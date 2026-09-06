import * as THREE from 'three';
import type { ShipState } from './types';
import type { WorldEnv } from './env';
import { GLOBE_RADIUS } from './geo';
import { MAX_FORWARD, MODEL_SCALE } from './ship';
import { createWakeMap } from './wakemap';
import type { WakeMap } from './wakemap';

/**
 * Read-only introspection of the ribbon's ring buffer, for
 * `tests/unit/wake-ring.test.ts`. Nothing the running game reads.
 *
 * Exists because the buffer's invariants (live count within capacity, the
 * draw range staying a contiguous slice of the doubled index list, every
 * rib's tangent staying non-zero) are exactly the kind of thing that breaks
 * silently -- the ring keeps rendering *something* even when the bookkeeping
 * has drifted -- so a regression test needs a way to look inside it that does
 * not exist for any other caller.
 */
export interface WakeDebug {
  /** Ribs currently alive in the ring, 0..RIB_CAPACITY. */
  readonly liveRibs: number;
  /** Ring-buffer slot of the most recently laid rib. */
  readonly head: number;
  /** The ribbon geometry's current `drawRange`, as `setDrawRange` left it. */
  readonly drawRange: { start: number; count: number };
  /**
   * The ribbon's `aRight` attribute array: one tangent vector, repeated
   * across a rib's vertices. Read-only in spirit -- nothing in this module
   * writes it back.
   */
  readonly aRight: Float32Array;
}

export interface Wake {
  object: THREE.Object3D;
  /**
   * `renderer` is optional so callers with no live GPU context (unit tests)
   * keep working unchanged: when it is absent the wake map is simply not
   * filled this frame. In the running game `main.ts` always passes it.
   *
   * Filling the map happens at the END of this function, after `now` and
   * every rib/spray bookkeeping value for this frame are final -- see
   * `docs/RENDER_PLAN.md`'s render-order hazard for why it belongs here
   * rather than in an `onBeforeRender` callback: this runs once, at a fixed
   * point before `postFx.render` draws the water, where the render target
   * can always be restored predictably.
   */
  update(dt: number, ship: ShipState, env: WorldEnv, renderer?: THREE.WebGLRenderer): void;
  readonly debug: WakeDebug;
  /** The wake as an input to the water shader; see `waterwake.ts`. */
  readonly wakeMap: WakeMap;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Ring-buffer capacity, in ribs. A rib is one cross-section of the ribbon. */
const RIB_CAPACITY = 256;
/**
 * Vertices across a rib. More than two so the ribbon bends with the sphere
 * across its own width; at full spread a rib is ~20 units wide and a two-point
 * rib would chord straight through the water and be swallowed by it.
 */
const RIB_VERTS = 7;
/** Normalised offsets across a rib, -1 (port) .. +1 (starboard). */
const RIB_SIDES = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];
/** Triangle indices needed to bridge two consecutive ribs. */
const LINK_INDICES = (RIB_VERTS - 1) * 6;

/** Surface distance the ship must cover before a new rib is laid down. */
const RIB_SPACING = 0.34;
/** Seconds from laying a rib to it having completely dissolved. */
const WAKE_LIFE = 4.0;
/** A jump bigger than this (reverse, a long coast) splits the ribbon. */
const BREAK_GAP = 2.5;

/** Below this the ship leaves no wake at all. Reverse (negative) never does. */
const MIN_WAKE_SPEED = 1.2;

/*
 * Where the foam is thrown, relative to the ship's origin.
 *
 * Authored against the hull's own half-length, so they are multiplied by the
 * same MODEL_SCALE the hull is drawn at. Left at full size against a shrunken
 * ship the wake starts a whole boat-length astern of the transom and the bow
 * spray erupts out of open water ahead of the stem -- the most visible way
 * there is to get a scale change wrong.
 */

/** Distance astern of the ship origin where the foam starts. Hull half-length is 2.5 unscaled. */
const STERN_BACK = 2.3 * MODEL_SCALE;
/** Distance forward of the ship origin where bow spray is thrown. */
const BOW_FORWARD = 2.5 * MODEL_SCALE;

