import { describe, it, expect } from 'vitest';
import {
  DRAW_SWING,
  LOSS_MAX,
  LOSS_MIN,
  LOSS_SHARE,
  WIN_TIERS,
  lossGold,
  rollDrawGold,
  rollWinGold,
} from '../../src/bounty';
import { mulberry32 } from '../../src/towns';

/**
 * `bounty.ts` is four pure functions over one table, so the whole of it is
 * pinnable here: the table's chances add up, every roll lands inside the range
 * the plan promises, and neither loss nor draw can ever take more gold than a
 * purse actually holds. That last one is what `main.ts` leans on when it hands
 * the figure straight to `wallet.lose` without checking it.
 */

const rng = mulberry32(0xb0117);

describe('bounty: the win table', () => {
  it('sums to 1 and rolls inside [500, 20000] ten thousand times', () => {
    let total = 0;
    for (const tier of WIN_TIERS) {
      total += tier.chance;
      expect(tier.min).toBeLessThan(tier.max);
    }
    expect(total).toBeCloseTo(1, 12);

    // Aggregated rather than asserted ten thousand times over: a bound that
    // is broken once is broken in the extreme, and this tier has two seconds.
    let low = Infinity;
    let high = -Infinity;
    let fractions = 0;
    for (let i = 0; i < 10000; i++) {
      const gold = rollWinGold(rng);
      if (!Number.isInteger(gold)) fractions++;
      if (gold < low) low = gold;
      if (gold > high) high = gold;
    }
    expect(fractions).toBe(0);
    expect(low).toBeGreaterThanOrEqual(500);
    expect(high).toBeLessThanOrEqual(20000);
  });
});

describe('bounty: a defeat', () => {
  it('clamps at both ends and never takes more than the purse holds', () => {
    // Under the floor: the purse is simply emptied.
    expect(lossGold(0)).toBe(0);
    expect(lossGold(200)).toBe(200);
    // At the floor: a share too small to matter still costs LOSS_MIN.
    expect(lossGold(1000)).toBe(LOSS_MIN);
    // In the band the share is what is taken.
    expect(lossGold(30000)).toBe(30000 * LOSS_SHARE);
    // Past the ceiling one bad battle stops getting worse.
    expect(lossGold(500000)).toBe(LOSS_MAX);

    let overPurse = 0;
    let overCeiling = 0;
    for (let purse = 0; purse < 400000; purse += 137) {
      const cost = lossGold(purse);
      if (cost < 0 || cost > purse) overPurse++;
      if (cost > LOSS_MAX) overCeiling++;
    }
    expect(overPurse).toBe(0);
    expect(overCeiling).toBe(0);
  });
});

describe('bounty: a stand-off', () => {
  it('swings by at most DRAW_SWING and never below what the purse can pay', () => {
    let sawGain = false;
    let sawLoss = false;
    let outOfBand = 0;
    let beyondPurse = 0;
    let fractions = 0;
    for (let i = 0; i < 5000; i++) {
      const purse = i % 700;
      const swing = rollDrawGold(rng, purse);
      if (!Number.isInteger(swing)) fractions++;
      if (swing < -DRAW_SWING || swing > DRAW_SWING) outOfBand++;
      // A purse of 300 cannot pay a 1,000-gold stand-off, and this game has
      // no concept of a debt.
      if (swing < -purse) beyondPurse++;
      if (swing > 0) sawGain = true;
      if (swing < 0) sawLoss = true;
    }
    expect(fractions).toBe(0);
    expect(outOfBand).toBe(0);
    expect(beyondPurse).toBe(0);
    expect(sawGain && sawLoss).toBe(true);
  });
});
