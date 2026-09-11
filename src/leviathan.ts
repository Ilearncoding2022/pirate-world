import { Vector3 } from 'three';
import type { HeightMap } from './heightmap';
import type { HuntEvent, HuntPhase, HuntState, Shadow, ShipState, Terrain, Towns } from './types';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { mulberry32 } from './towns';

/**
 * leviathan.ts: the hunt, in world units.
 *
 * A shoal of shadows drifts across open water. One of them at a time is
 * marked, and a timing dial arms only while that one is inside harpoon range
 * AND inside the bow's arc. Five targets, then the purse. See
 * docs/LEVIATHAN_PLAN.md, which is the brief this file is built from.
 *
 * Owns one `HuntState`, mutated in place for the life of the run, as
 * `aiboats.ts` owns `AiBoatState` and `hazards.ts` owns `HazardState`. DOM-free
 * and scene-free: it moves numbers and vectors, and it is the module the unit
 * tests exercise. `leviathanshadows.ts` is what puts sprites where it says and
 * `leviathandial.ts` is what draws the bar it computes.
 *
 * **This is not an overlay.** Every other activity in this game is a card over
 * a frozen world, and an implementer reaching for `fishcover.ts` as a template
 * has already lost the feature: there is no `open()`, no `onOpen`/`onClose`
 * pair, no entry in the pause contract's list and no dimmed backdrop. The hunt
 * runs on the SAILING branch, which is what makes it the first activity played
 * with the actual helm.
 *
 * `aiboats.ts` is the model this file is cut from, and the two geometry rules
 * that run through it run through this one for the same reasons:
 *
 *   - **Nothing is kept as a compass bearing.** A shadow is a centre and a
 *     tangent, carried across its own travel by parallel transport, exactly as
 *     `ship.ts` carries the bow. A bearing lives in the tangent frame at one
 *     point, and that frame spins arbitrarily fast near a pole. `tangentFrame`
 *     is built fresh at the point of use and never held.
 *   - **The seeded stream is drawn from unconditionally.** The roll takes its
 *     number whether or not it can act on it, so what happens to be on the
 *     water cannot reorder the draws behind it.
 *
 * One thing it deliberately does NOT share with `aiboats.ts`: that module caps
 * itself at one live boat per colour because `aihulls.ts` keeps one hull clone
 * per colour. A shadow is a sprite out of a pool sized to `SHOAL_COUNT`, so the
 * cap here is one live SHOAL, and it exists because two hunts at once would be
 * two dials.
 */

/* ------------------------------------------------------------------ */
/* The roll                                                            */
/* ------------------------------------------------------------------ */

/**
 * Seconds between spawn rolls, and the chance one lands.
 *
 * Read them together: they are one rate written as a cadence and a chance.
 * `aiboats.ts`'s period unchanged, because a shoal is the same order of
 * interruption as a raider and may not arrive more often than one.
 *
 * At 0.06 a roll, a shoal is about one every three minutes of open-water
 * sailing before the clearance tests reject any of them, which against a
 * two-minute circumnavigation is a thing found a few times a lap rather than
 * a thing tripped over. The real rate is governed as much by how long a shoal
 * LIVES and by `SPAWN_GRACE` as by this number; move this one, not the period,
 * since the period also governs nothing else here.
 */
export const ROLL_PERIOD = 10;
export const P_SHOAL = 0.06;

/**
 * How far off the player a shoal is born, world units.
 *
 * Both ends sit INSIDE the scope's 50-unit `RADAR_RANGE`, and that is the
 * whole difference from `aiboats.ts`, whose bands straddle it so that a raider
 * arrives on the rim. A shoal is something you go to rather than something
 * that comes to you, so it is drawn where it can be seen first and reached
 * second: finding one is navigation, not luck.
 */
export const SHOAL_SPAWN_MIN = 30;
export const SHOAL_SPAWN_MAX = 45;

/**
 * How far the marked shadow may get before the shoal is gone, world units.
 *
 * Comfortably outside the spawn band, so a player who turns away for a few
 * seconds has not lost it, and comfortably inside a scope diameter, so a shoal
 * cannot follow a ship around the world. Sailing past one is a decision the
 * player is allowed to make and this is what makes it stick.
 */
