import type { Vector3 } from 'three';
import { SUN_APPEARS_SIN } from './horizon';

/**
 * Where the ship stands in its own day and its own night.
 *
 * This is deliberately a separate, DOM-free module from `timedial.ts`, for the
 * same reason `fishsim.ts` is separate from `fishrender.ts`: the geometry is
 * the part that can be wrong in a way nobody notices, so it is the part that
 * has to be testable without a canvas.
 *
 * Everything here follows from one fact recorded in **Day, night, and travel**
 * in `docs/ARCHITECTURE.md`: the sun is placed in world space from elapsed time
 * alone, and where the ship stands in its day is a property of *where the ship
 * is*, never of a clock it carries. So this is not reading a clock. It is
 * measuring the angle between the ship's meridian and the sun's, which is why
 * sailing east runs the day out faster and sailing west holds the sunset -- and
 * why nothing has to model that for it to show up here.
 *
 * ### Why there is no hour on it
 *
 * There used to be. It read `HH:MM`, and it was a lie in two directions at
 * once. On a globe of radius 200 the DRAWN horizon sits some 25 degrees below
 * eye level (see `horizon.ts`), so the sun cleared the sea long before the
 * dial said 06:00 and hung over it long after it said 18:00. Pinning those two
 * hours to what the player could actually see would have meant stretching the
 * hours themselves -- roughly 15.6 hours of visible sun squeezed into 12 -- so
 * a daylight hour would have lasted nearly twice a night one.
 *
 * The hour was the part that had to go. What a player wants off this dial is
 * not a time of day; it is how much of the light is left. So the day and the
 * night are each measured as a PHASE, from 0 at its first moment to 1 at its
 * last, and the one thing that marks the boundary is the one thing on screen:
 * the sun's disc touching the water.
 */
export interface SolarPhase {
  /**
   * Position in the local solar day, [0, 1). 0.5 is local noon, 0 is local
   * midnight. Advances with real time for a ship at anchor; advances faster
   * eastbound and slower (or backwards) westbound.
   *
   * This is the raw angle between the two meridians, so it still turns at a
   * constant rate and is what the dial's marker rides. It is NOT a clock the
   * player reads an hour off -- see `progress` for that.
   */
  solarTime: number;
  /** Sine of the sun's elevation at the ship. Positive means above eye level. */
  sinElevation: number;
  /** True while any part of the sun's disc is clear of the drawn horizon. */
  isDay: boolean;
  /**
   * How far through the CURRENT phase the ship is, [0, 1). 0 is the moment the
   * disc appeared (or the moment it vanished, at night), 1 the moment the
   * phase ends. The two phases are different real lengths, and both of those
   * lengths change with latitude, which is exactly what this normalises away.
   */
  progress: number;
  /**
   * Fraction of this local day the sun's disc is visible for, [0, 1]. Follows
   * from latitude and the sun's declination, so it collapses to 1 inside a
   * midnight sun and to 0 inside a night that never breaks.
   */
  dayFraction: number;
  /** `solarTime` at which the disc appears, and at which it is fully gone. */
  dayStart: number;
  dayEnd: number;
  /**
   * True where the sun never crosses the horizon at all, so the day or the
   * night runs the whole way round and there is no crossing to measure from.
   */
  polar: boolean;
}

