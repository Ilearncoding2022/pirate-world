/**
 * battery.ts — the backup power cell, bought at a berth and never refilled by
 * the world.
 *
 * A second tank sitting behind the main reserve, holding up to
 * BATTERY_CELLS_MAX cells bought one at a time. `energy.ts` owns when it is
 * drawn on (only once the main tank has actually run out) and `shop.ts` owns
 * what it costs; this file owns nothing but the charge itself and the promise
 * that it can only ever go down outside a purchase.
 *
 * That promise is the whole point of the item. Shore power and the solar
 * panels both write `EnergyState.level` and neither of them can reach in here,
 * so a cell spent crossing a dark ocean is gold gone: the backup is a
 * consumable dressed as a battery, and the reason a player thinks twice before
 * leaning on it.
 */

/**
 * How much charge ONE cell holds, as a fraction of the MAIN tank.
 *
 * Half a tank. It is deliberately a fraction of the main reserve rather than a
 * unit of its own, because everything that spends power — the quadratic burn,
 * the hotel load, a fishing session's 50% — is already written in those terms,
 * and a second unit would mean a conversion at every one of those sites.
 *
 * Half is also what makes the cell worth its price in exactly one currency:
 * it is one fishing session, or about 45 s flat out, or a night and a half
 * hove to. Any of those, once, and then it is gone.
 *
 * This is what a purchase BUYS. What the ship can hold is BATTERY_CAPACITY
 * below, and the two were the same number until the second cell existed.
 */
export const BATTERY_CELL = 0.5;

/**
 * How many cells the ship can stow.
 *
 * Two, so a player standing at a berth with 2000 gold can leave with a full
 * tank's worth of backup instead of half of one. The second cell costs exactly
 * what the first did (`shop.ts`'s BATTERY_PRICE, one price for one cell), so
 * this buys no discount and no penalty — only the option of carrying more,
 * which is the whole of what was asked for. It is the range of a long crossing
 * that changes, not the price of power.
 */
export const BATTERY_CELLS_MAX = 2;

/**
 * The most charge the cells can hold between them, in main-tank fractions.
 *
 * DERIVED, so a third cell or a resized one moves the save file's cap
 * (`save.ts`), the HUD's bar (`hud.ts`) and the shop's stock line together
 * instead of leaving three places to remember. Everything outside this file
 * that asks "how full can the backup get" asks this and not BATTERY_CELL.
 */
export const BATTERY_CAPACITY = BATTERY_CELL * BATTERY_CELLS_MAX;

export interface Battery {
  /** Charge held, in main-tank fractions, in [0, BATTERY_CAPACITY]. */
  readonly level: number;
  /** True when a purchase would add nothing. `shop.ts` dims the offer on this. */
  readonly isFull: boolean;
  /**
   * The charge as the save file holds it: whole percent of a main tank,
   * 0 to `BATTERY_CAPACITY * 100`.
   *
   * Rounded DOWN, so a reload can never hand back more charge than was
   * actually aboard. The most it can cost is the last percent of a cell.
   */
  readonly percent: number;
  /**
   * Adds ONE cell's charge, capped at BATTERY_CAPACITY. Returns false — and
   * changes nothing — when the store was already full, so a caller cannot
   * charge the wallet for nothing.
   *
   * Adds a fixed amount rather than filling to the top, which is what keeps
   * the old rule intact now that there is room for two: the shop sells one
   * cell at one price, so buying at 90% pays a full price for a tenth and
   * wastes the rest. A `charge()` that topped up to capacity instead would
   * make the cheapest way to stay full a purchase every time a berth went
   * past — the same trap the single-cell version was written to avoid, moved
   * up the bar rather than removed.
   */
  charge(): boolean;
  /**
   * Draws up to `want` and returns what was actually there to draw.
   *
   * A short answer is not an error: it is the cell running out mid-frame, and
   * `energy.ts` reads the shortfall as exactly that.
   */
  draw(want: number): number;
  /**
   * Returns an unsubscribe function. Fires immediately with the current level.
   *
   * Subscribers are notified when the PERSISTED figure moves — that is, when
   * `percent` changes — and not on every draw. The only subscriber is the save
   * file, and a cell bleeding away under a full-throttle burn crosses a
   * hundredth of a tank about once a second; notifying per frame would mean
   * sixty `localStorage` writes a second for a number that is only ever read
   * back once, at boot.
   */
  onChange(cb: (level: number) => void): () => void;
}

/** A charge in [0, BATTERY_CAPACITY], or 0 for anything that is not a number. */
function toLevel(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > BATTERY_CAPACITY ? BATTERY_CAPACITY : value;
}

/**
 * The cell, seeded from the save's whole-percent figure.
 *
 * `initialPercent` is the save file's own unit rather than a fraction, so the
 * one place the two representations meet is here and `save.ts` never has to
 * know what a tank fraction is.
 */
export function createBattery(initialPercent = 0): Battery {
  let level = toLevel(initialPercent / 100);
  let lastPercent = Math.floor(level * 100);
  const subscribers = new Set<(level: number) => void>();

  function notifyIfPersistedChanged(): void {
    const percent = Math.floor(level * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    // Over a copy: a subscriber is allowed to unsubscribe itself from inside
    // its own callback, the same contract `wallet.ts` keeps.
    for (const cb of Array.from(subscribers)) cb(level);
  }

  return {
    get level(): number {
      return level;
    },

    get isFull(): boolean {
      // A hair under capacity is full for the purposes of an offer: the
      // alternative is a 1000-gold button that stays lit to sell back the
      // rounding error left by a single frame of draw.
      return level >= BATTERY_CAPACITY - 1e-6;
    },

    get percent(): number {
      return Math.floor(level * 100);
    },

    charge(): boolean {
      if (level >= BATTERY_CAPACITY - 1e-6) return false;
      level += BATTERY_CELL;
      // The overflow a top-up wastes. Clamped rather than refused, because
      // refusing would mean a cell at 90% could not be topped up at all.
      if (level > BATTERY_CAPACITY) level = BATTERY_CAPACITY;
      notifyIfPersistedChanged();
      return true;
    },

    draw(want: number): number {
      if (!(want > 0) || level <= 0) return 0;
      const drawn = want < level ? want : level;
      level -= drawn;
      // Float dust, not a rule: the line above already guarantees a
      // non-negative result, and this only stops a cell reading -1e-19.
      if (level < 1e-9) level = 0;
      notifyIfPersistedChanged();
      return drawn;
    },

    onChange(cb: (level: number) => void): () => void {
      subscribers.add(cb);
      // Immediately, with the current value, for the same reason `wallet.ts`
      // does it: a subscriber that had to wait for the first change would
      // render a stale figure until one arrived.
      cb(level);
      return (): void => {
        subscribers.delete(cb);
      };
    },
  };
}
