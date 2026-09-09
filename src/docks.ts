import * as THREE from 'three';
import type { Dock, EnergyState, ShipState, Towns } from './types';
import type { WorldEnv } from './env';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { LAYER_DEFAULT, LAYER_REFLECTED } from './layers';

export interface Docks {
  object: THREE.Object3D;
  /**
   * `camera` is optional and is the name labels' only reader: they hold a
   * screen size, so how legible one is depends on how far the LENS is from it
   * and on nothing else. The same optional-fifth-argument shape `rain.ts`
   * takes the camera through, for the same reason — a caller that does not
   * pass one simply gets no labels rather than labels at the wrong opacity.
   */
  update(
    dt: number,
    env: WorldEnv,
    ship: ShipState,
    energy: EnergyState,
    camera?: THREE.Camera,
  ): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * Lift of the ring above the water sphere, in world units.
 *
 * The sea is a full sphere at exactly GLOBE_RADIUS, so a ring drawn at that
 * radius z-fights it across its whole face. It also has to clear the water
 * mesh's own faceting -- a 256x128 sphere sags a few hundredths of a unit below
 * the true surface between its vertices -- which is the same sum `wake.ts`
 * sizes its SURFACE_LIFT for, so this sits just above that. Absolute rather
 * than a fraction of the radius, for the reason given there: the sag grows with
 * the radius but the segment counts grow with it too. A fifth of a percent of
 * the ring's own width; nothing reads as floating.
 */
// Clears the displaced sea, not just the water sphere: `waterpatch.ts` now
// raises the surface near the ship by up to 0.3 at a full gale, and a berth
// ring is exactly where a ship rides out weather. Was 0.12 when the sea was
// flat.
const RING_LIFT = 0.42;

/**
 * Segments around a ring, and the radial fractions its vertices sit at.
 *
 * Every vertex is placed by sampling the sphere at that bearing and arc, not by
 * laying a flat disc on the tangent plane. At DOCK_RADIUS 8 on a 200 unit globe
 * a flat disc's rim would sink 0.16 units below the sea -- more than RING_LIFT
 * clears -- so the far edge of every zone would be swallowed by the water.
 *
 * The layers are bunched toward the rim because that is where the detail is:
 * the fill is a flat wash and the bright band lives between 0.70 and 1.0.
 */
const RING_SEGMENTS = 48;
const RING_LAYERS = [0.0, 0.5, 0.82, 1.0];

/**
 * Beacon mast, in world units.
 *
 * This is the only way to find a port in daylight -- `citylights.ts` is night
 * only, so without a mast a dock is invisible until dark. It is sized to be
 * spotted, not to be in scale: 16 units is roughly three ship lengths, and at
 * 300 units off the lamp still subtends a handful of pixels, which the bloom
 * pass then smears into something the eye catches. The taper and the three
 * sided mast keep it cheap; a fourteen triangle beacon costs nothing at 48 of
 * them and there is no reason for it to be round.
 */
// Halved from 16. The masts read as landmarks from a distance either way,
// and at the old height they cut across the sky from the chase camera and
// stood taller than the hills behind them. The lamp rides on top, so it
// comes down with this; LAMP_RADIUS is deliberately unchanged, since the
// light is what has to stay findable.
const MAST_HEIGHT = 8;
const MAST_RADIUS_BASE = 0.85;
const MAST_RADIUS_TOP = 0.45;
const MAST_SIDES = 3;
const LAMP_RADIUS = 1.5;

/**
 * Breathing rate of the idle ring and the lamp, in radians per second.
 *
 * About one cycle every five seconds. Slow enough to read as a beacon rather
 * than a blinker, and the phase is offset per berth so a coastline of them does
 * not pulse in unison.
 */
const BREATHE_RATE = 1.25;

/* ------------------------------------------------------------------ */
/* The name over the harbour                                           */
/* ------------------------------------------------------------------ */

/**
 * How far a label is legible, in world units. Ship-scale, both of them.
 *
 * Full strength inside `LABEL_FADE_NEAR` and gone by `LABEL_FADE_FAR`, and the
 * fade is what makes 36 of them bearable. The world is redrawn on every load,
 * so the name is the only durable fact about a harbour and the player has to
 * be able to read it off the world rather than only off the scope — but from
 * the chase camera's far end, and certainly from orbit, 36 names scattered
 * over a globe is a word cloud with a planet behind it.
 *
 * 60 is a little past the range at which the beacon's lamp resolves into a
 * shape rather than a point, so the name arrives at the moment the harbour
 * stops being a light and starts being a place. 140 is comfortably inside the
 * chase camera's ≈211-unit far framing, so zooming out clears the sky rather
 * than merely thinning it.
 */
export const LABEL_FADE_NEAR = 60;
export const LABEL_FADE_FAR = 140;

/**
 * Where the label sits above the beacon's foot, in world units.
 *
 * Clear of the lamp, which tops out at `MAST_HEIGHT + LAMP_RADIUS * 1.55`. The
 * gap above that is deliberately most of a lamp again: the lamp is the one
 * thing here that clears the bloom threshold, and text sitting in its halo is
 * text with a glow bleeding through it.
 */
const LABEL_LIFT = MAST_HEIGHT + LAMP_RADIUS * 2.8;

/**
 * The label's height as a fraction of the viewport's, and the padding around
 * the glyphs as a fraction of the type size.
 *
 * `sizeAttenuation` is off, so a sprite's scale is very nearly the fraction of
 * the screen's HEIGHT it covers: Three multiplies the scale by the view-space
 * depth, which cancels the perspective divide, and the residual factor is
 * `2 * tan(fov / 2)` — 1.04 at `camera.ts`'s 55° field. So 0.034 here is about
 * 3.4% of the frame, or 31px on a 900px window, of which the type itself is
 * most and the padding the rest.
 *
 * A screen size rather than a world size is the whole point. A world-sized
 * label is a label that is unreadable at the range you actually want to read
 * it at and a billboard at the range you do not.
 */
const LABEL_SCREEN_HEIGHT = 0.034;
const LABEL_PAD = 0.34;

/**
 * The size the name is rasterised at, in canvas pixels, and the halo under it.
 *
 * Generous, because the texture is authored once and then only ever scaled
 * DOWN: at the near fade a label is around 30 screen pixels tall on a 1080p
 * window and around 60 on a 2x display, and rasterising at 44 costs four
 * kilobytes of texture per harbour and removes the question entirely. The halo
 * is the scope's, for the scope's reason — this text crosses a lit sea, a
 * night sky and a green hillside, and a bare glyph over the third is not
 * there.
 */
const LABEL_RASTER_PX = 44;
const LABEL_HALO_PX = 4;

/**
 * The face, and the colours.
 *
 * The HUD's mono stack, named here rather than read from CSS for `radar.ts`'s
 * reason: a 2D canvas has no cascade to read. Mint, the same hue the scope
 * draws a berth's diamond in, so the name over the water and the name on the
 * instrument are recognisably one label for one place.
 */
const LABEL_FONT_STACK =
  'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';
const LABEL_FILL = '#8affc4';
const LABEL_HALO = 'rgba(2, 10, 18, 0.86)';

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

/*
 * These are `ShaderMaterial`s, so `postfx.ts` deliberately leaves them out of
 * the self-encode patch it applies to stock materials, and nothing converts
 * their output. Both shaders therefore do the linear -> sRGB encode themselves
 * on the last line, exactly as `water.ts` does, which is what lets the hexes
 * below mean on screen what they say. Every material here is built during
 * construction: one created later -- on first dock, say -- would miss the patch
 * *and* have no encode of its own, and render a stop dark.
 */

/**
 * Cyan: a berth waiting. Green: the ship is inside and charging. Amber: inside
 * but moving through faster than the 3 world units/s `energy.ts` charges below,
 * so the fix is to slow down rather than to go somewhere else. That threshold
 * lives in `energy.ts` and reaches here only as `EnergyState.mode`; duplicating
 * the number would give the rings a chance to disagree with the power plant.
 */
const IDLE_COLOR = '#3fd6ff';
const CHARGE_COLOR = '#4dff9b';
const BLOCKED_COLOR = '#ffb23d';
/** The mast itself, lit and unlit. Not black at night: it has to stay a line. */
const MAST_DAY_COLOR = '#c6d2dd';
const MAST_NIGHT_COLOR = '#42566b';

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

/*
 * `berthed` rather than the obvious `active`: `active` is a RESERVED WORD in
 * GLSL ES and every one of these shaders fails to compile with it. Nothing in
 * the TypeScript build can see that -- `tsc` and Vite treat a shader as a
 * string -- so it costs a green build and a black scene at runtime.
 *
 * One draw call per layer, so the berth a fragment belongs to arrives as a
 * vertex attribute (`aDock`) and the ship's whereabouts as a single uniform
 * (`uActive`, an index, or -1 for "not in any zone"). Everything else that
 * moves -- the breathing, the sun, the state -- is a uniform too, so a frame's
 * work is four scalar writes against two materials and no buffer touched.
 */

const RING_VERTEX = [
  'attribute float aRadial;',
  'attribute float aDock;',
  'varying float vRadial;',
  'varying float vDock;',
  'varying vec3 vDir;',
  'void main() {',
  '  vRadial = aRadial;',
  '  vDock = aDock;',
  '  vDir = normalize(position);',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}',
].join('\n');

