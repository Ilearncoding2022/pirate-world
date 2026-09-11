/**
 * The world's measuring tape: how much of it is land, how close the coast comes
 * to the equator, and what value of `HEIGHT_BIAS` puts the first number where
 * it belongs.
 *
 * ## Why this exists
 *
 * The figures quoted all over the generator -- "over 50 random seeds the
 * observed fractions ran 0.2154 to 0.3421 with a mean of 0.2759", "the measured
 * rejection rate is 0 in 50 random seeds", "at 25% they are 0.66%" -- were
 * produced by a throwaway run whose only surviving artefact is the prose that
 * quotes it. So the next person to touch `HEIGHT_BIAS` (which is to say, the
 * equatorial strip) had no way to check whether those sentences were still
 * true, and no way to retune the constant they describe without inventing the
 * measurement again from scratch.
 *
 * This is that measurement, committed. It is deliberately NOT a test: it
 * asserts nothing, it takes minutes rather than seconds, and it is invisible to
 * `npm test` for exactly the reason `generate.ts` is -- the root
 * `vitest.config.ts` only looks under `tests/unit`. It is reached through
 * `npm run world:measure` and read by a person.
 *
 * ## The three modes
 *
 * - `baseline` -- land fraction per seed, and nothing else. Uses only the
 *   oldest API in the pipeline (`createTerrain`, `createHeightMap`,
 *   `cullIslets`), so it runs unchanged against a stashed working tree. That is
 *   the point of it: the honest way to ask "what did this world look like
 *   BEFORE my change" is to run the same code over the same seeds on both
 *   sides, not to compare against a number somebody wrote down once.
 * - `solve` -- the same measurement swept over a grid of candidate
 *   `HEIGHT_BIAS` values, reporting which one lands the mean where you asked.
 * - `survey` -- whole worlds: every `WorldChecks` field, the islet cull's
 *   counts, and the equatorial strip's own numbers. The evidence the strip
 *   actually holds across worlds rather than in the one seed everything is
 *   pinned to.
 */
/*
 * Note what is NOT imported here: anything the equatorial strip added.
 *
 * `baseline` below has to run against a `git stash`ed working tree -- that is
 * the whole point of it -- and a static import of, say, `HEIGHT_BIAS` would be
 * hoisted and would fail to resolve against a `terrain.ts` that does not export
 * it yet. So the current bias is a PARAMETER to the two functions that need it,
 * and `survey` reaches for the new modules through a dynamic import inside its
 * own body. Keep it that way, or the before/after comparison this file exists
 * for stops being runnable in the "before" direction.
 */
import { createTerrain, DEFAULT_SEED, SEA_LEVEL } from '../../src/terrain';
import { createHeightMap } from '../../src/heightmap';
import type { HeightMap } from '../../src/heightmap';
import { cullIslets } from '../../src/islets';

/* ------------------------------------------------------------------ */
/* Seeds                                                               */
/* ------------------------------------------------------------------ */

/**
 * The seed list, drawn from a fixed meta-seed rather than from the clock.
 *
 * Two runs of this file have to be comparable -- that is the entire value of a
 * baseline -- so the same `count` always yields the same seeds, and `DEFAULT_SEED`
 * is always first so the pinned world's own row is at the top of every table.
 *
 * `mulberry32` is copied rather than imported because `terrain.ts` keeps its
 * own private. Copying a six-line PRNG is better here than exporting one: the
 * seeds this draws are an input to a measurement, not part of the world, and
 * the two must never end up sharing a stream.
 */
export function measurementSeeds(count: number): number[] {
  const seeds = [DEFAULT_SEED];
  let a = 20260911 >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  while (seeds.length < count) {
    const s = next();
    if (!seeds.includes(s)) seeds.push(s);
  }
  return seeds;
}

/* ------------------------------------------------------------------ */
/* Land fraction                                                       */
/* ------------------------------------------------------------------ */

/**
 * Share of texels above `seaLevel`, counted exactly the way `worldgen.ts`'s
 * `checkWorld` and `world-golden.json` count it.
 *
 * A TEXEL fraction and not an area fraction, and that is not a shortcut: it is
 * the same definition `LAND_MIN`/`LAND_MAX` are calibrated against, so the
 * three can never drift onto different ideas of "how much land". An
 * area-weighted figure would be the more physical number and would be the wrong
 * one to tune a gate with.
 */
