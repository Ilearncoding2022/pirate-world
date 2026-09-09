import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createTerrain, DEFAULT_SEED, SEA_LEVEL, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { latLonToDir } from '../../src/geo';

/**
 * The two edits `terrain.ts` makes to the raw noise field, and the reason each
 * one exists.
 *
 * Both are guarantees rather than tendencies: the spawn is ALWAYS water and
 * the poles ALWAYS have rock with water beside it, in every world, at every
 * seed. `terrain-golden.json` pins the field's actual values at 64 fixed
 * points; this file pins the two facts that must hold whatever those values
 * are, which is why it sweeps several seeds rather than trusting 1337.
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
