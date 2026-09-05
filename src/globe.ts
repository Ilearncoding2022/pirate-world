import * as THREE from 'three';
import type { Terrain } from './types';
import { GLOBE_RADIUS } from './geo';

/** How far land is displaced outward at maximum height. */
const MAX_LAND_RELIEF = 5.0;
/** Height band above sea level treated as beach. */
const BEACH_BAND = 0.055;
/** Depth band below sea level treated as shallow shelf. */
const SHELF_BAND = 0.11;

const PALETTE = {
  abyss: new THREE.Color('#04121f'),
  deep: new THREE.Color('#0a3348'),
  ocean: new THREE.Color('#10607a'),
  shelf: new THREE.Color('#1fa8b0'),
  shallow: new THREE.Color('#48e0d0'),
  sand: new THREE.Color('#d9c48b'),
  grass: new THREE.Color('#4f7a4a'),
  forest: new THREE.Color('#2f5540'),
  rock: new THREE.Color('#5b5468'),
  peak: new THREE.Color('#b9b2c9'),
};

/** Piecewise color ramp for a terrain height. */
function colorForHeight(h: number, seaLevel: number, out: THREE.Color): THREE.Color {
  if (h <= seaLevel) {
    const depth = seaLevel - h;
    if (depth < SHELF_BAND) {
      const t = depth / SHELF_BAND;
      return out.copy(PALETTE.shallow).lerp(PALETTE.shelf, t);
    }
    const t = Math.min(1, (depth - SHELF_BAND) / 0.55);
    if (t < 0.5) return out.copy(PALETTE.shelf).lerp(PALETTE.ocean, t / 0.5);
    if (t < 0.85) return out.copy(PALETTE.ocean).lerp(PALETTE.deep, (t - 0.5) / 0.35);
    return out.copy(PALETTE.deep).lerp(PALETTE.abyss, (t - 0.85) / 0.15);
  }

  const a = h - seaLevel;
  if (a < BEACH_BAND) {
    return out.copy(PALETTE.sand).lerp(PALETTE.grass, a / BEACH_BAND);
  }
  const t = Math.min(1, (a - BEACH_BAND) / 0.5);
  if (t < 0.4) return out.copy(PALETTE.grass).lerp(PALETTE.forest, t / 0.4);
  if (t < 0.75) return out.copy(PALETTE.forest).lerp(PALETTE.rock, (t - 0.4) / 0.35);
  return out.copy(PALETTE.rock).lerp(PALETTE.peak, (t - 0.75) / 0.25);
}

function buildSurface(terrain: Terrain): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(GLOBE_RADIUS, 96);
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  const colors = new Float32Array(count * 3);

  const dir = new THREE.Vector3();
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    const h = terrain.heightAt(dir);

    let radius = GLOBE_RADIUS;
    if (h > terrain.seaLevel) {
      const a = Math.min(1, (h - terrain.seaLevel) / 0.6);
      // Ease so coastlines stay near sea level while interiors rise.
      radius += MAX_LAND_RELIEF * a * a;
    }
    pos.setXYZ(i, dir.x * radius, dir.y * radius, dir.z * radius);

    colorForHeight(h, terrain.seaLevel, color);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  pos.needsUpdate = true;
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.82,
    metalness: 0.06,
    emissive: new THREE.Color('#062430'),
    emissiveIntensity: 0.22,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'globe-surface';
  return mesh;
}

