import type { Species, Tier } from './types';
import type { Wallet } from './wallet';
import { SPECIES, TIERS } from './species';

/**
 * fishbook.ts — the catch record and the panel that shows it.
 *
 * Two things live here because they are two views of one fact and splitting
 * them would only buy an interface between them: the store is the counts, the
 * panel is the counts drawn. Neither knows about localStorage — `save.ts`
 * subscribes to the store and writes the file.
 */

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export interface FishBookStore {
  /** Times this species has been caught, ever. 0 if never. */
  count(id: string): number;
  /** Banks one catch and persists it. */
  record(species: Species): void;
  /** Distinct species caught at least once. */
  readonly discovered: number;
  /** Every catch, ever, summed. */
  readonly total: number;
  /** Returns an unsubscribe function. */
  onChange(cb: () => void): () => void;
  /**
   * The counts as a plain record, for `save.ts` to write. A copy, and it
   * carries ids this build has never heard of — see `createFishBookStore`.
   */
  snapshot(): Record<string, number>;
}

/**
 * The record, seeded from a save.
 *
 * `initial` is taken **as given**, unknown ids included. A save written by a
 * later build therefore travels through this one untouched, and a species
 * renamed between builds keeps its history instead of being silently zeroed by
 * the first load that does not recognise it. `save.ts` makes the same promise
 * on the way in; this is the half of it that makes the promise survive a write.
 */
