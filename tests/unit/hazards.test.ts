import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createHazards, DISSIPATE, PUSH_PEAK, SPIRAL_SECONDS } from '../../src/hazards';
import { MAELSTROM_RADIUS, MAX_HAZARDS } from '../../src/hazardfield';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createHeightMap } from '../../src/heightmap';
import { createWaterBodies } from '../../src/waterbodies';
import { createTowns } from '../../src/towns';
import { LULL_SPEED, OCEAN_CAP } from '../../src/wind';
import { GLOBE_RADIUS, latLonToDir, headingToForward } from '../../src/geo';
import type { EnergyState, HazardKind, ShipState, WindState } from '../../src/types';

/**
 * `hazards.ts`'s rule set, against the real world it will run in: the roll's
 * one-of-each promise, the shape of the push, the spiral's invariants, the
 * berth's immunity, and the respawn's guarantees. The height map is small on
 * purpose — every reader here only needs the shape of the coastline, and the
 * whole tier has two seconds to spend.
 *
 * Nothing here asserts on how any of it looks; that is rule 1 in
 * docs/TESTING.md and it is what keeps this file cheap.
 */

/** Built once and shared: `createTowns` walks 20 000 candidates. */
const terrain = createTerrain(DEFAULT_SEED);
const heightMap = createHeightMap(terrain, 256, 128);
const spawnDir = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
const waterBodies = createWaterBodies(heightMap, terrain.seaLevel, spawnDir);
const towns = createTowns(heightMap, waterBodies, terrain.seaLevel);

function energyState(mode: EnergyState['mode']): EnergyState {
  return { level: 1, reserve: 0, rate: 0, mode, dock: null, canThrust: true };
}

/** A hull stopped in the open ocean at the world's spawn point, heading east. */
function stationaryShip(): ShipState {
  const position = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
  const up = position.clone();
  const forward = headingToForward(up, Math.PI / 2);
  return {
    position,
    up,
    forward,
    heading: Math.PI / 2,
    headingDeg: 90,
    speed: 0,
    groundSpeed: 0,
    velocity: new Vector3(),
    latDeg: SPAWN_LAT_DEG,
    lonDeg: SPAWN_LON_DEG,
  };
}

/**
 * A steady wind at the spawn point, blowing due east.
 *
 * Fixed rather than random because crests now take their heading from it: a
 * wind that wandered between runs would move every wave the roll produces,
 * and the one-of-each promise below would stop being the thing under test.
 * `speed` sits at the floor `wind.ts` guarantees — see LULL_SPEED — which is
 * also the case that used to be a dead calm.
 */
function windState(): WindState {
  const position = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
  return {
    speed: LULL_SPEED,
    bearing: Math.PI / 2,
    direction: headingToForward(position, Math.PI / 2),
    cap: OCEAN_CAP,
    along: 0,
    across: 0,
  };
}

/**
 * Shared, because `hazards.ts` only ever READS a wind — it copies the
 * direction out and never writes it back — so one object cannot leak state
 * between these tests the way a shared ship or energy state would.
 */
const wind = windState();

/** The same great-circle step the module walks, for placing a forced hazard. */
function step(from: Vector3, dir: Vector3, worldUnits: number): Vector3 {
  const axis = new Vector3().crossVectors(from, dir).normalize();
  return from.clone().applyAxisAngle(axis, worldUnits / GLOBE_RADIUS).normalize();
}

function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

function makeHazards(onSunk: () => void = () => {}) {
  return createHazards({ terrain, heightMap, waterBodies, towns, onSunk });
}

describe('hazards — the roll', () => {
  it('raises every kind over an hour of rolls, and never two of a kind at once', () => {
    const hazards = makeHazards();
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.1;
    const seen = new Set<HazardKind>();

    for (let i = 0; i < 3000 / dt; i++) {
      hazards.update(dt, ship, energy, wind);
      const live = hazards.state.live;
      expect(live.length).toBeLessThanOrEqual(MAX_HAZARDS);
      let wave = 0;
      let great = 0;
      let maelstrom = 0;
      for (const h of live) {
        seen.add(h.kind);
        if (h.kind === 'wave') wave++;
        else if (h.kind === 'greatwave') great++;
        else maelstrom++;
        // The one number every consumer reads. Out of [0, 1] it would either
        // flatten the sea or blow the displacement past the patch's skirt.
        expect(h.envelope).toBeGreaterThanOrEqual(0);
        expect(h.envelope).toBeLessThanOrEqual(1);
        expect(h.centre.length()).toBeCloseTo(1, 6);
      }
      expect(Math.max(wave, great, maelstrom)).toBeLessThanOrEqual(1);
    }

    expect([...seen].sort()).toEqual(['greatwave', 'maelstrom', 'wave']);
  });
});

