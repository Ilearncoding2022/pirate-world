import { describe, it, expect } from 'vitest';
import {
  ARM_UP,
  DIAL_PERIOD,
  HUNT_GOLD_PER_DAMAGE,
  LEVEL_HOLD,
  LEVEL_MULTIPLIER,
  LEVEL_SPEED,
  SOUND_BELOW,
  SWEEP_FAST,
  SWEEP_SLOW,
  arm,
  bandFor,
  canPress,
  createSweep,
  damageAt,
  huntGoldFor,
  multiplierFor,
  position,
  rateFor,
  step,
} from '../../src/huntsweep';

/**
 * `huntsweep.ts`'s rule set: the needle's start, its rate, the arm-up, the
 * damage ramp, the escalation tables and the purse.
 *
 * No world here at all. The sweep is pure functions over a two-field struct,
 * so every case below is arithmetic and the whole file runs in microseconds.
 * The sim's side of the same rules — that a press during the arm-up spends no
 * harpoon, that the bank escalates — lives in `leviathan.test.ts`, because
 * those are questions about the hunt rather than about the needle.
 */

/** The `centring` that makes `rateFor` return exactly 1 at level 0. */
const UNIT_RATE_CENTRING = (1 - SWEEP_SLOW) / (SWEEP_FAST - SWEEP_SLOW);

