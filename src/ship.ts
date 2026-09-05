import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Object3D } from 'three';
import type { InputState, ShipState, Terrain } from './types';
import { GLOBE_RADIUS, dirToLatLon, latLonToDir, normalizeHeadingDeg, tangentFrame } from './geo';

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/** Height of the hull waterline above the globe surface. */
const HULL_OFFSET = 0.6;

const ACCEL = 12; // world units / s^2 while a throttle key is held
const MAX_FORWARD = 18; // world units / s
const MAX_REVERSE = 7; // world units / s (magnitude)
const DRAG = 0.7; // linear drag coefficient (1/s)
const STOP_EPSILON = 0.02; // speeds below this snap to a dead stop

const TURN_RATE = 1.2; // rad / s at full speed
const TURN_MIN_SCALE = 0.55; // fraction of TURN_RATE still available at a standstill

/** How far ahead (world units) we probe for land so we stop before the coast. */
const LOOKAHEAD = 2.2;

const BOB_AMPLITUDE = 0.15; // world units
const SWAY_ROLL = 0.055; // rad (~3.1 deg)
const SWAY_PITCH = 0.035; // rad (~2.0 deg)
const TURN_BANK = 0.13; // rad of bank into a turn at full speed

const TWO_PI = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* Module-scope scratch (no per-frame allocation in the hot path)      */
/* ------------------------------------------------------------------ */

const _north = new Vector3();
const _east = new Vector3();
const _forward = new Vector3();
const _right = new Vector3();
const _back = new Vector3();
const _axis = new Vector3();
const _candidate = new Vector3();
const _probe = new Vector3();
const _basis = new Matrix4();
const _baseQuat = new Quaternion();
const _swayQuat = new Quaternion();
const _swayEuler = new Euler();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ------------------------------------------------------------------ */
/* Placeholder techno-punk pirate ship, primitives only                */
/* ------------------------------------------------------------------ */

/**
 * Builds the ship model. Convention: the bow points along local -Z, the deck
 * normal is local +Y and starboard is local +X, matching
 * `makeBasis(right, up, back)`. Overall length ~5.6 units (globe radius 100).
 */
function buildShipModel(): Group {
  const group = new Group();

  const hullMat = new MeshStandardMaterial({
    color: 0x4a2f1d,
    roughness: 0.85,
    metalness: 0.05,
    flatShading: true,
  });
  const trimMat = new MeshStandardMaterial({
    color: 0x8a5a32,
    roughness: 0.75,
    metalness: 0.1,
    flatShading: true,
  });
  const deckMat = new MeshStandardMaterial({
    color: 0x6b4526,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
  });
  const sailMat = new MeshStandardMaterial({
    color: 0xe8e2d0,
    roughness: 1,
    metalness: 0,
    side: DoubleSide,
    flatShading: true,
  });
  const neonCyan = new MeshStandardMaterial({
    color: 0x0a2a30,
    emissive: 0x22e6ff,
    emissiveIntensity: 2.2,
    roughness: 0.4,
    metalness: 0.2,
    flatShading: true,
  });
  const neonMagenta = new MeshStandardMaterial({
    color: 0x2a0a24,
    emissive: 0xff3ce0,
    emissiveIntensity: 2.6,
    roughness: 0.4,
    metalness: 0.2,
    flatShading: true,
  });

  // --- Hull: a box tapered into a prow by editing its vertex positions -----
  const hullGeo = new BoxGeometry(1.7, 1.05, 5, 2, 2, 6);
  {
    const pos = hullGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      let y = pos.getY(i);
      const z = pos.getZ(i);
      // f = 0 at the stern (z = +2.5), 1 at the bow (z = -2.5)
      const f = (2.5 - z) / 5;
      // Narrow sharply toward the bow, a little toward the stern.
      const bowTaper = 1 - 0.78 * f * f;
      const sternTaper = 1 - 0.22 * (1 - f) * (1 - f);
      pos.setX(i, x * bowTaper * sternTaper);
      // Rocker: lift the keel at both ends so the hull reads as a boat.
      if (y < 0) {
        y += 0.5 * f * f + 0.3 * (1 - f) * (1 - f);
        pos.setY(i, y);
      }
    }
    pos.needsUpdate = true;
    hullGeo.computeVertexNormals();
  }
  const hull = new Mesh(hullGeo, hullMat);
  hull.name = 'hull';
  group.add(hull);

  // --- Deck plate ---------------------------------------------------------
  const deck = new Mesh(new BoxGeometry(1.35, 0.08, 4), deckMat);
  deck.position.set(0, 0.54, 0.2);
  group.add(deck);

  // --- Raised stern castle ------------------------------------------------
  const stern = new Mesh(new BoxGeometry(1.35, 0.78, 1.25), trimMat);
  stern.position.set(0, 0.92, 1.75);
  group.add(stern);

  const sternRail = new Mesh(new BoxGeometry(1.45, 0.1, 1.35), hullMat);
  sternRail.position.set(0, 1.34, 1.75);
  group.add(sternRail);

  // --- Mast + yards -------------------------------------------------------
  const mast = new Mesh(new CylinderGeometry(0.075, 0.115, 3.7, 6), trimMat);
  mast.position.set(0, 2.15, -0.15);
  group.add(mast);

  const yard = new Mesh(new CylinderGeometry(0.05, 0.05, 2.3, 5), trimMat);
  yard.rotation.z = Math.PI / 2;
  yard.position.set(0, 3.15, -0.15);
  group.add(yard);

  // --- Sails (DoubleSide so they read from both tacks) --------------------
  const mainSail = new Mesh(new PlaneGeometry(2.1, 1.9, 3, 2), sailMat);
  mainSail.position.set(0, 2.25, -0.05);
  group.add(mainSail);

  const topSail = new Mesh(new PlaneGeometry(1.25, 0.85, 2, 1), sailMat);
  topSail.position.set(0, 3.55, -0.05);
  group.add(topSail);

  // --- Bowsprit: cylinder rotated so its axis points along -Z, tilted up ---
  const bowsprit = new Mesh(new CylinderGeometry(0.045, 0.07, 1.5, 5), trimMat);
  bowsprit.position.set(0, 0.62, -2.85);
  bowsprit.rotation.x = -Math.PI / 2 + 0.2;
  group.add(bowsprit);

  // --- Neon accents (techno-punk) -----------------------------------------
  for (const side of [-1, 1]) {
    const strip = new Mesh(new BoxGeometry(0.07, 0.11, 2.9), neonCyan);
    strip.position.set(side * 0.64, 0.3, 0.45);
    group.add(strip);
  }

  const prowGlow = new Mesh(new BoxGeometry(0.14, 0.14, 0.5), neonCyan);
  prowGlow.position.set(0, 0.42, -2.3);
  group.add(prowGlow);

  const lantern = new Mesh(new SphereGeometry(0.17, 8, 6), neonMagenta);
  lantern.position.set(0, 1.62, 1.75);
  group.add(lantern);

  const mastLight = new Mesh(new SphereGeometry(0.11, 6, 5), neonMagenta);
  mastLight.position.set(0, 4.02, -0.15);
  group.add(mastLight);

  return group;
}