const RING_FRAGMENT = [
  'uniform float uTime;',
  'uniform float uActive;',
  'uniform float uCharging;',
  'uniform float uBreathe;',
  'uniform vec3 uIdle;',
  'uniform vec3 uCharge;',
  'uniform vec3 uBlocked;',
  'uniform vec3 uSunDirection;',
  'varying float vRadial;',
  'varying float vDock;',
  'varying vec3 vDir;',
  'void main() {',
  '  float berthed = step(abs(vDock - uActive), 0.5);',
  '  vec3 tint = mix(uIdle, mix(uBlocked, uCharge, uCharging), berthed);',
  '  // Idle berths breathe, out of step with each other because the phase is',
  '  // keyed to the berth index. The occupied one is almost steady: a ring',
  '  // still pulsing under the ship reads as "searching", not as "charging".',
  '  float breathe = 0.5 + 0.5 * sin(uTime * uBreathe + vDock * 1.7);',
  '  float pulse = mix(0.62 + 0.38 * breathe, 0.92 + 0.08 * breathe, berthed);',
  '  // A bright band inside a faint wash: the wash says where the zone is, the',
  '  // band is the thing you steer at. Both ends of the band feather, so the',
  '  // rim has no hard edge against the sea.',
  '  float band = smoothstep(0.70, 0.93, vRadial) * (1.0 - smoothstep(0.93, 1.0, vRadial));',
  '  float fill = 1.0 - smoothstep(0.0, 0.98, vRadial);',
  '  // Deliberately not gated on daylight -- this is a navigation aid and the',
  '  // town lights are already night only. Only the balance shifts: hotter',
  '  // against a bright sea, cooler at night where nothing competes with it.',
  '  float lit = smoothstep(-0.25, 0.25, dot(vDir, normalize(uSunDirection)));',
  '  vec3 col = tint * mix(0.80, 1.25, lit) * mix(1.0, 1.35, berthed);',
  '  float a = (band * 0.90 + fill * 0.14) * pulse * mix(0.85, 1.0, lit);',
  '  a = clamp(a * (0.55 + 0.45 * berthed), 0.0, 0.95);',
  '  if (a < 0.004) discard;',
  '  gl_FragColor = vec4(pow(col, vec3(0.4545454545)), a);',
  '}',
].join('\n');

