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
import type {
  EnergyState,
  HazardState,
  InputState,
  PropulsionState,
  ShipState,
  Terrain,
  WindState,
} from './types';
/*
 * TYPE-ONLY, and it has to stay that way.
 *
 * `hull.ts` derives `HULL_REPAIR_RATE` from `energy.ts`'s `DOCK_NET_RATE` at
 * module scope, and `energy.ts` reads `MAX_FORWARD` out of this file. A VALUE
 * import here would close that into a real cycle — energy -> ship -> hull ->
 * energy — and the first module of the three to be entered decides whether it
 * crashes: a test file that imports `energy.ts` first suspends it at its own
 * import statement, so `hull.ts`'s top-level `DOCK_NET_RATE * 100` reads a
 * `const` still in its temporal dead zone and throws. A type import is erased
 * and cannot, which is why the hull below is defaulted to `null` rather than
 * to `createStubHull()`: taking the default would be the value import.
 */
import type { Hull } from './hull';
import { SEA_ANCHOR_DRAG } from './seaanchor';
import { GLOBE_RADIUS, dirToLatLon, latLonToDir, normalizeHeadingDeg, tangentFrame } from './geo';
import { createShipFx } from './shipfx';
import type { ShipFx } from './shipfx';
import shipModelUrl from '../assets/pirateship_beginner.glb?url';
import { sampleWave } from './wavefield';
import type { WaveOffsets, WaveSample } from './wavefield';
import { DISPLACE_AMPLITUDE } from './waveconstants';
import { hazardHeight } from './hazardfield';
import { seaWindStrength } from './wind';

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
export const HULL_OFFSET = 0.6;

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

/**
 * Uniform scale applied to the hull, the stand-in included.
 *
 * 0.65 is the ship at 35% off its authored size. It makes the world bigger in
 * the only sense `geo.ts` says a world can be -- same globe, same crossings,
 * smaller boat -- without touching a single world-scale constant.
 *
 * Everything measured off the hull has to come with it. Inside this file that
 * is MODEL_MOUNT_Y below; outside it, `wake.ts` authors STERN_BACK,
 * BOW_FORWARD and HALF_WIDTH_0 against the hull's own half-length, and a wake
 * left at full size detaches from a shrunken ship in the most obvious way
 * there is.
 */
export const MODEL_SCALE = 0.65;

/**
 * Where the glTF root hangs inside the ship group, so its waterline lands on
 * the sea.
 *
 * MODEL_WATERLINE_Y is a MODEL-space number, so it has to be scaled before it
 * is subtracted: at 0.65 the hull meets the water 0.13 below its deck plane,
 * not 0.2. Mounting it as though the model were still full size would sink the
 * ship the difference and put the sea through its gunwale.
 */
const MODEL_MOUNT_Y = -HULL_OFFSET - MODEL_WATERLINE_Y * MODEL_SCALE;

/**
 * Top speed, world units per second, which `hud.ts` reads out as 10.0 kn.
 *
 * Drag, not the clamp below, is what actually decides this. Thrust and drag
 * balance at ACCEL / DRAG, so that ratio *is* the top speed and the clamp only
 * ever catches the last fraction of a knot -- which is why ACCEL is derived
 * from this rather than typed. Set independently they disagree silently: at
 * ACCEL 12 and DRAG 0.7 the ship topped out at 17.1 however high the clamp was
 * set, and the number in this constant was simply never reached.
 *
 * Ten rather than the fifteen this was authored at. Because ACCEL is derived,
 * the drop takes the thrust down with it and leaves DRAG -- and therefore the
 * 2.9 s time constant, the coast and the stopping distance -- exactly where
 * they were: the ship reaches its cruise in the same time, that cruise is
 * simply two thirds of what it was. Reverse is untouched at 7, so ahead and
 * astern are now much closer together than the old 15/7 split.
 *
 * Exported because `energy.ts` divides the burn by it: the draw is quadratic in
 * (speed / MAX_FORWARD), so a copy of the 10 over there would mean a top-speed
 * change quietly retuning the whole fuel economy instead of moving with it.
 * `wake.ts` imports it for the same reason -- and a slower top speed means the
 * whole hull's worth of speed-driven effects, wake and spray included, now
 * reach full strength at 10 kn rather than 15.
 */
export const MAX_FORWARD = 10;
/**
 * Linear drag coefficient, 1/s. Also sets how long the ship coasts.
 *
 * 0.35 is half what it was, which is how the ship came to accelerate half as
 * hard WITHOUT losing a knot off the top. The two facts are the same fact:
 * thrust balances drag at ACCEL / DRAG, so halving ACCEL on its own would have
 * halved the top speed to 7.5 and left MAX_FORWARD asserting a 15 it could
 * never reach -- exactly the silent disagreement its own comment warns about.
 * Halving DRAG instead halves the derived ACCEL with it and leaves the ratio,
 * and therefore the top speed, untouched.
 *
 * What it does change, unavoidably, is the other half of this constant's job.
 * The time constant is 1 / DRAG, so it is now 2.9 s rather than 1.4: the ship
 * takes about twice as long to work up to a cruise, and twice as long to shed
 * it when the throttle comes off. A hull that gathers way slowly and carries
 * it a long time is the same hull -- there is no way to slow the pickup and
 * keep the old stopping distance while thrust is a constant against linear
 * drag. Plan the approach to a berth earlier.
 */
