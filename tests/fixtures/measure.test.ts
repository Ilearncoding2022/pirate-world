import { describe, it, expect } from 'vitest';
import { baseline, biasGrid, measurementSeeds, solveBias, stats, survey } from './measure';

/**
 * The measurement *runner*. Only reachable through `npm run world:measure`
 * (`tests/fixtures/vitest.measure.config.ts` is the only config that includes
 * this file), never through the ordinary `npm test`.
 *
 * It prints tables and asserts almost nothing, which is deliberate and is why
 * it lives here rather than under `tests/unit`. `docs/TESTING.md` rule 6 --
 * "add a test only when it pins something a change could break silently" --
 * cuts against turning a several-minute calibration sweep into a test; the
 * things this measures that MUST hold are pinned by `tests/unit/islets.test.ts`
 * and `tests/unit/terrain.test.ts` in seconds instead.
 *
 * Knobs, all through the environment so nothing here has to be edited to run
 * it differently:
 *
 *   WORLD_MODE=baseline|solve|survey   which of the three to run (default: survey)
 *   SEEDS=<n>                          how many worlds  (default: 24)
 *   TARGET=<fraction>                  the mean `solve` aims at
 *
 * `WORLD_MODE` and not `MODE`: vitest sets `process.env.MODE` itself (to
 * 'test'), so a knob called MODE is read back as something neither this file
 * nor the person running it ever wrote, and every mode silently skips.
 *
 * The intended sequence when retuning `HEIGHT_BIAS`:
 *
 *   git stash push src/            # measure the world WITHOUT the change
 *   WORLD_MODE=baseline SEEDS=24 npm run world:measure
 *   git stash pop
 *   WORLD_MODE=solve TARGET=<the mean that printed> npm run world:measure
 *   # write the solved bias into terrain.ts, then:
 *   WORLD_MODE=survey SEEDS=24 npm run world:measure
 */
const MODE = process.env.WORLD_MODE ?? 'survey';
const SEED_COUNT = Number(process.env.SEEDS ?? 24);

/** A progress line per world, because a silent five-minute run looks hung. */
function progress(label: string, seed: number, index: number, total: number): void {
  console.log(`  ${label} ${index + 1}/${total}  seed ${seed}`);
}

