import type { Battery } from './battery';
import type { HarpoonStore } from './harpoons';
import type { Wallet } from './wallet';
import type { SeaAnchorStore } from './seaanchor';
import type { OverdriveStore } from './overdrive';
import type { ChumDrumStore } from './chumdrum';
import type { BarbedHeadsStore } from './barbedheads';
import type { TrimStore } from './trim';
import type { MoonglassStore } from './moonglass';
import type { ArcLampStore } from './arclamp';
import type { GovernorStore } from './governor';
import { BATTERY_CAPACITY, BATTERY_CELL, BATTERY_CELLS_MAX } from './battery';
import { HARPOON_BUNDLE, HARPOON_PER_SESSION_MAX, HARPOON_STORE_MAX } from './harpoons';
import { SEA_ANCHOR_STORE_MAX } from './seaanchor';
import { OVERDRIVE_STORE_MAX, OVERDRIVE_SECONDS, OVERDRIVE_MAX_FORWARD } from './overdrive';
import { CHUM_DRUM_STORE_MAX } from './chumdrum';
import { BARBED_HEADS_STORE_MAX, BARBED_HEADS_DRAIN_SCALE } from './barbedheads';
import { TRIM_MAX_FORWARD } from './trim';
import { MOONGLASS_NIGHT_FRACTION } from './moonglass';
import { ARC_LAMP_SESSION_SECONDS } from './arclamp';
import { GOVERNOR_SESSION_COST } from './governor';

/**
 * shop.ts — the chandlery, open only alongside a berth.
 *
 * Ten offers across two tabs, and behind `?dev` a control that is not an
 * offer at all. It owns its own DOM and its own Escape, the same shape
 * `fishbook.ts` has, and it knows nothing about who is allowed to open it:
 * `main.ts` gates that on the berth, and `hud.ts` dims the key when there is
 * no berth to gate on.
 *
 * Every purchase is two all-or-nothing moves in a fixed order — take the gold,
 * then hand over the goods — and the second one is tested BEFORE the first
 * runs. See `buy` below: it is the one place in the project where gold can go
 * out, and the one arrangement in which it cannot go out for nothing. Every
 * one of the ten offers below goes through it, tiers and stock alike.
 *
 * `docs/SHOP_PLAN.md` is the design record eight of these ten items were
 * built from — read it before retuning a price or an effect, since the
 * reasoning for each number lives there and not here. This file only prices
 * what the item files already compute; a Battle tab is deliberately not
 * among the two below, for the reasons the plan's own "Three things to
 * settle" lays out.
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

/**
 * Gold for one Sea Anchor.
 *
 * The cheapest thing in the chandlery, and deliberately so: `seaanchor.ts`
 * only pays off for a player who has understood how a red boat's pure
 * pursuit steers, so it is priced to be tried rather than saved up for.
 */
export const SEA_ANCHOR_PRICE = 400;

/** Gold for one Overdrive Coil. Twice the anchor's price for the item that argues with the turn rate's own tuning. */
export const OVERDRIVE_PRICE = 800;

/** Gold for one Chum Drum, spent on the fishing cover screen. */
export const CHUM_DRUM_PRICE = 600;

/** Gold for one Barbed Heads bundle, spent on the fishing cover screen. */
export const BARBED_HEADS_PRICE = 700;

/**
 * Gold for each tier of Trim & Sheathing, indexed by the CURRENT tier — so
 * `TRIM_PRICES[0]` is Mk I's price, paid to move off tier 0.
 *
 * Doubling per tier, the same shape `moonglass.ts`'s, `arclamp.ts`'s and
 * `governor.ts`'s own price ladders use: a durable that got no more
 * expensive per knot of top speed would make the top tier the only one worth
 * saving for.
 */
export const TRIM_PRICES: readonly number[] = [2000, 4000, 8000];

/** Gold for each tier of the Moonglass Array, indexed the same way as `TRIM_PRICES`. */
export const MOONGLASS_PRICES: readonly number[] = [3000, 6000, 12000];

