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
  /**
   * `camera` is optional, and what it buys is the whole reason the box is not
   * a fixed size any more: it is sized off that camera's own frustum, so it
   * covers the frame at every zoom AND at every window shape. See
   * `RAIN_COVER`. A PerspectiveCamera specifically, for `fov` and `aspect`.
   * Without one the box holds its authored dimensions, which is what a
   * headless caller wants and what every test gets.
   */
  update(
    dt: number,
    ship: ShipState,
    wind: WindState,
    weather: WeatherState,
    camera?: THREE.PerspectiveCamera,
  ): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants — all ship-scale                                    */
/* ------------------------------------------------------------------ */

/**
 * The box the drops live in, in the units its own lanes are laid out in.
 *
 * No longer a world size: `RAIN_COVER` below stretches the box to the frame
 * every frame, so what these two fix is the box's SHAPE -- 14 across by 10
 * tall, a footprint about seven parts wide to five deep -- and the units the
 * shader's `uHalf`, `uHeight` and `uLength` are quoted in. The world size is
 * whatever the camera asks for.
 *
 * They are still worth reading as world numbers for the one framing where the
 * scale lands near 1, because that is the shape the rest of the file was
 * judged at: 14 is four and a half hull lengths and 10 clears the masthead
 * with room for a drop to have been falling before it reaches the deck.
 *
 * What has NOT changed is the trap underneath: the box holds a FIXED number of
 * drops, so every unit of world size is paid for in density. Ten times across
 * is a hundred times the footprint and would want a hundred times the drops.
 * That is the whole reason `RAIN_COVER` is a fraction and not 1.
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

/**
 * How much of the frame the box is stretched to cover, as a fraction of the
 * frustum's own half-width at the hull.
 *
 * This is what replaced a fixed size, and the reason is the zoom. `camera.ts`
 * frames the hull from `hypot(NEAR_DISTANCE, NEAR_HEIGHT)` = hypot(21, 9.5)
 * ≈ 23 units at its closest and from `hypot(GLOBE_RADIUS * 0.9, GLOBE_RADIUS
 * * 0.55)` ≈ 211 at its furthest -- a NINE-FOLD range on a wheel the player
 * turns freely, opening at ≈ 38. A box of any fixed size is therefore correct
 * at exactly ONE framing and wrong at the other eight: authored for the deck,
 * it becomes a discrete column of rain standing on the boat the moment the
 * player pulls back, which is most of the time. Making it bigger only moves
 * which single zoom is right.
 *
 * Derived from the CAMERA'S OWN FRUSTUM rather than from a distance this file
 * guesses at, because the frame is not just a distance: at the same zoom, a
 * 21:9 monitor sees half again as much width as a 16:9 one, and a box sized
 * against either shows its walls on the other. `fov` and `aspect` are the
 * whole of what that takes and the camera is already carrying both.
 *
 * Below 1 on purpose. The box holds a FIXED number of drops, so every unit of
 * coverage is paid for in density -- covering the full half-width would spread
 * the same curtain over twice the area of covering 0.7 of it. This is the
 * point on that curve where the rain still reaches the edges of the frame and
 * is still thick enough to be weather; `quality.rainDrops` was raised with it,
 * and the two have to move together.
 */
const RAIN_COVER = 0.7;

/**
 * How far astern the curtain reaches, as a multiple of the camera's distance.
 *
 * Width and depth are not the same requirement and cannot share a number.
 * Width answers to the frame; DEPTH answers to where the camera is, because
 * the one stretch of rain the player is guaranteed to be looking through is
 * the stretch between the lens and the hull. Size the depth off the frame
 * instead and the box's astern wall lands short of the camera at every zoom --
 * 15 units against a camera 21 back at the closest framing, 25 against 38 at
 * the default -- and the whole foreground of every frame is dry water while
 * it rains on the middle distance. Which is the "box on top of the boat" read
 * in its last and most stubborn form.
 *
 * Just over 1, so the wall passes behind the lens rather than landing on it.
 * That is also what finally makes `RAIN_FADE`'s exemption of the astern wall
 * true by construction instead of true by luck.
 */
const RAIN_BEHIND = 1.15;

/**
 * The camera distance `RAIN_LENGTH` was judged at, world units.
 *
 * A streak has to keep its length ON SCREEN, which means growing in world
 * units as the camera pulls back -- but it must not also inherit `RAIN_COVER`,
 * or widening the box to fill the frame would lengthen every drop with it and
 * turn the rain into scratches. So the box's scale and the drop's are computed
 * separately and the shader is handed a length that cancels the difference.
 *
 * 38 is the framing the game opens on, which is where 0.85 was chosen, so the
 * default view is unchanged by any of this.
 */
const RAIN_LENGTH_REF = 38;

/**
 * Where the rain fades out entirely, world units of camera distance.
 *
 * Rain is a thing you stand IN, and past the first quarter of the zoom the
 * player is not standing in anything -- the camera is beyond the ship's own
 * visibility (`RADAR_RANGE` is 50) and looking DOWN at the weather. A storm
 * from up there is the darkened cloud deck and the thickened haze that
 * `clouds.ts` and `fog.ts` already draw, and streaks over the top of those are
 * the one thing that gives the box away.
 *
 * 45 is a little past the framing the game opens on, so an ordinary look
 * around costs nothing; by 90 the curtain is gone. Set at 70 and 130 first,
 * and the shot that moved them showed why: at the mid zoom the widened box
 * throws drops out past the planet's own limb, and rain falling through empty
 * space is worse than no rain at all.
 *
 * The spread stops climbing at the far end too, because that is the last
 * distance anything is drawn from.
 */
