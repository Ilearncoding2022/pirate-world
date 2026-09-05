import { Vector3 } from 'three';
import { createNoise3D } from 'simplex-noise';
import type { Terrain } from './types';
import { latLonToDir } from './geo';

/** Default world seed. */
export const DEFAULT_SEED = 1337;

/** Height threshold separating water from land. */
export const SEA_LEVEL = 0.08;

/** Deterministic 32-bit PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Open-water radius (in radians of arc) guaranteed around the spawn point. */
const SPAWN_CLEAR_RADIANS = 0.16;
const SPAWN_FADE_RADIANS = 0.34;

const _spawn = latLonToDir(0, 0, new Vector3());
const _probe = new Vector3();

export function createTerrain(seed: number = DEFAULT_SEED): Terrain {
  const rng = mulberry32(seed);
  // Independent noise fields: broad continents, mid-scale coastline shaping, fine detail.
  const continentNoise = createNoise3D(rng);
  const shapeNoise = createNoise3D(rng);
  const detailNoise = createNoise3D(rng);
  const warpNoise = createNoise3D(rng);

  /** Fractal Brownian motion over a 3D noise field. */
  function fbm(
    noise: (x: number, y: number, z: number) => number,
    x: number,
    y: number,
    z: number,
    octaves: number,
    lacunarity: number,
    gain: number,
  ): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  function heightAt(dir: Vector3): number {
    const x = dir.x;
    const y = dir.y;
    const z = dir.z;

    // Domain warp keeps coastlines from looking like plain blobs.
    const w = 0.35;
    const wx = x + w * warpNoise(x * 1.7 + 11.3, y * 1.7, z * 1.7);
    const wy = y + w * warpNoise(x * 1.7, y * 1.7 + 7.1, z * 1.7);
    const wz = z + w * warpNoise(x * 1.7, y * 1.7, z * 1.7 + 3.9);

    // Broad landmasses: low frequency so we get a handful of real continents.
    const continents = fbm(continentNoise, wx * 1.05, wy * 1.05, wz * 1.05, 4, 2.0, 0.5);
    // Mid-scale shaping: peninsulas, bays, island arcs.
    const shape = fbm(shapeNoise, wx * 2.9, wy * 2.9, wz * 2.9, 4, 2.1, 0.5);
    // Fine detail: only meaningful once we are already near/above sea level.
    const detail = fbm(detailNoise, x * 8.5, y * 8.5, z * 8.5, 3, 2.2, 0.5);

    let h = continents * 0.72 + shape * 0.26 + detail * 0.08;

    // Bias the whole field down so the world reads as an ocean world with continents,
    // and gently flatten the extremes.
    h = h * 1.55 - 0.02;

    // Guarantee open water at the spawn point so the ship never starts beached.
    const d = Math.acos(Math.max(-1, Math.min(1, dir.dot(_spawn))));
    if (d < SPAWN_FADE_RADIANS) {
      const t =
        d <= SPAWN_CLEAR_RADIANS
          ? 0
          : (d - SPAWN_CLEAR_RADIANS) / (SPAWN_FADE_RADIANS - SPAWN_CLEAR_RADIANS);
      const smooth = t * t * (3 - 2 * t);
      const floor = -0.32;
      h = floor + (h - floor) * smooth;
    }

    return Math.max(-1, Math.min(1, h));
  }

  function isLand(dir: Vector3): boolean {
    return heightAt(dir) > SEA_LEVEL;
  }

  return {
    heightAt,
    isLand,
    isLandLatLon(latDeg: number, lonDeg: number): boolean {
      return isLand(latLonToDir(latDeg, lonDeg, _probe));
    },
    seaLevel: SEA_LEVEL,
  };
}
