import type { HeightMap } from './heightmap';
import { GLOBE_RADIUS } from './geo';
import { CULL_MARGIN } from './land';
import { BAND_GUARANTEE_RAD, BAND_WANDER_RAD } from './terrain';

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

/* ---- The equatorial strip's own cull ------------------------------ */

/**
 * How far from the equator a landmass has to stay entirely inside to be
 * judged as one of the strip's islets, radians.
 *
 * The outer edge of the veto's wander (`terrain.ts`), so this is "inside the
 * widest the strip ever gets". Beyond it the veto was already fading and the
 * land there is ordinary coast, which this rule must not touch.
 */
const BAND_ISLET_REACH = BAND_GUARANTEE_RAD + BAND_WANDER_RAD;

/**
 * The largest a landmass inside the strip is allowed to be, world units
 * squared, and the most latitude it is allowed to span, radians.
 *
 * `terrain.ts` guarantees no CONTINENT reaches the strip -- see
 * BAND_GUARANTEE_RAD for that arithmetic -- and the owner's rule allows small
 * islands inside it. These two are what make "small" a number rather than a
 * hope, and they are the mirror of MIN_ISLAND_AREA above: that one sinks what
 * is too small to be worth steering round, this one sinks what is too big to
 * be steered round at all.
 *
 * The two caps answer different questions, which is why only one of them moved
 * when the strip narrowed from fifty units to forty.
 *
 * AREA asks "is this a landmark or a landmass", and that is a judgement against
 * the SHIP, not against the corridor: 150 u^2 is a disc 13.8 units across, four
 * hull lengths, six times the smallest island the world keeps. A boat does not
 * care how wide the strip is when it decides whether the thing off the bow is
 * an island or a coast. So this one is absolute and stays.
 *
 * SPAN asks "can this bridge the strip", which is a question about the corridor
 * and therefore scales with it. It is not redundant with the area: area alone
 * does not bound a ribbon, and a 150 u^2 ribbon three units wide would be fifty
 * long -- across the whole strip while measuring well inside the area cap. Ten
 * units of latitude inside a forty-unit minimum leaves thirty units of clear
 * water whatever else happens, which is a maelstrom (20 across, see
 * `terrain.ts`'s BAND_GUARANTEE_RAD) with five units either side of it. It was
 * 0.06 rad against the old fifty-unit strip, the same quarter of the corridor.
 *
 * Both fire on the tail and never on the body, which is the shape a catch
 * should have -- the same shape `worldgen.ts`'s land-fraction band has. See
 * `npm run world:measure` for the surveyed largest.
 */
