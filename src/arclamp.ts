import type { TierStore } from './tierstore';
import { createTierStore } from './tierstore';

/**
 * arclamp.ts — the Arc-Lamp Rig, which lengthens a fishing session's clock.
 *
 * `docs/SHOP_PLAN.md`: "More time with the same ten shots does not hand the
 * player more fish; it lets them *decline* the sardine and wait for the
 * epic. It changes behaviour rather than yield." `SESSION_SHOTS` in
 * `fishsim.ts` is untouched by every tier — the rig sells patience, not
 * extra throws.
 *
 * The 30 below is `SESSION_SECONDS`'s own value, retyped rather than
 * imported, for the same reason `governor.ts` retypes `SESSION_COST`: this
 * file has nothing else `fishsim.ts` would need back, so importing it here
 * only to read one constant is not worth opening that door.
 */

/** Session length by tier, seconds — index 0 is `fishsim.ts`'s own SESSION_SECONDS. */
export const ARC_LAMP_SESSION_SECONDS: readonly number[] = [30, 36, 42, 48];

export const ARC_LAMP_TIER_MAX = ARC_LAMP_SESSION_SECONDS.length - 1;

export interface ArcLampStore extends TierStore {
  /** This tier's session length, seconds. */
  readonly sessionSeconds: number;
}

export function createArcLampStore(initial = 0): ArcLampStore {
  const store = createTierStore(ARC_LAMP_TIER_MAX, initial);
  return {
    get tier(): number {
      return store.tier;
    },
    get canBuy(): boolean {
      return store.canBuy;
    },
    buy: store.buy,
    onChange: store.onChange,
    get sessionSeconds(): number {
      return ARC_LAMP_SESSION_SECONDS[store.tier];
    },
  };
}
