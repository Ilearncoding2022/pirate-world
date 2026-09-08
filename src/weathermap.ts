/**
 * weathermap.ts — the live cells, baked into a texture the sky can read.
 *
 * `waterhazard.ts` packs its three hazards into uniform ARRAYS, and that is
 * right for a hazard: there are exactly three, each is a height the hull must
 * ride, and the shader loop is three iterations of polynomial arithmetic. A
 * weather cell is none of those things. It shades rather than displaces, the
 * population is not fixed, and the orbital shot wants every cell on the lit
 * hemisphere at once rather than the three nearest the ship.
 *
 * So the cells are rasterised into a small equirectangular texture a few
 * times a second, and the cloud deck and the aerial haze read it with the same
 * `dirToEquirect` the height map and the water-body mask already use. One
 * texture fetch per pixel whatever the population is, and no `MAX_CELLS`
 * constant anywhere in a shader.
 *
 * **This texture is DATA, not colour**, in exactly the sense `wakemap.ts`'s is:
 * R is the storm field, G the fog field, B a flag for whether the storm here
 * carries lightning, and its `colorSpace` is `NoColorSpace`. Never let it pick
 * up an sRGB encode going in or a decode coming out.
 *
 * **And it is not the truth.** It is 2.45 world units per texel, bilinear, and
 * up to a quarter-second stale. Everything that decides a NUMBER -- the
 * envelopes at the ship, the visibility, the wind's floor, the chart's stamp
 * -- reads `CellsState`'s analytic sample instead. See docs/WEATHER_PLAN.md,
 * Trap 3. The two disagree by a texel at a cell's edge, where the sky is soft
 * and nobody can tell.
 */
