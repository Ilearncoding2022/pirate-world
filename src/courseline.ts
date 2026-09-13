/**
 * courseline.ts — a dim dotted line over the sea from the ship to its course.
 *
 * The shortest way round the planet, drawn just above the water: a great-circle
 * arc from the hull to the destination's berth, at every zoom (owner's call,
 * 2026-09-13). It is a heading, not a route. It runs straight across whatever
 * land is in the way, and the land hides it there because the line is
 * depth-tested against the terrain like everything else on the sea.
 *
 * A ribbon rather than a GL line, because a GL line is one device pixel wide
 * on every browser that matters. Its width is held in SCREEN pixels in the
 * vertex shader, so it is a thread from orbit and a thread from the deck.
 *
 * The dots are measured from the DESTINATION end. Measured from the ship they
 * would travel with the hull and crawl over the water as it sails; measured
 * from the berth, a given dot stays over the same patch of sea and the ship
 * sails past them, which reads as a line laid on the sea.
 *
 * Drawn after the cloud deck, for `shipbeam.ts`'s reason: the far view is the
 * one this is most needed in, and it is looking down through weather.
 */
import * as THREE from 'three';
import type { ShipState } from './types';
import { GLOBE_RADIUS } from './geo';
import { LAYER_DEFAULT } from './layers';

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Points along the arc. Half the world in 256 steps is ~2.5 units a step. */
const POINTS = 256;

/**
 * Lift above the water sphere. Clears the displaced sea near the hull, which
 * `waterpatch.ts` raises by up to 0.3 in a gale -- the same sum `docks.ts`
 * sizes its ring for, a little over.
 */
const LINE_LIFT = 0.5;

/** Half the ribbon's width in screen pixels, and its world floor up close. */
const HALF_WIDTH_PX = 1.6;
const MIN_HALF_WIDTH = 0.08;

/**
 * Dot spacing, world units, as a share of the lens's distance from the hull,
 * clamped. A fixed world spacing is a dotted line on the deck and a solid one
 * from orbit; tracking the lens keeps the rhythm near the ship roughly the
 * same number of pixels at any zoom.
 */
const SPACING_PER_UNIT = 0.06;
const SPACING_MIN = 1.2;
const SPACING_MAX = 9;
/** Share of each spacing that is dot rather than gap. */
const DOT_SHARE = 0.26;

/** Clear of the hull, and gone inside the berth's ring. World units. */
const FADE_AT_SHIP = 4;
const FADE_AT_BERTH = 9;

/** The berth mint the harbour names and the scope's diamond carry, dimmed. */
const LINE_COLOR = '#8affc4';
const LINE_ALPHA = 0.55;

/**
 * Re-lay the arc once the hull has moved this far, radians (one world unit).
 * The ship end lags by at most that, which is well inside `FADE_AT_SHIP`.
 */
const RELAY_ANGLE = 1 / GLOBE_RADIUS;

/* ------------------------------------------------------------------ */
/* Pure parts, for the tests                                           */
/* ------------------------------------------------------------------ */

/**
 * `count` unit vectors along the great circle from `from` to `to`, both ends
 * included. Antipodal ends have no single shortest arc; the one returned then
 * goes by way of any perpendicular, which is as good a heading as any other.
 */
