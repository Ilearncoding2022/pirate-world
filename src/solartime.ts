import type { Vector3 } from 'three';

/**
 * Where the ship stands in its own solar day.
 *
 * This is deliberately a separate, DOM-free module from `timedial.ts`, for the
 * same reason `fishsim.ts` is separate from `fishrender.ts`: the geometry is
 * the part that can be wrong in a way nobody notices, so it is the part that
 * has to be testable without a canvas.
 *
 * Everything here follows from one fact recorded in **Day, night, and travel**
 * in `docs/ARCHITECTURE.md`: the sun is placed in world space from elapsed time
 * alone, and local time is a property of *where the ship is*, never of a clock
 * it carries. So the dial is not reading a clock. It is measuring the angle
 * between the ship's meridian and the sun's, which is why sailing east makes
 * the day run out faster and sailing west holds the sunset -- and why nothing
 * has to model that for it to show up here.
 */
export interface SolarPhase {
  /**
   * Position in the local solar day, [0, 1). 0.5 is local noon, 0 is local
   * midnight. Advances with real time for a ship at anchor; advances faster
   * eastbound and slower (or backwards) westbound.
   */
  time: number;
  /** Sine of the sun's elevation at the ship. Positive means the sun is up. */
  sinElevation: number;
  /**
   * Fraction of this local day the sun spends above the horizon, [0, 1].
   * Follows from latitude and the sun's declination, so it stretches with the
   * season and collapses to 0 or 1 inside a polar night or midnight sun.
   */
  dayFraction: number;
  /** Local time the sun rises and sets, in the same [0, 1) as `time`. */
  sunrise: number;
  sunset: number;
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
  const time = fract(0.5 - hourAngle);

  const lat = Math.asin(clamp(up.y, -1, 1));
  const declination = Math.asin(clamp(sunDirection.y, -1, 1));

  // Elevation straight from the dot product, so this can never disagree with
  // what the shaders draw.
  const sinElevation =
    up.x * sunDirection.x + up.y * sunDirection.y + up.z * sunDirection.z;

  /*
   * Half the daylight arc, as an hour angle. The standard sunrise equation:
   * the sun is up while cos(H) > -tan(lat) * tan(dec).
   *
   * Outside [-1, 1] there is no crossing at all, which is not a degenerate
   * case to guard against but a real place on this globe -- a polar night, or
   * a midnight sun. Both are reachable here, since the world has poles and an
   * axial tilt, so they are answered rather than clamped away.
   */
  const cosH0 = -Math.tan(lat) * Math.tan(declination);
  let dayFraction: number;
  if (cosH0 >= 1) dayFraction = 0;
  else if (cosH0 <= -1) dayFraction = 1;
  else dayFraction = Math.acos(cosH0) / Math.PI;

  const half = dayFraction / 2;
  return {
    time,
    sinElevation,
    dayFraction,
    sunrise: fract(0.5 - half),
    sunset: fract(0.5 + half),
  };
}

/** The four phases the dial names. */
export type PhaseName = 'DAWN' | 'DAY' | 'DUSK' | 'NIGHT';

/**
 * Elevation, in sine, within which the sun counts as rising or setting rather
 * than simply up or down. About 11.5 degrees either side of the horizon --
 * wider than civil twilight because it is naming what the sky looks like from
 * the deck, and the water shader's own day/night crossfade runs over a
 * comparable band.
 */
const TWILIGHT_SIN = 0.2;

/**
 * Names the phase, and says whether the sun is climbing.
 *
 * Rising is decided from the local time rather than by remembering the last
 * frame, so it is correct on the first frame and after any jump.
 */
export function phaseName(phase: SolarPhase): PhaseName {
  const rising = phase.time < 0.5;
  if (phase.sinElevation > TWILIGHT_SIN) return 'DAY';
  if (phase.sinElevation < -TWILIGHT_SIN) return 'NIGHT';
  return rising ? 'DAWN' : 'DUSK';
}

/** Local solar time as `HH:MM` on a 24 hour clock. */
export function formatLocalTime(time: number): string {
  const totalMinutes = Math.floor(fract(time) * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
