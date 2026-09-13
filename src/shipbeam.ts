/**
 * shipbeam.ts — a slow magenta pillar standing on the ship, for the far view.
 *
 * Pulled back toward orbit the hull is a few pixels on a planet, and the only
 * thing on screen that says where "you" are is the scope. This puts a column
 * of light on the hull that reads from the full zoom-out, in the magenta the
 * scope already draws the player's own ship in, so the two readings of one
 * position are recognisably one position. The harbour beacons are cyan; the
 * pillar is not a beacon and must never be mistaken for one.
 *
 * It fades in with the camera's zoom and is gone entirely on the deck, where
 * the hull is right there and a pillar out of its mast would be clutter.
 *
 * One quad, turned about the local up in the vertex shader to face the lens,
 * so the column has soft edges from any bearing without the cost or the hard
 * silhouette of a cylinder. Additive and depth-TESTED, so a headland between
 * the lens and the ship still hides the foot of it. Drawn after the cloud deck
 * on purpose: the point is to find the ship from above the weather.
 */
import * as THREE from 'three';
import type { ShipState } from './types';
import { GLOBE_RADIUS } from './geo';
import { LAYER_DEFAULT } from './layers';

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * How tall and how wide, world units. Ship-scale on purpose, like the beacon
 * mast: 80 units is two fifths of the planet's radius. The far framing looks
 * DOWN on the hull, so the column is heavily foreshortened; at 45 it read as a
 * stub from exactly the view it exists for.
 * The half width is at the foot; the column narrows toward the top.
 */
export const BEAM_HEIGHT = 80;
const BEAM_HALF_WIDTH = 0.9;
/**
 * The floor on that half width, in SCREEN pixels. A world width alone is a
 * two-pixel thread from the far framing -- measured, and it was lost against a
 * lit sea -- so the column never draws narrower than this however far out.
 */
const BEAM_MIN_HALF_PX = 7;

/**
 * The zoom band it fades across, 0 = deck and 1 = the furthest framing
 * (owner's call, 2026-09-13: fade in from mid zoom). Smoothstepped between
 * the two, so there is no zoom at which it pops.
 */
export const BEAM_FADE_START = 0.45;
export const BEAM_FADE_FULL = 0.85;

/**
 * One blink, seconds, and the share of full strength it falls to. A slow
 * breath rather than an on/off: it has to be findable at the bottom of the
 * cycle, and a hard blink over a whole planet reads as an alarm.
 */
const BLINK_PERIOD = 2.6;
const BLINK_FLOOR = 0.35;

/** The scope's own-ship magenta, `--magenta` in style.css. */
const BEAM_COLOR = '#ff4fd8';

/** Clear of the hull and the swell, so the foot does not fight the sea. */
const FOOT_LIFT = 0.6;

/* ------------------------------------------------------------------ */
/* Pure parts, for the tests                                           */
/* ------------------------------------------------------------------ */

