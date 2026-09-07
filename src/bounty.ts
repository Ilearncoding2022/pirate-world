/**
 * bounty.ts — what a battle is worth, in gold.
 *
 * Pure functions and one table. No wallet, no state, no randomness of its own:
 * every roll takes the caller's `rng` so a run replays, exactly the way
 * `fishsim.ts` and `species.ts` split the odds from the thing that spends
 * them. `main.ts` is the only caller, and the only place gold actually moves.
 *
 * The three outcomes are deliberately asymmetric. A win pays from a tiered
 * table where the small sums are common; a loss takes a SHARE of the purse
 * with a floor and a ceiling, so it stings at every wealth and never wipes a
 * rich player out; a draw is a coin toss for pocket change. See
 * docs/BATTLE_PLAN.md.
 */

/* ------------------------------------------------------------------ */
/* The win table                                                       */
/* ------------------------------------------------------------------ */

/**
 * Tiered win payouts. `chance` values must sum to 1; `rollWinGold` walks them
 * in order and the last tier catches any floating-point remainder, so a table
 * that sums to 0.9999 still returns a number rather than undefined.
 *
 * Expected value is a little under 2,800 gold. Set against a loss that costs
 * 10% of the purse, that keeps a fight worth taking at every purse size
 * without turning it into a gold printer: a player holding 30,000 stakes
 * 3,000 against roughly the same in expectation, and a player holding 5,000
 * stakes only the 500 floor.
 */
export const WIN_TIERS: readonly { chance: number; min: number; max: number }[] = [
  { chance: 0.6, min: 500, max: 1500 },
  { chance: 0.25, min: 1500, max: 4000 },
  { chance: 0.1, min: 4000, max: 10000 },
  { chance: 0.05, min: 10000, max: 20000 },
];

/** Share of the purse a defeat costs, before the floor and the ceiling. */
export const LOSS_SHARE = 0.1;
/**
 * Floor and ceiling on a defeat, in gold.
 *
 * The floor is what makes a fight matter to a player with almost nothing; the
 * ceiling is what stops one bad battle from undoing an hour of fishing. A
 * purse smaller than the floor is simply emptied — `lossGold` never returns
 * more than there is, so `wallet.lose` can be handed the figure unchecked.
 */
export const LOSS_MIN = 500;
export const LOSS_MAX = 10000;

/** A draw moves the purse by up to this, either way. */
export const DRAW_SWING = 1000;

/* ------------------------------------------------------------------ */
/* The rolls                                                           */
/* ------------------------------------------------------------------ */

/** Uniform integer in [min, max], inclusive at both ends. */
function uniformInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Draws a win payout: one number for the tier, one for the amount inside it.
 *
 * TWO draws, always, whatever tier comes up. A tier that consumed a different
 * number of values from the stream than its neighbours would make the seeded
 * sequence depend on its own results, which is the bug that makes a "seeded"
 * run stop replaying the moment anything upstream changes.
 */
export function rollWinGold(rng: () => number): number {
  const pick = rng();
  let acc = 0;
  let tier = WIN_TIERS[WIN_TIERS.length - 1];
  for (const t of WIN_TIERS) {
    acc += t.chance;
    if (pick < acc) {
      tier = t;
      break;
    }
  }
  return uniformInt(rng, tier.min, tier.max);
}

/**
 * What a defeat costs a purse of `purse` gold.
 *
 * Never more than the purse holds, so a player with 200 gold loses 200 rather
 * than going into a debt this game has no concept of.
 */
export function lossGold(purse: number): number {
  if (!Number.isFinite(purse) || purse <= 0) return 0;
  const share = Math.round(purse * LOSS_SHARE);
  const clamped = share < LOSS_MIN ? LOSS_MIN : share > LOSS_MAX ? LOSS_MAX : share;
  return Math.min(clamped, Math.floor(purse));
}

/**
 * A draw's gold swing: a uniform integer in [-DRAW_SWING, +DRAW_SWING],
 * floored at whatever the purse can actually pay.
 *
 * Positive means the player gains. One draw from the stream, always.
 */
export function rollDrawGold(rng: () => number, purse: number): number {
  const swing = uniformInt(rng, -DRAW_SWING, DRAW_SWING);
  if (swing >= 0) return swing;
  const held = Number.isFinite(purse) && purse > 0 ? Math.floor(purse) : 0;
  return -Math.min(held, -swing);
}
