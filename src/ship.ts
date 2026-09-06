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
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BufferGeometry, Material, Object3D } from 'three';
import type { InputState, ShipState, Terrain } from './types';
import { GLOBE_RADIUS, dirToLatLon, latLonToDir, normalizeHeadingDeg, tangentFrame } from './geo';
import { createShipFx } from './shipfx';
import type { ShipFx } from './shipfx';
import shipModelUrl from '../assets/pirateship_beginner.glb?url';

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * Height of the ship's local origin above the globe surface.
 *
 * `camera.ts` mirrors this in SHIP_ALTITUDE to aim at the hull, so the two
 * have to move together. It is a mounting height, not the waterline -- see
 * MODEL_WATERLINE_Y for where the sea actually cuts the glTF hull.
 */
const HULL_OFFSET = 0.6;

/**
 * Model-space Y at which the glTF hull is meant to meet the water.
 *
 * `tools/build_ship.py` puts y = 0 on the deck reference plane: the keel
 * bottoms out around -0.49 (appendages reach -0.69) and the gunwale runs
 * +0.44 amidships to +0.90 at the ends. Floating it therefore means sinking
 * the model into the group rather than standing it on the origin, which is
 * what MODEL_MOUNT_Y below does. Raise this number to sit deeper in the
 * water, lower it to ride lighter.
 */
const MODEL_WATERLINE_Y = -0.2;

/** Where the glTF root hangs inside the ship group, so its waterline lands on the sea. */
const MODEL_MOUNT_Y = -HULL_OFFSET - MODEL_WATERLINE_Y;

/**
 * Top speed, world units per second, which `hud.ts` reads out as 20.0 kn.
 *
 * Drag, not the clamp below, is what actually decides this. Thrust and drag
 * balance at ACCEL / DRAG, so that ratio *is* the top speed and the clamp only
 * ever catches the last fraction of a knot -- which is why ACCEL is derived
 * from this rather than typed. Set independently they disagree silently: at
 * ACCEL 12 and DRAG 0.7 the ship topped out at 17.1 however high the clamp was
 * set, and the number in this constant was simply never reached.
 */
const MAX_FORWARD = 20;
/** Linear drag coefficient, 1/s. Also sets how long the ship coasts. */
const DRAG = 0.7;
/** Thrust while a throttle key is held, world units / s^2. */
const ACCEL = MAX_FORWARD * DRAG;

const MAX_REVERSE = 7; // world units / s (magnitude); clamp-limited, not drag-limited
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
/* Stand-in hull, primitives only, shown while the glTF streams in     */
/* ------------------------------------------------------------------ */

/**
 * Builds a rough stand-in hull, used for the fraction of a second before
 * `pirateship_beginner.glb` finishes loading -- and kept on screen if that
 * load ever fails, so a missing asset costs detail rather than the ship.
 *
 * Convention, shared with the glTF: the bow points along local -Z, the deck
 * normal is local +Y and starboard is local +X, matching
 * `makeBasis(right, up, back)`. Overall length ~5.6 units (globe radius 100).
 */
function buildStandInHull(): Group {
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
  /**
   * Settles once the glTF hull has replaced the stand-in, or once that load
   * has failed and the stand-in is staying. Never rejects. `main.ts` waits on
   * it to hand the new materials to the post-processing chain.
   */
  ready: Promise<void>;
  update(dt: number, input: InputState): void;
}

/** Frees a subtree's GPU resources. Only ever used on the discarded stand-in. */
function disposeTree(root: Object3D): void {
  root.traverse((node) => {
    const holder = node as unknown as {
      geometry?: BufferGeometry;
      material?: Material | Material[];
    };
    holder.geometry?.dispose();
    const material = holder.material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) m.dispose();
  });
}

/**
 * Swaps the stand-in for `assets/pirateship_beginner.glb`.
 *
 * The glTF is authored to this module's axis convention already (see the
 * module docstring in `tools/build_ship.py`), so it needs no rotation and no
 * scaling -- only the vertical mount that puts its waterline on the sea.
 *
 * `shipfx.ts` then takes the loaded model over: it sharpens the tiled maps and
 * claims the nodes the build script kept separate for the game to animate. That
 * has to happen here, before `ready` resolves, because `main.ts` hands the
 * model to the post-processing chain on that promise and the materials must be
 * final by then.
 */
function loadHull(
  object: Group,
  standIn: Group,
  maxAnisotropy: number,
  onFx: (fx: ShipFx) => void,
): Promise<void> {
  return new GLTFLoader()
    .loadAsync(shipModelUrl)
    .then((gltf) => {
      const model = gltf.scene;
      model.name = 'ship-hull';
      model.position.y = MODEL_MOUNT_Y;
      onFx(createShipFx(model, maxAnisotropy));
      object.add(model);
      object.remove(standIn);
      disposeTree(standIn);
    })
    .catch((error: unknown) => {
      // A ship that is ugly still sails; a ship that throws does not.
      console.error('ship: could not load the glTF hull, keeping the stand-in', error);
    });
}

/**
 * @param maxAnisotropy the renderer's `capabilities.getMaxAnisotropy()`, passed
 *   in rather than read here because this module never sees the renderer. It is
 *   what keeps the model's tiled deck and hull maps from mushing out at the
 *   grazing angles the chase camera looks along.
 */
export function createShip(
  terrain: Terrain,
  start?: { latDeg: number; lonDeg: number; headingDeg?: number },
  maxAnisotropy = 1,
): Ship {
  const startLat = start?.latDeg ?? 0;
  const startLon = start?.lonDeg ?? 0;
  const startHeading = ((start?.headingDeg ?? 90) * Math.PI) / 180;

  const object = new Group();
  object.name = 'ship';
  const standIn = buildStandInHull();
  object.add(standIn);
  // Null until the glTF lands, and stays null if the load fails -- the stand-in
  // has none of the parts it drives.
  let fx: ShipFx | null = null;
  const ready = loadHull(object, standIn, maxAnisotropy, (loaded) => {
    fx = loaded;
  });

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
    let thrust = 0;
    if (input.forward) thrust += ACCEL;
    if (input.backward) thrust -= ACCEL;

    // Exact solution of  ds/dt = thrust - DRAG * s  over dt, rather than a
    // step of each in turn. Two reasons it has to be integrated in closed
    // form. It makes the top speed exactly thrust / DRAG: stepping thrust and
    // then drag lands on (ACCEL / DRAG) * (1 - DRAG * dt) instead, which is
    // 19.8 kn at 60fps and 18.6 at 10 -- a top speed that depends on the frame
    // rate. And with no throttle it decays cleanly to zero, so releasing the
    // keys still coasts the ship to a stop.
    const terminal = thrust / DRAG;
    state.speed = terminal + (state.speed - terminal) * Math.exp(-DRAG * dt);
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
    const driveFrac = clamp(Math.abs(state.speed) / MAX_FORWARD, 0, 1);
    const bobAmp = BOB_AMPLITUDE * (0.5 + 0.5 * driveFrac);
    bob = Math.sin(elapsed * 1.6) * bobAmp;

    applyTransform();

    // ---- Sail, flag and neon, on the committed speed ----------------------
    fx?.update(dt, driveFrac, (input.forward ? 1 : 0) - (input.backward ? 1 : 0));
  }

  // Place the ship correctly before the first frame is drawn.
  refreshForward();
  syncStateGeo();
  applyTransform();

  return { object, state: state as ShipState, ready, update };
}
