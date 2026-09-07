import type { Battery } from './battery';
import type { HarpoonStore } from './harpoons';
import type { Wallet } from './wallet';
import { BATTERY_CAPACITY, BATTERY_CELL, BATTERY_CELLS_MAX } from './battery';
import { HARPOON_BUNDLE, HARPOON_PER_SESSION_MAX, HARPOON_STORE_MAX } from './harpoons';

/**
 * shop.ts — the chandlery, open only alongside a berth.
 *
 * Two offers and nothing else. It owns its own DOM and its own Escape, the
 * same shape `fishbook.ts` has, and it knows nothing about who is allowed to
 * open it: `main.ts` gates that on the berth, and `hud.ts` dims the key when
 * there is no berth to gate on.
 *
 * Every purchase is two all-or-nothing moves in a fixed order — take the gold,
 * then hand over the goods — and the second one is tested BEFORE the first
 * runs. See `buy` below: it is the one place in the project where gold can go
 * out, and the one arrangement in which it cannot go out for nothing.
 */

/**
 * Gold for one backup cell.
 *
 * A thousand, against catches worth 4 to 320. That is roughly a good session
 * and a half for half a tank you can only spend once, which is what keeps the
 * cell an insurance policy rather than a fuel supply: a player who buys one
 * every time they pass a berth is fishing to pay for the fishing.
 *
 * One price for one cell, and the SECOND cell costs the same as the first.
 * The ship stows `BATTERY_CELLS_MAX` of them, so a full backup is this price
 * twice over — no bulk discount, because the point of the second cell is
 * range on a long crossing and not cheaper power.
 */
export const BATTERY_PRICE = 1000;

/**
 * Gold for one bundle of five spare harpoons.
 *
 * Half the cell's price for half a session's extra shots, so the two offers
 * cost about the same per minute of fishing and the choice between them is
 * about what the player is short of rather than about which is better value.
 */
export const HARPOONS_PRICE = 500;

