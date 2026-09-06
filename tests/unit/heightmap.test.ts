import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createHeightMap, HEIGHTMAP_GLSL } from '../../src/heightmap';
import { latLonToDir } from '../../src/geo';
import { createStubTerrain } from './support/stub-terrain';

/**
 * A tiny 4x2 map with a value ramp (`x + 10*y`), so every corner of a
 * bilinear cell is distinguishable and a hand-computed expectation is
 * unambiguous. Pixel centres follow the same convention `heightmap.ts`
 * documents: u = (x+0.5)/width, v = (y+0.5)/height, lon = (u-0.5)*2*PI,
 * lat = (v-0.5)*PI.
 */
function buildRampMap() {
  const width = 4;
  const height = 2;
  const terrain = createStubTerrain((dir: Vector3) => {
    const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const lon = Math.atan2(dir.x, dir.z);
    let u = lon / (Math.PI * 2) + 0.5;
    u -= Math.floor(u);
    const v = Math.min(0.999999, Math.max(0, lat / Math.PI + 0.5));
    const x = Math.round(u * width - 0.5);
    const y = Math.round(v * height - 0.5);
    return x + 10 * y;
  });
  return createHeightMap(terrain, width, height);
}

describe('heightmap', () => {
  it('bilinear-samples the interior of a cell', () => {
    const map = buildRampMap();
    // lat=0, lon=0 -> u=0.5, v=0.5: dead centre of the four texels
    // (x=1,y=0)=1, (x=2,y=0)=2, (x=1,y=1)=11, (x=2,y=1)=12 -> average 6.5.
    const value = map.sample(new Vector3(0, 0, 1));
    expect(value).toBeCloseTo(6.5, 9);
  });

  it('wraps in u across the antimeridian', () => {
    const map = buildRampMap();
    // lat=-45, lon=-162 -> u=0.05, v=0.25: interpolates between the x=3
    // column (wrapped from x=-1) and the x=0 column, both at y=0.
    // Hand-computed: h00=3 (x=3,y=0), h10=0 (x=0,y=0), tx=0.7 -> 3 + (0-3)*0.7 = 0.9.
    const dir = latLonToDir(-45, -162);
    const value = map.sample(dir);
    expect(value).toBeCloseTo(0.9, 9);
  });

  it('clamps in v at the pole rather than wrapping', () => {
    const map = buildRampMap();
    // The north pole: v clamps to 0.999999, landing entirely in the y=1 row
    // on both sides of the interpolation, so the value is a pure function of
    // that row regardless of longitude. lon(0,1,0) = atan2(0,0) = 0 -> u=0.5,
    // between x=1 (11) and x=2 (12) at tx=0.5 -> 11.5.
    const value = map.sample(new Vector3(0, 1, 0));
    expect(value).toBeCloseTo(11.5, 9);
  });

  it('sample() (TS) uses the same mapping as dirToEquirect (GLSL)', () => {
    // Pulls the two literal constants straight out of the shipped GLSL string
    // rather than hand-copying them, so this fails if `dirToEquirect` is ever
    // edited to a mapping `sample` does not also use (or vice versa).
    const match = HEIGHTMAP_GLSL.match(
      /lon \/ ([0-9.]+) \+ 0\.5, lat \/ ([0-9.]+) \+ 0\.5/,
    );
    if (!match) throw new Error('HEIGHTMAP_GLSL no longer matches the expected dirToEquirect shape');
    const glslTwoPi = Number(match[1]);
    const glslPi = Number(match[2]);

    const width = 8;
    const height = 4;
    const terrain = createStubTerrain(() => 0);
    // Height doesn't matter here; the data array below is written directly.
    const map = createHeightMap(terrain, width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) map.setAt(y * width + x, x + 100 * y);
    }
    map.flush();

    const dir = latLonToDir(17, -63); // arbitrary, off every axis
    const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const lon = Math.atan2(dir.x, dir.z);
    let u = lon / glslTwoPi + 0.5;
    u -= Math.floor(u);
    const v = Math.min(0.999999, Math.max(0, lat / glslPi + 0.5));

    // Replicate sample()'s own bilinear step from (u, v) so this checks
    // agreement on the (lat,lon) -> (u,v) mapping specifically, not on the
    // interpolation the two share by construction.
    const fx = u * width - 0.5;
    const fy = v * height - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.min(height - 1, Math.max(0, Math.floor(fy)));
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const xa = ((x0 % width) + width) % width;
    const xb = (xa + 1) % width;
    const h00 = xa + 100 * y0;
    const h10 = xb + 100 * y0;
    const h01 = xa + 100 * y1;
    const h11 = xb + 100 * y1;
    const top = h00 + (h10 - h00) * tx;
    const bot = h01 + (h11 - h01) * tx;
    const expected = top + (bot - top) * ty;

    expect(map.sample(dir)).toBeCloseTo(expected, 6);
  });
});
