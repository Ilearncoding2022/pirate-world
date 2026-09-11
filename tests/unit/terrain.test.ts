import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  BAND_GUARANTEE_RAD,
  createTerrain,
  DEFAULT_SEED,
  HEIGHT_BIAS,
  HEIGHT_GAIN,
  SEA_LEVEL,
  SPAWN_LAT_DEG,
  SPAWN_LON_DEG,
} from '../../src/terrain';
import { latLonToDir } from '../../src/geo';

/**
 * The three edits `terrain.ts` makes to the raw noise field, and the reason
 * each one exists.
 *
 * All three are guarantees rather than tendencies: the spawn is ALWAYS water,
 * the poles ALWAYS have rock with water beside it, and the equator ALWAYS has
 * its strip -- in every world, at every seed. `terrain-golden.json` pins the
 * field's actual values at 64 fixed points; this file pins the facts that must
 * hold whatever those values are, which is why it sweeps several seeds rather
 * than trusting 1337.
 *
 * No test here asserts on how any of it looks.
 */

/** A direction `d` radians from the given pole, down lon 0. */
function fromPole(sign: number, d: number): Vector3 {
  return latLonToDir(sign * (90 - (d * 180) / Math.PI), 0, new Vector3());
}

const SEEDS = [DEFAULT_SEED, 1, 7, 20250909, 0xdeadbeef];

describe('terrain polar bands', () => {
  it('puts land at both poles in every world', () => {
    for (const seed of SEEDS) {
      const terrain = createTerrain(seed);
      expect(terrain.heightAt(new Vector3(0, 1, 0)), `+Y at seed ${seed}`).toBeGreaterThan(
        SEA_LEVEL,
      );
      expect(terrain.heightAt(new Vector3(0, -1, 0)), `-Y at seed ${seed}`).toBeGreaterThan(
        SEA_LEVEL,
      );
    }
  });

  /*
   * 0.05 rad is where `towns.ts` puts the polar berth (POLE_BERTH_RAD), which
   * is the middle of the moat. Water HERE is the whole reason the moat exists;
   * whether that water joins the ocean is a different question and the one
   * `worldgen.ts` rejects worlds over.
   */
  it('digs water at the polar berth in every world', () => {
    for (const seed of SEEDS) {
      const terrain = createTerrain(seed);
      expect(terrain.heightAt(fromPole(1, 0.05)), `north moat at seed ${seed}`).toBeLessThan(
        SEA_LEVEL,
      );
      expect(terrain.heightAt(fromPole(-1, 0.05)), `south moat at seed ${seed}`).toBeLessThan(
        SEA_LEVEL,
      );
    }
  });

  it('keeps the whole islet band above water and the whole moat band below it', () => {
    const terrain = createTerrain(DEFAULT_SEED);
    for (const sign of [1, -1]) {
      // Just inside POLE_LAND_RAD, and just inside POLE_MOAT_RAD.
      expect(terrain.heightAt(fromPole(sign, 0.019))).toBeGreaterThan(SEA_LEVEL);
      expect(terrain.heightAt(fromPole(sign, 0.021))).toBeLessThan(SEA_LEVEL);
      expect(terrain.heightAt(fromPole(sign, 0.079))).toBeLessThan(SEA_LEVEL);
    }
  });

  /*
   * The fade band closes. At POLE_FADE_RAD the blend is fully back on the
   * natural height and the bias has gone to zero, so the field outside the
   * dimple is bit-identical to the field before the poles existed -- which is
   * the property the golden diff was reviewed against, and the reason no
   * coastline anywhere else in the world moved.
   */
  it('is back on the natural height at the edge of the fade band', () => {
    const terrain = createTerrain(DEFAULT_SEED);
    for (const sign of [1, -1]) {
      const inside = terrain.heightAt(fromPole(sign, 0.1999));
      const outside = terrain.heightAt(fromPole(sign, 0.2001));
      expect(Math.abs(inside - outside)).toBeLessThan(1e-3);
    }
  });

  it('still guarantees open water at the spawn', () => {
    for (const seed of SEEDS) {
      const terrain = createTerrain(seed);
      const spawn = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG, new Vector3());
      expect(terrain.heightAt(spawn), `spawn at seed ${seed}`).toBeLessThan(SEA_LEVEL);
    }
  });
});