function landFractionOf(data: Float32Array, seaLevel: number): number {
  let land = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > seaLevel) land++;
  return land / data.length;
}

/**
 * A `HeightMap` over a scratch copy of somebody else's heights.
 *
 * `cullIslets` reads `data`/`width`/`height` and writes through `setAt`/`flush`
 * and touches nothing else, so this is all of the interface it actually needs.
 * The cast is the honest way to say so -- the alternative is building a real
 * `DataTexture` per candidate, which allocates a GPU-shaped object for a
 * measurement that never reaches a GPU.
 */
function scratchMap(source: HeightMap, data: Float32Array): HeightMap {
  return {
    data,
    width: source.width,
    height: source.height,
    setAt(index: number, h: number): void {
      data[index] = h;
    },
    flush(): void {},
  } as unknown as HeightMap;
}

/**
 * Post-cull land fraction for one seed at one candidate `HEIGHT_BIAS`.
 *
 * The shift trick, in one line: heights are linear in BIAS, so rather than
 * rebuilding the world at `bias` we move the waterline by the same amount on
 * the world we already have. `h + (bias - HEIGHT_BIAS) > SEA_LEVEL` is
 * `h > SEA_LEVEL + HEIGHT_BIAS - bias`, and `cullIslets` takes the sea level as
 * an argument, so the real cull runs against the real map at a displaced
 * waterline. The answer is exact for every part of `heightAt` that is linear in
 * BIAS, which is all of it except the spawn floor, the polar floor and islet
 * and the final clamp -- and none of those four is anywhere near the waterline
 * for a shift of this size.
 *
 * The copy is per candidate and unavoidable: the cull mutates the map.
 */
function landFractionAtBias(map: HeightMap, currentBias: number, bias: number): number {
  const seaLevel = SEA_LEVEL + currentBias - bias;
  const scratch = Float32Array.from(map.data);
  cullIslets(scratchMap(map, scratch), seaLevel);
  return landFractionOf(scratch, seaLevel);
}

/* ------------------------------------------------------------------ */
/* baseline                                                            */
/* ------------------------------------------------------------------ */

export interface SeedLand {
  seed: number;
  landFraction: number;
}

/**
 * Land fraction per seed at the bias the source currently carries.
 *
 * Runs against a stashed tree as happily as against this one -- keep it that
 * way. The moment this reaches for anything the equatorial strip added, it
 * stops being able to measure the world without it, and the before/after
 * comparison this file exists for goes with it.
 */
