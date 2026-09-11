import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { findRingCentre, ringFits, RING_CLEARANCE, RING_DRIVEN_OFF } from '../../src/battlering';
import { ARENA_R0 } from '../../src/battleconstants';
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

/**
 * The inverse of `discMap`: LAND everywhere except inside the given discs.
 *
 * `discMap` can only draw islands in an open ocean, and an island is the one
 * shape that cannot express the case this module was rewritten for -- water
 * that is enclosed. A contact in a bay is a contact in a small patch of sea
 * with land all round it and the next sea room a long way off, and that is
 * two pockets in a continent rather than two islands in an ocean.
 */
function pocketMap(...pockets: { at: Vector3; radius: number }[]): HeightMap {
  return {
    sample(dir: Vector3): number {
      for (const p of pockets) {
        const cos = Math.max(-1, Math.min(1, dir.clone().normalize().dot(p.at)));
        if (Math.acos(cos) * GLOBE_RADIUS <= p.radius) return SEA;
      }
      return LAND;
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
     * Land over the WHOLE planet, which is now what it takes: the search runs
     * to the antipode, so a disc of GLOBE_RADIUS -- 200 units of arc, which
     * used to be far more than the 80-unit cap could see past -- is a puddle
     * of land in an ocean the search has no trouble reaching around.
     *
     * The fallback is the contact point itself, because a fight in an awkward
     * place beats a contact that can never resolve. It must not come back
     * looking like a success, or every caller and every later test would
     * believe it.
     */
    const whole = Math.PI * GLOBE_RADIUS;
    const placed = findRingCentre(discMap({ at: HERE, radius: whole }), SEA, HERE);
    expect(placed.fitted).toBe(false);
    expect(placed.centre.distanceTo(HERE)).toBeLessThan(1e-9);
  });

  it('reaches water the old 80-unit cap could not, rather than giving up on it', () => {
    /*
     * The case the whole change exists for, and the shape of the screenshot
     * that started it. The contact is in a bay ten units across -- far too
     * tight for a 28-unit clearance -- and the nearest sea room is 150 units
     * away, nearly twice the 80 units the search used to be allowed. The old
     * search saw nothing but coast, returned `fitted: false`, and `main.ts`
     * staged a duelling ring across the headland.
     */
    const openSea = offset(HERE, 150);
    const map = pocketMap({ at: HERE, radius: 10 }, { at: openSea, radius: 60 });
    const placed = findRingCentre(map, SEA, HERE);

    expect(placed.fitted).toBe(true);
    expect(placed.moved).toBeGreaterThan(80);
    expect(ringFits(map, SEA, placed.centre)).toBe(true);
  });

  it('takes the nearest water it can find, not merely some water', () => {
    /*
     * Two places a fight could be staged, one four times further than the
     * other. The search is outward in shells, so the near one has to win: an
     * unbounded search that wandered to the far side of the planet when there
     * was sea room sixty units away would be a worse bug than the one it
     * replaced, and it would be an invisible one -- both answers are open
     * water and both look right in a screenshot.
     */
    const near = offset(HERE, 60);
    const far = offset(HERE, -300);
    const map = pocketMap(
      { at: HERE, radius: 10 },
      { at: near, radius: 40 },
      { at: far, radius: 120 },
    );
    const placed = findRingCentre(map, SEA, HERE);

    expect(placed.fitted).toBe(true);
    expect(ringFits(map, SEA, placed.centre)).toBe(true);
    // Comfortably short of the far pocket, which starts 180 units out.
    expect(placed.moved).toBeLessThan(110);
  });

  it('stages every coastal contact on the shipped world on water that fits', () => {
    /*
     * The regression this whole change exists for, measured rather than
     * argued. Against the REAL height map at the resolution the game ships --
     * the low-resolution map the case below uses has texels 31 units across,
     * which is wider than the clearance itself and cannot answer a question
     * about a 28-unit disc.
     *
     * The sample is every coastal water texel, taken at a stride: water with
     * land in the next texel along is exactly the band a player sails and a
     * raider rams them in, and it is the band the old search failed in. On
     * 600 points drawn this way, **29% had no ring within the old 80-unit
     * SEARCH_MAX** and every one of them was staged across a headland. Not one
     * may fail now, and the answer has to survive the rule being re-run on it.
     *
     * A few of these points are enclosed lakes, which no contact can happen
     * on because `aiboats.ts` will not sail a boat there. They are left in:
     * they only make the sample harder, and filtering them would mean teaching
     * this test about the water-body mask for no gain.
     */
    const terrain = createTerrain(DEFAULT_SEED);
    const heightMap = createHeightMap(terrain);
    const { data, width, height } = heightMap;
    const sea = terrain.seaLevel;

    /** Water with land in the next texel east or south: the shoreline itself. */
    function isCoast(i: number): boolean {
      if (data[i] >= sea) return false;
      const y = (i / width) | 0;
      const x = i - y * width;
      if (data[y * width + ((x + 1) % width)] >= sea) return true;
      return y + 1 < height && data[(y + 1) * width + x] >= sea;
    }

    // Counted first and sampled second, at a stride off the total, so the 120
    // points are spread over every coast on the planet. Taking the first 120
    // in index order would take them all out of one polar ocean.
    let coastCells = 0;
    for (let i = 0; i < data.length; i++) if (isCoast(i)) coastCells++;
    const stride = Math.max(1, Math.floor(coastCells / 120));

    const coastal: Vector3[] = [];
    let seen = 0;
    for (let i = 0; i < data.length && coastal.length < 120; i++) {
      if (!isCoast(i)) continue;
      if (seen++ % stride !== 0) continue;
      const y = (i / width) | 0;
      const x = i - y * width;
      const lat = ((y + 0.5) / height - 0.5) * Math.PI;
      const lon = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      const cosLat = Math.cos(lat);
      coastal.push(
        new Vector3(cosLat * Math.sin(lon), Math.sin(lat), cosLat * Math.cos(lon)).normalize(),
      );
    }
    expect(coastal.length).toBeGreaterThan(60);

    const unplaced: number[] = [];
    const unfit: number[] = [];
    let pastOldCap = 0;
    coastal.forEach((contact, i) => {
      const placed = findRingCentre(heightMap, sea, contact);
      if (!placed.fitted) unplaced.push(i);
      if (!ringFits(heightMap, sea, placed.centre)) unfit.push(i);
      if (placed.moved > ARENA_R0 * 4) pastOldCap++;
    });
    expect(unplaced).toEqual([]);
    expect(unfit).toEqual([]);
    /*
     * And the sample really does exercise the new reach rather than passing
     * because every contact happened to be easy. `ARENA_R0 * 4` is the old
     * SEARCH_MAX to the letter, so this counts the fights the old code staged
     * on land. Asserted loosely -- the exact figure is a fact about one seed
     * and would make this a golden test of the terrain, which it is not.
     */
    expect(pastOldCap).toBeGreaterThan(10);
  });

  it('only calls a ring driven off once it shares no water with the contact', () => {
    /*
     * `RING_DRIVEN_OFF` is what `main.ts` tests `moved` against to decide
     * whether the cover card tells the player the fight was moved, so the
     * threshold has to mean something. It means this: at that distance a ring
     * opened at the new centre and a ring opened at the contact do not
     * overlap, so none of the water the player was sailing is in the fight.
     *
     * Pinned rather than left to read right, because the card's sentence is
     * an assertion about the world -- "no sea room inshore" -- and a threshold
     * quietly retuned below the ring's own diameter would make it a lie on
     * fights that are still staged on the player's own doorstep.
     */
    expect(RING_DRIVEN_OFF).toBeGreaterThanOrEqual(2 * ARENA_R0);
    // And under the clearance the search actually enforces, or it could never
    // fire on a fight that was only just moved clear.
    expect(RING_DRIVEN_OFF).toBeLessThanOrEqual(2 * RING_CLEARANCE);
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
