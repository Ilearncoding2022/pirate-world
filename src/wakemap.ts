import * as THREE from 'three';
import type { ShipState } from './types';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { MODEL_SCALE, MAX_FORWARD } from './ship';
import { NOISE_GLSL } from './noiseglsl';
import { LAYER_DEFAULT } from './layers';

/**
 * wakemap.ts -- the ship's wake as an input to the water shader.
 *
 * Renders a small top-down data texture each frame -- foam density, a packed
 * surface-height offset, and foam age -- and hands it to `waterwake.ts`'s
 * `WaterPlugin`, which samples it back into the water fragment shader. See
 * `docs/RENDER_PLAN.md`, Phase 1 stream A, for the brief this implements.
 *
 * --- Channel layout (RGBA8, linear filtered, cleared to (0, 0.5, 0, 0)) ---
 *   R  foam density, 0..1
 *   G  surface height offset, packed as 0.5 + h * WAKE_HEIGHT_SCALE
 *   B  foam age, 0..1 (0 = just laid, near the ship; 1 = about to dissolve)
 *   A  unused
 *
 * This is DATA, not colour. Nothing here is sRGB-encoded on write, and
 * `waterwake.ts` does not decode it on read -- see the comment beside
 * `target.texture.colorSpace` below and the matching one at the sample site.
 *
 * --- The write/read frame ------------------------------------------------
 * `computeWakeFrame` is a pure function of the ship's current state: no
 * caching, nothing stored across frames. `render()` (called from
 * `wake.update`, every frame, before `postFx.render` draws the water) calls
 * it to place the orthographic camera; `waterwake.ts`'s plugin `update`
 * calls the SAME function independently to set the uniforms the fragment
 * shader projects world position through. Because both calls are pure
 * functions of the one ship state that is fixed for the whole frame, they
 * agree bit-for-bit regardless of which runs first in the frame loop --
 * see the render-order hazard in the plan for why that matters here.
 * `tangentFrame` is degenerate at the poles; computing it fresh in both
 * places rather than storing it anywhere is what makes that degeneracy
 * cancel instead of desyncing the write from the read.
 */

/* ------------------------------------------------------------------ */
/* Tuning -- every constant is ship-scale (docs/ARCHITECTURE.md "World  */
/* scale"): the wake trails a ship of fixed size, not the globe.        */
/* ------------------------------------------------------------------ */

/** Map footprint: a square this many world units on a side. */
export const WAKE_MAP_EXTENT = 48;

/**
 * Offset of the map centre from the ship along `ship.forward`, world units.
 * Negative = astern, so most of the map trails the hull rather than leading it.
 */
const WAKE_MAP_AHEAD = -12;

/** Height of the orthographic camera above the water along `ship.up`, world units. */
const WAKE_CAM_HEIGHT = 30;

/**
 * Camera near/far, world units. Bracket WAKE_CAM_HEIGHT with room to spare:
 * the ribbon sits on the true sphere (WAKE_RADIUS, in wake.ts) while this
 * map's other three contributors sit on the flat tangent plane through the
 * ship, so the ribbon's own curvature sag over the map's extent (~1.4 units
 * at the far corners) has to fit inside the frustum too.
 */
const WAKE_CAM_NEAR = 1;
const WAKE_CAM_FAR = 50;

/**
 * How a signed world-unit height is packed into the map's green channel:
 * G = 0.5 + h * WAKE_HEIGHT_SCALE. Dimensionless. Chosen so the tallest
 * contributor -- a Kelvin crest riding the bow hump, KELVIN_AMPLITUDE +
 * WAKE_BOW_HEIGHT =~ 0.52 world units -- stays inside [0, 1] with headroom;
 * `waterwake.ts` uses the same constant to decode height back out.
 */
export const WAKE_HEIGHT_SCALE = 0.9;

/**
 * Wavelength of the world-position-keyed "breakup" noise, world units. This
 * is the fix for the sine-banding bug the plan calls out: a function of
 * world position sits still in the water, unlike the old `band`/`fleck`
 * sine of distance sailed, which read as a barcode. `WAKE_BREAKUP_GLSL`
 * below is pasted verbatim into both the ribbon-map material's fragment
 * shader (this file) and `waterwake.ts`'s `foam` hook, so the two can never
 * disagree about what "breakup" means.
 */
