import { PerspectiveCamera, Vector3 } from 'three';
import type { InputState, ShipState } from './types';
import { GLOBE_RADIUS } from './geo';

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Matches ship.ts's HULL_OFFSET so the camera targets the actual hull. */
const SHIP_ALTITUDE = 0.6;

/**
 * Closest framing: tight over-the-shoulder chase view.
 *
 * Ship-scale, so these are absolute and do not move with GLOBE_RADIUS. The
 * hull should look the same up close on any size of world.
 *
 * Exported because `fogbank.ts` derives the clear air it keeps around the ship
 * from `NEAR_DISTANCE`, and the derivation is not a nicety: the chase camera
 * sits that far back HORIZONTALLY and inside the fog layer, so a clearing
 * narrower than this setback cannot reach the middle of the camera's own line
 * of sight, which is where the fog on it is thickest. Reading the number
 * rather than copying it means moving the chase framing moves the clearing.
 */
export const NEAR_DISTANCE = 21;
export const NEAR_HEIGHT = 9.5;
/**
 * Furthest framing: high, near-orbital look at the planet.
 *
 * World-scale: pulling back a fixed 90 units from a globe twice the size would
 * frame half as much of it and lose the orbital shot entirely. Tracking the
 * radius keeps the same view of the planet, which now holds four times the
 * surface -- and the ship, four times smaller in it.
 */
const FAR_DISTANCE = GLOBE_RADIUS * 0.9;
const FAR_HEIGHT = GLOBE_RADIUS * 0.55;

/**
 * Zoom the game opens on, 0 = closest framing and 1 = furthest.
 *
 * A fixed *distance*, not a fixed fraction of the range: the far end tracks
 * GLOBE_RADIUS, so holding the fraction would have pushed the camera back with
 * the planet and quietly reframed the game. 0.08 of 21..GLOBE_RADIUS*0.9 is the
 * same 33 units back and 17 up the game opened on before the world grew.
 */
export const OPENING_ZOOM = 0.08;

/**
 * The chase camera's resting field of view, degrees.
 *
 * Named rather than left as the literal the constructor used to carry, because
 * `kick` now offsets it and a kick that decayed back to a different number
 * than the one the camera was built with would leave the world permanently a
 * degree wider than it started.
 */
export const BASE_FOV = 55;

/** How far a full-strength kick widens the field of view, degrees. */
export const KICK_FOV = 4;

/** How fast a kick decays. Mostly gone in about two hundred milliseconds. */
export const KICK_DAMP = 9;

/**
 * How far the chase camera sits from the globe's CENTRE at the opening framing.
 *
 * Exported for one reason, and it is not the camera's: on a planet this small
 * the drawn horizon is nowhere near eye level, and how far below it sits is a
 * function of exactly this distance. `horizon.ts` turns it into the elevation
 * the sun's disc has to reach to clear the sea, which is what `solartime.ts`
 * calls daybreak and what `daynight.ts` grades the light against.
 *
 * Derived here rather than measured there, so retuning the chase framing moves
 * the horizon with it instead of leaving the sun rising at the old angle.
 */
export const CHASE_CAMERA_RADIUS = Math.hypot(
  GLOBE_RADIUS + SHIP_ALTITUDE + lerp(NEAR_HEIGHT, FAR_HEIGHT, OPENING_ZOOM),
  lerp(NEAR_DISTANCE, FAR_DISTANCE, OPENING_ZOOM),
);

/** How far ahead of the bow the camera aims, and how far above the deck. */
const LOOK_AHEAD = 6;
const LOOK_UP = 1.5;

/** Exponential damping rates (higher = snappier). */
const POSITION_DAMP = 4.5;
const TARGET_DAMP = 6;
const UP_DAMP = 6;
const ZOOM_DAMP = 8;

/** Zoom units gained per wheel notch. Full near->far sweep takes ~8 notches. */
const ZOOM_SENSITIVITY = 0.12;

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

const _shipWorld = new Vector3();
const _desiredPos = new Vector3();
const _desiredTarget = new Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface FollowCamera {
  camera: PerspectiveCamera;
  update(dt: number, ship: ShipState, input: InputState): void;
  /**
   * Puts the camera at this frame's destination immediately, with no damping.
   *
   * For the one event that moves the ship without sailing it there: the
   * respawn after a maelstrom. The damping below is a rate, not a distance, so
   * a hull teleported across the planet would be chased across it — a second
   * of the whole world streaking past under a fade that is only just lifting.
   * The zoom is left alone; it is the player's setting and did not move.
   */
  snap(ship: ShipState): void;
  /**
   * A jolt, for a thing that just hit hard. `amount` is 0..1 and saturates.
   *
   * Widens the field of view by up to `KICK_FOV` and lets it decay back, which
   * reads as the world lurching toward the player. It deliberately does NOT
   * move the rig: the rig is damped toward a destination computed from the
   * hull every frame, so a displacement would be chased back over several
   * frames and would fight the damping rather than decay cleanly. A field of
   * view has no destination and no damping, so it is the one channel a kick
   * can use without arguing with the chase.
   *
   * Additive and clamped rather than assigned, so two strikes in quick
   * succession are one bigger jolt instead of the second cancelling the first.
   */
  kick(amount: number): void;
  resize(aspect: number): void;
}

/**
 * Chase camera that rides the sphere with the ship: it sits behind and above
 * the hull, aims slightly ahead of the bow, and keeps its own `up` locked to
 * the local surface normal so the horizon never flips near the poles.
 */
