import type { Energy } from './energy';
import type { FishBookStore } from './fishbook';
import { createFishRenderer, speciesGlyph } from './fishrender';
import type { FishRenderer } from './fishrender';
import { createFishingSim } from './fishsim';
import type { FishingSim } from './fishsim';
import { tierInfo } from './species';
import type { FishingState, Species } from './types';
import type { Wallet } from './wallet';

/**
 * fishing.ts — the overlay controller.
 *
 * Owns the card's DOM, the input capture and the bookkeeping that turns a
 * `caught` event into gold and a Fish Book entry. The sim does not know about
 * any of that, and the renderer does not either: three modules read one
 * `FishingState` and none of them can contradict the others about it.
 *
 * This is the ONLY place gold is earned. `wallet.ts` is the only writer of the
 * figure and this is its only caller in a session, so "where did that gold
 * come from" has exactly one answer.
 */

/** Share of the tank one session costs. See FISHING_PLAN.md. */
export const SESSION_COST = 0.5;

export interface FishingDeps {
  readonly energy: Energy;
  readonly wallet: Wallet;
  readonly book: FishBookStore;
  /** Called when the card opens, so `main.ts` can freeze the world. */
  readonly onOpen: () => void;
  /** Called when it closes, so `main.ts` can thaw it. */
  readonly onClose: () => void;
}

export interface Fishing {
  readonly isOpen: boolean;
  /**
   * Charges SESSION_COST and opens, or returns false and does nothing.
   * A refusal must leave the tank untouched.
   */
  open(): boolean;
  close(): void;
  /** Steps the sim and paints. Called only while open. */
  update(dt: number): void;
  dispose(): void;
}

/**
 * Thousands separator for gold.
 *
 * A thin space rather than a comma, and only above four digits: the HUD is
 * monospaced and a comma inside a tabular figure shifts every digit after it
 * by a full cell every time the total crosses a power of ten.
 */
const THIN_SPACE = ' ';

