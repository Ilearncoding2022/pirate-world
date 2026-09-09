import { describe, it, expect } from 'vitest';
import {
  createDayNight,
  DAY_LENGTH,
  MOON_MONTH_DAYS,
  START_ELAPSED,
} from '../../src/daynight';
import { createEnv } from '../../src/env';
import type { WorldEnv } from '../../src/env';
import { Vector3 } from 'three';
import { solarPhase } from '../../src/solartime';
import { SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { latLonToDir } from '../../src/geo';
import { SUN_APPEARS_SIN } from '../../src/horizon';

/**
 * The moon's orbit.
 *
 * `daynight.ts` is the sole writer of `WorldEnv`, and the moon is now placed
 * there from elapsed time on its own period rather than parked opposite the
 * sun. That is geometry, so it is the part that can be wrong in a way nobody
 * notices from the deck -- the same argument `solartime.ts` makes for being a
 * DOM-free module of its own. None of this needs a renderer, so it belongs in
 * the unit tier (docs/TESTING.md).
 *
 * Nothing here asserts on appearance. The owner judges that by eye.
 */

/**
 * The world at absolute time `elapsed`, counted from zero.
 *
 * The clock is zeroed first because `createEnv` does NOT start at zero -- it
 * starts at `START_ELAPSED`, so the game opens at dawn rather than at noon.
 * Every case below is about the shape of the orbits over time, which is easier
 * to read and to check by hand from a zero origin, so the offset is removed
 * here rather than folded into every expectation. The one case that is about
 * the opening uses `START_ELAPSED` explicitly.
 */
function envAt(elapsed: number): WorldEnv {
  const dayNight = createDayNight();
  const env = createEnv();
  env.elapsed = 0;
  dayNight.update(elapsed, env);
  return env;
}

/** Longitude on geo.ts's convention: lon = atan2(x, z), so lon 0 is +Z. */
function lon(v: { x: number; z: number }): number {
  return Math.atan2(v.x, v.z);
}

/** Wraps a count of turns into [0, 1). */
function wrapTurn(t: number): number {
  return t - Math.floor(t);
}

/** Wraps a count of turns into (-0.5, 0.5], so a small lag reads as negative. */
function signedTurn(t: number): number {
  const w = wrapTurn(t);
  return w > 0.5 ? w - 1 : w;
}

/* A spread of times that is not a multiple of any period in the file. */
const SAMPLES = [0, 137, 600, 1200, 2600, 5000, 9600, 12345];

describe('moon orbit', () => {
  it('keeps moonDirection a unit vector at every sampled time', () => {
    for (const t of SAMPLES) {
      expect(envAt(t).moonDirection.length()).toBeCloseTo(1, 12);
    }
  });

  it('keeps moonIllumination inside [0, 1]', () => {
    for (const t of SAMPLES) {
      const lit = envAt(t).moonIllumination;
      expect(lit).toBeGreaterThanOrEqual(0);
      expect(lit).toBeLessThanOrEqual(1);
    }
  });

  it('reads the phase off the two directions, not off a clock', () => {
    // The identity the moon's own shader also depends on: full when the two
    // vectors oppose, new when they align. If this drifts, the disc in the
    // sky and the fill light stop agreeing about what night it is.
    for (const t of SAMPLES) {
      const env = envAt(t);
      const dot = env.sunDirection.dot(env.moonDirection);
      expect(env.moonIllumination).toBeCloseTo((1 - dot) * 0.5, 12);
    }
  });

  it('swings from a thin crescent to nearly full over one month', () => {
    /*
     * A month that never got near either end would still pass the [0, 1]
     * bound above, so the swing itself is what is pinned here.
     *
     * Note what is NOT asserted: that the moon ever reaches exactly new or
     * exactly full. It does not, and should not. The two orbits are inclined
     * to each other -- the sun's declination runs on a 6 day beat and the
     * moon's on a 5 day one -- so the bodies almost never line up exactly,
     * which is the same reason eclipses are rare rather than monthly. The
     * measured extremes are about 0.04 and 0.94; the bounds below leave room
     * for the beats to drift without leaving room for the cycle to collapse.
     */
    const month = DAY_LENGTH * MOON_MONTH_DAYS;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const lit = envAt((month * i) / 200).moonIllumination;
      min = Math.min(min, lit);
      max = Math.max(max, lit);
    }
    expect(min).toBeLessThan(0.08);
    expect(max).toBeGreaterThan(0.90);
  });

  it('opens on a moon that can actually be seen', () => {
    /*
     * The world once started with both bodies over longitude 0: a new moon,
     * beside a noon sun -- the one arrangement in which there is nothing to
     * look at. MOON_PHASE_OFFSET exists to prevent exactly that, so it gets a
     * test rather than a comment alone.
     *
     * Note this runs at START_ELAPSED, not at 0. The offset is tuned against
     * the hour the world actually opens at, and it had to be retuned once
     * already when that hour moved from noon to dawn -- so testing t = 0 here
     * would be pinning a moment no player ever sees.
     */
    const env = createEnv();
    createDayNight().update(0, env);
    expect(env.elapsed).toBe(START_ELAPSED);

    // Bright: the dawn opening puts the sun on the eastern horizon, which
    // leaves the whole western sky free for a nearly-opposite, nearly-full
    // moon. A noon opening could not do better than a third-lit crescent.
    expect(env.moonIllumination).toBeGreaterThan(0.6);

    // And up. The spawn is on the equator at longitude 0 (terrain.ts), so a
    // moon within a quarter turn of that meridian is above the horizon.
    const moonLon = lon(env.moonDirection);
    expect(Math.abs(moonLon)).toBeLessThan(Math.PI / 2);
    // West of the spawn meridian: setting astern as the sun rises ahead.
    expect(moonLon).toBeLessThan(0);
  });

  it('opens on daybreak, with the sun due east and touching the water', () => {
    /*
     * The world opens as the sun's disc clears the sea, so it is in front of a
     * ship that spawns on heading 090 and is visibly rising rather than
     * already up. START_ELAPSED is solved from the same threshold and the same
     * sunrise equation `solartime.ts` uses rather than written down, so what
     * is checked here is that the solve lands where it claims.
     *
     * Asserted through `solarPhase`, which is what the dial reads, so this
     * pins the moment the PLAYER sees rather than a vector that happens to
     * imply it. The old version of this case looked for elevation zero, and
     * that was the bug: on this globe elevation zero is a sun already a
     * quarter of the sky clear of the water.
     */
    const env = createEnv();
    createDayNight().update(0, env);

    const up = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG, new Vector3());
    const phase = solarPhase(up, env.sunDirection);

    // Exactly on the crossing, within a second of game time. Which SIDE of it
    // the zero-length first frame lands on is a float's choice and not worth
    // pinning, so the phase is read a second later, once time has moved.
    expect(phase.solarTime).toBeCloseTo(phase.dayStart, 5);

    const dayNight = createDayNight();
    const running = createEnv();
    dayNight.update(1, running);
    const after = solarPhase(up, running.sunDirection);
    expect(after.isDay).toBe(true);
    expect(after.progress).toBeGreaterThan(0);
    expect(after.progress).toBeLessThan(0.02);
    // Daybreak proper: the disc is ON the drawn horizon, not merely near it.
    expect(phase.sinElevation).toBeCloseTo(SUN_APPEARS_SIN, 6);
    // And it is the EASTERN horizon. With the tilt at zero the sun sits on the
    // equator, so its longitude is the hour angle of daybreak itself: east of
    // the spawn meridian by acos of the threshold, about 117 degrees.
    expect(lon(env.sunDirection)).toBeCloseTo(Math.acos(SUN_APPEARS_SIN), 6);
    expect(lon(env.sunDirection)).toBeGreaterThan(0);
  });

  it('lets the sun gain exactly one lap on the moon per month', () => {
    // This is the whole mechanism behind the moon rising later each day. The
    // sun-moon longitude gap must advance by 1 / MOON_MONTH_DAYS of a turn in
    // one day, and close on itself after MOON_MONTH_DAYS of them.
    const gapAt = (t: number): number => {
      const env = envAt(t);
      return (lon(env.sunDirection) - lon(env.moonDirection)) / (Math.PI * 2);
    };

    // Negative because both bodies track westward and the sun does it faster,
    // so the sun pulls away from the moon rather than the moon from the sun.
    // That sign is what makes moonrise LATER each day rather than earlier.
    const start = gapAt(0);
    const oneDay = signedTurn(gapAt(DAY_LENGTH) - start);
    expect(oneDay).toBeCloseTo(-1 / MOON_MONTH_DAYS, 9);

    // And after a whole month the gap is back where it started: one full lap.
    const oneMonth = signedTurn(gapAt(DAY_LENGTH * MOON_MONTH_DAYS) - start);
    expect(oneMonth).toBeCloseTo(0, 9);
  });

  it('tracks the equator exactly, and lets nothing in the sky move it', () => {
    /*
     * This used to be four golden triples captured before the moon landed,
     * guarding the one vector every shader in the project decides day from
     * night by against a second body being added next to it. It still guards
     * that, and now says WHAT it is guarding rather than four hashes of it:
     * with AXIAL_TILT at zero the sun holds the equator, and its longitude is
     * the elapsed fraction of a day run westward. Nothing else may touch it.
     *
     * Restoring the tilt is expected to fail this case, which is the point --
     * it is the one line that would otherwise let a season back in unnoticed.
     */
    for (const t of [0, 600, 2600, 9600]) {
      const sun = envAt(t).sunDirection;
      // On the equator: no declination, in any season.
      expect(sun.y).toBeCloseTo(0, 12);
      // And westward at one turn per DAY_LENGTH.
      const expected = -((t / DAY_LENGTH) % 1) * Math.PI * 2;
      expect(Math.cos(lon(sun))).toBeCloseTo(Math.cos(expected), 12);
      expect(Math.sin(lon(sun))).toBeCloseTo(Math.sin(expected), 12);
    }
  });
});
