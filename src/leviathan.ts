import { Vector3 } from 'three';
import type { HeightMap } from './heightmap';
import type {
  HuntCue,
  HuntEnding,
  HuntEvent,
  HuntGate,
  HuntPhase,
  HuntState,
  Shadow,
  ShipState,
  Terrain,
  Towns,
} from './types';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { mulberry32 } from './towns';
import {
  LEVEL_HOLD,
  LEVEL_SPEED,
  SOUND_BELOW,
  type Sweep,
  arm as armSweep,
  bandFor,
  canPress,
  createSweep,
  damageAt,
  huntGoldFor,
  multiplierFor,
  position as sweepPosition,
  rateFor,
  step as stepSweep,
} from './huntsweep';

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
 * How long the marked segment may be over land before the hunt is lost,
 * seconds.
 *
 * The world's map is sampled finely enough to carry sandbars a fraction of a
 * unit wide that break the surface by a hair, narrower than anything the
 * steering reads for. Ending a hunt on the first frame the mark touched one
 * ended hunts the player could see nothing wrong with. A second is several
 * units of travel at any speed the animal swims, which carries it across a
 * sandbar and not across a coast, and coasts are what the steering keeps it
 * off in the first place.
 */
export const AGROUND_SECONDS = 1;

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
/* The body: phase 2's chained animal                                  */
/* ------------------------------------------------------------------ */

/*
 * Every figure below is a FIRST GUESS with no playtest behind it. That caveat
 * is the one docs/ROADMAP.md already carries for `questconstants.ts` and for
 * the hunt's own numbers, and this block is the third place it applies.
 */

/**
 * Units between segment centres.
 *
 * Just over half a hull length, so fourteen segments make a body about
 * twenty-two units long: readable as one animal at the chase camera's fifty-two
 * and still short enough to fit inside `SHOAL_RADIUS`'s old footprint.
 */
export const BODY_SPACING = 1.6;

/**
 * The animal's length, nose to tail, world units.
 *
 * About twenty-two: seven hull lengths, and the number that replaces
 * `SHOAL_RADIUS` everywhere the shoal's FOOTPRINT is what matters — the water
 * test at spawn, the scope's mark, and the browser tier's framing.
 * `SHOAL_RADIUS` is kept because the spawn still reasons about a disc when it
 * looks for somewhere to put one.
 */
export const BODY_LENGTH = SHOAL_COUNT * BODY_SPACING;

/** How fast the head comes round once a turn has started, radians/s. */
export const HEAD_TURN_RATE = (60 * Math.PI) / 180;

/**
 * The bank before the turn, seconds.
 *
 * Item 7 entirely. The head rolls for a full second with the turn's sign
 * BEFORE the heading moves, so a reroll stops being a surprise and starts
 * being a thing the player can read and lead.
 */
export const TURN_TELEGRAPH = 1.0;

/**
 * How fast a segment's roll eases toward the one ahead of it, per second.
 *
 * What makes a turn RIPPLE from the head to the tail over about a second
 * rather than the whole animal snapping over at once. This is most of what
 * makes fourteen chained segments read as a living thing rather than a train.
 */
export const BANK_TRAVEL = 4;

/**
 * How far out of the water a segment sits: the body, the mark, and one that
 * has just taken a harpoon.
 *
 * The mark rides higher than the rest, which is most of what makes it findable
 * at chase distance without a HUD marker on it. `SURFACE_RATE` is how fast a
 * segment eases toward its target, per second.
 */
export const SURFACE_BODY = 0.18;
export const SURFACE_MARK = 0.5;
export const SURFACE_STRUCK = 1;
export const SURFACE_RATE = 3;

/**
 * How far ahead of the head the animal looks for a coast, world units.
 *
 * The body trails its head's own path, so the only NEW water it swims into is
 * ahead, and a coast has to be seen early enough to telegraph a turn and then
 * spend it. At `BOLT_SPEED` that is `TURN_TELEGRAPH` of travel (nine units)
 * plus the turning radius `BOLT_SPEED / HEAD_TURN_RATE` (under nine more). A
 * body's length clears both, and it is the same reach the spawn's fit test
 * probes ahead.
 */
export const COAST_LOOKAHEAD = BODY_LENGTH;

/**
 * The turns an animal facing a coast weighs, smallest first, radians: every
 * fifteen degrees out to a reversal. Each is weighed toward the side it was
 * already rolling before the other side.
 */
const ESCAPE_ANGLES: readonly number[] = Array.from(
  { length: 12 },
  (_, i) => ((i + 1) * 15 * Math.PI) / 180,
);

/**
 * Reads along `COAST_LOOKAHEAD` when a heading is weighed once rather than
 * watched frame by frame: one per `BODY_SPACING`, the same density as the body.
 */
const COAST_PROBES = SHOAL_COUNT;

/** Seconds before an animal that found no clear heading looks again. */
const ESCAPE_RETRY = 0.5;

/** The step a turn's arc is walked at when it is weighed, radians. */
const ARC_STEP = (15 * Math.PI) / 180;

/**
 * How far the head swims between the points of its recorded path, world
 * units, and how many points are kept: enough for a whole body and a margin.
 */
const TRAIL_STEP = 0.25;
const TRAIL_POINTS = Math.ceil(BODY_LENGTH / TRAIL_STEP) + 8;

/**
 * A cornered animal's wheel about: its speed as a fraction of cruise, and its
 * turn rate as a multiple of `HEAD_TURN_RATE`.
 *
 * An inlet narrower than the turning circle (eight units across at cruise)
 * has no way out at full speed, and holding course runs the head aground. So
 * when no turn at speed beats the heading held, the animal slows and pivots
 * nearly in place, on a radius of a third of a unit. Its body lies on the path
 * it swam in, so it folds back along water it has already crossed.
 */
const TIGHT_SPEED = 0.25;
const TIGHT_TURN = 3;

/** How hard the head turns away from a hull inside the radius, radians/s. */
export const FLEE_TURN = (90 * Math.PI) / 180;

/** How long a struck animal runs, seconds. */
export const BOLT_SECONDS = 2;

/**
 * Units/s while bolting.
 *
 * Under the hull's ~10.5 cruise, deliberately and for `SHADOW_SPEED`'s reason:
 * a bolting animal must always be catchable on a straight run, or a bad press
 * would end the hunt by outrunning the player rather than by sounding.
 */
export const BOLT_SPEED = 9;

/**
 * How far off the bow-line a forced shoal's heading is canted, radians.
 *
 * Dev-query framing only. Enough that the mark drifts out of `BOW_ARC` within
 * a few seconds — so `?hunt=armed` still tests a gate rather than pinning one
 * open — and little enough that the body stays in frame for a screenshot.
 */
export const FORCE_CANT = (40 * Math.PI) / 180;

/** The mark's walk up one segment, seconds. */
export const HANDOFF_SECONDS = 0.6;

/** Seconds between spouts, the in-world tell that a shoal is out there. */
export const SPOUT_MIN = 6;
export const SPOUT_MAX = 10;

/**
 * Fade length per ending, seconds: sounded, scattered, settled.
 *
 * Three endings that used to share one `FADE_OUT` and therefore looked
 * identical. A sounding animal gets the longest fade because its picture is a
 * dive under a swell; a scatter is the shortest because it is a fright.
 */
export const ENDING_FADE: Readonly<Record<HuntEnding, number>> = {
  sounded: 2.5,
  scattered: 1.5,
  settled: 3,
};

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
 * How close is TOO close, world units.
 *
 * Without this the gate is unsatisfiable at point blank, and not as an edge
 * case: a player's whole instinct is to close, and the bearing to something
 * you are standing on swings to ninety degrees and past it. Measured in a
 * browser before it was believed -- the hull reached `markRange` 0.18 with
 * `markOffBow` at -88.4 and the dial had never once armed on the way in.
 *
 * It is the same geometry `aiboats.ts` already relies on from the other side:
 * "inside about eleven units the bearing to a player crossing at 10 kn swings
 * faster than fifty degrees a second and the chaser simply cannot hold it."
 * That is what makes a raider shakeable, and it is what makes a harpoon
 * unaimable.
 *
 * Five, which is under two hull lengths. It also says something true: a
 * harpoon is thrown from the deck at water ahead of the ship, not at water
 * under it. So overshooting the mark now costs a pass, which is the pressure a
 * pursuit wanted anyway.
 */
export const HARPOON_MIN_RANGE = 5;

