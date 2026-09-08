import { Vector3 } from 'three';
import { createNoise2D } from 'simplex-noise';
import type { EnergyState, ShipState, Terrain, WindState } from './types';
import type { HeightMap } from './heightmap';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { mulberry32 } from './towns';

export interface Wind {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: WindState;
  /**
   * Runs after `energy.update` and before `ship.update`. After energy because
   * the berth verdict it shelters behind is this frame's; before the ship
   * because the ship spends the push this writes.
   *
   * `stormLift` is `CellsState.stormAtShip`, 0..1, and is why `weathercells.ts`
   * runs BEFORE this in the loop: a storm cell floors the wind so that a storm
   * always blows. Defaulted, so every caller that does not know about weather
   * -- every existing test among them -- gets exactly the wind it had.
   */
  update(dt: number, ship: ShipState, energy: EnergyState, stormLift?: number): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * Wind speed caps at the shore and in the open sea, world units/s, which
 * `hud.ts` reads out as 5.2 and 10.4 kn.
 *
 * Both are 35% off the 8 and 16 this was authored at, taken together rather
 * than singly so the exact-double ratio survives -- that ratio matters more
 * than either number: the open ocean is where the wind is worth having and the
 * coast is where it stays survivable.
 *
 * The cut lands on a hull that lost a third of its own top speed at the same
 * time, so the balance the system was tuned for is roughly intact: the ocean
 * push is 0.35 x 10.4 = 3.6 kn against a MAX_FORWARD of 10, still better than
 * a third of the engine. Crossing an ocean downwind remains a different
 * journey from crossing it upwind -- which is the whole reason for the system
 * -- without the weather ever being the larger half of how fast the ship is
 * going.
 */
export const COAST_CAP = 5.2;
export const OCEAN_CAP = 10.4;

/**
 * Distance offshore, world units, at which the cap reaches OCEAN_CAP.
 *
 * The ramp between the two caps is linear over this, so there is no line to
 * cross: standing out from a coast, the wind builds. 40 units is a fifth of
 * the globe radius and about seven hull lengths, so a player leaving a berth
 * feels it come on over several seconds rather than the instant they clear
 * the ring.
 */
export const OPEN_SEA_DISTANCE = 40;

/**
 * Knots added to the wind before the SEA reads it. Appearance only.
 *
 * The sea is drawn as though it were blowing four knots harder than it is, so
 * the 1 kn lull that `LULL_SPEED` guarantees looks like a 5 kn breeze, 2 looks
 * like 6, and so on. It moves nothing else: the hull's push, the SPEED and
 * WIND readouts, the scope's arrow, the flag and the sail all still read the
 * true `WindState.speed`. Only how the water LOOKS is shifted, which is what
 * was asked for -- the old lull was a plate of glass, and the sea spent most
 * of its time near the bottom of a curve that puts most of its height in the
 * top quarter.
 *
 * **It saturates.** Strength is clamped to 1, so once the true wind passes
 * `OCEAN_CAP - SEA_WIND_BIAS` -- 6.4 kn offshore -- the sea is already at full
 * height and blowing harder does not change it. Above that the water stops
 * being a reading of the weather. That is inherent in "shift the curve
 * right" and is the price of the lull looking alive; if the top of the range
 * needs to separate again, the fix is to rescale the mapping rather than to
 * shift it, and this constant is where that argument starts.
 *
 * Exported and read by BOTH `water.ts` (what is drawn) and `ship.ts` (what the
 * hull rides) through `seaWindStrength`. Those two files keep deliberate
 * copies of the height law itself -- see `HULL_CALM_INTENSITY` -- but the bias
 * is single-sourced, because a hull riding a calmer sea than the one on screen
 * is exactly the desync that duplication invites.
 */
export const SEA_WIND_BIAS = 4;

/**
 * The wind as the sea sees it: 0 at a dead calm, 1 at a full gale.
 *
 * The one place `SEA_WIND_BIAS` is applied and the one place the result is
 * clamped, so the shader and the hull cannot disagree about either.
 */
export function seaWindStrength(windSpeed: number): number {
  return Math.min(1, Math.max(0, (windSpeed + SEA_WIND_BIAS) / OCEAN_CAP));
}

/** Event and lull durations, seconds. Drawn uniformly from each band. */
const EVENT_MIN = 5;
const EVENT_MAX = 30;
const LULL_MIN = 3;
const LULL_MAX = 15;

/**
 * The floor under the wind, world units/s, which `hud.ts` reads out as 1 kn.
 *
 * The weather used to stop dead between events and the panel said CALM for
 * anything up to fifteen seconds at a time. It does not any more: there is
 * always a wind, it is always going somewhere, and the quiet part of the
 * cycle is a LULL rather than a calm.
 *
 * One knot is deliberately the smallest thing the HUD can print. It is a
 * tenth of the ocean cap and 0.35 of it reaches the hull, so it moves a
 * drifting ship about a third of a knot -- felt over a minute, invisible over
 * a second. What it buys is that nothing downstream ever has to special-case
 * a wind that is not blowing: the arrow always points somewhere real, the sea
 * always has a direction to run in, and a wave always has a way to travel.
 *
 * It is applied as a FLOOR rather than as an offset, so the top of the range
 * is exactly where it was and only the bottom moved.
 */
export const LULL_SPEED = 1.0;

/**
 * The share of its own cap the wind is floored at inside a full storm cell.
 *
 * A storm has to blow, and `weathercells.ts` rolls its cells without asking
 * the wind what phase it is in, so the two have to be reconciled somewhere.
 * Here, and as a floor: 0.8 of the cap is a gale by any reading -- 8.3 kn
 * offshore against the 10.4 the wind can reach at all -- while leaving the
 * gust envelope free to put the wind ABOVE it, so a storm cell during a
 * strong event is still stronger than one during a lull.
 *
 * Not 1.0 deliberately. At the cap the sea saturates (`SEA_WIND_BIAS`) and
 * every storm would look and sail identically; a little under it, the wind
 * inside a cell still has somewhere to go.
 */
export const CELL_WIND_LIFT = 0.8;

/**
 * Seconds an event spends ramping in, and again ramping out.
 *
 * Clamped to a quarter of the event's own duration below, which is not a
 * detail: a 5 s event with a flat 2 s fade at each end spends four of its five
 * seconds in transit and never once reaches its cap, so the short half of the
 * EVENT_MIN..EVENT_MAX band would produce nothing the player could feel.
 */
const FADE = 2;

/**
 * Floor of the gust envelope, as a fraction of the cap.
 *
 * The gust noise varies the strength *within* an event, so that a steady 10.4
 * kn does not read as a switch being held down. It must not be free to reach
 * zero: a wind that dies in the middle of its own event and then comes back is
 * a bug report, not weather. 0.55 keeps the quiet part of a gust clearly a
 * wind.
 */
const GUST_FLOOR = 0.55;

/**
 * Noise units per second along the gust curve. 1 / 0.25 = a feature every 4 s.
 *
 * Slow enough that a gust is something the ship rides rather than a flutter on
 * the HUD, fast enough that even a 5 s event breathes once.
 */
const GUST_RATE = 0.25;

/**
 * Fraction of the wind's speed that reaches the hull as ground velocity.
 *
 * The rule the whole system is tuned around: 8 kn of engine under a 10 kn
 * tailwind makes 8 + 0.35 x 10 = 11.5 kn over the ground. Well below 1 because
 * a hull is not a leaf, and still enough that the wind is worth planning a
 * crossing around.
 *
 * Flat out downwind under the ocean cap the ship makes 10 + 0.35 x 10.4 = 13.6
 * kn over the ground, so the weather is worth a third again on top of the
 * engine at its very best and rather less than that in the ordinary case. The
 * engine stays the thing the player is steering; the wind is a hand on it.
 */
const WIND_GRIP = 0.35;

/**
 * Time constant, seconds, on the applied push.
 *
 * The sector table below is deliberately coarse, and coarse means the target
 * push jumps the moment the ship's heading crosses a boundary. Adjacent
 * entries are 0.765 apart, so at the ocean cap that is 0.35 x 10.4 x 0.765 =
 * 2.8 kn of velocity appearing within one frame, and the hull visibly snaps.
 * Easing spreads it over about a third of a second. The
 * accepted consequence is that mid-transition the push is briefly not exactly
 * one of the eight table values; nothing downstream assumes it is.
 *
 * Same damping form as `bankRoll` in `ship.ts`: 1 - exp(-dt / tau).
 */
const PUSH_TAU = 0.3;

/**
 * How often the coast probe runs, Hz.
 *
 * 80 height-map reads a quarter-second is nothing; 80 every frame, for a
 * number that changes over tens of seconds, would be waste. The smoothing
 * below is what hides the 250 ms of staleness.
 */
const PROBE_HZ = 4;

/**
 * Time constant, seconds, smoothing the probed coast distance.
 *
 * The probe answers in rings, so its reading steps: 10, then 20, then 10 again
 * as an islet slides past. Fed straight into the cap that would step the
 * wind's strength with it. About a second of smoothing turns the staircase
 * into a ramp, and covers the islet the inner ring misses for a beat.
 */
const COAST_TAU = 1;

/** Bearings and ranges (world units) the coast probe walks. 16 x 5 = 80 reads. */
const PROBE_BEARINGS = 16;
const PROBE_RINGS = [5, 10, 20, 30, OPEN_SEA_DISTANCE];

/**
 * Weather seed. Fixed by default, so a given world always blows the same way.
 *
 * Reproducible weather is worth more here than novelty: tuning the caps and
 * chasing a drift bug both need the same gust to come back on the next run.
 */
const WIND_SEED = 0x0dd1e5;

/**
 * The eight-sector push table, indexed by the wind's travel bearing relative
 * to the bow, quantised to the nearest 45 degrees.
 *
 * Sector 0 is wind travelling the way the ship points -- dead astern, blowing
 * it forward. `along` is +forward, `across` is +starboard. The 0.707s are the
 * diagonals resolved onto those two axes, so every entry is a unit vector and
 * the cap therefore means the same thing on every point of sail.
 *
 * A table rather than a cosine is the design and not a shortcut: the player is
 * meant to learn eight distinct behaviours, not a continuum.
 */
const DIAG = Math.SQRT1_2;
const SECTOR_ALONG = [1, DIAG, 0, -DIAG, -1, -DIAG, 0, DIAG];
const SECTOR_ACROSS = [0, DIAG, 1, DIAG, 0, -DIAG, -1, -DIAG];

const TWO_PI = Math.PI * 2;
const SECTOR_ARC = TWO_PI / 8;

/* ------------------------------------------------------------------ */
/* Module-scope scratch (no per-frame allocation in the hot path)      */
/* ------------------------------------------------------------------ */

const _north = new Vector3();
const _east = new Vector3();
const _bearingDir = new Vector3();
const _axis = new Vector3();
const _probe = new Vector3();
const _starboard = new Vector3();
/** Where the ship stood when the wind was last carried. */
const _lastShipPos = new Vector3();

/** Wraps an angle into [0, 2*PI). */
function normalizeAngle(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI;
}

/* ------------------------------------------------------------------ */
/* Wind                                                                */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only WindState surface. */
interface MutableWindState {
  speed: number;
  bearing: number;
  direction: Vector3;
  cap: number;
  along: number;
  across: number;
  phase: 'lull' | 'event';
  phaseTime: number;
  phaseDuration: number;
  phaseIndex: number;
  envelope: number;
}

/**
 * The world's weather: ramped events of one fixed bearing each, separated by
 * calms, and stronger the further the ship stands off the land.
 *
 * One object, mutated in place for the life of the run, exactly as `energy.ts`
 * owns its tank. `ship.ts` spends the push, the HUD prints it and the radar
 * draws it, all from this same reference -- handing out a copy would leave them
 * reading a wind that had stopped moving.
 *
 * `heightMap` is the same field `radar.ts` rasterises, on purpose: the wind and
 * the scope can then never disagree about where the land is, so the sheltered
 * water on the display is the sheltered water the ship actually finds.
 */
export function createWind(terrain: Terrain, heightMap: HeightMap, seed = WIND_SEED): Wind {
  const rng = mulberry32(seed);
  const gustNoise = createNoise2D(rng);

  const state: MutableWindState = {
    speed: 0,
    bearing: 0,
    // Mutated in place for the life of the run, like everything else on this
    // object: `water.ts` holds the reference across frames.
    direction: new Vector3(0, 0, 1),
    cap: COAST_CAP,
    along: 0,
    across: 0,
    // The phase reading, for `weather.ts`. Every one of these is a local this
    // function already kept; they are exposed rather than invented, and the
    // opening values below match the lull the run opens on.
    phase: 'lull',
    phaseTime: 0,
    phaseDuration: 0,
    phaseIndex: 0,
    envelope: 0,
  };

  /**
   * Resolve a compass bearing at `at` into the world vector the wind keeps.
   *
   * The one direction this conversion runs: an event is authored as an angle
   * and immediately becomes a vector. Nothing converts back except the reading
   * taken for the HUD.
   */
  function setDirectionFromBearing(bearing: number, at: Vector3): void {
    tangentFrame(at, _north, _east);
    state.direction
      .copy(_north)
      .multiplyScalar(Math.cos(bearing))
      .addScaledVector(_east, Math.sin(bearing))
      .normalize();
    state.bearing = normalizeAngle(bearing);
  }

  // Open on a lull. The first thing a new player meets should be the sea as
  // the rest of the game already taught it, not a gust they have no name for.
  let inEvent = false;
  let phaseTime = 0;
  let phaseDuration = LULL_MIN + rng() * (LULL_MAX - LULL_MIN);
  // Offset into the gust curve, redrawn per event so that two events of the
  // same length do not gust identically.
  let gustLane = rng() * 1000;

  // Zero, so the very first frame probes rather than sailing on a guess.
  let probeTimer = 0;
  let lastReading = OPEN_SEA_DISTANCE;
  let coastDistance = OPEN_SEA_DISTANCE;
  let probed = false;

  /**
   * Distance to the nearest land, world units, resolved to the probe rings and
   * saturating at OPEN_SEA_DISTANCE.
   *
   * Walks the rings from the inside out and stops at the first that finds land
   * on any bearing, so the full 80 reads are only paid out in open water --
   * which is exactly where the answer is least interesting.
   */
  function probeCoast(position: Vector3): number {
    tangentFrame(position, _north, _east);
    for (let r = 0; r < PROBE_RINGS.length; r++) {
      const angle = PROBE_RINGS[r] / GLOBE_RADIUS;
      for (let b = 0; b < PROBE_BEARINGS; b++) {
        const theta = (b / PROBE_BEARINGS) * TWO_PI;
        _bearingDir
          .copy(_north)
          .multiplyScalar(Math.cos(theta))
          .addScaledVector(_east, Math.sin(theta));
        // The same great-circle step `ship.ts` walks: rotate the position
        // toward a tangent direction about their cross product.
        _axis.crossVectors(position, _bearingDir);
        if (_axis.lengthSq() < 1e-12) continue;
        _axis.normalize();
        _probe.copy(position).applyAxisAngle(_axis, angle).normalize();
        if (heightMap.sample(_probe) > terrain.seaLevel) return PROBE_RINGS[r];
      }
    }
    return OPEN_SEA_DISTANCE;
  }

  function update(dt: number, ship: ShipState, energy: EnergyState, stormLift = 0): void {
    // A frame that advanced no time moves no air. Returning leaves the last
    // true reading standing rather than rewriting the HUD with a stale zero.
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    // ---- Where the land is ------------------------------------------------
    probeTimer -= dt;
    if (probeTimer <= 0) {
      probeTimer += 1 / PROBE_HZ;
      // A frame longer than the probe interval must not leave the timer
      // negative and probe again immediately on the next one.
      if (probeTimer <= 0) probeTimer = 1 / PROBE_HZ;
      lastReading = probeCoast(ship.position);
      // The first reading is adopted outright. Easing toward it from a guess
      // would open the game on a wind that was wrong for the first second.
      if (!probed) {
        coastDistance = lastReading;
        probed = true;
      }
    }
    // Eased every frame, not only on a probe: smoothing that advanced four
    // times a second would step just as visibly as the raw reading it hides.
    coastDistance += (lastReading - coastDistance) * (1 - Math.exp(-dt / COAST_TAU));

    // Re-evaluated every frame, never locked at the start of an event: a ship
    // under a 30 s gust crosses 200 units, which is five times the ramp.
    const offshore = coastDistance / OPEN_SEA_DISTANCE;
    const t = offshore < 0 ? 0 : offshore > 1 ? 1 : offshore;
    state.cap = COAST_CAP + (OCEAN_CAP - COAST_CAP) * t;

    // ---- Calms and events -------------------------------------------------
    phaseTime += dt;
    if (phaseTime >= phaseDuration) {
      phaseTime -= phaseDuration;
      inEvent = !inEvent;
      // Counted, not flagged: `weather.ts` rolls on the step, so a consumer
      // that misses a frame still rolls exactly once for the phase it missed.
      state.phaseIndex++;
      if (inEvent) {
        phaseDuration = EVENT_MIN + rng() * (EVENT_MAX - EVENT_MIN);
        // A bearing is how an event is AUTHORED -- one compass angle, drawn
        // once -- but it is not how it is kept. Resolved into a world vector
        // here and carried as one from then on; see the transport below.
        setDirectionFromBearing(rng() * TWO_PI, ship.position);
        gustLane = rng() * 1000;
      } else {
        phaseDuration = LULL_MIN + rng() * (LULL_MAX - LULL_MIN);
        /*
         * A lull draws its own bearing, exactly as an event does.
         *
         * It used to hold the last event's, because at zero speed nothing
         * read the direction and spinning the HUD's arrow through a dead calm
         * would have been reporting weather that was not there. Now there is
         * always weather, so the reverse is true: holding the bearing would
         * make every lull a weak continuation of the gust before it, and the
         * wind would only ever change direction on the way UP. Drawing here
         * is what lets it come round while it is quiet, which is what a real
         * wind does.
         */
        setDirectionFromBearing(rng() * TWO_PI, ship.position);
      }
      // Guard against a carried-over remainder longer than the phase it lands
      // in, which would otherwise skip that phase whole on the next frame.
      if (phaseTime > phaseDuration) phaseTime = phaseDuration;
    }

    if (inEvent) {
      const fade = Math.min(FADE, phaseDuration * 0.25);
      const rise = fade > 0 ? phaseTime / fade : 1;
      const fall = fade > 0 ? (phaseDuration - phaseTime) / fade : 1;
      const ramp = Math.max(0, Math.min(1, Math.min(rise, fall)));
      // Published as-is. `weather.ts` rides this rather than deriving its own
      // envelope from `speed`, so a squall and the gale carrying it peak
      // together whatever the coast has done to `cap` in between.
      state.envelope = ramp;

      // Remap the noise's [-1, 1] into [GUST_FLOOR, 1].
      const n = gustNoise(phaseTime * GUST_RATE + gustLane, 0);
      const gust = GUST_FLOOR + (1 - GUST_FLOOR) * (n * 0.5 + 0.5);

      // Floored, not offset: an event's own ramp passes through zero at each
      // end, and without this the wind would still die for a second or two
      // either side of every gust -- the exact thing the floor is here to
      // stop. The cap and the gust shape above are untouched.
      state.speed = Math.max(LULL_SPEED, ramp * gust * state.cap);
    } else {
      state.envelope = 0;
      state.speed = LULL_SPEED;
    }

    /*
     * A storm cell floors the wind.
     *
     * The one coupling between the weather and the wind, and it runs one way:
     * a storm cell makes the wind blow, the wind never makes a cell. Without
     * it a storm that formed during a lull would be a dark, wet, flat calm,
     * which reads as a bug rather than as weather.
     *
     * A FLOOR, not an offset, for the same reason `LULL_SPEED` is one: the top
     * of the range is exactly where it was and only the bottom moves, so a
     * gale inside a cell is the gale it would have been. And it lifts the
     * SPEED only -- the bearing stays the phase's own, so a storm cell does
     * not get to choose which way it blows.
     */
    if (stormLift > 0) {
      const lift = stormLift > 1 ? 1 : stormLift;
      state.speed = Math.max(state.speed, lift * CELL_WIND_LIFT * state.cap);
    }

    // The phase reading, published after every branch above has run so it
    // describes the phase this frame actually spent.
    state.phase = inEvent ? 'event' : 'lull';
    state.phaseTime = phaseTime;
    state.phaseDuration = phaseDuration;

    // ---- Carry the wind across the ship's own motion ----------------------
    /*
     * The wind is a direction in the world, not an angle in a chart.
     *
     * It used to be the angle: `bearing` was held for the length of an event
     * and re-resolved against the tangent frame at the ship every frame. That
     * is stable anywhere the frame is, and near a pole the frame is not --
     * meridians converge, so a held bearing swings through the compass in a
     * few metres of travel and the push swung with it. A ship up there twisted
     * on the spot, driven round by its own weather.
     *
     * So the vector is transported instead, by exactly the rotation that
     * carried the hull, and the bearing is read back off it. A steady wind now
     * stays a steady wind: on a great-circle course it holds its angle to the
     * bow, and its COMPASS bearing changes, which is what a real wind does on
     * a real course. At the pole the reading spins and the wind does not.
     */
    _axis.crossVectors(_lastShipPos, ship.position);
    const sin = _axis.length();
    if (sin > 1e-12) {
      _axis.multiplyScalar(1 / sin);
      const cos = Math.max(-1, Math.min(1, _lastShipPos.dot(ship.position)));
      state.direction.applyAxisAngle(_axis, Math.atan2(sin, cos));
    }
    // Rounding walks it off the tangent plane over a long passage.
    state.direction.addScaledVector(ship.position, -state.direction.dot(ship.position));
    if (state.direction.lengthSq() > 1e-12) state.direction.normalize();
    else setDirectionFromBearing(state.bearing, ship.position);
    _lastShipPos.copy(ship.position);

    // The reading, for the HUD's arrow and the scope's. Derived, never stored
    // as the truth -- exactly as `ship.ts` now derives its heading.
    tangentFrame(ship.position, _north, _east);
    state.bearing = normalizeAngle(
      Math.atan2(state.direction.dot(_east), state.direction.dot(_north)),
    );

    // ---- Resolve onto the hull -------------------------------------------
    /*
     * Quantise the wind's angle to the BOW into one of eight sectors and read
     * the push straight out of the table.
     *
     * Measured between two world vectors rather than as a difference of two
     * compass bearings. Algebraically the same wherever a tangent frame exists,
     * and unlike the subtraction it still means something where one does not:
     * this is the number that decides which way the hull is shoved, so it is
     * the last place that should depend on a chart.
     */
    _starboard.crossVectors(ship.forward, ship.up);
    if (_starboard.lengthSq() > 1e-12) _starboard.normalize();
    const relative = normalizeAngle(
      Math.atan2(state.direction.dot(_starboard), state.direction.dot(ship.forward)),
    );
    const sector = Math.round(relative / SECTOR_ARC) % 8;

    let targetAlong = WIND_GRIP * state.speed * SECTOR_ALONG[sector];
    let targetAcross = WIND_GRIP * state.speed * SECTOR_ACROSS[sector];

    // A berth is shelter. `energy.ts` owns the one definition of docked --
    // inside a ring and slow enough to have connected -- so the wind cannot
    // develop a second opinion about it. Easing the target to zero rather than
    // cutting the push gives a berth a half-second of lee instead of a wall.
    if (energy.mode === 'docked') {
      targetAlong = 0;
      targetAcross = 0;
    }

    const k = 1 - Math.exp(-dt / PUSH_TAU);
    state.along += (targetAlong - state.along) * k;
    state.across += (targetAcross - state.across) * k;
  }

  return { state: state as WindState, update };
}