export const DESPAWN_RANGE = 70;

/**
 * Clearance a spawn keeps from a berth, on top of that berth's own radius,
 * world units.
 *
 * Larger than `aiboats.ts`'s four, and for a reason that module does not have:
 * Space is the moor-and-cast-off key inside a berth ring, and an armed dial
 * inside one would be two meanings on one key. `armed` is also false while
 * docked, so this is the second of two guards on the same thing. See
 * docs/LEVIATHAN_PLAN.md, trap 2.
 */
const BERTH_MARGIN = 25;

/**
 * Placement attempts per spawn, then give up until the next roll.
 *
 * The same number `aiboats.ts` and `hazards.ts` settled on, for the same
 * reason: near a crowded coast most attempts fail, and a ship deep in an
 * archipelago simply meets fewer shoals, which is the right answer there.
 */
const SPAWN_TRIES = 24;

/**
 * Seconds of quiet after a hunt ends, during which no roll lands.
 *
 * `aiboats.ts`'s figure. A player who has just watched a shoal scatter should
 * not have the next one appear while the purse is still on the strip.
 */
export const SPAWN_GRACE = 30;

/* ------------------------------------------------------------------ */
/* The shoal                                                           */
/* ------------------------------------------------------------------ */

/**
 * Shadows drawn, and how wide they sit about the shoal's centre, world units.
 *
 * Fourteen is enough that the water reads as occupied rather than as a handful
 * of marks, and nine units of spread is three hull lengths: wide enough that
 * the marked one is a target to pick out and narrow enough that the whole
 * shoal is in frame at the chase camera's usual distance.
 */
export const SHOAL_COUNT = 14;
export const SHOAL_RADIUS = 9;

/**
 * How fast a shadow travels, world units/s, the unit `hud.ts` prints as a knot.
 *
 * Well under the hull's ~10.5 cruise, and that is deliberate: a shoal can
 * always be caught on a straight run, so the difficulty is never the speed.
 * It is the heading reroll below, which is what makes a lead a guess.
 */
export const SHADOW_SPEED = 4;

/**
 * Seconds the shoal holds a heading before it may turn, and how far it turns.
 *
 * The owner's figures. Five to ten seconds is long enough to commit to a lead
 * and short enough that committing is a risk; sixty degrees either side is
 * wide enough to put a bow-on approach abeam in one reroll, which is the
 * moment the helm has to answer.
 */
export const HEADING_HOLD_MIN = 5;
export const HEADING_HOLD_MAX = 10;
export const TURN_MAX = (60 * Math.PI) / 180;

/* ------------------------------------------------------------------ */
/* The gate, which is the whole design                                 */
/* ------------------------------------------------------------------ */

/**
 * How close the marked shadow must be for the dial to arm, world units.
 *
 * Four hull lengths. Close enough that reaching it is steering rather than
 * pointing, and far enough that the shoal is not under the bow when the press
 * lands. Set against `SHADOW_SPEED` and the reroll, holding a target inside
 * this for the two seconds of a sweep is the skill the activity is made of.
 */
export const HARPOON_RANGE = 12;

/**
 * How far off the bow the marked shadow may be and still arm the dial, radians
 * either side.
 *
 * Thirty degrees. Without this gate the dial is `fishsim.ts`'s swing with a
 * different readout and the helm does nothing, which is the one way this
 * feature can be built wrong. See docs/LEVIATHAN_PLAN.md, decision 3.
 */
export const BOW_ARC = (30 * Math.PI) / 180;

/* ------------------------------------------------------------------ */
/* The dial                                                            */
/* ------------------------------------------------------------------ */

/**
 * Seconds for one full sweep of the dial.
 *
 * `fishsim.ts`'s harpoon swings on a 2.4 s period; this is tighter, because
 * the fishing card gives the player a still world to read it in and this one
 * does not. Two seconds is about three sweeps in the time it takes a shoal to
 * drift out of the arc.
 */
export const DIAL_PERIOD = 2.0;

