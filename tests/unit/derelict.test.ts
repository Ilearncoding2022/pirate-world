import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  FADE_IN,
  HOOK_RADIUS,
  P_CEILING,
  P_CLEAR,
  P_TERM,
  ROLL_PERIOD,
  SPAWN_MAX,
  SPAWN_MIN,
  TOW_DISTANCE,
  VOYAGE_MAX,
  VOYAGE_MIN,
  createDerelicts,
  oddsFor,
} from '../../src/derelict';
import { WEATHER_THRESHOLD } from '../../src/salvage';
import { createHeightMap } from '../../src/heightmap';
import { createWaterBodies } from '../../src/waterbodies';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createTowns } from '../../src/towns';
import { GLOBE_RADIUS, headingToForward, latLonToDir } from '../../src/geo';
import type { Derelict, ShipState, WeatherState, WindState } from '../../src/types';

/**
 * `derelict.ts`'s rule set: the odds, the one-at-a-time cap, the harbour band,
 * the hook ring, the tow's geometry, and the three ways a tow ends.
 *
 * All of it against the REAL world, unlike `salvage.test.ts`'s split: every
 * question here involves a harbour — where one is bound, how far, whether the
 * band can be satisfied — and a sea with no harbours in it cannot answer any of
 * them.
 *
 * Nothing here asserts on how any of it looks — rule 1 in docs/TESTING.md.
 */

const terrain = createTerrain(DEFAULT_SEED);
const heightMap = createHeightMap(terrain, 256, 128);
const spawnDir = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
const waterBodies = createWaterBodies(heightMap, terrain.seaLevel, spawnDir);
const towns = createTowns(heightMap, waterBodies, terrain.seaLevel);
const WORLD = { terrain, heightMap, waterBodies, towns };

function wind(speed = 0, direction = new Vector3(0, 0, 1)): WindState {
  return {
    speed,
    bearing: 0,
    direction,
    cap: 16,
    along: 0,
    across: 0,
    phase: 'event',
    phaseTime: 0,
    phaseDuration: 10,
    phaseIndex: 0,
    envelope: 1,
  };
}

const CALM = wind();

function sky(overrides: Partial<WeatherState> = {}): WeatherState {
  return {
    kind: 'clear',
    cover: 0,
    rain: 0,
    storm: 0,
    fog: 0,
    flash: 0,
    flashLocal: false,
    flashOrigin: null,
    flashSeed: 0,
    visibility: 50,
    ...overrides,
  } as WeatherState;
}

/** A hull at `dir` heading `headingRad`, stopped. */
function shipAt(dir: Vector3 = spawnDir.clone(), headingRad = Math.PI / 2): ShipState {
  const position = dir.clone().normalize();
  const up = position.clone();
  return {
    position,
    up,
    forward: headingToForward(up, headingRad),
    heading: headingRad,
    headingDeg: (headingRad * 180) / Math.PI,
    speed: 0,
    groundSpeed: 0,
    velocity: new Vector3(),
    latDeg: 0,
    lonDeg: 0,
  } as ShipState;
}

function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

function step(from: Vector3, dir: Vector3, worldUnits: number): Vector3 {
  const axis = new Vector3().crossVectors(from, dir).normalize();
  return from.clone().applyAxisAngle(axis, worldUnits / GLOBE_RADIUS).normalize();
}

/** Run `seconds` at 20 fps, under the sim's own 0.1 s frame clamp. */
function run(
  derelicts: ReturnType<typeof createDerelicts>,
  ship: ShipState,
  seconds: number,
  options: { weather?: WeatherState; suppressed?: boolean; w?: WindState } = {},
): Set<Derelict> {
  const dt = 0.05;
  const seen = new Set<Derelict>();
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    derelicts.update(dt, ship, options.w ?? CALM, options.suppressed ?? false, options.weather);
    if (derelicts.state.live !== null) seen.add(derelicts.state.live);
  }
  return seen;
}

