import { createStockStore } from './stockstore';

/**
 * seaanchor.ts — the Sea Anchor, a one-shot brake sold as a reading of the
 * chaser rather than a stat.
 *
 * `docs/SHOP_PLAN.md`: "Red boats use pure pursuit and never lead pursuit …
 * so they steer at where the ship IS. Stopping dead makes the chaser
 * overshoot, and `PHASE_MIN` of 5 s does not leave it time to come round for
 * a second pass. The item only works for a player who has understood the
 * chaser, which is why it is the cheapest thing on the list."
 *
 * This file owns the stock and the deploy timer; it does not touch the hull.
 * `ship.ts` reads `isDeployed` each frame (through a `PropulsionState` built
 * by `main.ts`) and is the one place the actual braking happens — forcing
 * thrust to zero and steepening drag to `SEA_ANCHOR_DRAG` for as long as this
 * file says the anchor is over the side.
 *
 * `deploy()` is deliberately the only way stock ever leaves the locker.
 * `stockstore.ts` offers a bare `use()` that spends one with no side effect
 * beyond the count, and this file does not re-export it: a spend that did
 * not also arm the timer would be gold gone with nothing to show for it,
 * which is exactly the failure `shop.ts`'s own `buy()` is written to rule
 * out on the purchase side. `count`/`canBuy`/`buy`/`onChange` are the only
 * parts of the underlying stock this file hands outward.
 */

/** Most that may be stowed. */
export const SEA_ANCHOR_STORE_MAX = 5;

/** How long the anchor takes to kill the ship's way, seconds. */
export const SEA_ANCHOR_KILL_SECONDS = 1;

/** How much longer it then holds the ship stopped, seconds. */
export const SEA_ANCHOR_HOLD_SECONDS = 3;

/** Total seconds `isDeployed` stays true for one use. */
export const SEA_ANCHOR_DEPLOY_SECONDS = SEA_ANCHOR_KILL_SECONDS + SEA_ANCHOR_HOLD_SECONDS;

/**
 * Drag coefficient, 1/s, `ship.ts` substitutes for its own DRAG while
 * deployed.
 *
 * The ship's ordinary DRAG (0.35, see `ship.ts`) has a 2.9 s time constant —
 * nowhere near fast enough to read as "killed" in one second. This one's
 * time constant is a third of a second, so three of them (the kill window)
 * decay any speed the ship was carrying to under 5% of itself, and the
 * ordinary hold-at-zero for the rest of the window is thrust staying at zero
 * against a ship that is already, for practical purposes, stopped.
 */
export const SEA_ANCHOR_DRAG = 3;

export interface SeaAnchorStore {
  /** How many are stowed, a whole number in `[0, SEA_ANCHOR_STORE_MAX]`. */
  readonly count: number;
  /** Whether one more would fit. */
  readonly canBuy: boolean;
  /** Adds one, or returns false when the locker is already full. */
  buy(): boolean;
  /** True for the whole kill-and-hold window after a deploy. */
  readonly isDeployed: boolean;
  /** Whether `deploy()` would do anything. */
  readonly canDeploy: boolean;
  /** Consumes one and starts the window, or returns false and spends nothing. */
  deploy(): boolean;
  /** Counts the deploy window down. A no-op while idle. */
  tick(dt: number): void;
  /** Returns an unsubscribe function. Fires immediately with the current count. */
  onChange(cb: (count: number) => void): () => void;
}

export function createSeaAnchorStore(initial = 0): SeaAnchorStore {
  const stock = createStockStore(SEA_ANCHOR_STORE_MAX, initial);
  /** Seconds left in the current deploy window; 0 means idle. */
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

    get isDeployed(): boolean {
      return remaining > 0;
    },

    get canDeploy(): boolean {
      return remaining <= 0 && stock.canUse;
    },

    deploy(): boolean {
      if (remaining > 0) return false;
      if (!stock.use()) return false;
      remaining = SEA_ANCHOR_DEPLOY_SECONDS;
      return true;
    },

    tick(dt: number): void {
      if (remaining <= 0) return;
      remaining = Math.max(0, remaining - dt);
    },
  };
}
