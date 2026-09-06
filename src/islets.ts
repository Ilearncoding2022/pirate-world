import type { HeightMap } from './heightmap';
import { GLOBE_RADIUS } from './geo';
import { CULL_MARGIN } from './land';

/**
 * Smallest landmass the world is allowed to keep, in world units squared.
 *
 * 24.6 u^2 is a disc 5.6 units across. The hull is 3.12 units long and 1.5
 * across (`ship.ts` MODEL_SCALE against `wake.ts`'s bow/stern offsets), so the
 * smallest surviving island is a little under two ship lengths -- big enough
 * that a player reads it as land and steers around it on purpose.
 *
 * Below this the sea was full of specks a fraction of the hull wide. They were
 * too small to see against the water and too small to be worth avoiding, but
 * `ship.ts` still refuses to sail through them, so they read as the boat
 * catching on nothing at all. Sinking them is the fix: 215 of the world's 321
 * landmasses go, and they take about 0.6% of its land area with them.
 */
export const MIN_ISLAND_AREA = 24.6;

/**
 * How far below sea level a culled islet is pushed, on the height scale.
 *
 * Two consumers set this floor and it has to clear both. `land.ts` keeps any
 * face with a vertex above `seaLevel - CULL_MARGIN`, so anything shallower
 * would leave the mesh drawing the island it is meant to have removed. The
 * water shader ramps its shallow band over the first 0.11 of depth, so landing
 * just past that puts the sunk patch on ordinary shelf colour instead of
 * ringing every former islet in a bright shoal.
 *
 * CULL_MARGIN is 0.10 and the shallow band is 0.11, so 0.12 is the first depth
 * that satisfies both with a little room to spare.
 */
const SINK_DEPTH = Math.max(CULL_MARGIN, 0.11) + 0.01;

/** What a cull did. Diagnostics only -- nothing reads this to make a decision. */
export interface IsletCull {
  /** Landmasses found before the cull. */
  islandsBefore: number;
  /** Landmasses sunk for being under MIN_ISLAND_AREA. */
  islandsRemoved: number;
  /** Share of the world's land area that went with them, in [0, 1]. */
  areaRemoved: number;
  /** Area of the smallest surviving landmass, in world units squared. */
  smallestKept: number;
}

/**
 * Sinks every landmass smaller than MIN_ISLAND_AREA beneath the sea.
 *
 * Run once at startup, on the shared height map, BEFORE anything reads it --
 * `waterbodies.ts` in particular, so its flood fill sees the sunk islets as
 * plain ocean and never strands a lagoon inside one that no longer exists.
 *
 * Editing the raster rather than the noise field is deliberate. The islets are
 * a connectivity property: no closed form over `terrain.heightAt` can say
 * whether a given point belongs to a speck or to a continent, because that
 * depends on what its neighbours do. A flood fill over the grid answers it
 * exactly once, and every consumer that reads the map afterwards -- the land
 * mesh, the water shader, the berth search, the scope -- inherits the answer
 * for free.
 *
 * The one consumer that does NOT read the map is ship collision, which asks
 * `terrain.isLand`. `globe.ts` closes that gap by handing the culled map back
 * to the terrain as its land mask; without that the hull would still snag on
 * islets nothing draws any more, which is the original bug wearing a hat.
 */
export function cullIslets(heightMap: HeightMap, seaLevel: number): IsletCull {
  const { data, width, height } = heightMap;
  const cells = width * height;
  const sunkTo = seaLevel - SINK_DEPTH;

  // Area of one texel in each row. Equirectangular rows shrink with cos(lat),
  // so a polar speck covers far less ground than an equatorial one of the same
  // pixel count, and counting pixels would cull the tropics too gently.
  const rowArea = new Float64Array(height);
  const dLon = (2 * Math.PI) / width;
  const dLat = Math.PI / height;
  for (let y = 0; y < height; y++) {
    const lat = ((y + 0.5) / height - 0.5) * Math.PI;
    rowArea[y] = GLOBE_RADIUS * GLOBE_RADIUS * Math.cos(lat) * dLon * dLat;
  }

  const land = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) if (data[i] > seaLevel) land[i] = 1;

  // Iterative 4-connected flood fill. u wraps at the antimeridian, v stops at
  // the poles -- the same topology heightmap.ts documents for its own lookup,
  // so a landmass straddling the seam is one island and not two.
  const seen = new Uint8Array(cells);
  const stack = new Int32Array(cells);
  const member = new Int32Array(cells);

  let islandsBefore = 0;
  let islandsRemoved = 0;
  let totalArea = 0;
  let removedArea = 0;
  let smallestKept = Infinity;

  for (let start = 0; start < cells; start++) {
    if (!land[start] || seen[start]) continue;

    let sp = 0;
    let count = 0;
    let area = 0;
    stack[sp++] = start;
    seen[start] = 1;

    while (sp > 0) {
      const i = stack[--sp];
      const y = (i / width) | 0;
      const x = i - y * width;
      member[count++] = i;
      area += rowArea[y];

      const east = y * width + ((x + 1) % width);
      const west = y * width + ((x - 1 + width) % width);
      if (land[east] && !seen[east]) { seen[east] = 1; stack[sp++] = east; }
      if (land[west] && !seen[west]) { seen[west] = 1; stack[sp++] = west; }
      if (y > 0) {
        const n = i - width;
        if (land[n] && !seen[n]) { seen[n] = 1; stack[sp++] = n; }
      }
      if (y < height - 1) {
        const s = i + width;
        if (land[s] && !seen[s]) { seen[s] = 1; stack[sp++] = s; }
      }
    }

    islandsBefore++;
    totalArea += area;

    if (area < MIN_ISLAND_AREA) {
      islandsRemoved++;
      removedArea += area;
      for (let k = 0; k < count; k++) heightMap.setAt(member[k], sunkTo);
    } else if (area < smallestKept) {
      smallestKept = area;
    }
  }

  heightMap.flush();

  return {
    islandsBefore,
    islandsRemoved,
    areaRemoved: totalArea > 0 ? removedArea / totalArea : 0,
    smallestKept: smallestKept === Infinity ? 0 : smallestKept,
  };
}
