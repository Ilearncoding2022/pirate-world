/**
 * rain.ts — the drops, in a box that follows the ship.
 *
 * Rain is the one piece of weather with no place at all: it is at the ship or
 * it is nowhere, because a raindrop forty units away is smaller than a pixel
 * and a raindrop four hundred is an idea. So unlike the cloud deck and the
 * haze, this module never reads `weathermap.ts` -- it reads `weather.rain`,
 * which is the storm AT THE SHIP, and draws a box of drops around the hull.
 *
 * Every drop moves in the VERTEX SHADER. The CPU writes three uniforms and
 * moves one group; it never touches a vertex. That is what makes three
 * thousand drops cost one draw call and no per-frame allocation, and it is
 * the same trick `clouds.ts` uses to animate a whole sky from `uTime`.
 *
 * The box is ship-scale (docs/ARCHITECTURE.md, "World scale") and does not
 * grow with `GLOBE_RADIUS`: rain is sized against a 3.1-unit hull and the
 * chase camera's near framing, not against the planet.
 */
import * as THREE from 'three';
import type { ShipState, WeatherState, WindState } from './types';
import { LAYER_DEFAULT } from './layers';
import { GLOBE_RADIUS } from './geo';

export interface Rain {
  object: THREE.Object3D;
  update(dt: number, ship: ShipState, wind: WindState, weather: WeatherState): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants — all ship-scale                                    */
/* ------------------------------------------------------------------ */

/**
 * The box the drops live in, world units across and tall.
 *
 * 14 across is four and a half hull lengths, which puts the box's edge behind
 * the chase camera at its near framing -- the one place a drop popping into
 * existence would be visible. 10 tall clears the masthead with room for a
 * drop to have been falling before it reaches the deck.
 *
 * Bigger is not better here: the box is a fixed number of drops, so widening
 * it thins the rain rather than extending it.
 *
 * Still 14 across with `RAIN_FADE` below in front of it: the fade dissolves
 * the walls, it does not move them, so the box reaches exactly as far as it
 * always did and the count it spreads over is unchanged.
 */
const RAIN_BOX = 14;
const RAIN_HEIGHT = 10;

/**
 * How fast a drop falls, world units per second, and how far the wind carries
 * it as it does.
 *
 * 18 u/s against a hull that makes 10 at full throttle: rain falls faster
 * than the ship sails, which is what stops it reading as a curtain being
 * towed along. The drift is a fraction of the fall applied along the wind's
 * own direction, so a gale visibly slants the rain and a lull does not -- the
 * cheapest possible way to tie two systems together and one of the most
 * legible.
 */
const RAIN_FALL = 18;
const RAIN_DRIFT = 0.35;

/**
 * How long a drop is drawn, world units, and how bright.
 *
 * Rain photographs and renders as streaks rather than points because both a
 * camera and an eye integrate over time. 0.85 is about a quarter of the
 * hull's length: long enough to read as motion, short enough not to become
 * hail.
 *
 * Both numbers were raised (from 0.5 and 0.35) because the storm was the one
 * piece of weather nobody could see. A drop is one pixel wide whatever these
 * say -- WebGL ignores `linewidth`, so thickness is not available without
 * rebuilding every drop as a camera-facing quad -- which leaves length and
 * alpha as the only two levers that cost nothing, and is why they carry most
 * of the increase rather than the drop count.
 *
 * 0.6 is the alpha at the CENTRE of the box and the brightest a drop ever
 * gets; `RAIN_FADE` below takes it to nothing by the edge. It is deliberately
 * short of 1 because the drops are ADDITIVE and there are thousands of them,
 * and because a streak crossing the moon or a lit window adds to it: the
 * density does the work, not the individual drop.
 */
const RAIN_LENGTH = 0.85;
const RAIN_ALPHA = 0.6;

/**
 * Where the curtain starts fading out, as a fraction of the box's half-width.
 *
 * The box has always been a box, and at the alpha this module opened with
 * that did not matter: the drops were faint enough that nobody could see
 * where they stopped. Raising the alpha made the rain visible and made its
 * FOOTPRINT visible with it -- a hard-edged rectangle of streaks sitting on
 * the water around the hull with dry sea on all four sides, which reads as a
 * bug rather than as weather.
 *
 * So the drops dim toward a wall -- but only toward THREE of the four, and
 * that asymmetry is the whole trick. The box is heading-aligned (see the
 * basis `update` builds), so `-z` is the wall astern, and the chase camera
 * sits behind and above the ship looking through it. Perspective then makes
 * those astern drops the nearest thing to the lens and by far the largest
 * part of the curtain on screen -- while the wall itself, exactly as
 * `RAIN_BOX` above says, falls behind the camera where no one can see it end.
 *
 * Fade it and the storm goes with it. That is not a guess: a symmetric fade
 * was tried at 0.6 and at 0.8, and both dimmed the rain back to roughly what
 * it had been before the alpha was ever raised -- the change undone by its
 * own fix. A radial version, which additionally inscribes a disc and leaves a
 * blob of rain hanging round the mast, was worse still. Screenshots caught
 * all three; no test would have.
 *
 * So: the two side walls and the wall ahead dissolve, and the wall astern is
 * left alone because it is not visible to begin with. 0.7 puts the dissolve
 * over the outer 2.1 units, wide enough that a boundary reads as rain
 * thinning rather than as rain stopping.
 *
 * Cheap enough to be free: one varying off the lane the drop already carries,
 * constant along a streak because both its vertices share a lane, so there is
 * no gradient down a drop and no second attribute.
 */
const RAIN_FADE = 0.7;

/** Below this much rain the whole object is hidden, so fair weather costs no draw call. */
const RAIN_VISIBLE = 0.02;

/** A pale, slightly blue grey. Rain is not white; white reads as snow. */
const RAIN_COLOR = new THREE.Color('#c8d4e0');

const VERTEX_SHADER = [
  'uniform float uTime;',
  'uniform float uHeight;',
  'uniform vec3 uWindDrift;',
  'uniform float uLength;',
  'uniform float uHalf;',
  'uniform float uFade;',
  // Each drop's own lane. x, z are its position in the box; y is a phase
  // offset in [0, 1) so the drops do not all fall in step.
  'attribute vec3 aLane;',
  // 0 for the head of a segment, 1 for its tail: one attribute is all it
  // takes to turn a pair of vertices into a streak along the velocity.
  'attribute float aTail;',
  // How much of the curtain's alpha this drop keeps. See RAIN_FADE.
  'varying float vEdge;',
  'void main() {',
  '  // The drop dims as it nears a wall of the box, so the curtain has no',
  '  // edge to see. Three walls, not four: the box is heading-aligned, so',
  '  // -z is the wall ASTERN, the one the chase camera is looking through',
  '  // rather than at, and `max(aLane.z, 0.0)` is what exempts it. See',
  '  // RAIN_FADE. Measured on the LANE and not on the drifted position, so',
  '  // a drop the wind carries keeps its brightness the whole way down',
  '  // instead of flickering as it goes.',
  '  float wall = max(abs(aLane.x), max(aLane.z, 0.0)) / uHalf;',
  '  vEdge = 1.0 - smoothstep(uFade, 1.0, wall);',
  '  // How far this drop has fallen, wrapped into the box. `fract` is what',
  '  // recycles a drop from the ground back to the top with no CPU work and',
  '  // no per-drop state at all.',
  '  float fall = fract(aLane.y + uTime);',
  '  vec3 pos = vec3(aLane.x, fall * uHeight, aLane.z);',
  '  // The wind carries the drop sideways as it falls, so the streak leans',
  '  // and the whole curtain slants with the weather.',
  '  pos += uWindDrift * fall;',
  '  // The tail sits back along the drop\'s own velocity, which is down plus',
  '  // whatever the wind is doing to it.',
  '  vec3 velocity = normalize(vec3(0.0, -1.0, 0.0) * uHeight + uWindDrift);',
  '  pos -= velocity * (aTail * uLength);',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);',
  '}',
].join('\n');

