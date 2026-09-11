import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  DRIFT_SHARE,
  FADE_IN,
  LIFE,
  LIVE_MAX,
  P_CEILING,
  P_CLEAR,
  P_TERM,
  ROLL_PERIOD,
  SPAWN_MAX,
  SPAWN_MIN,
  TAKE_RADIUS,
  WEATHER_THRESHOLD,
  createSalvage,
  oddsFor,
} from '../../src/salvage';
import { createHeightMap } from '../../src/heightmap';
import { createWaterBodies } from '../../src/waterbodies';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createTowns } from '../../src/towns';
import { createStubTerrain } from './support/stub-terrain';
import { GLOBE_RADIUS, headingToForward, latLonToDir } from '../../src/geo';
import type { SalvageRaft, ShipState, Towns, WeatherState, WindState } from '../../src/types';

/**
 * `salvage.ts`'s rule set: the weather sum and its ceiling, the ten-second
 * cadence, the three-raft cap, the spawn band, the drift, the life, and the one
 * radius that pays out.
 *
 * Two worlds, for `aiboats.test.ts`'s reason. The roll runs against the REAL
 * coastline, because placing a raft is a question about water, reachability and
 * berths and there is no point asking it of a sea with none; everything about
 * geometry runs against a flat empty ocean, where a real shoreline would only
 * decide things by accident.
 *
 * Nothing here asserts on how any of it looks — rule 1 in docs/TESTING.md.
 */

/* ---- The real world, built once ----------------------------------------- */

const terrain = createTerrain(DEFAULT_SEED);
const heightMap = createHeightMap(terrain, 256, 128);
const spawnDir = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
const waterBodies = createWaterBodies(heightMap, terrain.seaLevel, spawnDir);
const towns = createTowns(heightMap, waterBodies, terrain.seaLevel);
const REAL_WORLD = { terrain, heightMap, waterBodies, towns };

/* ---- A flat empty ocean ------------------------------------------------- */

const NO_TOWNS = { all: [], docks: [], dockAt: () => null, byName: () => null } as unknown as Towns;

function openOcean() {
  const stub = createStubTerrain();
  const map = createHeightMap(stub, 128, 64);
  return {
    terrain: stub,
    heightMap: map,
    waterBodies: createWaterBodies(map, stub.seaLevel, latLonToDir(0, 0)),
    towns: NO_TOWNS,
  };
}

const OPEN_OCEAN = openOcean();

/* ---- Stand-ins for the states this module only reads --------------------- */

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

/** A hull stopped at `dir`, heading east. */
function shipAt(dir: Vector3 = spawnDir.clone()): ShipState {
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
  } as ShipState;
}

function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

/** The great-circle step the module itself walks, for placing a forced raft. */
function step(from: Vector3, dir: Vector3, worldUnits: number): Vector3 {
  const axis = new Vector3().crossVectors(from, dir).normalize();
  return from.clone().applyAxisAngle(axis, worldUnits / GLOBE_RADIUS).normalize();
}

/**
 * Run `seconds` of world at 20 fps, the cadence `main.ts` runs this at, and
 * return every raft that was afloat at any point during it.
 *
 * The step has to be at or under the sim's own 0.1 s clamp or the clock lies:
 * `update` caps `dt` exactly as every other sim here does, so a harness
 * stepping 0.5 at a time advances a fifth of the world it thinks it does. The
 * first draft of this file did, and every rate assertion in it was five times
 * too strict.
 *
 * Rafts are counted by IDENTITY rather than read off `state.live` at the end. A
 * raft lives 120 s out of a roll that lands about every 110 s at the ceiling,
 * so whether one happens to be afloat on the last frame is a coin toss, and an
 * assertion on it would be a flake with a seed for an excuse.
 */
function run(
  salvage: ReturnType<typeof createSalvage>,
  ship: ShipState,
  seconds: number,
  options: { weather?: WeatherState; suppressed?: boolean; w?: WindState } = {},
): Set<SalvageRaft> {
  const dt = 0.05;
  const seen = new Set<SalvageRaft>();
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    salvage.update(dt, ship, options.w ?? CALM, options.suppressed ?? false, options.weather);
    for (const raft of salvage.state.live) seen.add(raft);
  }
  return seen;
}

