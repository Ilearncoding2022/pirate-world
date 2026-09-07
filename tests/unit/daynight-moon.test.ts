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

  it('opens at 06:00 local, with the sun due east', () => {
    /*
     * The world opens at dawn so the sun is in front of a ship that spawns on
     * heading 090. START_ELAPSED is derived from DAY_LENGTH and the spawn
     * longitude rather than written down, so what is checked here is that the
     * derivation lands where it claims.
     *
     * Asserted through `solarPhase`, which is what the time dial reads, so
     * this pins the hour the PLAYER sees rather than a vector that happens to
     * imply it. Note the sun's own `y` is its declination -- the seasonal
     * tilt, about 0.39 at this moment -- and not its height in the ship's sky;
     * those two are easy to confuse and only the second one means dawn.
     */
    const env = createEnv();
    createDayNight().update(0, env);

    const up = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG, new Vector3());
    const phase = solarPhase(up, env.sunDirection);

    // 0.25 of the local solar day is 06:00. Within a second of game time.
    expect(phase.time).toBeCloseTo(0.25, 5);
    // Sunrise proper: the sun is on the horizon, not merely near it.
    expect(phase.sinElevation).toBeCloseTo(0, 6);
    // And it is the EASTERN horizon. Longitude +90 degrees on geo.ts's
    // convention, where lon 0 is +Z and the spawn sits on it.
    expect(lon(env.sunDirection)).toBeCloseTo(Math.PI / 2, 6);
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

  it('leaves the sun exactly where it was before the moon existed', () => {
    // Golden triples captured from `main` at the commit the moon landed on.
    // Adding a body to the sky must not move the one every shader in the
    // project already decides day from night by.
    const golden: Array<[number, [number, number, number]]> = [
      [0, [0, 0.3273525223712207, 0.9449022838882333]],
      [600, [-1.1240916480829483e-16, 0.3968337839199034, -0.9178904879885244]],
      [2600, [-0.8655909711516524, -0.03167061015596467, 0.4997491802025173]],
      [9600, [0, 0.039777780460565, 0.9992085508949726]],
    ];
    for (const [t, [x, y, z]] of golden) {
      const sun = envAt(t).sunDirection;
      expect(sun.x).toBeCloseTo(x, 12);
      expect(sun.y).toBeCloseTo(y, 12);
      expect(sun.z).toBeCloseTo(z, 12);
    }
  });
});
