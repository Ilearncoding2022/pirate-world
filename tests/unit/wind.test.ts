import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createWind, LULL_SPEED, OCEAN_CAP } from '../../src/wind';
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
