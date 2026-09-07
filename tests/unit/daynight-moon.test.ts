import { describe, it, expect } from 'vitest';
import { createDayNight, DAY_LENGTH, MOON_MONTH_DAYS } from '../../src/daynight';
import { createEnv } from '../../src/env';
import type { WorldEnv } from '../../src/env';

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

/** Runs a fresh rig forward to `elapsed` in one step and returns the env. */
function envAt(elapsed: number): WorldEnv {
  const dayNight = createDayNight();
  const env = createEnv();
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

  it('runs a full new -> full -> new cycle over one month', () => {
    // Sampled finely enough to catch both ends: a month that never reaches
    // either extreme would still pass the [0, 1] bound above.
    const month = DAY_LENGTH * MOON_MONTH_DAYS;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const lit = envAt((month * i) / 200).moonIllumination;
      min = Math.min(min, lit);
      max = Math.max(max, lit);
    }
    expect(min).toBeLessThan(0.02);
    expect(max).toBeGreaterThan(0.98);
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