const WAKE_FOAM_WAVELENGTH = 3.2;

/*
 * The next three mirror wake.ts's SURFACE_LIFT/WAKE_RADIUS, HALF_WIDTH_0 and
 * SPREAD_RATE exactly, so the map-only ribbon material traces the identical
 * footprint the on-screen ribbon does even though its fragment shader is
 * different. Duplicated rather than imported: wake.ts already imports
 * `createWakeMap` from this file, and importing these back would make the
 * two modules a cycle. Keep them in sync by hand if wake.ts's values change.
 */
const RIBBON_MAP_RADIUS = GLOBE_RADIUS + 0.1;
const RIBBON_MAP_HALF_WIDTH = 1.15 * MODEL_SCALE;
const RIBBON_MAP_SPREAD = 1.95;
/** Seconds from a rib being laid to it having completely dissolved; mirrors wake.ts's WAKE_LIFE. */
const RIBBON_MAP_LIFE = 4.0;

/**
 * Hull-relative anchors for the bow hump and stern trough, world units.
 * Mirror wake.ts's BOW_FORWARD/STERN_BACK (same duplication reasoning as
 * above): authored against the hull's own half-length and carried by
 * MODEL_SCALE, so a hull rescale moves the hump and the trough with it.
 */
const HULL_BOW_ANCHOR = 2.5 * MODEL_SCALE;
const HULL_STERN_ANCHOR = 2.3 * MODEL_SCALE;

/** Kelvin pattern transverse wavelength at MAX_FORWARD, world units; runs with speed^2 below. */
const KELVIN_WAVELENGTH = 2.6;
/** Floor on that wavelength so `k` does not blow up as speed -> 0; the whole term is also gated by speedFrac^2. */
const KELVIN_WAVELENGTH_FLOOR = 0.5;
/** tan(19.47 deg): the classic Kelvin-wake half-angle, dimensionless. */
const KELVIN_ARM_SLOPE = 0.3535;
/** Width of the divergent arm's gaussian envelope, world units. */
const KELVIN_ARM_WIDTH = 0.9;
/** Width of the transverse (following) wave train's envelope, world units. */
const KELVIN_TRANSVERSE_WIDTH = 6.0;
/** Curvature of the divergent wavefront's phase (the `side^2` term), empirical. */
const KELVIN_CURVE = 0.05;
/** Peak Kelvin ripple height at full speed, world units, before WAKE_HEIGHT_SCALE. */
const KELVIN_AMPLITUDE = 0.22;
/** Where the Kelvin pattern starts, and finishes, fading toward the map's edge, world units astern. */
const KELVIN_EDGE_FADE_START = WAKE_MAP_EXTENT * 0.32;
const KELVIN_EDGE_FADE_END = WAKE_MAP_EXTENT * 0.5;

/** Bow hump peak height / stern trough peak depth at full speed, world units. */
const WAKE_BOW_HEIGHT = 0.3;
const WAKE_STERN_DEPTH = 0.4;
/** Gaussian widths of the two humps along the ship's own axis, world units. */
const HUMP_WIDTH_BOW = 0.9;
const HUMP_WIDTH_STERN = 1.1;
/** Lateral falloff of both humps away from the centreline, world units. */
const HUMP_HALF_BEAM = 1.3;

/** Length of the stern churn patch astern of the transom, world units. */
const STERN_CHURN_LENGTH = 2.5;
/** Lateral half-width of the churn patch, world units. */
const STERN_CHURN_WIDTH = 1.2;
/** Spatial frequency of the churn's scrolling noise, world units^-1. */
const STERN_CHURN_FREQ = 1 / 0.7;
/** How fast the churn noise scrolls, in noise-phase units per second (time-based, not a world drift -- the churn sits at the transom, not out in the water, so it need not stay world-locked the way the ribbon foam does). */
const STERN_CHURN_SCROLL = 2.0;

