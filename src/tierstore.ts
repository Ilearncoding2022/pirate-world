/**
 * tierstore.ts — the shape shared by every durable in the chandlery.
 *
 * `docs/SHOP_PLAN.md` organises the twelve proposed items under one rule:
 * "Durables raise ceilings. Consumables remain the thing you spend." Four of
 * the eight built here are durables under that rule — Trim & Sheathing,
 * Moonglass Array, Arc-Lamp Rig, Efficiency Governor — and all four have
 * exactly the same shape: a whole tier in `[0, tiers.length - 1]`, bought one
 * step at a time, with tier 0 being the ship as it always was. `trim.ts`,
 * `moonglass.ts`, `arclamp.ts` and `governor.ts` each wrap one call here
 * rather than reimplementing the same four methods four times with four
 * chances to disagree about what "the last tier" means.
 *
 * What is deliberately NOT shared: price. Exactly as `shop.ts` prices the
 * battery cell and the harpoon bundle rather than `battery.ts` or
 * `harpoons.ts` pricing themselves, a tier's cost is the chandlery's business
 * and this file never sees a gold figure. It only ever answers "is there a
 * next tier" and "move to it."
 */

export interface TierStore {
  /** The tier bought so far, a whole number in `[0, tiers.length - 1]`. */
  readonly tier: number;
  /** Whether a further purchase would move the tier at all. */
  readonly canBuy: boolean;
  /** Moves up one tier, or returns false and changes nothing at the last one. */
  buy(): boolean;
  /** Returns an unsubscribe function. Fires immediately with the current tier. */
  onChange(cb: (tier: number) => void): () => void;
}

/** A whole tier in `[0, maxTier]`, or 0 for anything that is not one. */
function toTier(value: number, maxTier: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const whole = Math.floor(value);
  return whole > maxTier ? maxTier : whole;
}

/**
 * Builds one durable's tier counter.
 *
 * `tierCount` is the number of tiers ABOVE zero — three for every durable in
 * the plan, Mk I through Mk III — so the highest reachable tier is
 * `tierCount` itself and `initial` is clamped against that rather than
 * against the length of some array the caller has not necessarily built yet.
 */
export function createTierStore(tierCount: number, initial = 0): TierStore {
  let tier = toTier(initial, tierCount);
  const subscribers = new Set<(tier: number) => void>();

  function notify(): void {
    // Over a copy: a subscriber may unsubscribe itself from inside its own
    // callback, the same contract every other store in the project keeps.
    for (const cb of Array.from(subscribers)) cb(tier);
  }

  return {
    get tier(): number {
      return tier;
    },

    get canBuy(): boolean {
      return tier < tierCount;
    },

    buy(): boolean {
      if (tier >= tierCount) return false;
      tier += 1;
      notify();
      return true;
    },

    onChange(cb: (tier: number) => void): () => void {
      subscribers.add(cb);
      cb(tier);
      return (): void => {
        subscribers.delete(cb);
      };
    },
  };
}
