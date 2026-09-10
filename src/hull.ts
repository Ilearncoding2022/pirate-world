/**
 * hull.ts — durability: the second reserve, beside the power reserve.
 *
 * The brief is docs/HARBOURS_PLAN.md, "Stream B: the hull". A float in
 * [HULL_MIN, 100] that falls with the clock, falls twice as fast in weather,
 * is knocked down by fights and maelstroms, and climbs again alongside a
 * berth. Nothing in here draws anything, reads the world or knows what a
 * berth is: it is handed two booleans a frame and owns the arithmetic
 * between them.
 *
 * The shape follows `battery.ts` deliberately — a float kept inside, a whole
 * percent published, and `onChange` fired only when that whole percent moves.
 * A hull wearing at a quarter of a percent a minute crosses a whole percent
 * about every four minutes, so the save is written about once every four
 * minutes rather than sixty times a second. That throttle is the only reason
 * a continuously-moving figure can be persisted at all; see the note on
 * `createRecords` in `save.ts`, which subscribes this and the cell for the
 * same reason.
 *
 * Two things this file deliberately does NOT own:
 *
 * - **When the clock runs.** `update` is called only from the sailing branch
 *   of `main.ts`'s frame loop, which is what keeps the hull still during
 *   fishing, a battle, the shop and the menu (docs/HARBOURS_PLAN.md,
 *   decision 12). That is a property of the call site, not a flag in here,
 *   so there is no mode this file can be left stuck in.
 * - **What counts as weather.** `HULL_WEATHER_THRESHOLD` lives in `main.ts`
 *   beside the `WeatherState` it tests. This file is handed the answer.
 */
import type { HullMode, HullState } from './types';
import { DOCK_NET_RATE } from './energy';

export interface Hull {
  readonly state: HullState;
  /**
   * Advance the wear or the repair.
   *
   * `docked` wins over `weathered`: a ship alongside is being worked on, and
   * the weather it is sitting in does not matter. Called ONLY from the
   * sailing branch of the frame loop, which is what keeps the clock off
   * during fishing, a battle, the shop and the menu — see
   * docs/HARBOURS_PLAN.md, decision 12. It is a property of the call site
   * rather than a flag in here.
   */
  update(dt: number, docked: boolean, weathered: boolean): void;
  /** Knock `points` whole percent off, floored at `HULL_MIN`. */
  damage(points: number): void;
  /** Add `points` whole percent, capped at 100. */
  repair(points: number): void;
  /** Fires when the WHOLE percent changes, for the save. */
  onChange(fn: () => void): void;
  /**
   * Sets the hull outright and tells NOBODY. The `?hull=` query's one door.
   *
   * `damage`/`repair` are the honest ways to move this number and both
   * notify, which means both write the save. A dev query must not: see the
   * note on `?hull=<percent>` under `createHull` below.
   */
  override(percent: number): void;
}

/* ------------------------------------------------------------------ */
/* The numbers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Lowest the hull can ever go. There is no sinking and no game over.
 *
 * One rather than zero, and that is the whole design of this reserve: a
 * player at the floor is crawling at 1 kn, cannot fish and loses a fight to
 * the first ball, but is still sailing and can still reach a berth. Zero
 * would need a failure state, and the game has none — a ship that cannot be
 * lost is a ship whose durability is a cost rather than a threat.
 */
export const HULL_MIN = 1;

/** The top, and what a save with no hull field in it reads as. */
export const HULL_MAX = 100;

