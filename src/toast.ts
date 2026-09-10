import { TOAST_HOLD, TOAST_QUEUE } from './questconstants';

/**
 * toast.ts — the transient notice the game has never had.
 *
 * `docs/ROADMAP.md`, **Player-facing work** item 4: "There is no toast or
 * notification layer. Gold changes are a silent number swap in the telemetry
 * panel; a caught fish, an arriving storm, a raider sighting and a harbour
 * first-visit all pass without comment." That is the gap this closes, and it is
 * a prerequisite rather than a nicety — without it a contract settling is a
 * number in a panel nobody was looking at.
 *
 * Contracts are its only consumer in Phase 1. Everything else on that list is
 * one `push` at an event `main.ts` already sees, and joining it later costs
 * nothing here. It was built in the contracts branch rather than ahead of it for
 * one reason: a notification layer with no consumer is a design with no
 * feedback, and the first consumer is what tells you whether four seconds is
 * long enough and whether one line is enough room.
 *
 * ## Why the clock is the world's
 *
 * `update(dt)` is called from the SAILING branch of `main.ts`'s frame loop and
 * nowhere else, so a notice raised on the frame the fishing card opens is still
 * there when the card closes. A CSS animation or a `setTimeout` would have run
 * the message out behind the card, and the player would come back to a world
 * that had quietly told them something and then forgotten it.
 *
 * That is also why there is no transition on the way out in `style.css`: the
 * fade would be on a real clock while the hold is on the world's, and the two
 * would disagree every time the world stopped.
 *
 * ## One line, one at a time
 *
 * The strip shows the head of the queue and nothing else. A stack of three
 * would cover the mooring notice, which sits at the same edge and is the one
 * thing on this HUD a player must not miss. Messages behind the head wait their
 * turn, and the fifth is DROPPED rather than queued — at four seconds each, a
 * deeper queue would be describing something that happened twenty seconds ago
 * and is no longer news.
 */

/**
 * How loud a notice is. Three, mapped to classes in `style.css`, drawn from the
 * hull block's palette so the colour language is the HUD's and not this file's.
 *
 * - `info` — something started, or moved. The quiet one.
 * - `good` — something was earned.
 * - `bad`  — something was lost.
 */
export type ToastSeverity = 'info' | 'good' | 'bad';

export interface Toast {
  /**
   * Raises a notice. Silently dropped when the queue is full.
   *
   * Text, not markup: it goes in through `textContent`. Harbour names reach
   * this by way of `quests.ts`, and a place name rendered into a page is
   * exactly the kind of thing that later comes from somewhere other than a
   * constant in this repository.
   */
  push(text: string, severity?: ToastSeverity): void;
  /** One frame of world time. Only called from the sailing branch. */
  update(dt: number): void;
  /** Drops everything waiting and clears the strip. */
  clear(): void;
  dispose(): void;
}

interface Notice {
  readonly text: string;
  readonly severity: ToastSeverity;
}

/** The class the strip wears, per severity. One per value of `ToastSeverity`. */
const SEVERITY_CLASS: Readonly<Record<ToastSeverity, string>> = {
  info: 'toast--info',
  good: 'toast--good',
  bad: 'toast--bad',
};