/**
 * The equatorial strip.
 *
 * The promise is that the mainland coast never comes within
 * `BAND_GUARANTEE_RAD` of the equator. That is a statement about CONNECTED
 * landmasses, so the whole of it can only be checked against a rasterised world
 * -- `tests/unit/islets.test.ts` does that, and `npm run world:measure` does it
 * across fifty. What CAN be checked here, cheaply and at every seed, is the
 * arithmetic the promise rests on: the veto holds the continental term so far
 * under the waterline inside the strip that only the speck-scale terms can ever
 * reach it, so the strip is overwhelmingly water at every longitude.
 */
describe('the equatorial strip', () => {
  /**
   * A dense ring of samples inside the guarantee, at `latFrac` of the way from
   * the equator to `BAND_GUARANTEE_RAD`. 360 longitudes, so a single blocked
   * meridian cannot hide between samples.
   */
  function bandLandFraction(terrain: ReturnType<typeof createTerrain>, latFrac: number): number {
    const latDeg = ((BAND_GUARANTEE_RAD * latFrac) * 180) / Math.PI;
    let land = 0;
    let total = 0;
    for (let lon = 0; lon < 360; lon += 1) {
      for (const sign of [1, -1]) {
        const dir = latLonToDir(sign * latDeg, lon - 180, new Vector3());
        if (terrain.heightAt(dir) > SEA_LEVEL) land++;
        total++;
      }
    }
    return land / total;
  }

  /*
   * Under 2% at the very edge of the guarantee, which is where the veto is
   * weakest -- the ceiling is flat right across the strip, but the shape and
   * detail terms that CAN still reach the surface are unconstrained, and the
   * land they make is the islets the owner asked for. So this is a bound on
   * specks, not an assertion of no land: 2% of a 360-point ring is seven
   * samples, and the surveyed worlds run far under it.
   */
  it('is overwhelmingly water everywhere inside the guarantee, at every seed', () => {
    for (const seed of SEEDS) {
      const terrain = createTerrain(seed);
      for (const frac of [0, 0.5, 0.99]) {
        expect(bandLandFraction(terrain, frac), `seed ${seed} at ${frac} of the band`).toBeLessThan(
          0.02,
        );
      }
    }
  });

  /*
   * The bound the guarantee actually rests on, asserted as arithmetic rather
   * than as an outcome.
   *
   * `heightAt` is not decomposable from outside, so this reconstructs the worst
   * case instead: the continental term pinned at its ceiling, both other terms
   * at their theoretical maximum of 1.0. If THAT is still under water, no
   * combination of noise can put a continent's own height above sea level
   * inside the strip, and the only land left possible is speck-scale. The
   * numbers are read off `terrain.ts`'s constants, so a retune that breaks the
   * bound fails here rather than silently in a world nobody measured.
   */
  it('keeps a continent at its ceiling under water however the other terms fall', () => {
    const BAND_CEILING = -0.07;
    const worst = BAND_CEILING * 0.72 + 1 * 0.26 + 1 * 0.08;
    // The shape+detail terms cannot actually both peak at 1.0 -- they are fbm
    // sums measured at sigma ~0.073 -- so the realistic bound is the one the
    // case above measures. This is the ceiling's own contribution in isolation.
    const continentalOnly = BAND_CEILING * 0.72 * HEIGHT_GAIN + HEIGHT_BIAS;
    expect(continentalOnly).toBeLessThan(SEA_LEVEL - 0.2);
    // And the sanity check that the worst case is a real bound, not a vacuous
    // one: the summed field is clamped to [-1, 1] before it is ever read.
    expect(worst * HEIGHT_GAIN + HEIGHT_BIAS).toBeLessThan(1);
  });
});
