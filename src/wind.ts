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
   */
  update(dt: number, ship: ShipState, energy: EnergyState): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * Wind speed caps at the shore and in the open sea, world units/s, which
 * `hud.ts` reads out as 8.0 and 16.0 kn.
 *
 * Exactly double, and that ratio matters more than either number: the open
 * ocean is where the wind is worth having and the coast is where it stays
 * survivable. At 16 kn the push is 0.35 x 16 = 5.6 kn, better than a third of
 * MAX_FORWARD, so crossing an ocean downwind is still a different journey from
 * crossing it upwind -- which is the whole reason for the system -- without the
 * weather ever being the larger half of how fast the ship is going.
 */
export const COAST_CAP = 8;
export const OCEAN_CAP = 16;

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

/** Event and calm durations, seconds. Drawn uniformly from each band. */
const EVENT_MIN = 5;
const EVENT_MAX = 30;
const CALM_MIN = 3;
const CALM_MAX = 15;

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
 * The gust noise varies the strength *within* an event, so that a steady 16 kn
 * does not read as a switch being held down. It must not be free to reach
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
 * Flat out downwind under the ocean cap the ship makes 15 + 0.35 x 16 = 20.6
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
 * entries are 0.765 apart, so at the ocean cap that is 0.35 x 16 x 0.765 =
 * 4.3 kn of velocity appearing within one frame, and the hull visibly snaps.
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

/* ------------------------------------------------------------------ */
/* Wind                                                                */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only WindState surface. */
interface MutableWindState {
  speed: number;
  bearing: number;
  cap: number;
  along: number;
  across: number;
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
    cap: COAST_CAP,
    along: 0,
    across: 0,
  };

  // Open on a calm. The first thing a new player meets should be the sea as
  // the rest of the game already taught it, not a gust they have no name for.
  let inEvent = false;
  let phaseTime = 0;
  let phaseDuration = CALM_MIN + rng() * (CALM_MAX - CALM_MIN);
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

  function update(dt: number, ship: ShipState, energy: EnergyState): void {
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
      if (inEvent) {
        phaseDuration = EVENT_MIN + rng() * (EVENT_MAX - EVENT_MIN);
        state.bearing = rng() * TWO_PI;
        gustLane = rng() * 1000;
      } else {
        phaseDuration = CALM_MIN + rng() * (CALM_MAX - CALM_MIN);
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

      // Remap the noise's [-1, 1] into [GUST_FLOOR, 1].
      const n = gustNoise(phaseTime * GUST_RATE + gustLane, 0);
      const gust = GUST_FLOOR + (1 - GUST_FLOOR) * (n * 0.5 + 0.5);

      state.speed = ramp * gust * state.cap;
    } else {
      // The bearing is left where the last event set it. Nothing reads it
      // while the speed is zero, and rewriting it would spin the HUD's arrow
      // through a calm, which looks like weather that is not there.
      state.speed = 0;
    }

    // ---- Resolve onto the hull -------------------------------------------
    // Quantise the wind's travel bearing, relative to the bow, into one of
    // eight sectors and read the push straight out of the table.
    let relative = (state.bearing - ship.heading) % TWO_PI;
    if (relative < 0) relative += TWO_PI;
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
