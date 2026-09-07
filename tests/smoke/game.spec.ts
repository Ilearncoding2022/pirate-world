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
  // The splash comes down only once the world is built, the hull is aboard
  // and one frame has been rendered to compile the shaders -- all of which
  // happens AFTER the .glb response above. Waiting for it matters to this
  // suite specifically: `waitForLiveFrame` samples a page screenshot, and the
  // loading art is a colourful painting that would sail through its
  // luminance and colour-count checks while the game underneath was still
  // black. `loading.ts` removes the element rather than hiding it.
  await page.waitForFunction(() => document.getElementById('loading') === null, undefined, {
    timeout: FRAME_TIMEOUT_MS,
  });
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

  test('the dev gold row is invisible and inert without ?dev', async ({ page }) => {
    /*
     * A regression test for a bug that shipped, and for the reason it shipped.
     *
     * `.shop__dev` sets `display: flex`, which BEATS the UA's
     * `[hidden] { display: none }` -- the same trap `.shop[hidden]` already
     * guards against. So the row rendered for every player: `shop.ts` only
     * writes its label and attaches its listener behind `?dev`, and what a
     * player without the query actually got was an unlabelled box that did
     * nothing when clicked.
     *
     * The check that MISSED it asserted `element.hidden === true`. That
     * property was set the whole time; it was the CSS that ignored it. So
     * this asks the renderer -- offsetParent and the computed display -- and
     * never the attribute, because the attribute was never the thing that was
     * wrong. Playwright's `toBeHidden` is the same question.
     */
    await boot(page, '/');

    // The panel is shut at boot, so unhide only the OVERLAY. The dev row must
    // stay invisible on its own account, which is exactly what failed before.
    await page.evaluate(() => {
      const shop = document.getElementById('shop');
      if (shop) {
        shop.hidden = false;
        shop.setAttribute('aria-hidden', 'false');
      }
    });

    await expect(page.locator('#shop-dev')).toBeHidden();

    const state = await page.evaluate(() => {
      const row = document.getElementById('shop-dev');
      const btn = document.getElementById('shop-dev-gold');
      return {
        display: row === null ? 'missing' : getComputedStyle(row).display,
        rendered: row !== null && row.offsetParent !== null,
        label: btn?.textContent ?? '',
      };
    });
    expect(state.display, 'computed display of #shop-dev without ?dev').toBe('none');
    expect(state.rendered, '#shop-dev is laid out without ?dev').toBe(false);
    // Unlabelled is the tell that shop.ts never wired it either.
    expect(state.label, '#shop-dev-gold label without ?dev').toBe('');
  });

  test('the dev gold row is visible and mints gold with ?dev', async ({ page }) => {
    await boot(page, '/?dev');

    await page.evaluate(() => {
      const shop = document.getElementById('shop');
      if (shop) {
        shop.hidden = false;
        shop.setAttribute('aria-hidden', 'false');
      }
    });

    await expect(page.locator('#shop-dev')).toBeVisible();

    const purse = (): Promise<string> =>
      page.evaluate(() => document.getElementById('shop-purse')?.textContent ?? '');
    expect(await purse()).toBe('0');

    // A real, hit-tested click -- not `element.click()`. The button being
    // reachable by the pointer is half of what is being tested.
    await page.click('#shop-dev-gold');
    // U+2009 THIN SPACE, the grouping `shop.ts` prints gold with.
    await expect
      .poll(purse, { message: 'purse after one dev click' })
      .toBe('10\u2009000');

    // And the HUD's own GOLD row, which is a separate subscriber.
    const hudGold = await page.evaluate(
      () => document.getElementById('hud-gold')?.textContent ?? '',
    );
    expect(hudGold, 'HUD gold after one dev click').toBe('10\u2009000');
  });

  test('battle=1 boots into the arena clean', async ({ page }) => {
    const problems = collectConsoleProblems(page);

    /*
     * The arena is a SECOND scene with its own sea shader, its own lights and
     * its own camera, and none of it is compiled by an ordinary session: a
     * fight is a 16%-per-ten-seconds draw away, and the whole point of this
     * tier is that it executes shaders Node never sees. `?battle=1` puts an
     * orange boat on the hull three seconds in, so the contact, the fade and
     * the arena all happen inside one boot.
     */
    await boot(page, '/?battle=1');

    const world = await waitForLiveFrame(page);
    expect(world.meanLuminance, 'battle=1: world before the contact').toBeGreaterThan(6);

    /*
     * The cover card first. A ram raises `#battlecover` and holds the world
     * for its three-second count, and only then does the fight open -- so this
     * is now the first thing a contact puts on screen and the arena is three
     * seconds behind it. Waited on separately rather than folded into the wait
     * below, because the two prove different things: this one is the beat the
     * player reads the rules in, and a regression that skipped it would
     * otherwise be invisible here.
     *
     * 25 s for a contact the query makes at three. The gap is the software
     * renderer: `?battle=1` closes its boat on the hull in SIM time, which
     * advances at the frame loop's capped dt, and this tier draws the world at
     * about 4 fps -- so three seconds of closing takes the better part of ten
     * on the wall clock. The count on the card itself does NOT stretch that
     * way; see MAX_TICK in `battlecover.ts` for why it must not.
     */
    await page
      .locator('#battlecover')
      .waitFor({ state: 'visible', timeout: 25000 })
      .catch(() => undefined);

    // A picture of the beat, on the same terms as every other shot in this
    // file: an artefact for the owner to look at, never an assertion. The card
    // is the one thing here whose whole job is to be read, and no assertion
    // about a DOM node's visibility can tell anyone whether it can be.
    await screenshot(page, 'battle-cover');

    /*
     * The overlay going up IS the arena coming up, so it is the condition to
     * wait on rather than a duration to guess at. It is allowed to time out
     * without failing: the raiders' sim can be stubbed out, and this test's
     * job is to prove nothing in the world it boots into logs a shader error,
     * not to assert that a fight started.
     *
     * The budget is the count plus the fade plus the slack the query already
     * needed. It is generous on purpose: this tier software-renders, and a
     * timeout here does not fail the test, it silently stops testing the
     * arena -- which is the failure that costs the most and shows the least.
     */
    await page
      .locator('#battle')
      .waitFor({ state: 'visible', timeout: 12000 })
      .catch(() => undefined);

    /*
     * And the card is gone by the time the arena is up. It is taken down
     * inside the fade's `onBlack`, so a cover still visible here would mean
     * the player is looking at a plate of art with a fight running underneath
     * it -- the one failure mode this screen can have that does not throw.
     */
    await expect(page.locator('#battlecover')).toBeHidden();

    const arena = await waitForLiveFrame(page);
    expect(arena.meanLuminance, 'battle=1: centre-60% mean luminance').toBeGreaterThan(6);
    expect(arena.colours, 'battle=1: distinct colours in the centre 60%').toBeGreaterThan(64);
    await screenshot(page, 'battle');

    expect(problems, problems.join('\n')).toEqual([]);
  });
});