const DRAG = 0.35;
/**
 * Thrust while a throttle key is held, world units / s^2, for the
 * unmodified hull. Now 3.5.
 *
 * `update` below no longer reads this constant directly: Trim & Sheathing
 * (`trim.ts`) raises `MAX_FORWARD` in `PropulsionState.maxForward`, and
 * `ACCEL = MAX_FORWARD * DRAG` is exactly the ratio that upgrade is built to
 * keep — see `trim.ts`'s own comment on why a higher top speed already buys
 * proportionally more thrust at no separate cost. `update` therefore
 * recomputes this same product every frame from whatever `maxForward`
 * `propulsion` hands it, and this constant survives only as the reference
 * point that derivation is written against, and the number the doc comment
 * above describes.
 */
const ACCEL = MAX_FORWARD * DRAG;

const MAX_REVERSE = 7; // world units / s (magnitude); clamp-limited, not drag-limited
const STOP_EPSILON = 0.02; // speeds below this snap to a dead stop

const TURN_RATE = 1.2; // rad / s at full speed
const TURN_MIN_SCALE = 0.55; // fraction of TURN_RATE still available at a standstill

/** How far ahead (world units) we probe for land so we stop before the coast. */
const LOOKAHEAD = 2.2;

/**
 * Residual idle bob in a dead calm, world units. Absolute (not scaled by
 * MODEL_SCALE) -- see docs/ARCHITECTURE.md "Ship dynamics" on why the sway
 * and bank constants stay ship-scale-absolute rather than shrinking with the
 * hull. `sampleWave`'s real heave (below) does the rest of the work now;
 * this old fixed sine is kept at 30% of its former amplitude purely so a
 * flat calm still breathes instead of freezing the hull dead still.
 */
const BOB_AMPLITUDE = 0.15; // world units
const TURN_BANK = 0.13; // rad of bank into a turn at full speed

/**
 * Fore/aft and beam half-distance from the hull centre the wave field is
 * sampled at for pitch and roll, world units before MODEL_SCALE (ship-scale:
 * these describe the physical hull, not the globe). Scaled by MODEL_SCALE
 * below wherever they are used, exactly as `wake.ts`'s hull-relative
 * constants are.
 */
const HULL_SAMPLE_HALF_LENGTH = 1.4;
const HULL_SAMPLE_HALF_BEAM = 0.55;

/**
 * How fast the hull's heave/pitch/roll settle onto a new reading of the sea,
 * 1/s -- a low-pass on `sampleWave`'s output so the hull doesn't visibly
 * teleport onto the surface every frame the wave field jitters at high
 * frequency (the chop layer is fragment-only and never reaches this sample,
 * but the wave layer's ridge crests are still sharp up close).
 */
const HULL_RESPONSE = 3.0;

/**
 * Fraction of the wave field's full-gale height still felt in a dead calm.
 * Mirrors `water.ts`'s private `CALM_INTENSITY` (0.16) so the hull never
 * feels a livelier sea than the one the patch actually draws. Duplicated
 * rather than imported: this stream's one permitted edit to `water.ts` is
 * the read-only `offsets` export, nothing else in that file. Keep the two in
 * sync by hand if `CALM_INTENSITY` is ever retuned.
 */
const HULL_CALM_INTENSITY = 0.16;

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
/** Where the hull stood before this frame's step, for the bow's transport. */
const _prevPosition = new Vector3();
const _candidate = new Vector3();
const _probe = new Vector3();
const _starboard = new Vector3();
const _velocity = new Vector3();
const _course = new Vector3();
const _basis = new Matrix4();
const _baseQuat = new Quaternion();
const _swayQuat = new Quaternion();
const _swayEuler = new Euler();
/** Scratch direction for the four hull-relative wave samples below. */
const _waveDir = new Vector3();
/** Scratch output for `sampleWave`, reused across all five samples per frame. */
const _waveSample: WaveSample = { h: 0, gu: 0, gv: 0 };
/** A dead-calm sea has no wind offsets to speak of, but still moves in place. */
const _zeroWaveOffsets: WaveOffsets = { swell: new Vector3(), wave: new Vector3() };
/**
 * No rough water at all, for a caller that does not have a hazard system --
 * the unit tests, which never build one. Frozen rather than merely shared:
 * `ship.ts` only ever reads it, and a default that a caller could quietly
 * mutate would be a very hard bug to find.
 */