describe('derelict: the odds', () => {
  it('sums the weather terms, stops at the ceiling, and is a tenth of the salvage', () => {
    expect(oddsFor()).toBe(P_CLEAR);
    const wet = WEATHER_THRESHOLD + 0.01;
    expect(oddsFor(sky({ rain: wet }))).toBeCloseTo(P_CLEAR + P_TERM, 12);
    expect(oddsFor(sky({ rain: wet, storm: wet, fog: wet }))).toBeCloseTo(P_CEILING, 12);

    // And here the cap actually BINDS, which is the one place this table
    // differs from the salvage's: the raw sum is 3.2% and the ceiling takes it
    // back to a round 3%. See the comment on P_CEILING.
    expect(P_CLEAR + 3 * P_TERM).toBeGreaterThan(P_CEILING);
    expect(P_CEILING).toBe(0.03);

    // The relationship to the salvage is the design, not a coincidence: a raft
    // is a find and a derelict is a commitment, so it may not arrive as often.
    expect(P_CLEAR * 10).toBeCloseTo(0.02, 12);
    expect(P_CEILING).toBeLessThan(0.095 / 3);
  });
});

describe('derelict: the roll', () => {
  it('is rare in clear air and ten times likelier in the worst weather', () => {
    const a = createDerelicts({ ...WORLD, seed: 0xd00d });
    let clearFound = 0;
    // Hooking it is what makes room for the next one, so a run that never hooks
    // measures the FIRST wreck and nothing else. Each one is taken off the water
    // the moment it appears, which is what turns this into a rate.
    for (let i = 0; i < 3600 / 0.05; i++) {
      a.update(0.05, shipAt(), CALM, false, sky());
      if (a.state.live !== null) {
        clearFound++;
        a.force(spawnDir.clone());
        a.lose();
        // `force` then `lose` is the shortest way to empty the slot; `lose`
        // refuses an untowed hull, so the forced one is hooked first.
        if (a.state.live !== null) {
          a.update(0.05, shipAt(), CALM, false, sky());
          a.hook();
          a.lose();
        }
      }
    }

    const b = createDerelicts({ ...WORLD, seed: 0xd00d });
    let dirtyFound = 0;
    const dirty = sky({ rain: 1, storm: 1, fog: 1 });
    for (let i = 0; i < 3600 / 0.05; i++) {
      b.update(0.05, shipAt(), CALM, false, dirty);
      if (b.state.live !== null) {
        dirtyFound++;
        b.force(spawnDir.clone());
        if (b.state.live !== null) {
          b.update(0.05, shipAt(), CALM, false, dirty);
          b.hook();
          b.lose();
        }
      }
    }

    // An hour is 360 rolls: about 0.7 wrecks in clear air and about 11 in the
    // worst sky the globe has.
    expect(dirtyFound).toBeGreaterThan(3);
    expect(dirtyFound).toBeGreaterThan(clearFound);
  });

  it('never has two at once, and rolls nothing while one is still out there', () => {
    const derelicts = createDerelicts({ ...WORLD, seed: 5 });
    const seen = run(derelicts, shipAt(), 7200, { weather: sky({ rain: 1, storm: 1, fog: 1 }) });
    // One object, ever, for as long as it is not taken off the water.
    expect(seen.size).toBe(1);
    expect(derelicts.state.live).not.toBeNull();
  });

  it('rolls nothing while suppressed', () => {
    const derelicts = createDerelicts({ ...WORLD, seed: 11 });
    const seen = run(derelicts, shipAt(), 7200, {
      weather: sky({ rain: 1, storm: 1, fog: 1 }),
      suppressed: true,
    });
    expect(seen.size).toBe(0);
  });

  it('rolls on the ten-second clock', () => {
    const derelicts = createDerelicts({ ...WORLD, seed: 13 });
    const dirty = sky({ rain: 1, storm: 1, fog: 1 });
    expect(run(derelicts, shipAt(), ROLL_PERIOD - 0.1, { weather: dirty }).size).toBe(0);
  });

  it('places one in the spawn band, over water, bound for a harbour in the voyage band', () => {
    const ship = shipAt();
    let checked = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const derelicts = createDerelicts({ ...WORLD, seed });
      run(derelicts, ship, 3600, { weather: sky({ rain: 1, storm: 1, fog: 1 }) });
      const live = derelicts.state.live;
      if (live === null) continue;
      checked++;

      const off = arcDistance(ship.position, live.position);
      expect(off).toBeGreaterThanOrEqual(SPAWN_MIN);
      expect(off).toBeLessThanOrEqual(SPAWN_MAX);
      expect(terrain.isLand(live.position)).toBe(false);

      // The harbour it names has to exist in this world, and the distance it
      // recorded has to be the distance to it.
      const target = towns.byName(live.bound);
      expect(target).not.toBeNull();
      expect(target?.dock).not.toBeNull();
      const voyage = arcDistance(live.position, target!.dock!.dir);
      expect(voyage).toBeGreaterThanOrEqual(VOYAGE_MIN);
      expect(voyage).toBeLessThanOrEqual(VOYAGE_MAX);
      expect(live.voyage).toBeCloseTo(voyage, 6);
    }
    expect(checked).toBeGreaterThan(3);
  });
});