/** Latitude and longitude grid drawn just above the surface. */
function buildGrid(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'globe-grid';
  const r = GLOBE_RADIUS + 0.45;
  const STEP = 15;
  const SEG = 180;

  const faint: number[] = [];
  const bright: number[] = [];

  // Parallels: constant latitude.
  for (let lat = -75; lat <= 75; lat += STEP) {
    const arr = lat === 0 ? bright : faint;
    const phi = (lat * Math.PI) / 180;
    const y = Math.sin(phi) * r;
    const rad = Math.cos(phi) * r;
    for (let i = 0; i < SEG; i++) {
      const t0 = (i / SEG) * Math.PI * 2;
      const t1 = ((i + 1) / SEG) * Math.PI * 2;
      arr.push(Math.sin(t0) * rad, y, Math.cos(t0) * rad);
      arr.push(Math.sin(t1) * rad, y, Math.cos(t1) * rad);
    }
  }

  // Meridians: constant longitude.
  for (let lon = 0; lon < 360; lon += STEP) {
    const arr = lon === 0 || lon === 180 ? bright : faint;
    const th = (lon * Math.PI) / 180;
    for (let i = 0; i < SEG; i++) {
      const a0 = -Math.PI / 2 + (i / SEG) * Math.PI;
      const a1 = -Math.PI / 2 + ((i + 1) / SEG) * Math.PI;
      arr.push(Math.cos(a0) * Math.sin(th) * r, Math.sin(a0) * r, Math.cos(a0) * Math.cos(th) * r);
      arr.push(Math.cos(a1) * Math.sin(th) * r, Math.sin(a1) * r, Math.cos(a1) * Math.cos(th) * r);
    }
  }

  const make = (verts: number[], opacity: number, colorHex: string): THREE.LineSegments => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const m = new THREE.LineBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return new THREE.LineSegments(g, m);
  };

  group.add(make(faint, 0.16, '#3fe0ff'));
  group.add(make(bright, 0.42, '#7ff0ff'));
  return group;
}

/** Fresnel rim glow shell around the planet. */
function buildAtmosphere(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS * 1.055, 96, 64);

  const vertexShader = [
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'void main() {',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  vNormalV = normalize(normalMatrix * normal);',
    '  vViewDir = normalize(-mvPosition.xyz);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '}',
  ].join('\n');

  const fragmentShader = [
    'uniform vec3 uColor;',
    'uniform float uIntensity;',
    'uniform float uPower;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'void main() {',
    '  // BackSide normals point inward, so use the absolute dot to measure the rim.',
    '  float rim = 1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir)));',
    '  float glow = pow(clamp(rim, 0.0, 1.0), uPower) * uIntensity;',
    '  gl_FragColor = vec4(uColor * glow, glow);',
    '}',
  ].join('\n');

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#4fbaff') },
      uIntensity: { value: 1.15 },
      uPower: { value: 3.0 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atmosphere';
  return mesh;
}

function buildStars(): THREE.Points {
  const COUNT = 3000;
  const RADIUS = 2000;
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);
  const c = new THREE.Color();

  for (let i = 0; i < COUNT; i++) {
    // Uniform distribution on a sphere.
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    positions[i * 3] = Math.cos(th) * s * RADIUS;
    positions[i * 3 + 1] = u * RADIUS;
    positions[i * 3 + 2] = Math.sin(th) * s * RADIUS;

    const warm = Math.random();
    c.setHSL(warm < 0.8 ? 0.58 : 0.09, 0.35, 0.6 + Math.random() * 0.4);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'starfield';
  return points;
}

export function createGlobe(terrain: Terrain): { group: THREE.Group; update(dt: number): void } {
  const group = new THREE.Group();
  group.name = 'world';

  group.add(buildSurface(terrain));
  group.add(buildGrid());
  group.add(buildAtmosphere());

  const starGroup = new THREE.Group();
  starGroup.name = 'starfield-pivot';
  starGroup.add(buildStars());
  group.add(starGroup);

  const hemi = new THREE.HemisphereLight(0xbfe4ff, 0x101a24, 0.85);
  hemi.name = 'hemi-light';
  group.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d6, 1.5);
  sun.position.set(300, 200, 400);
  sun.name = 'sun';
  group.add(sun);

  const fill = new THREE.DirectionalLight(0x5fa8ff, 0.35);
  fill.position.set(-400, -150, -250);
  fill.name = 'fill-light';
  group.add(fill);

  return {
    group,
    update(dt: number): void {
      starGroup.rotation.y += dt * 0.004;
    },
  };
}