describe('salvage: the odds', () => {
  it('sums the weather terms and stops at the ceiling', () => {
    expect(oddsFor()).toBe(P_CLEAR);
    expect(oddsFor(sky())).toBe(P_CLEAR);

    const wet = WEATHER_THRESHOLD + 0.01;
    expect(oddsFor(sky({ rain: wet }))).toBeCloseTo(P_CLEAR + P_TERM, 12);
    expect(oddsFor(sky({ fog: wet }))).toBeCloseTo(P_CLEAR + P_TERM, 12);
    expect(oddsFor(sky({ storm: wet }))).toBeCloseTo(P_CLEAR + P_TERM, 12);
    expect(oddsFor(sky({ rain: wet, storm: wet }))).toBeCloseTo(P_CLEAR + 2 * P_TERM, 12);
    expect(oddsFor(sky({ rain: wet, storm: wet, fog: wet }))).toBeCloseTo(P_CEILING, 12);

    // The ceiling is the sum today, so it can only ever bind if a fourth term
    // is added. Pinned anyway: that is the whole reason the `min` is there.
    expect(P_CLEAR + 3 * P_TERM).toBeCloseTo(P_CEILING, 12);
  });

  it('ignores weather under the threshold, so a wisp of fog is not a storm', () => {
    expect(oddsFor(sky({ fog: WEATHER_THRESHOLD }))).toBe(P_CLEAR);
    expect(oddsFor(sky({ rain: WEATHER_THRESHOLD - 0.001 }))).toBe(P_CLEAR);
  });
});