/**
 * Lift above the water sphere.
 *
 * The water mesh is a 256x128 sphere, so its facets sag
 * GLOBE_RADIUS * (1 - cos(PI / 256)) below the true surface -- about 0.015 at
 * the current radius. This has to clear that plus the ribbon's own (much
 * smaller) sag. Absolute rather than radius-scaled on purpose: the sag grows
 * with the radius but the segment counts grow with it too, so it stays put.
 * Invisible at any camera distance.
 */
const SURFACE_LIFT = 0.1;
const WAKE_RADIUS = GLOBE_RADIUS + SURFACE_LIFT;

/**
 * Half-width of a freshly laid rib, and how fast a rib keeps spreading.
 *
 * The initial width is the hull's beam, so it scales with the hull. The spread
 * rate is the sea's answer to being parted and is left alone, so a smaller ship
 * cuts a narrower wake that opens out just as wide behind it.
 */
const HALF_WIDTH_0 = 1.15 * MODEL_SCALE;
const SPREAD_RATE = 1.95;

/* Bow spray ---------------------------------------------------------- */

const SPRAY_CAPACITY = 192;
const SPRAY_LIFE = 0.78;
/** Particles per second at full speed. */
const SPRAY_RATE = 130;
const SPRAY_MIN_SPEED = 2.5;
/** World units / s^2 pulling droplets back toward the surface. */
const SPRAY_GRAVITY = 15;
/** Droplet diameter in world units, before the age-based growth factor. */
const SPRAY_SIZE = 0.42;

/* ------------------------------------------------------------------ */
/* Module-scope scratch (this runs every frame; nothing allocates here) */
/* ------------------------------------------------------------------ */

const _center = new THREE.Vector3();
const _right = new THREE.Vector3();
const _bow = new THREE.Vector3();
const _spawn = new THREE.Vector3();
const _vel = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Re-uploads a dynamic attribute. Partial `addUpdateRange` uploads were tried
 * first and dropped rib data on the way to the GPU; the whole set of buffers is
 * only ~85 KB, so one bufferSubData per frame is both cheaper to reason about
 * and far below anything that matters.
 */
