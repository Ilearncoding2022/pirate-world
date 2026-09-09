import * as THREE from 'three';
import type { Terrain, Towns } from './types';
import type { WorldEnv } from './env';
import type { HeightMap } from './heightmap';
import { landRadius } from './land';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { LAYER_REFLECTED } from './layers';
import { SHORE_MARGIN, TOWN_SEED, mulberry32 } from './towns';

export interface CityLights {
  object: THREE.Object3D;
  update(dt: number, env: WorldEnv): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * Scatter seed, derived from the WORLD seed rather than shared with anything.
 *
 * The world is redrawn on every page load now (`worldgen.ts`), so a constant
 * here would light every world's towns in the same order -- which does not
 * show, but does mean the lamps are the one thing about the world that is not
 * a function of the seed, and the next person to go looking for why two worlds
 * look alike would have to find that out the hard way.
 *
 * Derived rather than passed straight through, on the same terms as before:
 * this scatter does not draw its centres from `towns.ts`'s stream, so it does
 * not see the same numbers in the same order, and sharing the integer would
 * only pretend otherwise. Golden-ratio xor, which is the cheapest thing that
 * decorrelates two streams from one integer.
 */
function scatterSeed(worldSeed: number): number {
  return (worldSeed ^ 0x9e3779b9) >>> 0;
}

/** Individual lights may creep a little further up the hillsides than a centre. */
const MEMBER_CEILING = 0.42;

/**
 * Lamps per town, before the ones that land in the sea or up a cliff are
 * dropped.
 *
 * Up by half from 14..67, and the reason is subtraction rather than ambition:
 * `docs/HARBOURS_PLAN.md`, decision 1, deleted the 440 lone outposts that used
 * to fill the space between settlements, and 36 towns replaced 40. Without a
 * compensating rise the night side of the globe simply had a third fewer
 * lights on it. Half is what puts roughly the same number of lamps back
 * WITHIN the towns, where every one of them is now something the player can
 * sail to, rather than spread over a coast that sells nothing.
 */
const MEMBER_MIN = 21;
const MEMBER_SPREAD = 81;

/**
 * Lift above the land surface, in world units.
 *
 * The land mesh's triangles are a couple of world units across, while the
 * height map this samples is finer than that, so a light placed at the exact
 * sampled radius can end up a fraction of a unit inside a face. Four tenths of
 * a percent of the globe radius clears that without the lights reading as
 * floating -- and it has to track the radius, because the triangles do.
 */
const LIGHT_LIFT = GLOBE_RADIUS * 0.004;

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
 * Where the towns are is `towns.ts`'s answer, not this module's: it needs the
 * same list the berths, the scope and the charging test work from. What is
 * left is the second stage, which is all this file ever really was -- each
 * centre grows an elongated blob of lamps along its own axis, which is what
 * makes a harbour read as a strip rather than a dot.
 *
 * There is nothing else. The thin scatter of lone outposts that used to fill
 * the space between settlements is gone (`docs/HARBOURS_PLAN.md`, decision 1):
 * every light on this globe now belongs to a harbour the player can moor at,
 * and a lit shore that sells nothing and charges nothing was a promise the
 * world could not keep. The towns carry half again as many lamps each to pay
 * for it -- see MEMBER_MIN.
 *
 * Two draw calls: the lights themselves, and one soft glow per settlement so
 * a city reads as a smudge of light from orbit rather than a cloud of pixels.
 *
 * @param seed The WORLD seed, not a scatter seed. Defaulted to TOWN_SEED so a
 *   headless caller that has no world of its own still gets a lit globe.
 */
export function createCityLights(
  terrain: Terrain,
  heightMap: HeightMap,
  towns: Towns,
  seed: number = TOWN_SEED,
): CityLights {
  const rng = mulberry32(scatterSeed(seed));
  const sea = terrain.seaLevel;

  const _probe = new THREE.Vector3();
  const _north = new THREE.Vector3();
  const _east = new THREE.Vector3();
  const _colour = new THREE.Color();

  /** Offset `dir` inside its own tangent plane by (n, e) radians, renormalised. */
  function offsetDirection(dir: THREE.Vector3, n: number, e: number, out: THREE.Vector3): THREE.Vector3 {
    tangentFrame(dir, _north, _east);
    return out.copy(dir).addScaledVector(_north, n).addScaledVector(_east, e).normalize();
  }

  /* ---- 1. Lights -------------------------------------------------- */

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

  for (const town of towns.all) {
    const centre = town.dir;
    // How techno this town is. Coastal trade posts run more neon.
    const neon = Math.min(1, rng() * 0.7 + town.coast * 0.5);

    // An elongated footprint, oriented arbitrarily in the tangent plane, so
    // towns read as strips along a shore instead of round blobs.
    const orient = rng() * Math.PI * 2;
    const ca = Math.cos(orient);
    const sa = Math.sin(orient);
    const major = 0.013 + rng() * 0.030;
    const minor = major * (0.32 + rng() * 0.5);
    const population = MEMBER_MIN + Math.floor(rng() * MEMBER_SPREAD);

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
    const gr = landRadius(town.height, sea) + LIGHT_LIFT;
    glowPositions.push(centre.x * gr, centre.y * gr, centre.z * gr);
    _colour.setHSL(0.085 + neon * 0.06, 0.72, 0.5, THREE.LinearSRGBColorSpace);
    glowColors.push(_colour.r, _colour.g, _colour.b);
    glowSizes.push((major / 0.02) * (0.55 + placed / 70));
    glowTwinkles.push(rng() * Math.PI * 2, 0.12 + rng() * 0.3);
  }

  /* ---- 2. Geometry and objects ------------------------------------ */

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
  // Docs/RENDER_PLAN.md Phase 1 Stream D: a town's glow appears in the
  // water's own reflection cube, same as its individual lamps below. Three
  // does not inherit layers to children, so both Points objects need this,
  // not just the group they sit in.
  glow.layers.enable(LAYER_REFLECTED);

  const lamps = buildLayer('city-lamps', positions, colors, sizes, twinkles, {
    sizeScale: 430,
    sizeRange: [1.6, 9],
    intensity: 0.72,
    falloff: [16, 90],
    weights: [0.5, 0.8],
    flicker: 0.34,
  });
  lamps.renderOrder = 5;
  lamps.layers.enable(LAYER_REFLECTED);

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
