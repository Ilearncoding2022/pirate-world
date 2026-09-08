import type { StockStore } from './stockstore';
import { createStockStore } from './stockstore';

/**
 * barbedheads.ts — Barbed Heads, one session at a slower tension drain.
 *
 * `docs/SHOP_PLAN.md`: "Targets the exact failure mode of the best fish.
 * Tiers 4 and 5 struggle, draining tension at 0.45 and 0.60 a second against
 * a `TENSION_GAIN` of 0.12 a press — 3.8 and 5.0 taps a second to hold — and
 * a fish whose tension reaches zero is lost outright... the only offer that
 * makes a hard fight winnable rather than skippable."
 *
 * `BARBED_HEADS_DRAIN_SCALE` is the number `fishsim.ts` multiplies every
 * row's `TENSION_DRAIN` by for the length of an armed session — at 0.7 the
 * two hardest fish drain at 0.315 and 0.42 a second, 2.6 and 3.5 taps
 * instead of 3.8 and 5.0. `fishcover.ts` is where a player chooses to spend
 * one; this file only holds the stock.
 */

/** Most that may be stowed. */
export const BARBED_HEADS_STORE_MAX = 5;

/** Multiplier on every row's TENSION_DRAIN for an armed session. */
export const BARBED_HEADS_DRAIN_SCALE = 0.7;

export type BarbedHeadsStore = StockStore;

export function createBarbedHeadsStore(initial = 0): BarbedHeadsStore {
  return createStockStore(BARBED_HEADS_STORE_MAX, initial);
}
