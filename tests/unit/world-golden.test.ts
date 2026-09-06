import { describe, it, expect, beforeAll } from 'vitest';
import { buildWorldGolden } from '../fixtures/generate';
import type { WorldGolden } from '../fixtures/generate';
import golden from '../fixtures/world-golden.json';

/**
 * Builds the real 2048x1024 height map, culls islets, floods the water
 * bodies and places every town -- the slow test (~2s), per
 * docs/RENDER_PLAN.md. Pins land fraction, lake fraction, town count and the
 * "every Town.dock is non-null" invariant to the values captured on `main`.
 *
 * Regenerate with `npm run golden:update` after a legitimate change (a
 * different `HEIGHT_BIAS`, `MIN_ISLAND_AREA`, `CLUSTER_TARGET`, ...) and note
 * it in the report.
 */
describe(
  'world-golden',
  () => {
    let live: WorldGolden;
    beforeAll(() => {
      live = buildWorldGolden();
    }, 15_000);

    it('matches the captured world exactly', () => {
      expect(live).toEqual(golden);
    });

    it('keeps every town in "all" berthed', () => {
      expect(live.allDocksNonNull).toBe(true);
      expect(live.townCount).toBe(live.dockCount);
    });
  },
  15_000,
);
