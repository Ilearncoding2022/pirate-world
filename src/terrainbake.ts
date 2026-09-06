import { DataTexture, RGBAFormat, UnsignedByteType, LinearFilter, RepeatWrapping, ClampToEdgeWrapping } from 'three';
import type { HeightMap } from './heightmap';
import { GLOBE_RADIUS } from './geo';

/**
 * Startup bake: ambient occlusion and 8-azimuth horizon angles over the
 * shared height field, read once by `land.ts` so the terrain shader can
 * shade per pixel without adding a single mesh vertex.
 *
 * Pure functions over a `Float32Array` equirectangular height field -- no
 * THREE dependency except in the one convenience wrapper (`bakeTerrain`) that
 * turns the raw arrays into textures. `land.ts` calls that wrapper once,
 * after `globe.ts` has run `cullIslets` and flushed the shared height map:
 * baking before the cull would bake occlusion for islands `islets.ts` is
 * about to sink.
 *
 * The equirect projection distorts distance: a step of `dLon` at latitude
 * `lat` covers `GLOBE_RADIUS * cos(lat) * dLon` world units, while the same
 * `dLat` always covers `GLOBE_RADIUS * dLat`. Every ray marched below divides
 * its east/west component by `cos(lat)` for exactly that reason -- get it
 * wrong and slopes, AO and horizon angles are all quietly incorrect off the
 * equator, worst at the poles.
 *
 * The ray march resolves to the nearest downsampled texel rather than
 * bilinear-filtering every step. A first pass filtered every step and cost
 * ~1050ms at 1024x512 -- more than 3x the 300ms budget. Nearest sampling,
 * plus precomputing each azimuth's step offsets as whole texels once (not
 * per fragment), turns the inner loop into integer array reads and brings
 * the whole bake in around the numbers logged in the report; see
 * `bakeTerrain`'s console.debug for the measured figure on this machine.
 */

/** Downsample size the bake runs at -- half the shared map's 2048x1024. The
 * plan's own reasoning: AO and horizon are low-frequency, so nothing legible
 * is lost, and a quarter of the texels is a quarter of the bake's cost. Both
 * dimensions are powers of two, which is what lets the longitude wrap below
 * use a bitmask instead of a modulo. */
export const BAKE_WIDTH = 1024;
export const BAKE_HEIGHT = 512;

/**
 * World-scale: converts a raw height-field sample (roughly [-1, 1], the same
 * units `heightmap.ts` stores) into world-unit elevation for slope, AO and
 * horizon math. Same order of magnitude as `land.ts`'s `MAX_LAND_RELIEF`
 * (`GLOBE_RADIUS * 0.05`), kept as an independent constant rather than an
 * import of it: `land.ts` imports this module, so importing back would be a
 * cycle, and the mesh's own easing curve (landRadius's `a * a`) is not worth
 * replicating here -- this bake is a shading approximation, not the mesh.
 */
export const BAKE_RELIEF_SCALE = GLOBE_RADIUS * 0.05;

/** Azimuths sampled per texel, both bakes. Matches the two RGBA8 horizon
 * textures (four azimuths per channel set) and the plan's "8 directions". */
export const BAKE_DIRECTIONS = 8;

/** Steps marched outward per azimuth for ambient occlusion -- the plan's own
 * "8 directions x 12 steps". Not a distance; see AO_RADIUS_RADIANS below. */
export const AO_STEPS = 12;

/**
 * Steps marched outward per azimuth for the horizon test. Fewer than
 * `AO_STEPS`: the horizon ray covers roughly six times AO's distance (see
 * HORIZON_RADIUS_RADIANS) and only needs to find the single tallest feature
 * along it, not resolve a nearby crevice, so wider steps cost accuracy the
 * budget cannot otherwise afford -- see the top-of-file note.
 */
export const HORIZON_STEPS = 8;

/**
 * Total great-circle arc marched for ambient occlusion, in radians --
 * world-scale, like terrain noise itself. ~7 world units at GLOBE_RADIUS=200:
 * short on purpose, since AO is about the crevice right under a pixel, not
 * the mountain range past the horizon.
 */
export const AO_RADIUS_RADIANS = 0.035;