/* ------------------------------------------------------------------ */
/* Ship                                                                */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only ShipState surface. */
interface MutableShipState {
  position: Vector3;
  up: Vector3;
  forward: Vector3;
  heading: number;
  headingDeg: number;
  speed: number;
  latDeg: number;
  lonDeg: number;
}

export interface Ship {
  object: Object3D;
  state: ShipState;
  update(dt: number, input: InputState): void;
}

export function createShip(
  terrain: Terrain,
  start?: { latDeg: number; lonDeg: number; headingDeg?: number },
): Ship {
  const startLat = start?.latDeg ?? 0;
  const startLon = start?.lonDeg ?? 0;
  const startHeading = ((start?.headingDeg ?? 90) * Math.PI) / 180;

  const object = new Group();
  object.name = 'ship';
  object.add(buildShipModel());

  const state: MutableShipState = {
    position: latLonToDir(startLat, startLon).normalize(),
    up: latLonToDir(startLat, startLon).normalize(),
    forward: new Vector3(),
    heading: ((startHeading % TWO_PI) + TWO_PI) % TWO_PI,
    headingDeg: normalizeHeadingDeg(startHeading),
    speed: 0,
    latDeg: startLat,
    lonDeg: startLon,
  };

  let elapsed = 0;
  let bob = 0;
  let bankRoll = 0;

  /**
   * Rebuilds `state.forward` from the current position + heading.
   * north/east come from geo.tangentFrame; heading 0 = north, +PI/2 = east.
   */
  function refreshForward(): void {
    tangentFrame(state.position, _north, _east);
    _forward
      .copy(_north)
      .multiplyScalar(Math.cos(state.heading))
      .addScaledVector(_east, Math.sin(state.heading));
    const len = _forward.length();
    if (len > 1e-8) _forward.multiplyScalar(1 / len);
    else _forward.copy(_north);
    state.forward.copy(_forward);
  }

  /**
   * Great-circle step. Rotating `from` by +angle around `axis = from x forward`
   * moves it toward `forward`, because (p x f) x p = f(p.p) - p(p.f) = f for an
   * orthonormal pair. Returns false if the axis is degenerate.
   */
  function stepAlong(out: Vector3, from: Vector3, angle: number): boolean {
    _axis.crossVectors(from, state.forward);
    if (_axis.lengthSq() < 1e-12) return false;
    _axis.normalize();
    out.copy(from).applyAxisAngle(_axis, angle).normalize();
    return true;
  }

  function syncStateGeo(): void {
    state.up.copy(state.position);
    state.headingDeg = normalizeHeadingDeg(state.heading);
    const ll = dirToLatLon(state.position);
    state.latDeg = ll.latDeg;
    state.lonDeg = ll.lonDeg;
  }

  function applyTransform(): void {
    // Base orientation, rebuilt from scratch every frame -> zero drift.
    // Local +X = starboard, +Y = surface normal, +Z = astern (bow is -Z).
    _right.crossVectors(state.forward, state.up);
    if (_right.lengthSq() < 1e-12) return;
    _right.normalize();
    _back.copy(state.forward).negate();
    _basis.makeBasis(_right, state.up, _back);
    _baseQuat.setFromRotationMatrix(_basis);

    const speedFrac = clamp(Math.abs(state.speed) / MAX_FORWARD, 0, 1);
    const amp = 0.45 + 0.55 * speedFrac;

    // Sway is applied AFTER the base orientation, in the ship's local space.
    const roll = Math.sin(elapsed * 1.15) * SWAY_ROLL * amp + bankRoll;
    const pitch = Math.sin(elapsed * 1.73 + 0.9) * SWAY_PITCH * amp;
    _swayEuler.set(pitch, 0, roll);
    _swayQuat.setFromEuler(_swayEuler);
    _baseQuat.multiply(_swayQuat);

    object.quaternion.copy(_baseQuat);
    object.position.copy(state.position).multiplyScalar(GLOBE_RADIUS + HULL_OFFSET + bob);
  }

  function update(dt: number, input: InputState): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    elapsed += dt;

    // ---- Steering: always allowed, even while beached --------------------
    let turnInput = 0;
    if (input.left) turnInput -= 1;
    if (input.right) turnInput += 1;

    const speedFrac = clamp(Math.abs(state.speed) / MAX_FORWARD, 0, 1);
    const turnRate = TURN_RATE * (TURN_MIN_SCALE + (1 - TURN_MIN_SCALE) * speedFrac);
    if (turnInput !== 0) {
      // Heading is clockwise-positive looking down at the surface from
      // outside, so right/D increases heading and the bow swings clockwise
      // from the player's chase-camera view.
      state.heading += turnInput * turnRate * dt;
      state.heading = ((state.heading % TWO_PI) + TWO_PI) % TWO_PI;
    }

    // Subtle bank into the turn, damped so it eases in and out.
    const bankTarget = -turnInput * TURN_BANK * (0.25 + 0.75 * speedFrac);
    bankRoll += (bankTarget - bankRoll) * (1 - Math.exp(-4 * dt));

    refreshForward();

    // ---- Throttle --------------------------------------------------------
    if (input.forward) state.speed += ACCEL * dt;
    if (input.backward) state.speed -= ACCEL * dt;

    // Linear drag, always on, so releasing the keys coasts to a stop.
    state.speed -= state.speed * DRAG * dt;
    state.speed = clamp(state.speed, -MAX_REVERSE, MAX_FORWARD);
    if (!input.forward && !input.backward && Math.abs(state.speed) < STOP_EPSILON) {
      state.speed = 0;
    }

    // ---- Move along the great circle, refusing to enter land -------------
    if (state.speed !== 0) {
      const angle = (state.speed * dt) / GLOBE_RADIUS;
      if (stepAlong(_candidate, state.position, angle)) {
        let blocked = terrain.isLand(_candidate);
        if (!blocked) {
          // Probe further along the direction of travel so we stop just short
          // of the coastline rather than clipping into it.
          const probeAngle = angle + (Math.sign(state.speed) * LOOKAHEAD) / GLOBE_RADIUS;
          if (stepAlong(_probe, state.position, probeAngle)) {
            blocked = terrain.isLand(_probe);
          }
        }
        if (blocked) {
          state.speed = 0; // beached: hold position; steering still works
        } else {
          state.position.copy(_candidate).normalize();
        }
      }
    }

    syncStateGeo();
    refreshForward(); // forward must match the committed position

    // ---- Idle motion ------------------------------------------------------
    const bobAmp = BOB_AMPLITUDE * (0.5 + 0.5 * clamp(Math.abs(state.speed) / MAX_FORWARD, 0, 1));
    bob = Math.sin(elapsed * 1.6) * bobAmp;

    applyTransform();
  }

  // Place the ship correctly before the first frame is drawn.
  refreshForward();
  syncStateGeo();
  applyTransform();

  return { object, state: state as ShipState, update };
}
