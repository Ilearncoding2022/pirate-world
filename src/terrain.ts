import { Vector3 } from 'three';
import { createNoise3D } from 'simplex-noise';
import type { Terrain } from './types';
import { latLonToDir } from './geo';

/** Default world seed. */
export const DEFAULT_SEED = 1337;

/** Height threshold separating water from land. */
export const SEA_LEVEL = 0.08;

/**
 * Vertical scale and offset applied to the summed noise, before SEA_LEVEL cuts it.
 *
 * These two numbers, and only these two, decide how much of the globe is dry.
 * GAIN spreads the field so coastlines are crisp rather than mushy; BIAS slides
 * the whole thing under the waterline until the land/water split comes out
 * where it should. BIAS is the one to reach for: moving SEA_LEVEL instead would
 * work identically on the shape of the world but would silently retune every
 * constant expressed as a height ABOVE sea level -- `towns.ts` SHORE_MARGIN and
 * CENTRE_CEILING, `land.ts` BEACH_BAND and CULL_MARGIN, the water shader's
 * depth ramp -- because those measure from a line that had moved.
 *
 * At GAIN 1.55 / BIAS -0.0657 the average world is 26.7% land, 73.3% water.
 * `islets.ts` then sinks the specks; BIAS is tuned against the figure AFTER
 * that cull, since that is the world the player sails.
 *
 * BIAS was -0.0964 until the equatorial strip went in (see BAND_GUARANTEE_RAD
 * below). The veto drowns whatever the noise had put across the equator, which
 * cost the world about two points of land fraction, and this is what puts them
 * back everywhere else. It is therefore a FUNCTION OF THE STRIP'S WIDTH and has
 * to be re-solved whenever that moves: it was -0.0590 while the strip was fifty
 * units wide, and -0.0657 now that it is forty.
 *
 * Note WHAT it is tuned against, because the two answers differ by more than
 * the tolerance: the target is the POPULATION mean over 50 seeds, measured at
 * 0.267151 before the strip existed and landed on 0.267166 with it, NOT seed
 * 1337's own figure. Restoring the pinned seed exactly would have meant
 * over-restoring every other world -- the strip takes more equatorial land off
 * 1337 than off an average draw -- pushing the mean up and the top of the
 * distribution past `worldgen.ts`'s LAND_MAX, which would have turned a
 * negligible rejection rate into roughly one world in six. The owner chose the
 * population. Seed 1337 is 0.2409 as a result, down from 0.244906, and the
 * 50-seed spread came out 0.2221 to 0.3304 -- still inside `worldgen.ts`'s
 * LAND_MIN/LAND_MAX, which therefore did not have to move.
 *
 * `npm run world:measure` is what produced all of those numbers and is the way
 * to produce them again -- see `tests/fixtures/measure.ts`. Do not retune this
 * constant by eye; the tool solves for it in about eighty seconds.
 *
 * GAIN and BIAS are not independent. Land is `raw * GAIN + BIAS > SEA_LEVEL`,
 * i.e. `raw > (SEA_LEVEL - BIAS) / GAIN`, so the pair only ever expresses ONE
 * number -- a threshold on the raw noise -- and every (GAIN, BIAS) that yields
 * the same land fraction yields a bit-identical coastline. Changing GAIN alone
 * to reshape the world therefore does nothing but move the land fraction, and
 * the split between open ocean and enclosed water is not separately tunable
 * here at all: it follows from the threshold. Lower sea, deeper flooding, more
 * basins joined to the sea. At 33% land the world's lakes were 1.3% of its
 * water; at 25% they were 0.66%, and no choice of GAIN recovers the difference.
 * Only a different noise field would.
 */
/*
 * Exported for `tests/fixtures/measure.ts` and nothing in `src/`.
 *
 * The calibration tool needs the pair to do its one trick: `h` is linear in
 * BIAS, so moving BIAS to B' shifts every height uniformly and the land test
 * `h > SEA_LEVEL` becomes `h > SEA_LEVEL + BIAS - B'` on a height map that has
 * already been built. That turns "rebuild the world for every candidate" into
 * "build it once and move the waterline", which is the difference between a
 * calibration run that takes minutes and one that takes hours.
 */
