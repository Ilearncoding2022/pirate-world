import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createWeatherCells, cellProfile } from '../../src/weathercells';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createHeightMap } from '../../src/heightmap';
import { GLOBE_RADIUS, latLonToDir, headingToForward, tangentFrame } from '../../src/geo';
import type { EnergyState, ShipState } from '../../src/types';

/**
 * `weathercells.ts`'s invariants: the population it keeps, where it is
 * allowed to put a cell, that a cell stays on the sphere over a long life,
 * and that the same seed replays. Runs against the real terrain and a small
 * height map, exactly as `wind.test.ts` and `hazards.test.ts` do -- the coast
 * test only needs the shape of the coastline, not its resolution.
 */
const terrain = createTerrain(DEFAULT_SEED);
const heightMap = createHeightMap(terrain, 256, 128);

/** The bubble's outer edge and the retire margin, mirrored from the module. */
const CELL_BUBBLE = 250;
const CELL_RETIRE = 70;
const CELL_SPAWN_MIN = 90;
const CELL_TARGET = 3;

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

function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

describe('weather cells', () => {
  it('fills to CELL_TARGET and never past it, and never spawns inside the scope', () => {
    const cells = createWeatherCells(terrain, heightMap);
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.1;

    let reachedTarget = false;
    let minBirthDistance = Infinity;
    let seen = new Set<string>();

    for (let i = 0; i < 1200 / dt; i++) {
      const before = new Set(cells.state.live);
      cells.update(dt, ship, energy);
      expect(cells.state.live.length).toBeLessThanOrEqual(CELL_TARGET);
      if (cells.state.live.length === CELL_TARGET) reachedTarget = true;
      // Every cell that appeared this frame was born outside the scope plus
      // its own radius, which is what stops weather from materialising on top
      // of the ship.
      for (const cell of cells.state.live) {
        if (before.has(cell)) continue;
        minBirthDistance = Math.min(minBirthDistance, arcDistance(ship.position, cell.centre));
        seen.add(cell.kind);
      }
    }

    expect(reachedTarget).toBe(true);
    expect(minBirthDistance).toBeGreaterThanOrEqual(CELL_SPAWN_MIN - 1e-6);
    // Twenty minutes of rolls has to produce both kinds.
    expect(seen.has('storm')).toBe(true);
    expect(seen.has('fog')).toBe(true);
  });

  it('never BEARS a fog bank on or beside land', () => {
    const cells = createWeatherCells(terrain, heightMap);
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.1;

    // At BIRTH, which is the claim the module actually makes. A fog cell
    // drifts at 2 u/s for up to six minutes and may perfectly well reach a
    // coast later; that is weather, and the alternative -- a bank that
    // dissolves at a shoreline -- would be stranger to watch than the thing
    // it prevents.
    let born = 0;
    for (let i = 0; i < 2400 / dt; i++) {
      const before = new Set(cells.state.live);
      cells.update(dt, ship, energy);
      for (const cell of cells.state.live) {
        if (before.has(cell) || cell.kind !== 'fog') continue;
        born++;
        expect(heightMap.sample(cell.centre) > terrain.seaLevel).toBe(false);
      }
    }
    expect(born).toBeGreaterThan(0);
  });

  it('keeps a cell on the sphere and its travel tangent over a long life', () => {
    const cells = createWeatherCells(terrain, heightMap);
    const ship = stationaryShip();
    const energy = energyState('drain');
    const north = new Vector3();
    const east = new Vector3();
    tangentFrame(ship.position, north, east);
    // 100 units north of the ship, drifting east.
    const centre = ship.position.clone().applyAxisAngle(east.clone().negate(), 100 / GLOBE_RADIUS);
    cells.force('storm', centre.normalize(), east);

    const dt = 0.1;
    for (let i = 0; i < 600 / dt; i++) {
      cells.update(dt, ship, energy);
      if (cells.state.live.length === 0) break;
      const cell = cells.state.live[0];
      expect(cell.centre.length()).toBeCloseTo(1, 6);
      expect(cell.north.length()).toBeCloseTo(1, 6);
      // Still tangent: a travel vector with a radial component climbs off the
      // sphere over thousands of steps.
      expect(Math.abs(cell.north.dot(cell.centre))).toBeLessThan(1e-6);
    }
  });

  it('samples a forced cell at full strength at its centre and nothing past its edge', () => {
    const cells = createWeatherCells(terrain, heightMap);
    const ship = stationaryShip();
    const energy = energyState('drain');
    const north = new Vector3();
    const east = new Vector3();
    tangentFrame(ship.position, north, east);

    // Centred on the ship: the sample is the cell's own strength.
    cells.force('storm', ship.position.clone(), east, 30);
    cells.update(0.05, ship, energy);
    expect(cells.state.stormAtShip).toBeCloseTo(1, 3);
    expect(cells.state.fogAtShip).toBe(0);
    expect(cells.state.lightningAtShip).toBe(true);

    // And a fog bank well past its own radius reaches the ship not at all.
    const far = ship.position.clone().applyAxisAngle(east.clone().negate(), 200 / GLOBE_RADIUS);
    const other = createWeatherCells(terrain, heightMap);
    other.force('fog', far.normalize(), east, 30);
    other.update(0.05, ship, energy);
    expect(other.state.fogAtShip).toBe(0);
  });

  it('retires a cell that drifts out of the bubble', () => {
    const cells = createWeatherCells(terrain, heightMap);
    const ship = stationaryShip();
    const energy = energyState('drain');
    const north = new Vector3();
    const east = new Vector3();
    tangentFrame(ship.position, north, east);

    // Just inside the retire edge, and pointed at the door: the tangent at
    // the cell that leads directly away from the ship, not geographic north,
    // which at this range could be pointing anywhere.
    const angle = (CELL_BUBBLE + CELL_RETIRE - 5) / GLOBE_RADIUS;
    const centre = ship.position.clone().applyAxisAngle(east.clone().negate(), angle).normalize();
    const away = centre.clone().sub(ship.position);
    away.addScaledVector(centre, -away.dot(centre)).normalize();
    cells.force('storm', centre, away);
    expect(cells.state.live.length).toBe(1);

    const dt = 0.1;
    let retired = false;
    for (let i = 0; i < 120 / dt; i++) {
      cells.update(dt, ship, energy);
      if (cells.state.live.length === 0) {
        retired = true;
        break;
      }
    }
    expect(retired).toBe(true);
  });

  it('replays: the same seed and the same ship give the same population', () => {
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.1;

    function trace(): string[] {
      const cells = createWeatherCells(terrain, heightMap, 12345);
      const out: string[] = [];
      for (let i = 0; i < 900 / dt; i++) {
        cells.update(dt, ship, energy);
        if (i % 100 !== 0) continue;
        out.push(
          cells.state.live
            .map(
              (c) =>
                `${c.kind}:${c.radius.toFixed(3)}:${c.strength.toFixed(4)}:${c.centre.x.toFixed(6)}`,
            )
            .join('|'),
        );
      }
      return out;
    }

    expect(trace()).toEqual(trace());
  });

  it('profiles a cell flat in its core and zero past its edge', () => {
    // The one curve `weathermap.ts` also bakes and `radar.ts` draws a disc of.
    expect(cellProfile(1, 0, 30)).toBeCloseTo(1, 9);
    expect(cellProfile(1, 30 * 0.5, 30)).toBeCloseTo(1, 9);
    expect(cellProfile(1, 30, 30)).toBeCloseTo(0, 9);
    expect(cellProfile(1, 45, 30)).toBe(0);
    // And it scales with strength rather than reshaping.
    expect(cellProfile(0.4, 0, 30)).toBeCloseTo(0.4, 9);
    expect(cellProfile(0, 0, 30)).toBe(0);
  });
});