/**
 * Targetable shadows per hunt, and so the harpoons one hunt may take.
 *
 * One press is one harpoon, so five is also the ceiling on the locker draw,
 * which is exactly one `HARPOON_BUNDLE`: one bundle buys one hunt. There is
 * deliberately no second "max draw" constant to disagree with this one.
 */
export const HUNT_TARGETS = 5;

/**
 * Damage under which the shoal scatters and the hunt is over.
 *
 * Twenty-five, which is `|dial| > 0.75`: the outer quarter of each red band.
 * This is the failure state, and it is what turns five targets from a promise
 * into a ceiling. `docs/ROADMAP.md` calls the absence of a failure state a
 * CHOICE rather than a gap, so this is scoped to the hunt and changes nothing
 * about the game as a whole: a scattered shoal still pays what was banked.
 */
export const SOUND_BELOW = 25;

/**
 * Gold per point of damage.
 *
 * Ten, not fifty. At fifty a perfect hunt pays 25 000 with no stake, which
 * beats a won fight (`bounty.ts` tops out at 20 000 and costs a tenth of the
 * purse to lose) and makes every other activity in the game irrelevant. At ten
 * a hunt pays 1 820 blind and about 4 250 played well, which lands just above
 * the fight's expected value and level with the best contract, with the fight
 * keeping the jackpot. `questconstants.ts` holds exactly this line for
 * contracts and the argument is the same one.
 */
export const HUNT_GOLD_PER_DAMAGE = 10;

/**
 * Every purse is rounded to a multiple of this.
 *
 * `questconstants.ts`'s `GOLD_ROUNDING`, retyped rather than imported for the
 * reason that file's own comment gives about `governor.ts`: a hunt is not a
 * contract and importing one economy's constant into another is how the two
 * end up retuned together by accident.
 */
const GOLD_ROUNDING = 50;

/**
 * Seconds a shadow spends fading its shape up after a spawn, and down at the
 * end of a hunt.
 *
 * `aiboats.ts`'s figures. The rise is short because a shape that resolves
 * slowly reads as a bug in the water rather than as something arriving; the
 * fade is longer because a shoal that vanished in a frame would look like a
 * dropped draw call.
 */
export const FADE_IN = 0.5;
export const FADE_OUT = 1;

/**
 * Hunt seed. Fixed by default, so a given world always draws the same shoals:
 * the same argument `wind.ts` makes for WIND_SEED and `aiboats.ts` for
 * AIBOAT_SEED. Tuning a chase needs the same chase back on the next run.
 */
const LEVIATHAN_SEED = 0x1e71a7;

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
const _offset = new Vector3();
const _toShadow = new Vector3();
const _prevPosition = new Vector3();
const _candidateEdge = new Vector3();

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Rotate `from` by `angle` toward the tangent direction `dir`, about their
 * cross product: the same great-circle step `ship.ts` walks in `stepAlong` and
 * `aiboats.ts` in its transport. Returns false, writing nothing, when the two
 * are parallel and no axis exists.
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
 * The unit tangent at `at` that points along the great circle toward `target`,
 * written into `out`. False when the two coincide and there is no direction to
 * give.
 */
function pointAt(out: Vector3, at: Vector3, target: Vector3): boolean {
  out.copy(target).addScaledVector(at, -target.dot(at));
  if (out.lengthSq() < 1e-12) return false;
  out.normalize();
  return true;
}

/**
 * Damage a press at dial position `p` is worth.
 *
 * ONE ramp, and the five colour bands `leviathandial.ts` paints are a readout
 * of this and nothing else: they are where the colour changes and no rule ever
 * reads them, so the palette can be retuned without touching the ruleset.
 *
 * 100 at the centre, 0 at either end. The dial itself is a SINE, which is what
 * makes the green band harder than its width suggests: a sine lingers near the
 * extremes and crosses the middle fastest, so a press at a uniformly random
 * moment averages `100 * (1 - 2/PI)`, about 36, and not the 50 a linear sweep
 * would give.
 */
export function damageAt(p: number): number {
  if (!Number.isFinite(p)) return 0;
  const mag = Math.abs(p);
  if (mag >= 1) return 0;
  return Math.round(100 * (1 - mag));
}

