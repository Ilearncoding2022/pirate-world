/**
 * menu.ts — the Escape menu, and the controls guide that now lives inside it.
 *
 * The controls used to be a `<details>` card pinned to the HUD. It was always
 * on screen, which is the wrong trade for something a player reads once: it
 * cost a corner permanently, it had to be shrunk to half size to afford that
 * corner, and it was hidden outright below 560px of viewport height — so on
 * exactly the small screens where the on-screen keys matter most, the guide
 * explaining them was not there at all. Now it is behind a key, at a size that
 * can be read, and the corner went to the helm.
 *
 * Three panes and one screen. The root offers what the menu can do; CONTROLS
 * swaps to the key list, HARBOURS to the roll of the world's 36, and BACK
 * returns from either. They are panes rather than overlays because there is no
 * state to carry between them and nothing else in the project stacks a card on
 * a card — the fish book sits ON the fishing cover, but only because the
 * record is a page of that activity rather than a destination of its own.
 *
 * HARBOURS is here rather than on the HUD because it answers a different
 * question from the scope. The scope answers "what is near me", live, at 50
 * units; this answers "where is the place I remember", at any range, and the
 * world is redrawn on every load — so a harbour the player moored at last
 * session is somewhere else entirely and the fix has to be recomputed against
 * whatever sea is currently up. That is what the `harbours` callback is: this
 * file never sees a `Towns` or a `ShipState`, and cannot, because a menu page
 * that knew how to find a harbour would be a second copy of the projection the
 * scope already owns.
 *
 * It owns the ESCAPE KEY OUTRIGHT — opening as well as closing. That is one
 * listener rather than two, and it is deliberate: with `main.ts` opening on
 * Escape and this file closing on it, a single press would reach both handlers
 * and the menu would open and shut on the same event, with the order of two
 * `window` listeners deciding whether the player saw anything. Whether opening
 * is ALLOWED is still `main.ts`'s to answer, through `canOpen` — this file has
 * no idea what a fight or a maelstrom is.
 */

/**
 * One row of the HARBOURS page, as the caller hands it over.
 *
 * A flat record of four primitives on purpose. Everything needed to draw a row
 * is already resolved by the time it arrives, so this file holds no geometry
 * and no world objects, and the page cannot quietly grow a second projection
 * beside `radar.ts`'s.
 */
export interface HarbourEntry {
  /** Display name, from `HARBOUR_NAMES`. Shown whether or not the place is known. */
  readonly name: string;
  /**
   * Has the ship moored here, in this world or any earlier one?
   *
   * The only thing that decides whether a row carries a fix or reads
   * UNCHARTED. An unknown harbour's `bearing` and `distance` are never read,
   * so a caller may pass zeroes for them.
   */
  readonly known: boolean;
  /**
   * True bearing to the harbour, RADIANS, 0 = north and clockwise positive —
   * the same convention `ShipState.heading` and `WindState.bearing` keep, so
   * the caller hands over a reading rather than a conversion.
   */
  readonly bearing: number;
  /** Great-circle distance from the ship, world units. */
  readonly distance: number;
}

export interface MenuDeps {
  /**
   * May the menu open right now? Asked on every Escape the menu is closed for.
   *
   * `main.ts` answers it, because the answer is "nothing else owns the screen"
   * and this file cannot see the overlays, the fight or the hazard phase. It
   * is a callback rather than a flag for the pause contract's reason: a value
   * read once at construction would be a lie by the second frame.
   */
  readonly canOpen: () => boolean;
  /** Called when the menu opens, so `main.ts` can halt the ship. */
  readonly onOpen: () => void;
  /**
   * The 36 harbours, as of the instant the page is opened.
   *
   * A callback rather than an array for the pause contract's reason and one
   * more: the fixes are only true where the ship is standing, so a list read
   * once at construction would be a lie the first time the player sailed
   * anywhere. It is called when the HARBOURS pane is SHOWN — not on every
   * Escape — so 36 great-circle solutions are paid for only by a player who
   * asked to see them.
   *
   * Optional, and an absent one leaves the page empty rather than broken: the
   * menu is built before the world in some orderings, and a controls guide
   * that refused to open because nothing had told it about harbours yet would
   * be the wrong failure entirely.
   */
  readonly harbours?: () => readonly HarbourEntry[];
}

/* ------------------------------------------------------------------ */
/* The fix                                                             */
/* ------------------------------------------------------------------ */

const RAD_TO_DEG = 180 / Math.PI;

