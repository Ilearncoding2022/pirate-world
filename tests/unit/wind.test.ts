import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createWind, OCEAN_CAP } from '../../src/wind';
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
    const energy = energyState('drain');
    const dt = 0.05;

    let sawPositiveSpeed = false;
    for (let i = 0; i < 250 / dt; i++) {
      wind.update(dt, ship, energy);
      expect(wind.state.speed).toBeLessThanOrEqual(OCEAN_CAP + 1e-6);
      expect(wind.state.speed).toBeGreaterThanOrEqual(0);
      expect(wind.state.direction.length()).toBeCloseTo(1, 6);
      if (wind.state.speed > 0) sawPositiveSpeed = true;
    }
    // Over 250s of calm/event cycling (each phase at most 30s) there must
    // have been at least one event.
    expect(sawPositiveSpeed).toBe(true);
  });

  it('eases the push to zero once docked', () => {
    const terrain = createTerrain(DEFAULT_SEED);
    const heightMap = createHeightMap(terrain, 256, 128);
    const wind = createWind(terrain, heightMap);
    const ship = stationaryShip();
    const dt = 0.05;

    // Run undocked until the wind is actually pushing the hull.
    const sailing = energyState('drain');
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