/**
 * Total great-circle arc marched for the horizon test, in radians --
 * world-scale. ~40 world units at GLOBE_RADIUS=200: far enough that a ridge
 * a short sail away can shadow the sunrise, without paying for the whole
 * horizon.
 */
export const HORIZON_RADIUS_RADIANS = 0.2;

/**
 * Elevation angle a fully-saturated baked horizon byte represents, degrees.
 * The GLSL side (`land.ts`) decodes with the same constant so the two never
 * drift apart.
 */
export const HORIZON_MAX_DEGREES = 60;

/**
 * Height-field units (SEA_LEVEL's own normalized scale, not world units).
 * Origin texels this far below sea level are open ocean far from any coast
 * the land mesh could ever draw -- `land.ts`'s kept faces bottom out at
 * `seaLevel - CULL_MARGIN` (0.10) -- so both bakes skip ray-marching from
 * them and write the flat, unoccluded answer directly. This is most of the
 * bake's remaining cost saving: about three quarters of the height field is
 * ocean.
 */
const SEA_SKIP_MARGIN = 0.16;

const TWO_PI = Math.PI * 2;
/** Floor on cos(lat) so the east/west step near the poles does not divide by
 * (near) zero and send a ray to the other side of the planet. */
const MIN_COS_LAT = 0.05;

/** Bilinear sample of an equirect Float32Array field. u wraps, v clamps --
 * the same convention as `heightmap.ts`'s `sample`, reimplemented here
 * because this operates on the bake's own downsampled copy, not the shared
 * map's array. Only used for the downsample itself; the ray march below
 * resolves to whole texels for speed -- see the top-of-file note. */
function sampleField(data: Float32Array, w: number, h: number, lat: number, lon: number): number {
  let u = lon / TWO_PI + 0.5;
  u -= Math.floor(u);
  const v = Math.min(0.999999, Math.max(0, lat / Math.PI + 0.5));

  const fx = u * w - 0.5;
  const fy = v * h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(fy)));
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = ((x0 % w) + w) % w;
  const xb = (xa + 1) % w;

  const h00 = data[y0 * w + xa];
  const h10 = data[y0 * w + xb];
  const h01 = data[y1 * w + xa];
  const h11 = data[y1 * w + xb];
  const top = h00 + (h10 - h00) * tx;
  const bot = h01 + (h11 - h01) * tx;
  return top + (bot - top) * ty;
}

/**
 * Point-sampled downsample of an equirect height field to `dstW`x`dstH`.
 * Point sampling rather than a box filter: the plan's own justification for
 * baking at half resolution is that AO and horizon are low-frequency, so the
 * extra antialiasing a box filter would buy is not worth its cost here.
 */
function downsample(src: Float32Array, srcW: number, srcH: number, dstW: number, dstH: number): Float32Array {
  const out = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const v = (y + 0.5) / dstH;
    const lat = (v - 0.5) * Math.PI;
    for (let x = 0; x < dstW; x++) {
      const u = (x + 0.5) / dstW;
      const lon = (u - 0.5) * TWO_PI;
      out[y * dstW + x] = sampleField(src, srcW, srcH, lat, lon);
    }
  }
  return out;
}

/** cos/sin of each of the `BAKE_DIRECTIONS` azimuths, 0 = north, clockwise --
 * the same convention `geo.ts`'s heading uses, so the land shader's own
 * bearing math lines up with the texel a byte came from. */
function azimuthComponents(): { cos: Float64Array; sin: Float64Array } {
  const cos = new Float64Array(BAKE_DIRECTIONS);
  const sin = new Float64Array(BAKE_DIRECTIONS);
  for (let k = 0; k < BAKE_DIRECTIONS; k++) {
    const angle = (k * TWO_PI) / BAKE_DIRECTIONS;
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }
  return { cos, sin };
}

/**
 * Per-(azimuth, step) row offset in whole texels, `[k * steps + s]`.
 *
 * Independent of longitude and of latitude (moving north/south covers
 * `GLOBE_RADIUS * dLat` regardless of where you start), so this is built
 * once per bake and reused for every row.
 */