function upload(attr: THREE.BufferAttribute): void {
  attr.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Foam ribbon                                                         */
/* ------------------------------------------------------------------ */

/**
 * The ribbon is a fixed ring of `RIB_CAPACITY` ribs. Only the newest rib is
 * written each frame; everything else, including the widening V and the fade,
 * is derived in the vertex/fragment shader from the rib's recorded birth time,
 * so no geometry is rebuilt and nothing is allocated per frame.
 *
 * The index buffer lists the ribs twice (link `i` joins rib `i % N` to rib
 * `(i + 1) % N`). Any contiguous chronological run of ribs in the ring is then
 * one contiguous slice of that doubled index list, so the live part of the
 * trail draws with a single `setDrawRange` and a single draw call.
 */
function buildRibbonMaterial(): THREE.ShaderMaterial {
  const vertexShader = [
    'attribute vec3 aRight;',
    // x: side in [-1,1], y: birth time, z: speed fraction, w: distance sailed
    'attribute vec4 aParams;',
    'attribute float aBreak;',
    'uniform float uTime;',
    'uniform float uLife;',
    'uniform float uRadius;',
    'uniform float uHalfWidth;',
    'uniform float uSpread;',
    'varying float vSide;',
    'varying float vAge;',
    'varying float vSpeed;',
    'varying float vDist;',
    'varying float vBreak;',
    'varying vec3 vDir;',
    'void main() {',
    '  float side = aParams.x;',
    '  float age = max(0.0, uTime - aParams.y);',
    '  float speed = aParams.z;',
    '  // The wake keeps spreading after it is laid, which is what makes the V.',
    '  float hw = (uHalfWidth + uSpread * age) * (0.42 + 0.58 * speed);',
    '  // position is the rib centre at wake radius and aRight is tangent there,',
    '  // so offsetting then re-normalising walks along a great circle: the',
    '  // ribbon hugs the sphere instead of chording through it.',
    '  vec3 p = normalize(position + aRight * (side * hw)) * uRadius;',
    '  vSide = side;',
    '  vAge = clamp(age / uLife, 0.0, 1.0);',
    '  vSpeed = speed;',
    '  vDist = aParams.w;',
    '  vBreak = aBreak;',
    '  vDir = normalize(p);',
    '  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);',
    '}',
  ].join('\n');

  const fragmentShader = [
    'uniform vec3 uSunDirection;',
    'uniform vec3 uFoam;',
    'uniform vec3 uNightFoam;',
    'uniform float uOpacity;',
    'varying float vSide;',
    'varying float vAge;',
    'varying float vSpeed;',
    'varying float vDist;',
    'varying float vBreak;',
    'varying vec3 vDir;',
    'void main() {',
    '  // Ribs flagged as a break bridge a discontinuity (reverse, a long',
    '  // pause). vBreak is 1 there and 0 at its neighbours, so both quads',
    '  // touching it vanish and the two runs never join up.',
    '  if (vBreak > 0.001) discard;',
    '  float s = abs(vSide);',
    '  float fade = pow(1.0 - vAge, 1.2);',
    '  float spread = smoothstep(0.02, 0.5, vAge);',
    '  // Churned core, plus the two bright arms that grow as the V opens out.',
    '  float core = 1.0 - smoothstep(0.0, 0.9, s);',
    '  float arm = smoothstep(0.45, 0.88, s) * (1.0 - smoothstep(0.88, 1.0, s));',
    '  float shape = core * mix(1.0, 0.30, spread) + arm * (0.25 + 1.05 * spread);',
    '  // Hard churn immediately behind the stern.',
    '  shape += (1.0 - smoothstep(0.0, 0.75, s)) * exp(-vAge * 9.0) * 0.85;',
    '  // Two beat frequencies keyed to distance sailed, so the foam texture',
    '  // sits still in the water instead of sliding along with the ship.',
    '  float band = 0.80 + 0.20 * sin(vDist * 2.9 + s * 1.7);',
    '  float fleck = 0.86 + 0.14 * sin(vDist * 9.7 - s * 6.3 + 1.7);',
    '  shape *= band * fleck;',
    '  float sun = dot(vDir, normalize(uSunDirection));',
    '  float lit = smoothstep(-0.28, 0.30, sun);',
    '  vec3 col = mix(uNightFoam, uFoam, lit) * mix(0.30, 1.0, lit);',
    '  float a = shape * fade * uOpacity * (0.28 + 0.72 * vSpeed) * mix(0.42, 1.0, lit);',
    '  a = clamp(a, 0.0, 0.9);',
    '  if (a < 0.004) discard;',
    '  gl_FragColor = vec4(col, a);',
    '}',
  ].join('\n');

  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: WAKE_LIFE },
      uRadius: { value: WAKE_RADIUS },
      uHalfWidth: { value: HALF_WIDTH_0 },
      uSpread: { value: SPREAD_RATE },
      uOpacity: { value: 1.0 },
      uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
      uFoam: { value: new THREE.Color('#eaf7ff') },
      uNightFoam: { value: new THREE.Color('#7fa6d8') },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
}

/* ------------------------------------------------------------------ */
/* Bow spray                                                           */
/* ------------------------------------------------------------------ */