/**
 * Ordinary wear, percent per SECOND. 0.25 / 60 = 0.004167.
 *
 * Authored as "a quarter of a percent a minute" and divided out, exactly as
 * `battleconstants.ts` authors `ARENA_OMEGA` from a speed: the minute figure
 * is the one a person can hold, and the per-second rate is only its
 * consequence. It is what the HUD prints, in minutes, for the same reason —
 * a wear rate in per-second prints as `-0.00`.
 *
 * A quarter of a percent a minute is 400 minutes from a fresh hull to the
 * floor, and 200 minutes to the 50% where the first cap bites. Against a day
 * that lasts 20 minutes that is a wear a player meets after a session rather
 * than during one, which is the point: the hull is a reason to call at a
 * harbour eventually, not a fuel gauge. `energy.ts` is already the fuel
 * gauge and the two must not compete.
 *
 * Real time, not sea miles. A ship at anchor in the sun wears as fast as one
 * under way — the owner chose the clock. A per-unit-travelled rate would be
 * a one-line change in `update` if that ever reads wrong.
 *
 * This is NEITHER world-scale nor ship-scale (docs/ARCHITECTURE.md, **World
 * scale**): it is a rate over a percentage, so `GLOBE_RADIUS` moving does not
 * move it. A bigger world means longer crossings and therefore a hull that
 * wears further between harbours, and that is the intended consequence rather
 * than something to compensate for here.
 */
export const HULL_WEAR = 0.25 / 60;

/**
 * What foul weather multiplies the wear by. Two.
 *
 * A flat doubling rather than a curve over the envelopes, and it never
 * stacks: storm, rain and fog together are the same 2x as any one of them
 * (decision 13). Three multiplying envelopes would put the ship at 8x in the
 * one condition a player already cannot see out of, and "the weather is
 * eating my hull" would arrive as a number nobody could predict. One factor,
 * one threshold, and the tag says `x2` — that is a rule a player can learn by
 * watching it once.
 */
export const HULL_WEATHER_GAIN = 2;

/**
 * Repair alongside a berth, percent per second. 2.0.
 *
 * DERIVED from `energy.ts`'s net shore-power rate rather than typed, because
 * the claim being made is that the hull and the tank fill at the same speed:
 * twenty seconds alongside, from empty to full, for both. Two numbers would
 * let that claim quietly stop being true the first time either was retuned,
 * and the README states it as one figure.
 *
 * That derivation is why this moved when nobody edited this file. Shore power
 * went from 2%/s to 5%/s (`energy.ts`, DOCK_FULL_SECONDS) and repair went
 * with it, which is the arrangement working rather than failing -- the whole
 * point of reading the number instead of copying it.
 *
 * `DOCK_NET_RATE` is in tank fractions per second and this is in percent per
 * second, hence the 100. Free, at any berth, and 1200 times the ordinary
 * wear: a harbour undoes eight hours of sailing in twenty seconds. That still
 * leaves the paid fix in the chandlery a convenience for mid-ocean rather
 * than the normal way to keep a hull, but the gap has narrowed -- a berth was
 * already the answer to a worn hull and is now a quicker one.
 */
export const HULL_REPAIR_RATE = DOCK_NET_RATE * 100;

/**
 * The two band edges, in percent. Below 50 the hull is worn; below 25 it is
 * failing. Both are STRICT (docs/HARBOURS_PLAN.md, Interpretations).
 *
 * Exported because `hud.ts` paints a severity modifier on the same two edges
 * and `shop.ts` prices a repair against them; a second copy of the 50 in
 * either file is a band that can drift out of step with the cap it is
 * supposed to be describing.
 */
export const HULL_WORN_BELOW = 50;
export const HULL_FAILING_BELOW = 25;

/**
 * The three speed caps, world units per second — SHIP-SCALE, the same family
 * `MAX_FORWARD` and `PropulsionState.maxForward` belong to
 * (docs/ARCHITECTURE.md, **World scale**). They are absolute speeds against a
 * fixed hull, so a bigger globe does not move them; it only makes the
 * crossing they are suffered over longer.
 *
 * 10 is exactly `MAX_FORWARD`, so a worn hull is a ship with every upgrade
 * switched off rather than a ship made slow — the player is put back in the
 * boat they started the game in, which is a boat they already know how to
 * sail. 5 is half of that: still a passage, visibly a limp. 1 is the floor
 * and is barely steerage way; it exists to make the last percent frightening
 * without ever being final.
 *
 * The caps ignore every upgrade (decision 14): `ship.ts` takes
 * `Math.min(propulsion.maxForward, speedCap)`, and `propulsion.maxForward`
 * is where both Trim & Sheathing and an Overdrive Coil already are. The wind
 * is added after the engine integrates and is NOT capped, so a gale can still
 * carry a broken ship home faster than its own engine could.
 */