function buildRowOffsets(radiusRadians: number, steps: number, h: number, cosAz: Float64Array): Int32Array {
  const out = new Int32Array(BAKE_DIRECTIONS * steps);
  const stepWorld = (radiusRadians * GLOBE_RADIUS) / steps;
  const pixelsPerRadian = h / Math.PI;
  for (let k = 0; k < BAKE_DIRECTIONS; k++) {
    const dLatPerUnit = cosAz[k] / GLOBE_RADIUS;
    for (let s = 0; s < steps; s++) {
      const dist = (s + 1) * stepWorld;
      out[k * steps + s] = Math.round(dLatPerUnit * dist * pixelsPerRadian);
    }
  }
  return out;
}

/**
 * Per-(azimuth, step) column offset in whole texels, for one row's `cosLat`
 * -- this is where the equirect metric correction lives: the same world-unit
 * east/west step is more texels wide near the equator than near a pole.
 *
 * Also fills `scaleOut` with `BAKE_RELIEF_SCALE / distance`, ready to
 * multiply straight into a height difference in the hot loop below (a
 * multiply is cheaper there than a divide, and this is called once per row,
 * not once per texel) -- `distance` being the WORLD-UNIT distance actually
 * represented by the rounded (row, col) texel pair this step resolved to,
 * not the nominal, pre-rounding step distance. Rounding both offsets to the
 * nearest whole texel and then dividing by the distance that rounding was
 * SUPPOSED to represent biases the ratio the two bakes maximise over: a
 * short early step rounds a larger fraction of itself away, and since the
 * max is always taken on the favourable side, that bias does not average
 * out. Recomputing the distance from what was actually sampled removes it;
 * a unit test (the cone of known slope) is what caught the ~1.2 degree miss
 * the nominal distance produced. A step whose rounded offset landed back on
 * the origin texel writes 0 rather than dividing by (near) zero -- see
 * `Math.max(0, maxRatio)` at each call site, which already treats "no
 * contribution" and "contributes exactly 0" identically.
 */
function buildColOffsetsAndScale(
  radiusRadians: number,
  steps: number,
  w: number,
  h: number,
  cosLat: number,
  sinAz: Float64Array,
  rowOffsets: Int32Array,
  colOut: Int32Array,
  scaleOut: Float64Array,
): void {
  const stepWorld = (radiusRadians * GLOBE_RADIUS) / steps;
  const pixelsPerRadianU = w / TWO_PI;
  const dLatPerPixel = Math.PI / h;
  const dLonPerPixel = TWO_PI / w;
  const safeCosLat = Math.max(cosLat, MIN_COS_LAT);
  for (let k = 0; k < BAKE_DIRECTIONS; k++) {
    const dLonPerUnit = sinAz[k] / (GLOBE_RADIUS * safeCosLat);
    for (let s = 0; s < steps; s++) {
      const idx = k * steps + s;
      const dist = (s + 1) * stepWorld;
      const dx = Math.round(dLonPerUnit * dist * pixelsPerRadianU);
      colOut[idx] = dx;

      const dLat = rowOffsets[idx] * dLatPerPixel;
      const dLon = dx * dLonPerPixel;
      // Flat tangent-plane distance for the realised (dLat, dLon) pair, the
      // same equirect metric correction as everywhere else in this file:
      // an east/west texel is `cosLat` times narrower, in world units, than
      // a north/south one.
      const realDist = GLOBE_RADIUS * Math.sqrt(dLat * dLat + (cosLat * dLon) * (cosLat * dLon));
      scaleOut[idx] = realDist < MIN_STEP_DIST ? 0 : BAKE_RELIEF_SCALE / realDist;
    }
  }
}

/**
 * Wraps a column index into `[0, w)`. `BAKE_WIDTH` is a power of two, so the
 * hot path (`bakeTerrain`) takes the bitmask branch -- measurably cheaper
 * than `%` at the tens of millions of calls this runs at -- while arbitrary
 * widths (the unit tests' smaller synthetic grids) still get a correct
 * modulo.
 */
function wrapX(x: number, w: number): number {
  if ((w & (w - 1)) === 0) return x & (w - 1);
  const r = x % w;
  return r < 0 ? r + w : r;
}

