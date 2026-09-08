import type { Dock, EnergyMode, EnergyState, ShipState, Towns, WeatherState } from './types';
import type { WorldEnv } from './env';
import type { Battery } from './battery';
import { MAX_FORWARD } from './ship';
import { OVERDRIVE_BURN_MULTIPLIER } from './overdrive';

export interface Energy {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: EnergyState;
  /**
   * Runs before `ship.update`, so it sees last frame's speed. That is a frame
   * of lag on the burn and it is the right trade: the alternative is the ship
   * spending power it turns out not to have.
   *
   * `overdriveActive` and `moonNightFraction` are `main.ts`'s per-frame read
   * of two Navigation offers, both optional and both defaulting to "not
   * bought": an Overdrive Coil bills a flat multiple of `FULL_BURN` for the
   * whole window rather than the ordinary speed-squared curve (see
   * `overdrive.ts`), and a Moonglass Array's tier is the share of
   * `SOLAR_PEAK` it reaches at night, off `env.moonIllumination` (see
   * `moonglass.ts`).
   */
  update(
    dt: number,
    ship: ShipState,
    env: WorldEnv,
    overdriveActive?: boolean,
    moonNightFraction?: number,
    weather?: WeatherState,
  ): void;
  /**
   * Takes `level` off the plant in one go, if it is there to take.
   *
   * Returns whether it was spent, so a caller cannot half-buy anything: the
   * fishing card charges 50% of the tank and must not open on a refusal.
   *
   * It draws the main tank down first and reaches the backup cell only once
   * the main tank is at zero — the same order the per-frame burn uses, and the
   * order the cell is sold under. A player on 20% with a full cell can
   * therefore still buy a session, and pays for it with the last of the tank
   * plus 30% of the backup.
   *
   * `rate` and `mode` are deliberately NOT touched here. They describe the
   * plant over the last frame and this is not the plant — it is a withdrawal.
   * The next `update` recomputes both, and the one frame in which the HUD
   * shows a stale rate beside a halved bar is the frame the overlay is
   * covering the HUD anyway.
   */
  spend(level: number): boolean;
  /**
   * Takes the hull's loss when a maelstrom has eaten it: the main tank keeps
   * WRECK_KEEP of whatever it held, and nothing else in the world changes.
   *
   * The backup cell is untouched on purpose — it was bought with gold and is
   * the one charge in the game nothing recharges, so sinking it would be
   * confiscating a purchase rather than costing a mistake. Gold, the fish book
   * and the harpoon locker are untouched for the same reason.
   *
   * `rate` and `mode` are not touched either, exactly as `spend` leaves them:
   * they describe the plant over the last frame, and this is not the plant. A
   * tank already at zero stays at zero, and the RESTART_LEVEL hysteresis is
   * unaffected — a wreck can only ever move the level down.
   */
  wreck(): void;
  /**
   * Takes the hull's loss when an AI boat has won the cannon fight.
   *
   * The main tank goes to ZERO, and the backup cell — which a wreck leaves
   * alone because it was bought with gold — is drawn down here too, because a
   * defeat is not weather: it is another captain taking what the ship had. A
   * cell holding more than DEFEAT_KEEP_ABOVE is left on DEFEAT_KEEP, and one
   * at or below it is emptied outright, so the consolation exists only for a
   * player who had genuinely invested in the cell.
   *
   * `rate` and `mode` are untouched, exactly as `spend` and `wreck` leave
   * them: they describe the plant over the last frame and this is not the
   * plant. Gold is not this module's to take — see `bounty.ts`.
   */
  defeat(): void;
  /**
   * Takes a draw's bruise: STALEMATE_COST off the main tank, floored at zero,
   * and nothing else. Percentage POINTS off the bar, not a share of what was
   * held — a wreck keeps a fraction, a stand-off costs a fixed amount.
   */
  stalemate(): void;
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
 * 42 minutes. It was set against an 1800 s night, which it outlasted by a
 * margin -- a player who anchored at dusk woke up on 29% rather than dead --
 * and `daynight.ts` has since cut the night to 600 s. The endurance was
 * deliberately left where it was rather than shortened to hold the old
 * squeeze, so a night hove to now costs about 24% and ends around 76%.
 *
 * That is a real loosening and it is the one to reach for first if drifting
 * overnight stops being a decision. Systems always draw something -- a plant
 * that costs nothing to leave running is a plant nobody bothers to recharge --
 * but the draw only bites while the night is long enough to feel it.
 */
const IDLE_ENDURANCE = 42 * 60;

/**
 * Seconds from empty to full at anchor under a sun in the zenith.
 *
 * 200 s, so the net climb under a zenith sun is exactly **0.5% of the tank per
 * second** -- the figure the HUD prints and the player watches. NET, not
 * gross: the hotel load is still being paid while the panels work, and
 * SOLAR_PEAK below adds it back so this stays a claim about what is seen.
 *
 * The useful window is much narrower than "daytime", because yield is the sine
 * of the sun's elevation: 3 min 20 s to full at local noon, about 7 min 15 s at
 * 30 degrees of elevation, and a net loss the moment the sun sets. Drifting is
 * not a way to fill the tank; it is a way to not quite empty it.
 */
const SOLAR_FULL_SECONDS = 200;

/**
 * Seconds from empty to full alongside a berth.
 *
 * 50 s, so shore power nets exactly **2% of the tank per second**. NET, like
 * SOLAR_FULL_SECONDS and for the same reason: DOCK_RATE below adds the hotel
 * load back, so this is the number the HUD prints rather than a gross yield
 * the player never sees.
 *
 * A berth remains far and away the fastest charge in the world, four times the
 * best the sun ever manages, but it is a stop measured in tens of seconds
 * rather than a tap of the brakes, so when to break a passage is a real
 * choice.
 */
const DOCK_FULL_SECONDS = 50;

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
 * The Overdrive Coil's flat propulsion draw, level/s, while it burns.
 *
 * `overdrive.ts`: "an escape that costs the fuel to get home is still a
 * decision." `OVERDRIVE_BURN_MULTIPLIER` (4) times `FULL_BURN` rather than
 * the ordinary `speedFrac^2` curve continued out to 16 kn — a flat rate
 * charged for the whole window whether or not the ship is actually holding
 * 16 kn, because the coil is being fed regardless of how fast the hull
 * happens to be moving at any one instant of it.
 */
const OVERDRIVE_BURN = OVERDRIVE_BURN_MULTIPLIER * FULL_BURN;

/**
 * Solar with the sun in the zenith, level/s. 1/185 + IDLE_DRAIN = 0.005802.
 *
 * IDLE_DRAIN is added back because SOLAR_FULL_SECONDS is a claim about the NET
 * climb, and the hotel load is still being paid while the panels work. The
 * gross figure alone would leave the two minutes about 6 s short.
 *
 * Yield is the sine of the sun's elevation at the ship, so the useful window
 * is much narrower than "daytime": 0.0050 net at local noon (200 s to full),
 * 0.0023 net at 30 degrees of elevation (about 7.3 min), and -0.0004 the
 * moment the sun sets. That last number is intended and is the whole shape of
 * the loop -- a ship left drifting overnight loses ground, and a berth is the
 * only fast way back.
 */
const SOLAR_PEAK = 1 / SOLAR_FULL_SECONDS + IDLE_DRAIN;

/**
 * Shore power, level/s, gross.
 *
 * IDLE_DRAIN is added back for the same reason SOLAR_PEAK adds it: the hotel
 * load is drawn alongside the berth as it is everywhere else, so a gross
 * 1/DOCK_FULL_SECONDS would net slightly under the figure that constant
 * claims. 1/50 + 0.000397 = 0.020397 gross, which nets exactly 0.0200 -- the
 * 2%/s the HUD reads alongside.
 */
const DOCK_RATE = 1 / DOCK_FULL_SECONDS + IDLE_DRAIN;

/**
 * Seconds the ship has to stay inside a berth's ring before it connects.
 *
 * This replaced a speed limit, and it enforces the same rule in the terms the
 * player can actually see. The old test asked "are you under 3 kn": true of a
 * ship that had stopped, but also true of one drifting quietly across the ring
 * on the wind, and false of one that had genuinely arrived and not yet lost
 * way. A dwell asks the question the ring is drawn to ask -- are you staying?
 *
 * Two seconds is the number because of what it excludes. The zone is 16 units
 * across, so at 15 kn a straight run through it lasts 1.07 s and at 10 kn
 * 1.6 s: nothing on a passage can collect a berth by crossing it, which is the
 * whole job the speed limit was doing. Anything slower than about 8 kn can
 * dwell, drifting included, and that is deliberate -- being blown into harbour
 * and moored is an arrival, not an exploit, and `wind.ts` shelters what is
 * docked so the drift ends there anyway.
 *
 * Timed against wall clock rather than distance, so a ship holding station
 * inside the ring qualifies however it is holding it.
 */
const DOCK_DWELL_SECONDS = 2;

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
 *   - The berth test is on NEITHER any more. It is a dwell: see
 *     DOCK_DWELL_SECONDS. A ring cannot be collected by crossing it because
 *     crossing it does not take two seconds, which is the same protection the
 *     old ground-speed test gave without having to pick between the two
 *     speeds at all.
 */

/**
 * Charge the plant has to climb back to before the thrusters relight, level.
 *
 * The hysteresis is the whole point of the constant. Relighting at the first
 * positive level instead would spend that level on thrust inside the same
 * frame and drop straight back to empty, so the thrusters would stutter on and
 * off every single frame for as long as the panels trickled -- and `mode`
 * would strobe EMPTY/SOLAR along with them. 0.03 is 6 s of noon sun or 1.5 s
 * at a berth: long enough to read as a restart, short enough not to feel like
 * a punishment.
 *
 * Tested against main tank PLUS backup cell, so a ship that runs its tank dry
 * with a cell aboard never stops at all — it changes which tank it is drinking
 * from, and the HUD says so.
 */
const RESTART_LEVEL = 0.03;

/**
 * What is left in the main tank after a shipwreck: a quarter of it.
 *
 * 80% becomes 20%; a full tank becomes 22 s of running at top speed out of the
 * 90 s ENDURANCE_SECONDS buys. Written as the fraction KEPT rather than the
 * fraction lost because that is the reading the player takes off the bar the
 * moment the screen comes back: three quarters gone is a real setback and a
 * long sail to the nearest berth, and a total loss on top of a teleport to
 * somewhere unfamiliar would be a run ended rather than a run damaged.
 */
const WRECK_KEEP = 0.25;

/**
 * The charge a backup cell has to be holding for a defeat to leave any of it.
 *
 * A fifth of a main tank, which is 40% of a full cell. Below that the cell is
 * emptied outright, and the reason is the same one WRECK_KEEP is written as a
 * fraction KEPT: the consolation has to be legible as a consolation. A player
 * who had genuinely invested in the cell walks away with something to sail on;
 * a player who was already down to the dregs of it walks away with the dregs
 * rounded off, which is a cleaner reading than a tenth of a tenth.
 */
const DEFEAT_KEEP_ABOVE = 0.2;

/**
 * What is left in the cell after a defeat that qualifies: a tenth of a main
 * tank, a fifth of a full cell.
 *
 * 10% is 20 s of running at top speed, or 4 minutes hove to. Enough to reach a
 * berth that is already in sight and not enough to carry on as if nothing had
 * happened, which is the whole shape of losing a fight: it is a setback, and
 * the walk home is the cost of it.
 *
 * Exported because `battleui.ts`'s result card prints the cell that is
 * actually left rather than this number; the export exists so the card and the
 * rule can be read side by side, not so the card can restate the constant.
 */
export const DEFEAT_KEEP = 0.1;

/**
 * What a stand-off costs the main tank: 25 percentage POINTS of the bar the
 * HUD shows, floored at zero, not a quarter of whatever was held.
 *
 * The asymmetry with WRECK_KEEP is deliberate and is the difference between
 * the two events. A wreck keeps a FRACTION, so it hurts most at full and
 * cannot quite finish a ship that was already nearly dry. A draw costs a FIXED
 * amount, so it is the same bruise whatever the tank held: a full ship shrugs
 * it off and a ship on 20% is put on the floor by it, which is what makes
 * taking a fight on a low tank a decision rather than a formality.
 *
 * Exported so `battleui.ts` can print the figure it charged instead of typing
 * a second 25 into the result card.
 */
export const STALEMATE_COST = 0.25;

/**
 * How much of a storm's and a fog bank's darkness the panels lose.
 *
 * Harsh, and deliberately so: at 0.95 a full storm is 5% of a clear noon,
 * which makes a storm a power problem rather than a change of scenery, and
 * makes a berth worth running for. Fog costs half -- a bank is bright grey
 * from above and the panels do see SOMETHING through it.
 *
 * ## Why this cannot strand a player
 *
 * The question a harsh number like this has to answer is whether a ship can
 * be caught under permanent cloud with an empty tank and no way out. It
 * cannot, and the bound comes from two places at once:
 *
 *  - A SQUALL is a subset of a wind event, and `wind.ts` caps an event at
 *    `EVENT_MAX` = 30 s. Thirty seconds of no charge costs 15% of
 *    `SOLAR_FULL_SECONDS`, and the lull that follows is guaranteed.
 *  - A CELL is bounded twice over. Its own `strength` fades to nothing at the
 *    end of a life of at most six minutes, and it drifts at 2 units per
 *    second while a ship at rest does not, so even a dead hull is clear of a
 *    40-unit storm within about 40 seconds of its centre passing.
 *
 * Against `IDLE_ENDURANCE` of 42 minutes, neither is close to dangerous. No
 * floor is needed here, and adding one would only hide the two bounds above
 * from whoever next changes them.
 */
const STORM_SOLAR_CUT = 0.95;
const FOG_SOLAR_CUT = 0.5;

/**
 * The share of a clear sky's output below which the panel says OVERCAST
 * rather than SOLAR CHARGING.
 *
 * Two thirds. It is a threshold on `solarKeep` and NOT on the rate, and that
 * is the whole care in it: a low winter sun on a clear afternoon makes a
 * small rate too, and calling that overcast would be a second lie in place of
 * the first. This asks only "is the weather taking a third of what the sky
 * would otherwise be worth", which is a question about the sky.
 *
 * At the cuts above, a storm passes it at a third of full strength and a fog
 * bank at two thirds -- so the tag turns over while the weather is arriving
 * rather than once it has already settled on the ship.
 */
const OVERCAST_KEEP = 2 / 3;

/** The share of the panels' output the weather leaves. 1 in clear weather, exactly. */
function solarKeep(weather?: WeatherState): number {
  if (!weather) return 1;
  return (1 - STORM_SOLAR_CUT * weather.storm) * (1 - FOG_SOLAR_CUT * weather.fog);
}

/* ------------------------------------------------------------------ */
/* Energy                                                              */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only EnergyState surface. */
interface MutableEnergyState {
  level: number;
  reserve: number;
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
export function createEnergy(towns: Towns, battery: Battery): Energy {
  const state: MutableEnergyState = {
    level: 1,
    reserve: battery.level,
    rate: 0,
    mode: 'hotel',
    dock: null,
    canThrust: true,
  };

  /** Seconds spent continuously inside `dwellBerth`. See DOCK_DWELL_SECONDS. */
  let dwell = 0;
  /** The ring the clock is counting for, or null when the ship is in none. */
  let dwellBerth: Dock | null = null;

  function update(
    dt: number,
    ship: ShipState,
    env: WorldEnv,
    overdriveActive = false,
    moonNightFraction = 0,
    weather?: WeatherState,
  ): void {
    // A frame that advanced no time moves no charge. Returning leaves the last
    // true reading standing; falling through would rewrite `rate` to a 0 the
    // HUD prints for a frame, which reads as a hiccup in the plant.
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    const speed = Math.abs(ship.speed);

    // Quadratic, so doubling the speed quadruples the propulsion draw. Note it
    // is the *committed* speed and not the throttle: a ship coasting down from
    // full ahead is still moving water and is still paying for it.
    //
    // An Overdrive Coil replaces this curve outright rather than extending it
    // past 1.0 -- see OVERDRIVE_BURN's own comment for why the bill is flat
    // for the whole window instead of tracking the instantaneous speed.
    const speedFrac = speed / MAX_FORWARD;
    const burn = overdriveActive
      ? IDLE_DRAIN + OVERDRIVE_BURN
      : IDLE_DRAIN + FULL_BURN * speedFrac * speedFrac;

    // A berth overrides the panels rather than stacking with them. Shore power
    // is over four times the best the sun ever manages, so the sum would beat
    // the berth alone by a couple of seconds over a whole charge -- and it
    // would make the rate on the HUD unreadable back to a single cause.
    // The dwell clock. It counts only while the ship is inside one particular
    // ring, and it is the identity of the berth that is tracked rather than
    // merely "inside something": two zones cannot overlap (`towns.ts` rejects
    // a berth that would), so leaving one and entering another is a new
    // arrival and starts the two seconds again.
    const berth = towns.dockAt(ship.position);
    if (berth === null || berth !== dwellBerth) {
      dwellBerth = berth;
      dwell = 0;
    }
    if (berth !== null) dwell += dt;
    const docked = berth !== null && dwell >= DOCK_DWELL_SECONDS;

    let charge = 0;
    /**
     * Whether the charge below is the sun's doing rather than the moon's.
     *
     * Hoisted out of the block that decides it purely so the mode ladder can
     * tell SOLAR from MOONGLASS. Recomputing the dot product down there would
     * give the file two answers to the same question, which is exactly the
     * split the panels and the shaders are kept out of.
     */
    let sunUp = false;
    /**
     * The share of a clear sky the weather left, for the mode ladder alone.
     *
     * `solarKeep` is called once and its answer kept, rather than asked again
     * down there: two calls could disagree the frame the weather turns over,
     * and the panel would name a cause the charge above did not come from.
     */
    let weatherKeep = 1;
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
      const sunElevation = ship.up.dot(env.sunDirection);
      sunUp = sunElevation > 0;
      weatherKeep = solarKeep(weather);
      charge = SOLAR_PEAK * Math.max(0, sunElevation) * weatherKeep;

      // A Moonglass Array's own tier fraction of SOLAR_PEAK, gated to hours
      // the sun contributes nothing at all -- see `moonglass.ts`. Added
      // rather than left to compete with the sun, because the two can never
      // both be positive: `sunElevation` is non-positive exactly when this
      // fires.
      if (sunElevation <= 0 && moonNightFraction > 0) {
        // Cut by the same factor: a Moonglass Array under a storm sees no
        // moon either. Left uncut, a night storm would be a BETTER place to
        // charge than a day one, which is a strange thing for a game to teach.
        charge += SOLAR_PEAK * moonNightFraction * env.moonIllumination * solarKeep(weather);
      }
    }

    const before = state.level;
    let level = before + (charge - burn) * dt;

    // What the main tank could not pay for comes out of the backup cell, and
    // ONLY then -- which is the whole rule the cell is sold under. Note the
    // charge side never reaches it: shore power and the panels write `level`,
    // so a bought cell is spent for good and no berth will put it back.
    let fromReserve = 0;
    if (level < 0) {
      fromReserve = battery.draw(-level);
      level = 0;
    } else if (level > 1) level = 1;
    state.level = level;
    state.reserve = battery.level;

    // The truth, not the intention. Derived from what was actually committed,
    // so a full tank in the sun reads 0.0 rather than the charge it cannot
    // take, and a tank hitting the floor reads only the part of the burn it
    // could still pay for. Over the TOTAL of both tanks, so a ship running on
    // its cell reads the burn it is really paying instead of the +0.00 %/s a
    // pinned `level` would show. The HUD prints this number.
    state.rate = (level - before - fromReserve) / dt;

    // Hysteresis: dry at 0, no thrust again until RESTART_LEVEL. See that
    // constant for the per-frame stutter this avoids. Both tanks count, so a
    // cell aboard is the difference between coasting and carrying on.
    const available = level + battery.level;
    if (available <= 0) state.canThrust = false;
    else if (available >= RESTART_LEVEL) state.canThrust = true;

    state.dock = docked ? berth : null;

    /*
     * The mode ladder. Precedence, not a list -- see EnergyMode in `types.ts`
     * for what each name means and why there are ten of them.
     *
     * No thrust outranks everything, a berth included: while the first percent
     * trickles back the plant is still refusing to move the ship, and a tag
     * that flipped to SOLAR the instant the level left zero would be lying
     * about the one thing the player needs to know. The two halves of it are
     * split on the rate, because "adrift in the dark" and "panels up, helm
     * back in a few seconds" are the same predicament only on paper.
     *
     * `docked` comes next and is deliberately unconditional: five modules test
     * it as the single definition of being at a berth, so nothing may shadow
     * it while shore power is connected.
     *
     * `reserve` then outranks both burns, because it is the reading that
     * cannot be undone. A ship drifting at night on its cell is technically
     * doing what a drifting ship always does, and calling that a burn would
     * let a bought battery empty itself without the panel ever saying which
     * tank was going down.
     *
     * `overdrive` sits above `burn` for the same reason in reverse: the coil
     * bills a flat four times the full-speed draw whatever the hull is
     * actually doing, so reading it as an ordinary burn would leave the
     * player to explain a rate the speed does not account for.
     *
     * `mooring` sits BELOW `burn` on purpose. The dwell clock counts whatever
     * the hull is doing, drifting arrivals included, but a ship motoring
     * through the ring is burning and calling that CONNECTING would be the
     * same class of lie the old EMPTY tag told.
     */
    if (!state.canThrust) state.mode = state.rate > 0 ? 'restart' : 'dead';
    else if (docked) state.mode = 'docked';
    else if (fromReserve > 0) state.mode = 'reserve';
    else if (overdriveActive) state.mode = 'overdrive';
    else if (ship.speed !== 0) state.mode = 'burn';
    else if (berth !== null) state.mode = 'mooring';
    else if (charge > 0) {
      // Sun, moon, or a sun the weather is standing in front of. The overcast
      // rung sits inside the sunlit branch and not beside it, because a
      // Moonglass Array under a storm is still charging off the moon -- it is
      // cut by the same factor, and MOONGLASS is the cause either way.
      if (!sunUp) state.mode = 'moon';
      else state.mode = weatherKeep < OVERCAST_KEEP ? 'overcast' : 'solar';
    }
    else state.mode = 'hotel';
  }