/*
 * `position` and `normal` are declared for us by Three's ShaderMaterial prefix;
 * redeclaring either fails to compile.
 */
const BEACON_VERTEX = [
  'attribute float aDock;',
  'attribute float aLamp;',
  'attribute float aUp;',
  'varying float vDock;',
  'varying float vLamp;',
  'varying float vUp;',
  'varying vec3 vNormal;',
  'varying vec3 vDir;',
  'void main() {',
  '  vDock = aDock;',
  '  vLamp = aLamp;',
  '  vUp = aUp;',
  '  vNormal = normal;',
  '  // The mast stands on its own radius, so the surface direction under it is',
  '  // just the normalised position -- good enough for the day/night term.',
  '  vDir = normalize(position);',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}',
].join('\n');

const BEACON_FRAGMENT = [
  'uniform float uTime;',
  'uniform float uActive;',
  'uniform float uCharging;',
  'uniform float uBreathe;',
  'uniform vec3 uIdle;',
  'uniform vec3 uCharge;',
  'uniform vec3 uBlocked;',
  'uniform vec3 uMastDay;',
  'uniform vec3 uMastNight;',
  'uniform vec3 uSunDirection;',
  'varying float vDock;',
  'varying float vLamp;',
  'varying float vUp;',
  'varying vec3 vNormal;',
  'varying vec3 vDir;',
  'void main() {',
  '  float berthed = step(abs(vDock - uActive), 0.5);',
  '  vec3 tint = mix(uIdle, mix(uBlocked, uCharge, uCharging), berthed);',
  '  vec3 sun = normalize(uSunDirection);',
  '  float lit = smoothstep(-0.25, 0.25, dot(vDir, sun));',
  '  vec3 col;',
  '  if (vLamp > 0.5) {',
  '    float breathe = 0.5 + 0.5 * sin(uTime * uBreathe + vDock * 1.7);',
  '    // Over 1.0 on purpose. The lamp is the one part of a dock meant to clear',
  '    // the bloom threshold in postfx.ts, and that glow is what makes a beacon',
  '    // a point of light from a few hundred units instead of a smear.',
  '    col = tint * mix(1.25 + 0.35 * breathe, 1.90, berthed);',
  '  } else {',
  '    // Lambert with a high floor, brightening toward the lamp. A correctly',
  '    // dark unlit side would vanish into the night sea, and the mast has to',
  '    // stay a vertical line against a bright sea and a black one alike.',
  '    float ndl = max(dot(normalize(vNormal), sun), 0.0);',
  '    col = mix(uMastNight, uMastDay, lit) * (0.45 + 0.55 * ndl) * (0.80 + 0.45 * vUp);',
  '    // A collar in the berth\'s own colour under the lamp, so the state is',
  '    // legible at ranges where the lamp is still a single pixel.',
  '    col = mix(col, tint * 0.9, smoothstep(0.86, 0.97, vUp));',
  '  }',
  '  gl_FragColor = vec4(pow(col, vec3(0.4545454545)), 1.0);',
  '}',
].join('\n');