export const HEIGHT_GAIN = 1.55;
export const HEIGHT_BIAS = -0.0657;

/** Deterministic 32-bit PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where the player starts.
 *
 * Single source of truth: `main.ts` places the ship here, the clearing below
 * guarantees the water under it, and `waterbodies.ts` floods the ocean out
 * from it to decide what the ship can ever reach.
 */
export const SPAWN_LAT_DEG = 0;
export const SPAWN_LON_DEG = 0;

/** Open-water radius (in radians of arc) guaranteed around the spawn point. */
const SPAWN_CLEAR_RADIANS = 0.16;
const SPAWN_FADE_RADIANS = 0.34;

/* ---- The two polar harbours' ground ------------------------------- */

/**
 * A rock at each pole, a moat of water around it, and a fade back to whatever
 * the noise wanted.
 *
 * `docs/HARBOURS_PLAN.md` puts Marine Stronghold at +Y and No Man's Land at -Y
 * in EVERY world, which means the noise field cannot be allowed a vote on
 * whether there is land there. So the field is overwritten in three bands
 * measured as the angle `p` from the nearer pole -- world-scale and angular,
 * the same family as every other settlement constant, so the dimple grows with
 * GLOBE_RADIUS instead of shrinking to a pinprick if the world does.
 *
 *   p < LAND     an islet, forced at least ISLET_RISE above sea level
 *   p < MOAT     water, forced at least as deep as MOAT_FLOOR
 *   p < FADE     a smoothstep from the moat floor back to the natural height
 *
 * At GLOBE_RADIUS 200 that is four units of rock inside sixteen of water,
 * inside a forty-unit dimple. The berth sits at 0.05 rad (`POLE_BERTH_RAD` in
 * `towns.ts`), which is the middle of the moat.
 *
 * The moat being WATER is not the same as the moat being SEA. Whether it joins
 * the ocean is a fact about the whole world -- a continent may simply be
 * sitting on the pole -- and no local edit can promise it. `worldgen.ts`
 * rejects such a world and redraws, which is the only honest answer short of
 * carving a channel to the nearest ocean, and carving one is a pathfinding job
 * over the height map for the sake of two harbours.
 *
 * FADE_BIAS is the knob that decides how often that rejection fires. Blending
 * straight back to the natural height leaves the moat ringed by whatever was
 * already there -- often a coastal shelf a hair above the waterline, which
 * seals it. A downward push that is full at the moat's outer edge and gone at
 * the fade's opens the ring far more often than not, at the cost of a shallow
 * annulus of sea the noise did not ask for. It is measured, not guessed: over
 * 50 random seeds neither pole was ever sealed, with the bias in or out, so at
 * 25% land it is insurance rather than a load-bearing part. It stays because
 * the land fraction is a constant somebody will raise one day, and the first
 * thing a wetter world's rejection rate would come from is a continent sitting
 * on a pole.
 */
const POLE_LAND_RAD = 0.02;
const POLE_MOAT_RAD = 0.08;
const POLE_FADE_RAD = 0.2;
/** How far above sea level the islet is forced. Well past `land.ts`'s beach band. */
const POLE_ISLET_RISE = 0.16;
/** Moat depth. The same floor the spawn clearing digs, and for the same reason. */
const POLE_MOAT_FLOOR = -0.32;
/** Downward push at the moat's outer edge, fading to nothing at the fade's. */
const POLE_FADE_BIAS = 0.12;

/* ---- The equatorial strip ----------------------------------------- */