/** Gold for each tier of the Arc-Lamp Rig, indexed the same way as `TRIM_PRICES`. */
export const ARC_LAMP_PRICES: readonly number[] = [2000, 4000, 8000];

/**
 * Gold for each tier of the Efficiency Governor, indexed the same way as
 * `TRIM_PRICES`. Priced above the other three durables at every tier: see
 * `governor.ts`'s own comment on why the compounding item is the one worth
 * keeping expensive.
 */
export const GOVERNOR_PRICES: readonly number[] = [2500, 5000, 9000];

/**
 * Gold the dev button mints per click.
 *
 * Ten thousand: ten backup cells, or twenty bundles of harpoons, so one click
 * is enough to test any offer in the panel and a second click is enough to
 * test what the panel does when nothing is short of gold. A figure small
 * enough to need repeated clicking would just be a slower version of the same
 * thing.
 */
export const DEV_GOLD_GRANT = 10_000;

/**
 * Whether this session may mint gold, read from the URL and nothing else.
 *
 * `?dev` (with or without a value) and never `import.meta.env.MODE`, on
 * exactly the terms `?quality=` and `?hazard=` are read on: `vite preview`
 * serves a genuine production build and these harnesses are meant to be used
 * against one, so a MODE test would switch the button off in the very build
 * it is wanted in. An ordinary player sets no query, so for them this is
 * always false and the row below stays hidden and unwired.
 *
 * Exported for `shop.test.ts` and for the same reason `createQuality` takes
 * its `search`: a gate that can only be exercised by editing the address bar
 * is a gate nothing can test.
 */
export function isDevMode(search: string): boolean {
  return new URLSearchParams(search).has('dev');
}

export interface ShopPanel {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

/**
 * U+2009 THIN SPACE, as everywhere else a gold figure is printed.
 *
 * Written as an ESCAPE and not as the character itself, which is the whole
 * fix: it was the character, and somewhere along the way it was flattened to
 * an ordinary space (0x20). The two are indistinguishable in a diff and very
 * nearly so on screen, so the purse in here quietly stopped matching the one
 * on the HUD and stayed that way. `hud.ts` has always written the escape and
 * has always been right; this file and `battleui.ts` were the two literals,
 * and both of them had been flattened. Do not put the character back.
 */
const THIN_SPACE = '\u2009';

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
 * short of gold, cell already full, locker full, tier already maxed — and
 * the caller picks.
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
  readonly seaAnchor: SeaAnchorStore;
  readonly overdrive: OverdriveStore;
  readonly chumDrum: ChumDrumStore;
  readonly barbedHeads: BarbedHeadsStore;
  readonly trim: TrimStore;
  readonly moonglass: MoonglassStore;
  readonly arcLamp: ArcLampStore;
  readonly governor: GovernorStore;
}

/** A store shaped like a plain stock counter — every consumable in the panel. */
interface StockLike {
  readonly count: number;
  readonly canBuy: boolean;
  buy(): boolean;
}

/** A store shaped like a tier counter — every durable in the panel. */
interface TierLike {
  readonly tier: number;
  readonly canBuy: boolean;
  buy(): boolean;
}

/**
 * The chandlery panel.
 *
 * Returns a controller that does nothing at all when its markup is absent, on
 * the same terms `fishing.ts` and `radar.ts` do: a missing display must not
 * take the frame loop down, and — the part that matters where money is
 * involved — it must not be able to spend anything either.
 */
