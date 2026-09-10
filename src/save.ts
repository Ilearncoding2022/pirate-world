import type { ActiveQuest, QuestKind, QuestTier, QuestWindow, SaveData, UpgradeLine } from './types';
import type { Wallet } from './wallet';
import type { FishBookStore } from './fishbook';
import type { Battery } from './battery';
import type { HarpoonStore } from './harpoons';
import type { SeaAnchorStore } from './seaanchor';
import type { OverdriveStore } from './overdrive';
import type { ChumDrumStore } from './chumdrum';
import type { BarbedHeadsStore } from './barbedheads';
import type { TrimStore } from './trim';
import type { MoonglassStore } from './moonglass';
import type { ArcLampStore } from './arclamp';
import type { GovernorStore } from './governor';
import type { Hull } from './hull';
import { createWallet } from './wallet';
import { createFishBookStore } from './fishbook';
import { BATTERY_CAPACITY, createBattery } from './battery';
import { HARPOON_STORE_MAX, createHarpoonStore } from './harpoons';
import { SEA_ANCHOR_STORE_MAX, createSeaAnchorStore } from './seaanchor';
import { OVERDRIVE_STORE_MAX, createOverdriveStore } from './overdrive';
import { CHUM_DRUM_STORE_MAX, createChumDrumStore } from './chumdrum';
import { BARBED_HEADS_STORE_MAX, createBarbedHeadsStore } from './barbedheads';
import { TRIM_TIER_MAX, createTrimStore } from './trim';
import { MOONGLASS_TIER_MAX, createMoonglassStore } from './moonglass';
import { ARC_LAMP_TIER_MAX, createArcLampStore } from './arclamp';
import { GOVERNOR_TIER_MAX, createGovernorStore } from './governor';
import { HULL_MIN, createHull } from './hull';
import type { KnownHarbours } from './knownharbours';
import type { HarbourStock } from './harbourstock';
import { createKnownHarbours } from './knownharbours';
import { createHarbourStock } from './harbourstock';
import type { Reputation } from './reputation';
import { createReputation } from './reputation';
import { MAX_ACTIVE, REPUTATION_FLOOR } from './questconstants';

/**
 * save.ts — localStorage, versioned, and tolerant of anything it finds there.
 *
 * Two rules run through the whole file.
 *
 * **A player who cannot save must still be able to fish.** Every read and
 * every write is wrapped: `localStorage` is not merely empty in Safari's
 * private mode or under a "block site data" setting, it *throws on access* —
 * on the property itself, before any method is called. A quota-exceeded
 * `setItem` throws too, and that one can happen mid-session on a machine that
 * was saving happily a minute earlier. None of those may reach the game loop.
 *
 * **Repair, do not reset.** A file that is the right version but has one bad
 * field is a player's history with a scratch on it. The scratch is discarded
 * and the rest kept; only damage that makes the file unreadable as a whole —
 * unparsable, not an object, or a version this build does not know — costs the
 * lot. See `sanitize` for exactly where that line falls.
 */
export const SAVE_KEY = 'pirate-world.save';

/**
 * Where the explored chart lives. Its OWN key, beside this file rather than
 * inside it.
 *
 * `SaveData` is two numbers and twenty counts, rewritten in full on every
 * catch, purchase and whole percent of battery -- the comment on `writeSave`
 * below says there is nothing to amortise, and for that file there is not.
 * The chart is 87 KB and changes continuously while the ship explores, so it
 * has the opposite cadence and would have dragged this one onto it. Kept
 * apart, each writes at the rate it should: this one on every event, the
 * chart at most every few seconds.
 *
 * The consequence, which is the price: clearing a player's progress means
 * clearing two keys, not one. Recorded here so the second is not forgotten.
 */
export const CHART_KEY = 'pirate-world.chart';