describe('derelict: hooking one', () => {
  it('offers the ring only inside HOOK_RADIUS, and only while it is adrift', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const east = headingToForward(ship.position.clone(), Math.PI / 2);
    const derelicts = createDerelicts(WORLD);

    // Outside: no offer, and a press does nothing.
    derelicts.force(step(ship.position, east, HOOK_RADIUS + 0.5));
    derelicts.update(0.05, ship, CALM, false);
    expect(derelicts.state.hookReady).toBe(false);
    expect(derelicts.hook()).toBe(false);
    expect(derelicts.state.live?.towed).toBe(false);

    // Inside: offered, and the press takes.
    derelicts.lose();
    derelicts.force(step(ship.position, east, HOOK_RADIUS - 0.5));
    derelicts.update(0.05, ship, CALM, false);
    expect(derelicts.state.hookReady).toBe(true);
    expect(derelicts.hook()).toBe(true);
    expect(derelicts.state.live?.towed).toBe(true);
    // And the offer goes down the moment it is on the line, so a second press
    // cannot re-hook a hull that is already being towed.
    expect(derelicts.state.hookReady).toBe(false);
    expect(derelicts.hook()).toBe(false);
  });

  it('makes no offer while suppressed', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const derelicts = createDerelicts(WORLD);
    derelicts.force(ship.position.clone());
    derelicts.update(0.05, ship, CALM, true);
    expect(derelicts.state.hookReady).toBe(false);
    expect(derelicts.hook()).toBe(false);
  });

  it('fades in over a second and never fades out', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const north = headingToForward(ship.position.clone(), 0);
    const derelicts = createDerelicts(WORLD);
    derelicts.force(step(ship.position, north, 40));

    run(derelicts, ship, FADE_IN / 2);
    expect(derelicts.state.live!.envelope).toBeGreaterThan(0.3);
    expect(derelicts.state.live!.envelope).toBeLessThan(0.7);

    run(derelicts, ship, 600);
    // Ten minutes later it is still there, still lit: a derelict has no life.
    expect(derelicts.state.live).not.toBeNull();
    expect(derelicts.state.live!.envelope).toBe(1);
  });
});