/**
 * Rasterises one harbour name into a transparent canvas texture.
 *
 * Returns null where there is no canvas to draw on — a headless run, or a
 * browser that has refused the 2D context — because a label is the most
 * optional thing in this file and must never be the reason a world fails to
 * build.
 *
 * The canvas is sized from the measured text rather than fixed, so a sprite's
 * aspect matches its own name and `Rustwharf` is not stretched to the width of
 * `Bilgewater Reach`.
 */
function makeLabelTexture(name: string): { texture: THREE.CanvasTexture; aspect: number } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d');
  if (measure === null) return null;

  const font = `600 ${LABEL_RASTER_PX}px ${LABEL_FONT_STACK}`;
  measure.font = font;
  const pad = LABEL_RASTER_PX * LABEL_PAD;
  const width = Math.ceil(measure.measureText(name).width + pad * 2);
  const height = Math.ceil(LABEL_RASTER_PX + pad * 2);
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);

  // The context is re-fetched off the resized canvas: setting width or height
  // resets every piece of 2D state, the font included.
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = LABEL_HALO_PX;
  ctx.strokeStyle = LABEL_HALO;
  ctx.strokeText(name, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = LABEL_FILL;
  ctx.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  /*
   * sRGB going in, because this is COLOUR and not data — the opposite of
   * `wakemap.ts` and `weathermap.ts`, and the distinction is exactly the one
   * ARCHITECTURE draws. Three decodes it to linear on the fetch, and
   * `postfx.ts`'s self-encode patch — which a `SpriteMaterial` does receive,
   * being a stock material — puts it back on the way out. Leave it
   * `NoColorSpace` and the round trip is missing its first half, and the mint
   * comes out washed.
   */
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, aspect: canvas.width / canvas.height };
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * The charging zones on the water beside each port town, and the beacons that
 * make them findable in daylight.
 *
 * Two draw calls for the whole world: every ring is merged into one geometry
 * and every mast into another. Forty-odd berths as forty-odd Object3Ds would
 * cost ninety draw calls and ninety matrix updates a frame to draw what is,
 * visually, one static thing that changes colour in one place. The berth under
 * the ship is singled out inside the shader from a per-vertex index against a
 * uniform, so "the ship arrived" costs one uniform write rather than a geometry
 * rebuild or a material swap.
 */
