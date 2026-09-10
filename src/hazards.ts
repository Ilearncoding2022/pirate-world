/**
 * hazards.ts — the rough water: waves that shove the hull, and maelstroms
 * that eat it.
 *
 * Owns one `HazardState`, **mutated in place for the life of the run**,
 * exactly as `energy.ts` owns its tank and `wind.ts` its weather. The water
 * shader, the displacement patch, the hull and the scope all hold that same
 * reference; handing out a copy would leave them reading a sea that had
 * stopped moving.
 *
 * DOM-free and scene-free by design: this module moves numbers and vectors,
 * which is what makes the whole rule set testable in the two-second tier.
 * `hazardfield.ts` owns what a hazard LOOKS like; this owns when one rises,
 * where it goes, and what it does to the ship.
 *
 * The brief is docs/HAZARDS_PLAN.md. Read it before retuning anything here.
 *
 * Two geometry rules run through the whole file and neither is optional:
 *
 *   - **Nothing is kept as a compass bearing.** A hazard is a centre and a
 *     pair of tangent vectors, carried across its own travel by parallel
 *     transport, exactly as `ship.ts` carries the bow and `wind.ts` carries
 *     the wind. A bearing lives in the tangent frame at one point, and that
 *     frame spins arbitrarily fast near a pole — which is the bug that made
 *     the hull twist on the spot up there. `tangentFrame` is built fresh at
 *     the point of use and never held.
 *   - **`north` is the direction of travel, `east` is the crest's long axis.**
 *     `east = normalize(cross(north, centre))`, `extent` is measured along
 *     `east` and `halfWidth` along `north`. Swap those two and a 20-unit wall
 *     of water becomes a 5-unit stub.
 *
 * A crest's `centre` and `extent` are both live, and now for two reasons.
 * Land eats a wave from the end that met it (`clipToWater`), which shortens
 * `extent` and slides `centre` onto the middle of what survives; and a wave
 * GROWS while it lives, gaining length and height off its own age (`grow`).
 * The two meet in `clipRatio`, which carries what the coast has taken as a
 * share rather than as a length, so a broken end stays broken while the rest
 * of the front goes on building. Nothing downstream needs to know — the
 * shader, the CPU port the hull rides, the contact test and the scope all
 * read the pair — but nothing may cache either of them across a frame.
 *
 * A third live number joins them: `amplitude`, which a crest also rolls and
 * then grows. It used to be one of two constants keyed off the kind, and the
 * kind it was keyed off is gone -- see `HazardKind` in `types.ts`.
 */
