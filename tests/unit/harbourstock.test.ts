import { describe, it, expect } from 'vitest';
import { createHarbourStock, LINE_MIN_HARBOURS, UPGRADE_LINES } from '../../src/harbourstock';
import { HARBOUR_NAMES, HARBOUR_COUNT } from '../../src/harbournames';
import { mulberry32 } from '../../src/towns';
import type { UpgradeLine } from '../../src/types';

/**
 * `harbourstock.ts` on its own: the verbatim path, the re-roll, and the one
 * promise the whole all-at-once design exists to make -- that every upgrade
 * ladder is sold at at least `LINE_MIN_HARBOURS` of the thirty-six.
 *
 * The coverage case runs a thousand seeded rolls rather than one, because the
 * guarantee is about a distribution and a single roll passing says nothing
 * about the next one. A thousand costs about a hundred milliseconds, which is
 * inside `docs/TESTING.md`'s budget for the tier by two orders of magnitude.
 */

/** A full table: every name in `names`, carrying everything. */
function fullTable(names: readonly string[]): Record<string, UpgradeLine[]> {
  const table: Record<string, UpgradeLine[]> = {};
  for (const name of names) table[name] = [...UPGRADE_LINES];
  return table;
}

/** How many harbours in a snapshot carry each line. */
function counts(table: Record<string, UpgradeLine[]>): Map<UpgradeLine, number> {
  const out = new Map<UpgradeLine, number>();
  for (const line of UPGRADE_LINES) out.set(line, 0);
  for (const lines of Object.values(table)) {
    for (const line of lines) out.set(line, (out.get(line) ?? 0) + 1);
  }
  return out;
}

describe('harbourstock', () => {
  it('keeps a full saved table verbatim, and does not announce a roll', () => {
    const saved: Record<string, UpgradeLine[]> = fullTable(HARBOUR_NAMES);
    // One harbour with something other than the lot, so "verbatim" is a real
    // claim rather than one that any table would satisfy.
    saved.Rustwharf = ['governor'];

    const stock = createHarbourStock(saved);
    let announced = 0;
    stock.onChange(() => announced++);

    expect(stock.linesFor('Rustwharf')).toEqual(['governor']);
    expect(stock.snapshot()).toEqual(saved);
    // Nothing was rolled, so nothing needs writing: the file already has it.
    expect(announced).toBe(0);
  });

  it('keeps names it does not recognise, the way the fish book keeps species', () => {
    const saved = fullTable(HARBOUR_NAMES);
    saved['A Harbour From A Later Build'] = ['trim'];
    const stock = createHarbourStock(saved);
    expect(stock.snapshot()['A Harbour From A Later Build']).toEqual(['trim']);
  });

  it('re-rolls the WHOLE table when even one name is missing, and says so once', () => {
    const saved = fullTable(HARBOUR_NAMES);
    // One hole. Every other harbour carried all four; after the re-roll
    // essentially none of them can, which is what makes the table observably
    // new rather than patched.
    delete saved[HARBOUR_NAMES[7]];

    const stock = createHarbourStock(saved, HARBOUR_NAMES, mulberry32(4));
    let announced = 0;
    stock.onChange(() => announced++);

    const table = stock.snapshot();
    expect(Object.keys(table).sort()).toEqual([...HARBOUR_NAMES].sort());
    const untouched = HARBOUR_NAMES.filter((n) => table[n].length === UPGRADE_LINES.length);
    expect(untouched.length).toBeLessThan(HARBOUR_COUNT);
    // Exactly once, so the save is written once and not per subscriber.
    expect(announced).toBe(1);
  });

  it('rolls from scratch for a player with no file at all', () => {
    const stock = createHarbourStock({}, HARBOUR_NAMES, mulberry32(11));
    let announced = 0;
    stock.onChange(() => announced++);
    expect(Object.keys(stock.snapshot())).toHaveLength(HARBOUR_COUNT);
    expect(announced).toBe(1);
  });

  it('carries every line at six harbours or more, over a thousand seeded rolls', () => {
    for (let seed = 0; seed < 1000; seed++) {
      const stock = createHarbourStock({}, HARBOUR_NAMES, mulberry32(seed));
      const table = stock.snapshot();
      for (const [line, count] of counts(table)) {
        expect(count, `line ${line} at seed ${seed}`).toBeGreaterThanOrEqual(LINE_MIN_HARBOURS);
      }
    }
  });

  it('never leaves a harbour with nothing to sell', () => {
    for (let seed = 0; seed < 1000; seed++) {
      const table = createHarbourStock({}, HARBOUR_NAMES, mulberry32(seed)).snapshot();
      for (const name of HARBOUR_NAMES) {
        expect(table[name].length, `${name} at seed ${seed}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('keeps the guarantee even when the draw itself refuses to cooperate', () => {
    /*
     * A generator that never gives a harbour anything: every line coin comes
     * up above the odds, and the consolation pick always lands on the same
     * line. No number of re-rolls can satisfy the floor from that, so this is
     * the one case that reaches `topUp` -- and the point of the case is that
     * the store terminates and still keeps its promise rather than spinning.
     */
    const stock = createHarbourStock({}, HARBOUR_NAMES, () => 0.99);
    const table = stock.snapshot();
    for (const [line, count] of counts(table)) {
      expect(count, `line ${line}`).toBeGreaterThanOrEqual(LINE_MIN_HARBOURS);
    }
  });

  it('returns nothing for a harbour that is not in the table', () => {
    const stock = createHarbourStock(fullTable(HARBOUR_NAMES));
    expect(stock.linesFor('Nowhere At All')).toEqual([]);
  });

  it('hands out copies, so a caller cannot edit the table through them', () => {
    const stock = createHarbourStock({}, HARBOUR_NAMES, mulberry32(3));
    const first = stock.snapshot();
    first[HARBOUR_NAMES[0]].push('trim');
    first[HARBOUR_NAMES[0]].push('trim');
    expect(stock.snapshot()[HARBOUR_NAMES[0]]).not.toEqual(first[HARBOUR_NAMES[0]]);
  });
});
