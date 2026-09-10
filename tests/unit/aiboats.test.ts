import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  CONTACT_RADIUS,
  PHASE_MAX,
  P_ORANGE,
  RED_SPEED,
  ROLL_PERIOD,
  createAiBoats,
} from '../../src/aiboats';
import { createShip } from '../../src/ship';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createHeightMap } from '../../src/heightmap';
import { createWaterBodies } from '../../src/waterbodies';
import { createTowns } from '../../src/towns';
import { createStubTerrain } from './support/stub-terrain';
import { GLOBE_RADIUS, headingToForward, latLonToDir } from '../../src/geo';
import type {
  AiBoat,
  AiBoatKind,
  EnergyState,
  HazardState,
  InputState,
  ShipState,
  Terrain,
  Towns,
  WindState,
} from '../../src/types';

/**
 * `aiboats.ts`'s rule set: the roll's one-of-each promise, a pursuit that
 * connects, a pursuit that can be shaken, the conversion at the end of a
 * clock, the suppression rule and the coast.
 *
 * Two worlds, on purpose. The roll runs against the REAL coastline, because
 * placing a boat is a question about water, reachability and berths and there
 * is no point asking it of a sea with none. Everything after it runs against a
 * flat, empty ocean, because those are questions about geometry and a real
 * shoreline would only decide them by accident. `hazards.test.ts` is the
 * precedent for the first and `ship-physics.test.ts` for the second.
 *
 * Nothing here asserts on how any of it looks; that is rule 1 in
 * docs/TESTING.md and it is what keeps this file cheap.
 */

/* ---- The real world, built once: `createTowns` walks 20 000 candidates ---- */

const terrain = createTerrain(DEFAULT_SEED);
const heightMap = createHeightMap(terrain, 256, 128);
const spawnDir = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
const waterBodies = createWaterBodies(heightMap, terrain.seaLevel, spawnDir);
const towns = createTowns(heightMap, waterBodies, terrain.seaLevel);

/* ---- A flat empty ocean, for the geometry ------------------------------- */

const NO_TOWNS: Towns = { all: [], docks: [], dockAt: () => null };

/** A world with the given land test, its height map and its reachability. */
function stubWorld(heightAt?: (dir: Vector3) => number) {
  const stub = createStubTerrain(heightAt);
  // 128x64 is coarse, and deliberately: nothing below asks a question finer
  // than "which side of this meridian", and the raster is built per test.
  const map = createHeightMap(stub, 128, 64);
  return {
    terrain: stub,
    heightMap: map,
    waterBodies: createWaterBodies(map, stub.seaLevel, latLonToDir(0, 0)),
    towns: NO_TOWNS,
  };
}

const OPEN_OCEAN = stubWorld();

/* ---- Stand-ins for the states this module only reads -------------------- */

const NO_HAZARDS: HazardState = {
  live: [],
  along: 0,
  across: 0,
  phase: 'free',
  drive: null,
};

const NO_WIND: WindState = {
  speed: 0,
  bearing: 0,
  direction: new Vector3(0, 0, 1),
  cap: 16,
  along: 0,
  across: 0,
};

function energyState(mode: EnergyState['mode'] = 'burn'): EnergyState {
  return { level: 1, reserve: 0, rate: 0, mode, dock: null, canThrust: true };
}

function input(overrides: Partial<InputState> = {}): InputState {
  return { forward: false, backward: false, left: false, right: false, zoomDelta: 0, ...overrides };
}

/** A hull stopped at `dir`, heading east. */
function stationaryShip(dir: Vector3 = spawnDir.clone()): ShipState {
  const position = dir.clone().normalize();
  const up = position.clone();
  return {
    position,
    up,
    forward: headingToForward(up, Math.PI / 2),
    heading: Math.PI / 2,
    headingDeg: 90,
    speed: 0,
    groundSpeed: 0,
    velocity: new Vector3(),
    latDeg: 0,
    lonDeg: 0,
  };
}

/** The same great-circle step the module walks, for placing a forced boat. */
function step(from: Vector3, dir: Vector3, worldUnits: number): Vector3 {
  const axis = new Vector3().crossVectors(from, dir).normalize();
  return from.clone().applyAxisAngle(axis, worldUnits / GLOBE_RADIUS).normalize();
}

function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

/** The unit tangent at `at` pointing along the great circle toward `target`. */
function towardOf(at: Vector3, target: Vector3): Vector3 {
  const out = target.clone().addScaledVector(at, -target.dot(at));
  return out.normalize();
}