export function createShop(deps: ShopDeps, search: string = window.location.search): ShopPanel {
  const root = document.getElementById('shop');
  const backdrop = document.getElementById('shop-backdrop');
  const closeButton = document.getElementById('shop-close');
  const purse = document.getElementById('shop-purse');
  const batteryStock = document.getElementById('shop-battery-stock');
  const harpoonStock = document.getElementById('shop-harpoon-stock');
  const batteryBuy = document.getElementById('shop-battery-buy');
  const harpoonBuy = document.getElementById('shop-harpoon-buy');
  const devRow = document.getElementById('shop-dev');
  const devGold = document.getElementById('shop-dev-gold');
  const tabNavigation = document.getElementById('shop-tab-navigation');
  const tabFishing = document.getElementById('shop-tab-fishing');
  const panelNavigation = document.getElementById('shop-panel-navigation');
  const panelFishing = document.getElementById('shop-panel-fishing');

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

  /**
   * One purchase: test the goods, take the gold, hand the goods over.
   *
   * `canTake` is asked BEFORE the wallet is touched, and `take` is only ever
   * called on gold that has already been debited. The order matters because
   * both halves can refuse — a full cell refuses a charge, a full locker
   * refuses a bundle, a maxed durable refuses a tier — and the arrangement
   * where the wallet goes first would have a refusal on the second half mean
   * gold spent on nothing.
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

  const refreshers: Array<() => void> = [];
  const disposers: Array<() => void> = [];

  /**
   * Wires one consumable offer — a fixed price and a stock cap. Covers Sea
   * Anchor, Overdrive Coil, Chum Drum and Barbed Heads; the backup cell and
   * the harpoon locker keep their own hand-written wiring below because each
   * carries a second ceiling (`BATTERY_CELLS_MAX` charge fullness,
   * `HARPOON_PER_SESSION_MAX`) this generic shape does not know about.
   *
   * Returns nothing: the offer's `refresh` and its listener's teardown are
   * folded into the shared `refreshers`/`disposers` arrays above, the same
   * way every hand-written offer below folds itself in.
   */
  function wireConsumable(prefix: string, price: number, max: number, store: StockLike): void {
    const buyEl = document.getElementById(`shop-${prefix}-buy`);
    if (!(buyEl instanceof HTMLButtonElement)) return;
    textWriter(document.getElementById(`shop-${prefix}-price`))(`${formatGold(price)} G`);
    const writeStock = textWriter(document.getElementById(`shop-${prefix}-stock`));
    const writeOffer = offerWriter(buyEl);

    function refresh(): void {
      writeStock(`${store.count} / ${max}`);
      if (!store.canBuy) writeOffer(false, `The locker holds ${max}`);
      else writeOffer(deps.wallet.gold >= price, `Needs ${price} gold`);
    }

    function onBuy(): void {
      buy(price, () => store.canBuy, () => store.buy());
    }

    buyEl.addEventListener('click', onBuy);
    refreshers.push(refresh);
    disposers.push(() => buyEl.removeEventListener('click', onBuy));
  }

  /**
   * Wires one durable offer — a tier ladder with one price per step, indexed
   * by the tier the ship is CURRENTLY on. Covers Trim & Sheathing, Moonglass
   * Array, Arc-Lamp Rig and the Efficiency Governor: four different effects
   * behind one identical shape, per `docs/SHOP_PLAN.md`'s organising rule
   * that a durable is a ceiling raised in steps rather than a number typed in
   * once.
   *
   * `detail` is written once, describing the whole ladder (`trim.ts`'s
   * `TRIM_MAX_FORWARD` printed out in full) rather than only the current
   * tier's figure — a player two tiers from the top should be able to read
   * where the ladder ends without buying their way there first.
   */
  function wireDurable(prefix: string, prices: readonly number[], detail: string, store: TierLike): void {
    const buyEl = document.getElementById(`shop-${prefix}-buy`);
    if (!(buyEl instanceof HTMLButtonElement)) return;
    textWriter(document.getElementById(`shop-${prefix}-detail`))(detail);
    const writeTier = textWriter(document.getElementById(`shop-${prefix}-tier`));
    const writePrice = textWriter(document.getElementById(`shop-${prefix}-price`));
    const writeOffer = offerWriter(buyEl);
    const maxTier = prices.length;

    function refresh(): void {
      writeTier(`Mk ${store.tier} / ${maxTier}`);
      if (!store.canBuy) {
        writePrice('MAXED');
        writeOffer(false, 'Already at the top tier');
      } else {
        const price = prices[store.tier];
        writePrice(`${formatGold(price)} G`);
        writeOffer(deps.wallet.gold >= price, `Needs ${price} gold`);
      }
    }

    function onBuy(): void {
      buy(prices[store.tier] ?? 0, () => store.canBuy, () => store.buy());
    }

    buyEl.addEventListener('click', onBuy);
    refreshers.push(refresh);
    disposers.push(() => buyEl.removeEventListener('click', onBuy));
  }

  // The three figures the backup cell and the harpoon bundle are actually
  // written in -- half a tank, five harpoons, and the two prices -- are
  // stamped into the markup here rather than typed into index.html, so a
  // retune of any of them moves the words on the buttons with it instead of
  // leaving the panel advertising the old deal.
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

  function refreshBatteryAndHarpoons(): void {
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
  refreshers.push(refreshBatteryAndHarpoons);

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

  buyBattery.addEventListener('click', onBuyBattery);
  buyHarpoons.addEventListener('click', onBuyHarpoons);

  // ---- Navigation: Sea Anchor, Overdrive Coil, Trim & Sheathing, Moonglass Array
  wireConsumable('anchor', SEA_ANCHOR_PRICE, SEA_ANCHOR_STORE_MAX, deps.seaAnchor);
  wireConsumable('overdrive', OVERDRIVE_PRICE, OVERDRIVE_STORE_MAX, deps.overdrive);
  wireDurable(
    'trim',
    TRIM_PRICES,
    `Top speed ${TRIM_MAX_FORWARD.join(' → ')} kn`,
    deps.trim,
  );
  wireDurable(
    'moonglass',
    MOONGLASS_PRICES,
    `Night solar up to ${MOONGLASS_NIGHT_FRACTION.map((f) => `${Math.round(f * 100)}%`).join(' / ')} of noon`,
    deps.moonglass,
  );

  // ---- Fishing: Chum Drum, Barbed Heads, Arc-Lamp Rig, Efficiency Governor
  wireConsumable('chum', CHUM_DRUM_PRICE, CHUM_DRUM_STORE_MAX, deps.chumDrum);
  wireConsumable('barbed', BARBED_HEADS_PRICE, BARBED_HEADS_STORE_MAX, deps.barbedHeads);
  wireDurable(
    'arclamp',
    ARC_LAMP_PRICES,
    `Session length ${ARC_LAMP_SESSION_SECONDS.join(' → ')} s`,
    deps.arcLamp,
  );
  wireDurable(
    'governor',
    GOVERNOR_PRICES,
    `Session cost ${GOVERNOR_SESSION_COST.map((c) => `${Math.round(c * 100)}%`).join(' → ')}`,
    deps.governor,
  );

  // Two static details worth stating here, once, rather than repeating in
  // every one of the eight offers above: the Overdrive Coil's own burn
  // window and top speed, and Barbed Heads' drain scale — both numbers a
  // player would otherwise have to already know `overdrive.ts`/
  // `barbedheads.ts` to make sense of.
  textWriter(document.getElementById('shop-overdrive-detail'))(
    `${OVERDRIVE_SECONDS} s at ${OVERDRIVE_MAX_FORWARD} kn`,
  );
  textWriter(document.getElementById('shop-anchor-detail'))(
    `Kills way, then holds it briefly · stows ${SEA_ANCHOR_STORE_MAX}`,
  );
  textWriter(document.getElementById('shop-chum-detail'))(`One session · stows ${CHUM_DRUM_STORE_MAX}`);
  textWriter(document.getElementById('shop-barbed-detail'))(
    `One session at ${Math.round(BARBED_HEADS_DRAIN_SCALE * 100)}% tension drain · stows ${BARBED_HEADS_STORE_MAX}`,
  );

  /*
   * The dev row: unhidden, labelled and wired ONLY behind `?dev`.
   *
   * All three happen together and nowhere else, so there is no arrangement in
   * which a player's session has a live listener on a button it cannot see.
   * Outside dev mode the markup stays exactly as index.html ships it —
   * hidden, and with no text in it — and `onDevGold` is never subscribed.
   */
  const devMode = isDevMode(search);
  const buyDevGold = devMode && devGold instanceof HTMLButtonElement ? devGold : null;
  if (devMode && devRow !== null) {
    devRow.hidden = false;
    textWriter(buyDevGold)(`+${formatGold(DEV_GOLD_GRANT)} G`);
  }

  /**
   * Redraws every offer off the ten stores.
   *
   * Subscribed to all ten rather than called after a purchase, because the
   * purse also moves while this panel is shut — a session banked between two
   * visits — and a shop that only refreshed on its own clicks would open
   * showing the balance the player had last time.
   */
  function refresh(): void {
    writePurse(formatGold(deps.wallet.gold));
    for (const r of refreshers) r();
  }

  function onDevGold(): void {
    deps.wallet.add(DEV_GOLD_GRANT);
  }

  const unsubWallet = deps.wallet.onChange(refresh);
  const unsubBattery = deps.battery.onChange(refresh);
  const unsubHarpoons = deps.harpoons.onChange(refresh);
  const unsubSeaAnchor = deps.seaAnchor.onChange(refresh);
  const unsubOverdrive = deps.overdrive.onChange(refresh);
  const unsubChumDrum = deps.chumDrum.onChange(refresh);
  const unsubBarbedHeads = deps.barbedHeads.onChange(refresh);
  const unsubTrim = deps.trim.onChange(refresh);
  const unsubMoonglass = deps.moonglass.onChange(refresh);
  const unsubArcLamp = deps.arcLamp.onChange(refresh);
  const unsubGovernor = deps.governor.onChange(refresh);
  refresh();

  /* ---------------------------------------------------------------- */
  /* Tabs                                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Switches which of the two `.shop__panel-group`s is shown.
   *
   * Not reset on every open: a player who came back to buy a second Trim
   * tier should not have to reselect Navigation every time they pass a
   * berth. The choice lives only for the life of this panel's controller —
   * it is not part of the save file, on the same terms `menu.ts`'s pane
   * is not either.
   */
  let activeTab: 'navigation' | 'fishing' = 'navigation';

  function paintTabs(): void {
    const onNav = activeTab === 'navigation';
    tabNavigation?.setAttribute('aria-selected', String(onNav));
    tabFishing?.setAttribute('aria-selected', String(!onNav));
    tabNavigation?.classList.toggle('is-active', onNav);
    tabFishing?.classList.toggle('is-active', !onNav);
    if (panelNavigation !== null) panelNavigation.hidden = !onNav;
    if (panelFishing !== null) panelFishing.hidden = onNav;
  }
  paintTabs();

  function onTabNavigation(): void {
    activeTab = 'navigation';
    paintTabs();
  }
  function onTabFishing(): void {
    activeTab = 'fishing';
    paintTabs();
  }

  tabNavigation?.addEventListener('click', onTabNavigation);
  tabFishing?.addEventListener('click', onTabFishing);

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
  buyDevGold?.addEventListener('click', onDevGold);

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
      buyDevGold?.removeEventListener('click', onDevGold);
      tabNavigation?.removeEventListener('click', onTabNavigation);
      tabFishing?.removeEventListener('click', onTabFishing);
      for (const d of disposers) d();
      unsubWallet();
      unsubBattery();
      unsubHarpoons();
      unsubSeaAnchor();
      unsubOverdrive();
      unsubChumDrum();
      unsubBarbedHeads();
      unsubTrim();
      unsubMoonglass();
      unsubArcLamp();
      unsubGovernor();
    },
  };
}
