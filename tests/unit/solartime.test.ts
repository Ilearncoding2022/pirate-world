import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { solarPhase, phaseName } from '../../src/solartime';
import { SUN_APPEARS_SIN } from '../../src/horizon';
import { latLonToDir } from '../../src/geo';

/**
 * Regression cover for the day dial's geometry.
 *
 * Two claims are being pinned, and both are the kind that look plausible while
 * being wrong.
 *
 * The first is that where the ship stands in its day is a property of WHERE IT
 * IS rather than of a clock it carries, so sailing east runs the day out faster
 * and sailing west stretches it. That is one subtraction in `solartime.ts`, and
 * with its operands swapped everything still looks right -- the dial turns, the
 * sun rises and sets -- while running backwards.
 *
 * The second is that the day starts when the sun's disc appears over the DRAWN
 * horizon, not when it crosses eye level. Those are 25 degrees apart on a globe
 * this small, which is a third of the morning, and nothing about a dial reading
 * "DAY 4%" would look wrong if it were measuring from the wrong one.
 */

/** The sun's world direction at a given time of day, copied from daynight.ts. */
function sunAt(timeOfDay: number, declination = 0): Vector3 {
  const sunLon = -timeOfDay * Math.PI * 2;
  const cosDec = Math.cos(declination);
  return new Vector3(
    cosDec * Math.sin(sunLon),
    Math.sin(declination),
    cosDec * Math.cos(sunLon),
  );
}

/** The phase for a ship at a lat/lon, with the sun placed at `timeOfDay`. */
function phaseAt(latDeg: number, lonDeg: number, timeOfDay = 0, declination = 0) {
  return solarPhase(latLonToDir(latDeg, lonDeg, new Vector3()), sunAt(timeOfDay, declination));
}

/**
 * The ship's longitude that reads `solarTime` with the sun over longitude 0.
 *
 * `solarTime = fract(0.5 + shipLon / 2PI)` there, so this is that inverted. It
 * is how the cases below stand a ship exactly on its own daybreak without
 * searching for it.
 */
function lonForSolarTime(solarTime: number): number {
  return (solarTime - 0.5) * 360;
}

