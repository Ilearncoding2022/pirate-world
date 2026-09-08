import type { StockStore } from './stockstore';
import { createStockStore } from './stockstore';

/**
 * chumdrum.ts — the Chum Drum, one session's spawn roll leaned toward the
 * better fish.
 *
 * `docs/SHOP_PLAN.md` prices this on one lever out of four — "what
 * appears" — deliberately separate from the others: `arclamp.ts` changes how
 * long the window is, `governor.ts` how often it can be opened, and
 * `barbedheads.ts` (Barbed Heads) how forgiving the strongest fish are.
 *
 * `CHUM_DRUM_MIN_TIER` is the number `species.ts`'s `rollSpecies` reads when
 * a drum is armed: every tier below it is zeroed out of that spawn's odds
 * rather than merely boosted, which is what "biased toward tier 3+" means
 * literally rather than approximately. `fishcover.ts` is where a player
 * chooses to spend one; this file only holds the stock.
 */

/** Most that may be stowed. */
export const CHUM_DRUM_STORE_MAX = 5;

/** The lowest tier a biased spawn roll may still produce. See `species.ts`. */
export const CHUM_DRUM_MIN_TIER = 3;

export type ChumDrumStore = StockStore;

export function createChumDrumStore(initial = 0): ChumDrumStore {
  return createStockStore(CHUM_DRUM_STORE_MAX, initial);
}
