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
import type { EnergyState, InputState, ShipState, Terrain, WindState } from './types';
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
 *
 * Exported because `energy.ts` divides the burn by it: the draw is quadratic in
 * (speed / MAX_FORWARD), so a copy of the 20 over there would mean a top-speed
 * change quietly retuning the whole fuel economy instead of moving with it.
 */
export const MAX_FORWARD = 20;
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
const _starboard = new Vector3();
const _velocity = new Vector3();
const _course = new Vector3();
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
  groundSpeed: number;
  velocity: Vector3;
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
  /**
   * `energy` gates thrust: a dry tank still steers, coasts and drifts.
   * `wind` supplies the push the hull is carried by on top of its own engine.
   */
  update(dt: number, input: InputState, energy: EnergyState, wind: WindState): void;
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
    groundSpeed: 0,
    velocity: new Vector3(),
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
   * Great-circle step along the unit tangent `dir`. Rotating `from` by +angle
   * around `axis = from x dir` moves it toward `dir`, because
   * (p x d) x p = d(p.d) - p(p.d) = d for an orthonormal pair. Returns false if
   * the axis is degenerate.
   *
   * `dir` is the direction of TRAVEL, which is no longer always `forward`: a
   * beam wind carries the hull sideways while the bow holds its heading, so
   * the caller decides which direction is being walked.
   */
  function stepAlong(out: Vector3, from: Vector3, dir: Vector3, angle: number): boolean {
    _axis.crossVectors(from, dir);
    if (_axis.lengthSq() < 1e-12) return false;
    _axis.normalize();
    out.copy(from).applyAxisAngle(_axis, angle).normalize();
    return true;
  }

  /**
   * Walks one step of `angle` along `dir` and commits it, unless that would put
   * the hull on land. Returns whether the ship moved; nothing is written when
   * it did not.
   *
   * The LOOKAHEAD probe runs along the same direction, so we stop just short of
   * a coastline rather than clipping into it. Because `dir` is always the
   * direction of travel and `angle` is always positive, the probe no longer
   * needs the sign of the speed the way it did when everything was walked along
   * the bow: going astern is now a `dir` of -forward.
   */
  function tryStep(dir: Vector3, angle: number): boolean {
    if (!stepAlong(_candidate, state.position, dir, angle)) return false;
    let blocked = terrain.isLand(_candidate);
    if (!blocked && stepAlong(_probe, state.position, dir, angle + LOOKAHEAD / GLOBE_RADIUS)) {
      blocked = terrain.isLand(_probe);
    }
    if (blocked) return false;
    state.position.copy(_candidate).normalize();
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

  function update(dt: number, input: InputState, energy: EnergyState, wind: WindState): void {
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
    // A dry tank cuts thrust in both directions and nothing else. Steering,
    // drag, the bob and sway, the land probe and the sea all keep running
    // below, so the ship coasts to a stop and still answers the helm -- being
    // out of charge is a predicament, never a frozen frame. The player can
    // always turn the hull, and the panels bring it back.
    let thrust = 0;
    if (energy.canThrust) {
      if (input.forward) thrust += ACCEL;
      if (input.backward) thrust -= ACCEL;
    }

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
    // Snap on the absence of THRUST, not on the absence of input. The two are
    // the same key press until the tank runs dry, and then they are not: a
    // player holding W on a dead ship gets thrust 0, and the exponential above
    // decays toward zero without ever arriving. Testing the keys instead would
    // leave `speed` at 1e-9 for as long as the key was held -- under way by no
    // measure a player can see, but never `=== 0`, which is exactly the test
    // `energy.ts` uses to decide the panels are deployed. The ship would sit
    // there refusing to charge, and nothing on screen would say why.
    if (thrust === 0 && Math.abs(state.speed) < STOP_EPSILON) {
      state.speed = 0;
    }

    // ---- Ground velocity: the engine along the bow, plus the wind ---------
    // `state.speed` is the engine and only the engine. What the hull does over
    // the ground is that plus the eased push `wind.ts` resolved this frame,
    // and adding it as a VELOCITY rather than as a turning force is what gives
    // a beam wind real leeway: the bow holds its heading and the ship crabs
    // off its course, which the wake behind it will show.
    _starboard.crossVectors(state.forward, state.up);
    if (_starboard.lengthSq() > 1e-12) _starboard.normalize();
    else _starboard.set(0, 0, 0);

    _velocity
      .copy(state.forward)
      .multiplyScalar(state.speed + wind.along)
      .addScaledVector(_starboard, wind.across);

    const groundMag = _velocity.length();

    // ---- Move along the ground velocity, refusing to enter land ----------
    if (groundMag > 1e-9) {
      _course.copy(_velocity).multiplyScalar(1 / groundMag);
      if (!tryStep(_course, (groundMag * dt) / GLOBE_RADIUS)) {
        // Blocked on the combined course. A beam wind pinning the hull against
        // a coast must not also stop it sailing ALONG that coast, so try the
        // engine alone before giving up -- otherwise a player with a shore to
        // leeward loses the helm entirely until the wind drops.
        let freed = false;
        if (state.speed !== 0) {
          _course.copy(state.forward).multiplyScalar(Math.sign(state.speed));
          freed = tryStep(_course, (Math.abs(state.speed) * dt) / GLOBE_RADIUS);
        }
        if (freed) {
          // Sailing along the coast under engine alone. The leeway was refused
          // by the land, so it must not survive into what we report.
          _velocity.copy(state.forward).multiplyScalar(state.speed);
        } else {
          // Only now is it truly beached: hold position; steering still works.
          state.speed = 0;
          _velocity.set(0, 0, 0);
        }
      }
    }

    // Written from what the hull COMMITTED, never from what it attempted. The
    // land refuses steps after the velocity above is built, and reporting the
    // attempt would leave a ship hard aground reading a knot and a half on the
    // HUD -- and would hand that phantom way to `energy.ts`, which decides
    // whether a berth may connect on this very number.
    const committed = _velocity.length();
    state.velocity.copy(_velocity);
    // Signed by the forward component rather than by Math.sign of it: a ship
    // making pure leeway has no forward component at all, and calling that
    // stopped would hand `energy.ts` a berth it had not earned.
    state.groundSpeed = _velocity.dot(state.forward) >= 0 ? committed : -committed;

    syncStateGeo();
    refreshForward(); // forward must match the committed position

    // ---- Idle motion ------------------------------------------------------
    const driveFrac = clamp(Math.abs(state.speed) / MAX_FORWARD, 0, 1);
    const bobAmp = BOB_AMPLITUDE * (0.5 + 0.5 * driveFrac);
    bob = Math.sin(elapsed * 1.6) * bobAmp;

    applyTransform();

    // ---- Sail, flag and neon, on the committed speed and the charge --------
    // The throttle passed on is the raw key press. `canThrust` is handed over
    // beside it and is the single place the flames answer to power, so zeroing
    // the throttle here as well would cut the same thing twice and fight the
    // fade `shipfx.ts` puts on it.
    // Apparent wind, resolved in the ship's own frame. Both terms are already
    // in that frame -- the ground velocity built above is exactly
    // (speed + wind.along) forward and wind.across to starboard -- so this
    // needs no vectors, and it uses the true bearing rather than the quantised
    // sector because the eye is better at angles than the hull is.
    //
    // In a flat calm at 20 kn this comes out as 20 kn from dead ahead, and the
    // sail only takes on extra belly once a following wind is outrunning the
    // ship.
    //
    // Note this DOES change the hull's look, whatever `docs/WIND_PLAN.md` says
    // about it matching the old behaviour: before there was weather the flag
    // leaned toward the bow, because the model was authored around a permanent
    // following wind. Under an apparent wind a ship making way in a calm has
    // the air coming over its bow, so the flag now lies astern. That is the
    // physical answer and the one the plan asked for; the plan was simply
    // wrong about which way the old flag pointed.
    const relative = wind.bearing - state.heading;
    const apparentAlong = wind.speed * Math.cos(relative) - (state.speed + wind.along);
    const apparentAcross = wind.speed * Math.sin(relative) - wind.across;

    fx?.update(
      dt,
      driveFrac,
      (input.forward ? 1 : 0) - (input.backward ? 1 : 0),
      energy.level,
      energy.canThrust,
      energy.dock !== null,
      apparentAlong,
      apparentAcross,
    );
  }

  // Place the ship correctly before the first frame is drawn.
  refreshForward();
  syncStateGeo();
  applyTransform();

  return { object, state: state as ShipState, ready, update };
}