const RAIN_FAR_IN = 45;
const RAIN_FAR_OUT = 90;

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
  'uniform vec2 uSpread;',
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
  '  // The lane is where the drop lives in the box; uSpread is how wide the',
  '  // box is this frame -- x across the frame, y astern-to-ahead, and they',
  '  // are different numbers. HORIZONTAL only, and that is the whole point:',
  '  // the curtain has to reach the frame and the lens, but its HEIGHT is',
  '  // physical -- the',
  '  // cloud base is 4.8 units over the water and no camera moves it -- and',
  '  // so are the fall, the drift and the streak below, all of which stay in',
  '  // world units at the values they were judged at.',
  '  vec3 pos = vec3(aLane.x * uSpread.x, fall * uHeight, aLane.z * uSpread.y);',
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
    uSpread: { value: new THREE.Vector2(1, 1) },
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

  function update(
    dt: number,
    ship: ShipState,
    wind: WindState,
    weather: WeatherState,
    camera?: THREE.PerspectiveCamera,
  ): void {
    const rain = weather.rain;
    lines.visible = count > 0 && rain > RAIN_VISIBLE;
    if (!lines.visible) return;

    // The box hangs on the ship's own local vertical, so "down" means down
    // wherever on the globe the ship happens to be, and on the ship's heading,
    // so `+z` is ahead and `-z` astern -- which is what lets both `RAIN_FADE`
    // and `RAIN_BEHIND` talk about the wall the camera is behind. Where its
    // centre ends up is settled further down, once the camera has said how big
    // the box is; it is neither at the hull nor on the water.
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

    // ---- How big the box is this frame, and whether it is drawn at all ----
    //
    // Measured from the box's anchor to the camera rather than read off the
    // camera's own zoom, because the zoom is a damped fraction and this wants
    // the distance the frame is actually being drawn at. Capped at the far
    // fade, which is the last distance anything is drawn from, so the box
    // stops growing exactly where it stops being visible. With no camera at
    // all the box keeps its authored size, which is what a headless caller
    // wants and what every test still gets.
    const distance = camera
      ? Math.min(camera.position.distanceTo(object.position), RAIN_FAR_OUT)
      : RAIN_LENGTH_REF;
    // The frustum's own half-width where the hull is. See `RAIN_COVER`.
    const halfFrame = camera
      ? distance * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect
      : RAIN_BOX * 0.5;
    // Never below 1: the camera dips inside its own framing while the damping
    // catches up on a hard turn, and a curtain that narrowed there would thin
    // the rain at the one moment the player is looking hardest at it.
    //
    // Handed to the SHADER and not to `object.scale`, which is what this was
    // first written as and is worth recording as the trap: a group scale is
    // uniform, so it stretched the box's HEIGHT too -- ten units became fifty,
    // the drops spanned twenty-five above the masthead to twenty-five under
    // the keel, and all that showed above the water was a thin band with dry
    // sea beneath it. The height is physical and belongs to the cloud base;
    // only the footprint answers to the camera.
    const half = RAIN_BOX * 0.5;
    const wide = Math.max(half, halfFrame * RAIN_COVER);
    // Astern to just past the lens, ahead as far as the curtain is wide. The
    // box is no longer symmetric about the hull, so it carries its own centre.
    const astern = -distance * RAIN_BEHIND;
    const ahead = wide;
    const deep = Math.max(half, (ahead - astern) * 0.5);
    uniforms.uSpread.value.set(wide / half, deep / half);

    // Dropped by half its height, so the drops fall THROUGH the deck rather
    // than beginning at it. Unscaled, like the height it is half of.
    object.position.addScaledVector(_up, -RAIN_HEIGHT * 0.5);
    // And shifted astern onto the box's own centre, which is behind the hull
    // now that the curtain reaches further back than forward.
    object.position.addScaledVector(_fwd, (astern + ahead) * 0.5);

    elapsed += dt;
    // Turns over once per RAIN_HEIGHT / RAIN_FALL seconds, which is what the
    // shader's `fract` wraps on. Untouched by the spread, because the height
    // is: a drop falls 18 u/s at every zoom.
    uniforms.uTime.value = (elapsed * RAIN_FALL) / RAIN_HEIGHT;
    // The streak grows with the camera's distance so it keeps its length ON
    // SCREEN, and takes nothing from the spread -- widening the curtain to
    // fill the frame must not lengthen every drop in it. See
    // `RAIN_LENGTH_REF`.
    uniforms.uLength.value = RAIN_LENGTH * (distance / RAIN_LENGTH_REF);
    // The far fade is a plain ramp and not a smoothstep: it runs over 60 units
    // of camera travel that take seconds of wheel to cross, so there is no
    // edge to soften and an ease here would only make the rain hang around
    // longer at the top of the band, which is where it is least wanted.
    const far =
      distance <= RAIN_FAR_IN
        ? 1
        : Math.max(0, 1 - (distance - RAIN_FAR_IN) / (RAIN_FAR_OUT - RAIN_FAR_IN));
    uniforms.uOpacity.value = rain * RAIN_ALPHA * far;
    // And once the fade has run out the object goes with it, on the same terms
    // as `RAIN_VISIBLE`: an orbital frame should not be submitting fifty
    // thousand vertices at zero alpha to draw nothing.
    if (far <= 0) lines.visible = false;

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
