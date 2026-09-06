import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';
import { PNG } from 'pngjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The browser tier. See `docs/TESTING.md` for when this is meant to run and
 * what it is allowed to grow into. In short: this file exists to prove the
 * shaders still compile and the game still boots and sails. It is not the
 * place to assert on how anything looks.
 *
 * Every wait in here is a CONDITION, never a sleep. An earlier version spent
 * 25.5s in fixed `waitForTimeout` calls, which was most of the suite's
 * runtime, and it was paid on every agent and every merge. The conditions
 * below observe the same three things those sleeps were guessing at: the hull
 * finishing its download, the first real frame reaching the canvas, and the
 * ship actually making way.
 */

/**
 * Screenshots are artefacts for the owner, never assertions -- see
 * docs/RENDER_PLAN.md. `SMOKE_LABEL` names the subfolder so a run can be
 * compared against an earlier one instead of overwriting it.
 */
const LABEL = process.env.SMOKE_LABEL ?? 'main';
const OUT_DIR = join('tests', 'out', LABEL);

/** Generous ceilings. They are never reached on a healthy run; they only stop a hang. */
const HULL_TIMEOUT_MS = 60_000;
const FRAME_TIMEOUT_MS = 30_000;
const SAIL_TIMEOUT_MS = 30_000;

/**
 * Collecting every `console.error`, every `pageerror`, and every
 * `console.warn` that starts with `THREE.` IS the shader regression test:
 * Three reports shader compile and link failures through `console.error`, so
 * this one list is what every rendering change is actually graded on. It has
 * already caught a real bug -- a uniform declared in the wrong shader stage,
 * which compiles fine in the vertex prefix and fails in the fragment one.
 */
function collectConsoleProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      problems.push(`console.error: ${msg.text()}`);
    } else if (msg.type() === 'warning' && msg.text().startsWith('THREE.')) {
      problems.push(`console.warn (THREE.): ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    problems.push(`pageerror: ${err.message}`);
  });
  return problems;
}

async function screenshot(page: Page, name: string): Promise<string> {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

/** Mean luminance and distinct colour count over the centre 60% of a frame. */
function frameStats(png: PNG): { meanLuminance: number; colours: number } {
  const { width, height, data } = png;
  const x0 = Math.floor(width * 0.2);
  const x1 = Math.ceil(width * 0.8);
  const y0 = Math.floor(height * 0.2);
  const y1 = Math.ceil(height * 0.8);

  let sum = 0;
  let count = 0;
  const colours = new Set<number>();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count++;
      colours.add((r << 16) | (g << 8) | b);
    }
  }
  return { meanLuminance: sum / count, colours: colours.size };
}

/** True once the canvas holds a real frame rather than the clear colour. */
function isLiveFrame(stats: { meanLuminance: number; colours: number }): boolean {
  return stats.meanLuminance > 6 && stats.colours > 64;
}

/**
 * Waits for the first genuinely rendered frame, then returns its stats.
 *
 * This replaces a 6s sleep. It is also the only image check the suite makes,
 * and it exists to catch a black or single-colour canvas, nothing more --
 * "no test may assert on how anything looks" (docs/TESTING.md).
 */
async function waitForLiveFrame(page: Page): Promise<{ meanLuminance: number; colours: number }> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  let stats = { meanLuminance: 0, colours: 0 };
  while (Date.now() < deadline) {
    stats = frameStats(PNG.sync.read(await page.screenshot()));
    if (isLiveFrame(stats)) return stats;
    await page.waitForTimeout(250);
  }
  return stats;
}

/** Pulls the leading number out of the HUD's "12 kn" / "0 kn" text. */
function readSpeed(text: string | null): number {
  const match = (text ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : NaN;
}

/**
 * Waits until the ship is genuinely making way.
 *
 * This replaces a 5s sleep, and it is load bearing rather than cosmetic:
 * materials in this engine compile on first draw, so the wake and spray
 * shaders do not exist until the hull has actually moved. Until this returns,
 * the console check above has not seen them.
 */
async function waitUntilMakingWay(page: Page, minKnots: number): Promise<number> {
  const deadline = Date.now() + SAIL_TIMEOUT_MS;
  let speed = 0;
  while (Date.now() < deadline) {
    speed = readSpeed(await page.locator('#hud-speed').textContent());
    if (speed >= minKnots) return speed;
    await page.waitForTimeout(200);
  }
  return speed;
}

/**
 * Loads the game and waits for the hull and the first frame.
 *
 * The hull is a ~5 MB glTF fetched over HTTP, so its response is a precise,
 * free signal that it has arrived -- far better than guessing at a duration
 * that has to hold on both a fast machine and this software rasteriser.
 */
async function boot(page: Page, url: string): Promise<void> {
  const hull = page.waitForResponse((r) => r.url().endsWith('.glb'), { timeout: HULL_TIMEOUT_MS });
  await page.goto(url);
  await hull;
}

test.describe('game smoke', () => {
  test('boots, sails, turns, zooms, and never logs a shader error', async ({ page }) => {
    const problems = collectConsoleProblems(page);

    await boot(page, '/');

    const idle = await waitForLiveFrame(page);
    expect(idle.meanLuminance, 'idle: centre-60% mean luminance').toBeGreaterThan(6);
    expect(idle.colours, 'idle: distinct colours in the centre 60%').toBeGreaterThan(64);
    await screenshot(page, 'idle');

    // Sail. Holding thrust until the HUD actually reads way on is what forces
    // the wake and spray materials to compile; see waitUntilMakingWay.
    await page.keyboard.down('KeyW');
    const speed = await waitUntilMakingWay(page, 3);
    expect(speed, 'HUD SPD under thrust').toBeGreaterThan(0);
    await screenshot(page, 'sailing');

    // Turn, still under way. A turn breaks the wake ribbon's continuity, which
    // is its own code path.
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(1200);
    await screenshot(page, 'turning');
    await page.keyboard.up('KeyD');

    // Zoom out in two stages. Distance drives the water's LOD and roughness
    // terms, so the orbital framing compiles and exercises different branches
    // than the chase one.
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(900);
    await screenshot(page, 'mid');
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(900);
    await screenshot(page, 'far');
    await page.keyboard.up('KeyW');

    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('quality=low still boots clean', async ({ page }) => {
    const problems = collectConsoleProblems(page);

    // The low tier is a genuinely different shader: the reflection plugin is
    // never registered, so the water compiles without it. That is the only
    // reason this second load exists.
    await boot(page, '/?quality=low');

    const hasQualityHook = await page.evaluate(() => {
      const w = window as unknown as { __pirateWorld?: { quality?: unknown } };
      return typeof w.__pirateWorld?.quality !== 'undefined';
    });
    expect(hasQualityHook, 'window.__pirateWorld.quality under ?quality=').toBe(true);

    const stats = await waitForLiveFrame(page);
    expect(stats.meanLuminance, 'quality=low: centre-60% mean luminance').toBeGreaterThan(6);
    expect(stats.colours, 'quality=low: distinct colours').toBeGreaterThan(64);
    await screenshot(page, 'quality-low-idle');

    expect(problems, problems.join('\n')).toEqual([]);
  });
});