export function createFishBookStore(initial: Readonly<Record<string, number>> = {}): FishBookStore {
  const counts = new Map<string, number>(Object.entries(initial));
  const subscribers = new Set<() => void>();

  /**
   * Distinct species in THIS build's catalogue with a catch against them.
   *
   * Deliberately not "entries in the map": the footer reads `12 / 20 SPECIES`
   * against a fixed denominator, and counting an id the catalogue no longer
   * contains would print `21 / 20`. `total` below makes the opposite choice
   * for the opposite reason.
   */
  function discovered(): number {
    let n = 0;
    for (const species of SPECIES) if ((counts.get(species.id) ?? 0) > 0) n++;
    return n;
  }

  /**
   * Every catch ever, unknown ids included — it is a lifetime tally rather
   * than a score out of the catalogue, and a fish this build cannot name was
   * still caught by the player who is being told how many they have caught.
   */
  function total(): number {
    let n = 0;
    for (const count of counts.values()) n += count;
    return n;
  }

  return {
    count(id: string): number {
      return counts.get(id) ?? 0;
    },

    record(species: Species): void {
      counts.set(species.id, (counts.get(species.id) ?? 0) + 1);
      // Over a copy: a subscriber may unsubscribe itself from inside its own
      // callback, which is exactly what a panel's dispose() does.
      for (const cb of Array.from(subscribers)) cb();
    },

    get discovered(): number {
      return discovered();
    },

    get total(): number {
      return total();
    },

    onChange(cb: () => void): () => void {
      subscribers.add(cb);
      return (): void => {
        subscribers.delete(cb);
      };
    },

    snapshot(): Record<string, number> {
      return Object.fromEntries(counts);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** U+2009 THIN SPACE. A comma would read as a decimal point to half the world. */
const THIN_SPACE = ' ';

/** U+00D7 MULTIPLICATION SIGN, and the em dash that stands in for no catches. */
const TIMES = '×';
const NO_COUNT = '—';

/**
 * "1 565" — gold, grouped in threes by a thin space.
 *
 * The footer has a whole line to itself and this figure is the reward the
 * panel exists to report, so it groups from four digits up rather than from
 * five as the cramped telemetry row does. `docs/FISHING_PLAN.md` draws it this
 * way in both of its mock-ups.
 */
function formatGold(gold: number): string {
  const digits = String(Math.max(0, Math.floor(gold)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += THIN_SPACE;
    out += digits[i];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

export interface FishBookPanel {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

/** What an uncaught species is called. The discovery is the reward. */
const UNKNOWN_NAME = 'UNKNOWN';

/** One species' row, and the two writers that keep it up to date. */
interface Row {
  readonly species: Species;
  readonly setCaught: (caught: boolean) => void;
  readonly setCount: (count: number) => void;
}

/**
 * Returns a setter that writes textContent only when the value changed.
 *
 * The same write-through cache `hud.ts` uses. It matters less here than it
 * does at 60fps — the book redraws on a catch, not on a frame — but twenty
 * rows times three fields is sixty writes per catch and only one of them ever
 * differs.
 */
function textWriter(el: HTMLElement | null): (value: string) => void {
  let last: string | null = null;
  return (value: string): void => {
    if (el === null || value === last) return;
    last = value;
    el.textContent = value;
  };
}

/** Returns a setter that toggles one class only when the flag changed. */
function classWriter(el: HTMLElement | null, name: string): (on: boolean) => void {
  let last: boolean | null = null;
  return (on: boolean): void => {
    if (el === null || on === last) return;
    last = on;
    el.classList.toggle(name, on);
  };
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * Builds one species row and returns it with its writers.
 *
 * The name is written by a setter rather than baked into the markup, because
 * an uncaught species must not have its name in the DOM at all: it would be a
 * two-word spoiler sitting one inspector click away from the player who is
 * meant to be hunting for it.
 */
function buildRow(species: Species): { node: HTMLElement; row: Row } {
  const node = element('div', 'fishbook__row');
  node.style.setProperty('--tint', species.art.tint);

  const sprite = element('span', 'fishbook__sprite');
  sprite.appendChild(element('span', 'fishbook__glyph', species.art.emoji));
  node.appendChild(sprite);

  const name = element('span', 'fishbook__name');
  node.appendChild(name);

  node.appendChild(element('span', 'fishbook__gold', `${species.gold}g`));

  const count = element('span', 'fishbook__count');
  node.appendChild(count);

  const writeName = textWriter(name);
  const writeCount = textWriter(count);
  const writeUnknown = classWriter(node, 'fishbook__row--unknown');

  return {
    node,
    row: {
      species,
      setCaught(caught: boolean): void {
        writeUnknown(!caught);
        writeName(caught ? species.name : UNKNOWN_NAME);
      },
      setCount(n: number): void {
        writeCount(n > 0 ? `${TIMES}${THIN_SPACE}${n}` : NO_COUNT);
      },
    },
  };
}

/**
 * The record panel: every species in the catalogue, grouped by tier.
 *
 * It ships hidden and knows nothing about what opens it — the HUD button is
 * wired elsewhere — so the only thing it owns beyond its own DOM is Escape.
 */
export function createFishBook(store: FishBookStore, wallet: Wallet): FishBookPanel {
  const root = document.getElementById('fishbook');
  const body = document.getElementById('fishbook-body');
  const foot = document.getElementById('fishbook-foot');
  const closeButton = document.getElementById('fishbook-close');
  const backdrop = document.getElementById('fishbook-backdrop');

  const rows: Row[] = [];

  // Built once, from the catalogue, in tier order. The markup ships as an
  // empty shell precisely so `species.ts` stays the only place the catalogue
  // exists: a species added there appears here with no edit to index.html.
  if (body !== null) {
    // Cleared first, so building is idempotent. The shipped body is already
    // empty, and the app constructs this once — but a dev-server hot reload
    // re-runs the bootstrap against a document that was never torn down, and
    // appending blind there stacks a second catalogue under the first. Found
    // exactly that way, in the browser.
    body.replaceChildren();

    for (const info of TIERS) {
      const tier: Tier = info.tier;
      const members = SPECIES.filter((s) => s.tier === tier);
      if (members.length === 0) continue;

      const group = element('section', 'fishbook__group');
      // The colour comes from `TIERS`, not from the --tier-N tokens, so this
      // heading and the catch flash in the card read off one source. The
      // tokens are there for CSS that has no species in hand.
      group.style.setProperty('--tier', info.colour);
      group.appendChild(element('h3', 'fishbook__tier', info.name));

      for (const species of members) {
        const built = buildRow(species);
        group.appendChild(built.node);
        rows.push(built.row);
      }
      body.appendChild(group);
    }
  }

  const writeFoot = textWriter(foot);

  function refresh(): void {
    for (const row of rows) {
      const n = store.count(row.species.id);
      row.setCaught(n > 0);
      row.setCount(n);
    }
    writeFoot(
      `${store.discovered} / ${SPECIES.length} SPECIES · ${formatGold(wallet.gold)} GOLD`,
    );
  }

  // Both subscriptions redraw the whole panel. Gold moves on the same event
  // the counts do, so two narrower paths would only buy a moment in which the
  // footer's two halves disagreed.
  const unsubBook = store.onChange(refresh);
  const unsubWallet = wallet.onChange(refresh);
  refresh();

  let open = false;

  function setOpen(next: boolean): void {
    if (root === null || next === open) return;
    open = next;
    root.hidden = !next;
    root.setAttribute('aria-hidden', next ? 'false' : 'true');
    if (next) {
      // The catches landed while this was closed, and the subscriptions above
      // have already written them, so opening is only the scroll and the
      // focus. Redrawing here as well would be the same sixty no-op writes.
      body?.scrollTo({ top: 0 });
      closeButton?.focus();
    }
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
  // Clicking away is what every other modal on the machine does, and the
  // backdrop is already there to catch the pointer the world must not receive.
  backdrop?.addEventListener('click', onClose);

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
      unsubBook();
      unsubWallet();
    },
  };
}