describe('world measurement', () => {
  it.runIf(MODE === 'baseline')(
    'baseline: land fraction per seed at the current HEIGHT_BIAS',
    () => {
      // No import of HEIGHT_BIAS here, static or dynamic: this block is the one
      // that has to survive a stashed tree. See the note at the top of
      // `measure.ts`.
      const seeds = measurementSeeds(SEED_COUNT);
      console.log(`\nBASELINE  ${seeds.length} seeds\n`);
      let n = 0;
      const rows = baseline(seeds, (row) => {
        progress('baseline', row.seed, n++, seeds.length);
        console.log(`      land ${row.landFraction.toFixed(6)}`);
      });
      const s = stats(rows.map((r) => r.landFraction));
      console.log(
        `\n  min ${s.min.toFixed(6)}   mean ${s.mean.toFixed(6)}   max ${s.max.toFixed(6)}`,
      );
      console.log(`  pinned seed ${rows[0].seed}: ${rows[0].landFraction.toFixed(6)}\n`);
      expect(rows.length).toBe(seeds.length);
    },
    30 * 60_000,
  );

  it.runIf(MODE === 'solve')(
    'solve: which HEIGHT_BIAS lands the mean land fraction on TARGET',
    async () => {
      const { HEIGHT_BIAS } = await import('../../src/terrain');
      const seeds = measurementSeeds(SEED_COUNT);
      const target = Number(process.env.TARGET ?? 0.2759);
      // Wide enough to bracket the answer from either direction, fine enough
      // that the linear interpolation between two rungs is worth trusting --
      // land fraction moves about 0.0095 per 0.01 of bias near the operating
      // point, so a 0.0025 rung is 0.0024 of land.
      const grid = biasGrid(-0.11, -0.02, 0.0025);
      console.log(
        `\nSOLVE  ${seeds.length} seeds  ${grid.length} candidates  target mean ${target}\n`,
      );
      const result = solveBias(seeds, HEIGHT_BIAS, target, grid, (seed, i) =>
        progress('solve', seed, i, seeds.length),
      );
      console.log('\n    bias      mean      min       max       seed1337');
      for (const c of result.candidates) {
        console.log(
          `  ${c.bias.toFixed(4)}   ${c.meanLand.toFixed(6)}  ${c.minLand.toFixed(6)}  ` +
            `${c.maxLand.toFixed(6)}  ${c.pinnedLand.toFixed(6)}`,
        );
      }
      console.log(
        `\n  SOLVED HEIGHT_BIAS = ${result.solved === null ? 'outside the grid' : result.solved.toFixed(6)}\n`,
      );
      expect(result.candidates.length).toBe(grid.length);
    },
    60 * 60_000,
  );

  it.runIf(MODE === 'survey')(
    'survey: whole worlds, judged by the generator’s own checks',
    async () => {
      const { HEIGHT_BIAS, BAND_GUARANTEE_RAD } = await import('../../src/terrain');
      const { LAND_MIN, LAND_MAX } = await import('../../src/worldgen');
      const { GLOBE_RADIUS } = await import('../../src/geo');
      const seeds = measurementSeeds(SEED_COUNT);
      console.log(`\nSURVEY  ${seeds.length} seeds  HEIGHT_BIAS ${HEIGHT_BIAS}\n`);
      const rows = await survey(seeds, (seed, i) => progress('survey', seed, i, seeds.length));

      console.log(
        '\n        seed   land      lake      harb  poles  eqOpen  bridges  approach  islets  pass',
      );
      for (const r of rows) {
        console.log(
          `  ${String(r.seed).padStart(10)}  ${r.landFraction.toFixed(6)}  ` +
            `${r.lakeFraction.toFixed(6)}   ${String(r.harbourCount).padStart(2)}   ` +
            `${r.polesReachable ? ' ok  ' : 'FAIL '}  ${r.equatorOpen ? ' ok  ' : 'FAIL '}  ` +
            `${String(r.bandBridges).padStart(5)}  ${r.mainlandApproach.toFixed(1).padStart(8)}  ` +
            `${String(r.bandIsletsKept).padStart(3)}  ${String(r.bandIsletsSunk).padStart(4)}  ` +
            `${r.largestBandIslet.toFixed(0).padStart(7)}  ${r.passes ? 'ok' : 'FAIL'}`,
        );
        if (!r.passes) console.log(`               ${r.failures.join('; ')}`);
      }

      const land = stats(rows.map((r) => r.landFraction));
      const approach = stats(rows.map((r) => r.mainlandApproach));
      const rejected = rows.filter((r) => !r.passes).length;
      // The figure that actually states the promise. A rejected world is one
      // nobody is ever given, so its coast is not evidence about anything --
      // the guarantee is about the worlds that PASS, and this is the only line
      // in the table that measures exactly those.
      const kept = rows.filter((r) => r.passes);
      const keptApproach = stats(kept.map((r) => r.mainlandApproach));
      console.log(
        `\n  land      min ${land.min.toFixed(6)}  mean ${land.mean.toFixed(6)}  max ${land.max.toFixed(6)}`,
      );
      console.log(`  bounds    LAND_MIN ${LAND_MIN}  LAND_MAX ${LAND_MAX}`);
      console.log(
        `  approach  min ${approach.min.toFixed(1)}u  mean ${approach.mean.toFixed(1)}u  max ${approach.max.toFixed(1)}u`,
      );
      console.log(`  bridges   ${rows.reduce((a, r) => a + r.bandBridges, 0)} across all seeds`);
      console.log(
        `  islets    ${rows.reduce((a, r) => a + r.bandIsletsKept, 0)} kept, ` +
          `${rows.reduce((a, r) => a + r.bandIsletsSunk, 0)} sunk over the caps, ` +
          `largest ${Math.max(...rows.map((r) => r.largestBandIslet)).toFixed(0)} u2`,
      );
      console.log(
        `  ACCEPTED: closest mainland ${keptApproach.min.toFixed(1)}u ` +
          `(floor ${(BAND_GUARANTEE_RAD * GLOBE_RADIUS).toFixed(1)}u), ` +
          `mean ${keptApproach.mean.toFixed(1)}u, over ${kept.length} worlds`,
      );
      console.log(`  rejected  ${rejected} of ${rows.length}\n`);

      expect(rows.length).toBe(seeds.length);
    },
    60 * 60_000,
  );
});