/** Render-target clear value: zero foam, neutral (0.5) height, zero age. Data, not a colour. */
const WAKE_CLEAR_COLOR = new THREE.Color(0, 0.5, 0);
const WAKE_CLEAR_ALPHA = 0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ------------------------------------------------------------------ */
/* The write/read frame: a pure function of ship state, computed fresh   */
/* wherever it is needed. Nothing here is cached across frames.          */
/* ------------------------------------------------------------------ */

export interface WakeFrame {
  /** World position of the map's centre. */
  readonly centre: THREE.Vector3;
  /** Tangent-frame east at the ship, world space. */
  readonly east: THREE.Vector3;
  /** Tangent-frame north at the ship, world space. */
  readonly north: THREE.Vector3;
  /** The ship's own up (== position, unit), world space. */
  readonly up: THREE.Vector3;
}

/** A fresh, independent scratch frame. Callers own the one they create; nothing here is shared. */
export function createWakeFrame(): WakeFrame {
  return {
    centre: new THREE.Vector3(),
    east: new THREE.Vector3(),
    north: new THREE.Vector3(),
    up: new THREE.Vector3(),
  };
}

/**
 * Fills `out` from the ship's current state. Pure and non-allocating: call
 * it fresh every time the frame is needed rather than storing the result,
 * so the write side (this file's `render`) and the read side
 * (`waterwake.ts`'s plugin `update`) always agree, in whatever order the
 * frame loop happens to call them.
 */
export function computeWakeFrame(ship: ShipState, out: WakeFrame): void {
  out.up.copy(ship.up);
  tangentFrame(out.up, out.north, out.east);
  out.centre.copy(ship.position).multiplyScalar(GLOBE_RADIUS).addScaledVector(ship.forward, WAKE_MAP_AHEAD);
}

/**
 * World position -> map uv, as a pure function. This is the TS side of the
 * exact formula `waterwake.ts` embeds in GLSL (`wakeUV`); `tests/unit/wakemap.test.ts`
 * proves the two agree and that the map centre reads back as uv (0.5, 0.5).
 */
export function projectToMapUV(
  worldPos: THREE.Vector3,
  centre: THREE.Vector3,
  east: THREE.Vector3,
  north: THREE.Vector3,
  extent: number,
): { u: number; v: number } {
  const dx = worldPos.x - centre.x;
  const dy = worldPos.y - centre.y;
  const dz = worldPos.z - centre.z;
  const localX = dx * east.x + dy * east.y + dz * east.z;
  const localY = dx * north.x + dy * north.y + dz * north.z;
  return { u: 0.5 + localX / extent, v: 0.5 + localY / extent };
}

/**
 * The world-position-keyed breakup noise, shared verbatim by the ribbon-map
 * material below and `waterwake.ts`'s `foam` hook. Pasting the identical
 * string into both shaders is what guarantees they agree -- see the
 * WAKE_FOAM_WAVELENGTH comment above.
 */
export const WAKE_BREAKUP_GLSL: string[] = [
  `const float WAKE_FOAM_FREQ = ${(1 / WAKE_FOAM_WAVELENGTH).toFixed(6)};`,
  'float wakeBreakup(vec3 worldPos) {',
  '  float n1 = snoise(worldPos * WAKE_FOAM_FREQ);',
  '  float n2 = snoise(worldPos * WAKE_FOAM_FREQ * 2.6 + vec3(11.3, -4.7, 8.1));',
  '  return 0.65 + 0.35 * (0.6 * n1 + 0.4 * n2);',
  '}',
];

/* ------------------------------------------------------------------ */
/* The ribbon-map material: the on-screen ribbon's geometry, re-shaded   */
/* for the data buffer instead of the screen.                           */
/* ------------------------------------------------------------------ */