/**
 * The only version this build writes or accepts.
 *
 * A future version 2 loader keeps this constant and adds a migration; it does
 * NOT widen the accept test, because the whole value of the field is that an
 * unrecognised number is a definite answer rather than a guess.
 *
 * The shop's fields — `reserve` and `harpoons` first, and now the eight
 * fields `docs/SHOP_PLAN.md` added (`seaAnchors`, `overdriveCoils`,
 * `chumDrums`, `barbedHeads`, `trimTier`, `moonglassTier`, `arcLampTier`,
 * `governorTier`) — were ADDED to version 1 rather than justifying a version
 * 2, and that is the right call under this file's own rules each time. A
 * version bump means "every field below is of unknown meaning", which is a
 * claim about the file that would be false: a v1 save from a build that
 * predates any one of these offers is a perfectly good save whose owner
 * simply never bought that thing. Every field here is absent-means-zero,
 * which is exactly what such a player had.
 */
const SAVE_VERSION = 1;

export const EMPTY_SAVE: SaveData = Object.freeze({
  version: 1,
  gold: 0,
  fishBook: Object.freeze({}),
  reserve: 0,
  harpoons: 0,
  seaAnchors: 0,
  overdriveCoils: 0,
  chumDrums: 0,
  barbedHeads: 0,
  trimTier: 0,
  moonglassTier: 0,
  arcLampTier: 0,
  governorTier: 0,
  hull: 100,
  knownHarbours: Object.freeze([]),
  harbourStock: Object.freeze({}),
  reputation: 0,
  // Zero is the sentinel for "never drawn", not a seed. `createRecords` draws a
  // real one the first time it sees this, which is the only place a quest seed
  // is ever chosen -- see the note there on why it cannot be drawn here.
  questSeed: 0,
  quests: Object.freeze([]),
});

/* ------------------------------------------------------------------ */
/* Storage, which is allowed to be absent or hostile                   */
/* ------------------------------------------------------------------ */

/**
 * `localStorage`, or null where touching it throws.
 *
 * Resolved on every call rather than cached at module load: a `SecurityError`
 * here is a browser setting, and a setting can be changed without a reload.
 * The call is cheap and it runs twice a catch at the very most.
 */