describe('derelict: under tow', () => {
  it('rides six units astern, bow toward the ship, wherever the ship goes', () => {
    let ship = shipAt(latLonToDir(0, 0));
    const derelicts = createDerelicts(WORLD);
    derelicts.force(ship.position.clone());
    derelicts.update(0.05, ship, CALM, false);
    expect(derelicts.hook()).toBe(true);

    for (const heading of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      for (const lat of [0, 45, 85]) {
        ship = shipAt(latLonToDir(lat, 20), heading);
        derelicts.update(0.05, ship, CALM, false);
        const live = derelicts.state.live!;

        // Six units back, on the bow's own line.
        expect(arcDistance(ship.position, live.position)).toBeCloseTo(TOW_DISTANCE, 6);
        const asternOfShip = step(ship.position, ship.forward.clone().negate(), TOW_DISTANCE);
        expect(arcDistance(asternOfShip, live.position)).toBeLessThan(1e-6);

        // And pointing at the ship, not trailing backwards.
        const toShip = ship.position
          .clone()
          .addScaledVector(live.position, -ship.position.dot(live.position))
          .normalize();
        expect(live.forward.dot(toShip)).toBeGreaterThan(0.999);
      }
    }
  });

  it('does not drift once it is on the line, whatever the wind does', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const derelicts = createDerelicts(WORLD);
    derelicts.force(ship.position.clone());
    derelicts.update(0.05, ship, CALM, false);
    derelicts.hook();

    const gale = wind(16, headingToForward(ship.position.clone(), Math.PI / 2));
    run(derelicts, ship, 30, { w: gale });
    // Still exactly astern of a ship that has not moved.
    expect(arcDistance(ship.position, derelicts.state.live!.position)).toBeCloseTo(TOW_DISTANCE, 6);
  });

  it('drifts downwind while it is still adrift', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const north = headingToForward(ship.position.clone(), 0);
    const derelicts = createDerelicts(WORLD);
    const born = step(ship.position, north, 40);
    derelicts.force(born.clone());

    const direction = headingToForward(born.clone(), Math.PI / 2);
    run(derelicts, ship, 10, { w: wind(10, direction) });
    // A fifth of ten knots for ten seconds.
    expect(arcDistance(born, derelicts.state.live!.position)).toBeCloseTo(20, 0);
  });
});

describe('derelict: the three ways a tow ends', () => {
  function towed() {
    const ship = shipAt(latLonToDir(0, 0));
    const derelicts = createDerelicts(WORLD);
    derelicts.force(ship.position.clone());
    derelicts.update(0.05, ship, CALM, false);
    derelicts.hook();
    return { ship, derelicts };
  }

  it('releases by hand, and the hull is gone from the water', () => {
    const { derelicts } = towed();
    const dropped = derelicts.release();
    expect(dropped).not.toBeNull();
    expect(dropped!.towed).toBe(true);
    expect(derelicts.state.live).toBeNull();
    expect(derelicts.release()).toBeNull();
  });

  it('is lost outright, and settles, and both answer null when nothing is towed', () => {
    expect(towed().derelicts.lose()).not.toBeNull();
    expect(towed().derelicts.settle()).not.toBeNull();

    const derelicts = createDerelicts(WORLD);
    expect(derelicts.lose()).toBeNull();
    expect(derelicts.settle()).toBeNull();
    expect(derelicts.release()).toBeNull();
  });

  it('leaves a hull that is merely adrift alone: none of the three touch it', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const derelicts = createDerelicts(WORLD);
    derelicts.force(ship.position.clone());
    derelicts.update(0.05, ship, CALM, false);

    // Nothing is on the line, so losing a tow, settling one or casting one off
    // are all no-ops -- an empty tank does not sink a wreck the player never
    // touched, and mooring at its harbour does not pay for a hull still at sea.
    expect(derelicts.lose()).toBeNull();
    expect(derelicts.settle()).toBeNull();
    expect(derelicts.release()).toBeNull();
    expect(derelicts.state.live).not.toBeNull();
    expect(derelicts.state.live!.towed).toBe(false);
  });

  it('makes room for the next roll once the slot is empty', () => {
    const { derelicts } = towed();
    derelicts.settle();
    const seen = run(derelicts, shipAt(), 3600, { weather: sky({ rain: 1, storm: 1, fog: 1 }) });
    expect(seen.size).toBeGreaterThan(0);
  });
});