function buildRibbonMapMaterial(): THREE.ShaderMaterial {
  const vertexShader = [
    'attribute vec3 aRight;',
    'attribute vec4 aParams;', // x: side, y: birth, z: speedFrac, w: distance sailed (unused here)
    'attribute float aBreak;',
    'uniform float uTime;',
    `const float RADIUS = ${RIBBON_MAP_RADIUS.toFixed(6)};`,
    `const float HALF_WIDTH = ${RIBBON_MAP_HALF_WIDTH.toFixed(6)};`,
    `const float SPREAD = ${RIBBON_MAP_SPREAD.toFixed(6)};`,
    `const float LIFE = ${RIBBON_MAP_LIFE.toFixed(6)};`,
    'varying float vSide;',
    'varying float vAge;',
    'varying float vBreak;',
    'varying vec3 vWorldPos;',
    'void main() {',
    '  float side = aParams.x;',
    '  float age = max(0.0, uTime - aParams.y);',
    '  float speed = aParams.z;',
    '  float hw = (HALF_WIDTH + SPREAD * age) * (0.42 + 0.58 * speed);',
    '  vec3 p = normalize(position + aRight * (side * hw)) * RADIUS;',
    '  vSide = side;',
    '  vAge = clamp(age / LIFE, 0.0, 1.0);',
    '  vBreak = aBreak;',
    '  vec4 wp = modelMatrix * vec4(p, 1.0);',
    '  vWorldPos = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}',
  ].join('\n');

  const fragmentShader = [
    'varying float vSide;',
    'varying float vAge;',
    'varying float vBreak;',
    'varying vec3 vWorldPos;',
    NOISE_GLSL,
    ...WAKE_BREAKUP_GLSL,
    'void main() {',
    '  if (vBreak > 0.001) discard;',
    '  float s = abs(vSide);',
    '  float fade = pow(1.0 - vAge, 1.2);',
    '  float spread = smoothstep(0.02, 0.5, vAge);',
    '  // Same churned-core / arm shape as the on-screen ribbon (wake.ts) --',
    '  // only the texture differs: world-keyed noise instead of a sine of',
    '  // distance sailed, so this copy sits still in the water.',
    '  float core = 1.0 - smoothstep(0.0, 0.9, s);',
    '  float arm = smoothstep(0.45, 0.88, s) * (1.0 - smoothstep(0.88, 1.0, s));',
    '  float shape = core * mix(1.0, 0.30, spread) + arm * (0.25 + 1.05 * spread);',
    '  shape += (1.0 - smoothstep(0.0, 0.75, s)) * exp(-vAge * 9.0) * 0.85;',
    '  shape *= wakeBreakup(vWorldPos);',
    '  float density = clamp(shape * fade, 0.0, 1.0);',
    '  if (density < 0.004) discard;',
    '  // R: foam density. G: no height contribution from the ribbon (the',
    '  // shape material below owns G). B: age, for the plugin\'s cold-glow',
    '  // gate. Additive blend onto the (0, 0.5, 0, 0) clear -- see the',
    '  // channel-layout comment at the top of this file. Raw values: this is',
    '  // data, not colour, so no sRGB encode.',
    '  gl_FragColor = vec4(density, 0.0, vAge, 0.0);',
    '}',
  ].join('\n');

  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    side: THREE.DoubleSide,
  });
}

/* ------------------------------------------------------------------ */
/* The shape material: Kelvin pattern + bow hump/stern trough + stern    */
/* churn, all as functions of the ship-relative (dist, side) of a single */
/* quad covering the whole map -- see the class comment for why these    */
/* three ride together instead of three separate draws.                 */
/* ------------------------------------------------------------------ */