export const HULL_CAP_WORN = 10;
export const HULL_CAP_FAILING = 5;
export const HULL_CAP_CRITICAL = 1;

/* ------------------------------------------------------------------ */
/* The derived table                                                   */
/* ------------------------------------------------------------------ */

/*
 * Everything but `percent` is DERIVED on every read and never stored, so
 * there is exactly one place each band edge is written down and no cached
 * copy of it to go stale after a `damage()`.
 *
 * All three are derived from the PUBLISHED PERCENT and never from the float
 * behind it, and that is load-bearing rather than incidental. The rule the
 * owner set is "under 50% the ship travels at 10 kn": with a floored percent
 * that is exactly what happens at exactly that edge — a float anywhere in
 * [49, 50) publishes 49 and is capped, a float anywhere in [50, 51)
 * publishes 50 and is not, and there is no half-percent of grace in either
 * direction. Deriving from the float instead would let a hull print 50% while
 * already capped at 10 kn for the two minutes a crossing takes, and an
 * instrument that disagrees with the ship is worse than either reading on its
 * own. So: one number in the sim, one published form of it, and one band
 * function reading that. `hud.ts` can key its severity and its tag straight
 * off `percent` and be right by construction.
 *
 * The published form is a FLOOR, for the same reason `battery.ts` floors the
 * charge it persists: a reload must never hand back more than was aboard, and
 * a hull must never round up into a speed it has not got.
 */

/** Speed ceiling for a hull at `percent`, world units/s. `Infinity` is "no ceiling". */
function capFor(percent: number): number {
  if (percent >= HULL_WORN_BELOW) return Infinity;
  if (percent >= HULL_FAILING_BELOW) return HULL_CAP_WORN;
  // The critical row is the floor itself and nothing else, so its edge is one
  // percent above `HULL_MIN` rather than a constant of its own.
  if (percent >= HULL_MIN + 1) return HULL_CAP_FAILING;
  return HULL_CAP_CRITICAL;
}

/**
 * Hits this hull can take in a fight before it loses: 3, 2 or 1
 * (decision 19). Sampled ONCE, at contact, and frozen for the length of the
 * fight — `battle.ts` copies it onto the player `Combatant` — because a
 * threshold that moved mid-fight would be a rule the player could not have
 * been told.
 */
function hitsFor(percent: number): number {
  if (percent >= HULL_WORN_BELOW) return 3;
  if (percent >= HULL_FAILING_BELOW) return 2;
  return 1;
}

/* ------------------------------------------------------------------ */
/* The stub                                                            */
/* ------------------------------------------------------------------ */

/**
 * A sound hull that nothing can move.
 *
 * `speedCap` is `Infinity` rather than `MAX_FORWARD` deliberately —
 * `ship.ts` takes `Math.min(propulsion.maxForward, speedCap)`, and a finite
 * value here would silently cap a Trim-upgraded ship at the base 10 knots.
 */
const SOUND: HullState = Object.freeze({
  percent: HULL_MAX,
  speedCap: Infinity,
  canFish: true,
  hitsToLose: 3,
  mode: 'full' as const,
  rate: 0,
});

/**
 * A hull that never wears, handed to every consumer as the default argument.
 *
 * Step 0 of docs/HARBOURS_PLAN.md published this so streams C and D could
 * compile and be screenshotted before the sim landed, and it is KEPT now that
 * it has: it is what lets `createShip`, `createFishCover` and `createFishing`
 * take their hull as an optional dependency, which in turn is what lets
 * `tests/unit/ship-physics.test.ts` and every other existing call site stay
 * exactly as they were. A caller that says nothing gets the game as it
 * shipped before durability existed.
 */
