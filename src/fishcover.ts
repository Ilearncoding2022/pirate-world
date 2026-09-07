import type { Energy } from './energy';
import { SESSION_COST } from './fishing';

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
 */

export interface FishCoverDeps {
  readonly energy: Energy;
  /**
   * Starts a session. Returns whether one actually began, so a refusal at the
   * far end leaves this screen up rather than closing onto nothing.
   */
  readonly onStart: () => boolean;
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

/** "-50% POWER" — the session's price, off the one constant that sets it. */
function costLabel(): string {
  return `-${Math.round(SESSION_COST * 100)}% POWER`;
}

export function createFishCover(deps: FishCoverDeps): FishCover {
  const root = document.getElementById('fishcover');
  const backdrop = document.getElementById('fishcover-backdrop');
  const closeButton = document.getElementById('fishcover-close');
  const startButton = document.getElementById('fishcover-start');
  const recordButton = document.getElementById('fishcover-record');
  const costEl = document.getElementById('fishcover-cost');

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

  // The price is written from `SESSION_COST` rather than typed into the
  // markup, so a retune of what a session costs moves the label with it
  // instead of leaving the screen advertising the old price.
  if (costEl !== null) costEl.textContent = costLabel();

  let open = false;
  /** Write-through cache on the gate, the same pattern `hud.ts` uses. */
  let lastAffordable: boolean | null = null;

  /**
   * Arms or dims START FISHING against the plant.
   *
   * Re-read every frame the screen is up rather than once when it opens: the
   * world is frozen but the power plant is not, so a player who opens this at
   * a berth on 40% watches the button come alive without touching anything.
   *
   * Both tanks, because `energy.spend` will draw on both — see `energy.ts`.
   */
  function refresh(): void {
    const state = deps.energy.state;
    const affordable = state.level + state.reserve >= SESSION_COST;
    if (affordable === lastAffordable) return;
    lastAffordable = affordable;
    start.disabled = !affordable;
    if (affordable) start.removeAttribute('title');
    else start.setAttribute('title', `Needs ${Math.round(SESSION_COST * 100)}% power`);
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
    lastAffordable = null;
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
    if (deps.onStart()) setOpen(false);
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
