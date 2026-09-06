import type { SaveData } from './types';
import type { Wallet } from './wallet';
import type { FishBookStore } from './fishbook';
import { createWallet } from './wallet';
import { createFishBookStore } from './fishbook';

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
 * The only version this build writes or accepts.
 *
 * A future version 2 loader keeps this constant and adds a migration; it does
 * NOT widen the accept test, because the whole value of the field is that an
 * unrecognised number is a definite answer rather than a guess.
 */
const SAVE_VERSION = 1;

export const EMPTY_SAVE: SaveData = Object.freeze({
  version: 1,
  gold: 0,
  fishBook: Object.freeze({}),
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

/** True for a plain object — not null, not an array, not a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  return { version: 1, gold: gold ?? 0, fishBook };
}

/**
 * The save, whatever is in storage. Never throws; never returns garbage.
 *
 * Missing storage, a missing key, unparsable JSON, a version this build does
 * not know, a wrong-shaped object, a NaN or negative gold, counts that are
 * strings or negative — every one of those yields a valid `SaveData`.
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

function reportWriteFailure(reason: string): void {
  if (writeFailureReported) return;
  writeFailureReported = true;
  console.warn(`save.ts: cannot write ${SAVE_KEY} (${reason}); progress will not survive a reload.`);
}

/* ------------------------------------------------------------------ */
/* The wiring                                                          */
/* ------------------------------------------------------------------ */

/**
 * Loads the save and wires a wallet and a Fish Book to it, so that every
 * change to either is persisted without any caller remembering to.
 *
 * One entry point rather than three, because the three are only ever used
 * together and a half-wired set is a save file that silently stops updating —
 * the kind of bug that is invisible until a player reloads and finds an
 * evening gone.
 *
 * The wallet's `onChange` fires immediately, so this also rewrites the file
 * once at boot. That is wanted: it is what lands a repaired save back on disk
 * in its clean form, rather than leaving the damage to be re-parsed and
 * re-warned about on every load until the first catch.
 */
export function createRecords(): { wallet: Wallet; book: FishBookStore } {
  const save = loadSave();
  const wallet = createWallet(save.gold);
  // Seeded with the loaded record entire, unknown ids included; `snapshot()`
  // hands them straight back, so the round trip is lossless.
  const book = createFishBookStore(save.fishBook);

  function persist(): void {
    writeSave({ version: 1, gold: wallet.gold, fishBook: book.snapshot() });
  }

  // Both halves of the file, both subscribed, at the one moment where the
  // caller cannot forget one of them.
  wallet.onChange(persist);
  book.onChange(persist);

  return { wallet, book };
}
