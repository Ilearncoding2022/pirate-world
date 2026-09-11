import { describe, it, expect } from 'vitest';
import {
  CELL_SHARE,
  GOLD_MAX,
  GOLD_MIN,
  GOLD_STEP,
  ITEMS,
  ITEM_CHANCE,
  ITEM_LABEL,
  ITEM_PRICE,
  rollSalvage,
} from '../../src/salvagebounty';
import type { SalvageItem } from '../../src/salvagebounty';
import { mulberry32 } from '../../src/towns';

/**
 * `salvagebounty.ts` is one table and one function over it, so the whole of it
 * is pinnable here: the gold band's expected value (the number the balance
 * argument in docs/SALVAGE_PLAN.md is built on), the 5% item rate, the cell's
 * half share of that 5%, and the rule that every haul costs the stream exactly
 * three values however it turns out.
 *
 * The last of those is the one that is not about tuning. `main.ts` rolls this
 * off the same seeded stream a world's salvage is drawn from, and a haul that
 * consumed a variable count would make every later raft in that world depend on
 * what the earlier ones happened to contain.
 */

describe('salvagebounty: the gold band', () => {
  it('pays round hundreds inside [100, 1000] with an expected value of 550', () => {
    const rng = mulberry32(0x5a1a6e);
    const counts = new Map<number, number>();
    const runs = 200000;
    let total = 0;

    for (let i = 0; i < runs; i++) {
      const { gold } = rollSalvage(rng);
      total += gold;
      counts.set(gold, (counts.get(gold) ?? 0) + 1);
    }

    // The band, exactly: ten values, no eleventh, nothing off-step.
    expect(counts.size).toBe(10);
    for (const value of counts.keys()) {
      expect(value).toBeGreaterThanOrEqual(GOLD_MIN);
      expect(value).toBeLessThanOrEqual(GOLD_MAX);
      expect(value % GOLD_STEP).toBe(0);
    }

    // 550 is the figure the whole balance argument is written against: at the
    // roll's 9.5% ceiling it is what makes salvage ~310 gold a minute rather
    // than the first draft's ~2800.
    //
    // Bounded rather than `toBeCloseTo`, and the width is not arbitrary: the
    // band's standard deviation is 287 gold, so the mean of 200 000 draws has a
    // standard error of about 0.64 and a half-gold tolerance would fail on an
    // honest table about half the time. Five gold is eight standard errors --
    // loose enough never to flake, tight enough that a band shifted by one step
    // (100 gold) is caught instantly.
    expect(Math.abs(total / runs - 550)).toBeLessThan(5);

    // Uniform, not merely in range. Every value within 5% of a tenth.
    for (const count of counts.values()) {
      expect(count / runs).toBeGreaterThan(0.095);
      expect(count / runs).toBeLessThan(0.105);
    }
  });
});

describe('salvagebounty: the consumable', () => {
  it('rides one raft in twenty, and half of those are a cell', () => {
    const rng = mulberry32(0xc0ffee);
    const runs = 200000;
    let withItem = 0;
    let cells = 0;
    const seen = new Set<SalvageItem>();

    for (let i = 0; i < runs; i++) {
      const { item } = rollSalvage(rng);
      if (item === null) continue;
      withItem++;
      seen.add(item);
      if (item === 'cell') cells++;
    }

    expect(withItem / runs).toBeCloseTo(ITEM_CHANCE, 3);
    // Ten thousand laden rafts put the standard error on this share at 0.005,
    // so the window is 0.02 -- four of those, and still a quarter of the gap to
    // the nearest wrong answer the table could hold (0.1, a sixth even split).
    expect(Math.abs(cells / withItem - CELL_SHARE)).toBeLessThan(0.02);

    // Every item is reachable. A table entry that can never be drawn is a
    // promise in the shop's own currency that the sea never keeps.
    expect(seen.size).toBe(ITEMS.length);
    for (const item of ITEMS) expect(seen.has(item)).toBe(true);
  });

  it('pays the chandlery price in gold when the locker is full, and says which', () => {
    const rng = mulberry32(0x10cced);
    let converted = 0;

    for (let i = 0; i < 20000; i++) {
      const haul = rollSalvage(rng, () => false);
      // Nothing is ever stowed, so `item` is always null and a raft that was
      // carrying something says so in `soldOn` instead.
      expect(haul.item).toBeNull();
      if (haul.soldOn === null) {
        expect(haul.gold).toBeLessThanOrEqual(GOLD_MAX);
        continue;
      }
      converted++;
      // The gold is the band plus that item's own price, never another's.
      const extra = haul.gold - ITEM_PRICE[haul.soldOn];
      expect(extra).toBeGreaterThanOrEqual(GOLD_MIN);
      expect(extra).toBeLessThanOrEqual(GOLD_MAX);
      expect(extra % GOLD_STEP).toBe(0);
    }

    // The conversion is the 5% gate, unchanged: a full ship meets exactly as
    // many laden rafts as an empty one, it just banks them instead.
    expect(converted / 20000).toBeCloseTo(ITEM_CHANCE, 2);
  });

  it('respects room per item, so a full cell locker still lands a harpoon bundle', () => {
    const rng = mulberry32(0x5a1fe1);
    let cellsStowed = 0;
    let cellsSold = 0;
    let othersStowed = 0;

    for (let i = 0; i < 20000; i++) {
      const haul = rollSalvage(rng, (item) => item !== 'cell');
      if (haul.item === 'cell') cellsStowed++;
      if (haul.soldOn === 'cell') cellsSold++;
      if (haul.item !== null && haul.item !== 'cell') othersStowed++;
    }

    expect(cellsStowed).toBe(0);
    expect(cellsSold).toBeGreaterThan(0);
    expect(othersStowed).toBeGreaterThan(0);
  });
});

describe('salvagebounty: the stream', () => {
  it('spends exactly three draws per haul, whatever the haul is', () => {
    // Counted rather than inferred: the rule is about the COUNT, so the test
    // has to be about the count. Both paths through the item branch and both
    // sides of the room test are covered by the length of the run.
    for (const room of [true, false]) {
      let draws = 0;
      const source = mulberry32(0xd3a75);
      const counting = (): number => {
        draws++;
        return source();
      };
      for (let i = 1; i <= 5000; i++) {
        rollSalvage(counting, () => room);
        expect(draws).toBe(i * 3);
      }
    }
  });

  it('replays: the same seed gives the same hauls', () => {
    const a = mulberry32(0x5eed);
    const b = mulberry32(0x5eed);
    for (let i = 0; i < 500; i++) {
      expect(rollSalvage(a)).toEqual(rollSalvage(b));
    }
  });
});

describe('salvagebounty: the labels', () => {
  it('names every item for the notice strip', () => {
    for (const item of ITEMS) {
      expect(ITEM_LABEL[item].length).toBeGreaterThan(0);
      expect(ITEM_LABEL[item]).toBe(ITEM_LABEL[item].toUpperCase());
      expect(ITEM_PRICE[item]).toBeGreaterThan(0);
    }
  });
});
