import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RedFormat, RepeatWrapping, ClampToEdgeWrapping, Vector3 } from 'three';
import type { Terrain } from './types';

export interface HeightMap {
  /**
   * Baked ambient occlusion (R channel, 0-1; G/B/A unused, filled 255).
   *
   * Additive field: `createHeightMap` leaves it `null`. `land.ts` fills it
   * in (via `terrainbake.ts`'s `bakeTerrain`) once `globe.ts` has run
   * `cullIslets` and flushed the map -- baking earlier would bake occlusion
   * for islands about to be sunk. Nothing else writes it, and the existing
   * `texture`/`data`/`sample` above are untouched by any of this.
   */
  aux: DataTexture | null;
  /**
   * Baked horizon angles, two RGBA8 textures of four azimuths each (eight
   * total, 45 degrees apart, 0 = north and clockwise -- see `terrainbake.ts`).
   * Same lifecycle as `aux`: `null` until `land.ts`'s bake fills it in.
   */
  horizon: [DataTexture, DataTexture] | null;
  /**
   * Equirectangular terrain height, R16F, linear-filterable in WebGL2.
   *
   * Mapping, matching the latLonToDir convention in geo.ts:
   *   lat = asin(dir.y);  lon = atan(dir.x, dir.z);
   *   u   = lon / (2*PI) + 0.5;   v = lat / PI + 0.5;
   * u wraps (RepeatWrapping), v clamps.
   *
   * The stored value is terrain.heightAt(dir), roughly in [-1, 1].
   * Values above terrain.seaLevel are land.
   */
  texture: DataTexture;
  /** Raw heights, row-major, v increasing with index. Same values as the texture. */
  data: Float32Array;
  width: number;
  height: number;
  /** Bilinear sample of `data` at a unit direction. Matches the shader lookup. */
  sample(dir: Vector3): number;
  /**
   * Overwrite one texel, by index into `data`, in both the CPU array and the
   * half-float copy the GPU reads. Batch these and call `flush` once: the
   * upload is per-texture, not per-texel.
   *
   * This exists for `islets.ts`, which can only decide what to keep after a
   * flood fill has told it which texels belong to the same landmass. Nothing
   * else should be rewriting the terrain behind the generator's back.
   */
  setAt(index: number, h: number): void;
  /** Re-upload the texture after a run of `setAt` calls. */
  flush(): void;
}

/**
 * Rasterise the terrain height field into an equirectangular texture.
 *
 * Built once at startup. Sampling this in a fragment shader is far cheaper and
 * far higher resolution than pushing terrain detail through mesh vertices, so
 * the water shader, city lights and any future map overlay all read from here.
 */
export function createHeightMap(terrain: Terrain, width = 2048, height = 1024): HeightMap {
  const data = new Float32Array(width * height);
  const half = new Uint16Array(width * height);
  const dir = new Vector3();

  for (let y = 0; y < height; y++) {
    // Pixel centres, so the poles are not sampled exactly.
    const v = (y + 0.5) / height;
    const lat = (v - 0.5) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const lon = (u - 0.5) * Math.PI * 2;
      dir.set(cosLat * Math.sin(lon), sinLat, cosLat * Math.cos(lon));

      const h = terrain.heightAt(dir);
      const i = y * width + x;
      data[i] = h;
      half[i] = DataUtils.toHalfFloat(h);
    }
  }

  const texture = new DataTexture(half, width, height, RedFormat, HalfFloatType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = 'terrain-heightmap';

  function sample(d: Vector3): number {
    const lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
    const lon = Math.atan2(d.x, d.z);
    let u = lon / (Math.PI * 2) + 0.5;
    u -= Math.floor(u);
    const v = Math.min(0.999999, Math.max(0, lat / Math.PI + 0.5));

    const fx = u * width - 0.5;
    const fy = v * height - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.min(height - 1, Math.max(0, Math.floor(fy)));
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const xa = ((x0 % width) + width) % width;
    const xb = (xa + 1) % width;

    const h00 = data[y0 * width + xa];
    const h10 = data[y0 * width + xb];
    const h01 = data[y1 * width + xa];
    const h11 = data[y1 * width + xb];
    const top = h00 + (h10 - h00) * tx;
    const bot = h01 + (h11 - h01) * tx;
    return top + (bot - top) * ty;
  }

  function setAt(index: number, h: number): void {
    data[index] = h;
    half[index] = DataUtils.toHalfFloat(h);
  }

  function flush(): void {
    texture.needsUpdate = true;
  }

  return { texture, data, width, height, sample, setAt, flush, aux: null, horizon: null };
}

/**
 * GLSL helper shared by every shader that reads the height map.
 * Declares `uHeightMap` yourself; this only provides the lookup functions.
 */
export const HEIGHTMAP_GLSL = [
  'vec2 dirToEquirect(vec3 d) {',
  '  float lat = asin(clamp(d.y, -1.0, 1.0));',
  '  float lon = atan(d.x, d.z);',
  '  return vec2(lon / 6.28318530718 + 0.5, lat / 3.14159265359 + 0.5);',
  '}',
  'float terrainHeight(sampler2D heightMap, vec3 d) {',
  '  return texture2D(heightMap, dirToEquirect(d)).r;',
  '}',
].join('\n');