interface World {
  terrain: Terrain;
  heightMap: ReturnType<typeof createHeightMap>;
  waterBodies: ReturnType<typeof createWaterBodies>;
  towns: Towns;
}

function makeBoats(world: World, onContact: (boat: AiBoat) => void = () => {}) {
  return createAiBoats({ ...world, onContact });
}

const REAL_WORLD: World = { terrain, heightMap, waterBodies, towns };

describe('aiboats: the roll', () => {
  it('raises both colours over 3000 s, and never two of one at once', () => {
    const boats = makeBoats(REAL_WORLD);
    const ship = stationaryShip();
    const energy = energyState();
    const dt = 0.1;
    const seen = new Set<AiBoatKind>();

    // Aggregated rather than asserted inside the loop: thirty thousand frames
    // times four assertions is most of a second of this tier's whole budget,
    // and one violated bound is as loud reported at the end as it is reported
    // in the frame it happened.
    let mostOfAColour = 0;
    let mostLive = 0;
    let worstEnvelope = 0;
    let worstUnit = 0;

    for (let i = 0; i < 3000 / dt; i++) {
      boats.update(dt, ship, energy, NO_HAZARDS, false);
      const live = boats.state.live;
      if (live.length > mostLive) mostLive = live.length;
      let red = 0;
      let orange = 0;
      for (const boat of live) {
        seen.add(boat.kind);
        if (boat.kind === 'red') red++;
        else orange++;
        // `aihulls.ts` writes this straight into an emissive intensity and a
        // rim strength; out of [0, 1] it would either black the hull out or
        // blow it past the bloom knee.
        const out = Math.max(-boat.envelope, boat.envelope - 1);
        if (out > worstEnvelope) worstEnvelope = out;
        const drift = Math.max(
          Math.abs(boat.position.length() - 1),
          Math.abs(boat.forward.length() - 1),
        );
        if (drift > worstUnit) worstUnit = drift;
      }
      const most = Math.max(red, orange);
      if (most > mostOfAColour) mostOfAColour = most;
    }

    // The invariant the hull pool downstream depends on: one clone per colour,
    // so a second of either would be a boat with nothing to draw it.
    expect(mostOfAColour).toBe(1);
    expect(mostLive).toBeLessThanOrEqual(2);
    expect(worstEnvelope).toBe(0);
    expect(worstUnit).toBeLessThan(1e-9);
    expect([...seen].sort()).toEqual(['orange', 'red']);
  });

  it('spawns nothing and fires no contact while the ship is suppressed', () => {
    let contacts = 0;
    const boats = makeBoats(OPEN_OCEAN, () => contacts++);
    const ship = stationaryShip(latLonToDir(0, 0));
    const energy = energyState('docked');
    const dt = 0.1;

    for (let i = 0; i < 40 * ROLL_PERIOD / dt; i++) {
      boats.update(dt, ship, energy, NO_HAZARDS, true);
      expect(boats.state.live.length).toBe(0);
    }

    // And a boat already on the water, put right on top of the hull, still
    // starts no fight: a berth is shelter from raiders as much as from weather.
    boats.force('orange', ship.position, ship.forward);
    for (let i = 0; i < 2 / dt; i++) boats.update(dt, ship, energy, NO_HAZARDS, true);
    expect(contacts).toBe(0);
  });
});

