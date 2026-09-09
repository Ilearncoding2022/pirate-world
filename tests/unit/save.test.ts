import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadSave, writeSave, createRecords, SAVE_KEY, EMPTY_SAVE } from '../../src/save';
import type { SaveData } from '../../src/types';

/**
 * A minimal in-memory `Storage`, since vitest's `node` environment has no
 * `localStorage` at all -- `globalThis.localStorage` is simply undefined,
 * which `save.ts`'s own `storage()` already tolerates. This shim exists so
 * the round-trip half of the contract has something to round-trip through.
 */
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

let fake: FakeStorage;

beforeEach(() => {
  fake = new FakeStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: fake,
    configurable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('save', () => {
  it('round-trips a well-formed save', () => {
    const data: SaveData = {
      version: 1,
      gold: 1565,
      fishBook: { 'grey-mullet': 3, eel: 1 },
      reserve: 32,
      harpoons: 15,
      seaAnchors: 2,
      overdriveCoils: 1,
      chumDrums: 3,
      barbedHeads: 4,
      trimTier: 2,
      moonglassTier: 1,
      arcLampTier: 3,
      governorTier: 2,
      hull: 74,
      knownHarbours: ['Rustwharf', 'Neon Reach'],
      harbourStock: { Rustwharf: ['trim', 'governor'] },
    };
    writeSave(data);
    const loaded = loadSave();
    expect(loaded).toEqual(data);
  });

  it('returns EMPTY_SAVE when nothing has been written', () => {
    expect(loadSave()).toEqual(EMPTY_SAVE);
  });

  it('tolerates unparsable JSON', () => {
    fake.setItem(SAVE_KEY, 'not json at all {{{');
    expect(loadSave()).toEqual(EMPTY_SAVE);
  });

  it('tolerates a save from an unknown version', () => {
    fake.setItem(SAVE_KEY, JSON.stringify({ version: 2, gold: 999, fishBook: {} }));
    expect(loadSave()).toEqual(EMPTY_SAVE);
  });

  it('tolerates a non-object payload', () => {
    fake.setItem(SAVE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadSave()).toEqual(EMPTY_SAVE);
  });

  it('repairs one bad field without discarding the rest', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ version: 1, gold: 'lots', fishBook: { cod: 4, bad: 'nope', zero: 0 } }),
    );
    const loaded = loadSave();
    expect(loaded.gold).toBe(0); // unreadable gold -> 0
    expect(loaded.fishBook.cod).toBe(4); // good entry survives
    expect(loaded.fishBook.bad).toBeUndefined(); // bad entry dropped
    expect(loaded.fishBook.zero).toBeUndefined(); // a zero count is "never caught"
  });

  it('keeps unknown fishBook ids rather than pruning them', () => {
    fake.setItem(SAVE_KEY, JSON.stringify({ version: 1, gold: 10, fishBook: { 'not-a-real-species': 2 } }));
    const loaded = loadSave();
    expect(loaded.fishBook['not-a-real-species']).toBe(2);
  });

  it('never throws when localStorage itself throws on access', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(() => loadSave()).not.toThrow();
    expect(loadSave()).toEqual(EMPTY_SAVE);
    expect(() => writeSave(EMPTY_SAVE)).not.toThrow();
  });

  it('createRecords wires the wallet and the fish book to persistence', () => {
    fake.setItem(SAVE_KEY, JSON.stringify({ version: 1, gold: 40, fishBook: { cod: 2 } }));
    const records = createRecords();
    expect(records.wallet.gold).toBe(40);
    expect(records.book.count('cod')).toBe(2);

    records.wallet.add(10);
    const persisted = JSON.parse(fake.getItem(SAVE_KEY)!) as SaveData;
    expect(persisted.gold).toBe(50);
    expect(persisted.fishBook.cod).toBe(2);
  });

  /*
   * The shop's two fields were added to version 1 rather than bumping it, so
   * the load path has to be tolerant in both directions: a file written before
   * the shop existed must open with an empty locker and no cell, and an edited
   * file must not be able to claim more of either than the ceilings allow.
   */
  it('treats a pre-shop save as one with nothing bought', () => {
    fake.setItem(SAVE_KEY, JSON.stringify({ version: 1, gold: 40, fishBook: { cod: 2 } }));
    const loaded = loadSave();
    expect(loaded.reserve).toBe(0);
    expect(loaded.harpoons).toBe(0);
    expect(loaded.gold).toBe(40);
    // Same rule for every one of the eight fields docs/SHOP_PLAN.md added:
    // absent means never bought, not damage.
    expect(loaded.seaAnchors).toBe(0);
    expect(loaded.overdriveCoils).toBe(0);
    expect(loaded.chumDrums).toBe(0);
    expect(loaded.barbedHeads).toBe(0);
    expect(loaded.trimTier).toBe(0);
    expect(loaded.moonglassTier).toBe(0);
    expect(loaded.arcLampTier).toBe(0);
    expect(loaded.governorTier).toBe(0);
  });

  it('clamps a backup charge and a harpoon count to their ceilings', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ version: 1, gold: 0, fishBook: {}, reserve: 900, harpoons: 5000 }),
    );
    const loaded = loadSave();
    expect(loaded.reserve).toBe(100);
    expect(loaded.harpoons).toBe(100);
  });

  it('clamps every new stock and tier field to its own ceiling', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({
        version: 1,
        gold: 0,
        fishBook: {},
        seaAnchors: 999,
        overdriveCoils: 999,
        chumDrums: 999,
        barbedHeads: 999,
        trimTier: 999,
        moonglassTier: 999,
        arcLampTier: 999,
        governorTier: 999,
      }),
    );
    const loaded = loadSave();
    expect(loaded.seaAnchors).toBe(5);
    expect(loaded.overdriveCoils).toBe(3);
    expect(loaded.chumDrums).toBe(5);
    expect(loaded.barbedHeads).toBe(5);
    expect(loaded.trimTier).toBe(3);
    expect(loaded.moonglassTier).toBe(3);
    expect(loaded.arcLampTier).toBe(3);
    expect(loaded.governorTier).toBe(3);
  });

  it('keeps the rest of a save whose shop fields are unreadable', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ version: 1, gold: 77, fishBook: { cod: 1 }, reserve: 'full', harpoons: -3 }),
    );
    const loaded = loadSave();
    expect(loaded.gold).toBe(77);
    expect(loaded.fishBook.cod).toBe(1);
    expect(loaded.reserve).toBe(0);
    expect(loaded.harpoons).toBe(0);
  });

  it('createRecords persists a purchase made through the stores', () => {
    const records = createRecords();
    records.battery.charge();
    records.harpoons.buy();
    records.seaAnchor.buy();
    records.trim.buy();

    const persisted = JSON.parse(fake.getItem(SAVE_KEY)!) as SaveData;
    // Whole percent of a MAIN tank, which is the file's own unit for the cell.
    expect(persisted.reserve).toBe(50);
    expect(persisted.harpoons).toBe(5);
    expect(persisted.seaAnchors).toBe(1);
    expect(persisted.trimTier).toBe(1);
  });

  it('createRecords persists a Sea Anchor deploy as one fewer in stock', () => {
    // deploy() spends through the stock the same way buy() fills it -- the
    // save file only ever sees the count, never the deploy timer.
    const records = createRecords();
    records.seaAnchor.buy();
    records.seaAnchor.buy();
    records.seaAnchor.deploy();

    const persisted = JSON.parse(fake.getItem(SAVE_KEY)!) as SaveData;
    expect(persisted.seaAnchors).toBe(1);
  });
});
