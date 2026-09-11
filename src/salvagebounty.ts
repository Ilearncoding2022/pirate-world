import {
  BARBED_HEADS_PRICE,
  BATTERY_PRICE,
  CHUM_DRUM_PRICE,
  HARPOONS_PRICE,
  OVERDRIVE_PRICE,
  SEA_ANCHOR_PRICE,
} from './shop';

/**
 * salvagebounty.ts — what a raft of salvage is carrying, and what a tow pays.
 *
 * `bounty.ts` is the model: the payout tables for one event, as pure functions
 * over an injected `rng`, with no store, no wallet and no scene anywhere near
 * them. That is what lets the whole table be measured in the two-second unit
 * tier instead of being tuned by playing.
 *
 * The brief is docs/SALVAGE_PLAN.md. Read the balance note there before
 * retuning anything here: the gold band moved once already (100-3000 down to
 * 100-1000) and the arithmetic that moved it is written down.
 *
 * The tow's payout is here rather than in `derelict.ts` for the same reason the
 * raft's is not in `salvage.ts`: a sim decides what happens and a table decides
 * what it is worth, and only one of those two is a number somebody will want to
 * retune without reading a sim.
 *
 * **Every haul consumes exactly three values from the stream, whatever it
 * turns out to be.** `bounty.ts` states the rule and the reason: a branch that
 * draws a different count from its neighbour makes the seeded sequence depend
 * on its own results, which is the bug that stops a seeded run replaying. So
 * the gold index, the item gate and the item pick are all drawn every time —
 * on a raft carrying nothing but gold, two of the three are thrown away.
 */

/* ------------------------------------------------------------------ */
/* Gold                                                                */
/* ------------------------------------------------------------------ */

/**
 * The gold band, inclusive at both ends, and the step inside it.
 *
 * Uniform over ten round hundreds, expected value **550**. Round hundreds for
 * `questconstants.ts`'s own stated reason — a payout of 370 reads as the
 * output of a random number generator rather than as a sum of money — and
 * uniform rather than tiered because a raft is a small, frequent find and a
 * tier table's rare top end belongs to the events a player can lose.
 *
 * It was 100-3000 in the first draft of the plan, EV 1550, which at the roll's
 * own ceiling printed 1900-2800 gold a minute and beat every other activity in
 * the game put together. See the balance note in docs/SALVAGE_PLAN.md; if this
 * needs pulling again, pull `salvage.ts`'s per-term odds instead, because this
 * is the figure a player reads off the notice strip.
 */
export const GOLD_MIN = 100;
export const GOLD_MAX = 1000;
export const GOLD_STEP = 100;

/** How many distinct payouts the band holds. 10, and the one divisor here. */
const GOLD_STEPS = (GOLD_MAX - GOLD_MIN) / GOLD_STEP + 1;

/* ------------------------------------------------------------------ */
/* The consumable                                                      */
/* ------------------------------------------------------------------ */

/** Which locker a raft's extra goes into. Not a display name; see `ITEM_LABEL`. */
export type SalvageItem = 'cell' | 'harpoons' | 'anchor' | 'overdrive' | 'chum' | 'barbed';

/**
 * The share of rafts carrying a consumable on top of their gold, and the share
 * of those that carry a backup cell.
 *
 * Both the owner's numbers: one raft in twenty, and half of those a cell. The
 * cell is deliberately the common one because it is the only consumable in the
 * game that is spent whether the player chooses to or not — `battery.ts` calls
 * it "a consumable dressed as a battery" — so finding one floating is the find
 * that changes what a player dares to do next. The other five are an even
 * split of what is left, 10% of the 5% each.
 */
export const ITEM_CHANCE = 0.05;
export const CELL_SHARE = 0.5;

/**
 * The draw, as a cumulative table over `[0, 1)`.
 *
 * Written cumulatively rather than as weights so the pick is one comparison
 * walk and the last entry catches any floating-point remainder — the same
 * shape, and the same guard, as `bounty.ts`'s `WIN_TIERS`.
 */
const ITEM_TABLE: readonly { readonly item: SalvageItem; readonly upTo: number }[] = [
  { item: 'cell', upTo: CELL_SHARE },
  { item: 'harpoons', upTo: CELL_SHARE + 0.1 },
  { item: 'anchor', upTo: CELL_SHARE + 0.2 },
  { item: 'overdrive', upTo: CELL_SHARE + 0.3 },
  { item: 'chum', upTo: CELL_SHARE + 0.4 },
  { item: 'barbed', upTo: 1 },
];

/** Every item a raft can carry, in the table's own order. For the tests and the tests alone. */
export const ITEMS: readonly SalvageItem[] = ITEM_TABLE.map((entry) => entry.item);

/**
 * What each item is worth in gold when the locker it would go into is full.
 *
 * The chandlery's own prices, imported rather than restated: a found cell is
 * worth what a bought cell costs, and a second opinion about that would drift
 * the first time `shop.ts` retunes one.
 */
export const ITEM_PRICE: Readonly<Record<SalvageItem, number>> = {
  cell: BATTERY_PRICE,
  harpoons: HARPOONS_PRICE,
  anchor: SEA_ANCHOR_PRICE,
  overdrive: OVERDRIVE_PRICE,
  chum: CHUM_DRUM_PRICE,
  barbed: BARBED_HEADS_PRICE,
};

