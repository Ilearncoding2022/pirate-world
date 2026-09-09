import { Vector3 } from 'three';
import type { HeightMap } from './heightmap';
import type { AiBoat, AiBoatKind, AiBoatPhase, AiBoatState, EnergyState, HazardState, ShipState, Terrain, Towns } from './types';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { mulberry32 } from './towns';

/**
 * aiboats.ts — the raiders on the sea.
 *
 * Owns one `AiBoatState`, mutated in place for the life of the run, as
 * `wind.ts` owns `WindState` and `hazards.ts` owns `HazardState`. DOM-free and
 * scene-free: it moves numbers and vectors, and it is the module the unit
 * tests exercise. `aihulls.ts` is what puts meshes where it says.
 *
 * The brief is docs/BATTLE_PLAN.md. Read it before retuning anything here.
 *
 * `hazards.ts` is the model this file is cut from, and the two geometry rules
 * that run through it run through this one for the same reasons:
 *
 *   - **Nothing is kept as a compass bearing.** A boat is a centre and a
 *     tangent, carried across its own travel by parallel transport, exactly as
 *     `ship.ts` carries the bow. A bearing lives in the tangent frame at one
 *     point, and that frame spins arbitrarily fast near a pole.
 *     `tangentFrame` is built fresh at the point of use and never held.
 *   - **The seeded stream is drawn from unconditionally.** A roll takes its
 *     number for every kind whether or not it can act on it, so what happens
 *     to be on the water cannot reorder the draws behind it.
 *
 * One invariant everything downstream leans on: **at most one live boat of
 * each colour.** `aihulls.ts` keeps exactly one hull clone per colour, so a
 * second red or a second orange would be a boat with no hull. The roll
 * enforces it on the way in, and `convert` (below) is the one other place it
 * could be broken, so it checks.
 */

export interface AiBoatsDeps {
  terrain: Terrain;
  heightMap: HeightMap;
  waterBodies: WaterBodies;
  towns: Towns;
  seed?: number;
  /**
   * Fired once, the frame a hull touches the player's. `main.ts` halts the
   * ship and opens the battle from here. The boat stays in `live` until
   * `remove` takes it, so the arena has a hull to borrow.
   */
  onContact: (boat: AiBoat) => void;
}

