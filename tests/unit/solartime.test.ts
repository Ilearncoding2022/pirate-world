import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { solarPhase, phaseName, formatLocalTime } from '../../src/solartime';
import { latLonToDir } from '../../src/geo';

/**
 * Regression cover for the time dial's geometry.
 *
 * The dial's whole claim is that local time is a property of WHERE THE SHIP IS
 * rather than of a clock it carries, so sailing east shortens the day and
 * sailing west stretches it. That is one subtraction in `solartime.ts`, and
 * with its operands swapped everything still looks plausible -- the dial turns,
 * the sun rises and sets -- while running backwards. These tests are what
 * would catch that.
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

describe('solarPhase', () => {
  it('reads local noon directly under the sun', () => {
    const sun = sunAt(0.3);
    // The ship stands at the subsolar point: same direction as the sun.
    const phase = solarPhase(sun.clone(), sun);
    expect(phase.time).toBeCloseTo(0.5, 6);
    expect(phase.sinElevation).toBeCloseTo(1, 6);
  });

  it('reads local midnight on the far side of the globe', () => {
    const sun = sunAt(0.3);
    const phase = solarPhase(sun.clone().negate(), sun);
    // Midnight is 0.0, which wraps, so accept either end of the circle.
    expect(Math.min(phase.time, 1 - phase.time)).toBeCloseTo(0, 6);
    expect(phase.sinElevation).toBeCloseTo(-1, 6);
  });

  it('advances forward in time for a ship lying still', () => {
    const at = latLonToDir(0, 0, new Vector3());
    const before = solarPhase(at, sunAt(0.10)).time;
    const after = solarPhase(at, sunAt(0.15)).time;
    expect(after).toBeGreaterThan(before);
    // A twentieth of a solar day of sun motion is a twentieth of the dial.
    expect(after - before).toBeCloseTo(0.05, 6);
  });

  it('runs the day faster eastbound and slower westbound', () => {
    const start = latLonToDir(0, 0, new Vector3());
    const east = latLonToDir(0, 6, new Vector3());
    const west = latLonToDir(0, -6, new Vector3());

    const t0 = solarPhase(start, sunAt(0.1)).time;
    const still = solarPhase(start, sunAt(0.15)).time - t0;
    const sailedEast = solarPhase(east, sunAt(0.15)).time - t0;
    const sailedWest = solarPhase(west, sunAt(0.15)).time - t0;

    expect(sailedEast).toBeGreaterThan(still);
    expect(sailedWest).toBeLessThan(still);
    // Six degrees of longitude is 6/360 of a day either way.
    expect(sailedEast - still).toBeCloseTo(6 / 360, 6);
    expect(still - sailedWest).toBeCloseTo(6 / 360, 6);
  });

  it('splits the day evenly on the equator at an equinox', () => {
    const phase = solarPhase(latLonToDir(0, 0, new Vector3()), sunAt(0.0, 0));
    expect(phase.dayFraction).toBeCloseTo(0.5, 6);
    expect(phase.sunrise).toBeCloseTo(0.25, 6);
    expect(phase.sunset).toBeCloseTo(0.75, 6);
  });

  it('answers a polar night and a midnight sun rather than clamping them away', () => {
    const tilt = 0.41;
    const northPolar = latLonToDir(80, 0, new Vector3());
    // Sun over the far hemisphere: the pole never sees it.
    expect(solarPhase(northPolar, sunAt(0.2, -tilt)).dayFraction).toBe(0);
    // Sun over its own hemisphere: it never sets.
    expect(solarPhase(northPolar, sunAt(0.2, tilt)).dayFraction).toBe(1);
  });

  it('stretches the day toward the summer pole and shortens it toward the winter one', () => {
    const tilt = 0.41;
    const sun = sunAt(0.2, tilt);
    const north = solarPhase(latLonToDir(55, 0, new Vector3()), sun).dayFraction;
    const equator = solarPhase(latLonToDir(0, 0, new Vector3()), sun).dayFraction;
    const south = solarPhase(latLonToDir(-55, 0, new Vector3()), sun).dayFraction;
    expect(north).toBeGreaterThan(equator);
    expect(equator).toBeGreaterThan(south);
    expect(equator).toBeCloseTo(0.5, 6);
  });
});

describe('phaseName', () => {
  const sun = sunAt(0.0, 0);
  const nameAtLat = (latDeg: number, lonDeg: number): string =>
    phaseName(solarPhase(latLonToDir(latDeg, lonDeg, new Vector3()), sun));

  it('names the sun overhead DAY and the far side NIGHT', () => {
    // Sun is over lat 0 / lon 0 at timeOfDay 0.
    expect(nameAtLat(0, 0)).toBe('DAY');
    expect(nameAtLat(0, 180)).toBe('NIGHT');
  });

  it('separates DAWN from DUSK by which side of noon the ship is on', () => {
    // Both sit on the terminator, so only the local time tells them apart.
    expect(nameAtLat(0, -90)).toBe('DAWN');
    expect(nameAtLat(0, 90)).toBe('DUSK');
  });
});

describe('formatLocalTime', () => {
  it('puts noon at 12:00 and midnight at 00:00', () => {
    expect(formatLocalTime(0.5)).toBe('12:00');
    expect(formatLocalTime(0)).toBe('00:00');
    expect(formatLocalTime(0.25)).toBe('06:00');
    expect(formatLocalTime(0.75)).toBe('18:00');
  });

  it('wraps rather than printing an impossible hour', () => {
    expect(formatLocalTime(1.25)).toBe('06:00');
    expect(formatLocalTime(-0.25)).toBe('18:00');
  });
});
