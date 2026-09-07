/**
 * loading.ts — the splash the world is built behind.
 *
 * It is the one piece of UI in the project that is NOT created by its module.
 * The markup ships visible in `index.html` and this only ever takes it over,
 * because the whole value of a loading screen is being on screen before the
 * thing it is covering for has started: `main.ts` arrives as a deferred module
 * script, so by the time any of this runs the browser has already painted the
 * splash from HTML and CSS alone. Building it here would mean a blank window
 * for exactly as long as the bundle takes to parse.
 *
 * `step` is the shape the rest of the file is written around. Every stage of
 * the boot is heavy synchronous work, and synchronous work does not let the
 * browser paint — so a progress bar written the obvious way (set the width,
 * then do the work) would jump from 0 to 100 on the frame the world finished
 * and never be seen. `step` therefore sets the bar and then WAITS for the
 * paint before returning, and `main.ts` calls it before each stage rather than
 * after. The bar is a promise of what is about to happen.
 */

export interface Loading {
  /**
   * Moves the bar and the caption, then waits for the browser to actually
   * paint them. Await it BEFORE the work the caption describes.
   */
  step(fraction: number, label: string): Promise<void>;
  /**
   * Moves the bar without waiting, for progress arriving inside a stage — a
   * download reporting bytes, say. No paint is forced, because the caller is
   * not blocking the main thread while it happens.
   */
  set(fraction: number): void;
  /** Fades the screen out and takes it out of the document. */
  done(): Promise<void>;
  /** Takes it down at once, unfaded. `?probe=wave` never wanted it. */
  dismiss(): void;
}

/**
 * Milliseconds the screen takes to fade.
 *
 * Must match the `transition` on `.loading` in `style.css`; the class starts
 * the fade and this decides when the element is hidden, and an element hidden
 * early cuts its own fade off halfway. Short, because a loading screen that
 * lingers after the world is ready is just a wait with better art.
 */
const FADE_MS = 380;

/** Resolves after the browser has painted. */
function painted(): Promise<void> {
  // Two frames, not one. A single rAF callback runs BEFORE the paint it is
  // scheduled against, so resolving there would hand control back to a caller
  // that immediately blocks the main thread for half a second, and the width
  // just written would never reach the screen. The second frame only runs once
  // the first one's paint is done.
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function createLoading(): Loading {
  const root = document.getElementById('loading');
  const bar = document.getElementById('loading-bar');
  const fill = document.getElementById('loading-fill');
  const label = document.getElementById('loading-label');
  const percent = document.getElementById('loading-pct');

  if (root === null) {
    // No markup, no splash — and the boot still has to run. Every `step`
    // resolves on the next frame anyway, so the staged bootstrap in `main.ts`
    // behaves identically; it simply has nothing to draw on.
    return {
      step: painted,
      set: (): void => undefined,
      done: (): Promise<void> => Promise.resolve(),
      dismiss: (): void => undefined,
    };
  }

  const overlay: HTMLElement = root;
  let gone = false;
  /** Last width written, so a stage that reports the same figure twice is free. */
  let lastPercent = -1;

  function set(fraction: number): void {
    if (gone) return;
    const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
    const whole = Math.round(clamped * 100);
    if (whole === lastPercent) return;
    lastPercent = whole;
    // The width is the animation: `.loading__fill` carries a transition, so a
    // stage that jumps twenty points slides rather than snaps, and the bar
    // keeps moving through the frames the main thread is too busy to give it.
    if (fill !== null) fill.style.width = `${whole}%`;
    if (percent !== null) percent.textContent = `${whole}%`;
    bar?.setAttribute('aria-valuenow', String(whole));
  }

  return {
    async step(fraction: number, text: string): Promise<void> {
      if (gone) return;
      set(fraction);
      if (label !== null) label.textContent = text;
      await painted();
    },

    set,

    async done(): Promise<void> {
      if (gone) return;
      gone = true;
      set(1);
      // The bar reaching 100 has to be seen before the fade starts, or the
      // screen leaves on a figure the player never read.
      await painted();
      overlay.classList.add('loading--gone');
      await new Promise((resolve) => setTimeout(resolve, FADE_MS));
      overlay.hidden = true;
      // Out of the document entirely: it is a full-screen fixed box and it is
      // never coming back, so leaving it behind means every later hit test
      // walks past it forever.
      overlay.remove();
    },

    dismiss(): void {
      gone = true;
      overlay.remove();
    },
  };
}
