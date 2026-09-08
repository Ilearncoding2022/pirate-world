import type { TierStore } from './tierstore';
import { createTierStore } from './tierstore';

/**
 * trim.ts — Trim & Sheathing, the hull upgrade that raises the ship's top
 * speed.
 *
 * `docs/SHOP_PLAN.md`: "Trim & Sheathing tops out at 13 kn deliberately,
 * against the raiders' 15. Both hulls are faster than the player on purpose
 * … and the whole upgrade path is built to leave that intact." Mk III is
 * therefore the last tier this file will ever offer — the plan calls a
 * fourth tier out explicitly as the one upgrade that must not exist.
 *
 * `ACCEL = MAX_FORWARD * DRAG` in `ship.ts` means a higher top speed already
 * buys proportionally more acceleration at no separate cost, so this file has
 * only one number to carry: the top speed itself.
 *
 * One simplification, made deliberately rather than by omission: `energy.ts`
 * and `wake.ts` still normalise their speed-driven curves against the base
 * `MAX_FORWARD` of 10, not against the upgraded figure. A Trim III ship
 * running flat out at 13 kn therefore burns somewhat more than a curve
 * rescaled to the new top speed would charge, and its wake saturates a
 * little under full throttle rather than exactly at it. Both are cosmetic
 * or economic rather than broken, and the extra burn if anything strengthens
 * the plan's own point about this upgrade — a faster ship is a hungrier one,
 * not a strictly better one.
 */

/** Effective top speed by tier, world units/s — index 0 is the unmodified hull. */
export const TRIM_MAX_FORWARD: readonly number[] = [10, 11, 12, 13];

/** The last tier this file will ever sell. See the note on the raiders' 15 kn above. */
export const TRIM_TIER_MAX = TRIM_MAX_FORWARD.length - 1;

export interface TrimStore extends TierStore {
  /** The ship's effective top speed at the current tier, world units/s. */
  readonly maxForward: number;
}

export function createTrimStore(initial = 0): TrimStore {
  const store = createTierStore(TRIM_TIER_MAX, initial);
  return {
    // Forwarded one property at a time rather than spread: `tier` and
    // `canBuy` are live getters on `store`, and an object spread reads a
    // getter once at spread time and bakes the result into a plain value —
    // exactly the kind of one-shot snapshot every store in this project is
    // written to avoid. `buy` and `onChange` are plain functions closed over
    // `store`'s own state, so those two forward safely by reference.
    get tier(): number {
      return store.tier;
    },
    get canBuy(): boolean {
      return store.canBuy;
    },
    buy: store.buy,
    onChange: store.onChange,
    get maxForward(): number {
      return TRIM_MAX_FORWARD[store.tier];
    },
  };
}