/**
 * "N 042°" — a true bearing, as the HARBOURS page prints it.
 *
 * `N` is the reference and not a rose point: this is a bearing measured from
 * north, clockwise, exactly as the HDG readout above the scope is, and the
 * letter is there so a player reading a column of them knows what the number
 * is measured from without a header. Naming the nearest of eight compass
 * points instead was considered and dropped — it would put NE beside 042 and
 * SW beside 214, which is a second, coarser answer to a question the number
 * has already answered exactly.
 *
 * Three digits, zero-padded, sharing `formatHeading`'s shape in `hud.ts` on
 * purpose: the bearing the player reads here is the heading they are about to
 * steer, and the two figures should be the same figure. Wrapped into [0, 360)
 * after rounding, so a bearing a hair under a full turn reads `N 000°` rather
 * than the impossible `N 360°`.
 *
 * Exported for `tests/unit/hull-hud.test.ts`.
 */
export function formatBearing(bearingRad: number): string {
  const deg = ((Math.round(bearingRad * RAD_TO_DEG) % 360) + 360) % 360;
  return `N ${String(deg).padStart(3, '0')}°`;
}

/**
 * "34 u" — a great-circle distance in world units.
 *
 * Units and not knots. Everything else the HUD prints off a world-unit figure
 * is a SPEED, and `hud.ts` prints those as knots one for one; this is a
 * length, and calling a length knots would be wrong in the one place a player
 * might actually do arithmetic with it — a harbour 34 units off at 12 knots is
 * three minutes away, and that sum only works if the two carry different
 * names.
 *
 * Whole units, rounded, floored at zero. The scope's rings are 12.5 units
 * apart, so a tenth here would be a digit finer than anything the player can
 * see and would flicker on a moored ship riding the swell.
 *
 * Exported for `tests/unit/hull-hud.test.ts`.
 */
export function formatDistance(units: number): string {
  const whole = Math.max(0, Math.round(units));
  return `${whole} u`;
}

/** What an unvisited harbour reads instead of a fix. */
const UNCHARTED = 'UNCHARTED';