/** A hunt's purse, gold, from the damage it banked. */
export function huntGold(banked: number): number {
  if (!(banked > 0)) return 0;
  const raw = banked * HUNT_GOLD_PER_DAMAGE;
  return Math.round(raw / GOLD_ROUNDING) * GOLD_ROUNDING;
}

/* ------------------------------------------------------------------ */
/* The module                                                          */
/* ------------------------------------------------------------------ */

/**
 * The locker, as this module needs it.
 *
 * Deliberately the narrowest slice of `HarpoonStore` that does the job:
 * `count` to decide whether the dial may arm at all, and `spend` to debit one
 * as the shot fires. Never a reserve of five up front: `fishing.ts` debits as
 * shots are fired precisely so a session abandoned mid-way cannot swallow
 * harpoons that were never thrown, and a hunt that disagreed with the card
 * about what a spare is would be a second opinion on one number.
 */
export interface HuntLocker {
  readonly count: number;
  spend(n: number): number;
}

export interface LeviathanDeps {
  terrain: Terrain;
  heightMap: HeightMap;
  waterBodies: WaterBodies;
  towns: Towns;
  /** The spare-harpoon locker, shared with the fishing card. */
  harpoons: HuntLocker;
  seed?: number;
  /**
   * Fired on every hit and once at the end of a hunt. `main.ts` pays the
   * wallet and pushes the strip from here; this module never touches either.
   */
  onEvent: (event: HuntEvent) => void;
}

export interface Leviathan {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: HuntState;
  /**
   * One frame, on the SAILING branch only, after `aiBoats.update` and before
   * `ship.update`.
   *
   * `suppressed` is `main.ts`'s own verdict (docked, mid-blackout, or in a
   * maelstrom), the identical call `aiBoats.update` is handed. It blocks both
   * the roll and the dial, and it scatters a hunt already under way: a hull in
   * a spiral is not one the player is steering.
   */
  update(dt: number, ship: ShipState, suppressed: boolean): void;
  /**
   * The press. Returns the damage it was worth, or -1 when the dial was not
   * armed and nothing happened.
   *
   * A refusal costs nothing: no harpoon, no target, no event. The view only
   * offers the key while `state.armed` is true, so -1 is the race between a
   * keystroke and a shoal drifting out of the arc, not an error.
   */
  fire(): number;
  /** Ends any live hunt, paying what was banked. `main.ts` calls it on a wreck. */
  scatter(): void;
  /** Puts a shoal on the water ahead of the bow. The `?hunt=` dev query's hand. */
  force(ship: ShipState): boolean;
}

/** Internal, mutable mirror of the read-only `Shadow` surface, plus bookkeeping. */
interface MutableShadow {
  position: Vector3;
  forward: Vector3;
  marked: boolean;
  envelope: number;
  /** Seconds since the shoal was born. Drives the fade in, and only that. */
  age: number;
}

/** Internal, mutable mirror of the read-only `HuntState` surface. */
interface MutableHuntState {
  phase: HuntPhase;
  shadows: MutableShadow[];
  target: number;
  banked: number;
  armed: boolean;
  dial: number;
  grace: number;
}