export function createDocks(towns: Towns): Docks {
  const group = new THREE.Group();
  group.name = 'docks';

  const docks = towns.docks;
  /** Berth to its index in the shaders' `aDock` attribute. */
  const dockIndex = new Map<Dock, number>();
  for (let i = 0; i < docks.length; i++) dockIndex.set(docks[i], i);

  const north = new THREE.Vector3();
  const east = new THREE.Vector3();
  const vertex = new THREE.Vector3();

  /* ---- Rings ------------------------------------------------------ */

  const ringVerts = RING_LAYERS.length * RING_SEGMENTS;
  const ringPos = new Float32Array(docks.length * ringVerts * 3);
  const ringRadial = new Float32Array(docks.length * ringVerts);
  const ringDock = new Float32Array(docks.length * ringVerts);
  const ringIndex: number[] = [];

  for (let d = 0; d < docks.length; d++) {
    const dock = docks[d];
    tangentFrame(dock.dir, north, east);
    const arc = dock.radius / GLOBE_RADIUS;
    const base = d * ringVerts;

    for (let l = 0; l < RING_LAYERS.length; l++) {
      const t = RING_LAYERS[l];
      for (let s = 0; s < RING_SEGMENTS; s++) {
        const a = (s / RING_SEGMENTS) * Math.PI * 2;
        // Sample the sphere: offset in the tangent plane, then renormalise, so
        // the vertex lands on the surface rather than on a chord across it.
        vertex
          .copy(dock.dir)
          .addScaledVector(north, Math.cos(a) * t * arc)
          .addScaledVector(east, Math.sin(a) * t * arc)
          .normalize()
          .multiplyScalar(GLOBE_RADIUS + RING_LIFT);

        const v = base + l * RING_SEGMENTS + s;
        ringPos[v * 3] = vertex.x;
        ringPos[v * 3 + 1] = vertex.y;
        ringPos[v * 3 + 2] = vertex.z;
        ringRadial[v] = t;
        ringDock[v] = d;
      }
    }

    // Quads between consecutive layers. The seam needs no duplicate column:
    // the ring closes by wrapping the segment index.
    for (let l = 0; l < RING_LAYERS.length - 1; l++) {
      for (let s = 0; s < RING_SEGMENTS; s++) {
        const s1 = (s + 1) % RING_SEGMENTS;
        const inner = base + l * RING_SEGMENTS;
        const outer = inner + RING_SEGMENTS;
        ringIndex.push(inner + s, outer + s, outer + s1);
        ringIndex.push(inner + s, outer + s1, inner + s1);
      }
    }
  }

  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));
  ringGeo.setAttribute('aRadial', new THREE.BufferAttribute(ringRadial, 1));
  ringGeo.setAttribute('aDock', new THREE.BufferAttribute(ringDock, 1));
  ringGeo.setIndex(ringIndex);
  // Stated rather than derived: both layers are scattered over the whole globe,
  // so the derived sphere is this one anyway, and a world that happened to
  // place no berths at all would otherwise hand the culler a NaN radius.
  ringGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), GLOBE_RADIUS * 1.2);

  const ringMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uActive: { value: -1 },
      uCharging: { value: 0 },
      uBreathe: { value: BREATHE_RATE },
      uIdle: { value: new THREE.Color(IDLE_COLOR) },
      uCharge: { value: new THREE.Color(CHARGE_COLOR) },
      uBlocked: { value: new THREE.Color(BLOCKED_COLOR) },
      uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
    },
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    transparent: true,
    // The ring is painted on the sea, not floating over it: it must not stamp
    // depth, or the wake and the ship's own spray would be cut out of it.
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });

  const rings = new THREE.Mesh(ringGeo, ringMaterial);
  rings.name = 'dock-rings';
  // With the wake, below the cloud deck, so a cloud passing overhead covers it.
  rings.renderOrder = 1;
  group.add(rings);

  /* ---- Beacons ---------------------------------------------------- */

  // Four vertices per mast face, plus a six-vertex octahedron for the lamp.
  const beaconVerts = MAST_SIDES * 4 + 6;
  const beaconPos = new Float32Array(docks.length * beaconVerts * 3);
  const beaconNormal = new Float32Array(docks.length * beaconVerts * 3);
  const beaconDock = new Float32Array(docks.length * beaconVerts);
  const beaconLamp = new Float32Array(docks.length * beaconVerts);
  const beaconUp = new Float32Array(docks.length * beaconVerts);
  const beaconIndex: number[] = [];

  const lampAxes = [north, east, vertex];

  for (let d = 0; d < docks.length; d++) {
    const dock = docks[d];
    tangentFrame(dock.dir, north, east);
    const base = d * beaconVerts;
    let w = base;

    /** Writes one vertex and returns its index. */
    function push(
      x: number,
      y: number,
      z: number,
      nx: number,
      ny: number,
      nz: number,
      up: number,
      lamp: number,
    ): number {
      beaconPos[w * 3] = x;
      beaconPos[w * 3 + 1] = y;
      beaconPos[w * 3 + 2] = z;
      beaconNormal[w * 3] = nx;
      beaconNormal[w * 3 + 1] = ny;
      beaconNormal[w * 3 + 2] = nz;
      beaconDock[w] = d;
      beaconLamp[w] = lamp;
      beaconUp[w] = up;
      return w++;
    }

    // Foot of the mast, on the same lifted surface as the ring.
    const footR = GLOBE_RADIUS + RING_LIFT;
    const fx = dock.dir.x * footR;
    const fy = dock.dir.y * footR;
    const fz = dock.dir.z * footR;

    for (let i = 0; i < MAST_SIDES; i++) {
      const a0 = (i / MAST_SIDES) * Math.PI * 2;
      const a1 = ((i + 1) / MAST_SIDES) * Math.PI * 2;
      const am = (a0 + a1) * 0.5;
      const nx = north.x * Math.cos(am) + east.x * Math.sin(am);
      const ny = north.y * Math.cos(am) + east.y * Math.sin(am);
      const nz = north.z * Math.cos(am) + east.z * Math.sin(am);

      const corner = (a: number, radius: number, lift: number): [number, number, number] => [
        fx + (north.x * Math.cos(a) + east.x * Math.sin(a)) * radius + dock.dir.x * lift,
        fy + (north.y * Math.cos(a) + east.y * Math.sin(a)) * radius + dock.dir.y * lift,
        fz + (north.z * Math.cos(a) + east.z * Math.sin(a)) * radius + dock.dir.z * lift,
      ];

      const b0 = corner(a0, MAST_RADIUS_BASE, 0);
      const b1 = corner(a1, MAST_RADIUS_BASE, 0);
      const t1 = corner(a1, MAST_RADIUS_TOP, MAST_HEIGHT);
      const t0 = corner(a0, MAST_RADIUS_TOP, MAST_HEIGHT);

      const i0 = push(b0[0], b0[1], b0[2], nx, ny, nz, 0, 0);
      const i1 = push(b1[0], b1[1], b1[2], nx, ny, nz, 0, 0);
      const i2 = push(t1[0], t1[1], t1[2], nx, ny, nz, 1, 0);
      const i3 = push(t0[0], t0[1], t0[2], nx, ny, nz, 1, 0);
      beaconIndex.push(i0, i1, i2, i0, i2, i3);
    }

    // Lamp: an octahedron on the mast's own axes. Six vertices, eight faces,
    // normals straight off the offset, which is exact for a sphere-like blob
    // and free.
    vertex.copy(dock.dir);
    const lampLift = MAST_HEIGHT + LAMP_RADIUS * 0.55;
    const cx = fx + dock.dir.x * lampLift;
    const cy = fy + dock.dir.y * lampLift;
    const cz = fz + dock.dir.z * lampLift;
    const poles: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
      const v = lampAxes[axis];
      for (const sign of [1, -1]) {
        poles.push(
          push(
            cx + v.x * LAMP_RADIUS * sign,
            cy + v.y * LAMP_RADIUS * sign,
            cz + v.z * LAMP_RADIUS * sign,
            v.x * sign,
            v.y * sign,
            v.z * sign,
            1,
            1,
          ),
        );
      }
    }
    // poles is [+north, -north, +east, -east, +up, -up]; the eight faces are
    // every choice of one pole from each axis.
    for (const a of [0, 1]) {
      for (const b of [2, 3]) {
        for (const c of [4, 5]) beaconIndex.push(poles[a], poles[b], poles[c]);
      }
    }
  }

  const beaconGeo = new THREE.BufferGeometry();
  beaconGeo.setAttribute('position', new THREE.BufferAttribute(beaconPos, 3));
  beaconGeo.setAttribute('normal', new THREE.BufferAttribute(beaconNormal, 3));
  beaconGeo.setAttribute('aDock', new THREE.BufferAttribute(beaconDock, 1));
  beaconGeo.setAttribute('aLamp', new THREE.BufferAttribute(beaconLamp, 1));
  beaconGeo.setAttribute('aUp', new THREE.BufferAttribute(beaconUp, 1));
  beaconGeo.setIndex(beaconIndex);
  beaconGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), GLOBE_RADIUS * 1.2);

  const beaconMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uActive: { value: -1 },
      uCharging: { value: 0 },
      uBreathe: { value: BREATHE_RATE },
      uIdle: { value: new THREE.Color(IDLE_COLOR) },
      uCharge: { value: new THREE.Color(CHARGE_COLOR) },
      uBlocked: { value: new THREE.Color(BLOCKED_COLOR) },
      uMastDay: { value: new THREE.Color(MAST_DAY_COLOR) },
      uMastNight: { value: new THREE.Color(MAST_NIGHT_COLOR) },
      uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
    },
    vertexShader: BEACON_VERTEX,
    fragmentShader: BEACON_FRAGMENT,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    // Both solids are closed and the whole layer is under a thousand
    // triangles, so face culling would only buy a chance to get a winding
    // wrong. Drawn as an opaque solid, so land in front of a beacon hides it.
    side: THREE.DoubleSide,
  });

  const beacons = new THREE.Mesh(beaconGeo, beaconMaterial);
  beacons.name = 'dock-beacons';
  // Docs/RENDER_PLAN.md Phase 1 Stream D: findable in the water's own
  // reflection cube. The rings are not -- they are painted flat on the sea
  // itself and would add nothing seen from inside a 128-256px cube.
  beacons.layers.enable(LAYER_REFLECTED);
  group.add(beacons);

  /* ---- Name labels ------------------------------------------------ */

  /*
   * One sprite per harbour, floating over its beacon.
   *
   * Thirty-six draw calls, and that is the accepted price rather than an
   * oversight: every one carries a different string, so they cannot share a
   * texture without an atlas, and an atlas is the work that gets done if and
   * when the Backquote overlay says these cost something. They are cheap in
   * the way that matters — no geometry, no matrix hierarchy, and every one
   * past `LABEL_FADE_FAR` marks itself invisible and costs nothing at all.
   *
   * `sizeAttenuation` is off, so the label holds a screen size instead of
   * shrinking with distance. That is what makes the pair of fade constants the
   * whole of the range logic: a label is either legible or absent, never a
   * two-pixel smear that the eye reads as dirt on the lens.
   */
  const labels: { sprite: THREE.Sprite; material: THREE.SpriteMaterial }[] = [];

  for (const dock of docks) {
    const name = dock.town.name;
    if (name === '') continue;
    const drawn = makeLabelTexture(name);
    if (drawn === null) continue;

    const material = new THREE.SpriteMaterial({
      map: drawn.texture,
      transparent: true,
      /*
       * OFF, and it has to be set rather than described.
       *
       * This file carried two comments saying it was off and never passed it;
       * the default is TRUE, so every label was 0.034 WORLD units tall -- a
       * sixth of a millimetre against a 3-unit hull -- and all 36 rendered
       * correctly, in the scene, at full opacity, far below one pixel. The
       * build was green and both test tiers passed, because nothing here
       * asserts on appearance and an invisible sprite throws nothing.
       *
       * With it off, `scale` is very nearly the fraction of the viewport the
       * sprite covers, which is what LABEL_SCREEN_HEIGHT is authored as and
       * what makes the two fade constants the whole of the range logic.
       */
      sizeAttenuation: false,
      // Not written into the depth buffer, exactly as the ring is not: a
      // label is an annotation on the world and must not carve the sea, the
      // spray or another harbour's label out of itself.
      depthWrite: false,
      // TESTED though, so a hill between the camera and a harbour hides its
      // name. A label read through solid rock would place the harbour on the
      // wrong side of the island.
      depthTest: true,
      opacity: 0,
    });

    const sprite = new THREE.Sprite(material);
    sprite.name = `dock-label-${name}`;
    sprite.position
      .copy(dock.dir)
      .multiplyScalar(GLOBE_RADIUS + RING_LIFT)
      .addScaledVector(dock.dir, LABEL_LIFT);
    sprite.scale.set(LABEL_SCREEN_HEIGHT * drawn.aspect, LABEL_SCREEN_HEIGHT, 1);
    /*
     * The one line that keeps the harbour's name out of the water.
     *
     * `layers.set` rather than a comment about the default: the beacons above
     * OPT IN to `LAYER_REFLECTED`, so the exclusion here is a decision and
     * should be written as one. A name reflected in the sea would be a mirror
     * image of text — unreadable, and read at a glance as a rendering fault —
     * and the reflection cube is 128-256 pixels a face, where a label is a
     * smear whatever way round it is.
     */
    sprite.layers.set(LAYER_DEFAULT);
    // Above the wake and with the beacons, under the cloud deck.
    sprite.renderOrder = 2;
    // Hidden until a camera says otherwise, so a frame drawn before the first
    // `update` never flashes 36 names at full strength.
    sprite.visible = false;
    group.add(sprite);
    labels.push({ sprite, material });
  }

  /** Scratch for the camera's world position; never allocated per frame. */
  const eye = new THREE.Vector3();

  const materials = [ringMaterial, beaconMaterial];

  return {
    object: group,
    update(
      _dt: number,
      env: WorldEnv,
      ship: ShipState,
      energy: EnergyState,
      camera?: THREE.Camera,
    ): void {
      // "Inside a zone" is the world's answer, not the power plant's: `energy`
      // may be refusing to charge (below CHARGE_SPEED_LIMIT is its rule, not
      // ours) and the ring still has to light up to say the ship is in the
      // right place and only going too fast.
      const dock = towns.dockAt(ship.position);
      const active = dock === null ? -1 : (dockIndex.get(dock) as number);
      const charging = energy.mode === 'docked' ? 1 : 0;

      for (let i = 0; i < materials.length; i++) {
        const u = materials[i].uniforms;
        u.uTime.value = env.elapsed;
        u.uActive.value = active;
        u.uCharging.value = charging;
        u.uSunDirection.value.copy(env.sunDirection);
      }

      /*
       * The labels' distance fade.
       *
       * Measured from the CAMERA and not from the ship, which is the whole
       * point of taking the camera at all: the chase view sits between 23 and
       * 211 units behind the hull, so a fade keyed to the ship would hold a
       * label at full strength while the lens was a hundred units further off
       * than the number it was tested at.
       *
       * `visible` is set as well as `opacity`, so a label out of range costs
       * nothing rather than costing a transparent draw. A camera that is not
       * passed leaves every label exactly as the last frame left it, which for
       * a caller that never passes one is hidden.
       */
      if (camera !== undefined && labels.length > 0) {
        camera.getWorldPosition(eye);
        for (const label of labels) {
          const distance = eye.distanceTo(label.sprite.position);
          if (distance >= LABEL_FADE_FAR) {
            label.sprite.visible = false;
            continue;
          }
          label.sprite.visible = true;
          label.material.opacity =
            distance <= LABEL_FADE_NEAR
              ? 1
              : 1 - (distance - LABEL_FADE_NEAR) / (LABEL_FADE_FAR - LABEL_FADE_NEAR);
        }
      }
    },
  };
}