/**
 * The promise: **the mainland coast never comes within 20 units of the
 * equator, in any world, at any longitude.** Forty units of open ocean, the
 * whole way round, and the ship spawns in the middle of it.
 *
 * That makes circumnavigation a fact about the generator rather than a thing a
 * seed might happen to allow. `waterbodies.ts` floods from the spawn point,
 * which is on the equator (`SPAWN_LAT_DEG`), so the strip is reachable water by
 * construction and every mile of it is a mile the player can actually sail.
 *
 * ## Why forty and not thirty, and not fifty
 *
 * The width is set by what has to fit down the corridor, not by taste. A
 * maelstrom is `MAELSTROM_RADIUS` = 10, so **twenty units across**
 * (`hazardfield.ts`). One sitting on the equator has to leave room to steer
 * round it without leaving the strip, or the guarantee is worth nothing the
 * first time the weather puts one there:
 *
 *   - at 30 units there are 5 units of water either side of it -- three hull
 *     beams, which is not a passage, it is a scrape;
 *   - at 40 there are 10 either side, which is the tightest that still reads as
 *     sailing round something rather than squeezing past it;
 *   - at 50 there are 15, which is comfortable and was the first cut of this
 *     feature.
 *
 * Forty is the floor of that range and was chosen (owner, 2026-09-11) over the
 * original fifty, because the cost of the strip is not land -- `HEIGHT_BIAS`
 * puts every acre of that back, see below -- but a band of the planet with no
 * mainland and therefore no harbours on it. Fifty units is +-7.2 degrees, about
 * 12.5% of the sphere; forty is +-5.7 and about 10%. Narrower than forty and
 * the corridor stops being an ocean and starts being a canal.
 *
 * ## Why this vetoes a noise term instead of flooring the height
 *
 * The spawn clearing and the polar moat both work by writing a floor into `h`.
 * That is right for a dimple a few units across and wrong for a belt round the
 * planet, for three reasons:
 *
 *  - A floor is a lid. Every texel it touches lands on one value, and 69% of
 *    the band would sit at exactly that depth -- a stripe of one colour in the
 *    water shader's ramp, which is a ruled line drawn in the sea instead of in
 *    the coastline.
 *  - A floor owns a depth constant, and that constant has to be kept in step
 *    with `land.ts`'s CULL_MARGIN and the shader's shallow band forever.
 *  - The owner wants small islands INSIDE the strip, and a floor drowns
 *    everything. They would have to be put back by a second term with no
 *    relationship to the land it sits off, which is how you get scenery that
 *    looks scattered rather than placed.
 *
 * So the band clamps the **continental** term alone, before the three fields
 * are summed. Continents are the only one of the three that can build a
 * landmass; `shape` and `detail` work at 69 units and 23, which is speck scale.
 * Veto the continents and what is left is an archipelago off a drowned shelf --
 * the islets fall out of the physics instead of being bolted onto it, and they
 * appear where the drowned land is highest, which is exactly where an eye
 * expects to find them.
 *
 * ## The guarantee, as arithmetic
 *
 * `fbm` normalises, so `continents` is bounded by +-1 and the clamp below holds
 * it at or under BAND_CEILING everywhere inside BAND_GUARANTEE_RAD. Its
 * contribution to `h` is therefore at most
 * `BAND_CEILING * 0.72 * HEIGHT_GAIN + HEIGHT_BIAS`, which is about 0.21 BELOW
 * SEA_LEVEL. For land, `shape * 0.26 + detail * 0.08` would have to clear
 * 0.136 on its own -- 1.9 sigma of a field measured at sigma 0.073. The
 * continents cannot reach the surface here. That is a bound, not a tendency.
 */
export const BAND_GUARANTEE_RAD = 0.1;

/**
 * How much further the veto reaches than it promises, radians.
 *
 * The coast is not allowed to be a ruled line of latitude, so the half-width is
 * `BAND_GUARANTEE_RAD + BAND_WANDER_RAD * 0.5 * (1 + n)` for a noise `n` in
 * [-1, 1] -- between 25 and 40 units off the equator depending on where you
 * are. Note which end is fixed: the wander only ever pushes the veto OUT.
 * Whatever the noise does, the guarantee is the guarantee, and that one line is
 * the whole of why this file can promise anything at all.
 *
 * 0.06 rad is 12 units of wander on a 20-unit floor, so the veto's half-width
 * runs 20 to 32 units and the strip 40 to 64. Enough that it visibly opens and
 * closes as you sail along it; not so much that it swallows a quarter of the
 * world. The ratio to the guarantee (0.6) is what was held when the strip
 * narrowed from fifty units to forty, rather than the absolute 15 it was before
 * -- the wander is a proportion of the corridor, and a fixed 15 on a 20-unit
 * floor would have made the edge wander further than the promise itself.
 */
