/**
 * Pure functions that compute the two golden fixtures T owns
 * (`terrain-golden.json`, `world-golden.json`) from the source as it stands.
 *
 * These are imported both by the tests that check the fixtures still match
 * (`tests/unit/terrain-golden.test.ts`, `tests/unit/world-golden.test.ts`)
 * and by the writer (`tests/fixtures/generate.test.ts`, run through
 * `tests/fixtures/vitest.config.ts` via `npm run golden:update`) that
 * (re)writes the JSON. Sharing the computation is the point: a golden and its
 * checker can never drift onto two different definitions of "the value".
 *
 * See docs/RENDER_PLAN.md, Phase 0 / T, and the note there: "Any later stream
 * that legitimately changes a golden updates the fixture in the same commit
 * and says so in its report. A golden that changes without such a note is a
 * regression."
 */
import { Vector3 } from 'three';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createHeightMap } from '../../src/heightmap';
import { cullIslets } from '../../src/islets';
import { createWaterBodies } from '../../src/waterbodies';
import { createTowns } from '../../src/towns';
import { latLonToDir } from '../../src/geo';

/**
 * 64 points spread evenly over the sphere by the Fibonacci-lattice
 * construction. Deterministic and independent of any PRNG in the codebase
 * under test, so this file draws no randomness of its own.
 */
export function fibonacciSphereDirections(n: number): Vector3[] {
  const dirs: Vector3[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;
    dirs.push(new Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius));
  }
  return dirs;
}

export interface TerrainGolden {
  seed: number;
  dirs: [number, number, number][];
  heights: number[];
}

/**
 * `terrain.heightAt` at 64 fixed directions. Pins the coastline: no stream
 * may move it (docs/RENDER_PLAN.md).
 */
export function buildTerrainGolden(): TerrainGolden {
  const terrain = createTerrain(DEFAULT_SEED);
  const dirs = fibonacciSphereDirections(64);
  const heights = dirs.map((d) => terrain.heightAt(d));
  return {
    seed: DEFAULT_SEED,
    dirs: dirs.map((d) => [d.x, d.y, d.z]),
    heights,
  };
}

export interface WorldGolden {
  seed: number;
  heightMapWidth: number;
  heightMapHeight: number;
  /** Fraction of height-map texels above sea level, after cullIslets. */
  landFraction: number;
  /** waterBodies.inlandFraction: share of the world's water that is enclosed. */
  lakeFraction: number;
  townCount: number;
  dockCount: number;
  allDocksNonNull: boolean;
  waterBodyCount: number;
  islandsBefore: number;
  islandsRemoved: number;
}

/**
 * Built at the real 2048x1024 (createHeightMap's default), so this is the
 * slow one (~2s) -- see docs/RENDER_PLAN.md's note to mark it as such.
 */
export function buildWorldGolden(): WorldGolden {
  const terrain = createTerrain(DEFAULT_SEED);
  const heightMap = createHeightMap(terrain);
  const cull = cullIslets(heightMap, terrain.seaLevel);
  terrain.useLandMask(heightMap.sample);

  const waterBodies = createWaterBodies(
    heightMap,
    terrain.seaLevel,
    latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG),
  );
  const towns = createTowns(heightMap, waterBodies, terrain.seaLevel);

  let landCells = 0;
  for (let i = 0; i < heightMap.data.length; i++) {
    if (heightMap.data[i] > terrain.seaLevel) landCells++;
  }

  return {
    seed: DEFAULT_SEED,
    heightMapWidth: heightMap.width,
    heightMapHeight: heightMap.height,
    landFraction: landCells / heightMap.data.length,
    lakeFraction: waterBodies.inlandFraction,
    townCount: towns.all.length,
    dockCount: towns.docks.length,
    allDocksNonNull: towns.all.every((t) => t.dock !== null),
    waterBodyCount: waterBodies.bodyCount,
    islandsBefore: cull.islandsBefore,
    islandsRemoved: cull.islandsRemoved,
  };
}
