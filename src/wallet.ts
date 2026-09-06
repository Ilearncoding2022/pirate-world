/**
 * wallet.ts — the player's gold.
 *
 * The ONLY writer of the gold figure. The HUD and the fishing card both
 * subscribe rather than polling, so a catch updates every place it shows in
 * the same tick and none of them can drift.
 *
 * It is deliberately not a store of the *save*: it knows nothing about
 * localStorage. `save.ts`'s `createRecords()` subscribes to it and writes the
 * file, which is what keeps persistence a single wiring job rather than a
 * responsibility spread across every module that spends or earns.
 */
export interface Wallet {
  readonly gold: number;
  /** Adds (never subtracts, for now) and notifies every subscriber. */
  add(amount: number): void;
  /** Returns an unsubscribe function. Fires immediately with the current gold. */
  onChange(cb: (gold: number) => void): () => void;
}

/**
 * A whole, non-negative gold figure, or 0 for anything that is not one.
 *
 * The wallet is the only writer, so it is also the last place a NaN can be
 * stopped: one `gold += NaN` is permanent — every later add leaves it NaN, the
 * HUD prints "NaN", and the next `writeSave` puts it in the file, where
 * `loadSave` will (correctly) throw the player's whole balance away. Cheaper to
 * refuse the bad number here than to repair its consequences there.
 */
function toGold(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function createWallet(initialGold = 0): Wallet {
  let gold = toGold(initialGold);
  const subscribers = new Set<(gold: number) => void>();

  function notify(): void {
    // Over a copy: a subscriber is allowed to unsubscribe itself from inside
    // its own callback, which is exactly what a panel's dispose() does.
    for (const cb of Array.from(subscribers)) cb(gold);
  }

  return {
    get gold(): number {
      return gold;
    },

    add(amount: number): void {
      const delta = toGold(amount);
      // A refused or zero amount notifies nobody: subscribers redraw on this,
      // and a "change" that changed nothing would repaint the HUD and rewrite
      // the save file for free.
      if (delta === 0) return;
      gold += delta;
      notify();
    },

    onChange(cb: (gold: number) => void): () => void {
      subscribers.add(cb);
      // Immediately, with the current value. A subscriber that had to wait for
      // the first change would render a stale figure — zero, usually — for
      // however long that took, which on a loaded save is the whole session
      // until the first catch.
      cb(gold);
      return (): void => {
        subscribers.delete(cb);
      };
    },
  };
}
