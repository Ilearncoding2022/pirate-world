import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createWind, CELL_WIND_LIFT, LULL_SPEED, OCEAN_CAP } from '../../src/wind';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createHeightMap } from '../../src/heightmap';
import { latLonToDir, headingToForward } from '../../src/geo';
import type { EnergyState, ShipState } from '../../src/types';

/**
 * `wind.ts`'s state-machine invariants: the speed ceiling, the unit-length
 * direction, and a berth cutting the push to zero. Runs against the real
 * terrain and a *small* height map (the coast probe only needs the shape of
 * the coastline, not full resolution), because `wind.ts` reads the shared
 * height field for its coast ramp.
 */
function energyState(mode: EnergyState['mode']): EnergyState {
  return { level: 1, rate: 0, mode, dock: null, canThrust: true };
}

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

describe('wind', () => {
  it('never exceeds OCEAN_CAP and keeps direction unit length', () => {
    const terrain = createTerrain(DEFAULT_SEED);
    const heightMap = createHeightMap(terrain, 256, 128);
    const wind = createWind(terrain, heightMap);
    const ship = stationaryShip();
    const energy = energyState('burn');
    const dt = 0.05;

    let sawGust = false;
    const bearings: number[] = [];
    for (let i = 0; i < 250 / dt; i++) {
      wind.update(dt, ship, energy);
      expect(wind.state.speed).toBeLessThanOrEqual(OCEAN_CAP + 1e-6);
      // The floor, and it is the whole point of LULL_SPEED: there is no calm
      // any more, so nothing downstream ever sees a wind that is not blowing.
      // `hud.ts` dropped its CALM state on the strength of this.
      expect(wind.state.speed).toBeGreaterThanOrEqual(LULL_SPEED - 1e-6);
      expect(wind.state.direction.length()).toBeCloseTo(1, 6);
      if (wind.state.speed > LULL_SPEED * 2) sawGust = true;
      if (i % 20 === 0) bearings.push(wind.state.bearing);
    }
    // A floor is not a flat line: over 250 s of cycling (each phase at most
    // 30 s) the wind must still get up well past it.
    expect(sawGust).toBe(true);
    // And it must come round while it is quiet as well as while it blows --
    // a lull draws its own bearing, so the compass cannot sit still for the
    // length of the run.
    const spread = Math.max(...bearings) - Math.min(...bearings);
    expect(spread).toBeGreaterThan(1);
  });

  it('steps phaseIndex once per phase and holds envelope at zero through a lull', () => {
    const terrain = createTerrain(DEFAULT_SEED);
    const heightMap = createHeightMap(terrain, 256, 128);
    const wind = createWind(terrain, heightMap);
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.05;

    let lastIndex = wind.state.phaseIndex;
    let lastPhase = wind.state.phase;
    let transitions = 0;
    for (let i = 0; i < 300 / dt; i++) {
      wind.update(dt, ship, energy);
      const stepped = wind.state.phaseIndex - lastIndex;
      // Never more than one step in a frame, and a step exactly when the
      // phase name changed: `weather.ts` rolls on the step and would roll
      // twice for one phase, or not at all, if either half of that failed.
      expect(stepped === 0 || stepped === 1).toBe(true);
      if (stepped === 1) {
        expect(wind.state.phase).not.toBe(lastPhase);
        transitions++;
      }
      lastIndex = wind.state.phaseIndex;
      lastPhase = wind.state.phase;

      expect(wind.state.phaseTime).toBeGreaterThanOrEqual(0);
      expect(wind.state.phaseTime).toBeLessThanOrEqual(wind.state.phaseDuration + 1e-9);
      expect(wind.state.envelope).toBeGreaterThanOrEqual(0);
      expect(wind.state.envelope).toBeLessThanOrEqual(1);
      // The contract `weather.ts` rides: a lull has no envelope at all.
      if (wind.state.phase === 'lull') expect(wind.state.envelope).toBe(0);
    }
    // 300 s of phases that are at most 30 s long has to cycle several times.
    expect(transitions).toBeGreaterThan(5);
  });

  it('floors the speed inside a storm cell without touching the bearing', () => {
    const terrain = createTerrain(DEFAULT_SEED);
    const heightMap = createHeightMap(terrain, 256, 128);
    const wind = createWind(terrain, heightMap);
    const lifted = createWind(terrain, heightMap);
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.05;

    for (let i = 0; i < 120 / dt; i++) {
      wind.update(dt, ship, energy);
      lifted.update(dt, ship, energy, 1);
      // The floor: inside a full cell the wind is never under its share of
      // the cap, whatever phase it is in.
      expect(lifted.state.speed).toBeGreaterThanOrEqual(
        CELL_WIND_LIFT * lifted.state.cap - 1e-6,
      );
      // And never under the wind it would have been: a floor, not a cap.
      expect(lifted.state.speed).toBeGreaterThanOrEqual(wind.state.speed - 1e-6);
      // The lift moves the speed only. Same seed, same draws, same compass.
      expect(lifted.state.bearing).toBeCloseTo(wind.state.bearing, 9);
    }
  });

  it('eases the push to zero once docked', () => {
    const terrain = createTerrain(DEFAULT_SEED);
    const heightMap = createHeightMap(terrain, 256, 128);
    const wind = createWind(terrain, heightMap);
    const ship = stationaryShip();
    const dt = 0.05;

    // Run undocked until the wind is actually pushing the hull.
    const sailing = energyState('burn');
    let steps = 0;
    while ((wind.state.along === 0 && wind.state.across === 0) && steps < 400 / dt) {
      wind.update(dt, ship, sailing);
      steps++;
    }
    expect(wind.state.along !== 0 || wind.state.across !== 0).toBe(true);

    // Dock, and give the PUSH_TAU (0.3s) ease plenty of time to settle.
    const docked = energyState('docked');
    for (let i = 0; i < 5 / dt; i++) wind.update(dt, ship, docked);

    expect(Math.abs(wind.state.along)).toBeLessThan(1e-6);
    expect(Math.abs(wind.state.across)).toBeLessThan(1e-6);
  });
});