import { ClampToEdgeWrapping, DataTexture, LinearFilter, NoColorSpace, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three';
import type { CellsState } from './types';
import { GLOBE_RADIUS, capColumns } from './geo';
import { cellProfile } from './weathercells';

export interface WeatherMap {
  /** The texture the consumers sample. Data, not colour. */
  texture: DataTexture;
  /**
   * Re-bakes at most `MAP_HZ` times a second, and only when something moved.
   * Called from `globe.update`, before the shaders that read it.
   */
  update(dt: number, cells: CellsState): void;
}

/**
 * Texels across and down.
 *
 * 512 x 256 is 2.45 world units per texel at the equator, against cells 50 to
 * 120 units across: twenty to fifty texels per cell, which is a soft ring two
 * texels wide at the edge once the bilinear filter has had it. That is a
 * feature in a cloud and invisible in haze. Four times the resolution would
 * be four times the upload for an edge nobody is looking at.
 */
const MAP_WIDTH = 512;
const MAP_HEIGHT = 256;

/**
 * Bakes per second.
 *
 * A cell drifts at 2 units per second, so a quarter-second of staleness is
 * half a texel of lag. The bake is skipped entirely when nothing has moved
 * far enough to change a texel, which is what makes an empty sky free.
 */
const MAP_HZ = 4;

/** Bytes per texel. RGBA because WebGL2 wants a four-byte row alignment anyway. */
const STRIDE = 4;

/**
 * Rasterise `cells` into `data`.
 *
 * A pure function over a `Uint8Array` so a Node test can run it with no GPU,
 * which is the whole reason it is exported: the parity that matters here is
 * between this and `cellProfile`, and that can be checked on the CPU alone.
 *
 * Each cell stamps its own bounding band of rows, and within a row the band of
 * columns `capColumns` gives -- the same arithmetic `chart.ts` stamps its
 * discovered disc with, shared through `geo.ts` so the sky and the scope
 * cannot end up disagreeing about where a cell is.
 *
 * Cells combine by `max`, never by sum, for the reason `weathercells.ts`
 * gives at its own sample: two overlapping banks are one weather.
 */
export function bakeWeatherMap(
  cells: CellsState,
  data: Uint8Array,
  width: number,
  height: number,
): void {
  data.fill(0);

  for (const cell of cells.live) {
    if (cell.strength <= 0) continue;
    const angRadius = cell.radius / GLOBE_RADIUS;
    // The centre in equirectangular terms. Same convention as the height
    // map's `dirToEquirect`: lat from y, lon from atan2(x, z).
    const lat0 = Math.asin(Math.max(-1, Math.min(1, cell.centre.y)));
    const lon0 = Math.atan2(cell.centre.x, cell.centre.z);

    const rowSpan = Math.ceil((angRadius / Math.PI) * height) + 1;
    const row0 = Math.floor(((lat0 / Math.PI + 0.5) * height) - rowSpan);
    const row1 = Math.ceil(((lat0 / Math.PI + 0.5) * height) + rowSpan);

    for (let y = row0; y <= row1; y++) {
      if (y < 0 || y >= height) continue;
      // The row's own latitude, at its centre.
      const lat = ((y + 0.5) / height - 0.5) * Math.PI;
      const half = capColumns(lat, lat0, angRadius);
      if (half < 0) continue;

      // How many columns that half-width is. A full row (half = PI) is the
      // whole width, which is what a cap over a pole does and why it needs no
      // wrapping special case.
      const colSpan =
        half >= Math.PI ? width : Math.ceil((half / (2 * Math.PI)) * width) + 1;
      const colCentre = (lon0 / (2 * Math.PI) + 0.5) * width;

      for (let k = -colSpan; k <= colSpan; k++) {
        // Wrapped: the map repeats in U, so a cell on the antimeridian writes
        // into both ends of the row rather than being clipped at one.
        let x = Math.floor(colCentre + k);
        x = ((x % width) + width) % width;

        // The distance is measured properly rather than assumed from the
        // band: the band is a bounding box in an equirectangular projection
        // and is generously wrong near the poles.
        const lon = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
        const cosD =
          Math.sin(lat0) * Math.sin(lat) +
          Math.cos(lat0) * Math.cos(lat) * Math.cos(lon - lon0);
        const d = Math.acos(Math.max(-1, Math.min(1, cosD))) * GLOBE_RADIUS;

        const v = cellProfile(cell.strength, d, cell.radius);
        if (v <= 0) continue;
        const byte = v >= 1 ? 255 : (v * 255) | 0;

        const o = (y * width + x) * STRIDE;
        if (cell.kind === 'fog') {
          if (byte > data[o + 1]) data[o + 1] = byte;
        } else if (byte > data[o]) {
          data[o] = byte;
          // The lightning flag follows the STRONGEST storm at this texel, so
          // a lit cell overlapping an unlit one lights the overlap.
          data[o + 2] = cell.lightning ? 255 : 0;
        }
      }
    }
  }
}

/**
 * `weatherAt(map, dir)` — the storm, fog and lightning fields at a direction.
 *
 * Paste into a fragment shader that has already pasted `HEIGHTMAP_GLSL`: it
 * reuses that chunk's `dirToEquirect` rather than defining a second copy of
 * the same projection. Returns (storm, fog, lightning), each 0..1, and
 * exactly (0, 0, 0) everywhere when no cell is alive -- which is the zero
 * contract every consumer depends on.
 *
 * It DECLARES `uWeatherMap` itself, exactly as `FOG_GLSL` declares the fog
 * colours, so a consumer must not declare it a second time; merging
 * `weatherMapUniforms` into the material is all that is needed. The first cut
 * of this chunk left the declaration to the caller and the water and land
 * shaders promptly failed to compile with `'uWeatherMap' : undeclared
 * identifier` -- which no unit test could see, because nothing in the Node
 * tier compiles GLSL. A chunk that declares what it uses cannot fail that way.
 */
export const WEATHERMAP_GLSL = [
  'uniform sampler2D uWeatherMap;',
  'vec3 weatherAt(sampler2D weatherMap, vec3 d) {',
  '  return texture2D(weatherMap, dirToEquirect(d)).rgb;',
  '}',
].join('\n');

/**
 * The one uniform every consumer merges into its own map, the way each merges
 * `fogUniforms`. One texture, one owner, and every shader in a frame agrees
 * about where the weather is.
 */
export const weatherMapUniforms = {
  uWeatherMap: { value: null as DataTexture | null },
};

export function createWeatherMap(): WeatherMap {
  const data = new Uint8Array(MAP_WIDTH * MAP_HEIGHT * STRIDE);
  const texture = new DataTexture(data, MAP_WIDTH, MAP_HEIGHT, RGBAFormat, UnsignedByteType);
  // Data, not colour. See the file comment.
  texture.colorSpace = NoColorSpace;
  // U wraps so a cell straddling the antimeridian blends across it rather
  // than being clamped into a seam; V clamps, exactly as the height map's
  // does, because a latitude past the pole is not a latitude.
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  weatherMapUniforms.uWeatherMap.value = texture;

  let timer = 0;
  /** True while the map still holds something, so an emptied sky is cleared once. */
  let dirty = false;

  function update(dt: number, cells: CellsState): void {
    timer += dt;
    if (timer < 1 / MAP_HZ) return;
    timer = 0;

    const live = cells.live.length > 0;
    // An empty sky costs one bake, the frame the last cell dies, and nothing
    // after that. Not a fill per frame: `data.fill(0)` over half a megabyte
    // four times a second, forever, to say nothing is happening.
    if (!live && !dirty) return;

    bakeWeatherMap(cells, data, MAP_WIDTH, MAP_HEIGHT);
    texture.needsUpdate = true;
    dirty = live;
  }

  return { texture, update };
}

export { MAP_WIDTH, MAP_HEIGHT, MAP_HZ };