describe('aiboats: pursuit', () => {
  it('runs a red boat down a stationary ship, and fires onContact exactly once', () => {
    let contacts = 0;
    let contacted: AiBoat | null = null;
    const boats = makeBoats(OPEN_OCEAN, (boat) => {
      contacts++;
      contacted = boat;
    });
    const ship = stationaryShip(latLonToDir(0, 0));
    const energy = energyState();
    const dt = 1 / 60;

    const at = step(ship.position, ship.forward, 45);
    boats.force('red', at, towardOf(at, ship.position));

    // 45 units at RED_SPEED is 3 s, comfortably inside the shortest clock,
    // and PHASE_MAX is the longest one this boat could have drawn.
    let contactAt = -1;
    for (let i = 0; i < PHASE_MAX / dt; i++) {
      boats.update(dt, ship, energy, NO_HAZARDS, false);
      if (contactAt < 0 && contacts > 0) contactAt = (i + 1) * dt;
    }
    expect(contacts).toBe(1);
    expect(contactAt).toBeGreaterThan(0);
    expect(contactAt).toBeLessThan(45 / RED_SPEED + 1);
    expect(contacted).not.toBe(null);

    // It keeps sailing after the contact, since `main.ts` owns the boat until
    // it calls `remove`, and it may never open a second fight on the way past.
    for (let i = 0; i < 4 / dt; i++) boats.update(dt, ship, energy, NO_HAZARDS, false);
    expect(contacts).toBe(1);

    boats.remove(contacted as unknown as AiBoat);
    expect(boats.state.live.length).toBe(0);
    expect(boats.state.grace).toBeGreaterThan(0);
  });

  it('is escapable: a hard turn away shakes a red boat, which turns orange', () => {
    let contacts = 0;
    const boats = makeBoats(OPEN_OCEAN, () => contacts++);
    const energy = energyState();
    const dt = 1 / 60;

    // The real hull, at its real top speed, so the escape is measured against
    // `ship.ts`'s own turn rate rather than a hand-rolled one.
    const ship = createShip(OPEN_OCEAN.terrain);
    const ahead = input({ forward: true });
    for (let i = 0; i < 20 / dt; i++) ship.update(dt, ahead, energy, NO_WIND);

    // Abeam to port, at the middle of the red band, bows on to the ship.
    const port = new Vector3().crossVectors(ship.state.up, ship.state.forward).normalize();
    const at = step(ship.state.position, port, 45);
    boats.force('red', at, towardOf(at, ship.state.position));

    // Helm hard over to starboard: away from the chaser's bow, which is the
    // escape. Turning the other way, across it, gets the player rammed.
    const away = input({ forward: true, right: true });
    let closest = Infinity;
    let converted = false;
    for (let i = 0; i < (PHASE_MAX + 2) / dt; i++) {
      boats.update(dt, ship.state, energy, NO_HAZARDS, false);
      ship.update(dt, away, energy, NO_WIND);
      const boat = boats.state.live[0];
      if (boat === undefined) break;
      closest = Math.min(closest, arcDistance(ship.state.position, boat.position));
      if (boat.kind === 'orange') {
        converted = true;
        expect(boat.phase).toBe('wander');
        break;
      }
    }

    expect(contacts).toBe(0);
    expect(closest).toBeGreaterThan(CONTACT_RADIUS);
    expect(converted).toBe(true);
  });

  it('removes a converted boat once its second clock runs out', () => {
    const boats = makeBoats(OPEN_OCEAN);
    const ship = stationaryShip(latLonToDir(0, 0));
    const energy = energyState();
    const dt = 1 / 60;

    // Behind the ship and pointing away, so it never closes and simply runs
    // its pursuit clock out where it is.
    const astern = ship.forward.clone().negate();
    const at = step(ship.position, astern, 50);
    boats.force('red', at, astern);

    let sawOrange = false;
    for (let i = 0; i < 2 * PHASE_MAX / dt; i++) {
      boats.update(dt, ship, energy, NO_HAZARDS, false);
      const boat = boats.state.live[0];
      if (boat !== undefined && boat.kind === 'orange') sawOrange = true;
      if (boats.state.live.length === 0) break;
    }
    expect(sawOrange).toBe(true);
    expect(boats.state.live.length).toBe(0);
  });
});

