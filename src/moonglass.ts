import type { TierStore } from './tierstore';
import { createTierStore } from './tierstore';

/**
 * moonglass.ts — the Moonglass Array, a night-charging upgrade for the solar
 * panels.
 *
 * `docs/SHOP_PLAN.md`: "Night solar at 8/14/22% of `SOLAR_PEAK`, ×
 * `env.moonIllumination`." The moon is otherwise decoration — see
 * `daynight.ts`'s `MOON_MONTH_DAYS` comment — and this is the item that gives
 * it a job: a full moon becomes a slow trickle home, and a new moon a
 * crossing the player had better carry a backup cell for.
 *
 * `energy.ts` is the only reader of `nightFraction`. It multiplies it against
 * `SOLAR_PEAK` and `env.moonIllumination` itself, gated to hours the sun
 * contributes nothing — this file only ever hands back the tier's own share.
 */

/** Share of SOLAR_PEAK the array reaches by tier — index 0 is no array at all. */
export const MOONGLASS_NIGHT_FRACTION: readonly number[] = [0, 0.08, 0.14, 0.22];

export const MOONGLASS_TIER_MAX = MOONGLASS_NIGHT_FRACTION.length - 1;

export interface MoonglassStore extends TierStore {
  /** This tier's share of SOLAR_PEAK, applied by `energy.ts` at night. */
  readonly nightFraction: number;
}

export function createMoonglassStore(initial = 0): MoonglassStore {
  const store = createTierStore(MOONGLASS_TIER_MAX, initial);
  return {
    get tier(): number {
      return store.tier;
    },
    get canBuy(): boolean {
      return store.canBuy;
    },
    buy: store.buy,
    onChange: store.onChange,
    get nightFraction(): number {
      return MOONGLASS_NIGHT_FRACTION[store.tier];
    },
  };
}