export interface Menu {
  /**
   * True from `open()` until `close()`. Read by `main.ts` every frame to
   * decide whether the world is frozen, so it is a live getter on the pause
   * contract's terms, never a latched flag.
   */
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

/**
 * The two pane modifiers, and the absence of both is the root.
 *
 * `style.css` owns everything that follows from them. Two classes rather than
 * one `menu--pane-*` because the root's rule was written as "not controls"
 * before there was a third pane, and a stylesheet section that may not touch
 * an existing rule can add a class more safely than it can rename one.
 */
const CONTROLS_CLASS = 'menu--controls';
const HARBOURS_CLASS = 'menu--harbours';

/** Which pane is up. The root is the one with no modifier on the overlay. */
type Pane = 'root' | 'controls' | 'harbours';

export function createMenu(deps: MenuDeps): Menu {
  const root = document.getElementById('menu');
  const backdrop = document.getElementById('menu-backdrop');
  const closeButton = document.getElementById('menu-close');
  const controlsButton = document.getElementById('menu-controls');
  const backButton = document.getElementById('menu-back');
  const harboursButton = document.getElementById('menu-harbours');
  const harboursBack = document.getElementById('menu-harbours-back');
  const harboursList = document.getElementById('menu-harbours-list');

  if (root === null || !(controlsButton instanceof HTMLButtonElement)) {
    /*
     * The contract every overlay in this project keeps: a screen that is not
     * in the document must not take the frame loop down with it. Harmless
     * here in a way it is not in `battlecover.ts` — nothing is waiting on this
     * one to hand the game back — so it is a plain no-op with no fallback
     * behaviour to get right.
     */
    return {
      isOpen: false,
      open: (): void => undefined,
      close: (): void => undefined,
      dispose: (): void => undefined,
    };
  }

  const overlay: HTMLElement = root;
  const controls: HTMLButtonElement = controlsButton;

  let open = false;
  /**
   * The pane the player was last on, so the root can put focus somewhere that
   * is not the button they just came out of. Starts on the root, which is
   * where a freshly opened menu also lands.
   */
  let lastPane: Pane = 'root';

  /**
   * Fills the harbour list from the callback.
   *
   * Rebuilt outright rather than patched. Thirty-six rows is one `innerHTML`
   * worth of work on a screen that is already frozen, and every field on every
   * row is stale the moment the ship moves — there is no such thing as a row
   * worth keeping between two openings of this page.
   *
   * The name goes in through `textContent`, never markup: `HARBOUR_NAMES` is a
   * constant in this repository today, but a list of place names rendered into
   * a page is exactly the kind of thing that later comes from somewhere else.
   */
  function fillHarbours(): void {
    if (harboursList === null) return;
    harboursList.textContent = '';
    const entries = deps.harbours?.() ?? [];
    for (const entry of entries) {
      const row = document.createElement('li');
      row.className = 'harbours__row';

      const name = document.createElement('span');
      name.className = 'harbours__name';
      name.textContent = entry.name;
      row.appendChild(name);

      const fix = document.createElement('span');
      // The fix and the dash are one element with two states, on the power
      // tag's rule: a row that is missing its fix must not be a row with an
      // empty box where the fix goes.
      if (entry.known) {
        fix.className = 'harbours__fix';
        fix.textContent = `${formatBearing(entry.bearing)}  ${formatDistance(entry.distance)}`;
      } else {
        fix.className = 'harbours__fix harbours__fix--unknown';
        fix.textContent = UNCHARTED;
      }
      row.appendChild(fix);

      harboursList.appendChild(row);
    }
  }

  /**
   * Shows one of the three panes.
   *
   * The pane is reset to root on the way IN rather than on the way out, so a
   * player who left the menu reading the controls does not come back to a
   * screen still showing them: the menu is a place you arrive at, and it
   * should look the same every time you arrive.
   *
   * Focus goes to the button the player would want next, and it is never the
   * one they just pressed. Going into a pane that is BACK. Coming out to the
   * root it is the destination they have NOT just been to, which with two
   * destinations is a real choice rather than a coin toss: a player who has
   * just read the controls is not about to read them again.
   */
  function setPane(pane: Pane): void {
    overlay.classList.toggle(CONTROLS_CLASS, pane === 'controls');
    overlay.classList.toggle(HARBOURS_CLASS, pane === 'harbours');

    if (pane === 'harbours') fillHarbours();

    if (pane === 'controls') {
      if (backButton instanceof HTMLButtonElement) backButton.focus();
    } else if (pane === 'harbours') {
      if (harboursBack instanceof HTMLButtonElement) harboursBack.focus();
    } else if (lastPane === 'controls' && harboursButton instanceof HTMLButtonElement) {
      harboursButton.focus();
    } else {
      controls.focus();
    }

    lastPane = pane;
  }

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    overlay.hidden = !next;
    overlay.setAttribute('aria-hidden', next ? 'false' : 'true');
    if (next) {
      // A fresh arrival, not a return: the root's focus rule is about where
      // the player has just been INSIDE this visit, and between visits there
      // is no such place.
      lastPane = 'root';
      setPane('root');
    }
  }

  function onClose(): void {
    setOpen(false);
  }

  function onControls(): void {
    setPane('controls');
  }

  function onHarbours(): void {
    setPane('harbours');
  }

  function onBack(): void {
    setPane('root');
  }

  /**
   * The whole of Escape: open when closed and allowed, close when open.
   *
   * Guarded on `open` rather than added and removed with the screen, like
   * every other overlay's key here: one listener for the life of the run
   * cannot leak and cannot be missing for the frame between the press and the
   * paint.
   *
   * BACK is deliberately not on this key. Escape from the controls pane closes
   * the menu outright rather than stepping back one, because the pane is not a
   * place the player navigated INTO so much as the thing they opened the menu
   * for, and a key that took two presses to leave a two-item menu would be
   * ceremony.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (!deps.canOpen()) return;
    event.preventDefault();
    setOpen(true);
    deps.onOpen();
  }

  window.addEventListener('keydown', onKeyDown);
  closeButton?.addEventListener('click', onClose);
  backdrop?.addEventListener('click', onClose);
  controls.addEventListener('click', onControls);
  backButton?.addEventListener('click', onBack);
  harboursButton?.addEventListener('click', onHarbours);
  harboursBack?.addEventListener('click', onBack);

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
    dispose(): void {
      setOpen(false);
      window.removeEventListener('keydown', onKeyDown);
      closeButton?.removeEventListener('click', onClose);
      backdrop?.removeEventListener('click', onClose);
      controls.removeEventListener('click', onControls);
      backButton?.removeEventListener('click', onBack);
      harboursButton?.removeEventListener('click', onHarbours);
      harboursBack?.removeEventListener('click', onBack);
    },
  };
}
