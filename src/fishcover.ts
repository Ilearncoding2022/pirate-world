import type { Energy } from './energy';
import type { GovernorStore } from './governor';
import type { ChumDrumStore } from './chumdrum';
import type { BarbedHeadsStore } from './barbedheads';
import type { Hull } from './hull';
import { HULL_FAILING_BELOW } from './hull';

/**
 * fishcover.ts — the fishing activity's cover screen.
 *
 * [FISH] used to start a session outright. It now opens this: one piece of art
 * and two ways in, START FISHING and FISHING RECORD. The screen exists because
 * the activity had grown two doors and only one key on the HUD — the record
 * had its own button on the dock, which meant the dock was carrying a menu
 * rather than a set of controls, and the two entries had nothing to say they
 * belonged to each other.
 *
 * It knows nothing about either destination. `main.ts` hands it two callbacks;
 * what a session costs and what a record is are somebody else's business.
 *
 * One thing it does own, and it is the reason it takes `energy` at all: the
 * power gate moved here. The dock's [FISH] key is now always live, because it
 * opens a menu and a menu must not be locked by the price of one thing on it —
 * a player with a flat battery is exactly the player who wants to look at
 * their record. START FISHING carries the gate instead, which is where the
 * charge is actually made.
 *
 * A second thing it owns now: arming a Chum Drum or a Barbed Heads bundle for
 * the session about to start. `shop.ts` sells the stock; this screen is the
 * only place either is ever spent, because it is the only screen a player
 * sees between deciding to fish and the session actually charging their tank.
 * Both toggles reset to off every time the screen opens — an armed choice is
 * for the session it was made in front of, never a standing preference that
 * silently spends the locker down on some later visit.
 */

export interface FishCoverDeps {
  readonly energy: Energy;
  /**
   * The hull. Read for `canFish` alone, and only to arm or dim START FISHING.
   *
   * Optional and defaulted to a sound hull, on the Step 0 convention every
   * other hull consumer follows (docs/HARBOURS_PLAN.md): a caller that says
   * nothing gets the screen exactly as it was before durability existed, so
   * `main.ts` wires this at integration and nothing breaks before then.
   */
  readonly hull?: Hull;
  /** The Efficiency Governor. Read for the price on START FISHING's own label. */
  readonly governor: GovernorStore;
  /** The Chum Drum locker. This screen is the only place one is ever armed. */
  readonly chumDrum: ChumDrumStore;
  /** The Barbed Heads locker. This screen is the only place one is ever armed. */
  readonly barbedHeads: BarbedHeadsStore;
  /**
   * Starts a session. Returns whether one actually began, so a refusal at the
   * far end leaves this screen up rather than closing onto nothing.
   *
   * Carries this screen's two toggles — whether a Chum Drum and/or a Barbed
   * Heads bundle should be spent on the session about to start.
   */
  readonly onStart: (useChumDrum: boolean, useBarbedHeads: boolean) => boolean;
  /** Opens the record. This screen deliberately stays up behind it. */
  readonly onRecord: () => void;
  /** Called when the screen opens, so `main.ts` can freeze the world. */
  readonly onOpen: () => void;
}

export interface FishCover {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  /** Keeps START FISHING in step with the plant. Called only while open. */
  update(): void;
  dispose(): void;
}

/**
 * The modifier that swaps the screen's art for the harbour plate.
 *
 * One class, and `style.css` owns everything that follows from it — the same
 * trick the HUD's `.pwr` and `.wnd` rows use. This file decides WHICH scene
 * the player is in and nothing about what it looks like.
 */
const HARBOUR_CLASS = 'fishcover--harbour';

/** "-50% POWER" off whatever the Efficiency Governor's current tier charges. */
function costLabel(sessionCost: number): string {
  return `-${Math.round(sessionCost * 100)}% POWER`;
}

/**
 * Wires one loadout toggle (Chum Drum or Barbed Heads) to its stock.
 *
 * Hidden entirely at zero stock rather than merely disabled: a player who has
 * never bought either consumable should see a screen with no loadout row at
 * all, on the same terms the shop's own dev row stays both hidden and unwired
 * outside `?dev`. Returns a `read()` the caller polls each `refresh()` for
 * the armed flag, and a `reset()` `setOpen` calls on the way in.
 */