function storage(): Storage | null {
  try {
    // The property access itself is what throws; `globalThis` keeps this file
    // loadable under node, which is what the probe runs it in.
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True once a write has failed, so the warning is printed once and not per catch. */
let writeFailureReported = false;

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

/** A whole, non-negative count, or null for anything that is not one. */
function toCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * A whole count in [0, max], or null for anything that is not one.
 *
 * The ceiling is enforced on the way IN rather than trusted, because both
 * capped fields are bought goods: an edited file claiming 900 harpoons is the
 * cheapest cheat there is, and the stores themselves clamp on construction
 * anyway. Clamping here as well is what makes the clamp visible in the load
 * warning instead of silently happening later.
 */
function toCapped(value: unknown, max: number): number | null {
  const count = toCount(value);
  if (count === null) return null;
  return count > max ? max : count;
}

/** True for a plain object — not null, not an array, not a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for one of the four durable ladders a harbour may carry. */
function isUpgradeLine(value: unknown): value is UpgradeLine {
  return value === 'trim' || value === 'moonglass' || value === 'arclamp' || value === 'governor';
}

/* ------------------------------------------------------------------ */
/* Contracts, read back off disk                                      */
/* ------------------------------------------------------------------ */

/**
 * The four kinds, including the two this build never generates.
 *
 * `EXPEDITION` and `SURVEY` are accepted here deliberately. A save written by a
 * later build that generates them must survive a round trip through this one —
 * the same promise `fishBook` keeps for unknown species ids and `knownHarbours`
 * keeps for unknown names. `quests.ts` will simply never settle one, which
 * costs the player a contract slot and not their history; dropping them would
 * cost the contract.
 */
function isQuestKind(value: unknown): value is QuestKind {
  return value === 'DELIVERY' || value === 'CHART' || value === 'EXPEDITION' || value === 'SURVEY';
}

function isQuestWindow(value: unknown): value is QuestWindow {
  return value === 'ANY' || value === 'DAYLIGHT' || value === 'NIGHT';
}

/** A finite number at or above zero, or null. Used for the purses and the clocks. */
function toNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** A non-empty string, or null. */
function toName(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * One contract off disk, or null if any field of it is unreadable.
 *
 * Whole-entry rather than per-field, which is the opposite of how the counts
 * above are repaired, and the reason is that a contract is not a set of
 * independent numbers: a delivery with a good purse and a rotten target is not
 * a contract with a scratch on it, it is a contract with no destination. There
 * is nothing to salvage and an unfulfillable slot is worse than an empty one.
 *
 * `CHART` goals are dropped whole and on purpose — see
 * `docs/QUESTS_PLAN.md`, interpretation 4. The chart is wiped with the world
 * (`CHART_KEY` is keyed on the seed), so the sea a chart goal measured does not
 * exist after a reload and the goal would silently restart from zero. A harbour
 * contract has a NAME to re-resolve and therefore survives; a fraction of a
 * vanished ocean does not.
 */
function toQuest(value: unknown, notes: string[]): ActiveQuest | null {
  if (!isRecord(value)) return null;

  const kind = value.kind;
  if (!isQuestKind(kind)) return null;
  if (kind === 'CHART') {
    notes.push('dropped a chart goal (its world is gone)');
    return null;
  }

  const id = toName(value.id);
  const issuer = toName(value.issuer);
  const brief = toName(value.brief);
  const window = value.window;
  const tier = value.tier;
  if (id === null || issuer === null || brief === null) return null;
  if (!isQuestWindow(window)) return null;
  if (tier !== 1 && tier !== 2 && tier !== 3) return null;

  // Every kind this build can settle has a destination, so a missing target is
  // damage rather than an absent optional. An unknown NAME is kept, on
  // `knownHarbours`' terms: a harbour this build cannot place is still a
  // harbour, and `quests.ts` re-resolves by name on every frame.
  const target = toName(value.target);
  if (target === null) return null;

  const gold = toNonNegative(value.gold);
  const reputation = toNonNegative(value.reputation);
  if (gold === null || reputation === null) return null;

  // Both clocks are nullable in the type and neither may be null here: a
  // deadline-less delivery would never expire and never be failable.
  const duration = toNonNegative(value.duration);
  const remaining = toNonNegative(value.remaining);
  if (duration === null || remaining === null) return null;

  return {
    id,
    kind,
    tier: tier as QuestTier,
    issuer,
    target,
    window,
    // Clamped to the deadline it was issued with, so an edited file cannot buy
    // itself an hour on a five-minute run.
    duration,
    coverage: null,
    gold: Math.floor(gold),
    reputation: Math.floor(reputation),
    brief,
    remaining: remaining > duration ? duration : remaining,
  };
}

/**
 * A valid `SaveData` from whatever was parsed out of storage.
 *
 * `notes` collects what had to be thrown away, so the caller can print one
 * warning naming all of it rather than one per field. A save with a NaN gold
 * and six rotten counts is one incident, not seven.
 *
 * The line between "repair" and "reset": the version is the file's claim about
 * its own shape, so a version this build does not know means every field below
 * is of unknown meaning and none of it can be salvaged. Inside a known
 * version, a field either parses or it does not, independently of its
 * neighbours — so `gold: "lots"` costs the gold and leaves the Fish Book, and
 * one rotten count costs one species. `docs/FISHING_PLAN.md` says "wrong shape
 * → defaults"; this is that rule applied per field rather than per file,
 * because the alternative is a stray NaN erasing an hour of fishing.
 */
function sanitize(parsed: unknown, notes: string[]): SaveData {
  if (!isRecord(parsed)) {
    notes.push('not an object');
    return EMPTY_SAVE;
  }
  if (parsed.version !== SAVE_VERSION) {
    notes.push(`version ${JSON.stringify(parsed.version)} (this build writes ${SAVE_VERSION})`);
    return EMPTY_SAVE;
  }

  const gold = toCount(parsed.gold);
  if (gold === null) notes.push(`gold ${JSON.stringify(parsed.gold)}`);

  // Bound to a name of its own rather than read as `parsed` inside the
  // closure below: `isRecord` narrowed the PARAMETER above, and narrowing on
  // a parameter does not carry into a nested function — TypeScript has to
  // assume the parameter could change before the closure runs, even though
  // this one never does. Capturing it in a `const` after the narrowing gives
  // the closure something whose type cannot have moved.
  const record = parsed;

  // Absent is not damage for any field read through here: a save written
  // before a given offer existed has no field for it, and a player who never
  // bought that thing has the same zero. Only a present-but-unreadable value
  // is worth a note — see the file comment on SAVE_VERSION for why each of
  // these eight joined version 1 rather than forcing a version 2.
  function readCapped(key: string, max: number): number | null {
    const value = record[key];
    if (value === undefined) return 0;
    const capped = toCapped(value, max);
    if (capped === null) notes.push(`${key} ${JSON.stringify(value)}`);
    return capped;
  }

  const reserveMax = Math.round(BATTERY_CAPACITY * 100);
  const reserve = readCapped('reserve', reserveMax);
  const harpoons = readCapped('harpoons', HARPOON_STORE_MAX);
  const seaAnchors = readCapped('seaAnchors', SEA_ANCHOR_STORE_MAX);
  const overdriveCoils = readCapped('overdriveCoils', OVERDRIVE_STORE_MAX);
  const chumDrums = readCapped('chumDrums', CHUM_DRUM_STORE_MAX);
  const barbedHeads = readCapped('barbedHeads', BARBED_HEADS_STORE_MAX);
  const trimTier = readCapped('trimTier', TRIM_TIER_MAX);
  const moonglassTier = readCapped('moonglassTier', MOONGLASS_TIER_MAX);
  const arcLampTier = readCapped('arcLampTier', ARC_LAMP_TIER_MAX);
  const governorTier = readCapped('governorTier', GOVERNOR_TIER_MAX);

  /**
   * Hull durability. A whole percent in [HULL_MIN, 100].
   *
   * Not read through `readCapped`: absent means a FULL hull rather than the
   * zero every count above defaults to, and a zero would be a scuttled ship
   * on a save written before the hull existed. The floor matters as much as
   * the ceiling here, which is the other reason this one is spelled out.
   */
  let hull: number | null = 100;
  const rawHull = record.hull;
  if (rawHull !== undefined) {
    if (typeof rawHull !== 'number' || !Number.isFinite(rawHull)) {
      hull = null;
      notes.push(`hull ${JSON.stringify(rawHull)}`);
    } else {
      hull = Math.min(100, Math.max(HULL_MIN, Math.round(rawHull)));
    }
  }

  /**
   * Harbours moored at. Unknown names are KEPT, on the same terms the fish
   * book keeps unknown species ids: a save from a build with a longer name
   * table must survive a round trip through this one.
   */
  const knownHarbours: string[] = [];
  const rawKnown = record.knownHarbours;
  if (rawKnown !== undefined) {
    if (!Array.isArray(rawKnown)) {
      notes.push('knownHarbours is not an array');
    } else {
      let rejectedNames = 0;
      const seen = new Set<string>();
      for (const entry of rawKnown) {
        if (typeof entry !== 'string' || entry.length === 0) {
          rejectedNames++;
          continue;
        }
        // First-visit order is the file's order; a duplicate is damage that
        // costs nothing to drop, because the store is a set either way.
        if (seen.has(entry)) continue;
        seen.add(entry);
        knownHarbours.push(entry);
      }
      if (rejectedNames > 0) {
        notes.push(`${rejectedNames} unreadable knownHarbours ${rejectedNames === 1 ? 'entry' : 'entries'}`);
      }
    }
  }

  /**
   * Per-harbour upgrade stock. A harbour whose list is unreadable is dropped
   * entirely rather than left with a partial one — `harbourstock.ts` re-rolls
   * the WHOLE table when any name is missing, because the coverage guarantee
   * (every ladder sold somewhere) cannot be made one harbour at a time.
   */
  const harbourStock: Record<string, UpgradeLine[]> = {};
  const rawStock = record.harbourStock;
  if (rawStock !== undefined) {
    if (!isRecord(rawStock)) {
      notes.push('harbourStock is not an object');
    } else {
      let rejectedStock = 0;
      for (const [name, value] of Object.entries(rawStock)) {
        if (!Array.isArray(value)) {
          rejectedStock++;
          continue;
        }
        const lines: UpgradeLine[] = [];
        let bad = false;
        for (const line of value) {
          if (!isUpgradeLine(line)) {
            bad = true;
            break;
          }
          if (!lines.includes(line)) lines.push(line);
        }
        if (bad) {
          rejectedStock++;
          continue;
        }
        harbourStock[name] = lines;
      }
      if (rejectedStock > 0) {
        notes.push(`${rejectedStock} unreadable harbourStock ${rejectedStock === 1 ? 'entry' : 'entries'}`);
      }
    }
  }

  /**
   * Standing. Signed, floored, no ceiling — the one field in this file that may
   * legitimately be negative, which is why it cannot go through `toCount`.
   */
  let reputation: number | null = 0;
  const rawReputation = record.reputation;
  if (rawReputation !== undefined) {
    if (typeof rawReputation !== 'number' || !Number.isFinite(rawReputation)) {
      reputation = null;
      notes.push(`reputation ${JSON.stringify(rawReputation)}`);
    } else {
      reputation = Math.max(REPUTATION_FLOOR, Math.round(rawReputation));
    }
  }

  /**
   * The board seed. A uint32, and zero means "never drawn" rather than a seed
   * of zero — `createRecords` draws one on that reading.
   */
  const rawSeed = record.questSeed;
  const questSeed =
    typeof rawSeed === 'number' && Number.isFinite(rawSeed) && rawSeed >= 0
      ? Math.floor(rawSeed) >>> 0
      : 0;

  /**
   * Contracts in hand. An unreadable entry costs one contract; an unreadable
   * LIST costs all of them, because there is nothing to iterate.
   */
  const quests: ActiveQuest[] = [];
  const rawQuests = record.quests;
  if (rawQuests !== undefined) {
    if (!Array.isArray(rawQuests)) {
      notes.push('quests is not an array');
    } else {
      let rejectedQuests = 0;
      const seenIds = new Set<string>();
      for (const entry of rawQuests) {
        const quest = toQuest(entry, notes);
        if (quest === null) {
          rejectedQuests++;
          continue;
        }
        // A duplicate id would give the player two clocks on one contract and
        // two purses for one delivery. Dropping the second costs nothing.
        if (seenIds.has(quest.id)) continue;
        seenIds.add(quest.id);
        // The ceiling is enforced on the way in for `toCapped`'s reason: an
        // edited file holding nine contracts is a cheap cheat, and the store
        // clamps on construction anyway.
        if (quests.length < MAX_ACTIVE) quests.push(quest);
      }
      if (rejectedQuests > 0) {
        notes.push(`${rejectedQuests} unreadable quests ${rejectedQuests === 1 ? 'entry' : 'entries'}`);
      }
    }
  }

  const fishBook: Record<string, number> = {};
  const raw = parsed.fishBook;
  if (!isRecord(raw)) {
    if (raw !== undefined) notes.push('fishBook is not an object');
  } else {
    let rejected = 0;
    for (const [id, value] of Object.entries(raw)) {
      const count = toCount(value);
      if (count === null) {
        rejected++;
        continue;
      }
      // A count of zero says the same thing an absent key does — "never
      // caught" — so it is dropped rather than rejected, and does not count as
      // damage. Nothing is lost and the file stays the size of the history.
      if (count > 0) fishBook[id] = count;
    }
    if (rejected > 0) notes.push(`${rejected} unreadable fishBook ${rejected === 1 ? 'entry' : 'entries'}`);
    // Unknown ids are KEPT — deliberately, and this is the load half of the
    // promise `fishbook.ts` keeps on the write half. A save from a later build
    // must survive a round trip through this one, and a species renamed
    // between builds must not have its history quietly deleted by the first
    // load that fails to recognise the name.
  }

  return {
    version: 1,
    gold: gold ?? 0,
    fishBook,
    reserve: reserve ?? 0,
    harpoons: harpoons ?? 0,
    seaAnchors: seaAnchors ?? 0,
    overdriveCoils: overdriveCoils ?? 0,
    chumDrums: chumDrums ?? 0,
    barbedHeads: barbedHeads ?? 0,
    trimTier: trimTier ?? 0,
    moonglassTier: moonglassTier ?? 0,
    arcLampTier: arcLampTier ?? 0,
    governorTier: governorTier ?? 0,
    hull: hull ?? 100,
    knownHarbours,
    harbourStock,
    reputation: reputation ?? 0,
    questSeed,
    quests,
  };
}

/**
 * The save, whatever is in storage. Never throws; never returns garbage.
 *
 * Missing storage, a missing key, unparsable JSON, a version this build does
 * not know, a wrong-shaped object, a NaN or negative gold, counts that are
 * strings or negative, a backup charge or a harpoon count over its ceiling —
 * every one of those yields a valid `SaveData`.
 */
export function loadSave(): SaveData {
  let raw: string | null;
  try {
    raw = storage()?.getItem(SAVE_KEY) ?? null;
  } catch {
    // getItem itself can throw even where the property resolved.
    console.warn(`save.ts: cannot read ${SAVE_KEY}; playing without a save file.`);
    return EMPTY_SAVE;
  }

  // No file is not damage. A first run must be silent.
  if (raw === null) return EMPTY_SAVE;

  const notes: string[] = [];
  let data: SaveData;
  try {
    data = sanitize(JSON.parse(raw) as unknown, notes);
  } catch {
    notes.push('unparsable JSON');
    data = EMPTY_SAVE;
  }

  if (notes.length > 0) {
    console.warn(`save.ts: discarded from ${SAVE_KEY} — ${notes.join('; ')}.`);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Writes the save, and shrugs if it cannot.
 *
 * Called after every catch rather than on a timer: a timer's whole risk
 * profile is the interval between the last tick and the tab being closed, and
 * this file is two numbers and twenty counts. There is nothing to amortise.
 *
 * A failure is reported once per run. It is nearly always a permanent
 * condition — a disabled store, a full quota — and the alternative is a
 * console line every few seconds for the rest of the session, on top of a
 * player who is already having a bad time.
 */
export function writeSave(data: SaveData): void {
  const store = storage();
  if (store === null) {
    reportWriteFailure('storage is unavailable');
    return;
  }
  try {
    store.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (error) {
    reportWriteFailure(String(error));
  }
}

/**
 * Reads the stored chart, or null.
 *
 * Returns the raw string; `chart.ts` owns the decoding and every one of its
 * failure modes, because the shape of that data is its business and not this
 * file's. What this file owns is the key and the fact that a missing or
 * unreadable one is not damage.
 */
export function loadChart(): string | null {
  try {
    return storage()?.getItem(CHART_KEY) ?? null;
  } catch {
    console.warn(`save.ts: cannot read ${CHART_KEY}; the chart will start blank.`);
    return null;
  }
}

/**
 * Writes the chart, and shrugs if it cannot.
 *
 * Same posture as `writeSave`, and it shares the same once-per-run failure
 * report: a full quota fails both, and two console lines for one cause help
 * nobody. The chart is by far the larger of the two, so in practice this is
 * the call that discovers the quota is gone.
 */
export function writeChart(encoded: string): void {
  const store = storage();
  if (store === null) {
    reportWriteFailure('storage is unavailable');
    return;
  }
  try {
    store.setItem(CHART_KEY, encoded);
  } catch (error) {
    reportWriteFailure(String(error));
  }
}

function reportWriteFailure(reason: string): void {
  if (writeFailureReported) return;
  writeFailureReported = true;
  console.warn(`save.ts: cannot write ${SAVE_KEY} (${reason}); progress will not survive a reload.`);
}

/* ------------------------------------------------------------------ */
/* The wiring                                                          */
/* ------------------------------------------------------------------ */

/**
 * Loads the save and wires everything that survives a reload to it, so that a
 * change to any of them is persisted without any caller remembering to.
 *
 * One entry point rather than four, because the four are only ever used
 * together and a half-wired set is a save file that silently stops updating —
 * the kind of bug that is invisible until a player reloads and finds an
 * evening gone.
 *
 * The wallet's `onChange` fires immediately, so this also rewrites the file
 * once at boot. That is wanted: it is what lands a repaired save back on disk
 * in its clean form, rather than leaving the damage to be re-parsed and
 * re-warned about on every load until the first catch.
 */
/**
 * What `createRecords` needs to know about the contract sim, and no more.
 *
 * A structural type rather than `Quests` itself, and that is the point: this
 * file must be able to persist contracts without importing the sim that makes
 * them. `quests.ts` imports `wallet.ts` and `reputation.ts`, both of which this
 * file already builds, so importing `quests.ts` here would close a cycle for
 * the sake of two method names.
 */
export interface QuestSource {
  snapshot(): readonly ActiveQuest[];
  on(fn: () => void): () => void;
}

export function createRecords(): {
  wallet: Wallet;
  book: FishBookStore;
  battery: Battery;
  harpoons: HarpoonStore;
  seaAnchor: SeaAnchorStore;
  overdrive: OverdriveStore;
  chumDrum: ChumDrumStore;
  barbedHeads: BarbedHeadsStore;
  trim: TrimStore;
  moonglass: MoonglassStore;
  arcLamp: ArcLampStore;
  governor: GovernorStore;
  hull: Hull;
  known: KnownHarbours;
  stock: HarbourStock;
  reputation: Reputation;
  /**
   * The board seed for this session: the saved one, or a fresh draw on a file
   * that has never had one.
   *
   * Handed out rather than kept, because `quests.ts` is built by `main.ts` and
   * not here — see `attachQuests`.
   */
  questSeed: number;
  /** Contracts loaded off disk, for `createQuests`' own `saved` parameter. */
  questsSaved: readonly ActiveQuest[];
  /**
   * Subscribes the contract sim to the save file. Called once, by `main.ts`.
   *
   * The one asymmetry in this module, and it is forced: every other record here
   * is built from a number in the file and nothing else, so this function can
   * own it outright. Contracts need `globe.towns` and the chart, neither of
   * which exists when the records are created, so the sim is built later and
   * hands itself back. Until it does, `persist` writes the contracts exactly as
   * they were loaded, which is the truth about them.
   */
  attachQuests(quests: QuestSource): void;
} {
  const save = loadSave();
  const wallet = createWallet(save.gold);
  // Seeded with the loaded record entire, unknown ids included; `snapshot()`
  // hands them straight back, so the round trip is lossless.
  const book = createFishBookStore(save.fishBook);
  // The cell takes the file's own unit — whole percent — and owns the
  // conversion to and from the tank fractions the sim runs in.
  const battery = createBattery(save.reserve);
  const harpoons = createHarpoonStore(save.harpoons);
  const seaAnchor = createSeaAnchorStore(save.seaAnchors);
  const overdrive = createOverdriveStore(save.overdriveCoils);
  const chumDrum = createChumDrumStore(save.chumDrums);
  const barbedHeads = createBarbedHeadsStore(save.barbedHeads);
  const trim = createTrimStore(save.trimTier);
  const moonglass = createMoonglassStore(save.moonglassTier);
  const arcLamp = createArcLampStore(save.arcLampTier);
  const governor = createGovernorStore(save.governorTier);
  const hull = createHull(save.hull);

  /*
   * The two harbour records, and they are not symmetrical.
   *
   * `known` grows while the ship sails — one name the first time it ties up
   * at a place — so it notifies like every other store here and `persist`
   * reads it back out.
   *
   * `stock` is drawn ONCE and then never changes for the life of the save.
   * Its `onChange` therefore fires at most once, at construction, and only
   * when this boot actually rolled the table; see `harbourstock.ts` on why
   * the roll covers all thirty-six harbours at once rather than one harbour
   * per visit. Subscribing it here is what lands that roll on disk, so the
   * next load reads the same chandleries back rather than rolling new ones.
   */
  const known = createKnownHarbours(save.knownHarbours);
  const stock = createHarbourStock(save.harbourStock);
  const reputation = createReputation(save.reputation);

  /*
   * The board seed, drawn here on a file that has none.
   *
   * `Math.random` and not a seeded stream, on the same terms as the world seed
   * in `worldgen.ts`: this is a choice made once about a save file, not a
   * number any test reproduces. Zero is re-rolled to 1 rather than accepted,
   * because zero is the sentinel the loader reads as "never drawn".
   *
   * It is not written to disk here. A fresh draw reaches the file with the
   * first thing the player earns, buys or moors at, and until then it is
   * re-drawn on every load — which costs nothing, because a player who has done
   * nothing is also sailing a world that was redrawn on the same load. The
   * alternative, writing a save for a player who has not played, would create
   * the key on a page visit.
   */
  const questSeed = save.questSeed !== 0 ? save.questSeed : Math.floor(Math.random() * 0xffffffff) + 1;

  /** The contract sim, once `main.ts` has one to give. Null until then. */
  let questSource: QuestSource | null = null;

  function persist(): void {
    writeSave({
      version: 1,
      gold: wallet.gold,
      fishBook: book.snapshot(),
      reserve: battery.percent,
      harpoons: harpoons.count,
      seaAnchors: seaAnchor.count,
      overdriveCoils: overdrive.count,
      chumDrums: chumDrum.count,
      barbedHeads: barbedHeads.count,
      trimTier: trim.tier,
      moonglassTier: moonglass.tier,
      arcLampTier: arcLamp.tier,
      governorTier: governor.tier,
      hull: hull.state.percent,
      // Iteration order is first-visit order, which is the order the file is
      // written in and the order the loader reads back -- see
      // `knownharbours.ts` on why a Set is the right shape for a record a
      // frame loop writes to.
      knownHarbours: Array.from(known.names),
      harbourStock: stock.snapshot(),
      reputation: reputation.points,
      questSeed,
      // Before `attachQuests`, the contracts that were loaded -- not an empty
      // list. A `persist` triggered by a catch in the first second of a session
      // must not be the write that erases three contracts in hand.
      quests: questSource?.snapshot() ?? save.quests,
    });
  }

  // Every part of the file, all subscribed, at the one moment where the caller
  // cannot forget one of them. The cell is the only one of the twelve that
  // moves continuously rather than on an event, and it is why `battery.ts`
  // notifies on its PERSISTED percent rather than on every draw — without
  // that, a ship burning through its backup would be writing localStorage
  // sixty times a second for a number that is read back exactly once, at
  // boot. The two deploy timers (`seaAnchor.isDeployed`, `overdrive.isActive`)
  // are deliberately not among the eight `onChange` subscriptions below: they
  // are not part of the persisted count and `save.ts` never asks either store
  // about them.
  wallet.onChange(persist);
  book.onChange(persist);
  battery.onChange(persist);
  harpoons.onChange(persist);
  seaAnchor.onChange(persist);
  overdrive.onChange(persist);
  chumDrum.onChange(persist);
  barbedHeads.onChange(persist);
  trim.onChange(persist);
  moonglass.onChange(persist);
  arcLamp.onChange(persist);
  governor.onChange(persist);
  // The hull is the second of the two that move continuously rather than on
  // an event, and it notifies on its PERSISTED whole percent for the same
  // reason the cell does -- see the note above.
  hull.onChange(persist);
  // A new mooring, and the one roll of the upgrade table. Neither moves more
  // than a few dozen times in the life of a save, so both write straight
  // through rather than being throttled the way the cell and the hull are.
  known.onChange(persist);
  stock.onChange(persist);
  // Standing moves on a settled contract and nowhere else, so it writes
  // straight through like the two above rather than being throttled.
  reputation.onChange(persist);

  return {
    wallet,
    book,
    battery,
    harpoons,
    seaAnchor,
    overdrive,
    chumDrum,
    barbedHeads,
    trim,
    moonglass,
    arcLamp,
    governor,
    hull,
    known,
    stock,
    reputation,
    questSeed,
    questsSaved: save.quests,
    attachQuests(quests: QuestSource): void {
      questSource = quests;
      /*
       * Every contract event, and one more thing: the clock.
       *
       * `quests.ts` fires on accept, completion, failure and each whole step of
       * a chart goal, which is four or five writes in the life of a contract.
       * The clock itself moves every frame and is deliberately NOT subscribed:
       * a deadline ticking down would write 87 KB of save file sixty times a
       * second for a figure read back exactly once, at boot. The cost is that a
       * tab closed mid-passage hands the contract back with the time it had at
       * the last event rather than at the last frame, which is generous to the
       * player and cheap to be generous about.
       */
      quests.on(persist);
      // Once, now: the loaded contracts have just become the live ones, and the
      // sim may already have refused one it could not place.
      persist();
    },
  };
}