function buildSprayMaterial(): THREE.ShaderMaterial {
  const vertexShader = [
    'attribute vec3 aVel;',
    // x: birth time, y: random seed, z: speed fraction at spawn
    'attribute vec3 aParams;',
    'uniform float uTime;',
    'uniform float uLife;',
    'uniform float uGravity;',
    'uniform float uSize;',
    'uniform float uPixelScale;',
    'varying float vT;',
    'varying float vSeed;',
    'varying vec3 vDir;',
    'void main() {',
    '  float age = uTime - aParams.x;',
    '  if (age < 0.0 || age > uLife) {',
    '    // Dead slot: push it outside the clip volume rather than drawing a dot.',
    '    vT = 1.0;',
    '    vSeed = 0.0;',
    '    vDir = vec3(0.0, 1.0, 0.0);',
    '    gl_PointSize = 0.0;',
    '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '    return;',
    '  }',
    '  // Ballistic arc. "Down" is the surface normal at the spawn point, which',
    '  // is what keeps droplets falling back into the sea on a curved world.',
    '  vec3 up = normalize(position);',
    '  vec3 p = position + aVel * age - up * (0.5 * uGravity * age * age);',
    '  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);',
    '  vT = age / uLife;',
    '  vSeed = aParams.y;',
    '  vDir = normalize(p);',
    '  gl_Position = projectionMatrix * mv;',
    '  float grow = 0.5 + 1.1 * vT;',
    '  float px = uSize * grow * (0.55 + 0.45 * aParams.z);',
    '  px *= projectionMatrix[1][1] * uPixelScale / max(0.001, -mv.z);',
    '  gl_PointSize = clamp(px, 1.0, 72.0);',
    '}',
  ].join('\n');

  const fragmentShader = [
    'uniform vec3 uSunDirection;',
    'uniform vec3 uFoam;',
    'uniform vec3 uNightFoam;',
    'uniform float uOpacity;',
    'varying float vT;',
    'varying float vSeed;',
    'varying vec3 vDir;',
    'void main() {',
    '  vec2 q = gl_PointCoord - vec2(0.5);',
    '  float r2 = dot(q, q);',
    '  if (r2 > 0.25) discard;',
    '  float soft = 1.0 - smoothstep(0.015, 0.25, r2);',
    '  float rise = smoothstep(0.0, 0.10, vT);',
    '  float fall = 1.0 - smoothstep(0.4, 1.0, vT);',
    '  float flick = 0.75 + 0.25 * sin(vSeed * 37.0);',
    '  float sun = dot(vDir, normalize(uSunDirection));',
    '  float lit = smoothstep(-0.28, 0.30, sun);',
    '  vec3 col = mix(uNightFoam, uFoam, lit) * mix(0.32, 1.0, lit);',
    '  float a = soft * rise * fall * flick * uOpacity * mix(0.42, 1.0, lit);',
    '  if (a < 0.004) discard;',
    '  gl_FragColor = vec4(col, clamp(a, 0.0, 0.95));',
    '}',
  ].join('\n');

  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: SPRAY_LIFE },
      uGravity: { value: SPRAY_GRAVITY },
      uSize: { value: SPRAY_SIZE },
      uPixelScale: { value: 400 },
      uOpacity: { value: 1.0 },
      uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
      uFoam: { value: new THREE.Color('#f2fbff') },
      uNightFoam: { value: new THREE.Color('#8fb4e0') },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });
}

/* ------------------------------------------------------------------ */
/* createWake                                                          */
/* ------------------------------------------------------------------ */

/**
 * `wakeMapSize` is `quality.wakeMapSize` (256 low, 512 medium/high), passed
 * down by `main.ts` rather than read from `quality.ts` directly so this file
 * does not need to know that module exists. Defaults to 512 (medium/high) so
 * `createWake()` -- used by `tests/unit/wake-ring.test.ts`, which has no
 * renderer to size a map for -- keeps compiling with no arguments.
 */
