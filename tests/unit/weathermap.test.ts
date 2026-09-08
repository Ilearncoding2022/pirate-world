import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { bakeWeatherMap, MAP_HEIGHT, MAP_WIDTH } from '../../src/weathermap';
import { cellProfile } from '../../src/weathercells';
import { GLOBE_RADIUS, latLonToDir, capColumns } from '../../src/geo';
import type { CellsState, WeatherCell } from '../../src/types';

/**
 * The bake, on a plain `Uint8Array` and with no GPU. What matters here is
 * parity between what the sky reads and what `cellProfile` says -- the sky and
 * the scope drawing a cell in two different places is the one failure this
 * texture can produce that nothing else would catch.
 */
const STRIDE = 4;

function cell(partial: Partial<WeatherCell> & { centre: Vector3 }): WeatherCell {
  return {
    kind: 'storm',
    north: new Vector3(0, 1, 0),
    radius: 40,
    strength: 1,
    lightning: false,
    age: 60,
    life: 300,
    ...partial,
  } as WeatherCell;
}

function state(live: WeatherCell[]): CellsState {
  return { live, stormAtShip: 0, fogAtShip: 0, lightningAtShip: false };
}

/** Read one texel by direction, the way the shader's `dirToEquirect` would. */
function texelAt(data: Uint8Array, dir: Vector3): [number, number, number] {
  const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  const lon = Math.atan2(dir.x, dir.z);
  const u = lon / (2 * Math.PI) + 0.5;
  const v = lat / Math.PI + 0.5;
  const x = Math.min(MAP_WIDTH - 1, Math.max(0, Math.floor(u * MAP_WIDTH)));
  const y = Math.min(MAP_HEIGHT - 1, Math.max(0, Math.floor(v * MAP_HEIGHT)));
  const o = (y * MAP_WIDTH + x) * STRIDE;
  return [data[o], data[o + 1], data[o + 2]];
}

function fresh(): Uint8Array {
  return new Uint8Array(MAP_WIDTH * MAP_HEIGHT * STRIDE);
}

describe('weather map', () => {
  it('is entirely zero with no cells, which is the whole zero contract', () => {
    const data = fresh();
    data.fill(200);
    bakeWeatherMap(state([]), data, MAP_WIDTH, MAP_HEIGHT);
    expect(data.every((b) => b === 0)).toBe(true);
  });

  it('peaks at a cell centre and is nothing past its edge', () => {
    const data = fresh();
    const centre = latLonToDir(10, 40);
    bakeWeatherMap(state([cell({ centre, radius: 40 })]), data, MAP_WIDTH, MAP_HEIGHT);

    expect(texelAt(data, centre)[0]).toBe(255);

    // Half a radius out: inside the flat core, still full.
    const near = latLonToDir(10 + (20 / GLOBE_RADIUS) * (180 / Math.PI), 40);
    expect(texelAt(data, near)[0]).toBe(255);

    // Just past the edge: nothing at all.
    const past = latLonToDir(10 + (46 / GLOBE_RADIUS) * (180 / Math.PI), 40);
    expect(texelAt(data, past)[0]).toBe(0);
  });

  it('agrees with cellProfile to within a texel of quantisation', () => {
    const data = fresh();
    const centre = latLonToDir(0, 0);
    const radius = 50;
    bakeWeatherMap(state([cell({ centre, radius, strength: 0.8 })]), data, MAP_WIDTH, MAP_HEIGHT);

    // Walk out along the equator and compare the texture against the analytic
    // profile every consumer that decides a number uses.
    for (let d = 0; d <= 60; d += 5) {
      const dir = latLonToDir(0, (d / GLOBE_RADIUS) * (180 / Math.PI));
      const expected = cellProfile(0.8, d, radius);
      const got = texelAt(data, dir)[0] / 255;
      // One texel is 2.45 units and the profile's steepest slope is about
      // 1.5/radius per unit, so a texel of position error is worth about 0.08.
      expect(Math.abs(got - expected)).toBeLessThan(0.1);
    }
  });

  it('separates storm from fog, and carries the lightning flag on the strongest storm', () => {
    const data = fresh();
    const centre = latLonToDir(-20, 120);
    bakeWeatherMap(
      state([cell({ centre, kind: 'fog', radius: 40 })]),
      data,
      MAP_WIDTH,
      MAP_HEIGHT,
    );
    const [storm, fog, lightning] = texelAt(data, centre);
    expect(fog).toBe(255);
    expect(storm).toBe(0);
    expect(lightning).toBe(0);

    // A lit storm on the same spot lights it; the fog channel is untouched.
    const both = fresh();
    bakeWeatherMap(
      state([
        cell({ centre, kind: 'fog', radius: 40 }),
        cell({ centre, kind: 'storm', radius: 40, lightning: true }),
      ]),
      both,
      MAP_WIDTH,
      MAP_HEIGHT,
    );
    const t = texelAt(both, centre);
    expect(t[0]).toBe(255);
    expect(t[1]).toBe(255);
    expect(t[2]).toBe(255);
  });

  it('takes the max of two overlapping cells rather than their sum', () => {
    const data = fresh();
    const centre = latLonToDir(0, 0);
    bakeWeatherMap(
      state([
        cell({ centre, radius: 40, strength: 0.5 }),
        cell({ centre, radius: 40, strength: 0.5 }),
      ]),
      data,
      MAP_WIDTH,
      MAP_HEIGHT,
    );
    // Half plus half is half, not one. Sums are how a pair of thin banks
    // becomes darker than either at full strength.
    expect(texelAt(data, centre)[0]).toBeLessThan(140);
    expect(texelAt(data, centre)[0]).toBeGreaterThan(115);
  });

  it('wraps across the antimeridian instead of clipping at the row end', () => {
    const data = fresh();
    // Dead on the seam: lon 180 is u = 0 and u = 1 at once.
    const centre = latLonToDir(0, 180);
    bakeWeatherMap(state([cell({ centre, radius: 40 })]), data, MAP_WIDTH, MAP_HEIGHT);

    const deg = (25 / GLOBE_RADIUS) * (180 / Math.PI);
    // Twenty-five units either side of the seam, which is one step over it.
    expect(texelAt(data, latLonToDir(0, 180 - deg))[0]).toBeGreaterThan(0);
    expect(texelAt(data, latLonToDir(0, -180 + deg))[0]).toBeGreaterThan(0);
  });

  it('covers every column of a row when the cap swallows a pole', () => {
    const data = fresh();
    // A cell centred within its own radius of the north pole covers the pole,
    // so the rows above it are complete and there is no band to wrap.
    const centre = latLonToDir(89, 0);
    bakeWeatherMap(state([cell({ centre, radius: 60 })]), data, MAP_WIDTH, MAP_HEIGHT);

    const topRow = MAP_HEIGHT - 1;
    let covered = 0;
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (data[(topRow * MAP_WIDTH + x) * STRIDE] > 0) covered++;
    }
    expect(covered).toBe(MAP_WIDTH);
  });

  it('capColumns: a full row at a pole, a half-width elsewhere, nothing outside', () => {
    // The row through the centre: the half-width is the angular radius itself.
    expect(capColumns(0, 0, 0.2)).toBeCloseTo(0.2, 6);
    // A row the cap does not reach.
    expect(capColumns(0.6, 0, 0.2)).toBe(-1);
    // A cap over the pole: every row above it is complete.
    expect(capColumns(1.5, Math.PI / 2, 0.3)).toBe(Math.PI);
    // A degenerate radius asks for nothing.
    expect(capColumns(0, 0, 0)).toBe(-1);
  });
});
