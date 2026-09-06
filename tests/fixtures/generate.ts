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
import { createLand, landRadius } from '../../src/land';

/**
 * Eight fixed terrain heights `landRadius` is sampled at for the golden
 * below (Stream C, docs/RENDER_PLAN.md): deep water past the shore-dip's own
 * clamp, a shallower depth and two points inside the unsaturated dip ramp
 * (`landRadius`'s `below` term saturates at `seaLevel - 0.08`), exactly
 * `terrain.seaLevel`, the beach band, mid relief, and a height past the
 * eased ramp's `a * a` ceiling. Fixed numbers rather than offsets from
 * `seaLevel` so the golden is a pure function of `landRadius` and the (also
 * pinned) `SEA_LEVEL` constant.
 */
const LAND_RADIUS_TEST_HEIGHTS = [-1, -0.3, 0.02, 0.06, 0.08, 0.15, 0.4, 1.0];

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
  /**
   * Land mesh vertex count after `createLand`'s coastal face filter --
   * Stream C (docs/RENDER_PLAN.md) added this and the field below. Pins the
   * land mesh's own extent alongside the height-field fractions above:
   * the bake reads the height field but must never write to it, so this
   * moving would mean the terrain itself moved, not just its shading.
   */
  landMeshVertexCount: number;
  /** `landRadius` at LAND_RADIUS_TEST_HEIGHTS, fixed points spanning deep
   * water to a height past the relief ramp's ceiling. */
  landRadiusAtHeights: number[];
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

  // Stream C (docs/RENDER_PLAN.md): the land mesh itself, built the same way
  // globe.ts does -- after the cull and the land-mask install above, so the
  // startup bake this also runs sees the same culled map it would in the
  // real game. The bake reads the height field and never writes it, so
  // nothing here should move the fractions computed above.
  const land = createLand(terrain, heightMap);
  const landMeshVertexCount = (land.mesh.geometry.attributes.position as { count: number }).count;
  const landRadiusAtHeights = LAND_RADIUS_TEST_HEIGHTS.map((h) => landRadius(h, terrain.seaLevel));

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
    landMeshVertexCount,
    landRadiusAtHeights,
  };
}
