import { createTerrain, DEFAULT_SEED } from '../../../src/terrain';
import { buildWorldData } from '../../../src/globe';
import { createQuality } from '../../../src/quality';
import type { Terrain } from '../../../src/types';
import type { WorldData } from '../../../src/globe';

/**
 * The seed-1337 world, built once per test FILE and shared inside it.
 *
 * Building one is the second most expensive thing in the unit tier -- the real
 * 2048x1024 height map, the islet cull, the flood fill and the town search,
 * about 1.3 s -- and `docs/TESTING.md` gives the whole job five minutes. So no
 * test builds a second one, and any test that only needs a `WorldData` shaped
 * object hand-builds a fake instead of coming here.
 *
 * Vitest isolates test files in separate workers, so the memo does not carry
 * between them; it is per file, and the files run in parallel. Two files
 * calling this cost one build of wall clock, not two.
 *
 * 1337 specifically because it is DEFAULT_SEED: the seed `world-golden.json`
 * pins, the seed the smoke suite loads, and the seed `worldgen.ts` falls back
 * to when twelve random draws have failed. If it stops being a good world,
 * everything downstream of it is already broken.
 */
let memo: { terrain: Terrain; data: WorldData } | null = null;

export function world1337(): { terrain: Terrain; data: WorldData } {
  if (memo === null) {
    const terrain = createTerrain(DEFAULT_SEED);
    // `createQuality('')` rather than a hand-built row: an explicit search
    // string keeps it off `window.location`, and its `localStorage` read is
    // already wrapped against throwing, so in plain Node it falls through to
    // the 'high' row without touching a DOM. Same construction the golden
    // fixture generator uses, for the same reason.
    memo = { terrain, data: buildWorldData(terrain, createQuality(''), DEFAULT_SEED) };
  }
  return memo;
}