function formatGold(gold: number): string {
  const n = Math.max(0, Math.round(gold));
  if (n < 10000) return String(n);
  return String(n).replace(/\B(?=(\d{3})+$)/g, THIN_SPACE);
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Wires the card in `index.html` to a sim and a renderer.
 *
 * Returns a controller that refuses to open if the markup is missing, on the
 * same terms as `radar.ts`: a display that is not in the document must not
 * take the frame loop down with it, and — the part that matters here — it must
 * not take the player's power either. `open()` returning false is the same
 * answer a flat battery gets, and it spends nothing.
 */
export function createFishing(deps: FishingDeps): Fishing {
  const root = document.getElementById('fishing');
  const canvasEl = document.getElementById('fishing-canvas');
  const clockEl = document.getElementById('fishing-clock');
  const shotsEl = document.getElementById('fishing-shots');
  const goldEl = document.getElementById('fishing-gold');
  const summaryEl = document.getElementById('fishing-summary');
  const catchesEl = document.getElementById('fishing-catches');
  const totalEl = document.getElementById('fishing-total');
  const againEl = document.getElementById('fishing-again');
  const closeEl = document.getElementById('fishing-close');

  if (
    !root ||
    !(canvasEl instanceof HTMLCanvasElement) ||
    !clockEl ||
    !shotsEl ||
    !goldEl ||
    !summaryEl ||
    !catchesEl ||
    !totalEl ||
    !(againEl instanceof HTMLButtonElement) ||
    !(closeEl instanceof HTMLButtonElement)
  ) {
    return {
      isOpen: false,
      open: (): boolean => false,
      close: (): void => undefined,
      update: (): void => undefined,
      dispose: (): void => undefined,
    };
  }

  // Re-bound with narrow types so the closures below see them as such, the
  // same move `radar.ts` makes with its canvas and context.
  const overlay: HTMLElement = root;
  const canvas: HTMLCanvasElement = canvasEl;
  const clockOut: HTMLElement = clockEl;
  const shotsOut: HTMLElement = shotsEl;
  const goldOut: HTMLElement = goldEl;
  const summary: HTMLElement = summaryEl;
  const catches: HTMLElement = catchesEl;
  const total: HTMLElement = totalEl;
  const again: HTMLButtonElement = againEl;
  const closeBtn: HTMLButtonElement = closeEl;

  const renderer: FishRenderer = createFishRenderer(canvas);

  let sim: FishingSim = createFishingSim();
  let open = false;
  let summaryShown = false;
  let listening = false;

  /**
   * The press, held for exactly one `update`.
   *
   * Set by a pointer or a Space keydown, consumed by the next step of the sim
   * and cleared there. A frame with three clicks in it is still one press —
   * the struggle is paid for in frames, and letting a mouse's event rate top
   * up the tension would make a gaming mouse a cheat code.
   */
  let pressed = false;

  /**
   * The input record, mutated in place rather than rebuilt.
   *
   * `FishingInput.press` is readonly to its reader; this is its writer, so the
   * local type is the mutable one and the sim sees the read-only surface.
   */
  const input = { press: false };

  /*
   * This session's takings, tallied HERE rather than read off the sim.
   *
   * `FishingState` reports the same two figures, but the summary has to agree
   * with the wallet and not merely with the ruleset: these are accumulated in
   * the same loop that calls `wallet.add`, so a catch can never be listed
   * without having been paid, or paid without being listed.
   */
  const sessionCatches: Species[] = [];
  let sessionGold = 0;

  /* ---- write-through caches, the same pattern as hud.ts ------------ */
  let lastClock = '';
  let lastShots = '';
  let lastGold = '';
  let lastAgainDisabled: boolean | null = null;

  function write(el: HTMLElement, text: string, cache: string): string {
    if (text === cache) return cache;
    el.textContent = text;
    return text;
  }

  /* ---------------------------------------------------------------- */
  /* Chrome                                                            */
  /* ---------------------------------------------------------------- */

  function paintChrome(state: FishingState): void {
    // Ceil, so the clock reads 0:01 for the whole of the last second and hits
    // 0:00 only when the session is actually over. Floor would show 0:00 for a
    // second the player can still fish in.
    const secs = Math.max(0, Math.ceil(state.timeLeft));
    const clock = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
    lastClock = write(clockOut, clock, lastClock);

    const shots = state.shotsLeft;
    lastShots = write(shotsOut, shots + (shots === 1 ? ' SHOT' : ' SHOTS'), lastShots);

    // The wallet's running total, with what this session has added to it. Two
    // figures because they answer different questions — how rich am I, and is
    // this session going well — and one of them is the reason to fish again.
    const gold = formatGold(deps.wallet.gold) + (sessionGold > 0 ? '  +' + sessionGold : '');
    lastGold = write(goldOut, gold, lastGold);
  }

  /**
   * Keeps FISH AGAIN in step with the tank.
   *
   * Re-read every frame the summary is up rather than once when it opens: the
   * power plant keeps ticking under the card, so a player who ends a session
   * at 40% and reads the catch list can find themselves able to afford another
   * one without touching anything.
   */
  function refreshAgain(): void {
    const affordable = deps.energy.state.level >= SESSION_COST;
    if (lastAgainDisabled === !affordable) return;
    lastAgainDisabled = !affordable;
    again.disabled = !affordable;
    if (affordable) again.removeAttribute('title');
    else again.setAttribute('title', 'Needs 50% power');
  }

  /* ---------------------------------------------------------------- */
  /* The session                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Charges the tank and starts a fresh session, or changes nothing.
   *
   * The charge is the first thing that happens and its refusal is the last
   * word: `energy.spend` is all-or-nothing, so there is no state in which the
   * power has gone and the session has not started.
   */
  function startSession(): boolean {
    if (!deps.energy.spend(SESSION_COST)) return false;
    sim = createFishingSim();
    sessionCatches.length = 0;
    sessionGold = 0;
    pressed = false;
    summaryShown = false;
    summary.hidden = true;
    lastAgainDisabled = null;
    paintChrome(sim.state);
    return true;
  }

  /**
   * Banks the frame's catches.
   *
   * The one place in the project gold is earned. `state.events` is cleared by
   * the sim at the top of every update, so this has to run every frame the sim
   * is stepped — the renderer reads the same list for its float-ups, and both
   * of them are reading it in the window between two updates.
   */
  function bank(state: FishingState): void {
    for (const ev of state.events) {
      if (ev.kind !== 'caught') continue;
      deps.wallet.add(ev.gold);
      deps.book.record(ev.species);
      sessionCatches.push(ev.species);
      sessionGold += ev.gold;
    }
  }

  function showSummary(): void {
    summaryShown = true;

    // Grouped by species in the order they were first landed, so the list
    // reads as the story of the session rather than as a sorted inventory.
    const groups = new Map<string, { species: Species; count: number; gold: number }>();
    for (const species of sessionCatches) {
      const row = groups.get(species.id);
      if (row) {
        row.count += 1;
        row.gold += species.gold;
      } else {
        groups.set(species.id, { species, count: 1, gold: species.gold });
      }
    }

    const rows: HTMLElement[] = [];
    for (const { species, count, gold } of groups.values()) {
      const li = document.createElement('li');
      li.className = 'fcatch';

      const sprite = document.createElement('span');
      sprite.className = 'fcatch__sprite';
      sprite.textContent = speciesGlyph(species);
      li.appendChild(sprite);

      const name = document.createElement('span');
      name.className = 'fcatch__name';
      name.textContent = species.name;
      // The tier colour the Fish Book and the card share, so a legendary is
      // the same orange wherever it is named.
      name.style.color = tierInfo(species.tier).colour;
      li.appendChild(name);

      const times = document.createElement('span');
      times.className = 'fcatch__count';
      times.textContent = '×' + count;
      li.appendChild(times);

      const value = document.createElement('span');
      value.className = 'fcatch__gold';
      value.textContent = String(gold);
      li.appendChild(value);

      rows.push(li);
    }

    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'fcatch fcatch--empty';
      li.textContent = 'NOTHING LANDED';
      rows.push(li);
    }

    catches.replaceChildren(...rows);
    total.textContent = '+' + formatGold(sessionGold) + ' GOLD';
    summary.hidden = false;
    lastAgainDisabled = null;
    refreshAgain();
    // The summary is the only part of the card that takes a keystroke of its
    // own, so it gets the focus rather than leaving it on whatever the page
    // had before the overlay opened.
    (again.disabled ? closeBtn : again).focus();
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  function tap(): void {
    if (!open || summaryShown) return;
    pressed = true;
  }

  function onPointerDown(ev: PointerEvent): void {
    // Stops the gesture turning into a text selection or a double-tap zoom on
    // a phone, where the card is the whole screen and every shot is a tap.
    ev.preventDefault();
    tap();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (!open) return;

    if (ev.key === 'Escape') {
      ev.preventDefault();
      // Escape ends a session at once and shows the summary; a second Escape,
      // on the summary, leaves. The power is not refunded either way — the
      // plan is explicit about that, and a refund would make Escape the way to
      // fish for free until a legendary showed up.
      if (summaryShown) close();
      else sim.abort();
      return;
    }

    if (ev.code !== 'Space' && ev.key !== ' ') return;

    // A focused button keeps its own Space, so the summary's two buttons work
    // from the keyboard like buttons.
    if (ev.target instanceof HTMLButtonElement) return;

    // Before the repeat test, not after: a held Space must not scroll the page
    // on the sixty auto-repeats we are about to throw away either.
    ev.preventDefault();
    if (ev.repeat) return;
    tap();
  }

  function onResize(): void {
    renderer.resize();
  }

  function onAgain(): void {
    if (!startSession()) refreshAgain();
  }

  function attach(): void {
    if (listening) return;
    listening = true;
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    again.addEventListener('click', onAgain);
    closeBtn.addEventListener('click', close);
  }

  function detach(): void {
    if (!listening) return;
    listening = false;
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
    again.removeEventListener('click', onAgain);
    closeBtn.removeEventListener('click', close);
  }

  /* ---------------------------------------------------------------- */
  /* Surface                                                           */
  /* ---------------------------------------------------------------- */

  function openCard(): boolean {
    if (open) return true;
    if (!startSession()) return false;

    open = true;
    overlay.hidden = false;
    attach();
    deps.onOpen();
    // After the card is visible, never before: a display:none element has a
    // clientWidth of zero, and the renderer would size its buffer to nothing
    // and then never notice, because nothing about the element changes again.
    renderer.resize();
    renderer.draw(sim.state, 0);
    return true;
  }

  function close(): void {
    if (!open) return;
    open = false;
    detach();
    overlay.hidden = true;
    summary.hidden = true;
    summaryShown = false;
    pressed = false;
    deps.onClose();
  }

  function update(dt: number): void {
    if (!open) return;

    input.press = pressed;
    pressed = false;

    sim.update(dt, input);
    bank(sim.state);
    paintChrome(sim.state);
    renderer.draw(sim.state, dt);

    if (sim.state.over && !summaryShown) showSummary();
    else if (summaryShown) refreshAgain();
  }

  function dispose(): void {
    detach();
    open = false;
    overlay.hidden = true;
  }

  return {
    get isOpen(): boolean {
      return open;
    },
    open: openCard,
    close,
    update,
    dispose,
  };
}