/** Below this, a step's rounded offset landed back on the origin texel --
 * too close to say anything about the horizon, and dividing by it would
 * divide by (near) zero. World units. */
const MIN_STEP_DIST = 1e-4;

/**
 * 8-direction, `AO_STEPS`-step horizon-cone ambient occlusion.
 *
 * Output is 0-1 per texel: 1 where nothing along any of the eight rays rises
 * above the local horizontal (an open field), lower where nearby terrain
 * climbs around the point. `seaLevel` lets ocean texels -- about three
 * quarters of the field -- skip the ray march entirely and read as fully
 * open, since nothing ever shades them: the land mesh never draws that far
 * out.
 */
export function bakeAmbientOcclusion(
  data: Float32Array,
  w: number,
  h: number,
  seaLevel: number,
): Float32Array {
  const out = new Float32Array(w * h);
  const { cos: cosAz, sin: sinAz } = azimuthComponents();
  const steps = AO_STEPS;
  const rowOffsets = buildRowOffsets(AO_RADIUS_RADIANS, steps, h, cosAz);
  const colOffsets = new Int32Array(BAKE_DIRECTIONS * steps);
  const scaleTable = new Float64Array(BAKE_DIRECTIONS * steps);
  const skipBelow = seaLevel - SEA_SKIP_MARGIN;
  const maxY = h - 1;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const lat = (v - 0.5) * Math.PI;
    const cosLat = Math.cos(lat);
    buildColOffsetsAndScale(AO_RADIUS_RADIANS, steps, w, h, cosLat, sinAz, rowOffsets, colOffsets, scaleTable);
    const rowBase = y * w;

    for (let x = 0; x < w; x++) {
      const idx = rowBase + x;
      const h0 = data[idx];
      if (h0 < skipBelow) {
        out[idx] = 1;
        continue;
      }

      let sinSum = 0;
      for (let k = 0; k < BAKE_DIRECTIONS; k++) {
        const base = k * steps;
        let maxRatio = -Infinity;
        for (let s = 0; s < steps; s++) {
          let yy = y + rowOffsets[base + s];
          if (yy < 0) yy = 0;
          else if (yy > maxY) yy = maxY;
          const xx = wrapX(x + colOffsets[base + s], w);
          const sample = data[yy * w + xx];
          const ratio = (sample - h0) * scaleTable[base + s];
          if (ratio > maxRatio) maxRatio = ratio;
        }
        const angle = Math.atan(Math.max(0, maxRatio));
        sinSum += Math.sin(angle);
      }
      out[idx] = 1 - sinSum / BAKE_DIRECTIONS;
    }
  }
  return out;
}

/**
 * Maximum elevation angle to the terrain along each of `BAKE_DIRECTIONS`
 * azimuths, encoded 0-1 over 0-`HORIZON_MAX_DEGREES` degrees, packed into two
 * RGBA8-ready `Uint8Array`s (azimuths 0-3 in the first, 4-7 in the second).
 *
 * `seaLevel` is not in the plan's original signature -- see the report -- but
 * without it this bake alone still runs the full unskipped cost over every
 * texel, ocean included, which was most of what put the first version of
 * this bake over budget. Ocean texels write horizon 0 (no shadow), which is
 * also the physically sensible answer: open water casts none.
 */