export function createWake(wakeMapSize = 512): Wake {
  const object = new THREE.Group();
  object.name = 'wake';

  /* ---- Ribbon geometry ------------------------------------------- */

  const ribVertexCount = RIB_CAPACITY * RIB_VERTS;
  const ribbonPos = new Float32Array(ribVertexCount * 3);
  const ribbonRight = new Float32Array(ribVertexCount * 3);
  const ribbonParams = new Float32Array(ribVertexCount * 4);
  const ribbonBreak = new Float32Array(ribVertexCount);
  /** CPU mirror of each rib's birth time, used to retire the tail. */
  const ribBirth = new Float32Array(RIB_CAPACITY);
  ribBirth.fill(-1e9);

  // aRight must never be the zero vector, even for slots never written.
  for (let r = 0; r < RIB_CAPACITY; r++) {
    for (let k = 0; k < RIB_VERTS; k++) {
      const v = r * RIB_VERTS + k;
      ribbonPos[v * 3 + 1] = WAKE_RADIUS;
      ribbonRight[v * 3] = 1;
      ribbonParams[v * 4] = RIB_SIDES[k];
      ribbonParams[v * 4 + 1] = -1e9;
      ribbonBreak[v] = 1;
    }
  }

  // Ribs listed twice so any wrapped run is one contiguous index slice.
  const ribbonIndex = new Uint16Array(RIB_CAPACITY * 2 * LINK_INDICES);
  {
    let w = 0;
    for (let link = 0; link < RIB_CAPACITY * 2; link++) {
      const a = (link % RIB_CAPACITY) * RIB_VERTS;
      const b = ((link + 1) % RIB_CAPACITY) * RIB_VERTS;
      for (let k = 0; k < RIB_VERTS - 1; k++) {
        ribbonIndex[w++] = a + k;
        ribbonIndex[w++] = b + k;
        ribbonIndex[w++] = b + k + 1;
        ribbonIndex[w++] = a + k;
        ribbonIndex[w++] = b + k + 1;
        ribbonIndex[w++] = a + k + 1;
      }
    }
  }

  const ribbonGeo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(ribbonPos, 3);
  const rightAttr = new THREE.BufferAttribute(ribbonRight, 3);
  const paramsAttr = new THREE.BufferAttribute(ribbonParams, 4);
  const breakAttr = new THREE.BufferAttribute(ribbonBreak, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  rightAttr.setUsage(THREE.DynamicDrawUsage);
  paramsAttr.setUsage(THREE.DynamicDrawUsage);
  breakAttr.setUsage(THREE.DynamicDrawUsage);
  ribbonGeo.setAttribute('position', posAttr);
  ribbonGeo.setAttribute('aRight', rightAttr);
  ribbonGeo.setAttribute('aParams', paramsAttr);
  ribbonGeo.setAttribute('aBreak', breakAttr);
  ribbonGeo.setIndex(new THREE.BufferAttribute(ribbonIndex, 1));
  ribbonGeo.setDrawRange(0, 0);
  // Vertices are world-space and rewritten in place, so the derived bounding
  // sphere would always be stale. The wake covers the whole globe anyway.
  ribbonGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WAKE_RADIUS * 1.5);

  const ribbonMat = buildRibbonMaterial();
  const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
  ribbon.name = 'wake-ribbon';
  ribbon.frustumCulled = false;
  ribbon.renderOrder = 1;
  object.add(ribbon);

  // The wake as an input to the water shader (see waterwake.ts). Shares this
  // same live ring-buffer geometry -- not a clone -- with its own material,
  // so its ribbon-map draw always matches whatever the on-screen ribbon
  // currently holds.
  const wakeMap = createWakeMap(wakeMapSize, ribbonGeo);

  /* ---- Spray geometry -------------------------------------------- */

  const sprayPos = new Float32Array(SPRAY_CAPACITY * 3);
  const sprayVel = new Float32Array(SPRAY_CAPACITY * 3);
  const sprayParams = new Float32Array(SPRAY_CAPACITY * 3);
  for (let i = 0; i < SPRAY_CAPACITY; i++) {
    sprayPos[i * 3 + 1] = GLOBE_RADIUS;
    sprayParams[i * 3] = -1e9; // born long ago: dead
  }

  const sprayGeo = new THREE.BufferGeometry();
  const sprayPosAttr = new THREE.BufferAttribute(sprayPos, 3);
  const sprayVelAttr = new THREE.BufferAttribute(sprayVel, 3);
  const sprayParamsAttr = new THREE.BufferAttribute(sprayParams, 3);
  sprayPosAttr.setUsage(THREE.DynamicDrawUsage);
  sprayVelAttr.setUsage(THREE.DynamicDrawUsage);
  sprayParamsAttr.setUsage(THREE.DynamicDrawUsage);
  sprayGeo.setAttribute('position', sprayPosAttr);
  sprayGeo.setAttribute('aVel', sprayVelAttr);
  sprayGeo.setAttribute('aParams', sprayParamsAttr);
  sprayGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WAKE_RADIUS * 1.5);

  const sprayMat = buildSprayMaterial();
  const spray = new THREE.Points(sprayGeo, sprayMat);
  spray.name = 'wake-spray';
  spray.frustumCulled = false;
  spray.renderOrder = 2;
  object.add(spray);

  /* ---- Ring-buffer state ----------------------------------------- */

  let head = RIB_CAPACITY - 1; // slot of the newest rib
  let liveRibs = 0;
  let sprayHead = SPRAY_CAPACITY - 1;
  let sprayParity = 0;
  let sprayAccum = 0;

  /** Where the last rib went down. Per-wake state, not scratch. */
  const lastCenter = new THREE.Vector3();

  let now = 0; // seconds since the wake was created
  let travelled = 0; // cumulative forward distance, drives the foam banding
  /** True when the next rib cannot be joined to the previous one. */
  let broken = true;

  function layRib(birth: number, speedFrac: number, isBreak: boolean): void {
    head = (head + 1) % RIB_CAPACITY;
    if (liveRibs < RIB_CAPACITY) liveRibs++;
    ribBirth[head] = birth;

    const base = head * RIB_VERTS;
    const cx = _center.x * WAKE_RADIUS;
    const cy = _center.y * WAKE_RADIUS;
    const cz = _center.z * WAKE_RADIUS;
    const b = isBreak ? 1 : 0;

    for (let k = 0; k < RIB_VERTS; k++) {
      const v = base + k;
      ribbonPos[v * 3] = cx;
      ribbonPos[v * 3 + 1] = cy;
      ribbonPos[v * 3 + 2] = cz;
      ribbonRight[v * 3] = _right.x;
      ribbonRight[v * 3 + 1] = _right.y;
      ribbonRight[v * 3 + 2] = _right.z;
      ribbonParams[v * 4] = RIB_SIDES[k];
      ribbonParams[v * 4 + 1] = birth;
      ribbonParams[v * 4 + 2] = speedFrac;
      ribbonParams[v * 4 + 3] = travelled;
      ribbonBreak[v] = b;
    }

    upload(posAttr);
    upload(rightAttr);
    upload(paramsAttr);
    upload(breakAttr);
  }

  function spawnSpray(
    up: THREE.Vector3,
    forward: THREE.Vector3,
    speedFrac: number,
    birth: number,
  ): void {
    sprayHead = (sprayHead + 1) % SPRAY_CAPACITY;
    const i = sprayHead;
    const side = (sprayParity++ & 1) === 0 ? -1 : 1;
    const r1 = Math.random();
    const r2 = Math.random();
    const r3 = Math.random();
    const r4 = Math.random();

    _spawn
      .copy(_bow)
      .multiplyScalar(GLOBE_RADIUS + 0.12 + r4 * 0.3)
      .addScaledVector(_right, side * (0.3 + r1 * 0.55))
      .addScaledVector(forward, (r2 - 0.5) * 0.9);

    const boost = 0.5 + 0.5 * speedFrac;
    _vel
      .copy(_right)
      .multiplyScalar(side * (1.5 + r1 * 2.4) * boost)
      .addScaledVector(up, (2.1 + r2 * 2.6) * boost)
      .addScaledVector(forward, (0.7 + r3 * 1.9) * boost);

    sprayPos[i * 3] = _spawn.x;
    sprayPos[i * 3 + 1] = _spawn.y;
    sprayPos[i * 3 + 2] = _spawn.z;
    sprayVel[i * 3] = _vel.x;
    sprayVel[i * 3 + 1] = _vel.y;
    sprayVel[i * 3 + 2] = _vel.z;
    sprayParams[i * 3] = birth;
    sprayParams[i * 3 + 1] = r3 * 6.283;
    sprayParams[i * 3 + 2] = speedFrac;

    upload(sprayPosAttr);
    upload(sprayVelAttr);
    upload(sprayParamsAttr);
  }

  function update(dt: number, ship: ShipState, env: WorldEnv, renderer?: THREE.WebGLRenderer): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    now += dt;

    const speed = ship.speed;
    const speedFrac = clamp(Math.abs(speed) / MAX_FORWARD, 0, 1);
    const makesWake = speed >= MIN_WAKE_SPEED;
    if (makesWake) travelled += speed * dt;

    // ---- Stern point, walked back along the great circle ---------------
    // normalize(R * up - d * forward) is exactly the point d/R radians astern,
    // so this stays on the sphere however far the hull is from the origin.
    _center
      .copy(ship.position)
      .multiplyScalar(GLOBE_RADIUS)
      .addScaledVector(ship.forward, -STERN_BACK)
      .normalize();

    // Starboard = forward x up (verified: heading east at lon 0 gives -Y, i.e.
    // south, which is a helmsman's right hand). Re-orthogonalise against the
    // stern's own normal, which is a degree or so off the ship's.
    _right.crossVectors(ship.forward, ship.up);
    if (_right.lengthSq() < 1e-12) _right.set(1, 0, 0);
    _right.addScaledVector(_center, -_right.dot(_center));
    if (_right.lengthSq() < 1e-12) _right.set(1, 0, 0);
    _right.normalize();

    // ---- Lay down new ribs ---------------------------------------------
    // _center is a unit direction, so scale the chord back to world units.
    const gap = liveRibs > 0 ? _center.distanceTo(lastCenter) * GLOBE_RADIUS : Infinity;
    if (makesWake && (liveRibs === 0 || gap >= RIB_SPACING)) {
      const isBreak = broken || liveRibs === 0 || gap > BREAK_GAP;
      layRib(now, speedFrac, isBreak);
      lastCenter.copy(_center);
      broken = false;
    }
    // Reversing or sitting still invalidates continuity: the next rib laid
    // must not be stitched to the run that came before it.
    if (speed < -0.35 || (!makesWake && gap > BREAK_GAP)) broken = true;

    // ---- Retire the tail -------------------------------------------------
    while (liveRibs > 0) {
      const tail = (head - liveRibs + 1 + RIB_CAPACITY) % RIB_CAPACITY;
      if (now - ribBirth[tail] > WAKE_LIFE) liveRibs--;
      else break;
    }

    if (liveRibs >= 2) {
      const tail = (head - liveRibs + 1 + RIB_CAPACITY) % RIB_CAPACITY;
      ribbonGeo.setDrawRange(tail * LINK_INDICES, (liveRibs - 1) * LINK_INDICES);
      ribbon.visible = true;
    } else {
      ribbonGeo.setDrawRange(0, 0);
      ribbon.visible = false;
    }

    // ---- Bow spray -------------------------------------------------------
    if (speed >= SPRAY_MIN_SPEED) {
      _bow
        .copy(ship.position)
        .multiplyScalar(GLOBE_RADIUS)
        .addScaledVector(ship.forward, BOW_FORWARD)
        .normalize();
      sprayAccum += SPRAY_RATE * Math.pow(speedFrac, 1.4) * dt;
      let n = Math.floor(sprayAccum);
      sprayAccum -= n;
      if (n > 8) n = 8;
      for (let i = 0; i < n; i++) spawnSpray(_bow, ship.forward, speedFrac, now);
    } else {
      sprayAccum = 0;
    }

    // ---- Uniforms --------------------------------------------------------
    const ribbonU = ribbonMat.uniforms;
    ribbonU.uTime.value = now;
    ribbonU.uSunDirection.value.copy(env.sunDirection);

    const sprayU = sprayMat.uniforms;
    sprayU.uTime.value = now;
    sprayU.uSunDirection.value.copy(env.sunDirection);
    // gl_PointSize is in device pixels, so it needs the drawing-buffer height.
    sprayU.uPixelScale.value = window.innerHeight * Math.min(window.devicePixelRatio, 2) * 0.5;

    // ---- Fill the wake map ------------------------------------------------
    // Last, so `now` and every buffer above are final for this frame. See the
    // `Wake.update` doc comment for why this belongs here and not in an
    // `onBeforeRender` callback.
    if (renderer) wakeMap.render(renderer, now, ship);
  }

  const debug: WakeDebug = {
    get liveRibs() {
      return liveRibs;
    },
    get head() {
      return head;
    },
    get drawRange() {
      return ribbonGeo.drawRange;
    },
    get aRight() {
      return ribbonRight;
    },
  };

  return { object, update, debug, wakeMap };
}