describe('the damage ramp', () => {
  it('is 100 at the centre and 0 at either end', () => {
    expect(damageAt(0)).toBe(100);
    expect(damageAt(1)).toBe(0);
    expect(damageAt(-1)).toBe(0);
  });

  it('is linear and symmetric between them', () => {
    expect(damageAt(0.5)).toBe(50);
    expect(damageAt(-0.5)).toBe(50);
    expect(damageAt(0.25)).toBe(75);
  });

  it('puts the sounding threshold in the outer tenth of the bar', () => {
    expect(damageAt(0.89)).toBeGreaterThanOrEqual(SOUND_BELOW);
    expect(damageAt(0.91)).toBeLessThan(SOUND_BELOW);
  });

  it('refuses to be poisoned by a number that is not one', () => {
    expect(damageAt(Number.NaN)).toBe(0);
    expect(damageAt(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('the sweep', () => {
  it('starts at the red edge, worth nothing at all', () => {
    /*
     * The single most important line in this file. The MVP started at
     * `sin(0)` — the MIDDLE of the bar — so the frame the gate opened was
     * worth very nearly 100 damage and tapping Space beat reading the needle.
     */
    const s = createSweep();
    arm(s);
    expect(Math.abs(position(s))).toBe(1);
    expect(damageAt(position(s))).toBe(0);
  });

  it('reaches the centre a quarter period in, at rate 1', () => {
    const s = createSweep();
    arm(s);
    const dt = 1 / 1000;
    for (let t = 0; t < DIAL_PERIOD / 4; t += dt) step(s, dt, UNIT_RATE_CENTRING, 0);
    expect(damageAt(position(s))).toBeGreaterThan(99);
  });

  it('refuses a press until the arm-up has run', () => {
    const s = createSweep();
    arm(s);
    expect(canPress(s)).toBe(false);

    step(s, ARM_UP * 0.9, 0, 0);
    expect(canPress(s)).toBe(false);

    step(s, ARM_UP * 0.2, 0, 0);
    expect(canPress(s)).toBe(true);
  });

  it('runs slower with the mark dead ahead than at the arc edge', () => {
    /*
     * Item 4, and the claim the activity rests on: steering and timing are one
     * skill rather than two taken in turn.
     */
    expect(rateFor(0, 0)).toBeCloseTo(SWEEP_SLOW, 6);
    expect(rateFor(1, 0)).toBeCloseTo(SWEEP_FAST, 6);
    expect(rateFor(1, 0)).toBeGreaterThan(rateFor(0, 0));
  });

  it('quickens with the level, in the animal own proportion', () => {
    for (let level = 1; level < LEVEL_SPEED.length; level++) {
      expect(rateFor(0, level)).toBeGreaterThan(rateFor(0, level - 1));
      expect(rateFor(0, level)).toBeCloseTo(
        SWEEP_SLOW * (LEVEL_SPEED[level] / LEVEL_SPEED[0]),
        6,
      );
    }
  });

  it('clamps a level past the end of the tables rather than reading off it', () => {
    const last = LEVEL_MULTIPLIER.length - 1;
    expect(multiplierFor(99)).toBe(LEVEL_MULTIPLIER[last]);
    expect(multiplierFor(-3)).toBe(LEVEL_MULTIPLIER[0]);
    expect(Number.isFinite(rateFor(0, 99))).toBe(true);
    expect(Number.isFinite(multiplierFor(Number.NaN))).toBe(true);
  });

  it('advances nothing on a frame that advanced no time', () => {
    const s = createSweep();
    arm(s);
    step(s, 0, 0.5, 0);
    step(s, -1, 0.5, 0);
    expect(position(s)).toBe(1);
    expect(canPress(s)).toBe(false);
  });
});

describe('the mash, which is what this all exists to beat', () => {
  it('averages a contemptible press, not a perfect one', () => {
    /*
     * A player hammering Space at 10 Hz from the moment the gate opens. Their
     * hand is not synchronised to the arming frame, so the offset inside each
     * press interval is uniform, and 1 000 trials sweep it.
     *
     * Under the MVP this averaged very nearly 100: the needle started at the
     * centre and the first press landed there. Under phase 2 the needle starts
     * at the edge and `ARM_UP` refuses everything for the first quarter
     * second, so the earliest press a masher can buy is worth about twenty.
     *
     * Deterministic on purpose — the offsets are swept rather than drawn — so
     * this can never be the test that fails one run in fifty.
     */
    const TRIALS = 1000;
    const INTERVAL = 0.1;
    let total = 0;
    let best = 0;

    for (let i = 0; i < TRIALS; i++) {
      const offset = (i / TRIALS) * INTERVAL;
      const s = createSweep();
      arm(s);

      let t = offset;
      // Step to each press instant in turn and take the first one honoured.
      let previous = 0;
      let damage = 0;
      for (let press = 0; press < 64; press++) {
        step(s, t - previous, 0, 0);
        previous = t;
        if (canPress(s)) {
          damage = damageAt(position(s));
          break;
        }
        t += INTERVAL;
      }
      total += damage;
      if (damage > best) best = damage;
    }

    const mean = total / TRIALS;
    expect(mean).toBeLessThan(50);
    // And not merely on average: no offset at all buys a green press.
    expect(best).toBeLessThan(70);
  });
});

describe('the escalation tables', () => {
  it('has one row per target, in every table', () => {
    expect(LEVEL_SPEED).toHaveLength(5);
    expect(LEVEL_HOLD).toHaveLength(5);
    expect(LEVEL_MULTIPLIER).toHaveLength(5);
  });

  it('escalates in speed, in pay, and in how little the heading commits', () => {
    for (let i = 1; i < LEVEL_SPEED.length; i++) {
      expect(LEVEL_SPEED[i]).toBeGreaterThan(LEVEL_SPEED[i - 1]);
      expect(LEVEL_MULTIPLIER[i]).toBeGreaterThan(LEVEL_MULTIPLIER[i - 1]);
      expect(LEVEL_HOLD[i][0]).toBeLessThan(LEVEL_HOLD[i - 1][0]);
      expect(LEVEL_HOLD[i][1]).toBeLessThan(LEVEL_HOLD[i - 1][1]);
    }
    for (const [lo, hi] of LEVEL_HOLD) expect(hi).toBeGreaterThan(lo);
  });

  it('keeps a bolting animal catchable', () => {
    // Every level's cruise stays under the hull's ~10.5, for `SHADOW_SPEED`'s
    // own reason: a chase the player cannot win is a hunt that ended without
    // saying so.
    for (const speed of LEVEL_SPEED) expect(speed).toBeLessThan(10.5);
  });
});

describe('the purse', () => {
  it('pays ten a point, rounded to fifty', () => {
    expect(huntGoldFor(500)).toBe(500 * HUNT_GOLD_PER_DAMAGE);
    expect(huntGoldFor(0)).toBe(0);
    expect(huntGoldFor(-5)).toBe(0);
  });

  it('lands a flawless hunt on 6 100', () => {
    const perfect = LEVEL_MULTIPLIER.reduce((sum, m) => sum + 100 * m, 0);
    expect(perfect).toBeCloseTo(610, 6);
    expect(huntGoldFor(perfect)).toBe(6100);
    // Over the best contract's 5 250, under `bounty.ts`'s 20 000 jackpot.
    expect(huntGoldFor(perfect)).toBeGreaterThan(5250);
    expect(huntGoldFor(perfect)).toBeLessThan(20000);
  });
});

describe('the bands', () => {
  it('agrees with the threshold the sim sounds on', () => {
    expect(bandFor(100)).toBe('green');
    expect(bandFor(70)).toBe('green');
    expect(bandFor(69)).toBe('yellow');
    expect(bandFor(SOUND_BELOW)).toBe('yellow');
    expect(bandFor(SOUND_BELOW - 1)).toBe('red');
    expect(bandFor(0)).toBe('red');
  });
});
