import { describe, it, expect } from 'vitest';
import {
  bakeAmbientOcclusion,
  bakeHorizon,
  BAKE_DIRECTIONS,
  BAKE_RELIEF_SCALE,
} from '../../src/terrainbake';
import { GLOBE_RADIUS } from '../../src/geo';

/**
 * `terrainbake.ts`'s regression per docs/RENDER_PLAN.md's Stream C section:
 * a flat field bakes AO = 1 and horizon = 0 everywhere; a cone of known slope
 * bakes the analytically known horizon angle at a ring of points, to within
 * 1 degree; outputs are the requested size and in range.
 *
 * Both bakes are pure functions over a plain Float32Array, so this needs
 * neither the real 2048x1024 height map nor a renderer -- a small synthetic
 * grid is enough, and keeps the suite fast.
 */

// Small enough that a fully-unskipped bake (every texel forced through the
// real ray march, not the ocean shortcut) still runs in milliseconds --
// correctness here does not depend on resolution, only the cone test below
// does, and it uses its own larger grid.
const SMALL_W = 128;
const SMALL_H = 64;

const W = 512;
const H = 256;

describe('terrainbake', () => {
  it('flat field: AO is 1 everywhere, horizon is 0 everywhere', () => {
    const flat = new Float32Array(SMALL_W * SMALL_H).fill(0.4);
    // Far below anything the sea-skip margin would treat as ocean, so this
    // exercises the real ray march rather than the "open ocean" shortcut --
    // a flat field should bake the same open answer either way.
    const seaLevel = -5;

    const ao = bakeAmbientOcclusion(flat, SMALL_W, SMALL_H, seaLevel);
    expect(ao.length).toBe(SMALL_W * SMALL_H);
    for (let i = 0; i < ao.length; i++) {
      expect(ao[i]).toBeCloseTo(1, 6);
    }

    const [h0, h1] = bakeHorizon(flat, SMALL_W, SMALL_H, seaLevel);
    expect(h0.length).toBe(SMALL_W * SMALL_H * 4);
    expect(h1.length).toBe(SMALL_W * SMALL_H * 4);
    for (let i = 0; i < h0.length; i++) {
      expect(h0[i]).toBe(0);
      expect(h1[i]).toBe(0);
    }
  });

  it('outputs are the requested size and in range', () => {
    // A non-flat, non-trivial field so this is not accidentally testing the
    // same all-zero-ratio path as the flat-field case above.
    const data = new Float32Array(SMALL_W * SMALL_H);
    for (let y = 0; y < SMALL_H; y++) {
      for (let x = 0; x < SMALL_W; x++) {
        data[y * SMALL_W + x] = Math.sin(x * 0.11) * 0.3 + Math.cos(y * 0.07) * 0.3;
      }
    }
    const seaLevel = -5;

    const ao = bakeAmbientOcclusion(data, SMALL_W, SMALL_H, seaLevel);
    expect(ao.length).toBe(SMALL_W * SMALL_H);
    for (let i = 0; i < ao.length; i++) {
      expect(ao[i]).toBeGreaterThanOrEqual(0);
      expect(ao[i]).toBeLessThanOrEqual(1);
    }

    const [h0, h1] = bakeHorizon(data, SMALL_W, SMALL_H, seaLevel);
    for (const tex of [h0, h1]) {
      expect(tex.length).toBe(SMALL_W * SMALL_H * 4);
      for (let i = 0; i < tex.length; i++) {
        expect(tex[i]).toBeGreaterThanOrEqual(0);
        expect(tex[i]).toBeLessThanOrEqual(255);
      }
    }
  });

  it('ocean texels (well below sea level) skip straight to the open answer', () => {
    const data = new Float32Array(SMALL_W * SMALL_H).fill(-0.9);
    const seaLevel = 0.08; // terrain.ts's SEA_LEVEL

    const ao = bakeAmbientOcclusion(data, SMALL_W, SMALL_H, seaLevel);
    expect(ao.every((v) => v === 1)).toBe(true);

    const [h0, h1] = bakeHorizon(data, SMALL_W, SMALL_H, seaLevel);
    expect(h0.every((v) => v === 0)).toBe(true);
    expect(h1.every((v) => v === 0)).toBe(true);
  });

  it('cone of known slope bakes the analytic horizon angle at a ring of points, to within 1 degree', () => {
    // A perfectly conical "mountain" centred on the NORTH POLE: height is a
    // linear function of colatitude alone, independent of longitude. That
    // symmetry is what makes this analytically tractable -- "due north" from
    // any point on any ring is, by construction, exactly the direction back
    // toward the apex, and moving a world-unit distance `dist` due north
    // changes latitude by EXACTLY `dist / GLOBE_RADIUS` (a meridian is a
    // great circle; no equirect approximation enters along this one
    // direction). So the height change per step is exact, and the ratio the
    // bake maximises over -- (heightDiff * BAKE_RELIEF_SCALE) / dist -- comes
    // out to the same constant at every step:
    //
    //   ratio(k) = SLOPE * cos(azimuth_k) * BAKE_RELIEF_SCALE / GLOBE_RADIUS
    //
    // which this test computes independently and compares to the baked
    // value. The only source of disagreement is the bake resolving each
    // step to the nearest whole texel rather than the exact position, which
    // is what the 1 degree tolerance below is for.
    const SLOPE = 20; // height-field units per radian of colatitude -- a
    // deliberately steep synthetic cone, chosen so the resulting angles sit
    // comfortably inside 0-60 degrees rather than near either edge.
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      const lat = (v - 0.5) * Math.PI;
      const colatitude = Math.PI / 2 - lat;
      const height = 0.4 - SLOPE * colatitude;
      for (let x = 0; x < W; x++) data[y * W + x] = height;
    }
    const seaLevel = -100; // nothing here should be skipped as "ocean"

    const [h0, h1] = bakeHorizon(data, W, H, seaLevel);
    const HORIZON_MAX_DEGREES = 60;

    function decodedDegrees(tex: Uint8Array, idx: number, channel: number): number {
      return (tex[idx * 4 + channel] / 255) * HORIZON_MAX_DEGREES;
    }

    // A ring of colatitudes, avoiding the very top and bottom rows where a
    // single texel spans a disproportionate solid angle.
    const testRows = [Math.floor(H * 0.3), Math.floor(H * 0.5), Math.floor(H * 0.7)];
    const testCols = [0, Math.floor(W * 0.25), Math.floor(W * 0.5), Math.floor(W * 0.77)];

    for (const y of testRows) {
      for (const x of testCols) {
        const idx = y * W + x;
        for (let k = 0; k < BAKE_DIRECTIONS; k++) {
          const azimuth = (k * 2 * Math.PI) / BAKE_DIRECTIONS;
          const expectedRatio = Math.max(0, SLOPE * Math.cos(azimuth) * BAKE_RELIEF_SCALE / GLOBE_RADIUS);
          const expectedDeg = (Math.atan(expectedRatio) * 180) / Math.PI;

          const tex = k < 4 ? h0 : h1;
          const channel = k < 4 ? k : k - 4;
          const bakedDeg = decodedDegrees(tex, idx, channel);

          expect(bakedDeg).toBeGreaterThanOrEqual(expectedDeg - 1);
          expect(bakedDeg).toBeLessThanOrEqual(expectedDeg + 1);
        }
      }
    }
  });
});