  /**
   * See `Energy.spend`. The floor is a hard refusal rather than a partial
   * draw: a session bought with half the power it costs is not a session.
   *
   * The affordability test is on both tanks together and the withdrawal is
   * main-first, so the refusal and the order can never disagree about what was
   * available.
   */
  function spend(level: number): boolean {
    if (!(level > 0) || state.level + battery.level < level) return false;
    const fromMain = Math.min(state.level, level);
    state.level -= fromMain;
    // Clamp the arithmetic, not the rule. The test above already guarantees a
    // non-negative result; this only keeps a float's last bit from printing a
    // tank of -0.0000001 on the HUD.
    if (state.level < 0) state.level = 0;
    const rest = level - fromMain;
    if (rest > 0) battery.draw(rest);
    state.reserve = battery.level;
    return true;
  }

  /** See `Energy.wreck`. One multiplication, and deliberately nothing else. */
  function wreck(): void {
    state.level *= WRECK_KEEP;
  }

  /**
   * See `Energy.defeat`. The main tank, and then the cell the wreck spares.
   *
   * The cell is drawn down through `battery.draw` rather than through a setter
   * this file would have to add, and that is not a style preference: `draw` is
   * what notifies the cell's subscribers, and the only subscriber is the save
   * file. A defeat written straight into `battery.level` would leave the run
   * playing on a cell the reload puts back.
   *
   * `draw` takes what it can and reports it, so the shortfall case needs no
   * test of its own here: asking for more than the cell holds empties it,
   * which is exactly what the below-the-threshold branch wants.
   */
  function defeat(): void {
    state.level = 0;
    // What the raider leaves behind, which is nothing at all unless the cell
    // was carrying a real charge. Written as the amount KEPT and subtracted,
    // so the two branches differ by one number rather than by two code paths.
    const keep = battery.level > DEFEAT_KEEP_ABOVE ? DEFEAT_KEEP : 0;
    battery.draw(battery.level - keep);
    state.reserve = battery.level;
  }

  /**
   * See `Energy.stalemate`. One subtraction and a floor, and nothing else.
   *
   * The floor is the rule and not float dust: a stand-off on 10% takes the
   * ship to zero rather than to -15%, and a negative tank would put the HUD's
   * bar off the bottom of its own track and `canThrust` into a state no
   * charge could climb out of.
   */
  function stalemate(): void {
    state.level = Math.max(0, state.level - STALEMATE_COST);
  }

  return { state: state as EnergyState, update, spend, wreck, defeat, stalemate };
}