/**
 * How close a hull has to come before the animal flees, world units.
 *
 * Equal to `HARPOON_MIN_RANGE`, and that equality is load-bearing rather than
 * a coincidence: the floor stays exactly where it was and keeps every one of
 * its unit cases, and the flee gives it a reason the player can SEE. Ramming
 * now fails because the thing moves, not because a rule says so.
 *
 * Declared HERE, immediately after the floor it equals, rather than up in the
 * body block with the rest of phase 2's figures: a `const` that reads another
 * `const` declared later in the file is a temporal-dead-zone throw at import,
 * and the alternative -- restating the 5 -- is exactly the drift this equality
 * exists to prevent.
 */
export const FLEE_RADIUS = HARPOON_MIN_RANGE;

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

/*
 * The needle itself lives in `huntsweep.ts` as of phase 2, and these are
 * re-exports so that the dial, the scope and every existing test go on
 * importing the hunt's vocabulary from the hunt's module.
 *
 * `fishsim.ts`'s harpoon swings on a 2.4 s period; this is tighter, because
 * the fishing card gives the player a still world to read it in and this one
 * does not. Two seconds is about three sweeps in the time it takes a shoal to
 * drift out of the arc.
 */
export {
  ARM_UP,
  DIAL_PERIOD,
  HUNT_GOLD_PER_DAMAGE,
  LEVEL_HOLD,
  LEVEL_MULTIPLIER,
  LEVEL_SPEED,
  SOUND_BELOW,
  SWEEP_FAST,
  SWEEP_SLOW,
  bandFor,
  damageAt,
  huntGoldFor,
  multiplierFor,
} from './huntsweep';

/**
 * Targetable shadows per hunt, and so the harpoons one hunt may take.
 *
 * One press is one harpoon, so five is also the ceiling on the locker draw,
 * which is exactly one `HARPOON_BUNDLE`: one bundle buys one hunt. There is
 * deliberately no second "max draw" constant to disagree with this one.
 */
export const HUNT_TARGETS = 5;

/*
 * `SOUND_BELOW` — damage under which the leviathan tires of being pricked and
 * sounds — is declared in `huntsweep.ts` with the ramp it is a threshold on,
 * and re-exported above. Its reasoning belongs here, with `fire`, which is the
 * only thing that applies it:
 *
 * Ten, which is `|dial| > 0.9`: the outer tenth of each red band, and the
 * owner's figure (2026-09-11). Twenty-five was built first and is a quarter of
 * the bar at each end, which punishes an ordinary bad press rather than a
 * contemptible one.
 *
 * This is the failure state, and it is what turns five targets from a promise
 * into a ceiling. `docs/ROADMAP.md` calls the absence of a failure state a
 * CHOICE rather than a gap, so it is scoped to the hunt and changes nothing
 * about the game as a whole: a scattered shoal still pays what was banked.
 *
 * It does NOT apply to the last target. A player who has banked four and puts
 * a feeble fifth into the water has finished the hunt either way, and telling
 * them the animal left in disgust would read as a failure on a run that just
 * scored four out of five. See `fire`.
 */

/*
 * `HUNT_GOLD_PER_DAMAGE` and the purse moved to `huntsweep.ts` in phase 2, so
 * that the rate, the rounding and `LEVEL_MULTIPLIER` sit in one file. The
 * argument for the rate is unchanged and is recorded here because it is an
 * argument about the GAME rather than about the needle:
 *
 * Ten, not fifty. At fifty a perfect hunt pays 25 000 with no stake, which
 * beats a won fight (`bounty.ts` tops out at 20 000 and costs a tenth of the
 * purse to lose) and makes every other activity in the game irrelevant. At ten
 * a hunt paid 1 820 blind and about 4 250 played well; under phase 2's
 * escalation it pays about 2 200 blind and 6 100 for a perfect run, which
 * keeps the ordering the figure was chosen for — level with the best contract,
 * with the fight keeping the jackpot. `questconstants.ts` holds exactly this
 * line for contracts and the argument is the same one.
 */

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
/** A coast probe, and the rotated heading a turn is checked along. */
const _probe = new Vector3();
const _probeHeading = new Vector3();
/** A turn being weighed: where its arc starts and ends, and the arc's frame. */
const _turnStart = new Vector3();
const _turnEnd = new Vector3();
const _turnLeft = new Vector3();
const _turnChord = new Vector3();
/** A spawn's heading, drawn before the fit test that probes along it. */
const _heading = new Vector3();
const _starboardMark = new Vector3();

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

/**
 * The rank the mark sits on for target `target`, on a body whose tail is
 * `last`. Evenly spaced from the tail at the first target to the head at the
 * last; the rounding is what lands fourteen segments and five targets on the
 * head exactly. One formula, read by the walk in `fire` and by the spawn's
 * fit test, so the ranks the spawn checks are the ranks the hunt visits.
 */
function markRankFor(target: number, last: number): number {
  return Math.round(last * (1 - target / (HUNT_TARGETS - 1)));
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

/*
 * `damageAt` and the purse moved to `huntsweep.ts` in phase 2 and are
 * re-exported at the top of this file. Why the ramp is shaped as it is:
 *
 * ONE ramp, and the five colour bands `leviathandial.ts` paints are a readout
 * of this and nothing else: they are where the colour changes and no rule ever
 * reads them, so the palette can be retuned without touching the ruleset.
 *
 * 100 at the centre, 0 at either end. The needle is a COSINE — a sine in the
 * MVP, and the change of letter is item 5's whole fix — which is what makes
 * the green band harder than its width suggests: it lingers near the extremes
 * and crosses the middle fastest, so a press at a uniformly random moment
 * averages `100 * (1 - 2/PI)`, about 36, and not the 50 a linear sweep would
 * give. Starting at the edge rather than the centre leaves that average alone
 * and removes only the free 100 that arming used to hand out.
 */

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
  /**
   * Fired for every picture and every sound the hunt wants made. Optional:
   * a sim with no views attached is the unit tier, and it must run silent.
   *
   * Separate from `onEvent` on purpose, and the separation is the one piece of
   * plumbing phase 2 insists on. `onEvent` is money and the notification strip
   * and has exactly one consumer; this has six, none of which may ever be in a
   * position to pay gold. See `HuntCue` in `types.ts`.
   */
  onCue?: (cue: HuntCue) => void;
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
  /**
   * Puts a shoal on the water ahead of the bow. The `?hunt=` dev query's hand.
   *
   * `arm` lays it inside the gate instead of out at `SHOAL_SPAWN_MIN`, and
   * moves the marked shadow onto the bow at the middle of the band, so the
   * dial is live within a frame. That is a dev affordance and says so: it is
   * the only thing in this module that moves a shadow rather than letting it
   * drift there.
   *
   * It exists because the armed state cannot be reached by waiting, only by
   * steering, and a test that has to sail to it is a test that fails when it
   * sails into a headland. `?battle=1` forces a fight for the same reason
   * rather than waiting for a 3.2% roll to ram the player.
   */
  /**
   * @param keepProgress dev only: re-lay the animal without clearing the
   *   hunt's score. The browser tier's substitute for a helm — after item 6
   *   the mark walks up the body away from the hull, so a tier that cannot
   *   steer loses it after the first handoff and can never photograph a
   *   settled hunt. It makes no press easier; it only puts the animal back.
   */
  force(ship: ShipState, arm?: boolean, keepProgress?: boolean): boolean;
}

/** Internal, mutable mirror of the read-only `Shadow` surface, plus bookkeeping. */
interface MutableShadow {
  position: Vector3;
  forward: Vector3;
  marked: boolean;
  envelope: number;
  /** Seconds since the shoal was born. Drives the fade in, and only that. */
  age: number;
  rank: number;
  surfacing: number;
  bank: number;
  burst: number;
  wobble: number;
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
  gate: HuntGate;
  ready: boolean;
  centring: number;
  sweepRate: number;
  level: number;
  streak: number;
  multiplier: number;
  turnIn: number;
  handoff: number;
  handoffFrom: number;
  handoffTo: number;
  bolt: number;
  ending: HuntEnding | null;
  mark: number;
}

