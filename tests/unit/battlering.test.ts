import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { findRingCentre, ringFits, RING_CLEARANCE } from '../../src/battlering';
import type { HeightMap } from '../../src/heightmap';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createHeightMap } from '../../src/heightmap';
import { GLOBE_RADIUS, latLonToDir } from '../../src/geo';

/**
 * `battlering.ts`'s one rule: a fight is staged on water the hulls can
 * actually cross. Nothing here asserts on how any of it looks — that is
 * rule 1 in docs/TESTING.md.
 *
 * Most of this runs against a SYNTHETIC height map rather than the real
 * world's, and that is the point rather than a shortcut. The rule is about
 * geometry — is there land inside this disc — and a real map answers it at
 * whatever resolution the map happens to have: at the 256x128 the cheap tier
 * builds, one texel is about 31 world units, which is wider than the whole
 * 28-unit clearance being tested. A map made of arithmetic has no texels to
 * hide an island between, so a case built on it fails only when the rule is
 * actually wrong.
 */
const SEA = 0;
const LAND = 1;

/**
 * A height map that is water everywhere except inside the given discs, each
 * an arc radius in world units about a unit direction.
 *
 * Only `sample` is real. The module reads nothing else, and a stub that
 * carried a texture and a Float32Array it never used would only be inviting a
 * reader to wonder which of them mattered.
 */
function discMap(...discs: { at: Vector3; radius: number }[]): HeightMap {
  return {
    sample(dir: Vector3): number {
      for (const d of discs) {
        const cos = Math.max(-1, Math.min(1, dir.clone().normalize().dot(d.at)));
        if (Math.acos(cos) * GLOBE_RADIUS <= d.radius) return LAND;
      }
      return SEA;
    },
  } as unknown as HeightMap;
}

/** A unit direction `worldUnits` from `from`, on an arbitrary fixed bearing. */
function offset(from: Vector3, worldUnits: number): Vector3 {
  const axis = new Vector3(0, 1, 0).cross(from);
  if (axis.lengthSq() < 1e-9) axis.set(1, 0, 0);
  axis.normalize();
  return from.clone().applyAxisAngle(axis, worldUnits / GLOBE_RADIUS).normalize();
}

const HERE = new Vector3(0, 0, 1);

describe('battlering — where a fight may be staged', () => {
  it('accepts open water', () => {
    expect(ringFits(discMap(), SEA, HERE)).toBe(true);
  });

  it('refuses a disc with land at its centre', () => {
    expect(ringFits(discMap({ at: HERE, radius: 3 }), SEA, HERE)).toBe(false);
  });

  it('refuses land INSIDE the ring, not merely land on its rim', () => {
    /*
     * The bug this case exists for, and the reason the module samples a disc
     * rather than a circle. A first cut probed the boundary alone and passed
     * a ring drawn straight across an archipelago: the rim was wet all the
     * way round and every islet the boats were about to be driven through sat
     * inside it, unprobed.
     *
     * So: an island half way out, big enough that a wave-sized hull plainly
     * cannot ignore it, and nothing at all on the rim.
     */
    const island = offset(HERE, RING_CLEARANCE * 0.5);
    const map = discMap({ at: island, radius: 4 });
    // The rim really is clear, or this case would prove nothing.
    expect(ringFits(map, SEA, offset(HERE, RING_CLEARANCE * 4))).toBe(true);
    expect(ringFits(map, SEA, HERE)).toBe(false);
  });

  it('ignores land beyond the clearance', () => {
    const far = offset(HERE, RING_CLEARANCE * 1.6);
    expect(ringFits(discMap({ at: far, radius: 5 }), SEA, HERE)).toBe(true);
  });

  it('slides the ring off a coast onto water it actually accepts', () => {
    const island = offset(HERE, RING_CLEARANCE * 0.5);
    const map = discMap({ at: island, radius: 6 });
    const placed = findRingCentre(map, SEA, HERE);

    expect(placed.fitted).toBe(true);
    expect(placed.moved).toBeGreaterThan(0);
    // Wherever it went, the rule it is enforcing has to hold there.
    expect(ringFits(map, SEA, placed.centre)).toBe(true);
    expect(placed.centre.length()).toBeCloseTo(1, 9);
  });

  it('keeps the contact point when a ring already fits, and says so', () => {
    const placed = findRingCentre(discMap(), SEA, HERE);
    expect(placed.fitted).toBe(true);
    expect(placed.moved).toBe(0);
    expect(placed.centre.distanceTo(HERE)).toBeLessThan(1e-9);
  });

  it('reports failure rather than pretending, when there is nowhere to go', () => {
    /*
     * Land everywhere within reach of the search. The fallback is the contact
     * point itself -- a fight in an awkward place beats a contact that can
     * never resolve -- but it must not come back looking like a success, or
     * every caller and every later test would believe it.
     */
    const placed = findRingCentre(discMap({ at: HERE, radius: GLOBE_RADIUS }), SEA, HERE);
    expect(placed.fitted).toBe(false);
    expect(placed.centre.distanceTo(HERE)).toBeLessThan(1e-9);
  });

  it('stages a fight at the world spawn without moving it', () => {
    // One case against the REAL world, because the synthetic map cannot say
    // whether the rule is survivable on the terrain the game ships: the
    // spawn point is open ocean by construction in `terrain.ts`.
    const terrain = createTerrain(DEFAULT_SEED);
    const heightMap = createHeightMap(terrain, 256, 128);
    const spawn = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG).normalize();
    const placed = findRingCentre(heightMap, terrain.seaLevel, spawn);
    expect(placed.fitted).toBe(true);
    expect(placed.moved).toBe(0);
  });
});