const FRAGMENT_SHADER = [
  'uniform vec3 uColor;',
  'uniform float uOpacity;',
  'varying float vEdge;',
  'void main() {',
  '  float alpha = uOpacity * vEdge;',
  '  gl_FragColor = vec4(uColor * alpha, alpha);',
  '}',
].join('\n');

/**
 * The rain.
 *
 * `drops` is `quality.rainDrops`. At 0 the caller should not build this at
 * all -- see the quality table -- but building it anyway yields an empty
 * object that costs nothing, so a caller is never obliged to branch.
 */
export function createRain(drops: number): Rain {
  const object = new THREE.Group();
  object.name = 'rain';

  const count = Math.max(0, drops | 0);
  const positions = new Float32Array(count * 2 * 3);
  const lanes = new Float32Array(count * 2 * 3);
  const tails = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    const x = (Math.random() - 0.5) * RAIN_BOX;
    const z = (Math.random() - 0.5) * RAIN_BOX;
    const phase = Math.random();
    for (let v = 0; v < 2; v++) {
      const o = (i * 2 + v) * 3;
      lanes[o] = x;
      lanes[o + 1] = phase;
      lanes[o + 2] = z;
      tails[i * 2 + v] = v;
    }
  }

  const geometry = new THREE.BufferGeometry();
  // `position` is never read by the shader -- the lane and the tail flag are
  // what place a vertex -- but Three wants one to compute a bounding sphere
  // from, and a zeroed buffer would collapse that sphere to a point and let
  // the frustum cull the whole curtain the moment the ship's own origin left
  // the screen. So it carries the box's corners' worth of extent.
  for (let i = 0; i < count * 2; i++) {
    positions[i * 3] = lanes[i * 3];
    positions[i * 3 + 1] = RAIN_HEIGHT * 0.5;
    positions[i * 3 + 2] = lanes[i * 3 + 2];
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aLane', new THREE.BufferAttribute(lanes, 3));
  geometry.setAttribute('aTail', new THREE.BufferAttribute(tails, 1));

  const uniforms = {
    uTime: { value: 0 },
    uWindDrift: { value: new THREE.Vector3() },
    uHeight: { value: RAIN_HEIGHT },
    uLength: { value: RAIN_LENGTH },
    uHalf: { value: RAIN_BOX * 0.5 },
    uFade: { value: RAIN_FADE },
    uColor: { value: RAIN_COLOR.clone() },
    uOpacity: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'rain-drops';
  lines.frustumCulled = false;
  // LAYER_DEFAULT only, deliberately: the reflection cube is rendered from a
  // camera parked at the ship's own waterline, so rain drawn into it would
  // appear as streaks in the water directly under the hull -- rain reflected
  // in rain, at the one place the player is looking.
  lines.layers.set(LAYER_DEFAULT);
  object.add(lines);

  /** Scratch, so `update` allocates nothing. */
  const _up = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _matrix = new THREE.Matrix4();
  const _stb = new THREE.Vector3();

  let elapsed = 0;

  function update(dt: number, ship: ShipState, wind: WindState, weather: WeatherState): void {
    const rain = weather.rain;
    lines.visible = count > 0 && rain > RAIN_VISIBLE;
    if (!lines.visible) return;

    // The box hangs on the ship's own local vertical, so "down" means down
    // wherever on the globe the ship happens to be. Its centre sits at the
    // hull with the box's own half-height subtracted, so the drops fall
    // through the deck rather than starting at it.
    _up.copy(ship.up).normalize();
    _fwd.copy(ship.forward).addScaledVector(_up, -ship.forward.dot(_up));
    if (_fwd.lengthSq() < 1e-12) _fwd.set(0, 0, 1).addScaledVector(_up, -_up.z);
    _fwd.normalize();
    _stb.crossVectors(_fwd, _up).normalize();
    _matrix.makeBasis(_stb, _up, _fwd);
    _quat.setFromRotationMatrix(_matrix);
    object.quaternion.copy(_quat);
    // `ShipState.position` is a unit DIRECTION, not a world position, so the
    // box has to be pushed out to the water's own surface -- the same
    // `multiplyScalar(GLOBE_RADIUS)` every other follower does. The box's own
    // dimensions stay ship-scale and do not grow with the radius; only where
    // it is hung does.
    object.position.copy(ship.position).multiplyScalar(GLOBE_RADIUS);
    // And dropped by half its height, so the drops fall THROUGH the deck
    // rather than beginning at it.
    object.position.addScaledVector(_up, -RAIN_HEIGHT * 0.5);

    elapsed += dt;
    // Turns over once per RAIN_HEIGHT / RAIN_FALL seconds, which is what the
    // shader's `fract` wraps on.
    uniforms.uTime.value = (elapsed * RAIN_FALL) / RAIN_HEIGHT;
    uniforms.uOpacity.value = rain * RAIN_ALPHA;

    // The wind's own direction, resolved into the box's local axes: the
    // shader works in the box's frame and the wind is a world vector.
    const drift = RAIN_DRIFT * RAIN_HEIGHT * (wind.speed / RAIN_FALL);
    uniforms.uWindDrift.value.set(
      wind.direction.dot(_stb) * drift,
      0,
      wind.direction.dot(_fwd) * drift,
    );
  }

  return { object, update };
}
