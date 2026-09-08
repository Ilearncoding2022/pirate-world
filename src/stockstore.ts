/**
 * stockstore.ts — the shape shared by every one-at-a-time consumable in the
 * chandlery.
 *
 * `harpoons.ts` is the locker's own thing: bundles of five, a session ceiling
 * separate from the store ceiling, spent in whatever quantity a session
 * happens to fire. The four consumables built from `docs/SHOP_PLAN.md` —
 * Sea Anchor, Overdrive Coil, Chum Drum, Barbed Heads — are simpler than
 * that on both ends. Each is bought one at a time (they cost hundreds of
 * gold apiece, not a bundle's worth), and each is spent exactly one at a
 * time, on the occasion the player chooses to use it rather than against a
 * per-session budget. `seaanchor.ts`, `overdrive.ts`, `chumdrum.ts` and
 * `barbedheads.ts` each wrap one call here instead of writing the same stock
 * counter four times.
 *
 * As with `tierstore.ts`, price is deliberately absent: `shop.ts` prices
 * every offer, and this file only ever answers "is there room for one more"
 * and "is there one to spend."
 */

export interface StockStore {
  /** How many are stowed, a whole number in `[0, max]`. */
  readonly count: number;
  /** Whether one more would fit. */
  readonly canBuy: boolean;
  /** Adds one, or returns false and changes nothing when the locker is full. */
  buy(): boolean;
  /** Whether there is one to spend. */
  readonly canUse: boolean;
  /** Spends one, or returns false and changes nothing when there is none. */
  use(): boolean;
  /** Returns an unsubscribe function. Fires immediately with the current count. */
  onChange(cb: (count: number) => void): () => void;
}

/** A whole count in `[0, max]`, or 0 for anything that is not one. */
function toCount(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const whole = Math.floor(value);
  return whole > max ? max : whole;
}

export function createStockStore(max: number, initial = 0): StockStore {
  let count = toCount(initial, max);
  const subscribers = new Set<(count: number) => void>();

  function notify(): void {
    // Over a copy: a subscriber may unsubscribe itself from inside its own
    // callback, the same contract every other store in the project keeps.
    for (const cb of Array.from(subscribers)) cb(count);
  }

  return {
    get count(): number {
      return count;
    },

    get canBuy(): boolean {
      return count < max;
    },

    buy(): boolean {
      if (count >= max) return false;
      count += 1;
      notify();
      return true;
    },

    get canUse(): boolean {
      return count > 0;
    },

    use(): boolean {
      if (count <= 0) return false;
      count -= 1;
      notify();
      return true;
    },

    onChange(cb: (count: number) => void): () => void {
      subscribers.add(cb);
      cb(count);
      return (): void => {
        subscribers.delete(cb);
      };
    },
  };
}
