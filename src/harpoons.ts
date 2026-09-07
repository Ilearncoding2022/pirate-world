/**
 * harpoons.ts — the spare-harpoon locker.
 *
 * A whole number, bought five at a time at a berth and spent one at a time in
 * a fishing session. It is deliberately not part of `fishsim.ts`: the sim owns
 * one session and this outlives every session, which is the only reason the
 * locker is worth stocking at all.
 *
 * Two ceilings, and they are different ceilings. `STORE_MAX` is how many can
 * be kept; `PER_SESSION_MAX` is how many of them one session may reach. The
 * second is what keeps the locker from turning the mini-game into a matter of
 * how much gold was brought to it — a stocked player fishes twice as long, not
 * twenty times as long.
 */

/**
 * Harpoons in one purchase. `shop.ts` owns what the bundle costs.
 *
 * Five, so a full session's worth of extras is two purchases rather than one:
 * the locker is a thing a player tops up on the way past a berth, not a switch
 * they flip once and stop thinking about.
 */
export const HARPOON_BUNDLE = 5;

/** Most that may be kept. See the note above on the two ceilings. */
export const HARPOON_STORE_MAX = 100;

/**
 * Most a single session may draw, however full the locker is.
 *
 * Ten, matching the session's own ten. A fully stocked player therefore gets
 * twenty shots at most — twice the water, against a clock that did not get
 * any longer, so the extras buy a session that is fished harder rather than
 * one that runs on after the 30 seconds are up.
 */
export const HARPOON_PER_SESSION_MAX = 10;

export interface HarpoonStore {
  /** Spares in the locker, a whole number in [0, HARPOON_STORE_MAX]. */
  readonly count: number;
  /**
   * Whether another bundle would fit whole.
   *
   * A bundle is sold entire or not at all: buying five and receiving two
   * because the locker was at 97 is a purchase a player would rightly call a
   * swindle, so the offer goes dark at 96 and comes back as soon as five
   * spares have been fired. The consequence — that 100 is only reachable from
   * exactly 95 — is the honest half of the same rule.
   */
  readonly canBuy: boolean;
  /** Adds one bundle, or returns false and changes nothing. */
  buy(): boolean;
  /**
   * Takes up to `n` and returns how many were actually there.
   *
   * A short answer is not an error. `fishing.ts` debits the locker as the
   * shots are fired rather than reserving them at the start of a session,
   * precisely so a tab closed mid-session cannot swallow harpoons that were
   * never thrown.
   */
  spend(n: number): number;
  /** Returns an unsubscribe function. Fires immediately with the current count. */
  onChange(cb: (count: number) => void): () => void;
}

/** A whole count in [0, HARPOON_STORE_MAX], or 0 for anything that is not one. */
function toCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const whole = Math.floor(value);
  return whole > HARPOON_STORE_MAX ? HARPOON_STORE_MAX : whole;
}

export function createHarpoonStore(initial = 0): HarpoonStore {
  let count = toCount(initial);
  const subscribers = new Set<(count: number) => void>();

  function notify(): void {
    // Over a copy: a subscriber may unsubscribe itself from inside its own
    // callback, the same contract `wallet.ts` and `battery.ts` keep.
    for (const cb of Array.from(subscribers)) cb(count);
  }

  return {
    get count(): number {
      return count;
    },

    get canBuy(): boolean {
      return count + HARPOON_BUNDLE <= HARPOON_STORE_MAX;
    },

    buy(): boolean {
      if (count + HARPOON_BUNDLE > HARPOON_STORE_MAX) return false;
      count += HARPOON_BUNDLE;
      notify();
      return true;
    },

    spend(n: number): number {
      const want = Math.floor(n);
      if (!(want > 0) || count === 0) return 0;
      const taken = want < count ? want : count;
      count -= taken;
      notify();
      return taken;
    },

    onChange(cb: (count: number) => void): () => void {
      subscribers.add(cb);
      cb(count);
      return (): void => {
        subscribers.delete(cb);
      };
    },
  };
}