import { Vector3 } from 'three';
import type {
  EnergyState,
  HazardKind,
  HazardState,
  ShipState,
  Terrain,
  Towns,
  WindState,
} from './types';
import type { HeightMap } from './heightmap';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS, latLonToDir, tangentFrame } from './geo';
import { mulberry32, randomDirection } from './towns';
import { SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import {
  CREST_BOW_MAX,
  CREST_HALF_LENGTH,
  CREST_HALF_LENGTH_CAP,
  CREST_HALF_LENGTH_MAX,
  CREST_HALF_LENGTH_MIN,
  CREST_HEIGHT_MAX,
  CREST_HEIGHT_MAX_START,
  CREST_HEIGHT_MIN,
  FUNNEL_DEPTH,
  MAELSTROM_RADIUS,
  MAX_HAZARDS,
} from './hazardfield';

export interface HazardsDeps {
  readonly terrain: Terrain;
  readonly heightMap: HeightMap;
  readonly waterBodies: WaterBodies;
  readonly towns: Towns;
  /**
   * Fixed by default, so a given world rolls the same weather — the same
   * argument `wind.ts` makes for WIND_SEED. Reproducible hazards are worth
   * more than novelty here: tuning a spiral and chasing a push bug both need
   * the same maelstrom to come back on the next run.
   */
  readonly seed?: number;
  /**
   * Fired once, on the frame the hull vanishes into a funnel. `main.ts` runs
   * the wreck from here: the power is cut, the screen goes black, the ship is
   * placed somewhere else, and this module is reset.
   */
  readonly onSunk: () => void;
}

export interface Hazards {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: HazardState;
  /**
   * Runs after `wind.update` and before `ship.update`. After the wind for two
   * reasons now: it needs this frame's docked verdict — `energy.ts` owns the
   * one definition of berthed and a berth is shelter from rough water too —
   * and a crest is raised upwind and travels with the weather, so it needs
   * this frame's wind rather than last frame's. Before the ship because the
   * ship spends the push, and obeys the drive, this same frame.
   */
  /**
   * `stormOdds` multiplies each kind's spawn probability. 1 in fair weather,
   * up to `1 + STORM_ODDS_GAIN` in a full storm, computed once in `main.ts`
   * so the hazards and the raiders cannot end up on two different readings of
   * the same sky.
   *
   * It multiplies the COMPARISON and nothing else. The draw itself stays
   * unconditional -- see the note on `ROLL_ORDER` -- so a stormy run and a
   * clear one consume the same numbers in the same order, and the seeded
   * stream still replays.
   */
  update(
    dt: number,
    ship: ShipState,
    energy: EnergyState,
    wind: WindState,
    stormOdds?: number,
  ): void;
  /** Clears every hazard and returns to `free`. Called while the screen is black. */
  reset(): void;
  /** Raises one hazard now, at `centre`, travelling `north`. Tests and `?hazard=` only. */
  force(kind: HazardKind, centre: Vector3, north: Vector3): void;
  /** A random point of reachable open ocean, clear of land and of every berth. */
  pickRespawn(): Vector3;
}

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * Seconds between rolls, and the odds each kind is drawn at on a roll.
 *
 * Read them together: they are one rate, expressed as a cadence and two
 * chances. The period is the tick BOTH kinds are drawn on — there is one
 * timer, not one per kind — so moving it moves both frequencies together,
 * which is usually not what you wanted; move a single probability instead.
 *
 * At one roll a second the nominal waits are a wave every 2.2 s and a
 * maelstrom every 50 s of sailing. Those are ceilings rather than rates: only
 * MAX_WAVES crests and one funnel are ever on the water (see CAPACITY), a
 * crest lives CREST_LIFE_MIN to CREST_LIFE_MAX seconds and a funnel up to
 * MAELSTROM_LIFE + 2 * MAELSTROM_GROW = 36, so what a second-by-second roll
 * actually buys is that the next one rises very soon after the last one dies,
 * not a sea stacked deeper than its budget. The sea is close to always
 * running, and a maelstrom is a thing a player meets rather than a thing they
 * have to be told exists.
 *
 * P_WAVE is PER ATTEMPT, and there are ROLL_ATTEMPTS.wave of them a roll, so
 * the number to reason about is 5 x 0.15 = 0.75 expected spawns a second into
 * an empty sea. It was 0.45 on a single attempt against a two-crest budget.
 *
 * It came down from that 0.45 because five attempts at it do not make a
 * busier sea, they make a PINNED one. Measured over 50 minutes of sim: the
 * water sat at 4.49 crests of a possible five and was full 61% of the time in
 * FAIR WEATHER, and a full storm then bought 1.04x the spawns -- the storm
 * multiplier had stopped meaning anything, because there was never a free
 * slot for it to fill faster. The whole point of a capacity and an odds knob
 * being two different numbers is that the first says how many and the second
 * says how quickly, and a saturated sea collapses them into one.
 *
 * At 0.15 the same measurement gives 3.45 crests in fair weather, full 23% of
 * the time, against 4.49 and 61% under a storm, for a ratio of 1.293 -- back
 * inside the band this file has always claimed and `hazards.test.ts` asserts.
 * So fair weather is genuinely busier than the two-crest sea it replaces, and
 * a storm is once again the thing that fills the water up.
 *
 * The maelstrom is deliberately not touched -- it is the rare thing, and the
 * one hazard that can end a run.
 *
 * Note the odds are per roll and per KIND: a kind already at its live budget
 * is drawn for and skipped, so the actual rate is well under these numbers
 * once the sea is busy.
 */
export const ROLL_PERIOD = 1;
const P_WAVE = 0.15;
const P_MAELSTROM = 0.02;

/**
 * The fixed order the three kinds are drawn in, every roll, for every kind,
 * live or not.
 *
 * The order is what makes the stream reproducible: a run replays its own
 * weather only if the same draws come off `rng` in the same sequence, and
 * skipping the draw for a kind that happens to be live would let what is on
 * the water reorder the stream behind it. So the number is always taken; only
 * the acting on it is conditional. See `roll`.
 */
const ROLL_ORDER: readonly HazardKind[] = ['wave', 'maelstrom'];
const ROLL_ODDS: Record<HazardKind, number> = {
  wave: P_WAVE,
  maelstrom: P_MAELSTROM,
};

/**
 * How many separate chances each kind gets per roll.
 *
 * A roll used to be one draw per kind, so a second of weather could raise at
 * most one wave however empty the sea was: filling five slots from cold took
 * five seconds of consecutive successes. Five attempts is the owner's ask
 * that a tick be ABLE to raise five, and it is what makes the new capacity
 * reachable in the moment a squall arrives rather than a ceiling the sea
 * creeps up on.
 *
 * Every attempt draws whether it can act or not, exactly as the single draw
 * always did -- see ROLL_ORDER. Six numbers come off `rng` per roll now, in
 * the same order, spent or not, so the stream still replays.
 *
 * The maelstrom stays at one. Its odds are the rare-event knob and giving it
 * five chances a second would multiply an 0.02 into something a player meets
 * constantly, which is the opposite of what it is for.
 */
const ROLL_ATTEMPTS: Record<HazardKind, number> = {
  wave: 5,
  maelstrom: 1,
};

/**
 * How many of each kind may be on the water at once, and the two together are
 * MAX_HAZARDS -- the shader's uniform-array bound, which nothing here may
 * exceed.
 *
 * Five crests and one maelstrom, where it was two and one. The maelstrom is
 * deliberately still one: it is the rare thing and the only hazard that can
 * end a run, and a sea with two of them is a different game rather than a
 * busier one.
 *
 * Crests overlap freely, which the old one-of-each rule made impossible
 * between the strong and great wave only by accident. `hazardHeight` has
 * summed its slots since the day it was written, so where fronts cross the
 * water genuinely stands higher, and neither the hull's ride nor the parity
 * probe needs a word changing for it. At five that summing is doing real
 * work: a crossing of three fronts is now something the sea can actually
 * produce rather than a case that existed only in the arithmetic.
 */
const MAX_WAVES = MAX_HAZARDS - 1;
const CAPACITY: Record<HazardKind, number> = {
  wave: MAX_WAVES,
  maelstrom: 1,
};

/**
 * How far off the ship a hazard rises.
 *
 * A crest's is expressed as SECONDS OF CLOSING and a maelstrom's, which does
 * not travel, as the world units it always was.
 *
 * The distance used to be a flat 18 to 30 units for both, drawn when every
 * wave travelled at the same 6 units/s. Now that a wave rolls its own speed
 * between CREST_SPEED_MIN and CREST_SPEED_MAX, a fixed distance means
 * something completely different at each end of that range: 18 units is three
 * seconds of warning at 6 knots and nine at 2, so the slowest waves would
 * spend most of their lives crawling across the middle distance and the
 * fastest would arrive before the player had read them. Three to five seconds
 * of closing is the thing that was actually being tuned, so it is the thing
 * that is now written down.
 *
 * The two clamps are what the distance itself still has to satisfy, and they
 * are why this is not simply `speed * lead`. SPAWN_DIST_MIN is beyond the
 * hull's own stopping distance and outside the chase camera's usual framing,
 * so a 2-knot wave never simply appears on top of the player; SPAWN_DIST_MAX
 * is FADE_NEAR exactly, so even the fastest wave born at the far end of its
 * lead is born at FULL strength rather than materialising out of the distance
 * fade. At the 6 units/s every other number here is anchored on, the pair
 * reproduces the old 18-to-30 band precisely.
 */
const SPAWN_LEAD_MIN = 3;
const SPAWN_LEAD_MAX = 5;
const SPAWN_DIST_MIN = 12;
const SPAWN_DIST_MAX = 32;
const MAELSTROM_SPAWN_MIN = 18;
const MAELSTROM_SPAWN_MAX = 30;

/**
 * Three spawns in four land within 60 degrees of UPWIND; the fourth goes
 * anywhere on the compass.
 *
 * This used to be biased toward the bow, and it had to change when the crests
 * stopped being aimed. A wave now runs with the wind and only with the wind
 * (see `crestHeading`), so where it is born is the only thing left that
 * decides whether it ever reaches the ship: raised upwind it comes down onto
 * the hull, raised downwind it leaves at 6 units/s and is never seen again.
 * Upwind is therefore the same decision the bow bias used to be, made in the
 * one frame that still means anything.
 *
 * The one draw in four that ignores the wind is kept for the reason it always
 * was: it stops the sea from feeling aimed. Some of it is simply there, and
 * some of it is water the player is sailing away from.
 */
const UPWIND_SHARE = 0.75;
const UPWIND_HALF_ARC = Math.PI / 3;

/**
 * Clearance a hazard's centre keeps from a berth, on top of that berth's own
 * radius and the hazard's extent, world units.
 *
 * A berth is shelter — `energy.ts` says a docked ship is neither pushed nor
 * captured — so a hazard whose footprint reached into a charging zone would
 * be a wall of water the player could see and sail straight through. The
 * margin is on top of `extent` so it is the hazard's *edge* that is kept out,
 * not its centre.
 */
const BERTH_MARGIN = 4;

/**
 * Placement attempts per kind per roll, then give up until the next roll.
 *
 * Every attempt costs a handful of height-map reads. Near a crowded coast
 * most of them fail, and 24 is enough that open water almost always finds a
 * spot on the first two or three while a ship deep in an archipelago simply
 * gets quieter weather — which is the right answer there anyway.
 */
const SPAWN_TRIES = 24;

/**
 * How fast a crest travels, world units/s -- which is KNOTS, since the hull's
 * MAX_FORWARD of 10 world units/s is what `hud.ts` reads out as 10 kn.
 *
 * Every wave used to travel at a flat 6, and the argument for that number was
 * that it is slower than the hull's 10 so a wave can always be outrun
 * downwind. Rolled between 2 and CREST_SPEED_MAX that guarantee is
 * deliberately given up at the top of the range: the fastest wave is faster
 * than the ship can run and has to be steered out of the way of rather than
 * fled from, which is the point of a sea that is no longer one speed. Three
 * quarters of the range is still slower than the hull.
 *
 * The ceiling is 10% off the 12 this shipped with, on the owner's call that
 * the fastest waves were too fast. 10.8 keeps the design point that mattered
 * -- it is still over the hull's MAX_FORWARD of 10, so the top of the sea
 * cannot simply be outrun -- while taking the margin from two knots to under
 * one, which is the difference between a wave that overhauls a fleeing ship
 * and one that gains on it slowly enough to be worth trying. Nothing else
 * needs retuning behind it: the push is derived from the speed rather than
 * rolled beside it (see PUSH_PEAK), so the hardest shove in the game comes
 * down from 10 to 9 by arithmetic, and the spawn distance is a lead TIME, so
 * a slower ceiling simply raises less water at the far end of the band.
 *
 * CREST_SPEED_REF is not a speed anything travels at. It is the anchor every
 * other constant in this file was tuned against, and it is used in exactly
 * two places -- the push strength and the growth caps' sanity -- so that a
 * wave rolling 6 behaves precisely as every wave did before this change.
 */
const CREST_SPEED_MIN = 2;
const CREST_SPEED_MAX = 10.8;
const CREST_SPEED_REF = 6;

/**
 * How far a crest travels in an untouched life, world units, and the seconds
 * that is allowed to take.
 *
 * The life used to be rolled directly, 5 to 9.5 seconds, which at one fixed
 * speed was the same thing as rolling a DISTANCE: 30 to 57 units of travel.
 * With the speed rolled too they are no longer the same thing, and it is the
 * distance that carries the argument, so the distance is what is drawn and
 * the life follows from it. A wave still crosses its own spawn band whatever
 * speed it rolled -- CREST_TRAVEL_MIN is deliberately past SPAWN_DIST_MAX --
 * so there is still no draw that puts a wave on the water which was never
 * able to reach the ship at all, and the longest run still ends up well past
 * the distance fade, which is what stops a crest loitering at the edge of the
 * patch.
 *
 * The two life clamps only bite at the ends of the speed range. At the
 * 6 units/s this was tuned at they are nowhere near: 34 to 57 units is 5.7 to
 * 9.5 seconds, the band this file always had. At CREST_SPEED_MAX the fastest
 * wave is over in about three; at 2 the slowest would run for 28 and is held
 * at 20, which still carries it 40 units -- past its own spawn distance and
 * out through the fade.
 *
 * Only the upper clamp still bites. CREST_LIFE_MIN was sized against a
 * 12-knot ceiling, which crossed CREST_TRAVEL_MIN in 2.8 seconds; at 10.8
 * the shortest life the distance can produce is 3.15, so the floor is now
 * slack. It is kept rather than retuned -- it is a floor, and a floor that
 * never fires is the correct state for one.
 */
const CREST_TRAVEL_MIN = 34;
const CREST_TRAVEL_MAX = 57;
export const CREST_LIFE_MIN = 2.5;
export const CREST_LIFE_MAX = 20;

/**
 * How fast a crest gains length and height, as a fraction of what it
 * currently has, per second -- so both COMPOUND -- and the ceilings that stops
 * at.
 *
 * A wave that rose at its full size and held it until it faded is a wave that
 * was never building; growing one reads as weather gathering, and it is what
 * makes a front that was worth dodging ten seconds ago worth dodging harder
 * now. Length runs at twice the rate of height because a front spreads along
 * itself much faster than it stacks up: 10% and 5% a second.
 *
 * Compounding needs the caps and they are not a formality. Length at 1.10^t
 * over the 20 seconds CREST_LIFE_MAX allows is 6.7x, which on the longest
 * roll would be a 160-unit front on an 80-unit displacement patch; height at
 * 1.05^t over the same is 2.65x, which would put a wave's crest three times
 * the hull's freeboard over the deck. CREST_HALF_LENGTH_CAP and
 * CREST_HEIGHT_MAX are the two ceilings, both in `hazardfield.ts` and both
 * argued there; LENGTH_GROWTH_CAP is the second ceiling on length, a multiple
 * of what the wave ROSE at, so a wave that rolled short stays a short wave
 * that grew rather than becoming the same 40-unit front every long-lived
 * crest ends as.
 */
const LENGTH_GROWTH = 0.1;
const LENGTH_GROWTH_CAP = 3;
const HEIGHT_GROWTH = 0.05;

/**
 * The narrowest and widest a crest may roll, world units of FULL width across
 * its own travel line -- so the half-width `hazardfield.ts` builds the
 * profile from is half of whatever is drawn here.
 *
 * `hazardfield.ts` used to hand every wave the same 5-unit width, and a sea
 * of identical waves is a sea a player reads once. Twelve is four hull
 * lengths of water to cross, which at CREST_SPEED_REF is two full seconds
 * under it. The top end is deliberately past what reads as "a wave": the
 * point is the spread, and the ordinary middle of the range is still about
 * the five units this always was.
 *
 * The floor is doubled from the 1 this shipped with, on the owner's reading
 * that the narrowest waves were too narrow. One unit was the width of a third
 * of the hull -- the ship was through it before it had finished heeling, so
 * it landed as a slap rather than as a wall, and the shove it delivered was
 * over before the player could connect it to the water that caused it. Two
 * units is still the quick end of the sea and is long enough to be read as
 * the thing that did it.
 *
 * What the width does NOT change is how hard the wave hits. The push is
 * derived from the wave's SPEED and the height is rolled on its own, so a
 * wide wave is a longer shove of the same strength rather than a bigger one.
 * It does change the contact test, which measures against `halfWidth` -- a
 * 12-unit wave is genuinely harder to be missed by, which is the honest
 * consequence of it being wider water.
 */
export const CREST_WIDTH_MIN = 2;
export const CREST_WIDTH_MAX = 12;

/**
 * How the arc a crest rolls is biased by the length it rolled.
 *
 * `hazardfield.ts` owns what the bow DOES; these two own how much of it a
 * given wave gets. The rule is that a long front tends to be an arc and a
 * short one tends to be a straight stub, which is what a wave spreading out
 * from wherever it was raised actually looks like: the further round the
 * front you can see, the more of its curvature is in front of you.
 *
 * `rollBow` normalises the length over CREST_HALF_LENGTH_MIN..MAX, so
 * doubling that floor moved this without touching either number here: the
 * shortest wave in the sea is now the middle of the old range, and it draws
 * the bow the middle of the range used to. That is the right answer rather
 * than an accident to correct -- the stubs the straight end existed for are
 * the very waves that were removed, and what is left is short FRONTS, which
 * bend.
 *
 * It is a tendency and not a formula, which is the whole reason there are two
 * numbers here instead of one division. The bow is a genuine draw off `rng`,
 * scaled by two factors: how long the wave is (BOW_LENGTH_FLOOR is the share
 * of the bias even the shortest wave keeps, so a short wave is nearly always
 * straight but is not FORBIDDEN a slight bend), and BOW_ROLL_FLOOR, the share
 * of the arc the roll can never take away, so a long wave is nearly always
 * arced but can occasionally come up almost straight. A sea whose silhouette
 * is a strict function of one length is a sea a player reads once, which is
 * the same argument the rolled width was added on.
 */
const BOW_LENGTH_FLOOR = 0.15;
const BOW_ROLL_FLOOR = 0.3;

/**
 * Seconds a crest spends rising, and seconds it spends fading out at the end
 * of an untouched life.
 *
 * The rise is short because a wave that grows slowly reads as the sea level
 * changing rather than as a wave arriving. The fade is longer than the rise
 * for the opposite reason: something that vanished in a frame would look like
 * a dropped draw call.
 */
const CREST_RISE = 1;
const CREST_FADE = 1.5;

/**
 * The coast clip: how many intervals the crest line is probed on, how many
 * bisection steps place each surviving end on the waterline, and the shortest
 * half-length left worth drawing, world units.
 *
 * **A crest that meets land loses the part that met it, not the whole wave.**
 * Every frame the surviving stretch is re-measured along `east` and the
 * hazard's `centre` and `extent` are moved onto it, so a 20-unit front running
 * onto a headland is a shortening wall of water beside the rock rather than a
 * wave that either climbs the beach or vanishes off open sea a moment before
 * it arrives. There is no fade on the lost part: it is gone the frame the
 * water under it turns to land, which is what "breaks on the shore" looks like
 * from the deck.
 *
 * 24 intervals over a 20-unit front is a probe every 0.83 units, which is
 * about the height map's own texel at the equator (2048 texels round a 1257-
 * unit globe), so a finer grid would only resample the same bilinear ramp. It
 * does mean an islet under ~1.7 units across can fall between two probes and
 * be passed over; `islets.ts` culls land that small anyway, and a wave that
 * ignored a rock the size of the hull is a cheaper wrong answer than 40 probes
 * a frame. The 5 bisection steps then place the end itself to 0.03 units, so
 * the shortening is smooth in time rather than stepping a probe at a time.
 *
 * MIN_EXTENT is a quarter of the hull: below it there is no wave left to draw
 * or to be hit by, and the hazard is dropped outright.
 */
const COAST_INTERVALS = 24;
const COAST_REFINE = 5;
const CREST_MIN_EXTENT = 0.75;

/**
 * Seconds a crest takes to dissipate once it has hit the hull, and the peak
 * of the shove it delivers over those seconds at CREST_SPEED_REF, world
 * units/s.
 *
 * The two are one number each way round: the hump is a half-sine, so the
 * distance carried is `2/PI * PEAK * DISSIPATE`. Three seconds at 5 carries
 * the hull about 9.5 units -- three hull lengths, felt but recoverable.
 *
 * **The peak is proportional to the wave's own speed**, which is the one
 * thing here that is not a constant: `pushPeak` below is
 * `PUSH_PEAK * speed / CREST_SPEED_REF`, so a wave shoves the hull in
 * proportion to how fast the water was moving when it arrived. That is both
 * the physical answer and, more to the point, the one that makes the rolled
 * speed READABLE: a player who can see a front closing fast now knows it will
 * hit hard, and the two facts about a wave the sea shows you before it
 * reaches you -- how tall and how quick -- are no longer independent of what
 * it does.
 *
 * The anchor is chosen so nothing gets stronger than the game already
 * shipped. At the 6 units/s every wave used to travel at the peak is exactly
 * the 5 it always was; at the 10.8 of the fastest roll it is 9, just under
 * the 10 the great wave was worth. What is new is everything in
 * between, and the bottom of the range: a 2-knot wave peaks at 1.7 and
 * carries the hull about three units, which is a wave felt rather than a wave
 * survived.
 *
 * DISSIPATE stays a flat 3 seconds. It is the length of the shove, not its
 * strength, and stretching it with speed as well would compound the two into
 * a fast wave carrying the hull four times as far as a slow one rather than
 * six-fifths as hard.
 */
export const DISSIPATE = 3;
export const PUSH_PEAK = 5;

/**
 * How far past the hull's own footprint a crest counts as touching it, world
 * units.
 *
 * Half a hull. The contact test is against a point — the ship is a single
 * direction on the sphere — so without this a wave would have to hit the
 * ship's exact centre, and a 3.1-unit hull would visibly take a crest across
 * the bow and shrug it off.
 */
const HULL_REACH = 1.0;

/**
 * Seconds a maelstrom takes to grow to full size, and seconds it holds there
 * before shrinking away over the same interval.
 *
 * Three seconds of growth is the player's warning: a funnel that opened
 * instantly under the hull would be unavoidable rather than difficult. Thirty
 * seconds of hold is long enough to be a hazard to navigate around and short
 * enough that a player who backs off has genuinely escaped it.
 *
 * The hold is extended indefinitely while a ship is inside it — a maelstrom
 * that has caught something stays until it has eaten it — and `reset()` is
 * what finally removes it.
 */
const MAELSTROM_GROW = 3;
const MAELSTROM_LIFE = 30;

/**
 * The spiral: seconds from capture to the hull vanishing, turns made in that
 * time, and how far below the waterline the hull is drawn at the end, world
 * units.
 *
 * Six seconds is the length of the cutscene the player did not ask for, so it
 * is as short as it can be while still reading as being dragged under rather
 * than teleported. Two and a half turns at an accelerating rate is what makes
 * it look like a drain and not a landing approach. SINK_DEPTH is comfortably
 * more than the hull's draught plus its freeboard, so nothing is left poking
 * out of the water on the frame `onSunk` fires.
 */
export const SPIRAL_SECONDS = 6;
const SPIRAL_TURNS = 2.5;
const SINK_DEPTH = 2.5;
/** Fraction of the spiral that passes before the hull starts going under. */
const SINK_START = 0.6;

/**
 * Distance fade: a hazard is at full strength within FADE_NEAR of the ship
 * and gone beyond FADE_FAR, world units.
 *
 * This is not decoration and it is not an art choice. The displacement patch
 * is 80 units square and skirts its own displacement to zero from 34 units
 * out; the sphere behind it is undisplaced. A hazard still at strength when
 * it leaves the patch would go on tilting the normal and foaming on flat
 * water — a painted stripe on the sea. So the envelope every consumer reads
 * carries this fade baked into it, and it is recomputed every frame because
 * the ship moves even when the hazard does not.
 */
const FADE_NEAR = 32;
const FADE_FAR = 38;

/**
 * How much open water a respawn point needs around it, world units, probed on
 * eight bearings.
 *
 * The ship reappears stopped and on a random heading, so it may be pointing
 * at whatever is nearest. Six units is about two hull lengths of sea in every
 * direction — enough that the first thing a player does after a wreck is not
 * run aground on a beach they were dropped against.
 */
export const RESPAWN_CLEARANCE = 6;
const RESPAWN_BEARINGS = 8;
/** Draws before `pickRespawn` gives up and returns the world's spawn point. */
const RESPAWN_TRIES = 500;

/**
 * Weather seed. Fixed by default, so a given world always rolls the same
 * rough water — the same argument `wind.ts` makes for WIND_SEED.
 */
const HAZARD_SEED = 0x5ea0bb;

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
const _prevCentre = new Vector3();
const _probe = new Vector3();
const _starboard = new Vector3();
const _pushDir = new Vector3();
const _radial = new Vector3();
const _prevDrivePos = new Vector3();
const _candidate = new Vector3();
const _footprint = new Vector3();

/** Clamp to [0, 1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The usual cubic ease, on an already-unclamped argument. */
function smoothstep01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * Rotate `from` by `angle` toward the tangent direction `dir`, about their
 * cross product — the same great-circle step `ship.ts` walks in `stepAlong`
 * and `wind.ts` in its coast probe. Returns false, writing nothing, when the
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

/* ------------------------------------------------------------------ */
/* Hazards                                                             */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only Hazard surface, plus its bookkeeping. */
interface MutableHazard {
  kind: HazardKind;
  centre: Vector3;
  east: Vector3;
  north: Vector3;
  extent: number;
  halfWidth: number;
  bow: number;
  speed: number;
  amplitude: number;
  envelope: number;
  size: number;
  age: number;
  /**
   * The half-length and the height this crest ROSE at, before any growth.
   *
   * `extent` and `amplitude` are recomputed from these and the age every
   * frame (see `grow`), so growth is a function of age rather than an
   * accumulation of per-frame multiplications -- which means a long frame, a
   * paused tab or a clamped `dt` cannot leave one wave permanently smaller
   * than another that rolled the same numbers. Zero on a maelstrom, which
   * does not grow: its size envelope is `size`, not these.
   */
  baseExtent: number;
  baseAmplitude: number;
  /**
   * The share of its ideal length this crest still has after everything the
   * coast has taken from it, 0..1, and it only ever falls.
   *
   * `clipToWater` shortens a wave that has run onto land, and growth would
   * otherwise hand the lost end straight back the next frame -- the clip
   * probes between the crest's CURRENT ends, so a wave whose ends had been
   * pushed back out over the rock would simply re-break there, flickering
   * once a frame. Carrying the loss as a RATIO instead is what lets both
   * rules hold at once: the part of the front that broke on the shore is gone
   * for good, and what is left of the wave goes on building.
   */
  clipRatio: number;
  /**
   * Seconds this crest lives if nothing consumes it, rolled once when it
   * rises. Zero on a maelstrom, which expires on MAELSTROM_LIFE instead and
   * never reads this.
   */
  life: number;
  consumed: boolean;
  /** The age at which it was consumed; -1 while it is still travelling. */
  consumedAt: number;
  /**
   * Whether being consumed carries a push. Only the hull consumes a crest
   * now, so this is true wherever `consumed` is — it is kept as its own flag
   * because the two are separate facts and a future consumer (a crest broken
   * on a reef, say) would be the case that separates them again. The coast no
   * longer uses either: land cuts the wave back rather than consuming it, see
   * `clipToWater`.
   */
  pushing: boolean;
}

/** Internal, mutable mirror of the read-only HazardDrive surface. */
interface MutableDrive {
  position: Vector3;
  forward: Vector3;
  sink: number;
}

/** Internal, mutable mirror of the read-only HazardState surface. */
interface MutableHazardState {
  live: MutableHazard[];
  along: number;
  across: number;
  phase: 'free' | 'spiral' | 'sunk';
  drive: MutableDrive | null;
}

export function createHazards(deps: HazardsDeps): Hazards {
  const { terrain, heightMap, waterBodies, towns, onSunk } = deps;
  const rng = mulberry32(deps.seed ?? HAZARD_SEED);

  const state: MutableHazardState = {
    live: [],
    along: 0,
    across: 0,
    phase: 'free',
    drive: null,
  };

  /**
   * Allocated once and handed out by reference, like everything else here:
   * `ship.ts` reads it every frame while the hull is being driven, and a
   * fresh object per frame would be sixty allocations a second for a thing
   * that is only ever three numbers.
   */
  const drive: MutableDrive = { position: new Vector3(), forward: new Vector3(), sink: 0 };

  let rollTimer = 0;
  /** The maelstrom that has the ship, while `phase !== 'free'`. */
  let captor: MutableHazard | null = null;
  let spiralTime = 0;
  let spiralR0 = 0;
  let spiralTheta0 = 0;
  let sunkFired = false;

  /* ---- The world's opinion of a point -------------------------------- */

  /*
   * Both questions are asked of the same rasterised height field the water
   * shader and the scope read, never of `terrain.heightAt`. Three readings of
   * one field can never disagree about where the shoreline is, which is the
   * reason `globe.ts` installs the map as the ship's land mask in the first
   * place.
   */
  function isOpenWater(dir: Vector3): boolean {
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

  /* ---- Building one ------------------------------------------------- */

  /**
   * Half the full length this crest rolls, world units. Uniform between the
   * two bounds, for the same reason the width is -- see `rollHalfWidth`.
   */
  function rollHalfLength(): number {
    return CREST_HALF_LENGTH_MIN + rng() * (CREST_HALF_LENGTH_MAX - CREST_HALF_LENGTH_MIN);
  }

  /**
   * How far this crest's ends trail behind its centre, as a fraction of its
   * half-length. See CREST_BOW_MAX, BOW_LENGTH_FLOOR and BOW_ROLL_FLOOR.
   *
   * One draw off `rng`, scaled by the two floors: the length term makes a
   * long wave usually arced and a short one usually straight, and the roll
   * term is what keeps "usually" honest in both directions.
   */
  function rollBow(halfLength: number): number {
    const lengthFrac =
      (halfLength - CREST_HALF_LENGTH_MIN) / (CREST_HALF_LENGTH_MAX - CREST_HALF_LENGTH_MIN);
    const byLength = BOW_LENGTH_FLOOR + (1 - BOW_LENGTH_FLOOR) * lengthFrac;
    const byRoll = BOW_ROLL_FLOOR + (1 - BOW_ROLL_FLOOR) * rng();
    return CREST_BOW_MAX * byLength * byRoll;
  }

  /** How fast this crest travels, world units/s. See CREST_SPEED_MIN/MAX. */
  function rollSpeed(): number {
    return CREST_SPEED_MIN + rng() * (CREST_SPEED_MAX - CREST_SPEED_MIN);
  }

  /** The height this crest RISES at, world units, before any growth. */
  function rollAmplitude(): number {
    return CREST_HEIGHT_MIN + rng() * (CREST_HEIGHT_MAX_START - CREST_HEIGHT_MIN);
  }

  /**
   * The profile's scale in world units, and it is POSITIVE for every kind --
   * a maelstrom's is the funnel's DEPTH, not a signed height.
   *
   * The minus sign lives inside `hazardfield.ts`'s profile, so that the rim
   * can be a positive fraction of the same number. Handing a negative one
   * over raises a mountain where the hole belongs, and does it identically on
   * the GPU and the CPU -- so the parity probe still agrees to the pixel, the
   * unit tests on both sides still pass, and the only thing that is wrong is
   * the sea. See `hazardStrength`, which is the other half of this contract.
   */
  /**
   * Half the full width this crest rolls, world units.
   *
   * Uniform between the two bounds. Not weighted toward the middle: the
   * whole reason the width moved off a constant is that the sea should be
   * able to produce a wave a player has not seen before, and a distribution
   * that quietly avoided its own ends would only be the old single width
   * with jitter on it.
   */
  function rollHalfWidth(): number {
    return (CREST_WIDTH_MIN + rng() * (CREST_WIDTH_MAX - CREST_WIDTH_MIN)) / 2;
  }

  /**
   * Seconds this crest lives untouched: the travel it rolled, divided by the
   * speed it rolled, held inside the two life clamps. See CREST_TRAVEL_MIN.
   */
  function rollLife(speed: number): number {
    const travel = CREST_TRAVEL_MIN + rng() * (CREST_TRAVEL_MAX - CREST_TRAVEL_MIN);
    return Math.max(CREST_LIFE_MIN, Math.min(CREST_LIFE_MAX, travel / speed));
  }

  /**
   * The peak of the shove this crest delivers, world units/s: PUSH_PEAK,
   * scaled by how fast the water was moving. See PUSH_PEAK.
   */
  function pushPeak(h: MutableHazard): number {
    return (PUSH_PEAK * h.speed) / CREST_SPEED_REF;
  }

  /**
   * Bring one crest's length and height up to what its age says they should
   * be, and re-apply whatever the coast has already taken off the length.
   *
   * Both are compounding -- `base * (1 + rate)^age` -- and both are capped;
   * see LENGTH_GROWTH and its neighbours for all four numbers. Recomputed
   * from the age each frame rather than multiplied on, so the result depends
   * on nothing but how long the wave has been on the water.
   */
  function grow(h: MutableHazard): void {
    const ideal = Math.min(
      h.baseExtent * Math.pow(1 + LENGTH_GROWTH, h.age),
      h.baseExtent * LENGTH_GROWTH_CAP,
      CREST_HALF_LENGTH_CAP,
    );
    h.extent = ideal * h.clipRatio;
    h.amplitude = Math.min(
      h.baseAmplitude * Math.pow(1 + HEIGHT_GROWTH, h.age),
      CREST_HEIGHT_MAX,
    );
  }

  /**
   * Raise a hazard at `centre` travelling toward `north`, and file it.
   *
   * `east` is rebuilt from `north` rather than passed in, so the pair can
   * never be handed over inconsistent: `east = normalize(cross(north,
   * centre))` is the one definition, here and in the transport below.
   */
  function build(
    kind: HazardKind,
    centre: Vector3,
    north: Vector3,
    rolledSpeed: number | null = null,
  ): MutableHazard {
    const c = centre.clone().normalize();
    const n = north.clone();
    // Project the requested heading onto the tangent plane at the centre; a
    // caller (`force`, the dev query) may hand over anything.
    n.addScaledVector(c, -n.dot(c));
    if (n.lengthSq() < 1e-12) tangentFrame(c, n, _east);
    n.normalize();
    const e = new Vector3().crossVectors(n, c).normalize();

    const crest = kind !== 'maelstrom';
    // Every crest number is rolled HERE rather than in `trySpawn`, so a wave
    // forced by a test or by `?hazard=` is as varied as one the weather
    // raised: there is no such thing in this file as a crest of the default
    // anything. The order the draws come off `rng` is part of the run's
    // reproducibility -- see ROLL_ORDER -- so it is fixed, and `rollLife`
    // reads the speed rather than drawing it again.
    const halfLength = crest ? rollHalfLength() : 0;
    // `trySpawn` has to know a crest's speed before it can place it -- the
    // spawn distance is a lead TIME now -- so it draws one and hands it over.
    // `force` and the dev query pass nothing and get a rolled one here, which
    // is what keeps a forced wave as varied as a raised one.
    const speed = crest ? (rolledSpeed ?? rollSpeed()) : 0;
    const hazard: MutableHazard = {
      kind,
      centre: c,
      east: e,
      north: n,
      extent: crest ? halfLength : MAELSTROM_RADIUS,
      halfWidth: crest ? rollHalfWidth() : 0,
      bow: crest ? rollBow(halfLength) : 0,
      speed,
      amplitude: crest ? rollAmplitude() : FUNNEL_DEPTH,
      envelope: 0,
      size: crest ? 1 : 0,
      age: 0,
      baseExtent: crest ? halfLength : 0,
      baseAmplitude: 0,
      clipRatio: 1,
      life: crest ? rollLife(speed) : 0,
      consumed: false,
      consumedAt: -1,
      pushing: false,
    };
    hazard.baseAmplitude = hazard.amplitude;
    // The live budget is per kind (see CAPACITY): a hazard raised over a full
    // pool replaces the OLDEST of its kind rather than quietly pushing the
    // count past MAX_HAZARDS, which the shader's uniform arrays cannot hold.
    // Oldest and not newest so that a forced wave never evicts the one raised
    // half a second before it and leaves the sea emptier than it found it.
    const capacity = CAPACITY[kind];
    for (let i = 0; i < state.live.length && countOf(kind) >= capacity; ) {
      if (state.live[i].kind === kind) state.live.splice(i, 1);
      else i++;
    }
    state.live.push(hazard);
    return hazard;
  }

  /** How many of `kind` are on the water. Compared against CAPACITY. */
  function countOf(kind: HazardKind): number {
    let n = 0;
    for (let i = 0; i < state.live.length; i++) {
      if (state.live[i].kind === kind) n++;
    }
    return n;
  }

  /* ---- Spawning ----------------------------------------------------- */

  /**
   * The heading a crest travels on: the wind's, resolved at the crest's own
   * centre. Written into `_north`, with `_east` rebuilt to match.
   *
   * Waves go where the weather goes. That is the whole rule, and it replaces
   * a crest that used to be aimed at where the ship would be in four seconds:
   * the sea is not hunting anybody, and a player who can read the wind can
   * now read the water as well, which is worth more than a hazard that
   * quietly followed them.
   *
   * `wind.direction` is a world vector in the tangent plane at the SHIP (see
   * `WindState.direction` on why it is kept as a vector and not a bearing).
   * The crest is up to 30 units away, where that plane is a fraction of a
   * degree off, so it is projected onto the tangent plane at `centre` and
   * renormalised rather than used as it stands. Falls back to any frame at
   * all in the degenerate case, which needs the wind to be pointing straight
   * up out of the sea.
   */
  function crestHeading(centre: Vector3, wind: WindState): void {
    _north.copy(wind.direction);
    _north.addScaledVector(centre, -_north.dot(centre));
    if (_north.lengthSq() < 1e-12) {
      tangentFrame(centre, _north, _east);
      return;
    }
    _north.normalize();
    _east.crossVectors(_north, centre).normalize();
  }

  /**
   * Try to place one hazard of `kind`. Returns whether it was placed.
   *
   * The plan lists the acceptance tests before the choice of heading, but a
   * crest's footprint is measured along `east`, which only exists once
   * `north` does — so the heading is drawn first and the footprint tested
   * against the frame it produced. Same tests, same points, in the only order
   * that can actually evaluate them.
   */
  function trySpawn(kind: HazardKind, ship: ShipState, wind: WindState): boolean {
    if (state.live.length >= MAX_HAZARDS) return false;
    /*
     * The footprint the placement tests is the NOMINAL half-length, not the
     * one this particular wave is about to roll and certainly not the one it
     * will have grown to. Both of those are deliberate. Testing against
     * CREST_HALF_LENGTH_MAX would err outward and quietly stop the sea
     * raising anything at all inside an archipelago, and testing against the
     * grown length is impossible -- a wave spends its whole life getting
     * longer, and it travels while it does it. `clipToWater` is what owns a
     * front meeting land, every frame, for the whole of its life; this test
     * only has to stop a wave being BORN across a beach.
     */
    const extent = kind === 'maelstrom' ? MAELSTROM_RADIUS : CREST_HALF_LENGTH;
    // Drawn once, before the attempt loop, so 24 failed placements cost one
    // draw off `rng` rather than 24 -- the stream is the run's weather, and a
    // crowded coast must not be able to reorder it.
    const speed = kind === 'maelstrom' ? 0 : rollSpeed();

    for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
      // A crest rises a fixed number of SECONDS off the bow rather than a
      // fixed number of units -- see SPAWN_LEAD_MIN. A maelstrom does not
      // travel, so its distance is still a distance.
      const draw = rng();
      const d =
        kind === 'maelstrom'
          ? MAELSTROM_SPAWN_MIN + draw * (MAELSTROM_SPAWN_MAX - MAELSTROM_SPAWN_MIN)
          : Math.max(
              SPAWN_DIST_MIN,
              Math.min(
                SPAWN_DIST_MAX,
                speed * (SPAWN_LEAD_MIN + draw * (SPAWN_LEAD_MAX - SPAWN_LEAD_MIN)),
              ),
            );
      const upwind = rng() < UPWIND_SHARE;
      const offset = upwind ? (rng() * 2 - 1) * UPWIND_HALF_ARC : rng() * TWO_PI;

      /*
       * The bearing is resolved by turning a VECTOR about the ship's own up,
       * never by adding an offset to a compass bearing and rebuilding it in a
       * tangent frame. Algebraically the same wherever a frame exists, and
       * unlike the addition it still means "60 degrees off upwind" where one
       * does not. The uniform draw needs no frame either: any rotation through
       * a full turn covers the compass.
       *
       * The vector turned is the wind REVERSED -- `wind.direction` is where
       * the air is going, so its negation is where it is coming from, and
       * that is where the water the ship is about to meet has to be born.
       * `wind.ts` floors the weather at LULL_SPEED so there is always a
       * direction to read; the bow is the fallback only in the degenerate
       * case where the wind vector has collapsed onto the local up.
       */
      _bearingDir.copy(wind.direction).negate();
      _bearingDir.addScaledVector(ship.position, -_bearingDir.dot(ship.position));
      if (_bearingDir.lengthSq() < 1e-12) _bearingDir.copy(ship.forward);
      _bearingDir.applyAxisAngle(ship.up, offset);
      _bearingDir.addScaledVector(ship.position, -_bearingDir.dot(ship.position));
      if (_bearingDir.lengthSq() < 1e-12) continue;
      _bearingDir.normalize();
      if (!stepAlong(_candidate, ship.position, _bearingDir, d * ARC)) continue;

      // The centre first: the cheapest test, and the one that rejects most.
      if (!isOpenWater(_candidate)) continue;
      if (nearBerth(_candidate, extent + BERTH_MARGIN + largestBerthRadius())) continue;

      // The heading, and with it the frame the footprint is measured in.
      if (kind === 'maelstrom') {
        tangentFrame(_candidate, _north, _east);
      } else {
        crestHeading(_candidate, wind);
      }

      // The footprint: a crest's two ends, a maelstrom's four compass points.
      let clear = true;
      for (let i = 0; i < 4; i++) {
        if (kind !== 'maelstrom' && i >= 2) break;
        const along = i < 2 ? _east : _north;
        const sign = i % 2 === 0 ? 1 : -1;
        _footprint.copy(along).multiplyScalar(sign);
        if (!stepAlong(_probe, _candidate, _footprint, extent * ARC)) continue;
        if (!isOpenWater(_probe)) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;

      build(kind, _candidate, _north, kind === 'maelstrom' ? null : speed);
      return true;
    }
    return false;
  }

  /**
   * The widest berth in the world, cached once.
   *
   * The plan's clearance is `DOCK_RADIUS + extent + BERTH_MARGIN`, and
   * `DOCK_RADIUS` is private to `towns.ts` — it reaches this module only as
   * `Dock.radius`. Taking the largest rather than each berth's own keeps the
   * test one comparison per berth and errs outward, which is the safe side of
   * a rule about not putting a wall of water in a charging zone.
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

  /**
   * One roll: a draw for every kind, in a fixed order, live or not.
   *
   * The unconditional draw is the whole point — see ROLL_ORDER.
   */
  function roll(ship: ShipState, wind: WindState, stormOdds: number): void {
    for (const kind of ROLL_ORDER) {
      // Every attempt draws, and draws BEFORE anything is allowed to skip it
      // -- see ROLL_ATTEMPTS and ROLL_ORDER. The count of numbers taken off
      // `rng` per roll is therefore fixed at ROLL_ATTEMPTS summed over the
      // kinds, whatever the sea happens to be holding, which is the whole of
      // why a seeded run replays.
      for (let attempt = 0; attempt < ROLL_ATTEMPTS[kind]; attempt++) {
        const draw = rng();
        // The capacity rule and the storm multiplier are two different limits
        // and both stand. `stormOdds` makes a hazard likelier to be rolled;
        // CAPACITY caps how many can be on the water at once, so a storm fills
        // the free slots faster without ever raising the ceiling. That is why
        // tripling the odds buys well under three times the weather -- see
        // `main.ts`'s own note on STORM_ODDS_GAIN.
        //
        // Re-read every attempt rather than once per kind: five attempts can
        // fill the last free slot on the second of them, and the three behind
        // it must then find the sea full rather than overrun it.
        if (countOf(kind) >= CAPACITY[kind]) continue;
        if (draw < ROLL_ODDS[kind] * stormOdds) trySpawn(kind, ship, wind);
      }
    }
  }

  /* ---- Envelopes ----------------------------------------------------- */

  /** 1 within FADE_NEAR of the ship, 0 beyond FADE_FAR. See the constants. */
  function distanceFade(ship: ShipState, centre: Vector3): number {
    const d = arcDistance(ship.position, centre);
    return 1 - smoothstep01((d - FADE_NEAR) / (FADE_FAR - FADE_NEAR));
  }

  /**
   * Advance one hazard's shape envelope and size, and say whether it is over.
   *
   * The rise/hold/fade shape and the distance fade are multiplied together
   * into the single `envelope` all three consumers read, so a hazard that
   * outruns the displacement patch dissolves instead of painting a stripe on
   * the sphere behind it.
   */
  function shapeEnvelope(h: MutableHazard, ship: ShipState): boolean {
    if (h.kind === 'maelstrom') {
      let g: number;
      if (h.age < MAELSTROM_GROW) {
        g = smoothstep01(h.age / MAELSTROM_GROW);
      } else if (h.age < MAELSTROM_LIFE || state.phase !== 'free') {
        // A funnel with a ship in it does not expire; `reset()` removes it.
        g = 1;
      } else {
        const t = h.age - MAELSTROM_LIFE;
        if (t >= MAELSTROM_GROW) return true;
        g = 1 - smoothstep01(t / MAELSTROM_GROW);
      }
      h.size = g;
      h.envelope = g * distanceFade(ship, h.centre);
      return false;
    }

    const rise = smoothstep01(h.age / CREST_RISE);
    let fall: number;
    if (h.consumed) {
      const t = h.age - h.consumedAt;
      if (t >= DISSIPATE) return true;
      fall = 1 - smoothstep01(t / DISSIPATE);
    } else {
      if (h.age >= h.life) return true;
      fall = smoothstep01((h.life - h.age) / CREST_FADE);
    }
    h.size = 1;
    h.envelope = rise * fall * distanceFade(ship, h.centre);
    return false;
  }

  /* ---- Transport ----------------------------------------------------- */

  /**
   * Carry a crest one step along its own travel line.
   *
   * The step is a great-circle rotation and `north` is carried by exactly
   * that same rotation — parallel transport, `ship.ts`'s way with the bow.
   * The `reframe` afterwards is not decoration: each step leaves `north` a
   * rounding error out of the tangent plane, and over a 60-unit life those
   * errors accumulate into a crest that is no longer flat on the sea.
   */
  function transport(h: MutableHazard, dt: number): void {
    _prevCentre.copy(h.centre);
    if (!stepAlong(h.centre, h.centre, h.north, h.speed * dt * ARC)) return;

    _axis.crossVectors(_prevCentre, h.centre);
    const sin = _axis.length();
    if (sin > 1e-12) {
      _axis.multiplyScalar(1 / sin);
      const cos = Math.max(-1, Math.min(1, _prevCentre.dot(h.centre)));
      h.north.applyAxisAngle(_axis, Math.atan2(sin, cos));
    }
    reframe(h);
  }

  /**
   * Re-orthonormalise a crest's frame after its centre has been moved, and
   * rebuild `east` from the corrected `north`.
   *
   * Shared by `transport` (which moves the centre along `north`) and
   * `shiftAlongEast` (which moves it along `east`); both leave `north` a
   * rounding error out of the new tangent plane, and over a 60-unit life
   * those errors accumulate into a crest that is no longer flat on the sea.
   */
  function reframe(h: MutableHazard): void {
    h.north.addScaledVector(h.centre, -h.north.dot(h.centre));
    if (h.north.lengthSq() > 1e-12) h.north.normalize();
    else tangentFrame(h.centre, h.north, _east);
    h.east.crossVectors(h.north, h.centre).normalize();
  }

  /**
   * Slide a crest's centre `offset` world units along its own long axis.
   *
   * This is how the coast clip re-centres a wave on what is left of it: the
   * profile in `hazardfield.ts` is symmetric about `centre` and measured out
   * to `extent`, so a crest that has lost one end has to move onto the middle
   * of the other rather than grow an offset the shader has no uniform for.
   * Everything downstream — the shader, the CPU port the hull rides, the
   * contact test, the scope's bar — then follows from `centre` and `extent`
   * with no further change.
   *
   * The rotation is about `north` (the axis `stepAlong` builds is
   * `centre x east`, which is `north` by construction), so the travel
   * direction is untouched and only the frame needs tidying afterwards.
   */
  function shiftAlongEast(h: MutableHazard, offset: number): void {
    if (offset === 0) return;
    if (!stepAlong(h.centre, h.centre, h.east, offset * ARC)) return;
    reframe(h);
  }

  /** True where the crest line at `offset` world units along `east` is dry. */
  function landAlongCrest(h: MutableHazard, offset: number): boolean {
    if (!stepAlong(_probe, h.centre, h.east, offset * ARC)) _probe.copy(h.centre);
    return heightMap.sample(_probe) > terrain.seaLevel;
  }

  /**
   * Bisect between a dry offset and a wet one, and return the wettest bound
   * it is sure of.
   *
   * Conservative by construction: the value returned has been sampled as
   * water, so the surviving span never reaches past the waterline onto the
   * beach even when the bisection runs out of steps.
   */
  function waterline(h: MutableHazard, dry: number, wet: number): number {
    for (let k = 0; k < COAST_REFINE; k++) {
      const mid = (dry + wet) / 2;
      if (landAlongCrest(h, mid)) dry = mid;
      else wet = mid;
    }
    return wet;
  }

  /**
   * Cut a crest back to the longest stretch of open water it still covers,
   * and say whether anything is left of it.
   *
   * Called every frame a crest travels, so the wave breaks up as it meets the
   * shore rather than at some threshold moment. Three properties are worth
   * keeping if this is ever rewritten:
   *
   *   - **It only ever shrinks.** The probe runs between the crest's CURRENT
   *     ends, so a wave that has broken cannot grow its lost end back when it
   *     travels clear of the rock again — which is both what water does and
   *     what stops the clip from oscillating on a bilinear waterline.
   *   - **The longest run wins.** A wave cut in two by an islet keeps the
   *     bigger half. One hazard is one span in the shader's uniforms, so the
   *     alternative to choosing is drawing a wall of water across the rock.
   *   - **The line is the whole test.** The crest has depth (`halfWidth`,
   *     which a wave now rolls for itself between half of CREST_WIDTH_MIN and
   *     half of CREST_WIDTH_MAX) but only its own centre line is probed, so a
   *     wave's face may overlap a beach for a fraction of a second before the
   *     line does. A second row of probes would double the cost to move the
   *     moment of breaking by under a second at CREST_SPEED_REF, and the widest
   *     wave this can roll is the only one for which it is even that.
   */
  function clipToWater(h: MutableHazard): boolean {
    const half = h.extent;
    if (half <= 0) return false;
    const n = COAST_INTERVALS;
    const stride = (2 * half) / n;

    // The longest run of consecutive wet probes, as an index pair.
    let bestFrom = -1;
    let bestTo = -1;
    let runFrom = -1;
    for (let i = 0; i <= n; i++) {
      if (landAlongCrest(h, -half + stride * i)) {
        runFrom = -1;
        continue;
      }
      if (runFrom < 0) runFrom = i;
      if (bestFrom < 0 || i - runFrom > bestTo - bestFrom) {
        bestFrom = runFrom;
        bestTo = i;
      }
    }
    // Every probe dry: the whole front is on the beach, and it goes now.
    if (bestFrom < 0) return false;
    // Every probe wet, ends included: open water, and nothing to re-measure.
    if (bestFrom === 0 && bestTo === n) return true;

    const from =
      bestFrom === 0
        ? -half
        : waterline(h, -half + stride * (bestFrom - 1), -half + stride * bestFrom);
    const to =
      bestTo === n ? half : waterline(h, -half + stride * (bestTo + 1), -half + stride * bestTo);

    const extent = (to - from) / 2;
    if (extent < CREST_MIN_EXTENT) return false;
    shiftAlongEast(h, (from + to) / 2);
    // Carried as a SHARE of the length the wave would have had, not as the
    // length itself: `grow` re-applies it every frame, so the end that broke
    // on the shore stays broken while the rest of the front goes on building.
    // `h.extent` here is what `grow` just set, so the ratio compounds with
    // whatever the coast has already taken.
    h.clipRatio *= extent / h.extent;
    h.extent = extent;
    return true;
  }

  /* ---- The spiral ---------------------------------------------------- */

  function beginSpiral(h: MutableHazard, ship: ShipState, distance: number): void {
    state.phase = 'spiral';
    captor = h;
    spiralTime = 0;
    spiralR0 = distance;
    spiralTheta0 = Math.atan2(ship.position.dot(h.north), ship.position.dot(h.east));
    drive.position.copy(ship.position);
    drive.forward.copy(ship.forward);
    drive.sink = 0;
    state.drive = drive;
    state.along = 0;
    state.across = 0;
  }

  /**
   * One frame of being eaten.
   *
   * `r` reaches zero exactly at `s = 1` and `drive.position` is a great-circle
   * step of `r` from the funnel's centre, so the hull is never outside the
   * radius it was caught at and the position is a unit vector on every frame
   * of it — which `ship.ts` copies straight into its own state without
   * checking. The bow is taken from the direction it actually moved rather
   * than from the spiral's algebra, so it always points along the track.
   */
  function advanceSpiral(dt: number): void {
    const h = captor;
    if (h === null) return;
    spiralTime += dt;
    const s = clamp01(spiralTime / SPIRAL_SECONDS);

    const k = 1 - s;
    const r = spiralR0 * k * Math.sqrt(k);
    const theta = spiralTheta0 + TWO_PI * SPIRAL_TURNS * ((s + s * s) / 2);

    _prevDrivePos.copy(drive.position);
    _radial.copy(h.east).multiplyScalar(Math.cos(theta)).addScaledVector(h.north, Math.sin(theta));
    if (r < 1e-6 || _radial.lengthSq() < 1e-12 || !stepAlong(drive.position, h.centre, _radial, r * ARC)) {
      drive.position.copy(h.centre);
    }

    // The bow follows the track: the tangent-plane difference between where
    // the hull is and where it was. Degenerate on the frame it stops moving,
    // and there the last heading is the right one to keep.
    _pushDir.copy(drive.position).sub(_prevDrivePos);
    _pushDir.addScaledVector(drive.position, -_pushDir.dot(drive.position));
    if (_pushDir.lengthSq() > 1e-12) drive.forward.copy(_pushDir).normalize();

    drive.sink = SINK_DEPTH * smoothstep01((s - SINK_START) / (1 - SINK_START));

    if (s >= 1) {
      state.phase = 'sunk';
      drive.position.copy(h.centre);
      drive.sink = SINK_DEPTH;
      if (!sunkFired) {
        sunkFired = true;
        onSunk();
      }
    }
  }

  /* ---- The frame ----------------------------------------------------- */

  function update(
    dt: number,
    ship: ShipState,
    energy: EnergyState,
    wind: WindState,
    stormOdds = 1,
  ): void {
    // A frame that advanced no time raises no water. Returning leaves the
    // last true state standing rather than rewriting it with a stale zero.
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    const docked = energy.mode === 'docked';

    // ---- Roll -------------------------------------------------------
    rollTimer += dt;
    while (rollTimer >= ROLL_PERIOD) {
      rollTimer -= ROLL_PERIOD;
      roll(ship, wind, stormOdds);
    }

    // ---- Age, travel, and the coast ---------------------------------
    // Backwards, because a crest with no open water left under it is dropped
    // here and now: the part of a wave that meets land is gone on the frame
    // it meets it, with no dissipation to fade out through, so a front that
    // has lost every part of itself has nothing left to remove later.
    for (let i = state.live.length - 1; i >= 0; i--) {
      const h = state.live[i];
      h.age += dt;
      if (h.kind === 'maelstrom') continue;
      // Grow, then travel, then meet the coast -- in that order, because the
      // clip has to run on the length the wave actually has this frame or a
      // front that just grew a unit into a headland would draw over it until
      // the next one.
      grow(h);
      transport(h, dt);
      if (!clipToWater(h)) state.live.splice(i, 1);
    }

    // ---- Contact ----------------------------------------------------
    // A berth is shelter and a hull already in a funnel is not the player's
    // to shove, so neither state takes a crest at all: the wave passes over
    // and lives out its own life.
    if (!docked && state.phase === 'free') {
      for (let i = 0; i < state.live.length; i++) {
        const h = state.live[i];
        if (h.kind === 'maelstrom' || h.consumed) continue;
        // Dot products are the small-angle approximation, so they are only a
        // position on the near side of the sphere; on the far side both come
        // back near zero and every point would read as a hit.
        if (ship.position.dot(h.centre) <= 0) continue;
        // Local coordinates are dot products, never angles: `u` across the
        // travel line, `v` along it, direction units scaled to world units.
        const u = ship.position.dot(h.east) * GLOBE_RADIUS;
        // The along-travel coordinate is measured against the crest's own
        // ARC, exactly as `hazardfield.ts` measures it, or a bowed wave would
        // be hit by its ends a second before the water there arrived -- see
        // `hazBowV`. `bow` is 0 on a straight crest, so this is the plain dot
        // product the test always was for one of those.
        const xr = u / Math.max(h.extent, 1e-6);
        const v = ship.position.dot(h.north) * GLOBE_RADIUS + h.bow * h.extent * xr * xr;
        if (Math.abs(u) < h.extent + HULL_REACH && Math.abs(v) < h.halfWidth + HULL_REACH) {
          h.consumed = true;
          h.consumedAt = h.age;
          h.pushing = true;
        }
      }
    }

    // ---- Envelopes, and what is over --------------------------------
    for (let i = state.live.length - 1; i >= 0; i--) {
      if (shapeEnvelope(state.live[i], ship)) state.live.splice(i, 1);
    }

    // ---- Push -------------------------------------------------------
    /*
     * A half-sine hump, resolved onto the hull by two dot products and
     * nothing else. No eight-sector table and no easing: unlike the wind,
     * whose table steps as the bow crosses a boundary and therefore needs
     * smoothing, this is already smooth in time by construction, and it is
     * meant to shove the hull the way the water went rather than on a point
     * of sail.
     */
    let along = 0;
    let across = 0;
    if (!docked) {
      _starboard.crossVectors(ship.forward, ship.up);
      if (_starboard.lengthSq() > 1e-12) _starboard.normalize();
      for (let i = 0; i < state.live.length; i++) {
        const h = state.live[i];
        if (!h.consumed || !h.pushing || h.kind === 'maelstrom') continue;
        // The peak is this wave's own, scaled by the speed it rolled -- see
        // PUSH_PEAK. The span is not: a fast wave hits harder, not longer.
        const t = h.age - h.consumedAt;
        const p = pushPeak(h) * Math.sin((Math.PI * t) / DISSIPATE);
        // The crest's travel direction, brought onto the plane the hull
        // actually moves in; a few units away that is a rotation of a degree
        // or two, but it is what keeps the pair a true resolution of one
        // vector rather than two loosely related numbers.
        _pushDir.copy(h.north).addScaledVector(ship.position, -h.north.dot(ship.position));
        if (_pushDir.lengthSq() < 1e-12) continue;
        _pushDir.normalize();
        along += p * _pushDir.dot(ship.forward);
        across += p * _pushDir.dot(_starboard);
      }
    }
    state.along = along;
    state.across = across;

    // ---- Capture, and the spiral ------------------------------------
    if (state.phase === 'free') {
      if (!docked) {
        for (let i = 0; i < state.live.length; i++) {
          const h = state.live[i];
          if (h.kind !== 'maelstrom' || h.size <= 0) continue;
          const d = arcDistance(ship.position, h.centre);
          if (d < h.extent * h.size + HULL_REACH) {
            beginSpiral(h, ship, d);
            break;
          }
        }
      }
    } else if (state.phase === 'spiral') {
      advanceSpiral(dt);
    }
  }

  function reset(): void {
    state.live.length = 0;
    state.along = 0;
    state.across = 0;
    state.phase = 'free';
    state.drive = null;
    captor = null;
    spiralTime = 0;
    sunkFired = false;
    // The roll timer goes back to zero too: a player who has just watched
    // their ship sink gets the full ten seconds somewhere else before the
    // sea starts drawing again.
    rollTimer = 0;
  }

  function force(kind: HazardKind, centre: Vector3, north: Vector3): void {
    build(kind, centre, north);
  }

  /**
   * A random point of reachable open ocean, clear of land and of every berth.
   *
   * Pure, apart from the seeded stream it draws from, and deliberately not a
   * frame-loop function: it runs once, behind a black screen, and can afford
   * five hundred tries and a ring probe on each. The fallback is the world's
   * own spawn point, which `terrain.ts` guarantees is open ocean — so this
   * always returns somewhere the ship can float, even on a world with no
   * ocean left to find.
   */
  function pickRespawn(): Vector3 {
    const out = new Vector3();
    for (let attempt = 0; attempt < RESPAWN_TRIES; attempt++) {
      randomDirection(rng, out).normalize();
      if (!isOpenWater(out)) continue;
      if (nearBerth(out, 2 * largestBerthRadius())) continue;

      // One ring of eight bearings, the same probe `wind.ts` walks for its
      // coast distance, so the ship is dropped in water that is open in every
      // direction rather than in a channel it happens to be pointing out of.
      tangentFrame(out, _north, _east);
      let clear = true;
      for (let b = 0; b < RESPAWN_BEARINGS; b++) {
        const theta = (b / RESPAWN_BEARINGS) * TWO_PI;
        _bearingDir
          .copy(_north)
          .multiplyScalar(Math.cos(theta))
          .addScaledVector(_east, Math.sin(theta));
        if (!stepAlong(_probe, out, _bearingDir, RESPAWN_CLEARANCE * ARC)) continue;
        if (!isOpenWater(_probe)) {
          clear = false;
          break;
        }
      }
      if (clear) return out;
    }
    return latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG).normalize();
  }

  return { state: state as HazardState, update, reset, force, pickRespawn };
}