export function baseline(seeds: number[], onSeed?: (row: SeedLand) => void): SeedLand[] {
  const rows: SeedLand[] = [];
  for (const seed of seeds) {
    const terrain = createTerrain(seed);
    const map = createHeightMap(terrain);
    cullIslets(map, terrain.seaLevel);
    const row = { seed, landFraction: landFractionOf(map.data, terrain.seaLevel) };
    rows.push(row);
    onSeed?.(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* solve                                                               */
/* ------------------------------------------------------------------ */

export interface BiasCandidate {
  bias: number;
  meanLand: number;
  minLand: number;
  maxLand: number;
  /** Seed DEFAULT_SEED's own figure, since everything else in the repo is pinned to it. */
  pinnedLand: number;
}

export interface SolveResult {
  target: number;
  candidates: BiasCandidate[];
  /** Linear interpolation between the two candidates that bracket `target`. */
  solved: number | null;
}

/**
 * Sweeps a grid of candidate biases and interpolates the one that lands the
 * MEAN land fraction on `target`.
 *
 * A grid rather than a bisection, because the expensive thing here is building
 * a world (about a second at 2048x1024) and the cheap thing is evaluating a
 * candidate against one already built. A bisection would have to hold every
 * seed's map in memory at once -- fifty of them is 420 MB -- or rebuild them
 * for every step. The grid visits each seed once, evaluates the whole row of
 * candidates against it, and throws the map away.
 *
 * Land fraction is monotone increasing in bias (a higher bias lifts every
 * height against a fixed sea level), so the interpolation is safe and the grid
 * only has to bracket the answer.
 */
export function solveBias(
  seeds: number[],
  currentBias: number,
  target: number,
  grid: number[],
  onSeed?: (seed: number, index: number) => void,
): SolveResult {
  const sums = new Float64Array(grid.length);
  const mins = new Float64Array(grid.length).fill(Infinity);
  const maxs = new Float64Array(grid.length).fill(-Infinity);
  const pinned = new Float64Array(grid.length);

  seeds.forEach((seed, index) => {
    onSeed?.(seed, index);
    const terrain = createTerrain(seed);
    const map = createHeightMap(terrain);
    for (let g = 0; g < grid.length; g++) {
      const f = landFractionAtBias(map, currentBias, grid[g]);
      sums[g] += f;
      if (f < mins[g]) mins[g] = f;
      if (f > maxs[g]) maxs[g] = f;
      if (seed === DEFAULT_SEED) pinned[g] = f;
    }
  });

  const candidates: BiasCandidate[] = grid.map((bias, g) => ({
    bias,
    meanLand: sums[g] / seeds.length,
    minLand: mins[g],
    maxLand: maxs[g],
    pinnedLand: pinned[g],
  }));

  let solved: number | null = null;
  for (let g = 1; g < candidates.length; g++) {
    const lo = candidates[g - 1];
    const hi = candidates[g];
    if (lo.meanLand <= target && target <= hi.meanLand) {
      const span = hi.meanLand - lo.meanLand;
      const t = span > 0 ? (target - lo.meanLand) / span : 0;
      solved = lo.bias + (hi.bias - lo.bias) * t;
      break;
    }
  }

  return { target, candidates, solved };
}

/** An evenly spaced grid, inclusive of both ends, rounded to kill float fuzz. */
export function biasGrid(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i <= n; i++) out.push(Number((from + i * step).toFixed(6)));
  return out;
}

/* ------------------------------------------------------------------ */
/* survey                                                              */
/* ------------------------------------------------------------------ */

export interface SurveyRow {
  seed: number;
  landFraction: number;
  lakeFraction: number;
  harbourCount: number;
  polesReachable: boolean;
  spawnIsSea: boolean;
  equatorOpen: boolean;
  bandBridges: number;
  /** Closest approach of any mainland to the equator, world units. */
  mainlandApproach: number;
  islandsBefore: number;
  islandsRemoved: number;
  bandIsletsSunk: number;
  bandIsletsKept: number;
  largestBandIslet: number;
  passes: boolean;
  failures: string[];
}

/**
 * Whole worlds, measured through the same `checkWorld` the generator itself
 * judges a draw with -- never a second opinion written here.
 *
 * Imported lazily inside the function rather than at the top of the file so
 * `baseline` above stays runnable against a tree that has none of the
 * equatorial strip in it yet. Static imports are hoisted; these are not.
 */
export async function survey(
  seeds: number[],
  onSeed?: (seed: number, index: number) => void,
): Promise<SurveyRow[]> {
  const { buildWorldData } = await import('../../src/globe');
  const { checkWorld, worldPasses, describeFailures } = await import('../../src/worldgen');
  const { createQuality } = await import('../../src/quality');
  const quality = createQuality('');

  const rows: SurveyRow[] = [];
  seeds.forEach((seed, index) => {
    onSeed?.(seed, index);
    const terrain = createTerrain(seed);
    const data = buildWorldData(terrain, quality, seed);
    const checks = checkWorld(data, terrain);
    rows.push({
      seed,
      landFraction: checks.landFraction,
      lakeFraction: data.waterBodies.inlandFraction,
      harbourCount: checks.harbourCount,
      polesReachable: checks.polesReachable,
      spawnIsSea: checks.spawnIsSea,
      equatorOpen: checks.equatorOpen,
      bandBridges: checks.bandBridges,
      mainlandApproach: checks.mainlandApproach,
      islandsBefore: data.isletCull.islandsBefore,
      islandsRemoved: data.isletCull.islandsRemoved,
      bandIsletsSunk: data.isletCull.bandIsletsSunk,
      bandIsletsKept: data.isletCull.bandIsletsKept,
      largestBandIslet: data.isletCull.largestBandIslet,
      passes: worldPasses(checks),
      failures: describeFailures(checks),
    });
  });
  return rows;
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

export function stats(values: number[]): { min: number; mean: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, mean, max };
}
