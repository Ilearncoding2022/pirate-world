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
    const data: SaveData = { version: 1, gold: 1565, fishBook: { 'grey-mullet': 3, eel: 1 } };
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
    expect(() => writeSave({ version: 1, gold: 1, fishBook: {} })).not.toThrow();
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
});