export function sampleArc(from: THREE.Vector3, to: THREE.Vector3, count: number): THREE.Vector3[] {
  const a = from.clone().normalize();
  const b = to.clone().normalize();
  const dot = Math.max(-1, Math.min(1, a.dot(b)));
  const angle = Math.acos(dot);
  const out: THREE.Vector3[] = [];
  const n = Math.max(2, count);

  if (angle < 1e-9) {
    for (let i = 0; i < n; i++) out.push(a.clone());
    return out;
  }

  // An orthonormal partner for `a` in the plane of the arc.
  const partner = b.clone().addScaledVector(a, -dot);
  if (partner.lengthSq() < 1e-12) {
    partner.set(1, 0, 0).addScaledVector(a, -a.x);
    if (partner.lengthSq() < 1e-6) partner.set(0, 1, 0).addScaledVector(a, -a.y);
  }
  partner.normalize();

  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * angle;
    out.push(a.clone().multiplyScalar(Math.cos(t)).addScaledVector(partner, Math.sin(t)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

const VERTEX = [
  'attribute vec3 aSideDir;',
  'attribute float aSide;',
  'attribute float aFromBerth;',
  'attribute float aFromShip;',
  'uniform float uWorldPerPx;',
  'uniform float uHalfPx;',
  'uniform float uMinHalf;',
  'varying float vFromBerth;',
  'varying float vFromShip;',
  'varying float vSide;',
  'void main() {',
  '  vFromBerth = aFromBerth;',
  '  vFromShip = aFromShip;',
  '  vSide = aSide;',
  '  vec4 world = modelMatrix * vec4(position, 1.0);',
  '  float halfWidth = max(uMinHalf, length(cameraPosition - world.xyz) * uWorldPerPx * uHalfPx);',
  '  world.xyz += aSideDir * (aSide * halfWidth);',
  '  gl_Position = projectionMatrix * viewMatrix * world;',
  '}',
].join('\n');

const FRAGMENT = [
  'uniform vec3 uColor;',
  'uniform float uAlpha;',
  'uniform float uSpacing;',
  'uniform float uDotShare;',
  'uniform float uFadeShip;',
  'uniform float uFadeBerth;',
  'varying float vFromBerth;',
  'varying float vFromShip;',
  'varying float vSide;',
  'void main() {',
  '  float phase = fract(vFromBerth / uSpacing);',
  '  // A dot with feathered ends, and a feathered edge across the ribbon.',
  '  float feather = 0.06;',
  // Not called `dot`: that is a built-in, and shadowing it fails to compile.
  '  float mark = smoothstep(0.0, feather, phase) * (1.0 - smoothstep(uDotShare - feather, uDotShare, phase));',
  '  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));',
  '  float ends = smoothstep(uFadeShip * 0.5, uFadeShip, vFromShip) * smoothstep(uFadeBerth * 0.6, uFadeBerth, vFromBerth);',
  '  float a = mark * edge * ends * uAlpha;',
  '  if (a < 0.004) discard;',
  '  gl_FragColor = vec4(pow(uColor, vec3(0.4545454545)), a);',
  '}',
].join('\n');

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export interface CourseLine {
  readonly object: THREE.Object3D;
  /**
   * Lay the line from the hull to `target` (a unit direction -- the berth's), or
   * hide it for a null target. `camera` and `viewHeight` (CSS pixels) hold the
   * width and the dot rhythm in screen terms.
   */
  update(
    ship: ShipState,
    target: THREE.Vector3 | null,
    camera: THREE.PerspectiveCamera,
    viewHeight: number,
  ): void;
}

export function createCourseLine(): CourseLine {
  const verts = POINTS * 2;
  const positions = new Float32Array(verts * 3);
  const sideDirs = new Float32Array(verts * 3);
  const sides = new Float32Array(verts);
  const fromBerth = new Float32Array(verts);
  const fromShip = new Float32Array(verts);
  for (let i = 0; i < POINTS; i++) {
    sides[i * 2] = -1;
    sides[i * 2 + 1] = 1;
  }
  const index: number[] = [];
  for (let i = 0; i < POINTS - 1; i++) {
    const a = i * 2;
    const b = a + 2;
    index.push(a, a + 1, b + 1, a, b + 1, b);
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const sideDirAttr = new THREE.BufferAttribute(sideDirs, 3);
  const fromBerthAttr = new THREE.BufferAttribute(fromBerth, 1);
  const fromShipAttr = new THREE.BufferAttribute(fromShip, 1);
  for (const attr of [positionAttr, sideDirAttr, fromBerthAttr, fromShipAttr]) {
    attr.setUsage(THREE.DynamicDrawUsage);
  }
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('aSideDir', sideDirAttr);
  geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
  geometry.setAttribute('aFromBerth', fromBerthAttr);
  geometry.setAttribute('aFromShip', fromShipAttr);
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), GLOBE_RADIUS * 1.2);

  const uniforms = {
    uWorldPerPx: { value: 0 },
    uHalfPx: { value: HALF_WIDTH_PX },
    uMinHalf: { value: MIN_HALF_WIDTH },
    uColor: { value: new THREE.Color(LINE_COLOR) },
    uAlpha: { value: LINE_ALPHA },
    uSpacing: { value: 2 },
    uDotShare: { value: DOT_SHARE },
    uFadeShip: { value: FADE_AT_SHIP },
    uFadeBerth: { value: FADE_AT_BERTH },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'course-line';
  mesh.frustumCulled = false;
  mesh.renderOrder = 49;
  mesh.layers.set(LAYER_DEFAULT);
  mesh.visible = false;

  const laidFrom = new THREE.Vector3();
  const laidTo = new THREE.Vector3();
  let laid = false;
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const shipWorld = new THREE.Vector3();

  function lay(from: THREE.Vector3, to: THREE.Vector3): void {
    const arc = sampleArc(from, to, POINTS);
    const total = Math.acos(Math.max(-1, Math.min(1, from.clone().normalize().dot(to.clone().normalize()))));
    const length = total * GLOBE_RADIUS;
    const radius = GLOBE_RADIUS + LINE_LIFT;

    for (let i = 0; i < POINTS; i++) {
      const p = arc[i];
      const next = arc[Math.min(POINTS - 1, i + 1)];
      const prev = arc[Math.max(0, i - 1)];
      tangent.subVectors(next, prev);
      if (tangent.lengthSq() < 1e-12) tangent.set(1, 0, 0);
      side.crossVectors(p, tangent);
      if (side.lengthSq() < 1e-12) side.set(0, 0, 1);
      side.normalize();

      const along = (i / (POINTS - 1)) * length;
      for (let k = 0; k < 2; k++) {
        const v = i * 2 + k;
        positions[v * 3] = p.x * radius;
        positions[v * 3 + 1] = p.y * radius;
        positions[v * 3 + 2] = p.z * radius;
        sideDirs[v * 3] = side.x;
        sideDirs[v * 3 + 1] = side.y;
        sideDirs[v * 3 + 2] = side.z;
        fromShip[v] = along;
        fromBerth[v] = length - along;
      }
    }
    positionAttr.needsUpdate = true;
    sideDirAttr.needsUpdate = true;
    fromBerthAttr.needsUpdate = true;
    fromShipAttr.needsUpdate = true;
    laidFrom.copy(from);
    laidTo.copy(to);
    laid = true;
  }

  return {
    object: mesh,
    update(ship, target, camera, viewHeight): void {
      if (target === null) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
      const from = ship.position;
      if (!laid || laidTo.angleTo(target) > 1e-6 || laidFrom.angleTo(from) > RELAY_ANGLE) {
        lay(from, target);
      }
      uniforms.uWorldPerPx.value =
        viewHeight > 0 ? (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewHeight : 0;
      shipWorld.copy(from).multiplyScalar(GLOBE_RADIUS);
      const lens = camera.position.distanceTo(shipWorld);
      uniforms.uSpacing.value = Math.min(SPACING_MAX, Math.max(SPACING_MIN, lens * SPACING_PER_UNIT));
    },
  };
}