export interface AiBoats {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: AiBoatState;
  /**
   * After `hazards.update`, before `ship.update`: it needs this frame's
   * hazard phase, and contact has to halt the hull the same frame it happens.
   *
   * `suppressed` is `main.ts`'s verdict — docked, mid-blackout, or in a
   * maelstrom — and blocks both spawning and contact.
   */
  /**
   * `stormOdds` multiplies the ORANGE spawn probability, from the same number
   * `hazards.ts` reads in `main.ts`: raiders work the weather too, and a storm
   * that raised the sea without putting another hull on it would be half a
   * system.
   *
   * **Red is deliberately exempt** (2026-09-08, owner's call, on the same day
   * `P_RED` was cut to a fifth). The two colours are different kinds of event
   * and the weather may only multiply one of them. An orange boat is a hull
   * that happens to be out there, so more of them in dirty weather is the
   * world being busier. A red one ends in a fight unless it is out-turned, and
   * tripling that in a storm is the game deciding to interrupt you at the
   * exact moment the sea is already the thing you are fighting -- which is
   * also, more plainly, most of the 80% cut handed straight back.
   *
   * It multiplies the COMPARISON only. The draw stays unconditional and is
   * taken for both colours, so the seeded stream replays whatever the sky is
   * doing.
   */
  update(
    dt: number,
    ship: ShipState,
    energy: EnergyState,
    hazards: HazardState,
    suppressed: boolean,
    stormOdds?: number,
  ): void;
  /** Removes the boat a fight was fought with, and starts the grace period. */
  remove(boat: AiBoat): void;
  /** Spawns one boat now. Tests and the `?boat=` dev query only. */
  force(kind: AiBoatKind, position: Vector3, forward: Vector3): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * Seconds between spawn rolls, and the odds each colour is drawn at on one.
 *
 * Read them together: they are one rate written as a cadence and two chances.
 * Over a ten-minute sail that is about two red boats and forty-odd orange
 * rolls on the nominal figures. The period is deliberately twice
 * `hazards.ts`'s: a raider is a longer interruption than a wave, so it may
 * not arrive as often.
 *
 * **The two colours are now more than an order of magnitude apart, and that is
 * the point.** Orange wanders a track drawn once and never revised: it is weather,
 * and meeting one is the normal condition of being at sea. Red steers at the
 * player every frame and ends in a fight unless it is out-turned, so it is an
 * event, and an event that arrives every minute is a chore. P_RED was cut by
 * four fifths -- 0.16 to 0.032 (2026-09-08, owner's call), having itself been
 * doubled from 0.08 the day before -- which puts an aggressive raider at
 * roughly one every five minutes of sailing rather than one a minute.
 *
 * P_ORANGE went the other way, TRIPLED from 0.24 to 0.72 (2026-09-09, owner's
 * call), and for the mirror of the same reason. Orange is the colour the
 * player is meant to keep meeting, and at 0.24 the sea between harbours read
 * as empty for minutes at a stretch. At 0.72 a roll all but always lands, so
 * the rate is now governed almost entirely by how long a boat LIVES and by
 * the one-per-colour cap below -- which is the intent: an orange hull should
 * be somewhere on the water most of the time, not an event.
 *
 * The nominal counts above are ceilings the sea does not actually deliver:
 * the odds are per roll and per COLOUR, a colour already on the water is
 * drawn for and skipped, and the real rate is governed by how long a boat
 * LIVES at least as much as by these numbers -- see PHASE_SECONDS and the
 * post-fight grace. That correction now all but swallows orange, which at
 * 72% a roll is nearly always either out already or born on the spot; at 3.2%
 * red is almost never the colour being skipped, so its own figure is close to
 * what it says.
 *
 * Move the period and both frequencies move with it, which is usually not what
 * you wanted; move a single probability instead.
 */
export const ROLL_PERIOD = 10;
export const P_RED = 0.032;
export const P_ORANGE = 0.72;

/**
 * The fixed order the two colours are drawn in, every roll, live or not.
 *
 * The order is what makes the stream reproducible: a run replays its own
 * raiders only if the same draws come off `rng` in the same sequence, and
 * skipping the draw for a colour that happens to be live would let what is on
 * the water reorder the stream behind it. So the number is always taken; only
 * the acting on it is conditional. See `roll`.
 */
const ROLL_ORDER: readonly AiBoatKind[] = ['red', 'orange'];
const ROLL_ODDS: Record<AiBoatKind, number> = { red: P_RED, orange: P_ORANGE };

/**
 * How far off the player a boat is born, world units.
 *
 * Red starts further out than orange because it is coming for the player and
 * the approach is the warning: at 20 kn, 40 units is two seconds of closing
 * and 60 is three. Both bands straddle the scope's 50-unit `RADAR_RANGE`
 * rather than sitting inside it, so a raider born at the far end is a light
 * that appears on the rim as it closes rather than one that was always there.
 * That is the owner's intent, so no bearing bias is applied to red: it may
 * come from anywhere on the compass.
 */
export const RED_SPAWN_MIN = 40;
export const RED_SPAWN_MAX = 60;
export const ORANGE_SPAWN_MIN = 30;
export const ORANGE_SPAWN_MAX = 50;

/**
 * How fast each colour runs, world units/s, the unit `hud.ts` prints as a
 * knot.
 *
 * Both are faster than the player's `MAX_FORWARD` of 10, and that is the whole
 * point of them: neither can be outrun in a straight line, so a player who
 * wants to avoid a fight has to out-TURN one. See RED_TURN_RATE, which is what
 * makes that possible.
 *
 * The two are now the SAME speed, and the aggressor is no longer the faster
 * hull. What still separates them is intent and not pace: a red boat steers
 * at the player every frame while an orange one runs a track drawn once and
 * never revised, so red closes because it is aimed, not because it is quick.
 * The escape is unchanged in kind and easier in degree -- see RED_TURN_RATE,
 * whose turning circle tightens with the speed drop rather than widening.
 */
export const RED_SPEED = 15;
export const ORANGE_SPEED = 15;

/**
 * Seconds a boat spends in one phase: a red boat's pursuit, and any orange
 * boat's straight run.
 *
 * Short on purpose. A red boat covers 75 to 120 units in this time, which is
 * one and a half to two scope diameters, so a chase is a thing that happens
 * and then is over rather than a state the player is stuck in. It is also the other half
 * of the escape: a wide turning circle only matters if the chaser runs out of
 * clock before it can come round for a second pass.
 */
export const PHASE_MIN = 5;
export const PHASE_MAX = 8;

/**
 * The tightest a red boat can turn, radians/s.
 *
 * Thirty-five degrees a second at 15 kn is a turning circle of about 25 units
 * radius, seven hull lengths. The player at 10 kn and `ship.ts`'s `TURN_RATE`
 * of 1.2 rad/s turns inside 9. That gap is the escape the owner asked for: a
 * player who puts the helm hard over away from the bow gets inside the
 * chaser's circle, and it overshoots and has to come round again, which the
 * clock above does not leave it time to do.
 *
 * The plan proposed fifty degrees and it is not enough, measured across the
 * whole 40-to-60-unit spawn band: a hard turn away shakes a boat born at 45
 * units by half a hull, and one born at 60 gets a long enough run-up to close
 * the corner and connect anyway. At thirty-five the turn away works from
 * anywhere in the band with a hull's clearance to spare, and turning the wrong
 * way, across the chaser's bow rather than off it, still gets the player
 * rammed, which is what keeps the escape a decision rather than a formality.
 *
 * Pure pursuit, never lead pursuit. Aiming at where the player WILL be makes a
 * chaser markedly harder to shake, and escapable was the decision.
 */
export const RED_TURN_RATE = (35 * Math.PI) / 180;

/**
 * How an orange boat's fixed track is aimed: the share of them pointed at the
 * player at all, how far ahead of the hull they aim, and how far across it
 * they are allowed to miss by.
 *
 * A straight track drawn on a uniform heading essentially never crosses a
 * moving ship, and the owner wants contact with an orange boat to be possible,
 * including on purpose. So half of them are laid through the player's position
 * advanced by four seconds of travel and offset up to twelve units abeam: near
 * enough to be a real crossing, loose enough that it is a passage rather than
 * an attack. The other half take a uniform heading, because a sea where every
 * stranger is heading for you is not a sea full of strangers.
 *
 * The track never changes after it is drawn, so a player who does not want the
 * meeting can simply steer off it.
 */
export const ORANGE_AIM_SHARE = 0.5;
const ORANGE_AIM_LEAD = 4;
const ORANGE_AIM_SPREAD = 12;

/**
 * How close two hulls have to be for the fight to start, world units.
 *
 * About three quarters of the 3.1-unit hull. The test is between two centres,
 * so a bow-on touch and a beam-on touch count the same and two hulls passing
 * close abeam may register a little early. That is the right trade for a
 * one-comparison test on a hull this size, and the alternative, oriented
 * boxes on a sphere, buys nothing a player could see.
 */
export const CONTACT_RADIUS = 2.4;

/**
 * Clearance a spawn keeps from a berth, on top of that berth's own radius,
 * world units.
 *
 * A berth is shelter: `energy.ts` says a docked ship is not to be shoved by
 * the sea, and this module says it is not to be fought either. A raider born
 * inside a charging zone would be a fight waiting on the water for a player
 * who thought they were safe.
 */
const BERTH_MARGIN = 4;

/**
 * Placement attempts per spawn, then give up until the next roll.
 *
 * Every attempt costs a pair of map reads and a walk over the berths. Near a
 * crowded coast most of them fail, and 24 is enough that open water almost
 * always finds a spot in the first two or three while a ship deep in an
 * archipelago simply meets fewer raiders, which is the right answer there.
 * The same number `hazards.ts` settled on, for the same reason.
 */
const SPAWN_TRIES = 24;

/**
 * Seconds a boat spends fading its lights up after a spawn, and down at the
 * end of a straight run.
 *
 * The rise is short because a raider that brightens slowly reads as a bug in
 * the neon rather than as a boat arriving. The fade is longer than the rise
 * for the opposite reason: a hull that vanished in a frame would look like a
 * dropped draw call. Conversion does not fade at all: the same hull carries
 * on, and only its colour changes.
 */
export const FADE_IN = 0.5;
export const FADE_OUT = 1;

/**
 * Seconds of quiet after a fight, during which nothing spawns and no contact
 * fires.
 *
 * A player coming out of the arena is put back exactly where the contact
 * happened, stopped, with the other colour possibly still on the water a few
 * units away. Without this they would be rammed on the first frame back, by a
 * boat they never saw, before the screen had finished fading up.
 */
export const SPAWN_GRACE = 30;

/**
 * Raider seed. Fixed by default, so a given world always draws the same
 * raiders: the same argument `wind.ts` makes for WIND_SEED and `hazards.ts`
 * for HAZARD_SEED. Tuning a chase needs the same chase back on the next run.
 */
const AIBOAT_SEED = 0xa1b0a7;

const TWO_PI = Math.PI * 2;
/** World units to radians of arc on this globe. */
const ARC = 1 / GLOBE_RADIUS;

/* ------------------------------------------------------------------ */
/* Module-scope scratch (no per-frame allocation in the hot path)      */
/* ------------------------------------------------------------------ */

const _north = new Vector3();
const _east = new Vector3();
const _axis = new Vector3();
const _bearingDir = new Vector3();
const _candidate = new Vector3();
const _forward = new Vector3();
const _desired = new Vector3();
const _target = new Vector3();
const _starboard = new Vector3();
const _prevPosition = new Vector3();

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Rotate `from` by `angle` toward the tangent direction `dir`, about their
 * cross product: the same great-circle step `ship.ts` walks in `stepAlong`
 * and `hazards.ts` in its transport. Returns false, writing nothing, when the
 * two are parallel and no axis exists.
 */
function stepAlong(out: Vector3, from: Vector3, dir: Vector3, angle: number): boolean {
  _axis.crossVectors(from, dir);
  if (_axis.lengthSq() < 1e-12) return false;
  _axis.normalize();
  out.copy(from).applyAxisAngle(_axis, angle).normalize();
  return true;
}

/** Great-circle distance between two unit directions, world units. */
function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

/**
 * The unit tangent at `at` that points along the great circle toward
 * `target`, written into `out`. False when the two coincide and there is no
 * direction to give.
 */
function pointAt(out: Vector3, at: Vector3, target: Vector3): boolean {
  out.copy(target).addScaledVector(at, -target.dot(at));
  if (out.lengthSq() < 1e-12) return false;
  out.normalize();
  return true;
}

/* ------------------------------------------------------------------ */
/* AI boats                                                            */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only AiBoat surface, plus bookkeeping. */
interface MutableAiBoat {
  kind: AiBoatKind;
  phase: AiBoatPhase;
  position: Vector3;
  forward: Vector3;
  speed: number;
  clock: number;
  envelope: number;
  /** Seconds since it was born. Drives the fade in, and only that. */
  age: number;
  /** True once it has fired `onContact`, so it cannot fire again. */
  contacted: boolean;
}

/** Internal, mutable mirror of the read-only AiBoatState surface. */
interface MutableAiBoatState {
  live: MutableAiBoat[];
  grace: number;
}

export function createAiBoats(deps: AiBoatsDeps): AiBoats {
  const { terrain, heightMap, waterBodies, towns, onContact } = deps;
  const rng = mulberry32(deps.seed ?? AIBOAT_SEED);

  const state: MutableAiBoatState = { live: [], grace: 0 };
  let rollTimer = 0;

  /* ---- The world's opinion of a point -------------------------------- */

  /*
   * Asked of the same rasterised height field the water shader, the scope and
   * `hazards.ts` read, never of `terrain.heightAt`. Readings of one field can
   * never disagree about where the shoreline is, which is why `globe.ts`
   * installs the map as the ship's land mask in the first place.
   */
  function sailable(dir: Vector3): boolean {
    return heightMap.sample(dir) < terrain.seaLevel && waterBodies.sample(dir) < 0.5;
  }

  /** True if any berth's centre is within `clearance` world units of `dir`. */
  function nearBerth(dir: Vector3, clearance: number): boolean {
    const all = towns.all;
    for (let i = 0; i < all.length; i++) {
      const dock = all[i].dock;
      if (dock === null) continue;
      if (arcDistance(dir, dock.dir) < clearance) return true;
    }
    return false;
  }

  /**
   * The widest berth in the world, cached once.
   *
   * `towns.ts` keeps `DOCK_RADIUS` private and it reaches this module only as
   * `Dock.radius`. Taking the largest rather than each berth's own keeps the
   * test one comparison per berth and errs outward, which is the safe side of
   * a rule about not starting fights in a charging zone. Same trick, same
   * reason, as `hazards.ts`.
   */
  let berthRadius = -1;
  function largestBerthRadius(): number {
    if (berthRadius >= 0) return berthRadius;
    berthRadius = 0;
    for (const town of towns.all) {
      if (town.dock !== null && town.dock.radius > berthRadius) berthRadius = town.dock.radius;
    }
    return berthRadius;
  }

  function liveOf(kind: AiBoatKind): MutableAiBoat | null {
    for (let i = 0; i < state.live.length; i++) {
      if (state.live[i].kind === kind) return state.live[i];
    }
    return null;
  }

  /* ---- Building one -------------------------------------------------- */

  /**
   * Put one boat on the water at `position` heading `forward`, and file it.
   *
   * `forward` is projected onto the tangent plane at the centre rather than
   * trusted: `force` and the dev query may hand over anything, and a bow with
   * a radial component would walk the hull off the sphere on its first step.
   */
  function build(kind: AiBoatKind, position: Vector3, forward: Vector3): MutableAiBoat {
    const p = position.clone().normalize();
    const f = forward.clone();
    f.addScaledVector(p, -f.dot(p));
    if (f.lengthSq() < 1e-12) tangentFrame(p, f, _east);
    f.normalize();

    const boat: MutableAiBoat = {
      kind,
      phase: kind === 'red' ? 'pursue' : 'wander',
      position: p,
      forward: f,
      speed: kind === 'red' ? RED_SPEED : ORANGE_SPEED,
      clock: PHASE_MIN + rng() * (PHASE_MAX - PHASE_MIN),
      envelope: 0,
      age: 0,
      contacted: false,
    };
    // One of each colour, so a second of the same replaces the first rather
    // than quietly leaving `aihulls.ts` a boat with no hull to draw it with.
    for (let i = state.live.length - 1; i >= 0; i--) {
      if (state.live[i].kind === kind) state.live.splice(i, 1);
    }
    state.live.push(boat);
    return boat;
  }

  /* ---- Spawning ------------------------------------------------------ */

  /**
   * The heading a new boat leaves on, written into `_forward`.
   *
   * Red points at the player and starts turning from there. Orange draws all
   * three of its numbers whichever branch it takes, for the same reason the
   * roll draws unconditionally: a branch that consumed a different count from
   * the stream than its neighbour would make the seeded sequence depend on its
   * own results.
   */
  function headingFor(kind: AiBoatKind, at: Vector3, ship: ShipState): boolean {
    if (kind === 'red') return pointAt(_forward, at, ship.position);

    const aimed = rng() < ORANGE_AIM_SHARE;
    const spread = (rng() * 2 - 1) * ORANGE_AIM_SPREAD;
    const wander = rng() * TWO_PI;

    if (!aimed) {
      tangentFrame(at, _north, _east);
      _forward
        .copy(_north)
        .multiplyScalar(Math.cos(wander))
        .addScaledVector(_east, Math.sin(wander));
      return _forward.lengthSq() > 1e-12;
    }

    /*
     * The aim point is built in DIRECTION space: a world-unit offset becomes
     * an offset on the unit sphere by multiplying by ARC, exactly as every
     * other distance in this file is converted at the point of use. It is only
     * a target for `pointAt`, so the small-angle error over twelve units is
     * far below the twelve units of spread it is being offset by.
     */
    _starboard.crossVectors(ship.forward, ship.up);
    if (_starboard.lengthSq() > 1e-12) _starboard.normalize();
    _target
      .copy(ship.position)
      .addScaledVector(ship.velocity, ORANGE_AIM_LEAD * ARC)
      .addScaledVector(_starboard, spread * ARC)
      .normalize();
    return pointAt(_forward, at, _target);
  }

  /** Try to place one boat of `kind`. Returns whether it was placed. */
  function trySpawn(kind: AiBoatKind, ship: ShipState): boolean {
    const near = kind === 'red' ? RED_SPAWN_MIN : ORANGE_SPAWN_MIN;
    const far = kind === 'red' ? RED_SPAWN_MAX : ORANGE_SPAWN_MAX;

    for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
      const d = near + rng() * (far - near);
      const bearing = rng() * TWO_PI;

      // Resolved in a frame raised at the SHIP and used immediately, never
      // stored: see the file header on why a bearing may not be kept.
      tangentFrame(ship.position, _north, _east);
      _bearingDir
        .copy(_north)
        .multiplyScalar(Math.cos(bearing))
        .addScaledVector(_east, Math.sin(bearing));
      if (!stepAlong(_candidate, ship.position, _bearingDir, d * ARC)) continue;

      // The cheapest test first, and the one that rejects most.
      if (!sailable(_candidate)) continue;
      if (nearBerth(_candidate, largestBerthRadius() + BERTH_MARGIN)) continue;
      if (!headingFor(kind, _candidate, ship)) continue;

      build(kind, _candidate, _forward);
      return true;
    }
    return false;
  }

  /**
   * One roll: a draw for every colour, in a fixed order, live or not.
   *
   * The unconditional draw is the whole point; see ROLL_ORDER.
   */
  function roll(ship: ShipState, suppressed: boolean, stormOdds: number): void {
    for (const kind of ROLL_ORDER) {
      const draw = rng();
      if (suppressed || state.grace > 0) continue;
      if (liveOf(kind) !== null) continue;
      // Orange takes the weather's multiplier; red never does. See the note
      // on `stormOdds` in the interface above for why the sky may make the
      // sea busier without making it more hostile.
      const odds = kind === 'orange' ? ROLL_ODDS[kind] * stormOdds : ROLL_ODDS[kind];
      if (draw < odds) trySpawn(kind, ship);
    }
  }

  /* ---- Pursuit, conversion, transport -------------------------------- */

  /**
   * Turn a red boat's bow toward the player's CURRENT position, by at most
   * `RED_TURN_RATE * dt`.
   *
   * Pure pursuit: the aim point is where the player is, not where they will
   * be. The cap is the whole difficulty of the thing: inside about eleven
   * units the bearing to a player crossing at 10 kn swings faster than fifty
   * degrees a second and the chaser simply cannot hold it, which is what makes
   * a hard turn across the bow work.
   */
  function pursue(boat: MutableAiBoat, ship: ShipState, dt: number): void {
    if (!pointAt(_desired, boat.position, ship.position)) return;
    const angle = Math.acos(Math.max(-1, Math.min(1, boat.forward.dot(_desired))));
    const most = RED_TURN_RATE * dt;
    if (angle <= most) {
      boat.forward.copy(_desired);
      return;
    }
    // The bow turns about the surface normal, never in a chart. The sense
    // comes off the cross product rather than a signed angle, so it means the
    // same thing at a pole as it does at the equator.
    _axis.crossVectors(boat.forward, _desired);
    const sense = _axis.dot(boat.position) >= 0 ? 1 : -1;
    boat.forward.applyAxisAngle(boat.position, sense * most);
    boat.forward.addScaledVector(boat.position, -boat.forward.dot(boat.position));
    if (boat.forward.lengthSq() > 1e-12) boat.forward.normalize();
  }

  /**
   * A red boat gives up: it becomes an orange one on a fresh heading and a
   * fresh clock, and sails away.
   *
   * The one case that cannot be honoured is an orange boat already on the
   * water, because there is one orange hull downstream and no more. Then the
   * raider simply breaks off instead: it keeps its colour, stops chasing, and
   * runs out its fade on the heading it was on. A player sees a chaser lose
   * interest either way, which is the point of the rule.
   */
  function convert(boat: MutableAiBoat): void {
    if (liveOf('orange') !== null) {
      boat.phase = 'wander';
      boat.clock = FADE_OUT;
      return;
    }
    boat.kind = 'orange';
    boat.phase = 'wander';
    boat.speed = ORANGE_SPEED;
    boat.clock = PHASE_MIN + rng() * (PHASE_MAX - PHASE_MIN);
    tangentFrame(boat.position, _north, _east);
    const heading = rng() * TWO_PI;
    boat.forward
      .copy(_north)
      .multiplyScalar(Math.cos(heading))
      .addScaledVector(_east, Math.sin(heading))
      .normalize();
  }

  /**
   * Carry a boat one step along its own bow.
   *
   * The step is a great-circle rotation and `forward` is carried by exactly
   * that same rotation: parallel transport, `ship.ts`'s way with the bow and
   * `wind.ts`'s with the weather. The re-orthogonalisation afterwards is not
   * decoration: each step leaves the tangent a rounding error out of the
   * plane, and a red boat covers 120 units in its life.
   */
  function transport(boat: MutableAiBoat, dt: number): void {
    _prevPosition.copy(boat.position);
    if (!stepAlong(boat.position, boat.position, boat.forward, boat.speed * dt * ARC)) return;

    _axis.crossVectors(_prevPosition, boat.position);
    const sin = _axis.length();
    if (sin > 1e-12) {
      _axis.multiplyScalar(1 / sin);
      const cos = Math.max(-1, Math.min(1, _prevPosition.dot(boat.position)));
      boat.forward.applyAxisAngle(_axis, Math.atan2(sin, cos));
    }
    boat.forward.addScaledVector(boat.position, -boat.forward.dot(boat.position));
    if (boat.forward.lengthSq() > 1e-12) boat.forward.normalize();
    else tangentFrame(boat.position, boat.forward, _east);
  }

  /**
   * The fade, 0..1: up over FADE_IN from birth, down over the last FADE_OUT of
   * a straight run.
   *
   * `age` counts from the spawn and is never reset, which is exactly what
   * makes conversion free of a second fade-in: a boat converting after five
   * seconds of pursuit is long past FADE_IN and simply stays lit.
   */
  function envelopeOf(boat: MutableAiBoat): number {
    let e = boat.age < FADE_IN ? boat.age / FADE_IN : 1;
    if (boat.phase === 'wander' && boat.clock < FADE_OUT) {
      const out = boat.clock / FADE_OUT;
      if (out < e) e = out;
    }
    return clamp01(e);
  }

  /* ---- The frame ----------------------------------------------------- */

  function update(
    dt: number,
    ship: ShipState,
    _energy: EnergyState,
    _hazards: HazardState,
    suppressed: boolean,
    stormOdds = 1,
  ): void {
    // A frame that advanced no time draws no raiders. Returning leaves the
    // last true state standing rather than rewriting it with a stale zero.
    // `energy` and `hazards` are here because `main.ts`'s `suppressed` is
    // derived from them and the loop order is documented against that; this
    // module reads the verdict, never the two states behind it.
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    if (state.grace > 0) state.grace = Math.max(0, state.grace - dt);

    // ---- Roll -------------------------------------------------------
    rollTimer += dt;
    while (rollTimer >= ROLL_PERIOD) {
      rollTimer -= ROLL_PERIOD;
      roll(ship, suppressed, stormOdds);
    }

    // ---- Steer, travel, and the coast -------------------------------
    for (let i = state.live.length - 1; i >= 0; i--) {
      const boat = state.live[i];
      boat.age += dt;

      if (boat.phase === 'pursue') pursue(boat, ship, dt);
      transport(boat, dt);

      // A hull that has run onto a beach, or into water the player could
      // never sail to, is gone that frame. The cheapest rule there is, and
      // the one the crests use: nothing is drawn aground and nothing is
      // stranded in a lake.
      if (!sailable(boat.position)) {
        state.live.splice(i, 1);
        continue;
      }

      boat.clock -= dt;
      if (boat.phase === 'pursue') {
        // Out of clock, or standing over a ship it is not allowed to fight:
        // a berth is shelter here as much as it is from the weather, and a
        // raider that has arrived at one gives up rather than waiting.
        if (boat.clock <= 0 || (suppressed && arcDistance(ship.position, boat.position) < CONTACT_RADIUS)) {
          convert(boat);
        }
      } else if (boat.clock <= 0) {
        state.live.splice(i, 1);
        continue;
      }

      boat.envelope = envelopeOf(boat);
    }

    // ---- Contact ----------------------------------------------------
    // Once per boat, ever. `main.ts` halts the hull and opens the arena from
    // inside this call, and the boat stays in `live` so the arena has a hull
    // to borrow; `remove` is what finally takes it.
    if (!suppressed && state.grace <= 0) {
      for (let i = 0; i < state.live.length; i++) {
        const boat = state.live[i];
        if (boat.contacted) continue;
        if (arcDistance(ship.position, boat.position) < CONTACT_RADIUS) {
          boat.contacted = true;
          onContact(boat as AiBoat);
        }
      }
    }
  }

  function remove(boat: AiBoat): void {
    const i = state.live.indexOf(boat as MutableAiBoat);
    if (i >= 0) state.live.splice(i, 1);
    state.grace = SPAWN_GRACE;
  }

  function force(kind: AiBoatKind, position: Vector3, forward: Vector3): void {
    build(kind, position, forward);
  }

  return { state: state as AiBoatState, update, remove, force };
}