describe('salvage: the roll', () => {
  it('floats rafts in dirty weather and almost none in clear air', () => {
    // The rate end to end, through the real roll rather than through `oddsFor`:
    // an hour of the worst sky against an hour of the clearest, on one seed, so
    // the only difference between the two runs is the weather.
    //
    // 360 rolls at 9.5% is about 34 rafts and at 0.5% is about 2. The bounds
    // are wide on purpose -- this is a Monte Carlo over one seed, and what is
    // being pinned is that dirty weather is the weather salvage happens in.
    const dirty = sky({ rain: 0.5, storm: 0.5, fog: 0.5 });
    const a = createSalvage({ ...REAL_WORLD, seed: 0x5a1a1, onTake: () => {} });
    const inDirty = run(a, shipAt(), 3600, { weather: dirty });

    const b = createSalvage({ ...REAL_WORLD, seed: 0x5a1a1, onTake: () => {} });
    const inClear = run(b, shipAt(), 3600, { weather: sky() });

    expect(inDirty.size).toBeGreaterThan(20);
    expect(inClear.size).toBeLessThan(8);
    expect(inDirty.size).toBeGreaterThan(inClear.size * 4);
  });

  it('rolls on the ten-second clock and not per frame', () => {
    // Hundreds of updates inside one period, at odds that would otherwise have
    // landed several times over, and the sea stays empty: the rate is the
    // cadence times the odds, not the frame rate times the odds.
    const salvage = createSalvage({ ...REAL_WORLD, seed: 1, onTake: () => {} });
    const dirty = sky({ rain: 1, storm: 1, fog: 1 });
    expect(run(salvage, shipAt(), ROLL_PERIOD - 0.1, { weather: dirty }).size).toBe(0);

    // And over sixty periods it does land: about 5.7 rafts at 9.5%.
    expect(run(salvage, shipAt(), ROLL_PERIOD * 60, { weather: dirty }).size).toBeGreaterThan(0);
  });

  it('never floats more than three at once', () => {
    const salvage = createSalvage({ ...REAL_WORLD, seed: 7, onTake: () => {} });
    const dirty = sky({ rain: 1, storm: 1, fog: 1 });
    const ship = shipAt();
    let peak = 0;
    // Two hours, because the cap is meant to bind rarely: a raft every ~110 s
    // against a 120 s life means three afloat at once is a coincidence that has
    // to be waited for, and a cap no test ever reaches is a cap not under test.
    for (let i = 0; i < 144000; i++) {
      salvage.update(0.05, ship, CALM, false, dirty);
      peak = Math.max(peak, salvage.state.live.length);
      expect(salvage.state.live.length).toBeLessThanOrEqual(LIVE_MAX);
    }
    expect(peak).toBe(LIVE_MAX);
  });

  it('floats nothing while suppressed', () => {
    const salvage = createSalvage({ ...REAL_WORLD, seed: 3, onTake: () => {} });
    const seen = run(salvage, shipAt(), 3600, {
      weather: sky({ rain: 1, storm: 1, fog: 1 }),
      suppressed: true,
    });
    expect(seen.size).toBe(0);
    expect(salvage.state.live.length).toBe(0);
  });

  it('replays: one seed, one sea', () => {
    const dirty = sky({ rain: 1, storm: 1 });
    const runs: string[][] = [];
    for (let pass = 0; pass < 2; pass++) {
      const salvage = createSalvage({ ...REAL_WORLD, seed: 0xabcdef, onTake: () => {} });
      const seen = run(salvage, shipAt(), 3600, { weather: dirty });
      runs.push(
        Array.from(seen).map((raft) =>
          [
            raft.position.x.toFixed(9),
            raft.position.y.toFixed(9),
            raft.radius.toFixed(9),
            raft.yaw.toFixed(9),
          ].join('/'),
        ),
      );
    }
    expect(runs[0].length).toBeGreaterThan(5);
    expect(runs[0]).toEqual(runs[1]);
  });

  it('places rafts inside the band, over water, and never on the bow', () => {
    const salvage = createSalvage({ ...REAL_WORLD, seed: 0x5eabed, onTake: () => {} });
    const ship = shipAt();
    // The ship never moves and the air is calm, so a raft's position when it is
    // first seen is the position it was rolled at, which is what the band is
    // about. No slack is needed for drift, and none is given.
    const seen = run(salvage, ship, 3600, { weather: sky({ rain: 1, storm: 1, fog: 1 }) });
    expect(seen.size).toBeGreaterThan(10);
    for (const raft of seen) {
      const d = arcDistance(ship.position, raft.position);
      expect(d).toBeGreaterThanOrEqual(SPAWN_MIN);
      expect(d).toBeLessThanOrEqual(SPAWN_MAX);
      expect(d).toBeGreaterThan(TAKE_RADIUS * 2);
      expect(terrain.isLand(raft.position)).toBe(false);
    }
  });
});

describe('salvage: taking one', () => {
  it('pays inside the take radius and not outside it', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const east = headingToForward(ship.position.clone(), Math.PI / 2);

    // Just outside: nothing, however long the world runs.
    {
      const taken: SalvageRaft[] = [];
      const salvage = createSalvage({ ...OPEN_OCEAN, onTake: (r) => taken.push(r) });
      salvage.force(step(ship.position, east, TAKE_RADIUS + 0.2));
      run(salvage, ship, 5);
      expect(taken.length).toBe(0);
      expect(salvage.state.live.length).toBe(1);
    }

    // Just inside: paid on the first frame, and gone from `live` before the
    // callback — which is the contract `main.ts`'s notice leans on.
    {
      const taken: SalvageRaft[] = [];
      let liveAtCallback = -1;
      const salvage = createSalvage({
        ...OPEN_OCEAN,
        onTake: (r) => {
          taken.push(r);
          liveAtCallback = salvage.state.live.length;
        },
      });
      salvage.force(step(ship.position, east, TAKE_RADIUS - 0.2));
      salvage.update(0.05, ship, CALM, false);
      expect(taken.length).toBe(1);
      expect(liveAtCallback).toBe(0);
      expect(salvage.state.live.length).toBe(0);
    }
  });

  it('takes nothing while suppressed, and the raft is still there afterwards', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const taken: SalvageRaft[] = [];
    const salvage = createSalvage({ ...OPEN_OCEAN, onTake: (r) => taken.push(r) });
    salvage.force(ship.position.clone());
    run(salvage, ship, 2, { suppressed: true });
    expect(taken.length).toBe(0);
    expect(salvage.state.live.length).toBe(1);

    salvage.update(0.05, ship, CALM, false);
    expect(taken.length).toBe(1);
  });

  it('pays once per raft, never twice', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const taken: SalvageRaft[] = [];
    const salvage = createSalvage({ ...OPEN_OCEAN, onTake: (r) => taken.push(r) });
    salvage.force(ship.position.clone());
    run(salvage, ship, 10);
    expect(taken.length).toBe(1);
  });
});

