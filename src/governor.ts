import type { TierStore } from './tierstore';
import { createTierStore } from './tierstore';

/**
 * governor.ts — the Efficiency Governor, which lowers what a fishing session
 * costs the power plant.
 *
 * `docs/SHOP_PLAN.md`: "The compounding one, and the reason to price it
 * high: at Mk III it nearly doubles the sessions in a tank, which is worth
 * more over a run than any per-session item and would trivialise the backup
 * cell if it were cheap." `fishing.ts`'s own `SESSION_COST` is the tier-0
 * figure this file starts from.
 *
 * The 0.5 below is that constant's value, RETYPED rather than imported.
 * `fishing.ts` is the one file that has to import this one — `deps.governor`
 * is what it charges a session against — so importing back would be a
 * circular dependency between the two. `tools/` carries no probe for this
 * pair the way `species.ts`'s odds have one; a change to `SESSION_COST`
 * therefore has to be echoed here by hand.
 */

/** Share of a tank one session costs, by tier — index 0 is `fishing.ts`'s SESSION_COST. */
export const GOVERNOR_SESSION_COST: readonly number[] = [0.5, 0.42, 0.34, 0.26];

export const GOVERNOR_TIER_MAX = GOVERNOR_SESSION_COST.length - 1;

export interface GovernorStore extends TierStore {
  /** This tier's session price, as a fraction of the main tank. */
  readonly sessionCost: number;
}

export function createGovernorStore(initial = 0): GovernorStore {
  const store = createTierStore(GOVERNOR_TIER_MAX, initial);
  return {
    get tier(): number {
      return store.tier;
    },
    get canBuy(): boolean {
      return store.canBuy;
    },
    buy: store.buy,
    onChange: store.onChange,
    get sessionCost(): number {
      return GOVERNOR_SESSION_COST[store.tier];
    },
  };
}
