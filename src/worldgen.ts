import { Vector3 } from 'three';
import type { Terrain } from './types';
import type { Quality } from './quality';
import type { WorldData } from './globe';
import { buildWorldData } from './globe';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import { latLonToDir } from './geo';
import { HARBOUR_COUNT, HARBOUR_NAMES, NORTH_POLE_INDEX, SOUTH_POLE_INDEX } from './harbournames';

/**
 * worldgen.ts -- the seed, the checks, and the loop between them.
 *
 * `docs/HARBOURS_PLAN.md`, decision 7: a new random world on every page load.
 * That only works if a bad draw can be thrown away, and throwing one away only
 * works if finding out it is bad is cheap. Both halves live here.
 *
 * The cheapness is `globe.ts`'s split (`docs/HARBOURS_PLAN.md`, Trap 1). This
 * loop calls `buildWorldData` -- height map, islet cull, flood fill, town
 * search, about a second -- and never `buildWorldMeshes`, which is the 2.2
 * million vertices. A rejected world costs a second on the main thread behind
 * the loading bar and not one triangle.
 */

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * How many random seeds to try before giving up and taking the pinned one.
 *
 * A count, not a duration, because the cost per attempt is roughly fixed and
 * the number the player actually feels is the ceiling: twelve rejections is
 * about twelve seconds of loading bar, which is long but finite and is a case
 * that has never been observed -- the measured rejection rate is 0 in 50 random
 * seeds, so the expected number of attempts is one.
 *
 * The exhaustion path is not a fallback to "some world"; it is a fallback to
 * DEFAULT_SEED, which is pinned by `tests/fixtures/world-golden.json` and
 * therefore known to pass. That is what makes the loop total: it cannot end
 * without a world.
 */
export const WORLD_ATTEMPTS = 12;

/**
 * The band of land fraction a world has to fall in, as a share of the height
 * map's texels above sea level, after the islet cull.
 *
 * Calibrated, not chosen: seed 1337 measures 0.244906, and the band is that
 * value plus and minus 40%. Forty per cent is wide on purpose. This check is
 * not a taste filter -- `terrain.ts`'s HEIGHT_BIAS already decides what the
 * world should look like -- it is a catch for the draw that came out an
 * unsailable continent or an empty ocean with nowhere to moor. Over 50 random
 * seeds the observed fractions ran 0.2154 to 0.3421 with a mean of 0.2759, all
 * of them inside the band, which is the shape a catch should have: it fires on
 * the tail and never on the body.
 *
 * A TEXEL fraction, and not an area fraction, because the height map is
 * equirectangular and its polar rows are enormously over-sampled. It is the
 * same number `world-golden.json` pins, deliberately, so the two cannot drift
 * onto different definitions of "how much land".
 */
export const LAND_MIN = 0.147;
export const LAND_MAX = 0.343;

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

export interface WorldChecks {
  /** Is the ship's spawn point open water? */
  spawnIsSea: boolean;
  /** Share of height-map texels above sea level, after the islet cull. */
  landFraction: number;
  /** Did both polar harbours find sea the ship can reach? */
  polesReachable: boolean;
  /** How many harbours the town search actually founded. */
  harbourCount: number;
}

const _spawn = new Vector3();

/**
 * Measures a candidate world. Makes no judgement; `worldPasses` does that.
 *
 * Split in two so the truth table is a pure function of four numbers and can
 * be unit tested without building a world at all -- which matters, because
 * building one is the second most expensive thing this project does.
 */
export function checkWorld(data: WorldData, terrain: Terrain): WorldChecks {
  const { heightMap, towns } = data;

  let land = 0;
  for (let i = 0; i < heightMap.data.length; i++) {
    if (heightMap.data[i] > terrain.seaLevel) land++;
  }

  latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG, _spawn);

  return {
    // True by construction of `terrain.ts`'s spawn clearing, and checked
    // anyway: it is one texel read, and the clearing is a constant somebody
    // will retune one day without thinking about this loop.
    spawnIsSea: heightMap.sample(_spawn) <= terrain.seaLevel,
    landFraction: land / heightMap.data.length,
    // Asked of the town list rather than of the height map, because
    // `towns.ts`'s own reachability gate is the authority on it and a second
    // opinion here could only ever disagree with the thing that actually
    // decided. A pole that could not reach the sea was not founded, so its
    // name is not in the map.
    polesReachable:
      towns.byName(HARBOUR_NAMES[NORTH_POLE_INDEX]) !== null &&
      towns.byName(HARBOUR_NAMES[SOUTH_POLE_INDEX]) !== null,
    harbourCount: towns.all.length,
  };
}

/** Whether a measured world is worth building meshes for. */
export function worldPasses(c: WorldChecks): boolean {
  return (
    c.spawnIsSea &&
    c.landFraction >= LAND_MIN &&
    c.landFraction <= LAND_MAX &&
    c.polesReachable &&
    c.harbourCount === HARBOUR_COUNT
  );
}

