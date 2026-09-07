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
 * Two panes and one screen. The root offers what the menu can do; CONTROLS
 * swaps to the list and BACK returns. They are panes rather than two overlays
 * because there is no state to carry between them and nothing else in the
 * project stacks a card on a card — the fish book sits ON the fishing cover,
 * but only because the record is a page of that activity rather than a
 * destination of its own.
 *
 * It owns the ESCAPE KEY OUTRIGHT — opening as well as closing. That is one
 * listener rather than two, and it is deliberate: with `main.ts` opening on
 * Escape and this file closing on it, a single press would reach both handlers
 * and the menu would open and shut on the same event, with the order of two
 * `window` listeners deciding whether the player saw anything. Whether opening
 * is ALLOWED is still `main.ts`'s to answer, through `canOpen` — this file has
 * no idea what a fight or a maelstrom is.
 */

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
}

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

/** The pane modifier. `style.css` owns everything that follows from it. */
const CONTROLS_CLASS = 'menu--controls';

export function createMenu(deps: MenuDeps): Menu {
  const root = document.getElementById('menu');
  const backdrop = document.getElementById('menu-backdrop');
  const closeButton = document.getElementById('menu-close');
  const controlsButton = document.getElementById('menu-controls');
  const backButton = document.getElementById('menu-back');

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
   * Shows the root pane or the controls pane.
   *
   * The pane is reset to root on the way IN rather than on the way out, so a
   * player who left the menu reading the controls does not come back to a
   * screen still showing them: the menu is a place you arrive at, and it
   * should look the same every time you arrive.
   */
  function setPane(showControls: boolean): void {
    overlay.classList.toggle(CONTROLS_CLASS, showControls);
    // The button the player would want next, and it is never the one they just
    // pressed: going in, that is BACK; coming out, CONTROLS.
    if (!showControls) controls.focus();
    else if (backButton instanceof HTMLButtonElement) backButton.focus();
  }

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    overlay.hidden = !next;
    overlay.setAttribute('aria-hidden', next ? 'false' : 'true');
    if (next) setPane(false);
  }

  function onClose(): void {
    setOpen(false);
  }

  function onControls(): void {
    setPane(true);
  }

  function onBack(): void {
    setPane(false);
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
    },
  };
}