export const BAND_WANDER_RAD = 0.06;

/**
 * How far past the half-width the veto fades out, radians -- 18 units.
 *
 * A smoothstep, like the spawn clearing's and the pole's, and for the same
 * reason: a clamp that stopped dead would ring the strip in a cliff the land
 * mesh would draw as a wall. Across the fade the ceiling climbs to 1.0, at
 * which point it is inert and the noise field has its own say back.
 *
 * Where the coast actually lands inside this band is set by the continent's own
 * height, not by the fade -- a strong continent makes landfall a third of the
 * way through it, a weak one two thirds -- and the shape term moves the exact
 * spot by a few units at the 69-unit scale. So the coastline is already ragged
 * before the wander noise adds its scalloping on top.
 */
const BAND_FADE_RAD = 0.09;

/**
 * The ceiling the continental term is held under inside the strip.
 *
 * Negative on purpose and this negative on purpose. At a ceiling of 0 the
 * shape and detail terms alone clear sea level on 5-7% of band texels, and at
 * 69 units a piece those are not specks: the largest measured was 3988 square
 * units spanning 105 units of latitude -- twice across the strip it was meant
 * to be sitting in. Pushing it down far enough to stop that leaves about 0.04
 * between "a 1192-unit blob" and "nothing survives the islet cull at all",
 * which is a knife edge to balance a constant on.
 *
 * -0.07 with the squash below measures 0 to 2 surviving islets per world, the
 * largest 66 square units. See BAND_SQUASH for why the pair is what makes that
 * window wide instead of sharp.
 */
const BAND_CEILING = -0.07;

/**
 * How much of the continents' own shape survives the veto.
 *
 * The clamp is `ceiling - (1 - continents) * BAND_SQUASH` rather than a flat
 * `min` against the ceiling, which leaves it monotone in `continents`: a
 * drowned continent is still deeper in the middle than at its edges. That is
 * what keeps the seafloor from flattening into one shader colour, and it is
 * also what makes the islets land where they do -- the threshold the shape term
 * has to clear is lowest where the drowned continent is highest, so the specks
 * gather off the vetoed coast instead of scattering evenly as static.
 *
 * It costs nothing in guarantee: `continents <= 1` makes the subtracted term
 * non-negative, so the limit is never above the ceiling. And it stops binding
 * altogether below `(BAND_CEILING - BAND_SQUASH) / (1 - BAND_SQUASH)` = -0.189,
 * which leaves genuine deep ocean under the strip exactly as the noise drew it.
 *
 * Measured: 0.10 takes the band's land fraction down about 35x against a flat
 * ceiling at the same value, and leaves band heights spanning -1.04 to +0.13 --
 * the whole shelf-to-deep ramp rather than a stripe.
 */
const BAND_SQUASH = 0.1;

/**
 * The band edge's own noise, and the two frequencies it is read at.
 *
 * Sampled on the direction projected onto the equatorial plane, so the
 * half-width is a function of longitude alone within a hemisphere. Two octaves,
 * because one is a ruled line with a gentle S in it: 1.9 gives about twelve
 * gulfs of 105 units around the globe, 4.4 about twenty-eight scallops of 45.
 *
 * BAND_HEMI_OFFSET is what keeps the north and south edges from being the same
 * curve mirrored -- a mirror would put a matched pair of headlands opposite
 * each other and read as a strait rather than as an ocean. 2.1 is more than two
 * feature widths of the lower octave, so the two hemispheres draw from
 * effectively independent slices of the field. The sign flip across `y = 0`
 * leaves no seam, because the half-width is only ever CONSULTED out at
 * `|lat| ~ hw`; on the equator itself the veto is saturated either way.
 */
const BAND_GULF_FREQ = 1.9;
const BAND_SCALLOP_FREQ = 4.4;
const BAND_HEMI_OFFSET = 2.1;

