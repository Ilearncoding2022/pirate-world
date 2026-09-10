import { REPUTATION_FLOOR } from './questconstants';

/**
 * reputation.ts — the player's standing with the harbours.
 *
 * One signed integer, and the ONLY writer of it. Built on `wallet.ts`'s shape
 * deliberately: a store that owns one number, notifies rather than being
 * polled, and knows nothing about `localStorage` — `save.ts`'s `createRecords`
 * subscribes to it and writes the file, which is what keeps persistence one
 * wiring job instead of a responsibility spread across everything that earns.
 *
 * ## Why it is not a second wallet
 *
 * The wallet refuses a negative balance, floors at zero and splits taking into
 * `spend` (all or nothing) and `lose` (best effort). None of that applies here.
 * Reputation is *signed*: a captain who fails three contracts is at -15 and
 * that is a real reading, not an error to be clamped to zero. So there is no
 * `spend` and no refusal — `penalise` always succeeds, because a deadline that
 * has passed has passed whether the player can afford it or not. The only bound
 * is `REPUTATION_FLOOR`, and the asymmetry (a floor and no ceiling) is the
 * owner's decision; see `questconstants.ts` for the argument.
 *
 * ## What it buys
 *
 * Nothing, yet. That is Phase 2's question and `docs/QUESTS_PLAN.md` names the
 * candidates. It is worth being explicit that this is deliberate rather than
 * unfinished: the points are earned, spent, shown and saved from the first
 * commit, so by the time there is something to gate on them the history is
 * already there. A system introduced at the same moment as its consequence
 * would start every existing player at zero.
 */
export interface Reputation {
  /** Standing. An integer in [`REPUTATION_FLOOR`, +inf). */
  readonly points: number;
  /**
   * Earns `amount`. Non-positive and non-finite amounts are ignored.
   *
   * Named `award` rather than `add` because the caller is always a completion:
   * there is no other way up, and a method called `add` invites a caller to
   * pass a negative and bypass the floor below.
   */
  award(amount: number): void;
  /**
   * Costs `amount`, stopping at the floor. Never refuses.
   *
   * `amount` is a POSITIVE magnitude, like `wallet.lose`'s, so a caller cannot
   * accidentally gain standing by failing a contract with a sign error.
   */
  penalise(amount: number): void;
  /** Returns an unsubscribe function. Fires immediately with the current total. */
  onChange(cb: (points: number) => void): () => void;
}

/**
 * A whole, positive magnitude, or 0 for anything that is not one.
 *
 * Both ways in come through this, for the reason `wallet.ts` gives on its own
 * guard: one `points += NaN` is permanent, and the next write puts it in the
 * save file where the loader will correctly throw the player's standing away.
 * Cheaper to refuse the bad number here than to repair it there.
 */
function toMagnitude(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * A whole total at or above the floor, for the figure coming off disk.
 *
 * Applied on construction as well as on `penalise`, because the file is the
 * one input this module does not control: an edited save claiming -10 000
 * should come up at the floor rather than be trusted, and a save from a later
 * build with a lower floor should be brought up to this one's.
 */
function toTotal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const whole = Math.round(value);
  return whole < REPUTATION_FLOOR ? REPUTATION_FLOOR : whole;
}

export function createReputation(initial = 0): Reputation {
  let points = toTotal(initial);
  const subscribers = new Set<(points: number) => void>();

  function notify(): void {
    // Over a copy, on `wallet.ts`'s terms: a subscriber is allowed to
    // unsubscribe itself from inside its own callback.
    for (const cb of Array.from(subscribers)) cb(points);
  }

  return {
    get points(): number {
      return points;
    },

    award(amount: number): void {
      const delta = toMagnitude(amount);
      // A zero notifies nobody. Subscribers redraw and rewrite the save on
      // this, and a "change" that changed nothing would do both for free.
      if (delta === 0) return;
      points += delta;
      notify();
    },

    penalise(amount: number): void {
      const cost = toMagnitude(amount);
      if (cost === 0) return;
      const next = points - cost < REPUTATION_FLOOR ? REPUTATION_FLOOR : points - cost;
      // Already on the floor: the failure still happened, it simply costs
      // nothing more. Notifying here would rewrite the save on every expiry
      // for a number that did not move.
      if (next === points) return;
      points = next;
      notify();
    },

    onChange(cb: (points: number) => void): () => void {
      subscribers.add(cb);
      // Immediately, with the current value, for `wallet.ts`'s reason: a
      // subscriber that waited for the first change would show 0 for the whole
      // session on a loaded save until the first contract settled.
      cb(points);
      return (): void => {
        subscribers.delete(cb);
      };
    },
  };
}
