import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * Loads a probe harness (`src/dev/probe.ts`), screenshots the 128x128 canvas
 * it renders, decodes the PNG, and checks every pixel against the CPU samples
 * the same module publishes to `window.__pirateWorld`.
 *
 * Two fields are checked, and for the same reason: each has a GLSL original
 * the player sees and a CPU port the hull rides, and the whole point of the
 * split is that those are one surface, not two that look alike.
 *
 *   `?probe=wave`   -- `waterglsl.ts`'s `waveField` vs `wavefield.ts`, the
 *                      ordinary wind-driven sea (Phase 1 stream B).
 *   `?probe=hazard` -- `hazardfield.ts`'s `HAZARD_GLSL` vs its own CPU
 *                      `hazardHeight`, over a fixed crest, great crest and
 *                      maelstrom (docs/HAZARDS_PLAN.md).
 *
 * The tolerance is 3/255, per docs/RENDER_PLAN.md, and is not loosened here.
 */

type ProbeWindow = Window & { __pirateWorld?: Record<string, number[][] | undefined> };

const TOLERANCE = 3;

/**
 * Loads `url`, waits for the CPU grid to appear under `key`, and asserts the
 * screenshot of the probe canvas agrees with it everywhere.
 *
 * Both harnesses draw a 128x128 canvas and only one of them ever runs on a
 * given load, so the locator below is unambiguous.
 */
async function checkParity(page: Page, url: string, key: string): Promise<void> {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

  await page.goto(url);

  await page.waitForFunction(
    (k: string) => {
      const w = window as ProbeWindow;
      return Boolean(w.__pirateWorld?.[k]);
    },
    key,
    { timeout: 15_000 },
  );

  const probe = await page.evaluate((k: string) => (window as ProbeWindow).__pirateWorld![k]!, key);
  expect(probe.length, 'CPU probe grid height').toBeGreaterThan(0);

  const canvas = page.locator('canvas[width="128"][height="128"]');
  const screenshot = await canvas.screenshot();
  const png = PNG.sync.read(screenshot);

  expect(png.width, 'probe canvas width').toBe(probe[0].length);
  expect(png.height, 'probe canvas height').toBe(probe.length);

  let worst = 0;
  let worstAt: [number, number] | null = null;
  for (let row = 0; row < png.height; row++) {
    for (let col = 0; col < png.width; col++) {
      const i = (row * png.width + col) * 4;
      const gpuGrey = png.data[i];
      const cpuGrey = Math.round(probe[row][col] * 255);
      const diff = Math.abs(gpuGrey - cpuGrey);
      if (diff > worst) {
        worst = diff;
        worstAt = [row, col];
      }
    }
  }

  expect(problems, problems.join('\n')).toEqual([]);
  // Printed on a pass too. The margin is the interesting number -- a port
  // that quietly slipped from 1/255 to 3/255 is still green and is still
  // worth knowing about before it goes to 4.
  console.log(`${key}: worst pixel diff ${worst}/255 at ${worstAt ? worstAt.join(',') : 'n/a'}`);
  expect(worst, `worst pixel diff at ${worstAt ? worstAt.join(',') : 'n/a'}`).toBeLessThanOrEqual(TOLERANCE);
}

test.describe('wave field parity', () => {
  test('CPU wave field matches the GPU shader within 3/255 at every sample', async ({ page }: { page: Page }) => {
    await checkParity(page, '/?probe=wave', 'probe');
  });

  /*
   * The hazard field is built to make this test cheap to pass: every term is
   * polynomial plus one sqrt, with no transcendental anywhere in the height,
   * precisely so the two sides cannot drift the way `snoise` could. A failure
   * here therefore almost certainly means the two ports actually diverged --
   * a term added to one side, a constant retuned in one place -- rather than
   * the last-bit noise the tolerance exists to absorb.
   */
  test('CPU hazard field matches the GPU shader within 3/255 at every sample', async ({ page }: { page: Page }) => {
    await checkParity(page, '/?probe=hazard', 'hazardProbe');
  });
});