describe('solarPhase', () => {
  it('reads local noon directly under the sun', () => {
    const sun = sunAt(0.3);
    // The ship stands at the subsolar point: same direction as the sun.
    const phase = solarPhase(sun.clone(), sun);
    expect(phase.solarTime).toBeCloseTo(0.5, 6);
    expect(phase.sinElevation).toBeCloseTo(1, 6);
    expect(phase.isDay).toBe(true);
    // Noon is the middle of the day by construction, whatever the day's length.
    expect(phase.progress).toBeCloseTo(0.5, 6);
  });

  it('reads local midnight on the far side of the globe', () => {
    const sun = sunAt(0.3);
    const phase = solarPhase(sun.clone().negate(), sun);
    // Midnight is 0.0, which wraps, so accept either end of the circle.
    expect(Math.min(phase.solarTime, 1 - phase.solarTime)).toBeCloseTo(0, 6);
    expect(phase.sinElevation).toBeCloseTo(-1, 6);
    expect(phase.isDay).toBe(false);
    // And it is the middle of the night, for the same reason.
    expect(phase.progress).toBeCloseTo(0.5, 6);
  });

  it('advances forward in time for a ship lying still', () => {
    const before = phaseAt(0, 0, 0.1).solarTime;
    const after = phaseAt(0, 0, 0.15).solarTime;
    expect(after).toBeGreaterThan(before);
    // A twentieth of a solar day of sun motion is a twentieth of the dial.
    expect(after - before).toBeCloseTo(0.05, 6);
  });

  it('runs the day faster eastbound and slower westbound', () => {
    const t0 = phaseAt(0, 0, 0.1).solarTime;
    const still = phaseAt(0, 0, 0.15).solarTime - t0;
    const sailedEast = phaseAt(0, 6, 0.15).solarTime - t0;
    const sailedWest = phaseAt(0, -6, 0.15).solarTime - t0;

    expect(sailedEast).toBeGreaterThan(still);
    expect(sailedWest).toBeLessThan(still);
    // Six degrees of longitude is 6/360 of a day either way.
    expect(sailedEast - still).toBeCloseTo(6 / 360, 6);
    expect(still - sailedWest).toBeCloseTo(6 / 360, 6);
  });

  it('starts and ends the day on the one threshold the sun is drawn against', () => {
    /*
     * The whole point of the rework. Daybreak is the disc's top edge touching
     * the drawn horizon and nightfall is the same edge leaving it, so both must
     * land on `SUN_APPEARS_SIN` -- and must land on it at every latitude and
     * declination, which is what makes the general sunrise equation necessary
     * in place of the textbook `cos H = -tan(lat) tan(dec)`.
     */
    for (const [lat, dec] of [
      [0, 0],
      [35, 0],
      [-20, 0.3],
      [48, -0.41],
    ]) {
      const seed = phaseAt(lat, 0, 0, dec);
      expect(seed.polar).toBe(false);

      const dawn = phaseAt(lat, lonForSolarTime(seed.dayStart), 0, dec);
      const dusk = phaseAt(lat, lonForSolarTime(seed.dayEnd), 0, dec);

      expect(dawn.sinElevation).toBeCloseTo(SUN_APPEARS_SIN, 9);
      expect(dusk.sinElevation).toBeCloseTo(SUN_APPEARS_SIN, 9);
    }
  });

  it('gives the equator a day longer than its night, because the sea is below eye level', () => {
    const phase = phaseAt(0, 0);
    // acos(SUN_APPEARS_SIN) / PI: about 0.649, not the 0.5 an eye-level
    // horizon would give. If this ever reads 0.5 the horizon has been lost.
    expect(phase.dayFraction).toBeCloseTo(Math.acos(SUN_APPEARS_SIN) / Math.PI, 9);
    expect(phase.dayFraction).toBeGreaterThan(0.5);
  });

  it('runs progress from 0 to 1 across each phase, and the two cover the turn', () => {
    const lat = 22;
    const seed = phaseAt(lat, 0);

    // Just inside each end of the day, and of the night.
    const nudge = 1e-4;
    const dayOpen = phaseAt(lat, lonForSolarTime(seed.dayStart + nudge));
    const dayClose = phaseAt(lat, lonForSolarTime(seed.dayEnd - nudge));
    const nightOpen = phaseAt(lat, lonForSolarTime(seed.dayEnd + nudge));
    const nightClose = phaseAt(lat, lonForSolarTime(seed.dayStart - nudge));

    expect(dayOpen.isDay).toBe(true);
    expect(dayClose.isDay).toBe(true);
    expect(nightOpen.isDay).toBe(false);
    expect(nightClose.isDay).toBe(false);

    expect(dayOpen.progress).toBeCloseTo(0, 2);
    expect(dayClose.progress).toBeCloseTo(1, 2);
    expect(nightOpen.progress).toBeCloseTo(0, 2);
    expect(nightClose.progress).toBeCloseTo(1, 2);

    // Nothing falls between the two phases: they tile the whole turn.
    expect(seed.dayFraction + (1 - seed.dayFraction)).toBeCloseTo(1, 12);
  });

  it('advances progress monotonically through a phase', () => {
    const lat = 10;
    const seed = phaseAt(lat, 0);
    let last = -1;
    for (let i = 1; i < 20; i++) {
      const at = seed.dayStart + (seed.dayFraction * i) / 20;
      const phase = phaseAt(lat, lonForSolarTime(at));
      expect(phase.isDay).toBe(true);
      expect(phase.progress).toBeGreaterThan(last);
      last = phase.progress;
    }
  });

  it('answers a sun that never sets rather than clamping it away', () => {
    /*
     * With the axial tilt at zero this is permanent above about 63 degrees: the
     * sun circles at an elevation that never reaches down to the drawn horizon,
     * so there is no crossing to measure a phase from. It is a real place on
     * this globe, not a degenerate input.
     */
    const polar = phaseAt(75, 0);
    expect(polar.polar).toBe(true);
    expect(polar.dayFraction).toBe(1);
    expect(polar.isDay).toBe(true);

    // The threshold is what decides it, so just under the line still sets.
    const below = phaseAt(60, 0);
    expect(below.polar).toBe(false);
    expect(below.dayFraction).toBeLessThan(1);
  });

  it('answers a night that never breaks, on the far side of the same threshold', () => {
    // Unreachable with the tilt at zero, since the sun would have to stay more
    // than 116 degrees from the zenith all day and this globe tops out at 113.
    // Reachable the moment a tilt is restored, so the branch is pinned here.
    const phase = solarPhase(
      latLonToDir(89, 0, new Vector3()),
      sunAt(0.2, -1.2),
    );
    expect(phase.polar).toBe(true);
    expect(phase.dayFraction).toBe(0);
    expect(phase.isDay).toBe(false);
  });

  it('shortens the day toward the pole and lengthens it toward the summer one', () => {
    const north = phaseAt(55, 0, 0.2, -0.41).dayFraction;
    const equator = phaseAt(0, 0, 0.2, -0.41).dayFraction;
    const south = phaseAt(-55, 0, 0.2, -0.41).dayFraction;
    expect(south).toBeGreaterThan(equator);
    expect(equator).toBeGreaterThan(north);
  });
});

describe('phaseName', () => {
  it('names the sun overhead DAY and the far side NIGHT', () => {
    // Sun is over lat 0 / lon 0 at timeOfDay 0.
    expect(phaseName(phaseAt(0, 0))).toBe('DAY');
    expect(phaseName(phaseAt(0, 180))).toBe('NIGHT');
  });

  it('separates DAWN from DUSK by which side of noon the ship is on', () => {
    // Low sun either side: a quarter turn of longitude puts it near the
    // horizon, east of the sun in one direction and west in the other.
    expect(phaseName(phaseAt(0, -80))).toBe('DAWN');
    expect(phaseName(phaseAt(0, 80))).toBe('DUSK');
  });

  it('calls a disc that has cleared the water DAWN, not NIGHT', () => {
    /*
     * The bug this whole change exists to fix. At this longitude the sun is
     * well below EYE LEVEL and just clear of the DRAWN horizon: visible over
     * the sea, and formerly reported as night.
     */
    const lat = 0;
    const seed = phaseAt(lat, 0);
    const justUp = phaseAt(lat, lonForSolarTime(seed.dayStart + 0.01));
    expect(justUp.sinElevation).toBeLessThan(0);
    expect(justUp.sinElevation).toBeGreaterThan(SUN_APPEARS_SIN);
    expect(justUp.isDay).toBe(true);
    expect(phaseName(justUp)).toBe('DAWN');
  });
});