export function createFollowCamera(aspect: number): FollowCamera {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const camera = new PerspectiveCamera(BASE_FOV, safeAspect, 0.1, 6000);

  // Smoothed state.
  const smoothPos = new Vector3();
  const smoothTarget = new Vector3();
  const smoothUp = new Vector3(0, 1, 0);

  /** 0 = closest framing, 1 = furthest. See OPENING_ZOOM. */
  let zoomTarget = OPENING_ZOOM;
  let zoom = zoomTarget;
  let initialized = false;

  /** 0..1, raised by `kick` and decayed by `update`. See `FollowCamera.kick`. */
  let kickAmount = 0;
  /** The field of view the projection currently carries, to avoid a rebuild. */
  let appliedFov = BASE_FOV;

  function update(dt: number, ship: ShipState, input: InputState): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    // ---- Zoom (input.zoomDelta is reset by controls.endFrame, not here) ---
    const notches = input?.zoomDelta ?? 0;
    if (Number.isFinite(notches) && notches !== 0) {
      // zoomDelta is already in wheel notches (see InputState in types.ts).
      zoomTarget = clamp(zoomTarget + notches * ZOOM_SENSITIVITY, 0, 1);
    }
    zoom += (zoomTarget - zoom) * (dt > 0 ? 1 - Math.exp(-ZOOM_DAMP * dt) : 1);

    // Distance and height interpolate together, so the camera tilts more
    // top-down as it pulls back.
    const distance = lerp(NEAR_DISTANCE, FAR_DISTANCE, zoom);
    const height = lerp(NEAR_HEIGHT, FAR_HEIGHT, zoom);

    // ---- Frame vectors, guarded against degenerate input -----------------
    const up = ship.up.lengthSq() > 1e-8 ? ship.up : ship.position;
    _shipWorld.copy(ship.position).multiplyScalar(GLOBE_RADIUS + SHIP_ALTITUDE);

    const forward = ship.forward;
    const hasForward = forward.lengthSq() > 1e-8;

    _desiredPos.copy(_shipWorld).addScaledVector(up, height);
    if (hasForward) _desiredPos.addScaledVector(forward, -distance);

    _desiredTarget.copy(_shipWorld).addScaledVector(up, LOOK_UP);
    if (hasForward) _desiredTarget.addScaledVector(forward, LOOK_AHEAD);

    if (!initialized) {
      // Snap on the first update so there is no fly-in shot.
      smoothPos.copy(_desiredPos);
      smoothTarget.copy(_desiredTarget);
      smoothUp.copy(up);
      initialized = true;
    } else if (dt > 0) {
      smoothPos.lerp(_desiredPos, 1 - Math.exp(-POSITION_DAMP * dt));
      smoothTarget.lerp(_desiredTarget, 1 - Math.exp(-TARGET_DAMP * dt));
      smoothUp.lerp(up, 1 - Math.exp(-UP_DAMP * dt));
      if (smoothUp.lengthSq() < 1e-8) smoothUp.copy(up);
      smoothUp.normalize();
    }

    camera.position.copy(smoothPos);
    camera.up.copy(smoothUp);
    // Degenerate lookAt (camera sitting on its target) would produce NaNs.
    if (camera.position.distanceToSquared(smoothTarget) > 1e-8) {
      camera.lookAt(smoothTarget);
    }

    /*
     * The kick's decay, last, so the projection is rebuilt at most once a
     * frame and only on the frames a kick is actually live. An exponential
     * rather than a linear fall: a jolt should be mostly gone within a couple
     * of hundred milliseconds and entirely gone without a visible arrival.
     */
    if (kickAmount > 0) {
      kickAmount *= Math.exp(-KICK_DAMP * dt);
      if (kickAmount < 1e-3) kickAmount = 0;
    }
    const wantFov = BASE_FOV + KICK_FOV * kickAmount;
    if (Math.abs(wantFov - appliedFov) > 1e-4) {
      appliedFov = wantFov;
      camera.fov = wantFov;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * See `FollowCamera.snap`. Deliberately the same destinations `update`
   * computes and not a second framing: the two would drift apart the first
   * time either was retuned, and the symptom — a camera that jumps a little on
   * every respawn — would be blamed on the teleport rather than on the copy.
   */
  function snap(ship: ShipState): void {
    const up = ship.up.lengthSq() > 1e-8 ? ship.up : ship.position;
    _shipWorld.copy(ship.position).multiplyScalar(GLOBE_RADIUS + SHIP_ALTITUDE);

    const distance = lerp(NEAR_DISTANCE, FAR_DISTANCE, zoom);
    const height = lerp(NEAR_HEIGHT, FAR_HEIGHT, zoom);
    const forward = ship.forward;
    const hasForward = forward.lengthSq() > 1e-8;

    _desiredPos.copy(_shipWorld).addScaledVector(up, height);
    if (hasForward) _desiredPos.addScaledVector(forward, -distance);
    _desiredTarget.copy(_shipWorld).addScaledVector(up, LOOK_UP);
    if (hasForward) _desiredTarget.addScaledVector(forward, LOOK_AHEAD);

    smoothPos.copy(_desiredPos);
    smoothTarget.copy(_desiredTarget);
    smoothUp.copy(up).normalize();
    // Marked settled, so the next `update` damps from here rather than
    // snapping a second time -- and so a snap before the first frame is not
    // undone by `initialized` firing after it.
    initialized = true;

    camera.position.copy(smoothPos);
    camera.up.copy(smoothUp);
    if (camera.position.distanceToSquared(smoothTarget) > 1e-8) {
      camera.lookAt(smoothTarget);
    }
  }

  function kick(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    kickAmount = Math.min(1, kickAmount + amount);
  }

  function resize(newAspect: number): void {
    if (!(newAspect > 0) || !Number.isFinite(newAspect)) return;
    camera.aspect = newAspect;
    camera.updateProjectionMatrix();
  }

  return { camera, update, snap, resize, kick };
}
