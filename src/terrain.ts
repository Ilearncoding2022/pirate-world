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
 * At GAIN 1.55 / BIAS -0.0964 the world is 25% land, 75% water. `islets.ts`
 * then sinks the specks, which is worth about a further 0.6% of the land; BIAS
 * is tuned against the figure AFTER that cull, since that is the world the
 * player sails.
 *
 * GAIN and BIAS are not independent. Land is `raw * GAIN + BIAS > SEA_LEVEL`,
 * i.e. `raw > (SEA_LEVEL - BIAS) / GAIN`, so the pair only ever expresses ONE
 * number -- a threshold on the raw noise -- and every (GAIN, BIAS) that yields
 * the same land fraction yields a bit-identical coastline. Changing GAIN alone
 * to reshape the world therefore does nothing but move the land fraction, and
 * the split between open ocean and enclosed water is not separately tunable
 * here at all: it follows from the threshold. Lower sea, deeper flooding, more
 * basins joined to the sea. At 33% land the world's lakes were 1.3% of its
 * water; at 25% they are 0.66%, and no choice of GAIN recovers the difference.
 * Only a different noise field would.
 */
const HEIGHT_GAIN = 1.55;
const HEIGHT_BIAS = -0.0964;

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

const _spawn = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG, new Vector3());
const _probe = new Vector3();

export function createTerrain(seed: number = DEFAULT_SEED): Terrain {
  const rng = mulberry32(seed);
  // Independent noise fields: broad continents, mid-scale coastline shaping, fine detail.
  const continentNoise = createNoise3D(rng);
  const shapeNoise = createNoise3D(rng);
  const detailNoise = createNoise3D(rng);
  const warpNoise = createNoise3D(rng);

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
    const continents = fbm(continentNoise, wx * 1.05, wy * 1.05, wz * 1.05, 4, 2.0, 0.5);
    // Mid-scale shaping: peninsulas, bays, island arcs.
    const shape = fbm(shapeNoise, wx * 2.9, wy * 2.9, wz * 2.9, 4, 2.1, 0.5);
    // Fine detail: only meaningful once we are already near/above sea level.
    const detail = fbm(detailNoise, x * 8.5, y * 8.5, z * 8.5, 3, 2.2, 0.5);

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
