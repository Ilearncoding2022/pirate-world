import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { HeightMap } from './heightmap';

/**
 * Texels the inland flag is pushed outward into the surrounding land.
 *
 * The mask is bilinearly filtered, so a lake whose flag stopped dead at its
 * own waterline would fade back toward "ocean" across the shoreline and ring
 * every pond in sea colour. Bleeding the flag a few texels up the bank keeps
 * the whole body on the inland side of the filter. The bleed may only enter
 * land, never reachable water, so an ocean coast a few texels away from a lake
 * is left alone.
 */
const SHORE_BLEED = 3;

export interface WaterBodies {
  /**
   * Equirectangular R8 mask, in exactly the projection `heightmap.ts`
   * documents, so a shader can reuse `dirToEquirect` for both lookups.
   *
   *   1 = water the ship can never reach: lakes, ponds, enclosed seas
   *       (plus the few texels of bank immediately around them)
   *   0 = the open ocean, and all other land
   *
   * u wraps, v clamps, linearly filtered so the boundary is a soft blend
   * rather than a stair-stepped edge.
   */
  texture: DataTexture;
  /**
   * Nearest-texel read of the mask at a unit direction, matching what the
   * shader samples. 1 = enclosed inland water, 0 = ocean or open land.
   * `radar.ts` uses it to colour lakes on the scope.
   */
  sample(dir: Vector3): number;
  /** Share of the world's water that turned out to be enclosed, in [0, 1]. */
  inlandFraction: number;
  /** Number of distinct enclosed bodies found. Diagnostics only. */
  bodyCount: number;
}

/**
 * Splits the world's water into "ocean" and "inland".
 *
 * The ship moves over the sphere and refuses to enter land (`ship.ts`), so the
 * water it can ever touch is exactly the connected component of the sea that
 * contains its spawn point. Everything else — crater lakes, mountain tarns,
 * landlocked seas — is unreachable by definition, which is what lets
 * `water.ts` shade it as still fresh water instead of open ocean.
 *
 * The connectivity is computed once, at startup, as a flood fill over the
 * shared height map grid. That grid is the same field the water shader reads
 * for depth, so the mask and the shading can never disagree about where the
 * shoreline is.
 */
export function createWaterBodies(
  heightMap: HeightMap,
  seaLevel: number,
  spawnDir: Vector3,
): WaterBodies {
  const { data, width, height } = heightMap;
  const cells = width * height;

  const isWater = new Uint8Array(cells);
  let waterCells = 0;
  for (let i = 0; i < cells; i++) {
    if (data[i] <= seaLevel) {
      isWater[i] = 1;
      waterCells++;
    }
  }

  const reached = new Uint8Array(cells);
  // Worst case every water cell is queued exactly once.
  const queue = new Int32Array(cells);
  let head = 0;
  let tail = 0;

  function enqueue(index: number): void {
    if (isWater[index] === 0 || reached[index] === 1) return;
    reached[index] = 1;
    queue[tail++] = index;
  }

  enqueue(seedIndex(spawnDir, data, width, height, isWater));

  // The top and bottom rows are rings a fraction of a degree across, so every
  // cell in one is physically the same place as every other. Linking each row
  // in one shot the first time it is touched keeps a polar sea from being
  // split in two by a meridian of land that does not actually reach the pole.
  let southLinked = false;
  let northLinked = false;

  while (head < tail) {
    const i = queue[head++];
    const y = (i / width) | 0;
    const rowStart = i - (i % width);
    const x = i - rowStart;

    enqueue(rowStart + (x + 1) % width);
    enqueue(rowStart + (x + width - 1) % width);
    if (y > 0) enqueue(i - width);
    if (y < height - 1) enqueue(i + width);

    if (y === 0 && !southLinked) {
      southLinked = true;
      for (let k = 0; k < width; k++) enqueue(k);
    } else if (y === height - 1 && !northLinked) {
      northLinked = true;
      const base = (height - 1) * width;
      for (let k = 0; k < width; k++) enqueue(base + k);
    }
  }

  // ---- Enclosed water, plus a short bleed up its banks --------------------
  const mask = new Uint8Array(cells);
  let inlandCells = 0;
  head = 0;
  tail = 0;
  for (let i = 0; i < cells; i++) {
    if (isWater[i] === 1 && reached[i] === 0) {
      mask[i] = 255;
      inlandCells++;
      queue[tail++] = i;
    }
  }
  const bodyCount = countBodies(mask, isWater, width, height);

  function bleed(index: number): void {
    // Land only: spreading into reachable sea would tint the open ocean.
    if (isWater[index] === 1 || mask[index] !== 0) return;
    mask[index] = 255;
    queue[tail++] = index;
  }

  // Breadth-first, so a cell is first reached at its true texel distance and
  // one sweep per ring of the frontier is enough.
  let frontierEnd = tail;
  for (let step = 0; step < SHORE_BLEED; step++) {
    while (head < frontierEnd) {
      const i = queue[head++];
      const y = (i / width) | 0;
      const rowStart = i - (i % width);
      const x = i - rowStart;
      bleed(rowStart + (x + 1) % width);
      bleed(rowStart + (x + width - 1) % width);
      if (y > 0) bleed(i - width);
      if (y < height - 1) bleed(i + width);
    }
    frontierEnd = tail;
  }

  const texture = new DataTexture(mask, width, height, RedFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = 'inland-water-mask';

  return {
    texture,
    sample(dir: Vector3): number {
      return mask[texelIndex(dir, width, height)] > 127 ? 1 : 0;
    },
    inlandFraction: waterCells > 0 ? inlandCells / waterCells : 0,
    bodyCount,
  };
}

/**
 * Grid index of the texel containing a unit direction, in the projection
 * `heightmap.ts` documents: u wraps, v clamps.
 */
function texelIndex(dir: Vector3, width: number, height: number): number {
  const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  const lon = Math.atan2(dir.x, dir.z);
  let u = lon / (Math.PI * 2) + 0.5;
  u -= Math.floor(u);
  const v = Math.min(0.999999, Math.max(0, lat / Math.PI + 0.5));
  const x = Math.min(width - 1, Math.floor(u * width));
  const y = Math.min(height - 1, Math.floor(v * height));
  return y * width + x;
}

/**
 * Grid index of the flood fill seed.
 *
 * `terrain.ts` clears a disc of open water around the spawn, so the spawn cell
 * is water by construction. The fallback only matters if that guarantee is
 * ever tuned away: the deepest cell on the planet is open ocean under any
 * plausible height field.
 */
function seedIndex(
  dir: Vector3,
  data: Float32Array,
  width: number,
  height: number,
  isWater: Uint8Array,
): number {
  const index = texelIndex(dir, width, height);
  if (isWater[index] === 1) return index;

  let deepest = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i] < data[deepest]) deepest = i;
  }
  return deepest;
}

/** Counts connected components of the enclosed-water set. Reporting only. */
function countBodies(
  mask: Uint8Array,
  isWater: Uint8Array,
  width: number,
  height: number,
): number {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  let bodies = 0;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    bodies++;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const y = (i / width) | 0;
      const rowStart = i - (i % width);
      const x = i - rowStart;
      const push = (j: number): void => {
        if (mask[j] === 0 || isWater[j] === 0 || seen[j] === 1) return;
        seen[j] = 1;
        stack.push(j);
      };
      push(rowStart + (x + 1) % width);
      push(rowStart + (x + width - 1) % width);
      if (y > 0) push(i - width);
      if (y < height - 1) push(i + width);
    }
  }
  return bodies;
}