export function createLeviathan(deps: LeviathanDeps): Leviathan {
  const { terrain, heightMap, waterBodies, towns, harpoons, onEvent, onCue } = deps;
  const rng = mulberry32(deps.seed ?? LEVIATHAN_SEED);

  const state: MutableHuntState = {
    phase: 'idle',
    shadows: [],
    target: 0,
    banked: 0,
    armed: false,
    dial: 0,
    grace: 0,
    gate: 'suppressed',
    ready: false,
    centring: 0,
    sweepRate: 0,
    level: 0,
    streak: 0,
    multiplier: multiplierFor(0),
    turnIn: 0,
    handoff: 0,
    handoffFrom: 0,
    handoffTo: 0,
    bolt: 0,
    ending: null,
    mark: 0,
  };

  /**
   * The needle, owned here and stepped here.
   *
   * `huntsweep.ts` holds no module state of its own, so the one live sweep in
   * the game is this object. It is armed on the transition into armed and
   * stepped every armed frame, and nothing outside this closure writes it.
   */
  const sweep: Sweep = createSweep();

  /**
   * Hand one cue to whoever is listening.
   *
   * A cue carries a LIVE `position` when it has one — the marked segment's own
   * vector, not a copy — on `HuntState`'s rule that the caller holds the
   * reference and never keeps it. A consumer that wants to remember where a
   * strike happened copies the vector on the frame it is handed one, which is
   * what `HuntCue`'s "no identity" line in `types.ts` is asking for.
   */
  function emit(cue: HuntCue): void {
    if (onCue) onCue(cue);
  }

  let rollTimer = 0;
  /** Seconds until the shoal may turn again. */
  let headingClock = 0;
  /**
   * The turn that has been DRAWN but not yet begun, radians, signed.
   *
   * Non-zero only during the telegraph: the angle is chosen `TURN_TELEGRAPH`
   * seconds early so the head can roll into it and the cue can carry its sign
   * while the heading is still the old one.
   */
  let pendingTurn = 0;
  /** Radians of the current turn still to be spent, at `HEAD_TURN_RATE`. */
  let turnRemaining = 0;
  /** Seconds until the next spout. */
  let spoutClock = 0;
  /** Seconds of fade left in `settling`. */
  let settleClock = 0;
  /** Whether the player has been told the locker is empty, once per shoal. */
  let toldDry = false;
  /** Seconds until a cornered animal looks for a clear turn again. */
  let escapeClock = 0;
  /** Seconds the marked segment has been over land without a break. */
  let agroundClock = 0;
  /**
   * The head's recorded path, newest point first, as a fixed ring. Every
   * segment behind the head is placed ON it, at its rank's distance back.
   */
  const trail: Vector3[] = Array.from({ length: TRAIL_POINTS }, () => new Vector3());
  let trailNewest = 0;
  let trailCount = 0;

  function trailPush(point: Vector3): void {
    trailNewest = (trailNewest + 1) % TRAIL_POINTS;
    trail[trailNewest].copy(point);
    trailCount = Math.min(TRAIL_POINTS, trailCount + 1);
  }

  /** The `i`th recorded point back from the newest. */
  function trailAt(i: number): Vector3 {
    return trail[(trailNewest - i + TRAIL_POINTS * 2) % TRAIL_POINTS];
  }

  /** A fresh path: a straight line astern of `head` along `forward`. */
  function seedTrail(head: Vector3, forward: Vector3): void {
    trailCount = 0;
    for (let k = TRAIL_POINTS - 1; k >= 0; k--) {
      if (!stepAlong(_probe, head, forward, -k * TRAIL_STEP * ARC)) _probe.copy(head);
      trailPush(_probe);
    }
  }

  /**
   * Whether the turn pending or being spent was chosen by the coast rather
   * than drawn. An escape is not second-guessed while it is spent; a drawn
   * turn is, and a coast ahead replaces it outright.
   */
  let escaping = false;
  /** Whether that escape is a cornered wheel about: slow, and turned hard. */
  let tight = false;
  /** Set by `escapeTurn`: whether the turn it returned is a wheel about. */
  let escapeTight = false;

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
   * True if a body laid with its head at `centre`, swimming `forward`, would
   * start on water from tail to head and have open water ahead.
   *
   * The centre alone is not enough, and this is not a nicety: `update` ends a
   * hunt once the MARKED segment is aground, and the mark starts at the tail.
   * So the probes go where the body actually is, ALONG the heading, rather
   * than at the four cardinal points the MVP's nine-unit disc needed. A
   * cardinal cross never looks astern of a heading that is not itself
   * cardinal, which laid tails on beaches: the player heard a groan and a
   * dive and never saw an animal.
   *
   * One read per segment, and `COAST_PROBES` ahead, because the body follows
   * its head's path and a nose already facing a beach steers from its first
   * frame. A narrow strait fits a body laid down its length where a 45-unit
   * cross never could.
   */
  function shoalFits(centre: Vector3, forward: Vector3): boolean {
    if (!sailable(centre)) return false;
    // Laid as a straight line astern, so every rank is on that line.
    for (let rank = 1; rank < SHOAL_COUNT; rank++) {
      if (!stepAlong(_probe, centre, forward, -rank * BODY_SPACING * ARC)) return false;
      if (!sailable(_probe)) return false;
    }
    return waterAhead(centre, forward, COAST_PROBES);
  }

  /**
   * True if there is water for `COAST_LOOKAHEAD` ahead of `head`, read at
   * `reads` even steps.
   *
   * The frame loop asks with three: its probes slide forward with the head
   * every frame, so over a few frames they cover every point ahead anyway. A
   * heading being weighed is asked once and has no later frames to fill the
   * gaps, so it is asked with `COAST_PROBES`.
   */
  function waterAhead(head: Vector3, forward: Vector3, reads = 3): boolean {
    for (let i = 1; i <= reads; i++) {
      if (!stepAlong(_probe, head, forward, (COAST_LOOKAHEAD * i * ARC) / reads)) return false;
      if (!sailable(_probe)) return false;
    }
    return true;
  }

  /** The head's forward turned by `angle`, still tangent, in `_probeHeading`. */
  function headingTurned(head: MutableShadow, angle: number): Vector3 {
    _probeHeading.copy(head.forward).applyAxisAngle(head.position, angle);
    _probeHeading.addScaledVector(head.position, -_probeHeading.dot(head.position));
    if (_probeHeading.lengthSq() > 1e-12) _probeHeading.normalize();
    else _probeHeading.copy(head.forward);
    return _probeHeading;
  }

  /**
   * How far the head could swim along a heading `angle` off its own before
   * the first land, world units, read at `COAST_PROBES` steps and capped at
   * `COAST_LOOKAHEAD`.
   */
  function openWater(head: MutableShadow, angle: number): number {
    const forward = headingTurned(head, angle);
    // One read at two trail steps first: the flee weighs a few degrees a
    // frame, and the land that turns it aground is right off the head.
    if (!stepAlong(_probe, head.position, forward, 2 * TRAIL_STEP * ARC)) return 0;
    if (!sailable(_probe)) return 0;
    for (let i = 1; i <= COAST_PROBES; i++) {
      const reach = (COAST_LOOKAHEAD * i) / COAST_PROBES;
      if (!stepAlong(_probe, head.position, forward, reach * ARC)) return 0;
      if (!sailable(_probe)) return reach - COAST_LOOKAHEAD / COAST_PROBES;
    }
    return COAST_LOOKAHEAD;
  }

  /**
   * How much open water a turn of `angle` leaves the head, world units: 0 if
   * the head would cross land on the way, and otherwise the straight room from
   * where the turn ends, along the heading it ends on.
   *
   * Weighed along the path the head actually swims. It runs straight for
   * `leadIn` units first (a telegraph spends that much), then round an arc of
   * radius `speedNow() / HEAD_TURN_RATE`. Judging a turn by its end heading
   * alone is what sent a head round a reversal on the wrong side of a bay,
   * through land four units off its beam, toward water that was open.
   */
  function turnRoom(head: MutableShadow, angle: number, leadIn: number, radius: number): number {
    if (leadIn > 0) {
      if (!stepAlong(_turnStart, head.position, head.forward, leadIn * ARC)) return 0;
      if (!sailable(_turnStart)) return 0;
    } else {
      _turnStart.copy(head.position);
    }
    _turnEnd.copy(_turnStart);

    const sweep = Math.abs(angle);
    const side = Math.sign(angle);
    // A positive `rotateTangent` turns the heading toward up x forward.
    _turnLeft.crossVectors(head.position, head.forward).normalize();
    const steps = Math.ceil(sweep / ARC_STEP);
    for (let k = 1; k <= steps; k++) {
      const phi = (sweep * k) / steps;
      _turnChord
        .copy(head.forward)
        .multiplyScalar(radius * Math.sin(phi))
        .addScaledVector(_turnLeft, side * radius * (1 - Math.cos(phi)));
      const chord = _turnChord.length();
      if (chord < 1e-9) continue;
      _turnChord.addScaledVector(_turnStart, -_turnChord.dot(_turnStart));
      if (_turnChord.lengthSq() < 1e-12) continue;
      _turnChord.normalize();
      if (!stepAlong(_turnEnd, _turnStart, _turnChord, chord * ARC)) return 0;
      if (!sailable(_turnEnd)) return 0;
    }

    headingTurned(head, angle);
    _probeHeading.addScaledVector(_turnEnd, -_probeHeading.dot(_turnEnd));
    if (_probeHeading.lengthSq() < 1e-12) return 0;
    _probeHeading.normalize();
    for (let i = 1; i <= COAST_PROBES; i++) {
      const reach = (COAST_LOOKAHEAD * i) / COAST_PROBES;
      if (!stepAlong(_probe, _turnEnd, _probeHeading, reach * ARC)) return 0;
      if (!sailable(_probe)) return reach - COAST_LOOKAHEAD / COAST_PROBES;
    }
    return COAST_LOOKAHEAD;
  }

  /**
   * The turn a head facing land should take, radians, where 0 means hold.
   *
   * The smallest turn with open water for the whole `COAST_LOOKAHEAD`, and
   * failing that the turn toward the MOST open water, if it beats the heading
   * already held. A yes-or-no "clear for twenty-two units" found nothing in a
   * bay or a strait narrower than that, so the animal held its course into
   * the shore; steering toward the most room does not corner itself. Both
   * sides are weighed at every size, because a reversal to port and one to
   * starboard end on the same heading and swim different water.
   *
   * When no turn at speed beats holding on, a wheel about is weighed instead
   * (`TIGHT_SPEED`, `TIGHT_TURN`), and `escapeTight` says that is what came
   * back.
   *
   * Only the head's path is weighed, because the body trails that path and a
   * head kept on water keeps every segment behind it on water too. Draws
   * nothing from the seeded stream, so the coast decides where the animal goes
   * without reordering the draws behind it.
   */
  function escapeTurn(head: MutableShadow, prefer: number, leadIn: number): number {
    const first = prefer < 0 ? -1 : 1;
    let best = 0;
    let bestRoom = openWater(head, 0);
    escapeTight = false;
    const wide = speedNow() / HEAD_TURN_RATE;
    for (const angle of ESCAPE_ANGLES) {
      for (const side of [first, -first]) {
        const room = turnRoom(head, side * angle, leadIn, wide);
        if (room >= COAST_LOOKAHEAD) return side * angle;
        if (room > bestRoom) {
          best = side * angle;
          bestRoom = room;
        }
      }
    }
    if (best !== 0) return best;

    // Nothing at speed beats holding on. Cornered: weigh a wheel about, which
    // starts at once and turns on a radius of a fraction of a unit.
    const narrow = (speedNow() * TIGHT_SPEED) / (HEAD_TURN_RATE * TIGHT_TURN);
    for (const angle of ESCAPE_ANGLES) {
      for (const side of [first, -first]) {
        const room = turnRoom(head, side * angle, 0, narrow);
        if (room > bestRoom) {
          best = side * angle;
          bestRoom = room;
          if (room >= COAST_LOOKAHEAD) break;
        }
      }
      if (bestRoom >= COAST_LOOKAHEAD) break;
    }
    escapeTight = best !== 0;
    return best;
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

  /**
   * Move the mark to one rank, and publish it.
   *
   * The single place `marked` is written, so the invariant the whole gate
   * rests on — exactly one marked segment, and `state.mark` agreeing with it —
   * cannot drift. `state.mark` exists so that six consumers do not each scan
   * fourteen segments every frame to find out where to draw.
   */
  /**
   * Seconds the shoal holds its heading at this level, drawn from the seeded
   * stream.
   *
   * `LEVEL_HOLD` narrows from five-to-ten seconds at the first target to
   * three-to-six at the last, so the lead the player has just learned to take
   * stops being enough. `HEADING_HOLD_MIN`/`MAX` remain the level-0 row and
   * are still exported, because the scope and the docs quote them as the
   * hunt's opening pace.
   */
  /**
   * How fast the body is travelling this frame, world units/s.
   *
   * `LEVEL_SPEED` is the escalation in speed: four units at the first target,
   * six at the last, so the animal that taught the player to lead it stops
   * being the animal they learned on. A bolting one runs at `BOLT_SPEED`
   * instead, which is under the hull's cruise for `SHADOW_SPEED`'s own reason
   * — a chase the player cannot win is a hunt that ended without saying so.
   *
   * `SHADOW_SPEED` remains the level-0 figure and is still exported: the scope
   * and the docs quote it as the hunt's opening pace.
   */
  function speedNow(): number {
    const row = Math.max(0, Math.min(LEVEL_SPEED.length - 1, state.level));
    const cruise = LEVEL_SPEED[row];
    const speed = state.bolt > 0 ? cruise + (BOLT_SPEED - cruise) * state.bolt : cruise;
    return tight ? speed * TIGHT_SPEED : speed;
  }

  function holdForLevel(level: number): number {
    const row = LEVEL_HOLD[Math.max(0, Math.min(LEVEL_HOLD.length - 1, level))];
    return row[0] + rng() * (row[1] - row[0]);
  }

  function markRank(rank: number): void {
    if (state.shadows.length === 0) return;
    const want = Math.max(0, Math.min(state.shadows.length - 1, Math.round(rank)));
    for (const shadow of state.shadows) shadow.marked = shadow.rank === want;
    state.mark = want;
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

    /*
     * A CHAIN, not a disc.
     *
     * The MVP scattered fourteen shadows over a nine-unit disc with a shared
     * heading, and `docs/LEVIATHAN_PLAN.md`'s interpretation 1 argued for it
     * on the grounds that sub-groups are unreadable at chase distance. That
     * was right about sub-groups and wrong about the conclusion: the
     * unreadable thing was fourteen INDEPENDENT blobs. One body laid nose to
     * tail is more legible at distance, not less, and it telegraphs its own
     * turns for free — which is what items 6 and 7 are built on.
     *
     * Rank 0 is the head and sits at the centre the spawn chose; every other
     * segment is laid one `BODY_SPACING` astern of the one before it, which is
     * exactly where `update` will keep it.
     */
    const laid: Vector3[] = [];
    for (let i = 0; i < SHOAL_COUNT; i++) {
      const position = new Vector3();
      if (i === 0) {
        position.copy(c);
      } else {
        const ahead = laid[i - 1];
        // Astern of the segment in front, along the shared heading expressed
        // at that segment's own position.
        _offset.copy(f);
        _offset.addScaledVector(ahead, -_offset.dot(ahead));
        if (_offset.lengthSq() < 1e-12) tangentFrame(ahead, _offset, _east);
        _offset.normalize();
        if (!stepAlong(position, ahead, _offset, -BODY_SPACING * ARC)) position.copy(ahead);
      }
      laid.push(position);

      // The shoal's heading, re-expressed as a tangent at THIS shadow's own
      // position. Projecting rather than copying is what keeps the invariant
      // the tests assert: every forward is tangent where it lives.
      const bow = new Vector3().copy(f);
      bow.addScaledVector(position, -bow.dot(position));
      if (bow.lengthSq() < 1e-12) tangentFrame(position, bow, _east);
      bow.normalize();

      /*
       * `wobble` is drawn HERE, from the sim's own seeded stream, and never
       * from `Math.random` in a renderer. Two runs on one seed have to draw
       * the same animal, and a per-segment swim phase that came out of the
       * view would break that without breaking any test that watches the sim.
       *
       * `rank` is the index, so 0 is the head and `SHOAL_COUNT - 1` the tail.
       * Phase 2's stream A1 makes the body actually FOLLOW that order; laying
       * it down here is what lets every renderer be written against it first.
       */
      state.shadows.push({
        position,
        forward: bow,
        marked: false,
        envelope: 0,
        age: 0,
        rank: i,
        surfacing: 0,
        bank: 0,
        burst: 0,
        wobble: rng() * TWO_PI,
      });
    }

    /*
     * The mark starts at the TAIL and walks to the head across the five
     * targets, which reverses the MVP's seeded pick (see
     * docs/LEVIATHAN_PHASE2_PLAN.md item 6). A player who has just struck the
     * hindmost segment knows where the next one will be, so the fifth target
     * is a shot they have been steering toward for the whole hunt rather than
     * a fresh search.
     *
     * The seeded stream is still drawn from unconditionally, exactly where it
     * was, so what happens to be on the water cannot reorder the draws behind
     * it and every existing seeded expectation downstream is undisturbed.
     */
    seedTrail(c, f);
    rng();
    markRank(state.shadows.length - 1);

    state.phase = 'drifting';
    state.target = 0;
    state.banked = 0;
    state.armed = false;
    state.dial = 0;
    state.gate = 'far';
    state.ready = false;
    state.centring = 0;
    state.sweepRate = 0;
    state.level = 0;
    state.streak = 0;
    state.multiplier = multiplierFor(0);
    state.handoff = 0;
    state.handoffFrom = state.mark;
    state.handoffTo = state.mark;
    state.bolt = 0;
    state.ending = null;
    headingClock = holdForLevel(0);
    state.turnIn = headingClock;
    armSweep(sweep);
    spoutClock = SPOUT_MIN + rng() * (SPOUT_MAX - SPOUT_MIN);
    pendingTurn = 0;
    turnRemaining = 0;
    toldDry = false;
    escapeClock = 0;
    agroundClock = 0;
    escaping = false;
    tight = false;
    emit({ kind: 'spawn', position: state.shadows[0]?.position });
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

      // The heading first, because the fit test probes along it.
      tangentFrame(_candidate, _north, _east);
      _heading
        .copy(_north)
        .multiplyScalar(Math.cos(heading))
        .addScaledVector(_east, Math.sin(heading));

      // The cheapest test first, and the one that rejects most.
      if (!shoalFits(_candidate, _heading)) continue;
      if (nearBerth(_candidate, largestBerthRadius() + BERTH_MARGIN)) continue;

      build(_candidate, _heading);
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
  /**
   * Turn one segment's heading in place, about its own surface normal.
   *
   * The rotation axis is the segment's own position — which IS the outward
   * normal on a unit sphere — so the tangent stays tangent and the segment
   * does not move. Re-orthogonalised afterwards for `transport`'s reason: a
   * shoal turns for minutes and the error accumulates.
   */
  function rotateTangent(shadow: MutableShadow, angle: number): void {
    if (angle === 0) return;
    shadow.forward.applyAxisAngle(shadow.position, angle);
    shadow.forward.addScaledVector(shadow.position, -shadow.forward.dot(shadow.position));
    if (shadow.forward.lengthSq() > 1e-12) shadow.forward.normalize();
    else tangentFrame(shadow.position, shadow.forward, _east);
  }

  /**
   * One segment's per-frame scalars: the fade, how far out of the water it is,
   * and the decays.
   *
   * Kept apart from the positions above because these are what the RENDERERS
   * read and the sim itself reads none of them. A renderer that wanted to know
   * where a segment is asks `position`; everything here is how it should look
   * when it gets there.
   */
  function advanceSegment(shadow: MutableShadow, dt: number, rank: number): void {
    shadow.envelope = shadow.age < FADE_IN ? clamp01(shadow.age / FADE_IN) : 1;

    /*
     * The head's roll is DRIVEN during a telegraph and decays otherwise. The
     * body's is eased from the segment ahead and is therefore never touched
     * here, which is why this branch is the head's alone.
     */
    if (rank === 0) {
      if (pendingTurn !== 0) {
        const into = clamp01((TURN_TELEGRAPH - headingClock) / TURN_TELEGRAPH);
        shadow.bank = Math.sign(pendingTurn) * into;
      } else if (turnRemaining !== 0) {
        shadow.bank = Math.sign(turnRemaining);
      } else if (shadow.bank !== 0) {
        const decay = (dt / TURN_TELEGRAPH) * Math.sign(shadow.bank);
        shadow.bank = Math.abs(shadow.bank) <= Math.abs(decay) ? 0 : shadow.bank - decay;
      }
    }

    if (shadow.burst > 0) shadow.burst = Math.max(0, shadow.burst - dt / BOLT_SECONDS);

    /*
     * How far out of the water this segment is.
     *
     * The mark rides higher than the rest of the body, which is most of what
     * makes it findable at chase distance without a HUD marker, and a struck
     * segment breaks the surface for as long as its `burst` lasts. An ending
     * overrides both — see `endingSurfacing` — because a sounding animal goes
     * down whatever the mark was doing.
     */
    const want =
      state.ending !== null
        ? endingSurfacing()
        : Math.max(
            shadow.marked ? SURFACE_MARK : SURFACE_BODY,
            shadow.burst * SURFACE_STRUCK,
          );
    shadow.surfacing += (want - shadow.surfacing) * Math.min(1, dt * SURFACE_RATE);
  }

  /** Where the body goes when a hunt ends. One number, three pictures. */
  function endingSurfacing(): number {
    if (state.ending === 'settled') return 1;
    // Sounded goes DOWN, which is the picture that makes it feel like a loss;
    // a scatter merely stops showing off.
    return state.ending === 'sounded' ? 0 : SURFACE_BODY * 0.5;
  }

  /*
   * `reroll` is gone.
   *
   * The MVP turned every shadow by the same angle on the same frame, which is
   * the only thing fourteen independent drifters COULD do. A chained body
   * turns its head and lets the rest follow, so the heading change is
   * `rotateTangent` on rank 0 spread over `HEAD_TURN_RATE`, and the body's
   * turn is a consequence of the chain rather than an instruction to it.
   */

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
    if (!stepAlong(shadow.position, shadow.position, shadow.forward, speedNow() * dt * ARC)) {
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
  /**
   * Which of the five conditions is failing, or `'ok'` when none is.
   *
   * The MVP's `canArm` returning a boolean, widened into the WORD for why.
   * The conditions themselves are byte-for-byte the ones it tested and in the
   * same order of cheapness; all that is new is that the first failure is
   * named instead of collapsing to `false`.
   *
   * The reporting order is the teaching progression — sail closer, then point
   * the bow, then back off if you have overshot — and `HuntGate`'s own comment
   * carries the argument for it.
   */
  function gateFor(ship: ShipState, suppressed: boolean): HuntGate {
    if (suppressed) return 'suppressed';
    if (state.phase !== 'drifting') return 'suppressed';

    const target = marked();
    if (target === null) return 'suppressed';

    const range = arcDistance(ship.position, target.position);
    if (range > HARPOON_RANGE) return 'far';

    // The bearing to the target, resolved against the bow. Two world vectors
    // and one dot product, never two compass bearings subtracted: see
    // **Frames, and where they stop working** in docs/ARCHITECTURE.md.
    if (!pointAt(_toShadow, ship.position, target.position)) return 'arc';
    const cos = Math.max(-1, Math.min(1, ship.forward.dot(_toShadow)));
    if (Math.acos(cos) > BOW_ARC) return 'arc';

    if (range < HARPOON_MIN_RANGE) return 'close';
    if (harpoons.count <= 0) return 'dry';
    return 'ok';
  }

  /**
   * How far off the bow the mark is, 0 dead ahead and 1 at the arc's edge.
   *
   * The needle's rate input, and the whole of the claim that this activity
   * fuses steering with timing: a mark held dead ahead slows the sweep and
   * makes the press easy, and one taken at the edge of the arc runs it fast.
   * Clamped rather than allowed past 1, because outside the arc the dial is
   * not armed and the rate is not read.
   */
  function centringFor(ship: ShipState): number {
    const target = marked();
    if (target === null) return 0;
    if (!pointAt(_toShadow, ship.position, target.position)) return 0;
    const cos = Math.max(-1, Math.min(1, ship.forward.dot(_toShadow)));
    return clamp01(Math.acos(cos) / BOW_ARC);
  }

  /* ---- Ending one ---------------------------------------------------- */

  /**
   * End a hunt, paying what it banked.
   *
   * The purse settles ONCE, here, on the transition into `settling`, which is
   * what makes the fade that follows unable to pay twice. `main.ts` moves the
   * gold; this only says how much.
   */
  function finish(
    kind: 'sounded' | 'settled',
    reason?: 'pinprick' | 'lost',
    ending: HuntEnding = kind === 'settled' ? 'settled' : 'sounded',
  ): void {
    /*
     * Banked damage is a product of integers and a one-decimal multiplier, so
     * it can carry a float's dust: 100 * 1.1 is not exactly 110 in binary. The
     * purse rounds to fifty and would never show it, but `damage` reaches the
     * notification strip verbatim, and "SHOAL WORKED OUT 610.0000000000001
     * DMG" is the kind of thing that ships.
     */
    const banked = Math.round(state.banked);
    state.banked = banked;
    state.phase = 'settling';
    state.armed = false;
    state.ready = false;
    state.dial = 0;
    state.gate = 'suppressed';
    state.grace = SPAWN_GRACE;
    /*
     * `ending` is set ONCE, here, on the transition into `settling`, beside
     * the purse that already settles here. Everything that draws an ending
     * reads it, and the fade it is drawn over is per-ending rather than the
     * single `FADE_OUT` that made all three look the same.
     */
    state.ending = ending;
    settleClock = ENDING_FADE[ending];
    onEvent({ kind, damage: banked, gold: huntGoldFor(banked), reason, ending });
    // The dive carries WHERE, because `huntfx.ts` centres the swell on it and
    // draws nothing without one. The mark, being the segment the player was
    // working; the head if a lost hunt somehow has none.
    emit(
      ending === 'settled'
        ? { kind: 'settled' }
        : { kind: 'dive', position: marked()?.position ?? state.shadows[0]?.position },
    );
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
      const ending = state.ending ?? 'sounded';
      const fade = ENDING_FADE[ending];
      /*
       * The three endings are three PICTURES, and the difference is motion
       * rather than a different fade length. The MVP fed all three into one
       * `FADE_OUT` and they were indistinguishable; a player who lost a hunt
       * and a player who finished one saw the same thing happen on the water.
       *
       * The positions are the sim's to write because they are positions. What
       * each ending LOOKS like — the swell, the ink, the sink — belongs to the
       * renderers, and they read `ending` to know which to draw.
       */
      for (const shadow of state.shadows) {
        shadow.age += dt;
        shadow.envelope = clamp01(settleClock / fade);

        if (ending === 'scattered') {
          /*
           * A fright: the chain lets go and every segment runs off on its own
           * tangent, fanning by rank so the body comes apart rather than
           * sliding sideways as a unit.
           */
          rotateTangent(shadow, (shadow.rank % 2 === 0 ? 1 : -1) * dt * 1.2);
          transport(shadow, dt);
        } else if (ending === 'sounded') {
          // Converging on the mark and going down: the body draws together
          // and dives under a swell, which is the picture that makes a
          // sounding feel like something taken away rather than a fade.
          const target = marked();
          if (target !== null && target !== shadow) {
            if (pointAt(_bearingDir, shadow.position, target.position)) {
              shadow.forward.copy(_bearingDir);
            }
          }
          transport(shadow, dt);
        } else {
          // Settled: the body rises, holds, and sinks away unhurried. It keeps
          // swimming, because it is leaving rather than fleeing.
          transport(shadow, dt);
        }

        shadow.surfacing += (endingSurfacing() - shadow.surfacing) * Math.min(1, dt * SURFACE_RATE);
        if (shadow.burst > 0) shadow.burst = Math.max(0, shadow.burst - dt / BOLT_SECONDS);
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
    /*
     * The turn, telegraphed.
     *
     * `headingClock` counts down to the next heading change exactly as it did
     * in the MVP. What is new is that the last `TURN_TELEGRAPH` seconds of it
     * are SPENT: the angle is drawn early, the head rolls into it, and a cue
     * goes out, and only then does the heading actually move. A reroll stops
     * being a surprise and becomes a thing the player can read and lead, which
     * is the whole of item 7.
     */
    headingClock -= dt;
    state.turnIn = headingClock;

    const lead = state.shadows[0] ?? null;

    /*
     * The coast, which the animal steers around rather than onto.
     *
     * `update` ends a hunt once the mark is aground, and nothing used to keep
     * it off a beach: the head swam straight at coasts, and a turn swung a
     * body pivoting on its head across whatever lay beside it. Following an
     * animal along a coast lost the hunt nearly every time, to nothing the
     * player did. So a head that sees land inside `COAST_LOOKAHEAD` turns
     * away early, through the same telegraph as any other turn, so that it
     * still reads as a turn.
     */
    escapeClock = Math.max(0, escapeClock - dt);
    if (lead !== null && !escaping && escapeClock === 0 && !waterAhead(lead.position, lead.forward)) {
      /*
       * Telegraphed like any other turn, unless the land is closer than a
       * telegraph and a turning circle at this speed. Then it turns NOW: a
       * turn the player could read a second early is no use to an animal
       * already on the beach by the time it begins.
       */
      const urgent = openWater(lead, 0) < speedNow() * (TURN_TELEGRAPH + 1 / HEAD_TURN_RATE);
      const telegraph = urgent ? 0 : Math.min(headingClock, TURN_TELEGRAPH);
      const escape = escapeTurn(lead, lead.bank, speedNow() * telegraph);
      if (escape !== 0) {
        // Replaces a drawn turn that is pending or half spent: that turn was
        // chosen for a sea that had no coast in it.
        pendingTurn = escape;
        turnRemaining = 0;
        escaping = true;
        // A wheel about starts at once: a cornered animal has no second to
        // spend on a telegraph.
        tight = escapeTight;
        headingClock = tight ? 0 : telegraph;
        state.turnIn = headingClock;
        emit({ kind: 'turn', sign: Math.sign(pendingTurn) });
      } else {
        escapeClock = ESCAPE_RETRY;
      }
    }

    if (headingClock <= TURN_TELEGRAPH && pendingTurn === 0 && turnRemaining === 0) {
      // Drawn here rather than at the moment of turning, so the bank and the
      // cue can both carry the sign of a turn that has not happened yet.
      let drawn = (rng() * 2 - 1) * TURN_MAX;
      if (drawn === 0) drawn = TURN_MAX * 0.5;
      // A drawn turn that would point the head at land is not taken. The
      // heading already held is kept when it is open, and otherwise the coast
      // chooses, exactly as it would have a frame later.
      const leadIn = speedNow() * Math.max(0, headingClock);
      if (lead !== null && turnRoom(lead, drawn, leadIn, speedNow() / HEAD_TURN_RATE) < COAST_LOOKAHEAD) {
        drawn = openWater(lead, 0) >= COAST_LOOKAHEAD ? 0 : escapeTurn(lead, drawn, leadIn);
      }
      if (drawn !== 0) {
        pendingTurn = drawn;
        emit({ kind: 'turn', sign: Math.sign(pendingTurn) });
      } else {
        // Held rather than turned. A fresh hold, so this is not asked again
        // on every frame of the telegraph window.
        headingClock = holdForLevel(state.level);
        state.turnIn = headingClock;
      }
    }

    if (headingClock <= 0 && pendingTurn !== 0) {
      turnRemaining = pendingTurn;
      pendingTurn = 0;
      headingClock = holdForLevel(state.level);
      state.turnIn = headingClock;
    }

    const head = state.shadows[0] ?? null;

    /*
     * The flee, which is item 2 and which gives `HARPOON_MIN_RANGE` a reason
     * the player can SEE.
     *
     * The floor itself is unchanged and still refuses to arm inside five
     * units. What this adds is that the animal does not WAIT there to be
     * rammed: any segment inside `FLEE_RADIUS` of the hull turns the head
     * away, hard. Ramming now fails because the thing moves.
     */
    let fleeing = false;
    if (head !== null) {
      for (const shadow of state.shadows) {
        if (arcDistance(ship.position, shadow.position) >= FLEE_RADIUS) continue;
        fleeing = true;
        break;
      }
      if (fleeing && pointAt(_toShadow, head.position, ship.position)) {
        /*
         * Turn the head away from the bearing to the hull, choosing the side
         * it is already turning toward so the animal does not jitter between
         * two equally good escapes on successive frames.
         */
        const cross = _axis.crossVectors(head.forward, _toShadow).dot(head.position);
        const away = cross >= 0 ? -1 : 1;
        const step = away * Math.min(FLEE_TURN * dt, Math.PI);
        /*
         * Away from the hull, but not at a beach. The flee turns the head a
         * few degrees every frame, so it is weighed from close in: open water
         * measured from half a unit ahead, which sees land a unit or two off
         * the beam that a probe seven units out swings straight past. A heading
         * with less room than the one held is not taken; the other side is
         * tried, and failing both the head holds and only the bolt runs. An
         * escape already being spent is left alone, because it was weighed
         * along its whole arc and a flee was not.
         */
        if (!escaping) {
          const need = Math.min(COAST_LOOKAHEAD, openWater(head, 0));
          if (openWater(head, step) >= need) rotateTangent(head, step);
          else if (openWater(head, -step) >= need) rotateTangent(head, -step);
        }
        state.bolt = Math.max(state.bolt, 0.6);
      }
    }

    // The heading change itself, spread over time at `HEAD_TURN_RATE` rather
    // than applied in one frame. The body follows by construction below.
    if (turnRemaining !== 0 && head !== null) {
      const sign = Math.sign(turnRemaining);
      const rate = HEAD_TURN_RATE * (tight ? TIGHT_TURN : 1);
      const stepAngle = Math.min(Math.abs(turnRemaining), rate * dt) * sign;
      /*
       * A DRAWN turn is checked again as it is spent, not only when it was
       * drawn. The head swims on through the telegraph, so the turn begins
       * several units from where it was weighed. A step that leaves the head
       * less open water than it has now, short of the whole look-ahead, ends
       * the turn where it is. An escape is not checked: it was chosen for the
       * room at the END of it, and a turn away from a coast passes through
       * headings with less room on its way round.
       */
      let stop = false;
      if (!escaping) {
        const next = openWater(head, stepAngle);
        stop = next < COAST_LOOKAHEAD && next < openWater(head, 0);
      }
      if (stop) {
        turnRemaining = 0;
      } else {
        rotateTangent(head, stepAngle);
        turnRemaining -= stepAngle;
        if (Math.abs(turnRemaining) < 1e-9) turnRemaining = 0;
      }
      if (turnRemaining === 0) {
        escaping = false;
        tight = false;
      }
    }

    // The bolt decays on its own clock, raised by a strike or by a hull inside
    // `FLEE_RADIUS` above. It feeds `speedNow`, so a struck animal runs.
    if (state.bolt > 0) state.bolt = Math.max(0, state.bolt - dt / BOLT_SECONDS);

    // The mark's walk up one segment. `handoff` runs to 1 and stops; the
    // renderers read it as a pulse travelling from `handoffFrom` to
    // `handoffTo` and the sim reads it not at all.
    if (state.handoff > 0 && state.handoff < 1) {
      state.handoff = Math.min(1, state.handoff + dt / HANDOFF_SECONDS);
    }

    /*
     * The head swims; the body follows it.
     *
     * Only rank 0 is transported. The head's path is recorded every
     * `TRAIL_STEP`, and every other segment is placed ON that path at its
     * rank's distance behind the head, which is what makes fourteen drifting
     * blobs into one animal, and is the train on rails `leviathanshadows.ts`
     * waves for the eye. Every position is a normalised point of the path and
     * every tangent is `pointAt` toward the segment ahead, at the position it
     * belongs to, so the parallel-transport invariant holds per segment.
     *
     * On the path, and not astern along the head's heading, nor drawn after
     * the segment in front. Astern made the body a rigid rod pivoting on its
     * head, so every turn swung the tail through a twenty-two-unit arc across
     * whatever lay beside the animal. Drawn after the segment in front, it
     * cut up to three units inside every tight turn. Both put the mark on
     * beaches the head had swum around. On the path, a head kept off land
     * keeps every segment off it, and a turn travels down the body.
     */
    if (head !== null) {
      head.age += dt;
      transport(head, dt);
      if (trailCount === 0 || head.position.distanceTo(trailAt(0)) * GLOBE_RADIUS >= TRAIL_STEP) {
        trailPush(head.position);
      }
      advanceSegment(head, dt, 0);

      // Walk back along the path from the head: `_candidate` is the start of
      // the current piece, `walked` how far back along the path that is.
      _candidate.copy(head.position);
      let walked = 0;
      let next = trailAt(0).distanceTo(head.position) * GLOBE_RADIUS < 1e-6 ? 1 : 0;
      for (let i = 1; i < state.shadows.length; i++) {
        const ahead = state.shadows[i - 1];
        const shadow = state.shadows[i];
        shadow.age += dt;

        const want = i * BODY_SPACING;
        let placed = false;
        while (next < trailCount) {
          const to = trailAt(next);
          const piece = _candidate.distanceTo(to) * GLOBE_RADIUS;
          if (walked + piece >= want && piece > 1e-9) {
            shadow.position.copy(_candidate).lerp(to, (want - walked) / piece).normalize();
            placed = true;
            break;
          }
          walked += piece;
          _candidate.copy(to);
          next++;
        }
        // Past the end of the record, which a seeded path is long enough to
        // never be: held at the oldest point rather than left behind.
        if (!placed) shadow.position.copy(_candidate);

        if (pointAt(_bearingDir, shadow.position, ahead.position)) {
          shadow.forward.copy(_bearingDir);
        }

        /*
         * The roll travels DOWN the body rather than being copied: each
         * segment eases toward the one ahead of it, so a turn ripples from
         * the head to the tail over about a second instead of the whole
         * animal snapping over at once. This is most of what makes the chain
         * read as a living thing rather than as a train.
         */
        const follow = Math.min(1, dt * BANK_TRAVEL);
        shadow.bank += (ahead.bank - shadow.bank) * follow;
        advanceSegment(shadow, dt, i);
      }
    }

    /*
     * Spouts: the in-world tell that something is out there, on the seeded
     * stream like every other draw in this module.
     */
    spoutClock -= dt;
    if (spoutClock <= 0 && head !== null) {
      spoutClock = SPOUT_MIN + rng() * (SPOUT_MAX - SPOUT_MIN);
      emit({ kind: 'spout', position: head.position });
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
    agroundClock = target !== null && !sailable(target.position) ? agroundClock + dt : 0;
    if (
      target === null ||
      suppressed ||
      agroundClock > AGROUND_SECONDS ||
      arcDistance(ship.position, target.position) > DESPAWN_RANGE
    ) {
      finish('sounded', 'lost');
      return;
    }

    // ---- The gate and the dial ----------------------------------------
    /*
     * `gate` is computed EVERY frame, armed or not, and it is the single
     * biggest onboarding fix in phase 2: the MVP could only say that the bar
     * was dark, and this says which one of five things is making it dark. The
     * reticle colours by it and the dial's hint prints it in words, so the two
     * can never tell the player different stories.
     */
    state.gate = gateFor(ship, suppressed);
    state.centring = centringFor(ship);
    const armed = state.gate === 'ok';

    if (armed && !state.armed) {
      /*
       * Arming restarts the sweep AT THE RED EDGE.
       *
       * A player who loses the target and comes round again gets the dial from
       * a known start rather than from wherever a free-running clock happened
       * to be, which is the same reasoning `fishsim.ts` gives for stopping its
       * swing clock while the rope is out: the skill has to be learnable, and
       * a sweep whose phase depends on how long the approach took is not.
       *
       * What changed in phase 2 is only WHERE that known start is. It used to
       * be `sin(0)`, the middle of the bar, worth very nearly 100 damage to a
       * player who tapped Space on the arming frame. It is now the edge, worth
       * nothing, followed by `ARM_UP` in which a press is refused outright.
       */
      armSweep(sweep);
      emit({ kind: 'armed' });
    } else if (!armed && state.armed) {
      // The falling edge matters as much as the rising one: the armed tick is
      // a continuous voice and something has to tell it to stop.
      emit({ kind: 'disarmed' });
    }
    state.armed = armed;

    if (armed) {
      stepSweep(sweep, dt, state.centring, state.level);
      state.dial = sweepPosition(sweep);
      state.ready = canPress(sweep);
      state.sweepRate = rateFor(state.centring, state.level);
    } else {
      state.dial = 0;
      state.ready = false;
      state.sweepRate = 0;
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
    /*
     * The arm-up, refusing a press that arrived too early.
     *
     * Costs nothing and says nothing, exactly as an unarmed press does: the
     * view only offers the key while the dial is armed, so this is the race
     * between a keystroke and a needle that has not finished charging, not an
     * error. It is also the half of item 5's fix that a player can feel —
     * starting at the red edge makes the free shot worthless, and this makes
     * it impossible.
     */
    if (!state.ready) return -1;

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
    const band = bandFor(damage);
    /*
     * The press is worth its face value; the BANK is what escalates.
     *
     * `damage` stays an integer in [0, 100] and is what the strip, the floating
     * number and `SOUND_BELOW` all read, so the bar the player is looking at
     * never lies about what a press was worth. The level's factor is applied
     * to the running total and nowhere else, which is what keeps a widened
     * green band — the alternative this rejected — out of the drawn dial.
     */
    state.banked += damage * multiplierFor(state.level);
    state.target += 1;
    state.level = Math.min(HUNT_TARGETS - 1, state.target);
    state.multiplier = multiplierFor(state.level);
    state.streak = band === 'green' ? state.streak + 1 : 0;
    /*
     * `armed` is deliberately LEFT as it was. A press restarts the sweep (the
     * `armSweep` at the foot of this function) but does not close the gate,
     * and clearing the flag here made the next frame read as a fresh rising
     * edge: an `armed` cue after every strike with no `disarmed` before it,
     * and the reticle and vignette pulsing "the gate just opened" five times
     * a hunt. If the handoff has taken the mark out of the gate, `update`'s
     * falling edge says so on the next frame, which is the cue's contract.
     */
    state.ready = false;
    state.dial = 0;

    // The animal answers a harpoon by running, and the segment that took it
    // flinches. Both decay on the frame loop above.
    state.bolt = 1;
    target.burst = 1;

    onEvent({ kind: 'hit', damage, gold: 0 });
    emit({ kind: 'strike', position: target.position, damage, band });

    /*
     * The last target is exempt from the threshold, and the order here is what
     * makes it so.
     *
     * A player who has banked four and puts a feeble fifth into the water has
     * finished the hunt whatever the rule says, and greeting a four-out-of-five
     * run with "the leviathan tired of you" would read as a failure rather than
     * as the end of a good one. So the count is checked FIRST.
     */
    if (state.target >= HUNT_TARGETS) {
      finish('settled');
      return damage;
    }
    if (damage < SOUND_BELOW) {
      finish('sounded', 'pinprick');
      return damage;
    }

    /*
     * The mark WALKS, tail to head, one step per target.
     *
     * The MVP moved it to a seeded shadow that was merely not the one just
     * struck, which made every target a fresh search. Walking it up the body
     * means a player who has just hit the hindmost segment knows exactly where
     * the next one will be, so the fifth target is a shot they have been
     * steering toward all hunt. Re-marking the same segment is still never
     * done, which was the MVP's point and survives: the walk always advances.
     *
     * The seeded stream is still drawn from unconditionally, so removing the
     * random pick cannot reorder any draw that comes after it.
     */
    rng();
    const last = state.shadows.length - 1;
    const from = state.mark;
    // Evenly spaced from the tail at target 1 to the head at target 5. The
    // rounding is what makes fourteen segments and five targets land on the
    // head exactly, rather than a segment short of it.
    const to = markRankFor(state.target, last);
    state.handoff = state.handoff > 0 && state.handoff < 1 ? state.handoff : 0.0001;
    state.handoffFrom = from;
    state.handoffTo = to;
    markRank(to);
    emit({ kind: 'handoff' });
    armSweep(sweep);
    return damage;
  }

  function scatter(): void {
    if (state.phase !== 'drifting') return;
    /*
     * A scatter is a fright, not a sounding, and phase 2 gives it its own
     * picture and its own shorter fade. The EVENT is unchanged — still
     * `sounded` with reason `lost`, still paying what was banked — because
     * `main.ts` reads that pair to choose its line and has no business
     * learning a new word for an outcome it already handles. Only `ending`,
     * which is what the renderers draw, tells the two apart.
     */
    finish('sounded', 'lost', 'scattered');
  }

  /**
   * Move the marked shadow onto the bow at the middle of the gate's band.
   *
   * Dev only, and the one place a shadow is teleported. `leviathan.ts`
   * otherwise never writes a position that did not come from a spawn or from
   * `transport`, and nothing but `force(ship, true)` may call this.
   */
  function armMarkAt(ship: ShipState): void {
    const target = marked();
    if (target === null) return;

    const range = (HARPOON_MIN_RANGE + HARPOON_RANGE) / 2;
    if (!stepAlong(_candidate, ship.position, ship.forward, range * ARC)) return;

    /*
     * The body's heading: away from the hull, canted by `FORCE_CANT`.
     *
     * The MVP laid the mark's heading straight ACROSS the bow so that it would
     * drift out of the arc and the gate would still be a gate. That was right
     * for a nine-unit disc and wrong for a twenty-two-unit chained body: laid
     * broadside, most of the animal is off the side of the screen and the
     * browser tier photographs a shoal it cannot see.
     *
     * Running AWAY from the hull instead lays the chain down the bow line,
     * receding, which is the framing that actually shows what was built. The
     * cant is what keeps the MVP's point: at forty degrees the mark still
     * crosses out of `BOW_ARC` within a few seconds, so an armed dial does not
     * stay armed for ever and the gate is still being tested.
     */
    if (!pointAt(_starboardMark, _candidate, ship.position)) return;
    _starboardMark.negate();
    _starboardMark.applyAxisAngle(_candidate, FORCE_CANT);
    _starboardMark.addScaledVector(_candidate, -_starboardMark.dot(_candidate));
    if (_starboardMark.lengthSq() < 1e-12) return;
    _starboardMark.normalize();

    /*
     * The WHOLE BODY moves, not the marked segment.
     *
     * This is the one place the MVP's version could not survive the chain. It
     * teleported the mark alone, which a rigid body undoes on the very next
     * frame: every segment but the head is placed relative to the one ahead
     * of it, so a segment dragged out of line is simply snapped back and the
     * dial never arms.
     *
     * So the head is placed `rank * BODY_SPACING` AHEAD of where the mark is
     * wanted, along the body's heading, and the chain is rebuilt from there.
     * The mark then lands on the bow because that is where the chain puts it.
     */
    const rank = target.rank;
    const head = _prevPosition;
    if (!stepAlong(head, _candidate, _starboardMark, rank * BODY_SPACING * ARC)) return;

    const wasMark = state.mark;
    build(head, _starboardMark);
    markRank(wasMark);

    // Skips the fade, so the dial is readable on the frame after the query
    // fires rather than half a second later.
    for (const shadow of state.shadows) {
      shadow.age = FADE_IN;
      shadow.envelope = 1;
    }
  }

  function force(ship: ShipState, arm = false, keepProgress = false): boolean {
    state.grace = 0;
    /*
     * `keepProgress` re-lays the animal WITHOUT resetting the hunt's score.
     *
     * Dev only, and it exists for one reason: after item 6 the mark walks up
     * the body away from the hull, so a stationary hull loses it after the
     * first handoff and can never reach the fifth target. That is the design
     * working — the player is supposed to chase up the body — but it means the
     * `settled` picture cannot be photographed by a tier that cannot steer.
     *
     * So this is the browser tier's substitute for a helm, and nothing else
     * may use it. It is deliberately NOT a way to make a hunt easier: the
     * presses still have to land, still have to beat `SOUND_BELOW`, and still
     * bank at their own level's multiplier.
     */
    const keptTarget = state.target;
    const keptBanked = state.banked;
    const keptLevel = state.level;
    const keptStreak = state.streak;

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
    // Heading back down the bow, so the shoal closes rather than runs: a dev
    // query that needed a two-minute chase before it showed anything would
    // not be used. Drawn before the fit test, which probes along it.
    const ahead = stepAlong(_candidate, ship.position, ship.forward, SHOAL_SPAWN_MIN * ARC);
    if (ahead) {
      tangentFrame(_candidate, _north, _east);
      if (!pointAt(_heading, _candidate, ship.position)) _heading.copy(_north);
    }
    if (ahead && shoalFits(_candidate, _heading)) {
      build(_candidate, _heading);
      if (arm) armMarkAt(ship);
      restoreProgress();
      return true;
    }

    // Land ahead. Fall back to the ordinary placement, which searches the
    // whole compass and honours the berth clearance: the shoal is then
    // somewhere real rather than dead ahead, which is a worse photograph and
    // a far better failure.
    if (!trySpawn(ship)) return false;
    if (arm) armMarkAt(ship);
    restoreProgress();
    return true;

    /** Puts back what `build` cleared, when the caller asked to keep it. */
    function restoreProgress(): void {
      if (!keepProgress) return;
      state.target = keptTarget;
      state.banked = keptBanked;
      state.level = keptLevel;
      state.streak = keptStreak;
      state.multiplier = multiplierFor(keptLevel);
    }
  }

  return { state: state as HuntState, update, fire, scatter, force };
}

/** Re-exported so `leviathanshadows.ts` and the tests share one shape. */
export type { Shadow };
