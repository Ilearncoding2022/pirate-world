import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createTerrain } from '../../src/terrain';
import { buildTerrainGolden, fibonacciSphereDirections } from '../fixtures/generate';
import golden from '../fixtures/terrain-golden.json';

/**
 * Pins `terrain.heightAt` at 64 fixed directions to the value captured on
 * `main` before any rendering stream touches the world. See
 * docs/RENDER_PLAN.md: "This pins the coastline: no stream may move it."
 *
 * If a change legitimately moves these values, regenerate with
 * `npm run golden:update` and say so in the report -- an unexplained diff
 * here is exactly the regression this test exists to catch.
 */
describe('terrain-golden', () => {
  it('matches the captured heights to 1e-9', () => {
    const live = buildTerrainGolden();
    expect(live.seed).toBe(golden.seed);
    expect(live.heights.length).toBe(golden.heights.length);
    for (let i = 0; i < golden.heights.length; i++) {
      expect(live.heights[i]).toBeCloseTo(golden.heights[i], 9);
    }
  });

  it('is reproducible directly against createTerrain, independent of the generator helper', () => {
    const terrain = createTerrain(golden.seed);
    const dirs = fibonacciSphereDirections(64).map((d) => new Vector3(d.x, d.y, d.z));
    expect(dirs.length).toBe(golden.heights.length);
    for (let i = 0; i < dirs.length; i++) {
      expect(terrain.heightAt(dirs[i])).toBeCloseTo(golden.heights[i], 9);
    }
  });
});
