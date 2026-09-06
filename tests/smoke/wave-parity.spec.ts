import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * Loads `?probe=wave` (`src/dev/probe.ts`), screenshots the 128x128 canvas it
 * renders, decodes the PNG, and checks every pixel against the CPU samples
 * the same module publishes to `window.__pirateWorld.probe`.
 *
 * This is the whole point of Phase 1 stream B: it is the proof that the
 * hull (`ship.ts`, sampling `wavefield.ts`'s CPU port) rides the exact sea
 * the water shader (`water.ts`/`waterpatch.ts`) draws, not a look-alike.
 * The tolerance is 3/255, per docs/RENDER_PLAN.md, and is not loosened here.
 */

type ProbeWindow = Window & { __pirateWorld?: { probe?: number[][] } };

test.describe('wave field parity', () => {
  test('CPU wave field matches the GPU shader within 3/255 at every sample', async ({ page }: { page: Page }) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

    await page.goto('/?probe=wave');

    await page.waitForFunction(
      () => {
        const w = window as ProbeWindow;
        return Boolean(w.__pirateWorld?.probe);
      },
      { timeout: 15_000 },
    );

    const probe = await page.evaluate(() => (window as ProbeWindow).__pirateWorld!.probe!);
    expect(probe.length, 'CPU probe grid height').toBeGreaterThan(0);

    const canvas = page.locator('canvas[width="128"][height="128"]');
    const screenshot = await canvas.screenshot();
    const png = PNG.sync.read(screenshot);

    expect(png.width, 'probe canvas width').toBe(probe[0].length);
    expect(png.height, 'probe canvas height').toBe(probe.length);

    const TOLERANCE = 3;
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
    expect(worst, `worst pixel diff at ${worstAt ? worstAt.join(',') : 'n/a'}`).toBeLessThanOrEqual(TOLERANCE);
  });
});
