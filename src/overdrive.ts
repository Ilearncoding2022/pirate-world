import { createStockStore } from './stockstore';

/**
 * overdrive.ts — the Overdrive Coil, a 20-second sprint that argues with an
 * existing decision rather than extending it.
 *
 * `docs/SHOP_PLAN.md`: "A sprint that outruns a raider deletes the escape the
 * turn rate was tuned around. Kept in the list because the owner may want it
 * anyway; if it is built, the burn is what has to stop it being the default
 * answer — an escape that costs the fuel to get home is still a decision."
 * `OVERDRIVE_BURN_MULTIPLIER` is that burn: `energy.ts` bills a flat multiple
 * of `FULL_BURN` for the whole window rather than the ordinary
 * speed-squared curve, so lighting the coil costs the same whether or not the
 * ship ever reaches 16 kn.
 *
 * `OVERDRIVE_MAX_FORWARD` (16) clears the raiders' 15 kn on purpose — this is
 * the one item in the shop that is allowed to, and the fuel bill above is
 * what is meant to keep it a last resort rather than a new cruising speed.
 *
 * Same shape as `seaanchor.ts`: `engage()` is the only path that spends a
 * coil, because a spend that did not also arm the window would be gold gone
 * for nothing.
 */

/** Most that may be stowed. */
export const OVERDRIVE_STORE_MAX = 3;

/** How long one coil burns, seconds. */
export const OVERDRIVE_SECONDS = 20;

/** Effective top speed while burning, world units/s. See the file comment on the raiders' 15. */
export const OVERDRIVE_MAX_FORWARD = 16;

/** `energy.ts` bills FULL_BURN times this, flat, for the whole window. */
export const OVERDRIVE_BURN_MULTIPLIER = 4;

export interface OverdriveStore {
  /** How many are stowed, a whole number in `[0, OVERDRIVE_STORE_MAX]`. */
  readonly count: number;
  /** Whether one more would fit. */
  readonly canBuy: boolean;
  /** Adds one, or returns false when the locker is already full. */
  buy(): boolean;
  /** True for the whole burn window after an engage. */
  readonly isActive: boolean;
  /** Whether `engage()` would do anything. */
  readonly canEngage: boolean;
  /** Consumes one and starts the window, or returns false and spends nothing. */
  engage(): boolean;
  /** Counts the burn window down. A no-op while idle. */
  tick(dt: number): void;
  /** Returns an unsubscribe function. Fires immediately with the current count. */
  onChange(cb: (count: number) => void): () => void;
}

export function createOverdriveStore(initial = 0): OverdriveStore {
  const stock = createStockStore(OVERDRIVE_STORE_MAX, initial);
  /** Seconds left in the current burn window; 0 means idle. */
  let remaining = 0;

  return {
    get count(): number {
      return stock.count;
    },
    get canBuy(): boolean {
      return stock.canBuy;
    },
    buy: stock.buy,
    onChange: stock.onChange,

    get isActive(): boolean {
      return remaining > 0;
    },

    get canEngage(): boolean {
      return remaining <= 0 && stock.canUse;
    },

    engage(): boolean {
      if (remaining > 0) return false;
      if (!stock.use()) return false;
      remaining = OVERDRIVE_SECONDS;
      return true;
    },

    tick(dt: number): void {
      if (remaining <= 0) return;
      remaining = Math.max(0, remaining - dt);
    },
  };
}