function createToggle(
  button: HTMLElement | null,
  stockEl: HTMLElement | null,
): { read(): boolean; reset(): void; sync(count: number): void } {
  let armed = false;
  let lastCount: number | null = null;

  function paint(): void {
    if (button === null) return;
    button.classList.toggle('is-armed', armed);
    button.setAttribute('aria-pressed', String(armed));
  }

  button?.addEventListener('click', () => {
    if (button.hidden) return;
    armed = !armed;
    paint();
  });

  return {
    read(): boolean {
      return armed;
    },
    reset(): void {
      armed = false;
      paint();
    },
    sync(count: number): void {
      if (count === lastCount) return;
      lastCount = count;
      if (button !== null) button.hidden = count <= 0;
      if (stockEl !== null) stockEl.textContent = `×${count}`;
      // A toggle that just ran out of stock cannot stay armed — there is
      // nothing left for `fishing.ts` to spend, and a button the player can
      // no longer see must not silently keep affecting the session.
      if (count <= 0 && armed) {
        armed = false;
        paint();
      }
    },
  };
}

export function createFishCover(deps: FishCoverDeps): FishCover {
  const root = document.getElementById('fishcover');
  const backdrop = document.getElementById('fishcover-backdrop');
  const closeButton = document.getElementById('fishcover-close');
  const startButton = document.getElementById('fishcover-start');
  const recordButton = document.getElementById('fishcover-record');
  const costEl = document.getElementById('fishcover-cost');
  const chumButton = document.getElementById('fishcover-chum');
  const chumStockEl = document.getElementById('fishcover-chum-stock');
  const barbedButton = document.getElementById('fishcover-barbed');
  const barbedStockEl = document.getElementById('fishcover-barbed-stock');

  if (
    root === null ||
    !(startButton instanceof HTMLButtonElement) ||
    !(recordButton instanceof HTMLButtonElement)
  ) {
    // The same contract every other overlay keeps: a screen that is not in the
    // document must not take the frame loop down with it, and must not be able
    // to spend anything either.
    return {
      isOpen: false,
      open: (): void => undefined,
      close: (): void => undefined,
      update: (): void => undefined,
      dispose: (): void => undefined,
    };
  }

  const overlay: HTMLElement = root;
  const start: HTMLButtonElement = startButton;
  const record: HTMLButtonElement = recordButton;

  const chum = createToggle(chumButton, chumStockEl);
  const barbed = createToggle(barbedButton, barbedStockEl);

  let open = false;
  /**
   * Why START FISHING is currently dim, or null when it is armed. The
   * write-through cache on the gate, the same pattern `hud.ts` uses, kept on
   * the REASON rather than on the boolean -- see `refresh`.
   */
  let lastReason: string | null | undefined = undefined;
  /** Write-through cache on the price label, since the Governor's tier can move. */
  let lastCostLabel: string | null = null;

  /**
   * Arms or dims START FISHING against the plant, and keeps the price and the
   * two loadout toggles in step with the stores behind them.
   *
   * Re-read every frame the screen is up rather than once when it opens: the
   * world is frozen but the power plant is not, so a player who opens this at
   * a berth on 40% watches the button come alive without touching anything —
   * and a berth is also the only place the Governor or either locker can
   * change, so this is where a purchase made moments ago has to show up.
   *
   * Both tanks, because `energy.spend` will draw on both — see `energy.ts`.
   */
  function refresh(): void {
    const sessionCost = deps.governor.sessionCost;
    const label = costLabel(sessionCost);
    if (label !== lastCostLabel) {
      lastCostLabel = label;
      if (costEl !== null) costEl.textContent = label;
    }

    const state = deps.energy.state;
    const affordable = state.level + state.reserve >= sessionCost;
    /*
     * The hull gate, and it is a second gate rather than a term in the first.
     *
     * Below 25% the ship cannot fish at all (docs/HARBOURS_PLAN.md, decision
     * 15): there is no price that buys past it, which is exactly what makes
     * it different from the power gate above and why it cannot be folded into
     * `affordable`.
     *
     * Read every frame with everything else in `refresh`, and that matters
     * here more than it does for the power: this screen freezes the world, so
     * the hull cannot move while it is up — but a player who opened it at a
     * berth is being repaired, and watching START FISHING come alive as the
     * hull crosses 25 is the clearest possible statement of the rule.
     */
    const canFish = deps.hull?.state.canFish ?? true;
    // Named in precedence order, and the hull wins when both are true. Power
    // comes back on its own — the sun, a berth, a bought cell — so "needs 50%
    // power" is a wait; a hull under 25% is a repair, and telling a player to
    // wait for something that will never happen is the worse of the two
    // failures. `fishing.ts`'s FISH AGAIN reads the same three lines.
    const reason = !canFish
      ? `Hull under ${HULL_FAILING_BELOW}%`
      : !affordable
        ? `Needs ${Math.round(sessionCost * 100)}% power`
        : null;
    const armed = reason === null;
    // Diffed on the REASON and not on `armed`, because the two gates can hand
    // over to each other without the button ever coming alive in between: a
    // ship that is dim for power and then falls under 25% would otherwise
    // keep a tooltip naming a gate it has already cleared.
    if (reason !== lastReason) {
      lastReason = reason;
      start.disabled = !armed;
      if (reason === null) start.removeAttribute('title');
      else start.setAttribute('title', reason);
    }

    chum.sync(deps.chumDrum.count);
    barbed.sync(deps.barbedHeads.count);
  }

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    overlay.hidden = !next;
    overlay.setAttribute('aria-hidden', next ? 'false' : 'true');
    if (!next) return;
    /*
     * Which picture the screen wears, decided once on the way in.
     *
     * Fishing alongside a berth is a different scene from fishing at sea, and
     * the screen says so: the harbour plate goes up when the ship is moored
     * and the open-water one otherwise. `energy.mode` is the project's single
     * definition of docked — the same one the [SHOP] key and `wind.ts`'s
     * shelter read — so this can never develop a second opinion about where
     * the ship is.
     *
     * Read on OPEN and not in `refresh`, deliberately. `refresh` runs every
     * frame the screen is up, and a berth can be lost while it is: the ship is
     * halted, but a hazard's push or a gust can still carry it out of the
     * ring, and a background that changed under the player mid-read would be
     * the screen redecorating itself for no reason they can see.
     */
    overlay.classList.toggle(HARBOUR_CLASS, deps.energy.state.mode === 'docked');
    // `undefined` rather than `null`, because `null` is now a real reading on
    // this cache -- it is what "armed, no tooltip" looks like -- and only the
    // third state can mean "never painted".
    lastReason = undefined;
    lastCostLabel = null;
    // Both toggles reset to off on every open — see the file comment on why
    // an armed choice never survives to a later visit.
    chum.reset();
    barbed.reset();
    refresh();
    // The button the player came for, unless they cannot afford it.
    (start.disabled ? record : start).focus();
  }

  function onStart(): void {
    // The screen closes only on a session that actually began. `fishing.open()`
    // re-tests the plant on its own account and can still refuse — the
    // disabled attribute above is an affordance, never the lock — and closing
    // first would drop the player back into the world with nothing to show for
    // the click.
    if (deps.onStart(chum.read(), barbed.read())) setOpen(false);
    else refresh();
  }

  function onRecord(): void {
    // Deliberately NOT closed. The record is a page of this activity rather
    // than a destination of its own, so it opens on top and closing it comes
    // back to here. Its overlay outranks this one in the stacking order, which
    // is what makes that work with no coordination between the two.
    deps.onRecord();
  }

  function onClose(): void {
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Guarded on `open` rather than added and removed with the screen: one
    // listener for the life of the run cannot leak and cannot be missing for
    // the frame between the click and the paint.
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    setOpen(false);
  }

  window.addEventListener('keydown', onKeyDown);
  closeButton?.addEventListener('click', onClose);
  backdrop?.addEventListener('click', onClose);
  start.addEventListener('click', onStart);
  record.addEventListener('click', onRecord);

  return {
    get isOpen(): boolean {
      return open;
    },
    open(): void {
      if (open) return;
      setOpen(true);
      deps.onOpen();
    },
    close: onClose,
    update: refresh,
    dispose(): void {
      setOpen(false);
      window.removeEventListener('keydown', onKeyDown);
      closeButton?.removeEventListener('click', onClose);
      backdrop?.removeEventListener('click', onClose);
      start.removeEventListener('click', onStart);
      record.removeEventListener('click', onRecord);
    },
  };
}