/**
 * `sin` of the furthest the veto can possibly reach, for the early-out.
 *
 * Derived, never typed: `heightAt` has `dir.y` in hand and `y = sin(lat)`, so
 * testing against this is one comparison and skips the two extra noise calls
 * for the 82% of the globe the band cannot touch. Written as a `sin` of the sum
 * rather than as its own number so it cannot drift out of step with the three
 * constants it is made of.
 */
const BAND_REACH_SIN = Math.sin(BAND_GUARANTEE_RAD + BAND_WANDER_RAD + BAND_FADE_RAD);

const _spawn = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG, new Vector3());
const _probe = new Vector3();

export function createTerrain(seed: number = DEFAULT_SEED): Terrain {
  const rng = mulberry32(seed);
  // Independent noise fields: broad continents, mid-scale coastline shaping, fine detail.
  const continentNoise = createNoise3D(rng);
  const shapeNoise = createNoise3D(rng);
  const detailNoise = createNoise3D(rng);
  const warpNoise = createNoise3D(rng);
  /*
   * The equatorial strip's edge, and it is built LAST for a reason worth
   * keeping. Each `createNoise3D` consumes a fixed prefix of `rng`, so a field
   * appended after the other four leaves all four bit-identical -- every world
   * that existed before this line is the same world with it, apart from the
   * band the strip deliberately changes. Inserted anywhere above, it would
   * shift the whole stream and redraw every coastline on the planet.
   *
   * It is its own field rather than `warpNoise` at another frequency because
   * `warpNoise` is fed into the DOMAIN of the other three: an edge drawn from
   * it would wander in step with the very coastlines it is supposed to be
   * independent of, and the strip would open exactly where the land already
   * wasn't.
   */
  const bandNoise = createNoise3D(rng);

  /** Fractal Brownian motion over a 3D noise field. */
  function fbm(
    noise: (x: number, y: number, z: number) => number,
    x: number,
    y: number,
    z: number,
    octaves: number,
    lacunarity: number,
    gain: number,
  ): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  function heightAt(dir: Vector3): number {
    const x = dir.x;
    const y = dir.y;
    const z = dir.z;

    // Domain warp keeps coastlines from looking like plain blobs.
    const w = 0.35;
    const wx = x + w * warpNoise(x * 1.7 + 11.3, y * 1.7, z * 1.7);
    const wy = y + w * warpNoise(x * 1.7, y * 1.7 + 7.1, z * 1.7);
    const wz = z + w * warpNoise(x * 1.7, y * 1.7, z * 1.7 + 3.9);

    // Broad landmasses: low frequency so we get a handful of real continents.
    let continents = fbm(continentNoise, wx * 1.05, wy * 1.05, wz * 1.05, 4, 2.0, 0.5);
    // Mid-scale shaping: peninsulas, bays, island arcs.
    const shape = fbm(shapeNoise, wx * 2.9, wy * 2.9, wz * 2.9, 4, 2.1, 0.5);
    // Fine detail: only meaningful once we are already near/above sea level.
    const detail = fbm(detailNoise, x * 8.5, y * 8.5, z * 8.5, 3, 2.2, 0.5);

    // The equatorial strip, and note WHERE it is: on the continental term, and
    // before the sum. Everything below this line -- the gain, the bias, the
    // spawn clearing, the poles -- then runs over a field in which no continent
    // was ever allowed near the equator, rather than over one being corrected
    // after the fact. See BAND_GUARANTEE_RAD for the whole argument.
    if (Math.abs(y) < BAND_REACH_SIN) {
      const lat = Math.asin(Math.min(1, Math.abs(y)));
      // The direction, flattened onto the equatorial plane and renormalised: on
      // the equator itself this is the direction, and a few degrees off it the
      // difference is a fraction of a percent. It makes the half-width a
      // function of longitude within a hemisphere, which is what lets the
      // guarantee be argued in one line.
      const r = Math.hypot(x, z) || 1e-9;
      const ex = x / r;
      const ez = z / r;
      const o = y >= 0 ? BAND_HEMI_OFFSET : -BAND_HEMI_OFFSET;
      const n =
        0.67 * bandNoise(ex * BAND_GULF_FREQ, o, ez * BAND_GULF_FREQ) +
        0.33 * bandNoise(ex * BAND_SCALLOP_FREQ, o + 0.9, ez * BAND_SCALLOP_FREQ);
      // `n` is in [-1, 1], so this is in [BAND_GUARANTEE_RAD, +BAND_WANDER_RAD]
      // and never below. The floor is the floor whatever the noise says.
      const halfWidth = BAND_GUARANTEE_RAD + BAND_WANDER_RAD * 0.5 * (1 + n);
      if (lat < halfWidth + BAND_FADE_RAD) {
        const t = lat <= halfWidth ? 0 : (lat - halfWidth) / BAND_FADE_RAD;
        const smooth = t * t * (3 - 2 * t);
        // Climbs to 1.0 at the end of the fade, where `continents <= 1` makes
        // the clamp unreachable and the field is simply itself again.
        const ceiling = BAND_CEILING + (1 - BAND_CEILING) * smooth;
        const squash = BAND_SQUASH * (1 - smooth);
        const limit = ceiling - (1 - continents) * squash;
        if (continents > limit) continents = limit;
      }
    }

    let h = continents * 0.72 + shape * 0.26 + detail * 0.08;

    // Bias the whole field down so the world reads as an ocean world with continents,
    // and gently flatten the extremes.
    h = h * HEIGHT_GAIN + HEIGHT_BIAS;

    // Guarantee open water at the spawn point so the ship never starts beached.
    const d = Math.acos(Math.max(-1, Math.min(1, dir.dot(_spawn))));
    if (d < SPAWN_FADE_RADIANS) {
      const t =
        d <= SPAWN_CLEAR_RADIANS
          ? 0
          : (d - SPAWN_CLEAR_RADIANS) / (SPAWN_FADE_RADIANS - SPAWN_CLEAR_RADIANS);
      const smooth = t * t * (3 - 2 * t);
      const floor = -0.32;
      h = floor + (h - floor) * smooth;
    }

    // The poles, after the spawn clearing and before the clamp. `Math.abs` is
    // what lets one term serve both: the fade band is 0.20 rad and the poles
    // are PI apart, so the two dimples can never see each other and the angle
    // to the NEARER pole is the only one either band cares about. The spawn
    // clearing is on the equator, PI/2 away, so the two edits never meet
    // either -- but the ordering is fixed anyway, because a clearing that ever
    // grew that far should not be allowed to flood the fortress.
    const polar = Math.acos(Math.min(1, Math.abs(y)));
    if (polar < POLE_LAND_RAD) {
      // Never below the islet: a pole that drew ocean still gets its rock.
      h = Math.max(h, SEA_LEVEL + POLE_ISLET_RISE);
    } else if (polar < POLE_MOAT_RAD) {
      // Never above the moat: a pole that drew a continent still gets its water.
      h = Math.min(h, POLE_MOAT_FLOOR);
    } else if (polar < POLE_FADE_RAD) {
      const t = (polar - POLE_MOAT_RAD) / (POLE_FADE_RAD - POLE_MOAT_RAD);
      const smooth = t * t * (3 - 2 * t);
      h = POLE_MOAT_FLOOR + (h - POLE_MOAT_FLOOR) * smooth - (1 - t) * POLE_FADE_BIAS;
    }

    return Math.max(-1, Math.min(1, h));
  }

  /**
   * Set once at startup by `globe.ts`, to the culled height map's sampler.
   *
   * Until it is installed, `isLand` answers straight from the noise field --
   * which is what `createHeightMap` needs while it is rasterising that very
   * field, and what any headless caller gets if it never builds a map.
   */
  let landMask: ((dir: Vector3) => number) | null = null;

  function isLand(dir: Vector3): boolean {
    return (landMask !== null ? landMask(dir) : heightAt(dir)) > SEA_LEVEL;
  }

  return {
    heightAt,
    isLand,
    isLandLatLon(latDeg: number, lonDeg: number): boolean {
      return isLand(latLonToDir(latDeg, lonDeg, _probe));
    },
    useLandMask(sample: (dir: Vector3) => number): void {
      landMask = sample;
    },
    seaLevel: SEA_LEVEL,
  };
}