const MAX_BAND_ISLET_AREA = 150;
const MAX_BAND_ISLET_SPAN = 0.05;

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
  /** Landmasses sunk for being too big or too long inside the equatorial strip. */
  bandIsletsSunk: number;
  /**
   * Islands the strip kept: entirely inside it, and inside both caps.
   *
   * The feature, counted. The owner's rule is that small islands ARE allowed in
   * the strip, so a world where this is always zero would mean the veto had
   * been tuned into a rule that says "no land" -- which is a different feature
   * that happens to pass the same tests.
   */
  bandIsletsKept: number;
  /** Area of the largest island the strip kept, world units squared. 0 if none. */
  largestBandIslet: number;
  /**
   * Landmasses with a foot inside the guaranteed strip that also reach past
   * BAND_ISLET_REACH -- a coast that grew a causeway into water the generator
   * promised would be clear.
   *
   * NOT sunk, deliberately: such a thing is a continent, and deleting a
   * continent is far worse than the fault it would be hiding. It is counted so
   * `worldgen.ts` can throw the whole world away instead, which is the only
   * honest answer. Zero in every world measured; if it is ever not, the veto in
   * `terrain.ts` has been retuned past what it can promise.
   */
  bandBridges: number;
  /**
   * Closest approach to the equator of any surviving landmass that is NOT one
   * of the strip's islets, radians of latitude. `Infinity` if there is none.
   *
   * The promise this whole feature exists to keep, as one number: it must never
   * be under BAND_GUARANTEE_RAD.
   */
  mainlandMinAbsLat: number;
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
  // Distance from the equator, per row, for the band rules below. Precomputed
  // beside the area for the same reason: it is a function of the row alone, and
  // the fill visits far more texels than there are rows.
  const rowAbsLat = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    const lat = ((y + 0.5) / height - 0.5) * Math.PI;
    rowArea[y] = GLOBE_RADIUS * GLOBE_RADIUS * Math.cos(lat) * dLon * dLat;
    rowAbsLat[y] = Math.abs(lat);
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
  let bandIsletsSunk = 0;
  let bandIsletsKept = 0;
  let largestBandIslet = 0;
  let bandBridges = 0;
  let mainlandMinAbsLat = Infinity;

  for (let start = 0; start < cells; start++) {
    if (!land[start] || seen[start]) continue;

    let sp = 0;
    let count = 0;
    let area = 0;
    // The component's latitude extent, tracked through the fill it is already
    // doing. Two comparisons a texel and no second pass -- the alternative is
    // walking `member` again afterwards, which costs the same work and one more
    // place for the two loops to disagree about what a member is.
    let loAbsLat = Infinity;
    let hiAbsLat = 0;
    stack[sp++] = start;
    seen[start] = 1;

    while (sp > 0) {
      const i = stack[--sp];
      const y = (i / width) | 0;
      const x = i - y * width;
      member[count++] = i;
      area += rowArea[y];
      const absLat = rowAbsLat[y];
      if (absLat < loAbsLat) loAbsLat = absLat;
      if (absLat > hiAbsLat) hiAbsLat = absLat;

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

    /*
     * "Entirely inside the strip", and never "has a texel inside it".
     *
     * The tempting version is the dangerous one. The day someone retunes
     * `terrain.ts`'s BAND_CEILING and a continental tongue reaches the band,
     * "any texel inside" would sink the continent it belongs to -- a rule that
     * deletes a landmass the size of a continent because one pixel of it
     * strayed. This version can only ever fail the other way: a speck survives
     * that should have gone, which is a speck.
     */
    const bandIslet = hiAbsLat <= BAND_ISLET_REACH;
    const tooBig =
      bandIslet && (area > MAX_BAND_ISLET_AREA || hiAbsLat - loAbsLat > MAX_BAND_ISLET_SPAN);

    // A foot in the guaranteed strip and a body outside the veto's reach: a
    // coast that walked in. Counted, never sunk -- see `bandBridges`.
    if (!bandIslet && loAbsLat < BAND_GUARANTEE_RAD) bandBridges++;

    if (area < MIN_ISLAND_AREA || tooBig) {
      islandsRemoved++;
      if (tooBig) bandIsletsSunk++;
      removedArea += area;
      for (let k = 0; k < count; k++) heightMap.setAt(member[k], sunkTo);
    } else {
      if (area < smallestKept) smallestKept = area;
      if (bandIslet) {
        bandIsletsKept++;
        if (area > largestBandIslet) largestBandIslet = area;
      } else if (loAbsLat < mainlandMinAbsLat) {
        // Measured over what SURVIVES, and over mainland only: an islet the
        // strip is allowed to keep is not the coast this promise is about.
        mainlandMinAbsLat = loAbsLat;
      }
    }
  }

  heightMap.flush();

  return {
    islandsBefore,
    islandsRemoved,
    areaRemoved: totalArea > 0 ? removedArea / totalArea : 0,
    smallestKept: smallestKept === Infinity ? 0 : smallestKept,
    bandIsletsSunk,
    bandIsletsKept,
    largestBandIslet,
    bandBridges,
    // Left as Infinity when there is no mainland at all, which is a world with
    // no land outside the strip. `worldgen.ts`'s land fraction would have
    // thrown that away long before anything read this.
    mainlandMinAbsLat,
  };
}
