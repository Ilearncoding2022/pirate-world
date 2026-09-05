import * as THREE from 'three';
import type { Terrain } from './types';
import type { WorldEnv } from './env';
import type { HeightMap } from './heightmap';
import { landRadius } from './land';
import { tangentFrame } from './geo';

export interface CityLights {
  object: THREE.Object3D;
  update(dt: number, env: WorldEnv): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Placement seed. Fixed, so the same world always gets the same towns. */
const SEED = 0x5eed17;

/** How many settlements to try to place, and how hard to try. */
const CLUSTER_TARGET = 76;
const CLUSTER_TRIES = 20000;
/** Minimum arc, in radians, between two settlement centres. */
const CLUSTER_MIN_ARC = 0.095;

/** Lone lights (lighthouses, outposts) sprinkled outside the settlements. */
const OUTPOST_TARGET = 440;
const OUTPOST_TRIES = 34000;

/** Habitable band, as height above sea level. */
const SHORE_MARGIN = 0.004;
/** Settlements found on lowland only; the interior highlands stay empty. */
const CENTRE_CEILING = 0.26;
/** Individual lights may creep a little further up the hillsides. */
const MEMBER_CEILING = 0.42;

/** Arc, in radians, of the ring used to test how coastal a spot is. */
const COAST_PROBE_ARC = 0.055;
const COAST_PROBE_SAMPLES = 12;

/**
 * Lift above the land surface, in world units.
 *
 * The land mesh is an icosphere at detail 96, so its triangles are about one
 * world unit across, while the height map this samples is finer than that.
 * A light placed at the exact sampled radius can therefore end up a fraction
 * of a unit inside a face. Half a percent of the globe radius clears that
 * without the lights reading as floating.
 */
const LIGHT_LIFT = 0.4;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic 32-bit PRNG. Same generator as terrain.ts. */
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

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

/*
 * Both layers share one program. The vertex stage decides whether a light is
 * allowed to be seen at all; the fragment stage only shapes the blob.
 *
 * Two independent gates, multiplied:
 *
 *   night   - from dot(surface normal, sun direction), so a light switches on
 *             through dusk and is off well before its ground is in daylight.
 *   visible - a self-cull against the planet. Points carry a single depth for
 *             the whole sprite and this scene runs a 0.1 -> 6000 depth range,
 *             so the depth test cannot be trusted to hide the far hemisphere.
 *             dot(n, normalize(cameraPosition - p)) is positive exactly when
 *             the segment from the camera to the light never dips below the
 *             light's own radius, i.e. when the globe cannot be in the way.
 *             Fading from a small positive threshold keeps the limb clean and
 *             errs on the side of culling.
 */

const VERTEX_SHADER = [
  'attribute vec3 aColor;',
  'attribute float aSize;',
  'attribute vec2 aTwinkle;',
  'uniform vec3 uSunDirection;',
  'uniform float uTime;',
  'uniform float uPixelRatio;',
  'uniform float uSizeScale;',
  'uniform vec2 uSizeRange;',
  'uniform float uFlicker;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'void main() {',
  '  vec3 centre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;',
  '  vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
  '  vec3 up = normalize(worldPos - centre);',
  '  // Night side only, ramped across civil twilight.',
  '  float sun = dot(up, normalize(uSunDirection));',
  '  float night = 1.0 - smoothstep(-0.22, 0.10, sun);',
  '  // Cull anything the planet itself is standing in front of.',
  '  vec3 toCamera = cameraPosition - worldPos;',
  '  float dist = max(length(toCamera), 1e-4);',
  '  float facing = dot(up, toCamera / dist);',
  '  float visible = smoothstep(0.010, 0.090, facing);',
  '  // Two detuned sines, so no two lights breathe together.',
  '  float tw = 0.5 * sin(uTime * aTwinkle.y + aTwinkle.x)',
  '           + 0.5 * sin(uTime * aTwinkle.y * 0.37 + aTwinkle.x * 2.1);',
  '  float flicker = 1.0 - uFlicker + uFlicker * (0.5 + 0.5 * tw);',
  '  vAlpha = night * visible * flicker;',
  '  vColor = aColor;',
  '  if (vAlpha <= 0.002) {',
  '    // Outside the clip volume: nothing is rasterised for this light.',
  '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
  '    gl_PointSize = 0.0;',
  '  } else {',
  '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '    gl_PointSize = clamp(aSize * uSizeScale / dist, uSizeRange.x, uSizeRange.y) * uPixelRatio;',
  '  }',
  '}',
].join('\n');

const FRAGMENT_SHADER = [
  'uniform float uIntensity;',
  'uniform vec2 uFalloff;',
  'uniform vec2 uWeights;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'void main() {',
  '  vec2 uv = gl_PointCoord - vec2(0.5);',
  '  float d2 = dot(uv, uv);',
  '  if (d2 > 0.25) discard;',
  '  float halo = exp(-d2 * uFalloff.x);',
  '  float core = exp(-d2 * uFalloff.y);',
  '  float a = clamp((halo * uWeights.x + core * uWeights.y) * vAlpha, 0.0, 1.0);',
  '  vec3 rgb = vColor * uIntensity * (0.70 + 0.60 * core);',
  '  gl_FragColor = vec4(rgb, a);',
  '}',
].join('\n');

interface LayerOptions {
  sizeScale: number;
  sizeRange: [number, number];
  intensity: number;
  falloff: [number, number];
  weights: [number, number];
  flicker: number;
}

function buildMaterial(pixelRatio: number, options: LayerOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(0, 0, 1) },
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uSizeScale: { value: options.sizeScale },
      uSizeRange: { value: new THREE.Vector2(options.sizeRange[0], options.sizeRange[1]) },
      uFlicker: { value: options.flicker },
      uIntensity: { value: options.intensity },
      uFalloff: { value: new THREE.Vector2(options.falloff[0], options.falloff[1]) },
      uWeights: { value: new THREE.Vector2(options.weights[0], options.weights[1]) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    // Kept on as a second line of defence behind the self-cull above: it also
    // hides lights sitting behind a nearby ridge on the *near* hemisphere.
    depthTest: true,
  });
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Night-side settlements.
 *
 * Placement is a two-stage seeded scatter. First, settlement centres are
 * rejection-sampled over the sphere and scored by how coastal and how low
 * their spot is, so ports along a shoreline are far more likely than towns in
 * the highlands, and no two centres land on top of each other. Then each
 * centre grows an elongated blob of lights along its own axis, which is what
 * makes a harbour read as a strip rather than a dot. A thin scatter of lone
 * outposts fills the space between.
 *
 * Two draw calls: the lights themselves, and one soft glow per settlement so
 * a city reads as a smudge of light from orbit rather than a cloud of pixels.
 */
export function createCityLights(terrain: Terrain, heightMap: HeightMap): CityLights {
  const rng = mulberry32(SEED);
  const sea = terrain.seaLevel;

  const _dir = new THREE.Vector3();
  const _probe = new THREE.Vector3();
  const _north = new THREE.Vector3();
  const _east = new THREE.Vector3();
  const _colour = new THREE.Color();

  /** Uniform point on the unit sphere. */
  function randomDirection(out: THREE.Vector3): THREE.Vector3 {
    const y = rng() * 2 - 1;
    const theta = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return out.set(Math.cos(theta) * r, y, Math.sin(theta) * r);
  }

  /** Offset `dir` inside its own tangent plane by (n, e) radians, renormalised. */
  function offsetDirection(dir: THREE.Vector3, n: number, e: number, out: THREE.Vector3): THREE.Vector3 {
    tangentFrame(dir, _north, _east);
    return out.copy(dir).addScaledVector(_north, n).addScaledVector(_east, e).normalize();
  }

  /** Fraction of a ring around `dir` that is open water. 1 = an islet, 0 = inland. */
  function oceanFraction(dir: THREE.Vector3): number {
    tangentFrame(dir, _north, _east);
    let ocean = 0;
    for (let i = 0; i < COAST_PROBE_SAMPLES; i++) {
      const a = (i / COAST_PROBE_SAMPLES) * Math.PI * 2;
      _probe
        .copy(dir)
        .addScaledVector(_north, Math.cos(a) * COAST_PROBE_ARC)
        .addScaledVector(_east, Math.sin(a) * COAST_PROBE_ARC)
        .normalize();
      if (heightMap.sample(_probe) <= sea) ocean++;
    }
    return ocean / COAST_PROBE_SAMPLES;
  }

  /* ---- 1. Settlement centres -------------------------------------- */

  const centres: THREE.Vector3[] = [];
  const centreHeights: number[] = [];
  const centreCoast: number[] = [];

  for (let attempt = 0; attempt < CLUSTER_TRIES && centres.length < CLUSTER_TARGET; attempt++) {
    randomDirection(_dir);
    const h = heightMap.sample(_dir);
    if (h <= sea + SHORE_MARGIN || h > sea + CENTRE_CEILING) continue;

    const coast = oceanFraction(_dir);
    const lowland = 1 - Math.min(1, (h - sea) / CENTRE_CEILING);
    // Ports first, then flat inland towns, and hardly ever anything else.
    if (rng() > (0.10 + 0.75 * coast) * (0.35 + 0.65 * lowland)) continue;

    let tooClose = false;
    const minDot = Math.cos(CLUSTER_MIN_ARC);
    for (let i = 0; i < centres.length; i++) {
      if (centres[i].dot(_dir) > minDot) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    centres.push(_dir.clone());
    centreHeights.push(h);
    centreCoast.push(coast);
  }

  /* ---- 2. Lights -------------------------------------------------- */

  const positions: number[] = [];
  const colors: number[] = [];
  const sizes: number[] = [];
  const twinkles: number[] = [];

  const glowPositions: number[] = [];
  const glowColors: number[] = [];
  const glowSizes: number[] = [];
  const glowTwinkles: number[] = [];

  /** Picks a lamp colour. Returns the size multiplier that goes with it. */
  function pickColour(neon: number, out: THREE.Color): number {
    const roll = rng();
    const neonChance = 0.05 + neon * 0.32;
    if (roll < neonChance) {
      if (rng() < 0.62) out.setHSL(0.51, 0.95, 0.62, THREE.LinearSRGBColorSpace);
      else out.setHSL(0.87, 0.88, 0.64, THREE.LinearSRGBColorSpace);
      return 1.3;
    }
    if (roll < neonChance + 0.17) {
      out.setHSL(0.11, 0.32, 0.82, THREE.LinearSRGBColorSpace);
      return 1.0;
    }
    out.setHSL(0.075 + rng() * 0.035, 0.9, 0.58, THREE.LinearSRGBColorSpace);
    return 1.0;
  }

  function pushLight(dir: THREE.Vector3, h: number, colour: THREE.Color, size: number): void {
    const r = landRadius(h, sea) + LIGHT_LIFT;
    positions.push(dir.x * r, dir.y * r, dir.z * r);
    colors.push(colour.r, colour.g, colour.b);
    sizes.push(size);
    twinkles.push(rng() * Math.PI * 2, 0.6 + rng() * 2.6);
  }

  for (let c = 0; c < centres.length; c++) {
    const centre = centres[c];
    const coast = centreCoast[c];
    // How techno this town is. Coastal trade posts run more neon.
    const neon = Math.min(1, rng() * 0.7 + coast * 0.5);

    // An elongated footprint, oriented arbitrarily in the tangent plane, so
    // towns read as strips along a shore instead of round blobs.
    const orient = rng() * Math.PI * 2;
    const ca = Math.cos(orient);
    const sa = Math.sin(orient);
    const major = 0.013 + rng() * 0.030;
    const minor = major * (0.32 + rng() * 0.5);
    const population = 14 + Math.floor(rng() * 54);

    let placed = 0;
    for (let i = 0; i < population; i++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const a = rng() * Math.PI * 2;
        // Square-rooted radius would spread evenly; a higher power piles the
        // lights into the middle, which is what a town centre looks like.
        const rr = Math.pow(rng(), 0.6);
        const lx = Math.cos(a) * rr * major;
        const ly = Math.sin(a) * rr * minor;
        offsetDirection(centre, lx * ca - ly * sa, lx * sa + ly * ca, _probe);

        const h = heightMap.sample(_probe);
        if (h <= sea + SHORE_MARGIN || h > sea + MEMBER_CEILING) continue;

        const boost = pickColour(neon, _colour);
        // A handful of tall beacons per town.
        const beacon = rng() < 0.03 ? 2.1 : 1.0;
        pushLight(_probe, h, _colour, (0.55 + rng() * 0.8) * boost * beacon);
        placed++;
        break;
      }
    }

    if (placed < 6) continue;

    // One soft dome of light over the settlement.
    const gr = landRadius(centreHeights[c], sea) + LIGHT_LIFT;
    glowPositions.push(centre.x * gr, centre.y * gr, centre.z * gr);
    _colour.setHSL(0.085 + neon * 0.06, 0.72, 0.5, THREE.LinearSRGBColorSpace);
    glowColors.push(_colour.r, _colour.g, _colour.b);
    glowSizes.push((major / 0.02) * (0.55 + placed / 70));
    glowTwinkles.push(rng() * Math.PI * 2, 0.12 + rng() * 0.3);
  }

  /* ---- 3. Lone outposts ------------------------------------------- */

  let outposts = 0;
  for (let attempt = 0; attempt < OUTPOST_TRIES && outposts < OUTPOST_TARGET; attempt++) {
    randomDirection(_dir);
    const h = heightMap.sample(_dir);
    if (h <= sea + SHORE_MARGIN || h > sea + MEMBER_CEILING) continue;
    // Strongly coastal: these are lighthouses and jetty lamps.
    if (rng() > 0.05 + 0.9 * oceanFraction(_dir)) continue;

    const boost = pickColour(0.12, _colour);
    pushLight(_dir, h, _colour, (0.45 + rng() * 0.5) * boost);
    outposts++;
  }

  /* ---- 4. Geometry and objects ------------------------------------ */

  const pixelRatio =
    typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;

  function buildLayer(
    name: string,
    pos: number[],
    col: number[],
    size: number[],
    twinkle: number[],
    options: LayerOptions,
  ): THREE.Points {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    geometry.setAttribute('aTwinkle', new THREE.Float32BufferAttribute(twinkle, 2));
    geometry.computeBoundingSphere();

    const points = new THREE.Points(geometry, buildMaterial(pixelRatio, options));
    points.name = name;
    return points;
  }

  const glow = buildLayer('city-glow', glowPositions, glowColors, glowSizes, glowTwinkles, {
    sizeScale: 3000,
    // Capped well under the 255px gl_PointSize limit some drivers enforce,
    // remembering that uPixelRatio multiplies this again on hi-dpi screens.
    sizeRange: [5, 90],
    intensity: 0.1,
    falloff: [4.5, 60],
    weights: [1.0, 0.0],
    flicker: 0.14,
  });
  glow.renderOrder = 4;

  const lamps = buildLayer('city-lamps', positions, colors, sizes, twinkles, {
    sizeScale: 430,
    sizeRange: [1.6, 9],
    intensity: 0.72,
    falloff: [16, 90],
    weights: [0.5, 0.8],
    flicker: 0.34,
  });
  lamps.renderOrder = 5;

  const object = new THREE.Group();
  object.name = 'city-lights';
  object.add(glow);
  object.add(lamps);

  const layers = [glow, lamps];

  return {
    object,
    update(_dt: number, env: WorldEnv): void {
      for (let i = 0; i < layers.length; i++) {
        const uniforms = (layers[i].material as THREE.ShaderMaterial).uniforms;
        uniforms.uSunDirection.value.copy(env.sunDirection);
        uniforms.uTime.value = env.elapsed;
      }
    },
  };
}