/** 0..1 visibility for a camera zoom, per `BEAM_FADE_START` and `_FULL`. */
export function beamFade(zoom: number): number {
  const t = (zoom - BEAM_FADE_START) / (BEAM_FADE_FULL - BEAM_FADE_START);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** BLINK_FLOOR..1 at `time` seconds, a smooth breath of `BLINK_PERIOD`. */
export function beamBlink(time: number): number {
  const s = 0.5 + 0.5 * Math.sin((time / BLINK_PERIOD) * Math.PI * 2);
  return BLINK_FLOOR + (1 - BLINK_FLOOR) * s * s;
}

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

const VERTEX = [
  'attribute float aSide;',
  'attribute float aRise;',
  'uniform vec3 uFoot;',
  'uniform vec3 uUp;',
  'uniform float uHeight;',
  'uniform float uHalfWidth;',
  // World units per screen pixel at unit distance: 2 tan(fov/2) / height.
  'uniform float uWorldPerPx;',
  'uniform float uMinHalfPx;',
  'varying float vSide;',
  'varying float vRise;',
  'void main() {',
  '  vSide = aSide;',
  '  vRise = aRise;',
  '  // Turned about the local up to face the lens. Falls back to any',
  '  // perpendicular if the lens is straight overhead, which the chase camera',
  '  // never is but a degenerate frame must not turn into NaNs.',
  '  vec3 toEye = cameraPosition - uFoot;',
  '  vec3 side = cross(uUp, toEye);',
  '  if (dot(side, side) < 1e-6) side = cross(uUp, vec3(0.0, 0.0, 1.0));',
  '  side = normalize(side);',
  '  float floorWidth = length(toEye) * uWorldPerPx * uMinHalfPx;',
  '  float halfWidth = max(uHalfWidth, floorWidth) * mix(1.0, 0.55, aRise);',
  '  vec3 p = uFoot + uUp * (aRise * uHeight) + side * (aSide * halfWidth);',
  '  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);',
  '}',
].join('\n');

const FRAGMENT = [
  'uniform vec3 uColor;',
  'uniform float uStrength;',
  'varying float vSide;',
  'varying float vRise;',
  'void main() {',
  '  float across = 1.0 - abs(vSide);',
  '  // A hot core in a soft sheath, brightest at the foot and gone by the top.',
  '  float core = across * across * across;',
  '  float body = across * across;',
  '  float fall = 1.0 - vRise;',
  '  float a = (body * 0.8 + core * 1.0) * fall * uStrength;',
  '  if (a < 0.003) discard;',
  '  // Over 1.0 at the foot on purpose, so the base catches the bloom pass and',
  '  // the ship reads as a point of light at the far end of the zoom.',
  '  vec3 col = uColor * (1.0 + 0.45 * core * fall);',
  '  gl_FragColor = vec4(pow(col, vec3(0.4545454545)) * a, a);',
  '}',
].join('\n');

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export interface ShipBeam {
  readonly object: THREE.Object3D;
  /**
   * Stand the pillar on the ship at this frame's zoom. `zoom` is the chase
   * camera's 0..1; see `FollowCamera.zoom`. `camera` and `viewHeight` (CSS
   * pixels) set the column's minimum on-screen width.
   */
  update(
    dt: number,
    ship: ShipState,
    zoom: number,
    camera: THREE.PerspectiveCamera,
    viewHeight: number,
  ): void;
}

export function createShipBeam(): ShipBeam {
  // Four vertices: foot left/right, top left/right. Placed entirely in the
  // shader, so the positions here are only there to satisfy the attribute.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  geometry.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array([-1, 1, 1, -1]), 1));
  geometry.setAttribute('aRise', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 1]), 1));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // The quad is placed in the shader, so the culler cannot see where it is.
  // A sphere round the whole planet keeps it from ever being culled.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), GLOBE_RADIUS + BEAM_HEIGHT * 2);

  const uniforms = {
    uFoot: { value: new THREE.Vector3(0, GLOBE_RADIUS, 0) },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uHeight: { value: BEAM_HEIGHT },
    uHalfWidth: { value: BEAM_HALF_WIDTH },
    uWorldPerPx: { value: 0 },
    uMinHalfPx: { value: BEAM_MIN_HALF_PX },
    uColor: { value: new THREE.Color(BEAM_COLOR) },
    uStrength: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    // Premultiplied in the shader, added to the frame: a light, not a sheet.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ship-beam';
  mesh.frustumCulled = false;
  // After the cloud deck (2..), so it stands through the weather from above.
  mesh.renderOrder = 50;
  // Not in the water's reflection cube: a pillar mirrored in the sea under
  // the ship would double it at exactly the range it is meant to be read at.
  mesh.layers.set(LAYER_DEFAULT);
  mesh.visible = false;

  let time = 0;

  return {
    object: mesh,
    update(
      dt: number,
      ship: ShipState,
      zoom: number,
      camera: THREE.PerspectiveCamera,
      viewHeight: number,
    ): void {
      if (dt > 0) time += dt;
      const fade = beamFade(zoom);
      mesh.visible = fade > 0;
      if (!mesh.visible) return;
      const up = ship.position;
      uniforms.uUp.value.copy(up).normalize();
      uniforms.uFoot.value.copy(uniforms.uUp.value).multiplyScalar(GLOBE_RADIUS + FOOT_LIFT);
      uniforms.uStrength.value = fade * beamBlink(time);
      uniforms.uWorldPerPx.value =
        viewHeight > 0 ? (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewHeight : 0;
    },
  };
}