export function createStubHull(): Hull {
  return {
    state: SOUND,
    update: (): void => undefined,
    damage: (): void => undefined,
    repair: (): void => undefined,
    onChange: (): void => undefined,
    override: (): void => undefined,
  };
}

/* ------------------------------------------------------------------ */
/* The sim                                                             */
/* ------------------------------------------------------------------ */

/** A percent in [HULL_MIN, HULL_MAX]; anything that is not a number is a full hull. */
function toPercent(value: number): number {
  if (!Number.isFinite(value)) return HULL_MAX;
  if (value < HULL_MIN) return HULL_MIN;
  if (value > HULL_MAX) return HULL_MAX;
  return value;
}

/**
 * The hull, seeded from the save file's whole-percent figure.
 *
 * `initialPercent` is the file's own unit rather than a fraction, the same
 * arrangement `createBattery` keeps: `save.ts` never has to know that the sim
 * runs on a float, and this file never has to know what the file looks like.
 *
 * ## `?hull=<percent>`
 *
 * `main.ts` reads the query on the same terms as `?quality=` — parsed,
 * range-checked, and ignored if it is neither — and applies it with
 * `override(n)`, never with `damage`/`repair`. The difference is the whole
 * point of that method existing:
 *
 * - `damage`/`repair` are moves in the game. They notify, `save.ts` is
 *   subscribed, and the file is written. A dev query that wrote itself into
 *   the save would leave `?hull=1` in force on the next ordinary load, and
 *   the owner would find that out by sailing a crippled ship with no query in
 *   the URL.
 * - `override` sets the value and tells nobody, so the session runs on the
 *   query and the file on disk still holds the hull the player earned.
 *
 * It is an override for the SESSION, not a write. The one thing it cannot
 * promise is that the file will never learn the number: the first ordinary
 * wear crossing a whole percent notifies as usual and persists whatever the
 * hull is at by then. That is accepted — a screenshot station lasts seconds,
 * and the alternative is a latch that would have to be remembered to switch
 * off again.
 *
 * @param initialPercent whole percent from the save file, [HULL_MIN, 100].
 */