/** The failed checks, named, for the message a thrown `?seed=` carries. */
function failures(c: WorldChecks): string[] {
  const out: string[] = [];
  if (!c.spawnIsSea) out.push('the spawn point is land');
  if (c.landFraction < LAND_MIN || c.landFraction > LAND_MAX) {
    out.push(`land fraction ${c.landFraction.toFixed(4)} is outside [${LAND_MIN}, ${LAND_MAX}]`);
  }
  if (!c.polesReachable) out.push('a polar moat does not open to the sea');
  if (c.harbourCount !== HARBOUR_COUNT) {
    out.push(`only ${c.harbourCount} of ${HARBOUR_COUNT} harbours were founded`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

export interface GeneratedWorld {
  /** The seed the returned world was actually built from. */
  seed: number;
  terrain: Terrain;
  data: WorldData;
}

/**
 * A uint32 from the platform CSPRNG, which is the only source of randomness in
 * this project that is not seeded by something.
 *
 * `mulberry32` takes a uint32, so that is the width drawn. The fallback exists
 * for a runtime without WebCrypto -- an old Node, mostly -- and is not a
 * security question in either direction: nothing here is a secret, the draw
 * only has to be different between two page loads.
 */
function drawSeed(): number {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    return c.getRandomValues(new Uint32Array(1))[0] >>> 0;
  }
  return (Math.random() * 0x100000000) >>> 0;
}

/**
 * `?reject=<n>`: force the first `n` attempts to be rejected whatever they
 * measure. A dev query, on exactly the terms `?quality=` and `?clock=` are --
 * read through URLSearchParams, never through `import.meta.env.MODE`, because
 * `vite preview` serves a genuine production build and this is meant to be
 * pointed at one. An ordinary player's session sets no query and this returns
 * 0.
 *
 * It exists because the rejection loop is otherwise UNTESTABLE in a browser.
 * The measured rejection rate is 0 in 50 random seeds and 0 in the 270 that
 * have been checked in total -- there is no known seed that fails, which is
 * the point of the calibration but leaves the entire recovery path (the retry,
 * the loading bar's attempt counter, the fall back to DEFAULT_SEED) as code
 * nothing ever runs. `docs/TESTING.md` is blunt about what that is worth: the
 * browser tier earns its cost by executing what Node cannot, and a path with
 * no way to reach it is a path that will be broken the first time someone
 * needs it.
 *
 * Not read at module load. Resolved per call so a unit test can pass the count
 * directly and never touch `window`.
 */
function rejectionsFromQuery(): number {
  if (typeof location === 'undefined') return 0;
  const raw = new URLSearchParams(location.search).get('reject');
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Builds and measures one candidate. */
function attempt(seed: number, quality: Quality): { world: GeneratedWorld; checks: WorldChecks } {
  const terrain = createTerrain(seed);
  const data = buildWorldData(terrain, quality, seed);
  return { world: { seed, terrain, data }, checks: checkWorld(data, terrain) };
}

/**
 * Draws a world, rejecting the bad ones.
 *
 * Two modes, and they behave differently on purpose:
 *
 * - **With a `seedHint`** (from `?seed=`, tests and screenshots) exactly ONE
 *   attempt is made and a failure THROWS. A pinned seed is pinned because
 *   something is being compared against it; quietly handing back a different
 *   world would turn every such comparison into a lie, and the day 1337 stops
 *   passing is a day somebody needs to be told loudly rather than shown a
 *   world that looks nearly right. Note for `main.ts`: this rejection is a
 *   thrown error on a player-supplied query string, so the boot has to decide
 *   what to show for it.
 * - **Without one** seeds come from the CSPRNG, up to WORLD_ATTEMPTS of them,
 *   and exhaustion falls back to DEFAULT_SEED rather than failing. A player
 *   pressing reload is owed a world, not a diagnostic.
 *
 * `onAttempt` is awaited BEFORE each build, not after, because the whole point
 * of it is to let the loading bar paint the attempt number before the main
 * thread disappears into a second of synchronous work. Awaiting it afterwards
 * would paint every number one attempt late, and the last one never.
 *
 * `forcedRejections` is the `?reject=` dev query, defaulted from the URL. It
 * is the only way to make this loop take its second branch, because no seed is
 * known that fails; see `rejectionsFromQuery`.
 *
 * The loop is synchronous inside each attempt and there is no Worker. A Worker
 * would keep the tab responsive through a rejection and is the right next step
 * if rejections ever become common, but this project has no Worker anywhere
 * yet, the measured rejection rate is 0 in 50, and the loading bar already
 * covers the wait.
 */
export async function generateWorld(
  seedHint: number | null,
  quality: Quality,
  onAttempt: (n: number, seed: number) => Promise<void> = async () => {},
  forcedRejections: number = rejectionsFromQuery(),
): Promise<GeneratedWorld> {
  if (seedHint !== null) {
    const seed = seedHint >>> 0;
    await onAttempt(1, seed);
    const { world, checks } = attempt(seed, quality);
    if (forcedRejections > 0 || !worldPasses(checks)) {
      throw new Error(`seed ${seed} does not make a usable world: ${failures(checks).join('; ')}`);
    }
    return world;
  }

  for (let n = 1; n <= WORLD_ATTEMPTS; n++) {
    const seed = drawSeed();
    await onAttempt(n, seed);
    const { world, checks } = attempt(seed, quality);
    if (n > forcedRejections && worldPasses(checks)) return world;
  }

  // The pinned world. It passes by construction -- `world-golden.json` is
  // regenerated from it and `worldgen.test.ts` asserts it passes -- so this
  // return is not a guess, and no check is repeated here to prove it. If
  // DEFAULT_SEED ever stopped passing, the unit tier would have said so long
  // before a player got here.
  await onAttempt(WORLD_ATTEMPTS + 1, DEFAULT_SEED);
  return attempt(DEFAULT_SEED, quality).world;
}