export interface ShopPanel {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

/** U+2009 THIN SPACE, as everywhere else a gold figure is printed. */
const THIN_SPACE = ' ';

/** "1 000" — grouped from four digits up, matching the Fish Book's footer. */
function formatGold(gold: number): string {
  const digits = String(Math.max(0, Math.floor(gold)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += THIN_SPACE;
    out += digits[i];
  }
  return out;
}

/** Returns a setter that writes textContent only when the value changed. */
function textWriter(el: HTMLElement | null): (value: string) => void {
  let last: string | null = null;
  return (value: string): void => {
    if (el === null || value === last) return;
    last = value;
    el.textContent = value;
  };
}

/**
 * Returns a setter that arms or dims an offer, carrying the reason with it.
 *
 * The same pairing `hud.ts`'s `gateWriter` keeps, and for the same reason: a
 * dead button that does not say why is worse than one that never explains
 * itself. The difference is that this one has several reasons to be dead —
 * short of gold, cell already full, locker full — and the caller picks.
 */
function offerWriter(el: HTMLButtonElement | null): (armed: boolean, reason: string) => void {
  let lastArmed: boolean | null = null;
  let lastReason: string | null = null;
  return (armed: boolean, reason: string): void => {
    if (el === null || (armed === lastArmed && reason === lastReason)) return;
    lastArmed = armed;
    lastReason = reason;
    el.disabled = !armed;
    if (armed) el.removeAttribute('title');
    else el.setAttribute('title', reason);
  };
}

export interface ShopDeps {
  readonly wallet: Wallet;
  readonly battery: Battery;
  readonly harpoons: HarpoonStore;
}

/**
 * The chandlery panel.
 *
 * Returns a controller that does nothing at all when its markup is absent, on
 * the same terms `fishing.ts` and `radar.ts` do: a missing display must not
 * take the frame loop down, and — the part that matters where money is
 * involved — it must not be able to spend anything either.
 */
export function createShop(deps: ShopDeps): ShopPanel {
  const root = document.getElementById('shop');
  const backdrop = document.getElementById('shop-backdrop');
  const closeButton = document.getElementById('shop-close');
  const purse = document.getElementById('shop-purse');
  const batteryStock = document.getElementById('shop-battery-stock');
  const harpoonStock = document.getElementById('shop-harpoon-stock');
  const batteryBuy = document.getElementById('shop-battery-buy');
  const harpoonBuy = document.getElementById('shop-harpoon-buy');

  if (
    root === null ||
    !(batteryBuy instanceof HTMLButtonElement) ||
    !(harpoonBuy instanceof HTMLButtonElement)
  ) {
    return {
      isOpen: false,
      open: (): void => undefined,
      close: (): void => undefined,
      dispose: (): void => undefined,
    };
  }

  const overlay: HTMLElement = root;
  const buyBattery: HTMLButtonElement = batteryBuy;
  const buyHarpoons: HTMLButtonElement = harpoonBuy;

  // The three figures the offers are actually written in -- half a tank, five
  // harpoons, and the two prices -- are stamped into the markup here rather
  // than typed into index.html, so a retune of any of them moves the words on
  // the buttons with it instead of leaving the panel advertising the old deal.
  //
  // BATTERY_CELL and not BATTERY_CAPACITY: this line describes what ONE
  // purchase hands over, which is half a tank, while the stock line below
  // describes what the ship can hold, which is now two of them.
  textWriter(document.getElementById('shop-battery-detail'))(
    `One full charge · ${Math.round(BATTERY_CELL * 100)}% of a tank · ` +
      `stows ${BATTERY_CELLS_MAX}`,
  );
  textWriter(document.getElementById('shop-harpoon-detail'))(
    `${HARPOON_BUNDLE} spare harpoons · up to ${HARPOON_PER_SESSION_MAX} a session`,
  );
  textWriter(document.getElementById('shop-battery-price'))(`${formatGold(BATTERY_PRICE)} G`);
  textWriter(document.getElementById('shop-harpoon-price'))(`${formatGold(HARPOONS_PRICE)} G`);

  const writePurse = textWriter(purse);
  const writeBatteryStock = textWriter(batteryStock);
  const writeHarpoonStock = textWriter(harpoonStock);
  const writeBatteryOffer = offerWriter(buyBattery);
  const writeHarpoonOffer = offerWriter(buyHarpoons);

  /**
   * Redraws both offers off the three stores.
   *
   * Subscribed to all three rather than called after a purchase, because the
   * purse also moves while this panel is shut — a session banked between two
   * visits — and a shop that only refreshed on its own clicks would open
   * showing the balance the player had last time.
   */
  function refresh(): void {
    writePurse(formatGold(deps.wallet.gold));

    const cellPercent = Math.round(deps.battery.level * 100);
    writeBatteryStock(`${cellPercent}% / ${Math.round(BATTERY_CAPACITY * 100)}%`);
    if (deps.battery.isFull) writeBatteryOffer(false, 'Both cells are already full');
    else writeBatteryOffer(deps.wallet.gold >= BATTERY_PRICE, `Needs ${BATTERY_PRICE} gold`);

    writeHarpoonStock(`${deps.harpoons.count} / ${HARPOON_STORE_MAX}`);
    if (!deps.harpoons.canBuy) {
      writeHarpoonOffer(false, `The locker holds ${HARPOON_STORE_MAX}`);
    } else {
      writeHarpoonOffer(deps.wallet.gold >= HARPOONS_PRICE, `Needs ${HARPOONS_PRICE} gold`);
    }
  }

  /**
   * One purchase: test the goods, take the gold, hand the goods over.
   *
   * `canTake` is asked BEFORE the wallet is touched, and `take` is only ever
   * called on gold that has already been debited. The order matters because
   * both halves can refuse — a full cell refuses a charge, a full locker
   * refuses a bundle — and the arrangement where the wallet goes first would
   * have a refusal on the second half mean gold spent on nothing.
   */
  function buy(price: number, canTake: () => boolean, take: () => boolean): void {
    if (!canTake()) return;
    if (!deps.wallet.spend(price)) return;
    if (!take()) {
      // Cannot happen: `canTake` was true one statement ago and nothing
      // between here and there can have changed it — the world is frozen
      // while this panel is up. Refunding rather than asserting because the
      // one thing this file must never do is take gold and give nothing.
      deps.wallet.add(price);
    }
  }

  function onBuyBattery(): void {
    buy(
      BATTERY_PRICE,
      () => !deps.battery.isFull,
      () => deps.battery.charge(),
    );
  }

  function onBuyHarpoons(): void {
    buy(
      HARPOONS_PRICE,
      () => deps.harpoons.canBuy,
      () => deps.harpoons.buy(),
    );
  }

  const unsubWallet = deps.wallet.onChange(refresh);
  const unsubBattery = deps.battery.onChange(refresh);
  const unsubHarpoons = deps.harpoons.onChange(refresh);
  refresh();

  let open = false;

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    overlay.hidden = !next;
    overlay.setAttribute('aria-hidden', next ? 'false' : 'true');
    // The subscriptions above have kept the panel current the whole time it
    // was shut, so opening is only the focus.
    if (next) closeButton?.focus();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Guarded on `open` rather than added and removed with the panel: one
    // listener for the life of the run cannot leak and cannot be missing for
    // the frame between the click and the paint.
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    setOpen(false);
  }

  function onClose(): void {
    setOpen(false);
  }

  window.addEventListener('keydown', onKeyDown);
  closeButton?.addEventListener('click', onClose);
  backdrop?.addEventListener('click', onClose);
  buyBattery.addEventListener('click', onBuyBattery);
  buyHarpoons.addEventListener('click', onBuyHarpoons);

  return {
    get isOpen(): boolean {
      return open;
    },
    open(): void {
      setOpen(true);
    },
    close(): void {
      setOpen(false);
    },
    dispose(): void {
      setOpen(false);
      window.removeEventListener('keydown', onKeyDown);
      closeButton?.removeEventListener('click', onClose);
      backdrop?.removeEventListener('click', onClose);
      buyBattery.removeEventListener('click', onBuyBattery);
      buyHarpoons.removeEventListener('click', onBuyHarpoons);
      unsubWallet();
      unsubBattery();
      unsubHarpoons();
    },
  };
}
