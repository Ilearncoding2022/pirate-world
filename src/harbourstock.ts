import type { UpgradeLine } from './types';
import { HARBOUR_NAMES } from './harbournames';

/**
 * harbourstock.ts — which of the four upgrade ladders each harbour carries.
 *
 * Every harbour sells every consumable and the backup cell; what differs
 * between them is the four DURABLES — Trim & Sheathing, the Moonglass Array,
 * the Arc-Lamp Rig and the Efficiency Governor. Which of the four a given
 * harbour stocks is drawn once, keyed by name, and saved.
 *
 * ## Why the roll is all thirty-six at once, and not lazy
 *
 * The obvious implementation is to roll a harbour's stock the first time the
 * player ties up there. It is wrong, and the reason is a promise this file
 * has to make and a lazy roll cannot:
 *
 * **Every ladder must be sold SOMEWHERE.** A player who has decided to save
 * for Trim Mk III has to be able to find a harbour that sells Trim. A lazy
 * roll can only ever answer "does this harbour sell Trim"; it has no way to
 * know whether any of the thirty-five it has not rolled yet does, so it
 * cannot promise the ladder exists in the world at all. Roll the whole table
 * in one go and the promise is arithmetic: count the harbours carrying each
 * line, and if any line falls short of `LINE_MIN_HARBOURS`, throw the table
 * away and roll again.
 *
 * The floor is six of thirty-six rather than one, because "exists somewhere"
 * is not the same as "findable". At one harbour in thirty-six a player could
 * cross an ocean and still not have passed it; at six, a ladder is about a
 * one-in-six harbour and turns up in ordinary sailing.
 *
 * The second reason to roll it once is decision 9's: the table is SAVED, and
 * a harbour the player remembers keeps the upgrades it had. Rolling per world
 * would make the memory of a harbour worth nothing, since the place a player
 * sailed back to for a Governor would sell something else this time.
 *
 * ## Why it is re-rolled whole when ANY name is missing
 *
 * Same promise, from the other end. A partial table — say thirty-five names
 * from an older build plus one new one — cannot be completed a harbour at a
 * time without re-opening the coverage question, and the honest answer to
 * "does this table still satisfy the guarantee" is cheaper to get by rolling
 * again than by patching. `save.ts` drops a harbour whose list is unreadable
 * for exactly this reason: a hole in the table is a signal to re-roll, not
 * damage to be repaired in place.
 *
 * The cost of a re-roll is that a remembered harbour's stock changes. That is
 * accepted, and it only happens when the name table itself changed, which is
 * a build event and not something a player can cause.
 */

/** The four durable ladders, in the order the chandlery lists them. */
export const UPGRADE_LINES: readonly UpgradeLine[] = ['trim', 'moonglass', 'arclamp', 'governor'];

/**
 * Odds a given harbour carries a given line, before the two corrections
 * below. A coin per line per harbour, so the average harbour sells two of the
 * four and the interesting cases — a harbour that sells all four, one that
 * sells only the Governor — both turn up without being special-cased.
 */
const LINE_ODDS = 0.5;

/**
 * The fewest harbours that may carry any one line.
 *
 * Six of thirty-six. See the file comment: this is what makes a ladder
 * findable rather than merely existent.
 */
export const LINE_MIN_HARBOURS = 6;

/**
 * How many times the table may be rolled before the shortfall is filled in by
 * hand.
 *
 * At thirty-six harbours and even odds a line lands on eighteen on average,
 * and the chance of any of the four falling under six is about one in ten
 * million — this cap is not a tuning number and in the shipped configuration
 * it never fires. It exists because `random` and `names` are both parameters:
 * a test that hands in four names and a rigged generator would otherwise spin
 * this loop forever, and a store that can hang the boot is worse than one
 * that occasionally deals a harbour a line it did not draw.
 */
const MAX_ROLLS = 64;

export interface HarbourStock {
  /** The lines this harbour carries. Empty for a name that is not in the table. */
  linesFor(name: string): readonly UpgradeLine[];
  /** The whole table, for the save file. */
  snapshot(): Record<string, UpgradeLine[]>;
  /**
   * Fires when the table was rolled and the file does not have it yet.
   *
   * Immediately on subscription, the way `wallet.ts` notifies, and for the
   * same reason: the roll happens inside `createHarbourStock` — before any
   * caller could possibly have subscribed — so a store that only fired on a
   * LATER change would leave the boot's roll unwritten until something else
   * happened to touch the save.
   */
  onChange(fn: () => void): void;
}

