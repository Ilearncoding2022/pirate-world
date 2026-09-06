import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';
import { PNG } from 'pngjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Screenshots are artefacts for the owner, never assertions -- see
 * docs/RENDER_PLAN.md. `SMOKE_LABEL` names the subfolder so every stream's
 * run lands beside the others instead of overwriting one shared set.
 */
const LABEL = process.env.SMOKE_LABEL ?? 'main';
const OUT_DIR = join('tests', 'out', LABEL);

/**
 * Collecting every `console.error`, every `pageerror`, and every
 * `console.warn` that starts with `THREE.` IS the shader regression test:
 * Three reports shader compile and link failures through `console.error`, so
 * this one list is what every rendering stream is actually graded on.
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

/**
 * The only image assertions this suite makes: a black or single-colour
 * canvas fails, nothing about how the frame actually looks is checked. See
 * docs/RENDER_PLAN.md -- "no test may assert on how anything looks".
 */
function assertLiveFrame(pngPath: string): void {
  const png = PNG.sync.read(readFileSync(pngPath));
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
  const meanLuminance = sum / count;
  expect(meanLuminance, `${pngPath}: centre-60% mean luminance`).toBeGreaterThan(6);
  expect(colours.size, `${pngPath}: distinct colours in the centre 60%`).toBeGreaterThan(64);
}

/** Pulls the leading number out of the HUD's "12 kn" / "0 kn" text. */
function readSpeed(text: string): number {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : NaN;
}

test.describe('game smoke', () => {
  test('boots, sails, turns, zooms, and never logs a shader error', async ({ page }) => {
    const problems = collectConsoleProblems(page);

    await page.goto('/');

    // Step 1/2: idle liveliness. The game spawns on the night side and stays
    // there for well over 90s of sailing -- this assertion must not assume
    // daylight.
    await page.waitForTimeout(6000);
    assertLiveFrame(await screenshot(page, 'idle'));

    // Step 3: sail. Materials compile lazily on first draw, so the wake and
    // spray shaders are only exercised once the hull is actually moving --
    // do not shorten this step, it is what makes the console check mean
    // anything for those two shaders.
    const speedBefore = readSpeed((await page.locator('#hud-speed').textContent()) ?? '');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(5000);
    const speedAfter = readSpeed((await page.locator('#hud-speed').textContent()) ?? '');
    expect(speedAfter, 'HUD SPD after 5s of thrust').toBeGreaterThan(speedBefore);
    await screenshot(page, 'sailing');

    // Step 4: turn, still under way.
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(2500);
    await screenshot(page, 'turning');
    await page.keyboard.up('KeyD');

    // Step 5: zoom the chase camera out in two stages, then release thrust.
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(3000);
    await screenshot(page, 'mid');
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(3000);
    await screenshot(page, 'far');
    await page.keyboard.up('KeyW');

    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('quality=low still boots clean', async ({ page }) => {
    const problems = collectConsoleProblems(page);

    await page.goto('/?quality=low');
    await page.waitForTimeout(6000);

    // Quality tiers arrive from agent Q; until `window.__pirateWorld.quality`
    // exists this step is feature-detected and skipped cleanly rather than
    // stubbed, per docs/RENDER_PLAN.md.
    const hasQualityHook = await page.evaluate(() => {
      const w = window as unknown as { __pirateWorld?: { quality?: unknown } };
      return typeof w.__pirateWorld?.quality !== 'undefined';
    });
    test.skip(!hasQualityHook, 'window.__pirateWorld.quality does not exist yet (agent Q builds it in Phase 0)');

    assertLiveFrame(await screenshot(page, 'quality-low-idle'));
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
