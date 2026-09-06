import * as THREE from 'three';
import type { Terrain } from './types';
import type { WorldEnv } from './env';
import type { HeightMap } from './heightmap';
import { GLOBE_RADIUS } from './geo';

/**
 * Outward displacement of the highest land.
 *
 * World-scale, so it tracks GLOBE_RADIUS: 5% of the radius. Leaving it fixed
 * while the globe grew would flatten every mountain range into a rise.
 */
export const MAX_LAND_RELIEF = GLOBE_RADIUS * 0.05;
/**
 * Minimum lift of land above the water sphere. Keeps coastal faces from
 * z-fighting with the water surface, which sits at exactly GLOBE_RADIUS.
 */
export const COAST_LIFT = GLOBE_RADIUS * 0.0012;
/** Height band above sea level rendered as beach. */
const BEACH_BAND = 0.055;
/**
 * Faces whose vertices are all below this are dropped from the land mesh.
 *
 * Exported because `islets.ts` sinks the islands it culls past this depth. A
 * sunk islet shallower than the margin would keep its faces and go on being
 * drawn as land the ship can sail straight through.
 */
export const CULL_MARGIN = 0.10;

const PALETTE = {
  sand: new THREE.Color('#d9c48b'),
  grass: new THREE.Color('#4f7a4a'),
  forest: new THREE.Color('#2f5540'),
  rock: new THREE.Color('#5b5468'),
  peak: new THREE.Color('#b9b2c9'),
};

/** Colour ramp for land above sea level. */
function colorForLand(h: number, seaLevel: number, out: THREE.Color): THREE.Color {
  const a = Math.max(0, h - seaLevel);
  if (a < BEACH_BAND) return out.copy(PALETTE.sand).lerp(PALETTE.grass, a / BEACH_BAND);
  const t = Math.min(1, (a - BEACH_BAND) / 0.5);
  if (t < 0.4) return out.copy(PALETTE.grass).lerp(PALETTE.forest, t / 0.4);
  if (t < 0.75) return out.copy(PALETTE.forest).lerp(PALETTE.rock, (t - 0.4) / 0.35);
  return out.copy(PALETTE.rock).lerp(PALETTE.peak, (t - 0.75) / 0.25);
}

/** How far below the water surface a fully-submerged kept vertex is pushed. */
const SHORE_DIP = GLOBE_RADIUS * 0.022;

/**
 * Radius at which a vertex of the land mesh sits, given its terrain height.
 *
 * Vertices below sea level are sunk beneath the water sphere rather than
 * clamped to it. Without this, kept coastal faces all flatten onto one radius
 * and read as plates floating on the sea instead of a shore running into it.
 */
export function landRadius(h: number, seaLevel: number): number {
  if (h <= seaLevel) {
    const below = Math.min(1, (seaLevel - h) / 0.08);
    return GLOBE_RADIUS + COAST_LIFT - SHORE_DIP * below;
  }
  const a = Math.min(1, (h - seaLevel) / 0.6);
  // Eased so coastlines stay low and interiors rise.
  return GLOBE_RADIUS + COAST_LIFT + MAX_LAND_RELIEF * a * a;
}

export interface Land {
  mesh: THREE.Mesh;
  update(dt: number, env: WorldEnv): void;
}

/**
 * Land-only mesh.
 *
 * An icosphere is generated, then every face lying entirely below sea level is
 * discarded, so only continents and islands remain. Everything below is left to
 * the water surface. PolyhedronGeometry is non-indexed, which makes the face
 * filter a simple stride-9 walk over the position buffer.
 *
 * Heights come from the shared height map rather than from `terrain.heightAt`.
 * That is not only far cheaper -- a bilinear read against fifteen octaves of
 * fBm, three times per face, half a million faces -- it is also more correct:
 * the water shader reads the same texture, so land and sea agree on exactly
 * where the coastline is instead of differing by whatever the raster lost. The
 * map is finer than this mesh by a factor of three, so nothing is given up.
 */
/**
 * Icosphere subdivision.
 *
 * Sized so a triangle stays about 2.2 world units across -- a little under half
 * the ship's length -- which is the low-poly look the world is built around.
 * It is quadratic in cost, both in triangles and in the terrain samples taken
 * to build them, so it tracks the radius rather than being fixed: at
 * GLOBE_RADIUS 100 this is 96, the value the look was tuned at.
 */
const LAND_DETAIL = Math.round((96 * GLOBE_RADIUS) / 100);

export function createLand(terrain: Terrain, heightMap: HeightMap): Land {
  const source = new THREE.IcosahedronGeometry(GLOBE_RADIUS, LAND_DETAIL);
  const srcPos = source.attributes.position as THREE.BufferAttribute;
  const faceCount = srcPos.count / 3;

  const keptPositions: number[] = [];
  const keptColors: number[] = [];

  const dir = new THREE.Vector3();
  const color = new THREE.Color();
  const cutoff = terrain.seaLevel - CULL_MARGIN;

  const vh = [0, 0, 0];
  const vx = [0, 0, 0];
  const vy = [0, 0, 0];
  const vz = [0, 0, 0];

  for (let f = 0; f < faceCount; f++) {
    let anyLand = false;

    for (let k = 0; k < 3; k++) {
      const i = f * 3 + k;
      dir.fromBufferAttribute(srcPos, i).normalize();
      const h = heightMap.sample(dir);
      vh[k] = h;
      vx[k] = dir.x;
      vy[k] = dir.y;
      vz[k] = dir.z;
      if (h > cutoff) anyLand = true;
    }

    // Keep any face touching land, so coastlines get a full triangle of beach
    // rather than a ragged edge.
    if (!anyLand) continue;

    for (let k = 0; k < 3; k++) {
      const r = landRadius(vh[k], terrain.seaLevel);
      keptPositions.push(vx[k] * r, vy[k] * r, vz[k] * r);
      colorForLand(vh[k], terrain.seaLevel, color);
      keptColors.push(color.r, color.g, color.b);
    }
  }

  source.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(keptPositions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(keptColors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.88,
    metalness: 0.02,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'land';

  return {
    mesh,
    update(_dt: number, _env: WorldEnv): void {
      // Land is static. Lighting is handled by the day/night rig.
    },
  };
}