function buildShapeMaterial(): THREE.ShaderMaterial {
  const vertexShader = [
    'uniform vec3 uCentre;',
    'uniform vec3 uEast;',
    'uniform vec3 uNorth;',
    `const float EXTENT = ${WAKE_MAP_EXTENT.toFixed(4)};`,
    'varying vec3 vWorldPos;',
    'void main() {',
    '  // `position.xy` is PlaneGeometry(1, 1)\'s own [-0.5, 0.5] parametrisation.',
    '  vec3 worldPos = uCentre + uEast * (position.x * EXTENT) + uNorth * (position.y * EXTENT);',
    '  vWorldPos = worldPos;',
    '  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);',
    '}',
  ].join('\n');

  const fragmentShader = [
    'uniform vec3 uShipPos;',
    'uniform vec3 uShipForward;',
    'uniform vec3 uShipRight;',
    'uniform float uSpeedFrac;',
    'uniform float uTime;',
    'varying vec3 vWorldPos;',
    NOISE_GLSL,
    `const float KELVIN_WAVELENGTH = ${KELVIN_WAVELENGTH.toFixed(4)};`,
    `const float KELVIN_WAVELENGTH_FLOOR = ${KELVIN_WAVELENGTH_FLOOR.toFixed(4)};`,
    `const float KELVIN_ARM_SLOPE = ${KELVIN_ARM_SLOPE.toFixed(6)};`,
    `const float KELVIN_ARM_WIDTH = ${KELVIN_ARM_WIDTH.toFixed(4)};`,
    `const float KELVIN_TRANSVERSE_WIDTH = ${KELVIN_TRANSVERSE_WIDTH.toFixed(4)};`,
    `const float KELVIN_CURVE = ${KELVIN_CURVE.toFixed(6)};`,
    `const float KELVIN_AMPLITUDE = ${KELVIN_AMPLITUDE.toFixed(4)};`,
    `const float KELVIN_EDGE_FADE_START = ${KELVIN_EDGE_FADE_START.toFixed(4)};`,
    `const float KELVIN_EDGE_FADE_END = ${KELVIN_EDGE_FADE_END.toFixed(4)};`,
    `const float HULL_BOW_ANCHOR = ${HULL_BOW_ANCHOR.toFixed(6)};`,
    `const float HULL_STERN_ANCHOR = ${HULL_STERN_ANCHOR.toFixed(6)};`,
    `const float WAKE_BOW_HEIGHT = ${WAKE_BOW_HEIGHT.toFixed(4)};`,
    `const float WAKE_STERN_DEPTH = ${WAKE_STERN_DEPTH.toFixed(4)};`,
    `const float HUMP_WIDTH_BOW = ${HUMP_WIDTH_BOW.toFixed(4)};`,
    `const float HUMP_WIDTH_STERN = ${HUMP_WIDTH_STERN.toFixed(4)};`,
    `const float HUMP_HALF_BEAM = ${HUMP_HALF_BEAM.toFixed(4)};`,
    `const float WAKE_HEIGHT_SCALE = ${WAKE_HEIGHT_SCALE.toFixed(4)};`,
    `const float STERN_CHURN_LENGTH = ${STERN_CHURN_LENGTH.toFixed(4)};`,
    `const float STERN_CHURN_WIDTH = ${STERN_CHURN_WIDTH.toFixed(4)};`,
    `const float STERN_CHURN_FREQ = ${STERN_CHURN_FREQ.toFixed(6)};`,
    `const float STERN_CHURN_SCROLL = ${STERN_CHURN_SCROLL.toFixed(4)};`,
    'void main() {',
    '  vec3 rel = vWorldPos - uShipPos;',
    '  float dist = -dot(rel, uShipForward); // positive = astern',
    '  float side = dot(rel, uShipRight);',
    '  float speedFrac = clamp(uSpeedFrac, 0.0, 1.0);',
    '',
    '  // ---- Kelvin pattern: astern only. Classic 19.47deg divergent arms',
    '  // plus a transverse train on the centreline; wavelength runs with',
    '  // speed^2, as the physics (and the plan) says. No persistent history --',
    '  // this is a snapshot of the steady pattern a ship at this speed would',
    '  // leave, so "fading with age" is approximated by fading with distance',
    '  // astern instead of a stored birth time.',
    '  float distAstern = max(dist, 0.0);',
    '  float wavelength = mix(KELVIN_WAVELENGTH_FLOOR, KELVIN_WAVELENGTH, speedFrac * speedFrac);',
    '  float k = 6.283185307 / max(wavelength, 0.001);',
    '  float armOffset = distAstern * KELVIN_ARM_SLOPE;',
    '  float phase = k * (distAstern - KELVIN_CURVE * side * side);',
    '  float divergent = exp(-pow((abs(side) - armOffset) / KELVIN_ARM_WIDTH, 2.0)) * cos(phase);',
    '  float transverse = exp(-pow(side / KELVIN_TRANSVERSE_WIDTH, 2.0)) * cos(k * distAstern);',
    '  float edgeFade = 1.0 - smoothstep(KELVIN_EDGE_FADE_START, KELVIN_EDGE_FADE_END, distAstern);',
    '  float kelvin = (divergent * 0.7 + transverse * 0.3) * KELVIN_AMPLITUDE * speedFrac * speedFrac * edgeFade;',
    '',
    '  // ---- Bow hump / stern trough: two gaussians straddling the hull,',
    '  // pinned to its own half-length so they track a hull rescale.',
    '  float lateral = exp(-pow(side / HUMP_HALF_BEAM, 2.0));',
    '  float bowTerm = WAKE_BOW_HEIGHT * exp(-pow((dist + HULL_BOW_ANCHOR) / HUMP_WIDTH_BOW, 2.0));',
    '  float sternTerm = -WAKE_STERN_DEPTH * exp(-pow((dist - HULL_STERN_ANCHOR) / HUMP_WIDTH_STERN, 2.0));',
    '  float hump = (bowTerm + sternTerm) * lateral * speedFrac;',
    '',
    '  float heightWorld = kelvin + hump;',
    '  float gDelta = clamp(heightWorld * WAKE_HEIGHT_SCALE, -0.48, 0.48);',
    '',
    '  // ---- Stern churn: a short, bright, scrolling patch right at the',
    '  // transom. Time-based, not world-keyed -- it sits at the transom, not',
    '  // out in the water the ship has already passed, so it has no sine-',
    '  // banding problem to fix.',
    '  float sternLocal = dist - HULL_STERN_ANCHOR;',
    '  float inChurn = step(0.0, sternLocal) * (1.0 - smoothstep(0.0, STERN_CHURN_LENGTH, sternLocal));',
    '  vec3 churnP = vec3(side, sternLocal, uTime * STERN_CHURN_SCROLL) * STERN_CHURN_FREQ;',
    '  float cn1 = snoise(churnP);',
    '  float cn2 = snoise(churnP * 2.3 + 5.0);',
    '  float churnNoise = 0.5 + 0.5 * (0.6 * cn1 + 0.4 * cn2);',
    '  float churn = inChurn * churnNoise * exp(-pow(side / STERN_CHURN_WIDTH, 2.0)) * speedFrac;',
    '',
    '  // R: churn foam only. G: Kelvin + hump/trough height delta (additive',
    '  // onto the ribbon material\'s own draw -- see the clear-colour comment',
    '  // above). B, A: unused here. Raw data, no sRGB encode.',
    '  gl_FragColor = vec4(clamp(churn, 0.0, 1.0), gDelta, 0.0, 0.0);',
    '}',
  ].join('\n');

  return new THREE.ShaderMaterial({
    uniforms: {
      uCentre: { value: new THREE.Vector3() },
      uEast: { value: new THREE.Vector3() },
      uNorth: { value: new THREE.Vector3() },
      uShipPos: { value: new THREE.Vector3() },
      uShipForward: { value: new THREE.Vector3() },
      uShipRight: { value: new THREE.Vector3() },
      uSpeedFrac: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
}

/* ------------------------------------------------------------------ */
/* createWakeMap                                                        */
/* ------------------------------------------------------------------ */

export interface WakeMap {
  /** Stable across frames; only its contents change. Never sRGB-decode this -- see the class comment. */
  readonly texture: THREE.Texture;
  readonly extent: number;
  /**
   * Fills the map for this frame: places the orthographic camera from the
   * ship's current state, updates the four contributors' uniforms, and
   * renders. Always restores whatever render target was active -- see the
   * render-order hazard in the plan.
   */
  render(renderer: THREE.WebGLRenderer, now: number, ship: ShipState): void;
}

/**
 * `ribbonGeometry` is `wake.ts`'s own live ring-buffer `BufferGeometry`,
 * shared (not cloned) so this material always draws exactly what the
 * on-screen ribbon currently holds -- same vertices, same `drawRange`,
 * updated once by `wake.ts` and read here, never duplicated.
 */
export function createWakeMap(wakeMapSize: number, ribbonGeometry: THREE.BufferGeometry): WakeMap {
  const target = new THREE.WebGLRenderTarget(wakeMapSize, wakeMapSize, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  target.texture.name = 'wakemap';
  // Data, not colour -- see the channel-layout comment at the top of this
  // file. Never let this pick up an implicit sRGB conversion on either end.
  target.texture.colorSpace = THREE.NoColorSpace;

  const scene = new THREE.Scene();

  const camera = new THREE.OrthographicCamera(
    -WAKE_MAP_EXTENT / 2,
    WAKE_MAP_EXTENT / 2,
    WAKE_MAP_EXTENT / 2,
    -WAKE_MAP_EXTENT / 2,
    WAKE_CAM_NEAR,
    WAKE_CAM_FAR,
  );

  const ribbonMat = buildRibbonMapMaterial();
  const ribbonMesh = new THREE.Mesh(ribbonGeometry, ribbonMat);
  ribbonMesh.name = 'wakemap-ribbon';
  // The geometry's bounding sphere is stale by construction (wake.ts rewrites
  // vertices in place); frustum culling against it would drop live ribs.
  ribbonMesh.frustumCulled = false;
  // Cleared of LAYER_REFLECTED explicitly, per the plan -- belt and braces:
  // this mesh only ever renders into this file's own private `scene`, never
  // the main one, so Stream D's reflection cube can never see it regardless.
  ribbonMesh.layers.set(LAYER_DEFAULT);
  scene.add(ribbonMesh);

  const shapeGeo = new THREE.PlaneGeometry(1, 1);
  const shapeMat = buildShapeMaterial();
  const shapeMesh = new THREE.Mesh(shapeGeo, shapeMat);
  shapeMesh.name = 'wakemap-shape';
  shapeMesh.frustumCulled = false;
  shapeMesh.layers.set(LAYER_DEFAULT);
  scene.add(shapeMesh);

  const frame = createWakeFrame();
  const scratchClearColor = new THREE.Color();
  const scratchShipRight = new THREE.Vector3();
  const scratchShipPos = new THREE.Vector3();

  function render(renderer: THREE.WebGLRenderer, now: number, ship: ShipState): void {
    computeWakeFrame(ship, frame);

    camera.up.copy(frame.north);
    camera.position.copy(frame.centre).addScaledVector(frame.up, WAKE_CAM_HEIGHT);
    camera.lookAt(frame.centre);
    camera.updateMatrixWorld(true);

    // Starboard = forward x up, the same convention wake.ts's on-screen ribbon uses.
    scratchShipRight.crossVectors(ship.forward, ship.up);
    if (scratchShipRight.lengthSq() < 1e-12) scratchShipRight.set(1, 0, 0);
    scratchShipRight.normalize();

    const speedFrac = clamp(Math.abs(ship.speed) / MAX_FORWARD, 0, 1);

    ribbonMat.uniforms.uTime.value = now;

    const shapeU = shapeMat.uniforms;
    (shapeU.uCentre.value as THREE.Vector3).copy(frame.centre);
    (shapeU.uEast.value as THREE.Vector3).copy(frame.east);
    (shapeU.uNorth.value as THREE.Vector3).copy(frame.north);
    scratchShipPos.copy(ship.position).multiplyScalar(GLOBE_RADIUS);
    (shapeU.uShipPos.value as THREE.Vector3).copy(scratchShipPos);
    (shapeU.uShipForward.value as THREE.Vector3).copy(ship.forward);
    (shapeU.uShipRight.value as THREE.Vector3).copy(scratchShipRight);
    shapeU.uSpeedFrac.value = speedFrac;
    shapeU.uTime.value = now;

    // Always restore the renderer's previous target and clear colour -- a
    // frame that forgets this renders the whole game into the wake map and
    // shows the player a black screen (see the render-order hazard).
    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(scratchClearColor);

    renderer.setRenderTarget(target);
    renderer.setClearColor(WAKE_CLEAR_COLOR, WAKE_CLEAR_ALPHA);
    renderer.render(scene, camera);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(scratchClearColor, prevAlpha);
  }

  return {
    texture: target.texture,
    extent: WAKE_MAP_EXTENT,
    render,
  };
}