/** A table with every name in `names` present, or null if even one is missing. */
function verbatimOrNull(
  saved: Record<string, readonly UpgradeLine[]>,
  names: readonly string[],
): Record<string, UpgradeLine[]> | null {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(saved, name)) return null;
  }
  // Copied entire, unknown names included: a save from a build with a longer
  // name table round-trips through this one untouched, on the same terms the
  // fish book keeps unknown species ids.
  const table: Record<string, UpgradeLine[]> = {};
  for (const [name, lines] of Object.entries(saved)) table[name] = [...lines];
  return table;
}

/** One draw of the whole table: a coin per line, and a floor of one line each. */
function rollTable(names: readonly string[], random: () => number): Record<string, UpgradeLine[]> {
  const table: Record<string, UpgradeLine[]> = {};
  for (const name of names) {
    const lines: UpgradeLine[] = [];
    for (const line of UPGRADE_LINES) {
      if (random() < LINE_ODDS) lines.push(line);
    }
    if (lines.length === 0) {
      // A harbour that drew nothing gets one at random rather than being left
      // empty. One in sixteen harbours lands here, and a chandlery with no
      // upgrade rows at all reads as a bug rather than as a small port.
      // `Math.min` guards the one input `Math.floor` cannot: a generator that
      // returns exactly 1 would index off the end.
      const pick = Math.min(UPGRADE_LINES.length - 1, Math.floor(random() * UPGRADE_LINES.length));
      lines.push(UPGRADE_LINES[pick]);
    }
    table[name] = lines;
  }
  return table;
}

/** How many harbours carry each line. */
function countLines(table: Record<string, UpgradeLine[]>): Map<UpgradeLine, number> {
  const counts = new Map<UpgradeLine, number>();
  for (const line of UPGRADE_LINES) counts.set(line, 0);
  for (const lines of Object.values(table)) {
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/** True when every line is carried by at least `floor` harbours. */
function covers(table: Record<string, UpgradeLine[]>, floor: number): boolean {
  for (const count of countLines(table).values()) {
    if (count < floor) return false;
  }
  return true;
}

/**
 * Deals the short lines out by hand, in name order.
 *
 * Only reachable past `MAX_ROLLS`, which the shipped configuration never
 * spends. It is here so the guarantee is total rather than probabilistic:
 * whatever `names` and `random` are, this function returns a table in which
 * every line is carried by as many harbours as there are harbours to carry
 * it.
 */
function topUp(table: Record<string, UpgradeLine[]>, names: readonly string[], floor: number): void {
  const counts = countLines(table);
  for (const line of UPGRADE_LINES) {
    for (const name of names) {
      if ((counts.get(line) ?? 0) >= floor) break;
      const lines = table[name];
      if (lines === undefined || lines.includes(line)) continue;
      lines.push(line);
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
}

/**
 * The store.
 *
 * @param saved   the table `save.ts` repaired out of the file; `{}` for a new player.
 * @param names   the harbours that must be covered. The real table, in tests a short one.
 * @param random  the draw. `Math.random` in the game, a seeded generator in tests.
 */
export function createHarbourStock(
  saved: Record<string, readonly UpgradeLine[]> = {},
  names: readonly string[] = HARBOUR_NAMES,
  random: () => number = Math.random,
): HarbourStock {
  let table = verbatimOrNull(saved, names);
  const rolled = table === null;

  if (table === null) {
    let rolls = 0;
    do {
      table = rollTable(names, random);
      rolls++;
    } while (!covers(table, LINE_MIN_HARBOURS) && rolls < MAX_ROLLS);
    if (!covers(table, LINE_MIN_HARBOURS)) topUp(table, names, LINE_MIN_HARBOURS);
  }

  const built: Record<string, UpgradeLine[]> = table;

  /** True until the roll has been announced to somebody. See `onChange`. */
  let unannounced = rolled;

  const NONE: readonly UpgradeLine[] = Object.freeze([]);

  function linesFor(name: string): readonly UpgradeLine[] {
    return built[name] ?? NONE;
  }

  function snapshot(): Record<string, UpgradeLine[]> {
    const out: Record<string, UpgradeLine[]> = {};
    for (const [name, lines] of Object.entries(built)) out[name] = [...lines];
    return out;
  }

  function onChange(fn: () => void): void {
    // Fired once, to the first subscriber, and only when this boot actually
    // rolled: a table read verbatim out of the file is already on disk and
    // rewriting it would be a write for nothing.
    if (!unannounced) return;
    unannounced = false;
    fn();
  }

  return { linesFor, snapshot, onChange };
}