describe('salvage: a raft afloat', () => {
  it('fades in over half a second and sinks at the end of its life', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const north = headingToForward(ship.position.clone(), 0);
    const salvage = createSalvage({ ...OPEN_OCEAN, onTake: () => {} });
    salvage.force(step(ship.position, north, 40));

    // In 0.05 steps, because `update` clamps a frame at 0.1 s and a single
    // quarter-second call would advance the age by a tenth of a second.
    run(salvage, ship, FADE_IN / 2);
    expect(salvage.state.live[0].envelope).toBeGreaterThan(0.3);
    expect(salvage.state.live[0].envelope).toBeLessThan(0.7);

    run(salvage, ship, 5);
    expect(salvage.state.live[0].envelope).toBe(1);

    run(salvage, ship, LIFE);
    expect(salvage.state.live.length).toBe(0);
  });

  it('drifts downwind at a fifth of the wind, and keeps no heading of its own', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const north = headingToForward(ship.position.clone(), 0);
    const salvage = createSalvage({ ...OPEN_OCEAN, onTake: () => {} });
    const born = step(ship.position, north, 40);
    salvage.force(born.clone());

    const blow = 10;
    const direction = headingToForward(born.clone(), Math.PI / 2);
    for (let t = 0; t < 10; t += 0.05) {
      salvage.update(0.05, ship, wind(blow, direction), false);
    }

    // Ten seconds at a fifth of ten knots is twenty units of travel.
    const moved = arcDistance(born, salvage.state.live[0].position);
    expect(moved).toBeCloseTo(blow * DRIFT_SHARE * 10, 0);

    // And the direction is the wind's, not the ship's.
    const toward = salvage.state.live[0].position.clone().sub(born).normalize();
    expect(toward.dot(direction)).toBeGreaterThan(0.9);
  });

  it('does not drift in a calm', () => {
    const ship = shipAt(latLonToDir(0, 0));
    const north = headingToForward(ship.position.clone(), 0);
    const salvage = createSalvage({ ...OPEN_OCEAN, onTake: () => {} });
    const born = step(ship.position, north, 40);
    salvage.force(born.clone());
    run(salvage, ship, 10);
    expect(arcDistance(born, salvage.state.live[0].position)).toBeLessThan(1e-9);
  });

  it('sinks a raft the wind has driven ashore', () => {
    // A world that is land east of the prime meridian. The raft is floated a
    // little west of it and blown east until it grounds.
    const stub = createStubTerrain((dir) => (dir.x > 0 && dir.z > 0 ? 1 : -1));
    const map = createHeightMap(stub, 128, 64);
    const world = {
      terrain: stub,
      heightMap: map,
      waterBodies: createWaterBodies(map, stub.seaLevel, latLonToDir(0, -90)),
      towns: NO_TOWNS,
    };
    const ship = shipAt(latLonToDir(0, -20));
    const salvage = createSalvage({ ...world, onTake: () => {} });
    const born = latLonToDir(10, -10);
    salvage.force(born);
    expect(salvage.state.live.length).toBe(1);

    const east = headingToForward(born.clone(), Math.PI / 2);
    for (let t = 0; t < 60 && salvage.state.live.length > 0; t += 0.1) {
      salvage.update(0.1, ship, wind(16, east), false);
    }
    expect(salvage.state.live.length).toBe(0);
  });
});
