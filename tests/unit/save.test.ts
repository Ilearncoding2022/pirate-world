import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadSave, writeSave, createRecords, SAVE_KEY, EMPTY_SAVE } from '../../src/save';
import type { SaveData } from '../../src/types';
import { HARBOUR_NAMES, HARBOUR_COUNT } from '../../src/harbournames';
import { MAX_ACTIVE, REPUTATION_FLOOR } from '../../src/questconstants';

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
      reputation: 35,
      questSeed: 3141592653,
      quests: [
        {
          id: 'd0|Rustwharf|1|Neon Reach',
          kind: 'DELIVERY',
          tier: 1,
          issuer: 'Rustwharf',
          target: 'Neon Reach',
          window: 'NIGHT',
          duration: 225,
          coverage: null,
          gold: 750,
          reputation: 15,
          brief: 'Carry salvage to NEON REACH',
          remaining: 180,
        },
      ],
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

  /*
   * The three fields docs/HARBOURS_PLAN.md added, on exactly the terms the
   * shop's eight were added on: version 1, per-field repair, absent means the
   * default rather than damage. The round trip is in the first case in this
   * file; what follows is the repair half, one bad shape at a time.
   */
  it('treats a save written before the hull existed as a sound ship', () => {
    fake.setItem(SAVE_KEY, JSON.stringify({ version: 1, gold: 40, fishBook: { cod: 2 } }));
    const loaded = loadSave();
    // 100 and not 0, which is the whole reason `hull` is not read through
    // `readCapped`: a zero here would be a scuttled ship on a file whose
    // owner has never seen a hull reading in their life.
    expect(loaded.hull).toBe(100);
    expect(loaded.knownHarbours).toEqual([]);
    expect(loaded.harbourStock).toEqual({});
    expect(loaded.gold).toBe(40);
  });

  it('repairs a hull that is not a number, and clamps one that is out of range', () => {
    function hullOf(value: unknown): number {
      fake.setItem(SAVE_KEY, JSON.stringify({ version: 1, gold: 0, fishBook: {}, hull: value }));
      return loadSave().hull;
    }
    expect(hullOf('sound')).toBe(100);
    expect(hullOf(null)).toBe(100);
    // The floor matters as much as the ceiling: there is no sinking, so 0 and
    // -40 are both 1 rather than both nothing.
    expect(hullOf(0)).toBe(1);
    expect(hullOf(-40)).toBe(1);
    expect(hullOf(900)).toBe(100);
    expect(hullOf(63.4)).toBe(63);
  });

  it('drops the unreadable names out of knownHarbours and keeps the rest', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({
        version: 1,
        gold: 5,
        fishBook: {},
        knownHarbours: ['Rustwharf', 7, '', null, 'Ionport', 'Rustwharf'],
      }),
    );
    const loaded = loadSave();
    // Order is first-visit order, the duplicate is dropped because the store
    // is a set either way, and the two good names survive their neighbours.
    expect(loaded.knownHarbours).toEqual(['Rustwharf', 'Ionport']);
    expect(loaded.gold).toBe(5);
  });

  it('repairs a knownHarbours that is not an array at all', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ version: 1, gold: 5, fishBook: {}, knownHarbours: 'Rustwharf' }),
    );
    expect(loadSave().knownHarbours).toEqual([]);
  });

  it('drops a harbour whose stock list is unreadable, and keeps the good ones', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({
        version: 1,
        gold: 5,
        fishBook: {},
        harbourStock: {
          Rustwharf: ['trim', 'governor'],
          Ionport: ['trim', 'not-a-line'],
          'Lumen Bay': 'trim',
          'Neon Reach': [],
        },
      }),
    );
    const loaded = loadSave();
    expect(loaded.harbourStock.Rustwharf).toEqual(['trim', 'governor']);
    // A harbour with a bad entry is dropped WHOLE rather than left with a
    // partial list -- `harbourstock.ts` re-rolls the entire table when any
    // name is missing, so a hole is a signal and a half-list would not be.
    expect(loaded.harbourStock.Ionport).toBeUndefined();
    expect(loaded.harbourStock['Lumen Bay']).toBeUndefined();
    // An empty list is a real answer: a harbour that sells no upgrades.
    expect(loaded.harbourStock['Neon Reach']).toEqual([]);
  });

  it('repairs a harbourStock that is not an object at all', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ version: 1, gold: 5, fishBook: {}, harbourStock: ['trim'] }),
    );
    expect(loadSave().harbourStock).toEqual({});
  });

  it('createRecords persists a new mooring by name', () => {
    const records = createRecords();
    records.known.add('Rustwharf');
    expect(JSON.parse(fake.getItem(SAVE_KEY)!).knownHarbours).toEqual(['Rustwharf']);

    // The frame loop's own case: the ship sits alongside and `add` runs every
    // frame. One name in the file, and no second write.
    for (let i = 0; i < 30; i++) records.known.add('Rustwharf');
    expect(JSON.parse(fake.getItem(SAVE_KEY)!).knownHarbours).toEqual(['Rustwharf']);
  });

  it('createRecords rolls the upgrade table at boot and writes it', () => {
    const records = createRecords();
    const persisted = JSON.parse(fake.getItem(SAVE_KEY)!) as SaveData;
    // All thirty-six, on disk, before the player has done anything at all --
    // which is what makes the table survive into the next world.
    expect(Object.keys(persisted.harbourStock)).toHaveLength(HARBOUR_COUNT);
    expect(records.stock.linesFor(HARBOUR_NAMES[0]).length).toBeGreaterThanOrEqual(1);
  });

  it('createRecords keeps a saved upgrade table rather than re-rolling it', () => {
    const table: Record<string, string[]> = {};
    for (const name of HARBOUR_NAMES) table[name] = ['trim'];
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ version: 1, gold: 0, fishBook: {}, harbourStock: table }),
    );

    const records = createRecords();
    // Verbatim: a harbour the player remembers keeps the upgrades it had, and
    // that promise is the whole reason the roll is saved at all.
    expect(records.stock.linesFor(HARBOUR_NAMES[5])).toEqual(['trim']);
    expect(JSON.parse(fake.getItem(SAVE_KEY)!).harbourStock).toEqual(table);
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
  /* ---------------------------------------------------------------- */
  /* Contracts, reputation and the board seed                          */
  /* ---------------------------------------------------------------- */

  /**
   * One saved contract, as `save.ts` will read it back. Kept as a builder so a
   * case can spoil exactly one field and leave the rest well-formed, which is
   * the only way to tell "this field is rejected" from "the whole entry is".
   */
  function savedQuest(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'd0|Rustwharf|1|Ionport',
      kind: 'DELIVERY',
      tier: 2,
      issuer: 'Rustwharf',
      target: 'Ionport',
      window: 'DAYLIGHT',
      duration: 450,
      coverage: null,
      gold: 1200,
      reputation: 25,
      brief: 'Carry mail to IONPORT',
      remaining: 210,
      ...over,
    };
  }

  it('round-trips reputation, the board seed and a contract', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ ...EMPTY_SAVE, reputation: 45, questSeed: 987654321, quests: [savedQuest()] }),
    );
    const loaded = loadSave();
    expect(loaded.reputation).toBe(45);
    expect(loaded.questSeed).toBe(987654321);
    expect(loaded.quests).toHaveLength(1);
    expect(loaded.quests[0].target).toBe('Ionport');
    expect(loaded.quests[0].window).toBe('DAYLIGHT');
    expect(loaded.quests[0].remaining).toBe(210);
  });

  it('defaults all three on a save written before contracts existed', () => {
    // Absent is not damage, on the rule every field added to version 1 follows:
    // a player who predates the feature has no contracts and no standing, which
    // is exactly what these defaults say about them.
    fake.setItem(SAVE_KEY, JSON.stringify({ version: 1, gold: 10, fishBook: {} }));
    const loaded = loadSave();
    expect(loaded.reputation).toBe(0);
    expect(loaded.questSeed).toBe(0);
    expect(loaded.quests).toEqual([]);
  });

  it('keeps a NEGATIVE reputation, which no other field in this file may be', () => {
    fake.setItem(SAVE_KEY, JSON.stringify({ ...EMPTY_SAVE, reputation: -35 }));
    expect(loadSave().reputation).toBe(-35);
  });

  it('brings an edited reputation up to the floor rather than trusting it', () => {
    fake.setItem(SAVE_KEY, JSON.stringify({ ...EMPTY_SAVE, reputation: -100000 }));
    expect(loadSave().reputation).toBe(REPUTATION_FLOOR);
  });

  it('discards an unreadable reputation and keeps the rest of the file', () => {
    fake.setItem(SAVE_KEY, JSON.stringify({ ...EMPTY_SAVE, gold: 700, reputation: 'lots' }));
    const loaded = loadSave();
    expect(loaded.reputation).toBe(0);
    expect(loaded.gold).toBe(700);
  });

  it('drops a chart goal, because the sea it measured is gone', () => {
    /*
     * `docs/QUESTS_PLAN.md`, interpretation 4. The chart is wiped with the
     * world -- it lives under its own key and is checked against the world seed
     * -- so a goal that asked for 20% of an ocean that no longer exists would
     * silently restart from zero, which reads as a bug rather than as a rule.
     */
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({
        ...EMPTY_SAVE,
        quests: [
          savedQuest(),
          { ...savedQuest({ id: 'chart|0.2', kind: 'CHART', target: null }) },
        ],
      }),
    );
    const loaded = loadSave();
    expect(loaded.quests).toHaveLength(1);
    expect(loaded.quests[0].kind).toBe('DELIVERY');
  });

  it('drops one bad contract out of three and keeps the other two', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({
        ...EMPTY_SAVE,
        quests: [
          savedQuest({ id: 'a' }),
          savedQuest({ id: 'b', tier: 9 }),
          savedQuest({ id: 'c' }),
        ],
      }),
    );
    expect(loadSave().quests.map((q) => q.id)).toEqual(['a', 'c']);
  });

  it('drops a contract with no destination, rather than keeping a slot with nothing in it', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ ...EMPTY_SAVE, quests: [savedQuest({ target: null })] }),
    );
    expect(loadSave().quests).toEqual([]);
  });

  it('drops a contract with no clock, which could never expire', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ ...EMPTY_SAVE, quests: [savedQuest({ remaining: null })] }),
    );
    expect(loadSave().quests).toEqual([]);
  });

  it('keeps a target this build cannot place, on knownHarbours’ terms', () => {
    // A harbour from a longer name table is still a harbour the player is
    // carrying work to; `quests.ts` re-resolves by name on every frame.
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ ...EMPTY_SAVE, quests: [savedQuest({ target: 'Somewhere Newer' })] }),
    );
    expect(loadSave().quests[0].target).toBe('Somewhere Newer');
  });

  it('keeps a kind this build never generates, so a later save survives the trip', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ ...EMPTY_SAVE, quests: [savedQuest({ kind: 'EXPEDITION' })] }),
    );
    expect(loadSave().quests[0].kind).toBe('EXPEDITION');
  });

  it('clamps a clock edited past the deadline it was issued with', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ ...EMPTY_SAVE, quests: [savedQuest({ duration: 300, remaining: 99999 })] }),
    );
    expect(loadSave().quests[0].remaining).toBe(300);
  });

  it('never loads more than MAX_ACTIVE, however many the file claims', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({
        ...EMPTY_SAVE,
        quests: Array.from({ length: MAX_ACTIVE + 4 }, (_, i) => savedQuest({ id: `q${i}` })),
      }),
    );
    expect(loadSave().quests).toHaveLength(MAX_ACTIVE);
  });

  it('drops a duplicate id, which would be two clocks on one contract', () => {
    fake.setItem(
      SAVE_KEY,
      JSON.stringify({ ...EMPTY_SAVE, quests: [savedQuest({ id: 'same' }), savedQuest({ id: 'same' })] }),
    );
    expect(loadSave().quests).toHaveLength(1);
  });

  it('discards a quests field that is not an array and keeps the rest', () => {
    fake.setItem(SAVE_KEY, JSON.stringify({ ...EMPTY_SAVE, gold: 88, quests: 'three' }));
    const loaded = loadSave();
    expect(loaded.quests).toEqual([]);
    expect(loaded.gold).toBe(88);
  });

  it('createRecords draws a board seed where the file has none, and keeps one it has', () => {
    // Zero is the sentinel for "never drawn" rather than a seed of zero, which
    // is why a fresh draw can never come back as zero either.
    const fresh = createRecords();
    expect(fresh.questSeed).not.toBe(0);

    fake.setItem(SAVE_KEY, JSON.stringify({ ...EMPTY_SAVE, questSeed: 4242 }));
    expect(createRecords().questSeed).toBe(4242);
  });

  it('createRecords writes standing through to the file', () => {
    const records = createRecords();
    records.reputation.award(30);
    expect((JSON.parse(fake.getItem(SAVE_KEY)!) as SaveData).reputation).toBe(30);
    records.reputation.penalise(5);
    expect((JSON.parse(fake.getItem(SAVE_KEY)!) as SaveData).reputation).toBe(25);
  });

  it('createRecords writes the loaded contracts back before the sim is attached', () => {
    /*
     * The failure this exists to catch: a catch in the first second of a session
     * fires `persist`, and if `persist` read an empty sim instead of the loaded
     * file it would be the write that erased three contracts in hand.
     */
    fake.setItem(SAVE_KEY, JSON.stringify({ ...EMPTY_SAVE, quests: [savedQuest({ id: 'held' })] }));
    const records = createRecords();
    records.wallet.add(10);
    const persisted = JSON.parse(fake.getItem(SAVE_KEY)!) as SaveData;
    expect(persisted.quests.map((q) => q.id)).toEqual(['held']);
  });

  it('createRecords persists whatever the attached sim reports, on every event', () => {
    const records = createRecords();
    let fire: (() => void) | null = null;
    let snapshot: ReturnType<typeof savedQuest>[] = [];
    records.attachQuests({
      snapshot: () => snapshot as never,
      on: (fn: () => void) => {
        fire = fn;
        return (): void => undefined;
      },
    });
    // `attachQuests` writes once itself, so the file already agrees with the sim.
    expect((JSON.parse(fake.getItem(SAVE_KEY)!) as SaveData).quests).toEqual([]);

    snapshot = [savedQuest({ id: 'taken' })];
    fire!();
    expect((JSON.parse(fake.getItem(SAVE_KEY)!) as SaveData).quests.map((q) => q.id)).toEqual([
      'taken',
    ]);
  });
});