export function createLeviathan(deps: LeviathanDeps): Leviathan {
  const { terrain, heightMap, waterBodies, towns, harpoons, onEvent } = deps;
  const rng = mulberry32(deps.seed ?? LEVIATHAN_SEED);

  const state: MutableHuntState = {
    phase: 'idle',
    shadows: [],
    target: 0,
    banked: 0,
    armed: false,
    dial: 0,
    grace: 0,
  };

  let rollTimer = 0;
  /** Seconds until the shoal may turn again. */
  let headingClock = 0;
  /** Seconds the dial has been armed. Reset on every arming; see `arm`. */
  let dialClock = 0;
  /** Seconds of fade left in `settling`. */
  let settleClock = 0;
  /** Whether the player has been told the locker is empty, once per shoal. */
  let toldDry = false;

  /* ---- The world's opinion of a point -------------------------------- */

  /*
   * Asked of the same rasterised height field the water shader, the scope and
   * `aiboats.ts` read, never of `terrain.heightAt`. Readings of one field can
   * never disagree about where the shoreline is.
   */
  function sailable(dir: Vector3): boolean {
    return heightMap.sample(dir) < terrain.seaLevel && waterBodies.sample(dir) < 0.5;
  }

  /**
   * True if a shoal laid about `centre` would be entirely on water.
   *
   * The centre alone is not enough, and this is not a nicety. A shadow sits up
   * to `SHOAL_RADIUS` (nine units) from the centre, and `update` ends a hunt
   * the moment the MARKED shadow is aground. Testing only the middle therefore
   * puts shoals on coasts that scatter on the frame after they are laid, which
   * reaches the player as a notice about a shoal they never saw.
   *
   * Four cardinal points at the full radius rather than a dense sample: the
   * shoal is a disc, the coastline it has to clear is far coarser than nine
   * units, and four map reads on a spawn attempt that already costs two is the
   * right price for closing this.
   */
  function shoalFits(centre: Vector3): boolean {
    if (!sailable(centre)) return false;
    tangentFrame(centre, _north, _east);
    for (let i = 0; i < 4; i++) {
      const bearing = (i * Math.PI) / 2;
      _offset
        .copy(_north)
        .multiplyScalar(Math.cos(bearing))
        .addScaledVector(_east, Math.sin(bearing));
      if (!stepAlong(_candidateEdge, centre, _offset, SHOAL_RADIUS * ARC)) return false;
      if (!sailable(_candidateEdge)) return false;
    }
    return true;
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
   * The widest berth in the world, cached once. `aiboats.ts`'s trick and its
   * reason: one comparison per berth, erring outward, which is the safe side
   * of a rule about not arming a second meaning for the moor key.
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

  /** The marked shadow, or null. There is exactly one whenever `drifting`. */
  function marked(): MutableShadow | null {
    for (let i = 0; i < state.shadows.length; i++) {
      if (state.shadows[i].marked) return state.shadows[i];
    }
    return null;
  }

  /* ---- Building one -------------------------------------------------- */

  /**
   * Lay a shoal of `SHOAL_COUNT` shadows about `centre`, heading `forward`.
   *
   * Each shadow gets its OWN position and its own tangent, rather than an
   * offset resolved against the centre every frame. Two reasons, and the
   * second is the load-bearing one: a shared tangent is tangent at the centre
   * and not at the shadow, which over nine units is two and a half degrees of
   * lie, and a shoal whose members transport themselves stays a shoal without
   * anything having to re-derive it.
   */
  function build(centre: Vector3, forward: Vector3): void {
    const c = centre.clone().normalize();
    const f = forward.clone();
    f.addScaledVector(c, -f.dot(c));
    if (f.lengthSq() < 1e-12) tangentFrame(c, f, _east);
    f.normalize();

    state.shadows.length = 0;
    tangentFrame(c, _north, _east);

    for (let i = 0; i < SHOAL_COUNT; i++) {
      // A disc rather than a ring: the square root is what keeps the middle
      // from being sparse, which a uniform radius would make it.
      const radius = SHOAL_RADIUS * Math.sqrt(rng());
      const bearing = rng() * TWO_PI;
      _offset
        .copy(_north)
        .multiplyScalar(Math.cos(bearing))
        .addScaledVector(_east, Math.sin(bearing));

      const position = new Vector3();
      if (!stepAlong(position, c, _offset, radius * ARC)) position.copy(c);

      // The shoal's heading, re-expressed as a tangent at THIS shadow's own
      // position. Projecting rather than copying is what keeps the invariant
      // the tests assert: every forward is tangent where it lives.
      const bow = new Vector3().copy(f);
      bow.addScaledVector(position, -bow.dot(position));
      if (bow.lengthSq() < 1e-12) tangentFrame(position, bow, _east);
      bow.normalize();

      state.shadows.push({ position, forward: bow, marked: false, envelope: 0, age: 0 });
    }

    // Target one of five, and the mark starts on a shadow drawn from the same
    // stream everything else here comes off.
    state.shadows[Math.floor(rng() * state.shadows.length)].marked = true;

    state.phase = 'drifting';
    state.target = 0;
    state.banked = 0;
    state.armed = false;
    state.dial = 0;
    headingClock = HEADING_HOLD_MIN + rng() * (HEADING_HOLD_MAX - HEADING_HOLD_MIN);
    dialClock = 0;
    toldDry = false;
  }

  /* ---- Spawning ------------------------------------------------------ */

  /** Try to place one shoal. Returns whether it was placed. */
  function trySpawn(ship: ShipState): boolean {
    for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
      const d = SHOAL_SPAWN_MIN + rng() * (SHOAL_SPAWN_MAX - SHOAL_SPAWN_MIN);
      const bearing = rng() * TWO_PI;
      const heading = rng() * TWO_PI;

      // Resolved in a frame raised at the SHIP and used immediately, never
      // stored: see the file header on why a bearing may not be kept.
      tangentFrame(ship.position, _north, _east);
      _bearingDir
        .copy(_north)
        .multiplyScalar(Math.cos(bearing))
        .addScaledVector(_east, Math.sin(bearing));
      if (!stepAlong(_candidate, ship.position, _bearingDir, d * ARC)) continue;

      // The cheapest test first, and the one that rejects most.
      if (!shoalFits(_candidate)) continue;
      if (nearBerth(_candidate, largestBerthRadius() + BERTH_MARGIN)) continue;

      tangentFrame(_candidate, _north, _east);
      _offset
        .copy(_north)
        .multiplyScalar(Math.cos(heading))
        .addScaledVector(_east, Math.sin(heading));
      build(_candidate, _offset);
      return true;
    }
    return false;
  }

  /**
   * One roll: a draw taken whether or not it can be acted on.
   *
   * The unconditional draw is the whole point, and it is `aiboats.ts`'s rule:
   * skipping the number when a shoal happens to be live would let what is on
   * the water reorder the seeded stream behind it.
   */
  function roll(ship: ShipState, suppressed: boolean): void {
    const draw = rng();
    if (suppressed || state.grace > 0) return;
    if (state.phase !== 'idle') return;
    if (draw < P_SHOAL) trySpawn(ship);
  }

  /* ---- Drift --------------------------------------------------------- */

  /**
   * Turn the whole shoal by one angle, each shadow about its own normal.
   *
   * About the surface normal and never in a chart, and the sense comes off the
   * sign of the drawn angle rather than off a bearing subtraction, so it means
   * the same thing at a pole as at the equator.
   */
  function reroll(): void {
    const angle = (rng() * 2 - 1) * TURN_MAX;
    for (const shadow of state.shadows) {
      shadow.forward.applyAxisAngle(shadow.position, angle);
      shadow.forward.addScaledVector(shadow.position, -shadow.forward.dot(shadow.position));
      if (shadow.forward.lengthSq() > 1e-12) shadow.forward.normalize();
      else tangentFrame(shadow.position, shadow.forward, _east);
    }
  }

  /**
   * Carry one shadow a step along its own heading.
   *
   * The step is a great-circle rotation and `forward` is carried by exactly
   * that same rotation: parallel transport, `ship.ts`'s way with the bow and
   * `aiboats.ts`'s with a raider. The re-orthogonalisation afterwards is not
   * decoration: each step leaves the tangent a rounding error out of the
   * plane, and a shoal can drift for a minute.
   */
  function transport(shadow: MutableShadow, dt: number): void {
    _prevPosition.copy(shadow.position);
    if (!stepAlong(shadow.position, shadow.position, shadow.forward, SHADOW_SPEED * dt * ARC)) {
      return;
    }

    _axis.crossVectors(_prevPosition, shadow.position);
    const sin = _axis.length();
    if (sin > 1e-12) {
      _axis.multiplyScalar(1 / sin);
      const cos = Math.max(-1, Math.min(1, _prevPosition.dot(shadow.position)));
      shadow.forward.applyAxisAngle(_axis, Math.atan2(sin, cos));
    }
    shadow.forward.addScaledVector(shadow.position, -shadow.forward.dot(shadow.position));
    if (shadow.forward.lengthSq() > 1e-12) shadow.forward.normalize();
    else tangentFrame(shadow.position, shadow.forward, _east);
  }

  /* ---- The gate ------------------------------------------------------ */

  /**
   * Whether the dial may arm this frame.
   *
   * Four conditions, and the middle two are the feature. Range alone would be
   * proximity, and proximity alone is the fishing card played outside; the arc
   * is what makes holding a drifting target a matter of steering. The locker
   * is here rather than in `fire` so that an empty one shows as a dark dial
   * rather than as a press that silently does nothing.
   */
  function canArm(ship: ShipState, suppressed: boolean): boolean {
    if (suppressed) return false;
    if (state.phase !== 'drifting') return false;
    if (harpoons.count <= 0) return false;

    const target = marked();
    if (target === null) return false;
    if (arcDistance(ship.position, target.position) > HARPOON_RANGE) return false;

    // The bearing to the target, resolved against the bow. Two world vectors
    // and one dot product, never two compass bearings subtracted: see
    // **Frames, and where they stop working** in docs/ARCHITECTURE.md.
    if (!pointAt(_toShadow, ship.position, target.position)) return false;
    const cos = Math.max(-1, Math.min(1, ship.forward.dot(_toShadow)));
    return Math.acos(cos) <= BOW_ARC;
  }

  /* ---- Ending one ---------------------------------------------------- */

  /**
   * End a hunt, paying what it banked.
   *
   * The purse settles ONCE, here, on the transition into `settling`, which is
   * what makes the fade that follows unable to pay twice. `main.ts` moves the
   * gold; this only says how much.
   */
  function finish(kind: 'sounded' | 'settled'): void {
    const banked = state.banked;
    state.phase = 'settling';
    state.armed = false;
    state.dial = 0;
    state.grace = SPAWN_GRACE;
    settleClock = FADE_OUT;
    onEvent({ kind, damage: banked, gold: huntGold(banked) });
  }

  /* ---- The frame ----------------------------------------------------- */

  function update(dt: number, ship: ShipState, suppressed: boolean): void {
    // A frame that advanced no time draws no shoals. Returning leaves the last
    // true state standing rather than rewriting it with a stale zero, which is
    // `aiboats.ts`'s contract and the reason a paused world does not reset the
    // dial the player was reading when the menu came up.
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    if (state.grace > 0) state.grace = Math.max(0, state.grace - dt);

    // ---- The fade out -----------------------------------------------
    if (state.phase === 'settling') {
      settleClock -= dt;
      for (const shadow of state.shadows) {
        shadow.age += dt;
        shadow.envelope = clamp01(settleClock / FADE_OUT);
      }
      if (settleClock <= 0) {
        state.shadows.length = 0;
        state.phase = 'idle';
      }
      return;
    }

    // ---- Roll ---------------------------------------------------------
    rollTimer += dt;
    while (rollTimer >= ROLL_PERIOD) {
      rollTimer -= ROLL_PERIOD;
      roll(ship, suppressed);
    }

    if (state.phase !== 'drifting') return;

    // ---- Drift --------------------------------------------------------
    headingClock -= dt;
    if (headingClock <= 0) {
      reroll();
      headingClock = HEADING_HOLD_MIN + rng() * (HEADING_HOLD_MAX - HEADING_HOLD_MIN);
    }

    for (const shadow of state.shadows) {
      shadow.age += dt;
      transport(shadow, dt);
      shadow.envelope = shadow.age < FADE_IN ? clamp01(shadow.age / FADE_IN) : 1;
    }

    /*
     * Three ways a hunt ends without a press, all of them measured against the
     * MARKED shadow and not against a notional centre: the thing being hunted
     * is the thing that decides, and a shoal whose marked member has run onto
     * a beach is not one the player can still shoot at.
     *
     * Each pays what was banked. A hunt cut short by a maelstrom keeps its
     * gold for the same reason a scattered one does: the damage was real.
     */
    const target = marked();
    if (
      target === null ||
      suppressed ||
      !sailable(target.position) ||
      arcDistance(ship.position, target.position) > DESPAWN_RANGE
    ) {
      finish('sounded');
      return;
    }

    // ---- The gate and the dial ----------------------------------------
    const armed = canArm(ship, suppressed);
    if (armed && !state.armed) {
      /*
       * Arming resets the sweep.
       *
       * A player who loses the target and comes round again gets the dial from
       * a known start rather than from wherever a free-running clock happened
       * to be, which is the same reasoning `fishsim.ts` gives for stopping its
       * swing clock while the rope is out: the skill has to be learnable, and
       * a sweep whose phase depends on how long the approach took is not.
       */
      dialClock = 0;
    }
    state.armed = armed;

    if (armed) {
      dialClock += dt;
      state.dial = Math.sin((TWO_PI * dialClock) / DIAL_PERIOD);
    } else {
      state.dial = 0;
      // Said once per shoal, and only when the locker is the ONLY thing
      // standing in the way: a player who has never bought a bundle should be
      // told where the dial went, and told once rather than every frame.
      if (
        !toldDry &&
        !suppressed &&
        harpoons.count <= 0 &&
        arcDistance(ship.position, target.position) <= HARPOON_RANGE
      ) {
        toldDry = true;
        onEvent({ kind: 'dry', damage: 0, gold: 0 });
      }
    }
  }

  /* ---- The press ----------------------------------------------------- */

  function fire(): number {
    if (!state.armed || state.phase !== 'drifting') return -1;

    const target = marked();
    if (target === null) return -1;

    // Debited as the shot fires and never reserved up front, which is
    // `fishing.ts`'s rule and the reason the locker and the card can never
    // disagree about what a spare is.
    if (harpoons.spend(1) < 1) {
      state.armed = false;
      return -1;
    }

    const damage = damageAt(state.dial);
    state.banked += damage;
    state.target += 1;
    state.armed = false;
    state.dial = 0;
    onEvent({ kind: 'hit', damage, gold: 0 });

    if (damage < SOUND_BELOW) {
      finish('sounded');
      return damage;
    }
    if (state.target >= HUNT_TARGETS) {
      finish('settled');
      return damage;
    }

    /*
     * The mark moves, and never to the shadow it just left.
     *
     * Re-marking the same one would make the next target a matter of not
     * moving the helm, which is the opposite of what the arc gate is for. With
     * SHOAL_COUNT at fourteen there is always somewhere else for it to go.
     */
    target.marked = false;
    const others: MutableShadow[] = [];
    for (const shadow of state.shadows) if (shadow !== target) others.push(shadow);
    if (others.length === 0) {
      target.marked = true;
    } else {
      others[Math.floor(rng() * others.length)].marked = true;
    }
    dialClock = 0;
    return damage;
  }

  function scatter(): void {
    if (state.phase !== 'drifting') return;
    finish('sounded');
  }

  function force(ship: ShipState): boolean {
    state.grace = 0;

    /*
     * Straight up the bow at the near edge of the band, so `?hunt=` puts the
     * shoal where a player would have had to sail to find one.
     *
     * It still has to pass the same water test a rolled shoal does, and that
     * is not a formality: the ship spawns in guaranteed open ocean but thirty
     * units off the bow is a coin toss near a coast, and a shoal laid on a
     * beach scatters on the very next frame. The dev query would then appear
     * to do nothing at all, which is the failure most likely to be read as a
     * broken feature rather than as a bad spot.
     */
    if (
      stepAlong(_candidate, ship.position, ship.forward, SHOAL_SPAWN_MIN * ARC) &&
      shoalFits(_candidate)
    ) {
      // Heading back down the bow, so the shoal closes rather than runs: a dev
      // query that needed a two-minute chase before it showed anything would
      // not be used.
      tangentFrame(_candidate, _north, _east);
      if (!pointAt(_offset, _candidate, ship.position)) _offset.copy(_north);
      build(_candidate, _offset);
      return true;
    }

    // Land ahead. Fall back to the ordinary placement, which searches the
    // whole compass and honours the berth clearance: the shoal is then
    // somewhere real rather than dead ahead, which is a worse photograph and
    // a far better failure.
    return trySpawn(ship);
  }

  return { state: state as HuntState, update, fire, scatter, force };
}

/** Re-exported so `leviathanshadows.ts` and the tests share one shape. */
export type { Shadow };