/** Wraps into [0, 1). */
function fract(v: number): number {
  return v - Math.floor(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Solar phase at a point, from the same two vectors every shader in the
 * project uses to decide day from night.
 *
 * @param up  Unit vector from the globe's centre to the ship. `ShipState.up`.
 * @param sunDirection Unit vector toward the sun. `WorldEnv.sunDirection`.
 */
export function solarPhase(up: Vector3, sunDirection: Vector3): SolarPhase {
  // Longitudes on geo.ts's convention: lon = atan2(x, z), so lon 0 is +Z.
  const shipLon = Math.atan2(up.x, up.z);
  const sunLon = Math.atan2(sunDirection.x, sunDirection.z);

  // Hour angle: how far the ship's meridian is from the sun's. Zero is noon.
  // The sun tracks westward, so the ship's own longitude is subtracted from
  // it rather than the other way round -- with the operands swapped the dial
  // runs backwards, which is exactly what `solartime.test.ts` pins.
  const hourAngle = (sunLon - shipLon) / (Math.PI * 2);
  const solarTime = fract(0.5 - hourAngle);

  const lat = Math.asin(clamp(up.y, -1, 1));
  const declination = Math.asin(clamp(sunDirection.y, -1, 1));

  // Elevation straight from the dot product, so this can never disagree with
  // what the shaders draw.
  const sinElevation =
    up.x * sunDirection.x + up.y * sunDirection.y + up.z * sunDirection.z;

  /*
   * Half the visible arc, as an hour angle.
   *
   * The sunrise equation in its general form: the sun stands at elevation h
   * when `sin h = sin(lat) sin(dec) + cos(lat) cos(dec) cos H`, solved for the
   * H at which h is the elevation the disc appears at. The textbook
   * `cos H = -tan(lat) tan(dec)` is this same line with `sin h` set to zero,
   * and zero is the one elevation that is NOT the horizon here: the sea is
   * `SUN_APPEARS_SIN` below it.
   *
   * Outside [-1, 1] there is no crossing at all, which is not a degenerate
   * case to guard against but a real place on this globe -- a sun that never
   * sets, above about 63 degrees of latitude. It is answered rather than
   * clamped away.
   */
  const denominator = Math.cos(lat) * Math.cos(declination);
  let cosH0: number;
  if (denominator < 1e-9) {
    // Standing on a pole: the sun holds one elevation all day, so it is either
    // up for the whole turn or down for it. Push cosH0 past either end.
    cosH0 = Math.sin(lat) * Math.sin(declination) > SUN_APPEARS_SIN ? -2 : 2;
  } else {
    cosH0 =
      (SUN_APPEARS_SIN - Math.sin(lat) * Math.sin(declination)) / denominator;
  }

  let dayFraction: number;
  if (cosH0 >= 1) dayFraction = 0;
  else if (cosH0 <= -1) dayFraction = 1;
  else dayFraction = Math.acos(cosH0) / Math.PI;

  const polar = dayFraction <= 0 || dayFraction >= 1;
  const half = dayFraction / 2;
  const dayStart = polar ? 0 : fract(0.5 - half);
  const dayEnd = polar ? 0 : fract(0.5 + half);

  /*
   * Which phase, and how far through it.
   *
   * Decided from the hour angle rather than from `sinElevation`, so it agrees
   * with `dayStart`/`dayEnd` by construction. The two are the same geometry
   * and cannot disagree by more than float noise, but a disagreement of one
   * float at the boundary is a phase that flickers, and this side of it is
   * also the side that has to keep working through a polar day.
   */
  let isDay: boolean;
  let progress: number;
  if (dayFraction >= 1) {
    // The sun never sets: the day is the whole turn, so it runs from the
    // lowest the sun gets, at local midnight.
    isDay = true;
    progress = solarTime;
  } else if (dayFraction <= 0) {
    // It never rises: the night is the whole turn, measured from local noon,
    // the moment it comes nearest to rising.
    isDay = false;
    progress = fract(solarTime + 0.5);
  } else {
    // Signed distance from local noon. `solarTime` is already wrapped into
    // [0, 1), so this lands in [-0.5, 0.5) with no wrapping of its own.
    const fromNoon = solarTime - 0.5;
    isDay = Math.abs(fromNoon) < half;
    progress = isDay
      ? (fromNoon + half) / dayFraction
      : fract(solarTime - dayEnd) / (1 - dayFraction);
  }

  return {
    solarTime,
    sinElevation,
    isDay,
    progress: clamp(progress, 0, 1),
    dayFraction,
    dayStart,
    dayEnd,
    polar,
  };
}

/** The four phases the dial names. */
export type PhaseName = 'DAWN' | 'DAY' | 'DUSK' | 'NIGHT';

/**
 * Elevation, in sine, up to which a risen sun still counts as rising rather
 * than simply up. About 11.5 degrees above EYE LEVEL, which on this globe is
 * a long way above the water: the band a sun crosses between clearing the sea
 * and being properly up covers some 38 degrees of climb, and all of it looks
 * like dawn from the deck. The water shader's own day/night crossfade runs
 * over a comparable band.
 */
const TWILIGHT_SIN = 0.2;

/**
 * Names the phase.
 *
 * Rising is decided from the phase's own progress rather than by remembering
 * the last frame, so it is correct on the first frame and after any jump.
 */
export function phaseName(phase: SolarPhase): PhaseName {
  if (!phase.isDay) return 'NIGHT';
  if (phase.sinElevation >= TWILIGHT_SIN) return 'DAY';
  return phase.progress < 0.5 ? 'DAWN' : 'DUSK';
}