export function bakeHorizon(
  data: Float32Array,
  w: number,
  h: number,
  seaLevel: number,
): [Uint8Array, Uint8Array] {
  const out0 = new Uint8Array(w * h * 4);
  const out1 = new Uint8Array(w * h * 4);
  const { cos: cosAz, sin: sinAz } = azimuthComponents();
  const steps = HORIZON_STEPS;
  const rowOffsets = buildRowOffsets(HORIZON_RADIUS_RADIANS, steps, h, cosAz);
  const colOffsets = new Int32Array(BAKE_DIRECTIONS * steps);
  const scaleTable = new Float64Array(BAKE_DIRECTIONS * steps);
  const maxAngleRad = (HORIZON_MAX_DEGREES * Math.PI) / 180;
  const skipBelow = seaLevel - SEA_SKIP_MARGIN;
  const maxY = h - 1;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const lat = (v - 0.5) * Math.PI;
    const cosLat = Math.cos(lat);
    buildColOffsetsAndScale(HORIZON_RADIUS_RADIANS, steps, w, h, cosLat, sinAz, rowOffsets, colOffsets, scaleTable);
    const rowBase = y * w;

    for (let x = 0; x < w; x++) {
      const idx = rowBase + x;
      const pix = idx * 4;
      const h0 = data[idx];
      if (h0 < skipBelow) continue; // already zero-filled by the Uint8Array constructor

      for (let k = 0; k < BAKE_DIRECTIONS; k++) {
        const base = k * steps;
        let maxRatio = -Infinity;
        for (let s = 0; s < steps; s++) {
          let yy = y + rowOffsets[base + s];
          if (yy < 0) yy = 0;
          else if (yy > maxY) yy = maxY;
          const xx = wrapX(x + colOffsets[base + s], w);
          const sample = data[yy * w + xx];
          const ratio = (sample - h0) * scaleTable[base + s];
          if (ratio > maxRatio) maxRatio = ratio;
        }
        const angle = Math.min(maxAngleRad, Math.atan(Math.max(0, maxRatio)));
        const byte = Math.round((angle / maxAngleRad) * 255);
        if (k < 4) out0[pix + k] = byte;
        else out1[pix + (k - 4)] = byte;
      }
    }
  }
  return [out0, out1];
}

/** What `bakeTerrain` hands back to `land.ts`. */
export interface TerrainBake {
  /** R = ambient occlusion (0-1), G/B/A unused. */
  aux: DataTexture;
  /** Two RGBA8 textures, four of the eight baked azimuths each. */
  horizon: [DataTexture, DataTexture];
  /** Wall-clock time the whole bake (downsample + both passes) took, ms. */
  ms: number;
}

function makeTexture(bytes: Uint8Array, w: number, h: number, name: string): DataTexture {
  const texture = new DataTexture(bytes, w, h, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = name;
  return texture;
}

/**
 * Runs both bakes over `heightMap` and builds the textures `land.ts` samples.
 *
 * Call this only after `globe.ts`'s `cullIslets` has run and `flush()` has
 * been called -- baking earlier would occlude islands that are about to be
 * sunk and never drawn. `land.ts` satisfies this by calling it from inside
 * `createLand`, which `globe.ts` already constructs after the cull.
 *
 * Measured, not assumed: logs the wall-clock time once at `console.debug`
 * so the 300ms budget in docs/RENDER_PLAN.md can be checked against a real
 * number rather than an estimate.
 */
export function bakeTerrain(heightMap: HeightMap, seaLevel: number): TerrainBake {
  const start = performance.now();

  const small = downsample(heightMap.data, heightMap.width, heightMap.height, BAKE_WIDTH, BAKE_HEIGHT);
  const ao = bakeAmbientOcclusion(small, BAKE_WIDTH, BAKE_HEIGHT, seaLevel);
  const [h0, h1] = bakeHorizon(small, BAKE_WIDTH, BAKE_HEIGHT, seaLevel);

  const auxBytes = new Uint8Array(BAKE_WIDTH * BAKE_HEIGHT * 4);
  for (let i = 0; i < ao.length; i++) {
    auxBytes[i * 4] = Math.round(Math.max(0, Math.min(1, ao[i])) * 255);
    auxBytes[i * 4 + 1] = 255;
    auxBytes[i * 4 + 2] = 255;
    auxBytes[i * 4 + 3] = 255;
  }

  const ms = performance.now() - start;
  // eslint-disable-next-line no-console
  console.debug(`terrainbake: ${BAKE_WIDTH}x${BAKE_HEIGHT} AO + horizon baked in ${ms.toFixed(1)}ms`);

  return {
    aux: makeTexture(auxBytes, BAKE_WIDTH, BAKE_HEIGHT, 'terrain-ao'),
    horizon: [
      makeTexture(h0, BAKE_WIDTH, BAKE_HEIGHT, 'terrain-horizon-0'),
      makeTexture(h1, BAKE_WIDTH, BAKE_HEIGHT, 'terrain-horizon-1'),
    ],
    ms,
  };
}