export function createToast(): Toast {
  const root = document.getElementById('hud-toast');
  const textEl = document.getElementById('hud-toast-text');

  if (root === null || textEl === null) {
    /*
     * The contract every view in this project keeps: a thing that is not in the
     * document must not take the frame loop down with it.
     *
     * Harmless here in a way it is not for an overlay — nothing is waiting on a
     * notice to hand the game back — so it is a plain no-op with no fallback
     * behaviour to get right. `quests.ts` still settles, still pays and still
     * writes the save; the player simply is not told.
     */
    return {
      push: (): void => undefined,
      update: (): void => undefined,
      clear: (): void => undefined,
      dispose: (): void => undefined,
    };
  }

  const strip: HTMLElement = root;
  const label: HTMLElement = textEl;

  const queue: Notice[] = [];
  let showing: Notice | null = null;
  let held = 0;

  /** Write-through caches, on `hud.ts`'s terms: the strip is touched on change only. */
  let lastText: string | null = null;
  /**
   * Which severity class the element is currently wearing, read back off the
   * MARKUP rather than started at null.
   *
   * The same trick `hud.ts`'s `modifierWriter` uses, and here it is a bug fix
   * rather than an optimisation. `index.html` ships the strip with
   * `toast--info` on it, so starting this at null would skip the removal on the
   * first paint and leave the element wearing two severity classes at once —
   * after which which colour won would be decided by the order the rules happen
   * to appear in `style.css`.
   */
  let lastSeverity: ToastSeverity | null =
    (Object.keys(SEVERITY_CLASS) as ToastSeverity[]).find((name) =>
      strip.classList.contains(SEVERITY_CLASS[name]),
    ) ?? null;

  function paint(): void {
    if (showing === null) {
      // `hidden` and not a `display` rule, for `.moor`'s reason: the UA's
      // `[hidden]` is `display: none` at author-origin strength, and a
      // stylesheet that declared a `display` on the element would beat it.
      if (!strip.hidden) strip.hidden = true;
      return;
    }
    if (showing.text !== lastText) {
      lastText = showing.text;
      label.textContent = showing.text;
    }
    if (showing.severity !== lastSeverity) {
      if (lastSeverity !== null) strip.classList.remove(SEVERITY_CLASS[lastSeverity]);
      strip.classList.add(SEVERITY_CLASS[showing.severity]);
      lastSeverity = showing.severity;
    }
    if (strip.hidden) strip.hidden = false;
  }

  /** Pulls the next notice onto the strip, or clears it. */
  function advance(): void {
    showing = queue.shift() ?? null;
    held = 0;
    paint();
  }

  return {
    push(text: string, severity: ToastSeverity = 'info'): void {
      if (text.length === 0) return;
      // Nothing on screen: straight on, so the first notice of a session does
      // not wait a frame for `update`.
      if (showing === null) {
        showing = { text, severity };
        held = 0;
        paint();
        return;
      }
      if (queue.length >= TOAST_QUEUE) return;
      queue.push({ text, severity });
    },

    update(dt: number): void {
      if (showing === null) return;
      held += dt;
      if (held < TOAST_HOLD) return;
      advance();
    },

    clear(): void {
      queue.length = 0;
      showing = null;
      held = 0;
      paint();
    },

    dispose(): void {
      queue.length = 0;
      showing = null;
      paint();
    },
  };
}

/* ------------------------------------------------------------------ */
/* The queue, without a DOM                                            */
/* ------------------------------------------------------------------ */

/**
 * The same queue, as a pure object, so the rules above can be tested.
 *
 * `createToast` is a DOM view and nothing in this project mounts one in a test
 * (`docs/TESTING.md`: nothing here asserts on appearance). What IS worth
 * pinning is the behaviour a player would notice if it broke — that the fifth
 * message is dropped rather than queued, that the hold runs on the `dt` it is
 * handed and not on a real clock, and that an empty queue shows nothing — so
 * the logic is written once here and the view above drives the same rules.
 *
 * Exported for `tests/unit/quests-views.test.ts`.
 */
export interface ToastQueue {
  /** The notice on screen, or null. */
  readonly current: { readonly text: string; readonly severity: ToastSeverity } | null;
  /** How many are waiting behind it. */
  readonly waiting: number;
  /** False when the notice was dropped because the queue was full. */
  push(text: string, severity?: ToastSeverity): boolean;
  update(dt: number): void;
}

export function createToastQueue(): ToastQueue {
  const queue: Notice[] = [];
  let showing: Notice | null = null;
  let held = 0;

  return {
    get current(): Notice | null {
      return showing;
    },
    get waiting(): number {
      return queue.length;
    },
    push(text: string, severity: ToastSeverity = 'info'): boolean {
      if (text.length === 0) return false;
      if (showing === null) {
        showing = { text, severity };
        held = 0;
        return true;
      }
      if (queue.length >= TOAST_QUEUE) return false;
      queue.push({ text, severity });
      return true;
    },
    update(dt: number): void {
      if (showing === null) return;
      held += dt;
      if (held < TOAST_HOLD) return;
      showing = queue.shift() ?? null;
      held = 0;
    },
  };
}