describe('hazards — the push', () => {
  it('shoves the hull the way the crest went, peaking at PUSH_PEAK and gone by DISSIPATE', () => {
    const hazards = makeHazards();
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.05;

    // Dead astern of the bow: a crest travelling the way the ship points is
    // pure `along`, which is the pair's whole convention.
    hazards.force('greatwave', ship.position, ship.forward);
    let peakAlong = 0;
    let peakAcross = 0;
    for (let t = 0; t < DISSIPATE.greatwave - dt; t += dt) {
      hazards.update(dt, ship, energy, wind);
      peakAlong = Math.max(peakAlong, hazards.state.along);
      peakAcross = Math.max(peakAcross, Math.abs(hazards.state.across));
    }
    expect(peakAlong).toBeGreaterThan(PUSH_PEAK.greatwave * 0.9);
    expect(peakAlong).toBeLessThan(PUSH_PEAK.greatwave * 1.1);
    expect(peakAcross).toBeLessThan(PUSH_PEAK.greatwave * 0.02);

    // One dissipation later the hump is over and the crest is gone with it.
    for (let t = 0; t < 1; t += dt) hazards.update(dt, ship, energy, wind);
    expect(hazards.state.along).toBe(0);
    expect(hazards.state.across).toBe(0);
    expect(hazards.state.live.length).toBe(0);

    // And a crest crossing the bow is pure `across`, on the starboard sign.
    hazards.reset();
    const starboard = new Vector3().crossVectors(ship.forward, ship.up).normalize();
    hazards.force('wave', ship.position, starboard);
    peakAlong = 0;
    peakAcross = 0;
    for (let t = 0; t < DISSIPATE.wave - dt; t += dt) {
      hazards.update(dt, ship, energy, wind);
      peakAcross = Math.max(peakAcross, hazards.state.across);
      peakAlong = Math.max(peakAlong, Math.abs(hazards.state.along));
    }
    expect(peakAcross).toBeGreaterThan(PUSH_PEAK.wave * 0.9);
    expect(peakAcross).toBeLessThan(PUSH_PEAK.wave * 1.1);
    expect(peakAlong).toBeLessThan(PUSH_PEAK.wave * 0.02);
  });
});

describe('hazards — capture', () => {
  it('spirals the hull to the centre and sinks it once, at SPIRAL_SECONDS', () => {
    let sunk = 0;
    const hazards = makeHazards(() => sunk++);
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.05;

    // Five units off the bow: outside the funnel while it is small, inside it
    // well before the growth envelope is done.
    const centre = step(ship.position, ship.forward, 5);
    hazards.force('maelstrom', centre, ship.forward);

    let captureAt = -1;
    let sunkAt = -1;
    for (let i = 0; i < 20 / dt; i++) {
      hazards.update(dt, ship, energy, wind);
      const t = (i + 1) * dt;
      if (captureAt < 0 && hazards.state.phase !== 'free') captureAt = t;
      if (sunkAt < 0 && hazards.state.phase === 'sunk') sunkAt = t;

      const drive = hazards.state.drive;
      expect(drive === null).toBe(hazards.state.phase === 'free');
      if (drive !== null) {
        // `ship.ts` copies this straight into its own position without
        // checking it, so a drifting length would silently lift or sink the
        // whole hull off the sphere.
        expect(drive.position.length()).toBeCloseTo(1, 6);
        expect(drive.forward.length()).toBeCloseTo(1, 6);
        expect(arcDistance(drive.position, centre)).toBeLessThanOrEqual(MAELSTROM_RADIUS + 1e-6);
        expect(drive.sink).toBeGreaterThanOrEqual(0);
      }
    }

    expect(captureAt).toBeGreaterThan(0);
    // The capture frame places the drive and starts the clock at zero, so the
    // spiral runs SPIRAL_SECONDS from the frame after it: one frame of slack,
    // and no more.
    expect(sunkAt - captureAt).toBeGreaterThanOrEqual(SPIRAL_SECONDS);
    expect(sunkAt - captureAt).toBeLessThanOrEqual(SPIRAL_SECONDS + 2 * dt);
    expect(sunk).toBe(1);
    // The funnel holds the wreck past its own life, and the state stays sunk
    // until `main.ts` has finished the blackout and reset it.
    expect(hazards.state.phase).toBe('sunk');
    expect(hazards.state.drive?.position.distanceTo(centre)).toBeLessThan(1e-6);

    hazards.reset();
    expect(hazards.state.phase).toBe('free');
    expect(hazards.state.drive).toBe(null);
    expect(hazards.state.live.length).toBe(0);
  });
});

describe('hazards — a berth is shelter', () => {
  it('neither pushes nor captures a docked hull', () => {
    const ship = stationaryShip();
    const docked = energyState('docked');
    const dt = 0.05;

    let sunk = 0;
    const hazards = makeHazards(() => sunk++);
    hazards.force('greatwave', ship.position, ship.forward);
    hazards.force('maelstrom', ship.position, ship.forward);

    for (let i = 0; i < 12 / dt; i++) {
      hazards.update(dt, ship, docked, wind);
      expect(hazards.state.along).toBe(0);
      expect(hazards.state.across).toBe(0);
      expect(hazards.state.phase).toBe('free');
      expect(hazards.state.drive).toBe(null);
    }
    expect(sunk).toBe(0);
  });
});

describe('hazards — pickRespawn', () => {
  it('lands on reachable ocean, clear of land and of every berth', () => {
    const hazards = makeHazards();
    const berths = towns.all.map((t) => t.dock).filter((d) => d !== null);
    expect(berths.length).toBeGreaterThan(0);
    const widest = Math.max(...berths.map((d) => d.radius));

    for (let i = 0; i < 20; i++) {
      const p = hazards.pickRespawn();
      expect(p.length()).toBeCloseTo(1, 6);
      expect(heightMap.sample(p)).toBeLessThan(terrain.seaLevel);
      expect(waterBodies.sample(p)).toBeLessThan(0.5);
      for (const dock of berths) {
        expect(arcDistance(p, dock.dir)).toBeGreaterThanOrEqual(2 * widest);
      }
    }
  });
});
