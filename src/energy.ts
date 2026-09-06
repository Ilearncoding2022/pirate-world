import type { Dock, EnergyMode, EnergyState, ShipState, Towns } from './types';
import type { WorldEnv } from './env';
import { MAX_FORWARD } from './ship';

export interface Energy {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: EnergyState;
  /**
   * Runs before `ship.update`, so it sees last frame's speed. That is a frame
   * of lag on the burn and it is the right trade: the alternative is the ship
   * spending power it turns out not to have.
   */
  update(dt: number, ship: ShipState, env: WorldEnv): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/*
 * Every number here is written as an ENDURANCE in seconds -- the thing the
 * player actually experiences -- and the level/s rates are divided out of it.
 * Writing the rates directly and leaving the endurances in the prose beside
 * them is how the two drift apart: the same mistake `ship.ts` records under
 * MAX_FORWARD, where a hand-typed acceleration silently capped the ship at
 * 17.1 kn while the constant beside it claimed 18.
 */

/**
 * Seconds of full tank at top speed, ie. flat out at MAX_FORWARD (15.0 kn).
 *
 * A full lap of the globe is 2*PI*200 / 15 = 84 s, so 90 s is a lap and a
 * breath: enough to cross any ocean on the map at a run, not enough to keep
 * running once you are there.
 *
 * It bought a lap and a HALF while the ship still made 20 kn. The endurance
 * was deliberately left at 90 s when top speed came down rather than being
 * stretched to hold the old range, so a slower ship is a shorter-legged one
 * too. Raise this number if flat-out passages start ending in the wrong place.
 */
const FULL_SPEED_ENDURANCE = 90;

/**
 * Seconds of full tank at anchor with the panels dark, ie. the hotel load.
 *
 * `daynight.ts` runs a 1800 s day, half of it night, so 42 minutes is one
 * whole night hove to that ends on 29% rather than on empty. The margin is the
 * point: a player who anchors at dusk should wake up low and nervous, not
 * dead. Systems always draw something -- a plant that costs nothing to leave
 * running is a plant nobody bothers to recharge.
 */
const IDLE_ENDURANCE = 42 * 60;

/** Seconds from empty to full at anchor under a sun in the zenith. */
const SOLAR_FULL_SECONDS = 120;

/** Seconds from empty to full alongside a berth, before the hotel load (10.04 s after it). */
const DOCK_FULL_SECONDS = 10;

/**
 * The constant hotel load, level/s. 1 / 2520 = 0.000397.
 *
 * Drawn in every mode, under way and at rest alike, which is what makes the
 * net solar gain go negative after dark and therefore what makes a dock worth
 * sailing to.
 */
const IDLE_DRAIN = 1 / IDLE_ENDURANCE;

/**
 * Propulsion draw at top speed, level/s. 1/90 - IDLE_DRAIN = 0.010714.
 *
 * IDLE_DRAIN is subtracted rather than ignored because the burn at full
 * throttle is IDLE_DRAIN + FULL_BURN, and FULL_SPEED_ENDURANCE is a claim
 * about that sum. Typing 0.0107 beside the 90 leaves the pair free to disagree
 * the moment either one is retuned.
 *
 * It scales with (speed / MAX_FORWARD)^2, so half throttle is a quarter of the
 * propulsion draw and cruising slowly is a strategy rather than a slower way
 * to arrive equally empty. Seconds from a full tank to dry, holding a speed:
 *
 *   15.0 kn -> 90 s           7.5 kn -> 325 s (5.4 min)
 *   10.0 kn -> 194 s (3.2 min)   5.0 kn -> 630 s (10.5 min)
 *
 * Reverse burns on |speed| exactly like ahead: MAX_REVERSE is 7 kn, so full
 * astern costs 0.0027 level/s and would take about 6 minutes to empty.
 */
const FULL_BURN = 1 / FULL_SPEED_ENDURANCE - IDLE_DRAIN;

/**
 * Solar with the sun in the zenith, level/s. 1/120 + IDLE_DRAIN = 0.008730.
 *
 * IDLE_DRAIN is added back because SOLAR_FULL_SECONDS is a claim about the NET
 * climb, and the hotel load is still being paid while the panels work. The
 * gross figure alone would leave the two minutes about 6 s short.
 *
 * Yield is the sine of the sun's elevation at the ship, so the useful window
 * is much narrower than "daytime": 0.0083 net at local noon (120 s to full),
 * 0.0040 net at 30 degrees of elevation (about 4.2 min), and -0.0004 the
 * moment the sun sets. That last number is intended and is the whole shape of
 * the loop -- a ship left drifting overnight loses ground, and a berth is the
 * only fast way back.
 */
const SOLAR_PEAK = 1 / SOLAR_FULL_SECONDS + IDLE_DRAIN;

/** Shore power, level/s. 1/10 = 0.1000, so a berth refills a dead ship in 10.04 s. */
const DOCK_RATE = 1 / DOCK_FULL_SECONDS;

/**
 * Speed under which a berth will connect, world units/s (3.0 kn on the HUD).
 *
 * Not zero, because a berth that only pays out at a dead stop makes the player
 * fight STOP_EPSILON for a reward they have already sailed to; and not
 * generous either, because at 15 kn the ship crosses a whole charging zone in
 * a second or two and would collect a fifth of a tank for driving past.
 *
 * Tested against GROUND speed, and it is the only test in this file that is.
 * See the note below on the two speeds: a ship blown through a ring at 12 kn
 * with its engines stopped has `speed === 0`, and against that it would read
 * as moored, take on shore power and -- because `wind.ts` shelters whatever is
 * docked -- have the wind switched off around it mid-drift.
 */
const DOCK_SPEED_LIMIT = 3;

/*
 * The two speeds, and which one each rule here uses.
 *
 * `ship.speed` is the ENGINE. `ship.groundSpeed` is the engine plus the wind.
 * The split is deliberate and this file is where it is easiest to get wrong:
 *
 *   - The burn is on ENGINE speed, because the engines are what draw power.
 *     A tailwind therefore extends the ship's range rather than costing extra,
 *     which is what makes reading the weather worth doing.
 *   - The solar test is on ENGINE speed, so a dead ship drifting downwind
 *     still deploys its panels. That is the entire point of running out of
 *     charge in a wind: you are not stranded, you are being carried somewhere
 *     while you recover.
 *   - The berth test is on GROUND speed, so a ring cannot be collected by
 *     drifting through it.
 */

/**
 * Charge the reserve has to climb back to before the thrusters relight, level.
 *
 * The hysteresis is the whole point of the constant. Relighting at the first
 * positive level instead would spend that level on thrust inside the same
 * frame and drop straight back to empty, so the thrusters would stutter on and
 * off every single frame for as long as the panels trickled -- and `mode`
 * would strobe EMPTY/SOLAR along with them. 0.03 is 3.6 s of noon sun or 0.3 s
 * at a berth: long enough to read as a restart, short enough not to feel like
 * a punishment.
 */
const RESTART_LEVEL = 0.03;

/* ------------------------------------------------------------------ */
/* Energy                                                              */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only EnergyState surface. */
interface MutableEnergyState {
  level: number;
  rate: number;
  mode: EnergyMode;
  dock: Dock | null;
  canThrust: boolean;
}

/**
 * The ship's power plant: burn against speed, solar at anchor, fast charge at a
 * berth, and dead in the water when it runs out.
 *
 * One object, mutated in place for the life of the run. The HUD, `docks.ts`,
 * `ship.ts`'s thrust gate and the model's neon all hold this same reference, so
 * reassigning it -- or handing out a copy -- would leave them reading a tank
 * that had stopped moving.
 */
export function createEnergy(towns: Towns): Energy {
  const state: MutableEnergyState = {
    level: 1,
    rate: 0,
    mode: 'drain',
    dock: null,
    canThrust: true,
  };

  function update(dt: number, ship: ShipState, env: WorldEnv): void {
    // A frame that advanced no time moves no charge. Returning leaves the last
    // true reading standing; falling through would rewrite `rate` to a 0 the
    // HUD prints for a frame, which reads as a hiccup in the plant.
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    const speed = Math.abs(ship.speed);

    // Quadratic, so doubling the speed quadruples the propulsion draw. Note it
    // is the *committed* speed and not the throttle: a ship coasting down from
    // full ahead is still moving water and is still paying for it.
    const speedFrac = speed / MAX_FORWARD;
    const burn = IDLE_DRAIN + FULL_BURN * speedFrac * speedFrac;

    // A berth overrides the panels rather than stacking with them. Shore power
    // is eleven times the best the sun ever manages, so the sum would beat the
    // berth alone by well under a second over a whole charge -- invisible, and
    // it would make the rate on the HUD unreadable back to a single cause.
    const berth = towns.dockAt(ship.position);
    const docked = berth !== null && Math.abs(ship.groundSpeed) < DOCK_SPEED_LIMIT;

    let charge = 0;
    if (docked) {
      charge = DOCK_RATE;
    } else if (ship.speed === 0) {
      // Sine of the sun's elevation where the ship actually *is*: nothing at
      // night, weak at dawn and dusk, best at local noon. It is the same dot
      // product every shader in the world uses, so the panels and the lit
      // hemisphere can never disagree about whether it is day here.
      //
      // The exact zero test is safe because `ship.ts` snaps anything under
      // STOP_EPSILON to a dead stop. Inventing a second epsilon here would
      // give the game two different definitions of "stopped" to keep in sync,
      // and the panels would light while the hull was still visibly making way.
      charge = SOLAR_PEAK * Math.max(0, ship.up.dot(env.sunDirection));
    }

    const before = state.level;
    let level = before + (charge - burn) * dt;
    if (level < 0) level = 0;
    else if (level > 1) level = 1;
    state.level = level;

    // The truth, not the intention. Derived from the level actually committed,
    // so a full tank in the sun reads 0.0 rather than the charge it cannot
    // take, and a tank hitting the floor reads only the part of the burn it
    // could still pay for. The HUD prints this number.
    state.rate = (level - before) / dt;

    // Hysteresis: dry at 0, no thrust again until RESTART_LEVEL. See that
    // constant for the per-frame stutter this avoids.
    if (level <= 0) state.canThrust = false;
    else if (level >= RESTART_LEVEL) state.canThrust = true;

    state.dock = docked ? berth : null;

    // `empty` outranks everything, a berth included: while the first percent
    // trickles back the plant is still refusing thrust, and a tag that flipped
    // to SOLAR the instant the level left zero would be lying about the one
    // thing the player needs to know.
    if (!state.canThrust) state.mode = 'empty';
    else if (docked) state.mode = 'docked';
    else if (state.rate >= 0) state.mode = 'solar';
    else state.mode = 'drain';
  }

  return { state: state as EnergyState, update };
}