describe('aiboats: the storm multiplier', () => {
  it('cannot treble the raiders any more, because P_ORANGE saturates', () => {
    const ship = stationaryShip();
    const energy = energyState();
    const dt = 0.1;

    // Count SPAWNS rather than live boats: the population is capped at one of
    // each kind, so a live count saturates before the odds show through.
    function spawnsAt(stormOdds: number): number {
      const boats = makeBoats(REAL_WORLD);
      let spawns = 0;
      let before = new Set(boats.state.live);
      for (let i = 0; i < 6000 / dt; i++) {
        boats.update(dt, ship, energy, NO_HAZARDS, false, stormOdds);
        for (const b of boats.state.live) if (!before.has(b)) spawns++;
        before = new Set(boats.state.live);
      }
      return spawns;
    }

    const calm = spawnsAt(1);
    const storm = spawnsAt(3);
    expect(calm).toBeGreaterThan(0);
    /*
     * This case used to read "raises nearly three times as many raiders", and
     * it was true when P_ORANGE was 0.24: the roll was nowhere near its
     * one-of-each-kind cap, so tripling the probability very nearly tripled
     * the encounters and the ratio came out around 2.9.
     *
     * `c3c0093` TRIPLED P_ORANGE to 0.72 (owner's request: the sea between
     * harbours read as empty). That silently spent the storm multiplier. The
     * draw is `draw < ROLL_ODDS.orange * stormOdds` with no clamp, so at
     * stormOdds 3 the threshold is 2.16 and `rng()` is ALWAYS below it: every
     * roll with no orange alive spawns one. A storm cannot do better than
     * certainty, so the ceiling on this ratio is now 1 / P_ORANGE -- about
     * 1.39 -- and no multiplier above 1/0.72 = 1.39 can move it at all.
     *
     * That is a real behaviour change and not a slack test, so the band is
     * pinned tight around the saturation figure rather than widened to admit
     * the old one. If P_ORANGE ever comes back down, this fails and says so.
     *
     * Red is untouched by any of it: it is exempt from the multiplier (see
     * the case below) and its odds are 0.032, so it barely moves the ratio.
     */
    const ratio = storm / calm;
    expect(P_ORANGE * 3).toBeGreaterThan(1); // the saturation this pins
    expect(ratio).toBeGreaterThan(1.25);
    expect(ratio).toBeLessThan(1.55);
  });

  it('multiplies the wandering raider and never the aggressive one', () => {
    const ship = stationaryShip();
    const energy = energyState();
    const dt = 0.1;

    /** Spawns of each colour over 100 minutes of sim at this multiplier. */
    function spawnsAt(stormOdds: number): Record<AiBoatKind, number> {
      const boats = makeBoats(REAL_WORLD);
      const out: Record<AiBoatKind, number> = { red: 0, orange: 0 };
      let before = new Set(boats.state.live);
      for (let i = 0; i < 6000 / dt; i++) {
        boats.update(dt, ship, energy, NO_HAZARDS, false, stormOdds);
        for (const b of boats.state.live) if (!before.has(b)) out[b.kind]++;
        before = new Set(boats.state.live);
      }
      return out;
    }

    const calm = spawnsAt(1);
    const storm = spawnsAt(3);

    // Orange takes the weather, but only as far as certainty goes: at
    // P_ORANGE 0.72 a tripled threshold saturates, so what shows through is
    // the gap between 0.72 and 1 rather than the factor of three. See the
    // case above for the arithmetic.
    expect(storm.orange).toBeGreaterThan(calm.orange * 1.25);
    expect(storm.orange).toBeLessThan(calm.orange * 1.55);

    /*
     * Red does not. The two counts are not asserted EQUAL, and the reason is
     * worth keeping: `trySpawn` draws its placement from the same seeded
     * stream, so a storm that spawns more orange boats consumes more numbers
     * and every later red draw lands at a different offset. Red's rate is
     * unchanged; the particular boats are not the same boats. So this is a
     * band around the calm count rather than an identity, and it is a band
     * the tripling would blow straight through -- 3x on a count this small
     * is far outside it.
     */
    expect(calm.red).toBeGreaterThan(4);
    expect(storm.red).toBeGreaterThan(calm.red * 0.5);
    expect(storm.red).toBeLessThan(calm.red * 1.6);
  });

  it('defaults stormOdds to 1, so a caller that knows no weather is unchanged', () => {
    const ship = stationaryShip();
    const energy = energyState();
    const dt = 0.1;

    function trace(pass: (b: ReturnType<typeof makeBoats>) => void): string[] {
      const boats = makeBoats(REAL_WORLD);
      const out: string[] = [];
      for (let i = 0; i < 1200 / dt; i++) {
        pass(boats);
        if (i % 100 === 0) out.push(boats.state.live.map((b) => b.kind).join('|'));
      }
      return out;
    }

    expect(trace((b) => b.update(dt, ship, energy, NO_HAZARDS, false))).toEqual(
      trace((b) => b.update(dt, ship, energy, NO_HAZARDS, false, 1)),
    );
  });
});

describe('aiboats: the coast', () => {
  it('removes a boat whose centre steps onto land', () => {
    // Land east of 30 degrees of longitude, open water west of it, so a boat
    // running east out of lon 25 has about 17 units of sea in front of it.
    const world = stubWorld((dir) => (dir.x > 0.5 ? 1 : -1));
    const boats = makeBoats(world);
    const ship = stationaryShip(latLonToDir(0, 0));
    const energy = energyState();
    const dt = 1 / 60;

    const at = latLonToDir(0, 25);
    boats.force('orange', at, headingToForward(at, Math.PI / 2));
    expect(boats.state.live.length).toBe(1);

    let goneAt = -1;
    for (let i = 0; i < 4 / dt; i++) {
      boats.update(dt, ship, energy, NO_HAZARDS, false);
      if (boats.state.live.length === 0) {
        goneAt = (i + 1) * dt;
        break;
      }
    }
    // Gone on the beach, well before its own 5-to-8-second clock could have
    // taken it.
    expect(goneAt).toBeGreaterThan(0);
    expect(goneAt).toBeLessThan(3);
  });
});