export function createHull(initialPercent: number = HULL_MAX): Hull {
  let value = toPercent(initialPercent);

  /**
   * The published form of the value: a whole percent, rounded DOWN.
   *
   * The one conversion in the file, called by everything that reports and by
   * the notify throttle, so `percent`, the three derived fields and the save
   * can never be reading two different roundings of the same hull. Floored
   * on `battery.ts`'s principle — never hand back more than was aboard — and
   * it cannot publish 0, because `value` is clamped to `HULL_MIN` and
   * `Math.floor(1)` is 1. A hull reading 0% would be a scuttled ship, and
   * there is no such thing here.
   */
  function percentNow(): number {
    return Math.floor(value);
  }

  /** The last published figure, and the one `onChange` is throttled against. */
  let lastPercent = percentNow();
  const subscribers = new Set<() => void>();

  /*
   * What `update` was last told. Kept because `mode` and `rate` are read at
   * any time — including before the first frame, and while the world is
   * frozen and `update` is deliberately not being called — and both are
   * questions about what the hull is DOING, which is a fact about the last
   * thing it was told rather than about its value.
   */
  let docked = false;
  let weathered = false;

  function notifyIfPersistedChanged(): void {
    const percent = percentNow();
    if (percent === lastPercent) return;
    lastPercent = percent;
    // Over a copy, the contract `battery.ts` and `wallet.ts` both keep: a
    // subscriber may drop itself from inside its own callback.
    for (const fn of Array.from(subscribers)) fn();
  }

  /**
   * The rate the value is ACTUALLY changing at, signed, percent per second.
   *
   * The truth rather than the intention, which is the rule `energy.ts` states
   * for its own rate readout: a hull sitting on the floor reads 0 rather than
   * the wear it is no longer paying, and a full hull alongside reads 0 rather
   * than the repair it cannot take. An instrument printing a figure the value
   * was not moving by would be teaching the player to distrust it.
   */
  function rateNow(): number {
    if (docked) return value >= HULL_MAX ? 0 : HULL_REPAIR_RATE;
    if (value <= HULL_MIN) return 0;
    return -HULL_WEAR * (weathered ? HULL_WEATHER_GAIN : 1);
  }

  /**
   * What the hull is doing, for the HUD to label.
   *
   * `'full'` at 100 whether docked or not, because a hull at the top is not
   * being repaired and has nothing to say beyond being full. `'repairing'`
   * beats both wear modes below that, for the same reason `update` lets
   * `docked` beat `weathered`: alongside, the weather is not what is
   * happening to the ship.
   *
   * Off the published percent like everything else the HUD reads, so the tag
   * and the figure beside it can never disagree. At this one edge the two
   * forms are the same test — a floor of 100 needs a float of 100 — but
   * writing it against the float would leave a second rounding in the file
   * for someone to change independently later.
   */
  function modeNow(): HullMode {
    if (percentNow() >= HULL_MAX) return 'full';
    if (docked) return 'repairing';
    return weathered ? 'weathering' : 'wearing';
  }

  /*
   * One object with getters, built once, rather than a fresh snapshot per
   * read or a cache rewritten in `update`. Two reasons, and they are the same
   * two `hud.ts`'s caches are written for: `ship.ts` reads `speedCap` sixty
   * times a second and a per-read allocation is a collection pause in the
   * middle of the frame loop; and a cache would have to be rewritten by
   * `damage()` and `repair()` as well as by `update`, which is three places
   * to forget instead of none.
   */
  const state: HullState = {
    get percent(): number {
      return percentNow();
    },
    get speedCap(): number {
      return capFor(percentNow());
    },
    get canFish(): boolean {
      return percentNow() >= HULL_FAILING_BELOW;
    },
    get hitsToLose(): number {
      return hitsFor(percentNow());
    },
    get mode(): HullMode {
      return modeNow();
    },
    get rate(): number {
      return rateNow();
    },
  };

  return {
    state,

    update(dt: number, nowDocked: boolean, nowWeathered: boolean): void {
      // Remembered even on a frame that advances nothing: the ship can arrive
      // at a berth on a zero-length frame, and the tag must not wait for the
      // next one to say so.
      docked = nowDocked;
      weathered = nowWeathered;
      if (!Number.isFinite(dt) || !(dt > 0)) return;

      if (nowDocked) {
        // `docked` wins over `weathered` outright rather than the two being
        // summed. At 2.0 against 0.008 a sum would be indistinguishable from
        // the repair alone, and the tag would then have to name a cause the
        // player could not see in the figure.
        value += HULL_REPAIR_RATE * dt;
      } else {
        value -= HULL_WEAR * dt * (nowWeathered ? HULL_WEATHER_GAIN : 1);
      }

      if (value > HULL_MAX) value = HULL_MAX;
      else if (value < HULL_MIN) value = HULL_MIN;
      notifyIfPersistedChanged();
    },

    damage(points: number): void {
      if (!Number.isFinite(points) || points <= 0) return;
      value = Math.max(HULL_MIN, value - points);
      notifyIfPersistedChanged();
    },

    repair(points: number): void {
      if (!Number.isFinite(points) || points <= 0) return;
      value = Math.min(HULL_MAX, value + points);
      notifyIfPersistedChanged();
    },

    onChange(fn: () => void): void {
      // No immediate call, unlike `wallet.ts` and `battery.ts`. The one
      // subscriber is `save.ts`'s `persist`, the wallet already fires it once
      // at boot, and a second write of the identical record would be a
      // `localStorage` round trip for nothing.
      subscribers.add(fn);
    },

    override(percent: number): void {
      value = toPercent(percent);
      // Deliberately silent, and `lastPercent` moves with it so the next
      // ordinary crossing is measured from where the query put the hull
      // rather than from where the save file did. See the note on `?hull=`
      // above for why this one door does not write.
      lastPercent = percentNow();
    },
  };
}
