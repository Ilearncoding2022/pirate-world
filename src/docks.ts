import * as THREE from 'three';
import type { Dock, EnergyState, ShipState, Towns } from './types';
import type { WorldEnv } from './env';
import { GLOBE_RADIUS, tangentFrame } from './geo';

export interface Docks {
  object: THREE.Object3D;
  update(dt: number, env: WorldEnv, ship: ShipState, energy: EnergyState): void;
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
const RING_LIFT = 0.12;

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
const MAST_HEIGHT = 16;
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
  group.add(beacons);

  const materials = [ringMaterial, beaconMaterial];

  return {
    object: group,
    update(_dt: number, env: WorldEnv, ship: ShipState, energy: EnergyState): void {
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
    },
  };
}