/** What the notice strip calls each one. Upper case because the strip is. */
export const ITEM_LABEL: Readonly<Record<SalvageItem, string>> = {
  cell: 'A BACKUP CELL',
  harpoons: 'FIVE HARPOONS',
  anchor: 'A SEA ANCHOR',
  overdrive: 'AN OVERDRIVE COIL',
  chum: 'A CHUM DRUM',
  barbed: 'BARBED HEADS',
};

/* ------------------------------------------------------------------ */
/* The haul                                                            */
/* ------------------------------------------------------------------ */

export interface SalvageHaul {
  /** Gold aboard, always a round hundred and never zero. */
  readonly gold: number;
  /**
   * The consumable aboard, or null.
   *
   * Null covers both "this raft had no extra" (19 in 20) and "it had one the
   * ship has no room for", and the caller cannot tell those apart — by design.
   * The second case has already been paid for in `gold`; see `soldOn`.
   */
  readonly item: SalvageItem | null;
  /**
   * The item that was aboard but could not be stowed, or null.
   *
   * Carried separately from `item` so the notice can say what happened without
   * the grant path having to care: `main.ts` stows `item` and banks `gold`, and
   * this field only ever changes the words on the strip.
   */
  readonly soldOn: SalvageItem | null;
}

/* ------------------------------------------------------------------ */
/* The tow                                                             */
/* ------------------------------------------------------------------ */

/**
 * What delivering a derelict pays, in gold, at the two ends of the voyage band.
 *
 * Scaled on the distance actually towed rather than rolled, and that is the
 * point: a tow has no tiers and no luck in it. It is the one payout in this game
 * that is simply earned, which is what makes it the right reward for the one
 * activity that costs minutes of sailing at three quarters speed.
 *
 * 1200 to 2500 sits above `DELIVERY_GOLD`'s tier 1 and inside its tier 2
 * (`questconstants.ts`), which is where it belongs: a rescue is worth more than
 * a short cargo run and less than an antipodal one with a daylight window on it.
 * A 350-unit haul pays about double a 120-unit one.
 */
export const TOW_GOLD_MIN = 1200;
export const TOW_GOLD_MAX = 2500;

/**
 * Reputation for delivering one.
 *
 * Eight, against `questconstants.ts`'s own awards, and the argument is the same
 * one the gold makes: more standing than a cargo run and less than a survey of
 * a third of the world. It is also the only reputation in the game that cannot
 * be lost — a tow has no deadline to miss, so there is no failure to penalise.
 */
export const TOW_REPUTATION = 8;

/**
 * What a tow of `voyage` world units pays, in gold.
 *
 * Linear between the band's ends and clamped outside them, then rounded to
 * `GOLD_ROUNDING`'s own hundred so the notice reads as a sum of money. The
 * clamp is not decoration: `derelict.ts` draws its harbours from a band, but
 * `force` in a world with no harbour inside it will hand over whatever distance
 * it found, and a dev query should not be able to print a five-figure purse.
 */
export function towGold(voyage: number, min = 120, max = 350): number {
  if (!Number.isFinite(voyage)) return TOW_GOLD_MIN;
  const t = Math.max(0, Math.min(1, (voyage - min) / (max - min)));
  const raw = TOW_GOLD_MIN + (TOW_GOLD_MAX - TOW_GOLD_MIN) * t;
  return Math.round(raw / 100) * 100;
}

/* ------------------------------------------------------------------ */
/* The haul                                                            */
/* ------------------------------------------------------------------ */

/**
 * Draw one raft's contents. Exactly three values off `rng`, always.
 *
 * @param hasRoom whether a locker can take one more of `item`. Omitted means
 *   every locker has room, which is what the tuning tests want.
 *
 * **A full locker does not waste the find.** The item is drawn from the whole
 * table whatever the ship is carrying — the stream may not depend on the
 * player's lockers any more than on the weather — and an item with nowhere to
 * go is converted to its own shop price in gold instead. Dropping a 1000-gold
 * cell silently because the ship already has two is a loss a player never sees
 * the reason for, and paying a different item's price would be a lie about
 * which one floated past.
 */
export function rollSalvage(
  rng: () => number,
  hasRoom?: (item: SalvageItem) => boolean,
): SalvageHaul {
  const goldDraw = rng();
  const gateDraw = rng();
  const itemDraw = rng();

  const gold = GOLD_MIN + Math.min(GOLD_STEPS - 1, Math.floor(goldDraw * GOLD_STEPS)) * GOLD_STEP;

  if (gateDraw >= ITEM_CHANCE) return { gold, item: null, soldOn: null };

  let drawn: SalvageItem = ITEM_TABLE[ITEM_TABLE.length - 1].item;
  for (const entry of ITEM_TABLE) {
    if (itemDraw < entry.upTo) {
      drawn = entry.item;
      break;
    }
  }

  if (hasRoom !== undefined && !hasRoom(drawn)) {
    return { gold: gold + ITEM_PRICE[drawn], item: null, soldOn: drawn };
  }
  return { gold, item: drawn, soldOn: null };
}