const NO_HAZARD: HazardState = Object.freeze({
  live: Object.freeze([]),
  along: 0,
  across: 0,
  phase: 'free',
  drive: null,
}) as HazardState;

/**
 * The ship as it always was, for a caller that has not bought a single
 * Navigation offer and has never deployed a Sea Anchor -- the unit tests
 * included. Frozen for the same reason `NO_HAZARD` is: this file only ever
 * reads it.
 */
const NO_PROPULSION: PropulsionState = Object.freeze({
  maxForward: MAX_FORWARD,
  anchored: false,
});

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
 * `makeBasis(right, up, back)`. Hull ~5 units long before `MODEL_SCALE`,
 * matching the glTF it stands in for.
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
  // Neon here has to match the glTF's, or the swap on load reads as a colour
  // change rather than a detail change. These two are `neon_cyan` and
  // `neon_violet` from `tools/build_ship.py` converted out of linear into the
  // sRGB hex Three reads: (0.10, 0.72, 1.0) and (0.62, 0.20, 1.0). Magenta,
  // which this stand-in used to glow, belongs to the HUD alone -- see
  // ART-DIRECTION.md section 2.4.
  const neonCyan = new MeshStandardMaterial({
    color: 0x0a2a30,
    emissive: 0x59ddff,
    emissiveIntensity: 2.2,
    roughness: 0.4,
    metalness: 0.2,
    flatShading: true,
  });
  const neonViolet = new MeshStandardMaterial({
    color: 0x1a0a2a,
    emissive: 0xce7cff,
    emissiveIntensity: 2.2,
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

  const lantern = new Mesh(new SphereGeometry(0.17, 8, 6), neonViolet);
  lantern.position.set(0, 1.62, 1.75);
  group.add(lantern);

  const mastLight = new Mesh(new SphereGeometry(0.11, 6, 5), neonViolet);
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
   * `waveOffsets` is `globe.waveOffsets` -- the CPU sea the hull heaves,
   * pitches and rolls on; omitted, it defaults to a stationary field (see
   * `tests/unit/ship-physics.test.ts`, which never passes it).
   * `hazard` is `hazards.state` -- the rough water, doing two unrelated jobs:
   * a push spent exactly like the wind's, and a drive that takes the hull off
   * the player entirely. Omitted, it defaults to no rough water at all.
   * `propulsion` is `main.ts`'s per-frame read of the Navigation offers --
   * effective top speed and whether a Sea Anchor is over the side. Omitted,
   * it defaults to the unmodified hull. See `types.ts`'s `PropulsionState`.
   */
  update(
    dt: number,
    input: InputState,
    energy: EnergyState,
    wind: WindState,
    waveOffsets?: WaveOffsets,
    hazard?: HazardState,
    propulsion?: PropulsionState,
  ): void;
  /**
   * Puts the hull at `dir` on `headingRad`, stopped.
   *
   * The one other place a heading is an INPUT rather than a reading — see
   * `forwardFromHeading`. Only the respawn after a maelstrom calls it: a
   * teleport is the single event in this game that is allowed to move the ship
   * without walking it there.
   */
  place(dir: Vector3, headingRad: number): void;
  /**
   * A copy of the loaded glTF hull, for an AI boat to wear.
   *
   * Null before `ready` settles and null forever if the load failed — an AI
   * boat is not worth showing as the stand-in. Geometry is SHARED with the
   * player's hull and every material is CLONED, so a raider's recoloured neon
   * and its rim glow can never reach the ship the player is standing on.
   *
   * Scaled and mounted exactly as the player's is, so a clone dropped at the
   * same radius floats at the same waterline.
   */
  cloneHull(): Object3D | null;
  /**
   * Stops the hull dead, where it stands, this instant.
   *
   * The fishing overlay freezes the world, and a frozen world has to resume
   * from rest: a ship that kept its way through a paused minute would leap
   * forward on the frame the card closes, having travelled nowhere while it
   * was shut. Position and heading are untouched — this is a stop, not a
   * teleport.
   *
   * The bank angle is unwound with it, because a hull leaning into a turn it
   * is no longer making reads as a bug in the still frame behind the card.
   */
  halt(): void;
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
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new GLTFLoader()
    .loadAsync(shipModelUrl, (event) => {
      // The hull is 5 MB and is the longest single wait in the whole boot, so
      // it is the one stage that can report real bytes rather than a guess.
      // `total` is 0 when the server sends no Content-Length, and a fraction
      // of zero is worse than no fraction at all -- the caller keeps its last
      // reading instead.
      if (onProgress && event.total > 0) onProgress(event.loaded / event.total);
    })
    .then((gltf) => {
      const model = gltf.scene;
      model.name = 'ship-hull';
      model.scale.setScalar(MODEL_SCALE);
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
 * @param onHullProgress fraction of the glTF downloaded, [0, 1]. Optional, and
 *   the ship neither waits for a reader nor behaves differently with one --
 *   it exists so the loading screen can report the boot's longest stage
 *   honestly instead of animating a guess over it.
 * @param hull the durability reserve, read once a frame for its `speedCap`
 *   and for nothing else. Optional, and `null` means "no ceiling", which is
 *   the game exactly as it was before durability existed -- so every existing
 *   call site, `tests/unit/ship-physics.test.ts` included, is unchanged. See
 *   the type-only import at the top of this file for why the default is a
 *   `null` rather than `createStubHull()`.
 */
export function createShip(
  terrain: Terrain,
  start?: { latDeg: number; lonDeg: number; headingDeg?: number },
  maxAnisotropy = 1,
  onHullProgress?: (fraction: number) => void,
  hull: Hull | null = null,
): Ship {
  const startLat = start?.latDeg ?? 0;
  const startLon = start?.lonDeg ?? 0;
  const startHeading = ((start?.headingDeg ?? 90) * Math.PI) / 180;

  const object = new Group();
  object.name = 'ship';
  const standIn = buildStandInHull();
  // Scaled with the same factor as the glTF, so the half second before the
  // model lands does not show a ship of a different size.
  standIn.scale.setScalar(MODEL_SCALE);
  object.add(standIn);
  // Null until the glTF lands, and stays null if the load fails -- the stand-in
  // has none of the parts it drives.
  let fx: ShipFx | null = null;
  const ready = loadHull(
    object,
    standIn,
    maxAnisotropy,
    (loaded) => {
      fx = loaded;
    },
    onHullProgress,
  );

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
  /**
   * How far below its waterline the hull is drawn, world units.
   *
   * Non-zero only under a maelstrom's drive, which sinks the ship over the
   * last seconds of its spiral. Subtracted from the RADIUS in
   * `applyTransform` rather than from the visual transform, for the same
   * reason `bob` is added there: anything else leaves the hull sitting on a
   * surface the sea is no longer at.
   */
  let sink = 0;
  let bankRoll = 0;
  /** Low-passed heave/pitch/roll from `sampleWave`, radians for the latter two. */
  let waveHeave = 0;
  let wavePitch = 0;
  let waveRoll = 0;

  /**
   * Builds `state.forward` from a compass heading. Startup only.
   *
   * This used to run at the end of every frame, and it was the pole bug. A
   * compass heading is an angle in the tangent frame at one point, and near a
   * pole that frame spins arbitrarily fast against the ground: the meridians
   * converge, so a few metres of travel can swing north through ninety
   * degrees. Rebuilding the bow from a held heading therefore SWUNG THE BOW,
   * and a ship crossing high latitudes twisted on the spot. With a wind up it
   * was worse than that -- `wind.ts` held its bearing in the same collapsing
   * frame, so the push swung too, and the two drove each other in circles.
   *
   * `forward` is now the state and heading is the reading taken off it. See
   * `transportForward`.
   */
  function forwardFromHeading(headingRad: number): void {
    tangentFrame(state.position, _north, _east);
    _forward
      .copy(_north)
      .multiplyScalar(Math.cos(headingRad))
      .addScaledVector(_east, Math.sin(headingRad));
    const len = _forward.length();
    if (len > 1e-8) _forward.multiplyScalar(1 / len);
    else _forward.copy(_north);
    state.forward.copy(_forward);
  }

  /**
   * Carries the bow across a step, from `from` to the committed position.
   *
   * Parallel transport: the bow is turned by exactly the rotation that carried
   * the hull, so a ship holding its helm steady runs a great circle -- which is
   * what sailing straight ahead means on a sphere -- and nothing about the step
   * is expressed as an angle in any frame. That is what makes it work at the
   * pole, where frames stop being usable but rotations are still rotations.
   *
   * The re-orthogonalisation afterwards is not decoration. Each step leaves
   * `forward` a rounding error out of the tangent plane, and over a long
   * passage those errors accumulate into a bow that is visibly not level.
   */
  function transportForward(from: Vector3): void {
    _axis.crossVectors(from, state.position);
    const sin = _axis.length();
    if (sin > 1e-12) {
      _axis.multiplyScalar(1 / sin);
      const cos = Math.max(-1, Math.min(1, from.dot(state.position)));
      state.forward.applyAxisAngle(_axis, Math.atan2(sin, cos));
    }
    state.forward.addScaledVector(state.position, -state.forward.dot(state.position));
    const len = state.forward.length();
    if (len > 1e-8) state.forward.multiplyScalar(1 / len);
    else {
      tangentFrame(state.position, _north, _east);
      state.forward.copy(_north);
    }
  }

  /**
   * The compass heading the bow is currently pointing, radians.
   *
   * Derived, every frame, and never stored as the truth. At the pole the
   * tangent frame is arbitrary and so is this number -- which is correct, and
   * is what a real compass does there. The difference is that it is now only a
   * READING: `wind.ts` and the HUD may spin with it, the hull does not.
   */
  function headingFromForward(): number {
    tangentFrame(state.position, _north, _east);
    const h = Math.atan2(state.forward.dot(_east), state.forward.dot(_north));
    return ((h % TWO_PI) + TWO_PI) % TWO_PI;
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
    state.heading = headingFromForward();
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

    // Sway is applied AFTER the base orientation, in the ship's local space.
    // `waveRoll`/`wavePitch` are the low-passed reading of the sea itself
    // (see the wave-sampling block in `update`); `bankRoll` is the helm's own
    // lean into a turn and adds on top, unchanged.
    const roll = waveRoll + bankRoll;
    const pitch = wavePitch;
    _swayEuler.set(pitch, 0, roll);
    _swayQuat.setFromEuler(_swayEuler);
    _baseQuat.multiply(_swayQuat);

    object.quaternion.copy(_baseQuat);
    // `bob` folds in both the sampled heave and the calm-water residual sine
    // (see `update`) -- added to the RADIUS, not just to this visual
    // transform, so the hull never floats above or sinks below the surface
    // the patch actually displaces.
    object.position.copy(state.position).multiplyScalar(GLOBE_RADIUS + HULL_OFFSET + bob - sink);
  }

  function update(
    dt: number,
    input: InputState,
    energy: EnergyState,
    wind: WindState,
    /**
     * `globe.waveOffsets` -- the same integrated drift `water.ts`'s shader
     * reads, so the hull samples the identical sea the patch draws. Optional
     * and defaulting to a stationary field: `tests/unit/ship-physics.test.ts`
     * calls `update` without it, and the hull's `state.position` direction
     * (which that test pins to unit length) never depends on wave sampling
     * either way -- only the visual radius (`bob`) and orientation do.
     */
    waveOffsets: WaveOffsets = _zeroWaveOffsets,
    /**
     * `hazards.state` — the rough water. Two separate jobs, and they do not
     * overlap: `along`/`across` are a push spent exactly like the wind's, and
     * `drive` (when non-null) means the hull is no longer the player's to
     * steer and is being carried into a funnel. Optional and defaulting to
     * nothing at all, so `tests/unit/ship-physics.test.ts` needs no change.
     */
    hazard: HazardState = NO_HAZARD,
    /**
     * `main.ts`'s per-frame read of the Navigation offers: the ship's
     * effective top speed (base, Trim & Sheathing, or an Overdrive Coil's
     * burn — see `types.ts`) and whether a Sea Anchor is over the side.
     * Optional and defaulting to the unmodified hull, so
     * `tests/unit/ship-physics.test.ts` needs no change.
     */
    propulsion: PropulsionState = NO_PROPULSION,
  ): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    elapsed += dt;

    /*
     * The hull under a maelstrom's drive: not the player's any more.
     *
     * Everything between here and the wave sampling below is the ship the
     * player steers -- the helm, the throttle, the ground velocity and the
     * step across the water -- and a captured hull runs none of it. It is
     * placed where `hazards.ts` says it is, on the heading that module chose,
     * stopped: a ship being carried down a funnel is not making way, and a
     * groundSpeed reported off a spiral would have `energy.ts` billing the
     * engines for it and `wake.ts` laying a ribbon behind it.
     *
     * The sea sampling below still runs for both branches, so the hull keeps
     * heaving on the water -- and tipping into the funnel's own slope -- right
     * up until it goes under.
     */
    const drive = hazard.drive;
    if (drive === null) {
      // ---- Steering: always allowed, even while beached --------------------
      let turnInput = 0;
      if (input.left) turnInput -= 1;
      if (input.right) turnInput += 1;

      /*
       * The hull's top speed for this one frame -- MAX_FORWARD, or higher
       * with Trim & Sheathing bought or an Overdrive Coil burning, and then
       * cut to whatever a worn hull will stand. See `types.ts`'s
       * `PropulsionState` for who builds the first figure and why it is never
       * a sum of both.
       *
       * The `min` is what makes docs/HARBOURS_PLAN.md's decision 14 true
       * rather than a promise: BOTH upgrades are already inside
       * `propulsion.maxForward`, so one comparison overrides both and there
       * is no way to buy back the cap. A worn hull is a ship with its
       * Navigation shelf switched off.
       *
       * Two things it deliberately does not touch. The wind is added to
       * `groundSpeed` after the engine has integrated, below, and is NOT
       * capped -- a gale can still carry a broken ship home faster than its
       * own engine could, which is the one mercy in the rule. And reverse
       * falls out of it for free rather than being clamped by it: the `accel`
       * line below is `effMaxForward * DRAG`, so astern terminates at
       * `-effMaxForward` and MAX_REVERSE only bites when that is deeper than
       * the 7 kn it stands for.
       */
      const effMaxForward = Math.min(
        propulsion.maxForward,
        hull === null ? Infinity : hull.state.speedCap,
      );

      const speedFrac = clamp(Math.abs(state.speed) / effMaxForward, 0, 1);
      const turnRate = TURN_RATE * (TURN_MIN_SCALE + (1 - TURN_MIN_SCALE) * speedFrac);
      if (turnInput !== 0) {
        // The bow turns about the surface normal. Clockwise-positive looking
        // down from outside, so right/D swings it clockwise from the player's
        // chase-camera view -- the same sense the old heading counter had, but
        // applied to the vector itself so it means the same thing at the pole
        // as it does at the equator. A negative angle because applyAxisAngle is
        // counter-clockwise about `up`, and `up` points at the camera.
        state.forward.applyAxisAngle(state.up, -turnInput * turnRate * dt);
      }

      // Subtle bank into the turn, damped so it eases in and out.
      const bankTarget = -turnInput * TURN_BANK * (0.25 + 0.75 * speedFrac);
      bankRoll += (bankTarget - bankRoll) * (1 - Math.exp(-4 * dt));

      // ---- Throttle --------------------------------------------------------
      // A dry tank cuts thrust in both directions and nothing else. Steering,
      // drag, the bob and sway, the land probe and the sea all keep running
      // below, so the ship coasts to a stop and still answers the helm -- being
      // out of charge is a predicament, never a frozen frame. The player can
      // always turn the hull, and the panels bring it back.
      //
      // A Sea Anchor over the side cuts thrust the same way and for the same
      // shape of reason -- see `seaanchor.ts` -- but it is not a predicament:
      // it is the whole point of the item, so it is tested first and an empty
      // tank underneath it changes nothing either way.
      let thrust = 0;
      if (!propulsion.anchored && energy.canThrust) {
        // ACCEL exactly when the hull is unmodified -- the ordinary case,
        // and the one that constant's own comment is written against --
        // and `effMaxForward * DRAG` otherwise, which is the same ratio for
        // whatever tier or burn `propulsion` is reporting this frame.
        const accel = effMaxForward === MAX_FORWARD ? ACCEL : effMaxForward * DRAG;
        if (input.forward) thrust += accel;
        if (input.backward) thrust -= accel;
      }

      // The drag this frame's exact solution decays against. Ordinary DRAG,
      // unless a Sea Anchor is over the side, in which case it is
      // SEA_ANCHOR_DRAG -- an order of magnitude steeper, so the three time
      // constants of the kill window (see `seaanchor.ts`) decay any speed the
      // ship was carrying to a crawl in about a second rather than the ship's
      // usual 2.9 s coast.
      const drag = propulsion.anchored ? SEA_ANCHOR_DRAG : DRAG;

      // Exact solution of  ds/dt = thrust - drag * s  over dt, rather than a
      // step of each in turn. Two reasons it has to be integrated in closed
      // form. It makes the top speed exactly thrust / drag: stepping thrust and
      // then drag lands on (accel / drag) * (1 - drag * dt) instead, which is
      // 19.8 kn at 60fps and 18.6 at 10 -- a top speed that depends on the frame
      // rate. And with no throttle it decays cleanly to zero, so releasing the
      // keys still coasts the ship to a stop.
      const terminal = thrust / drag;
      state.speed = terminal + (state.speed - terminal) * Math.exp(-drag * dt);
      state.speed = clamp(state.speed, -MAX_REVERSE, effMaxForward);
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
        .multiplyScalar(state.speed + wind.along + hazard.along)
        .addScaledVector(_starboard, wind.across + hazard.across);

      const groundMag = _velocity.length();

      // ---- Move along the ground velocity, refusing to enter land ----------
      // Held before the first attempt, because the bow is carried by where the
      // hull ENDED UP relative to where it began, and `tryStep` may write the
      // position more than once below.
      _prevPosition.copy(state.position);
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

      // The bow is carried across whatever the hull actually committed -- one
      // transport for the whole step, however many attempts `tryStep` made.
      transportForward(_prevPosition);
      syncStateGeo();
    } else {
      state.position.copy(drive.position).normalize();
      state.up.copy(state.position);
      // Taken as given rather than transported: the spiral's own heading is
      // the direction of its motion, which `hazards.ts` has already worked out
      // from where the hull was last frame. Re-orthogonalised anyway, because
      // the step it came off is a chord across a tightening circle.
      state.forward
        .copy(drive.forward)
        .addScaledVector(state.position, -drive.forward.dot(state.position));
      if (state.forward.lengthSq() > 1e-12) state.forward.normalize();
      else {
        tangentFrame(state.position, _north, _east);
        state.forward.copy(_north);
      }
      state.speed = 0;
      state.groundSpeed = 0;
      state.velocity.set(0, 0, 0);
      // The helm's own lean unwinds at the same rate it eases in at above. A
      // hull nobody is steering is not banking into a turn, and a lean held
      // frozen through a six-second spiral reads as the model being stuck
      // rather than as the ship being taken.
      bankRoll -= bankRoll * (1 - Math.exp(-4 * dt));
      // The bow's transport baseline, so the frame the drive ENDS on does not
      // carry `forward` across the whole spiral in one rotation.
      _prevPosition.copy(state.position);
      syncStateGeo();
    }
    // How far the hull is drawn below its own waterline. Read by
    // `applyTransform`; zero whenever nothing is driving it.
    sink = drive !== null ? drive.sink : 0;

    // ---- Idle motion --------------------------------------------------
    const driveFrac = clamp(Math.abs(state.speed) / MAX_FORWARD, 0, 1);

    // ---- Ride the sea: sample the CPU wave field at the hull -----------
    // Same law as `water.ts`'s uWaveIntensity (height ~ wind speed squared,
    // floored so a calm sea still moves): see HULL_CALM_INTENSITY's comment
    // for why this is a second copy of that formula rather than a shared one.
    //
    // The BIAS inside `seaWindStrength` is not a second copy, deliberately.
    // The height law is duplicated and kept in step by hand; the four knots
    // the sea is drawn ahead of the weather are single-sourced in `wind.ts`,
    // because a hull riding an unbiased sea under a biased one would be a
    // boat sitting flat in visible waves.
    const windStrength = seaWindStrength(wind.speed);
    const waveGain = HULL_CALM_INTENSITY + (1 - HULL_CALM_INTENSITY) * windStrength * windStrength;

    const halfLength = (HULL_SAMPLE_HALF_LENGTH * MODEL_SCALE) / GLOBE_RADIUS;
    const halfBeam = (HULL_SAMPLE_HALF_BEAM * MODEL_SCALE) / GLOBE_RADIUS;

    // Recomputed against this frame's transported forward -- the copy built
    // earlier for the ground-velocity step is now a frame stale.
    _starboard.crossVectors(state.forward, state.up);
    if (_starboard.lengthSq() > 1e-12) _starboard.normalize();
    else _starboard.set(0, 0, 0);

    /*
     * The five heights below are in WORLD UNITS, and each is two terms.
     *
     * The wave field's own reading is a raw field value, so it is scaled here
     * by `seaGain` -- the weather. A hazard's height is already absolute world
     * units and is deliberately NOT wind-scaled: the wind raises the ordinary
     * sea, a hazard is its own weather, and putting a crest through `waveGain`
     * would make a maelstrom shallow in a calm and a strong wave a ripple.
     *
     * Both terms are added AT THE SAMPLE POINT, before any difference is
     * taken, which is what puts the hazard inside the pitch and roll numerators
     * below rather than beside them. The hull therefore climbs a crest, and
     * tips bow-down into a funnel, on the same arithmetic that already rides
     * the swell.
     */
    const seaGain = DISPLACE_AMPLITUDE * waveGain;
    const live = hazard.live;

    sampleWave(state.position, waveOffsets, 1.0, _waveSample);
    const centreH = _waveSample.h * seaGain + hazardHeight(state.position, live);

    _waveDir.copy(state.position).addScaledVector(state.forward, halfLength).normalize();
    sampleWave(_waveDir, waveOffsets, 1.0, _waveSample);
    const bowH = _waveSample.h * seaGain + hazardHeight(_waveDir, live);

    _waveDir.copy(state.position).addScaledVector(state.forward, -halfLength).normalize();
    sampleWave(_waveDir, waveOffsets, 1.0, _waveSample);
    const sternH = _waveSample.h * seaGain + hazardHeight(_waveDir, live);

    _waveDir.copy(state.position).addScaledVector(_starboard, halfBeam).normalize();
    sampleWave(_waveDir, waveOffsets, 1.0, _waveSample);
    const starboardH = _waveSample.h * seaGain + hazardHeight(_waveDir, live);

    _waveDir.copy(state.position).addScaledVector(_starboard, -halfBeam).normalize();
    sampleWave(_waveDir, waveOffsets, 1.0, _waveSample);
    const portH = _waveSample.h * seaGain + hazardHeight(_waveDir, live);

    const heaveTarget = centreH;
    // atan2 rather than a bare ratio: the run stays fixed (the sample
    // baseline) while the rise is the height difference, exactly the small
    // angle a real deck would tip through.
    const pitchTarget = Math.atan2(bowH - sternH, 2 * HULL_SAMPLE_HALF_LENGTH * MODEL_SCALE);
    const rollTarget = Math.atan2(starboardH - portH, 2 * HULL_SAMPLE_HALF_BEAM * MODEL_SCALE);

    // Low-pass so the hull settles onto a new reading of the sea rather than
    // visibly snapping to it every frame.
    const response = 1 - Math.exp(-HULL_RESPONSE * dt);
    waveHeave += (heaveTarget - waveHeave) * response;
    wavePitch += (pitchTarget - wavePitch) * response;
    waveRoll += (rollTarget - waveRoll) * response;

    // A residual of the old fixed sine, well below the sampled heave, so a
    // dead calm -- where the wave field itself is nearly flat -- still
    // breathes instead of freezing the hull dead still.
    const residual = Math.sin(elapsed * 1.6) * BOB_AMPLITUDE * 0.3;
    // Added to the RADIUS in applyTransform, not just the visual sway, so
    // the hull never sits below the surface the patch actually displaces.
    bob = waveHeave + residual;

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
    // In a flat calm at 15 kn this comes out as 15 kn from dead ahead, and the
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
      // The raw key press, except while the drive has the hull: a ship being
      // pulled into a funnel is not under power, and firing its thrusters on
      // the way down would read as the player still having the helm.
      drive === null ? (input.forward ? 1 : 0) - (input.backward ? 1 : 0) : 0,
      energy.level,
      energy.canThrust,
      energy.dock !== null,
      apparentAlong,
      apparentAcross,
    );
  }

  // Place the ship correctly before the first frame is drawn. This is the one
  // place a heading is an input rather than a reading.
  forwardFromHeading(state.heading);
  syncStateGeo();
  applyTransform();

  /**
   * See `Ship.halt`. Every quantity that carries motion across a frame goes to
   * zero; nothing that describes where the ship IS is touched.
   *
   * `bankRoll` is a private easing term rather than published state, which is
   * why it is unwound here and not by the caller — the caller cannot reach it.
   */
  /**
   * See `Ship.place`. The hull is set down at `dir` facing `headingRad`,
   * stopped, with the bank unwound -- everything `halt` zeroes, plus the two
   * things it deliberately does not touch, because this IS the teleport.
   */
  function place(dir: Vector3, headingRad: number): void {
    state.position.copy(dir).normalize();
    state.up.copy(state.position);
    forwardFromHeading(((headingRad % TWO_PI) + TWO_PI) % TWO_PI);
    // The bow's own transport baseline, so the frame after a teleport does not
    // carry `forward` across the entire planet the hull just crossed.
    _prevPosition.copy(state.position);
    // The sea is sampled fresh next frame; the low-passed attitude has to go
    // with the position or the hull arrives still leaning on the wave it left.
    waveHeave = 0;
    wavePitch = 0;
    waveRoll = 0;
    bob = 0;
    // The hull that went down the funnel comes back up at its own waterline.
    // `hazards.reset()` clears the drive a moment later, but this call happens
    // while it is still holding the hull at full sink.
    sink = 0;
    syncStateGeo();
    halt();
  }

  function halt(): void {
    state.speed = 0;
    state.groundSpeed = 0;
    state.velocity.set(0, 0, 0);
    bankRoll = 0;
    applyTransform();
  }

  /**
   * A copy of the loaded glTF hull for an AI boat to wear. See the docstring
   * on `Ship.cloneHull` above for the contract this keeps.
   *
   * The loaded model is found by the name `loadHull` gives it rather than
   * being held in a second closure variable, so there is exactly one fact
   * about whether the hull is aboard: it is a child of `object` or it is not.
   * The stand-in is unnamed, so this is null while it is still standing in and
   * null forever if the load failed.
   *
   * Materials are cloned through a map keyed on the SOURCE material, not one
   * clone per mesh. The build script joins the ship by material precisely so
   * it draws in 26 calls rather than one per bolt; cloning per mesh would hand
   * every mesh its own material and quietly undo that on the raider.
   *
   * `userData` is emptied on each clone, and that line is load bearing.
   * `Material.copy` deep-copies `userData` but does NOT copy `onBeforeCompile`
   * or `customProgramCacheKey`, so a clone taken after `main.ts` has already
   * run `postFx.adopt(ship.object)` inherits the "already encoded" flag from
   * postfx.ts without the hook that flag stands for -- and `adopt` then skips
   * it and it renders a stop dark. Same trap `shipfx.ts` documents from the
   * other side, which is why it clones its lamps during the load instead.
   */
  function cloneHull(): Object3D | null {
    const model = object.getObjectByName('ship-hull');
    if (!model) return null;

    const clone = model.clone(true);
    clone.name = 'ai-hull';
    // `clone(true)` already carries these across; set again so the mount the
    // raider floats at is stated here rather than inherited silently, exactly
    // as `loadHull` states it.
    clone.scale.setScalar(MODEL_SCALE);
    clone.position.y = MODEL_MOUNT_Y;

    const clones = new Map<Material, Material>();
    function cloneMaterial(source: Material): Material {
      const seen = clones.get(source);
      if (seen) return seen;
      const copy = source.clone();
      copy.userData = {};
      clones.set(source, copy);
      return copy;
    }

    clone.traverse((node) => {
      const mesh = node as Mesh;
      if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
      // Geometry is deliberately left shared: it is the same hull, and a 5 MB
      // model's buffers are not worth a second copy. The cost is the one
      // `docs/BATTLE_PLAN.md` accepts -- the AI's cloth deforms in step with
      // the player's, since `shipfx.ts` rewrites vertices these share.
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(cloneMaterial)
        : cloneMaterial(mesh.material);
    });

    return clone;
  }

  return { object, state: state as ShipState, ready, update, halt, place, cloneHull };
}
