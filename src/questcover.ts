import type { QuestOffer } from './types';
import type { Quests } from './quests';
import type { Reputation } from './reputation';
import { formatSpan } from './quests';
import { MAX_ACTIVE } from './questconstants';

/**
 * questcover.ts — the harbour's board. What `[CONTRACTS]` opens.
 *
 * Built on `fishcover.ts` to the letter: one piece of art, a body over it, a
 * close disc in the corner, an Escape that is guarded on `open` rather than
 * bound and unbound, and a no-op fallback for a screen that is not in the
 * document. A player who has opened the fishing cover has already learned how
 * to leave this one, and that is worth more than any originality available here.
 *
 * ## Why it is a screen of its own and not a tab in the chandlery
 *
 * The owner's call, made knowing the pad was already crowded. The argument
 * against the cheaper option is that `shop.ts` is a place a player goes to
 * SPEND, and a board is a place they go to decide where to sail next; folding
 * the second into the first would mean a player who never buys anything never
 * discovers that the game has a goal. A key of its own says there is something
 * here.
 *
 * ## What this file is not allowed to know
 *
 * It has never seen a `Towns`, a `Vector3`, the sun or the chart, and it must
 * not. Every fact on a card is already inside the `QuestOffer` that
 * `quests.ts` built — the purse, the standing, the deadline, the brief — with
 * exactly one exception, and the exception is wired as a callback rather than as
 * a dependency: `deps.sky`, which turns an offer into a line about what the
 * sun is doing over its target. That is the one reading which is about the
 * WORLD rather than about the posting, so `main.ts` supplies it, on the same
 * terms as the HARBOURS page's rows.
 *
 * ## The two buttons, and why ABANDON costs something
 *
 * ACCEPT is dimmed with a reason when the slots are full, on `fishcover.ts`'s
 * terms: an affordance, never the lock. `quests.accept` refuses on its own
 * account and the screen stays up on a refusal.
 *
 * ABANDON costs the same reputation a missed deadline costs, and that is
 * deliberate rather than punitive. Without it, three bad contracts could be
 * cleared for free and the deadline would stop meaning anything — a player
 * would accept everything and drop whatever turned out to be inconvenient. With
 * it, the price of changing your mind is the price of being wrong, which is the
 * same price. What it buys is that a slot is never permanently stuck: a
 * contract whose target this world does not contain can always be cleared.
 */

export interface QuestCoverDeps {
  readonly quests: Quests;
  readonly reputation: Reputation;
  /**
   * The harbour the ship is tied up at, or null. Asked on every open.
   *
   * A callback for the pause contract's reason, the same one `shop.ts`'s
   * `harbour` is one for: a berth read once at construction would be a lie by
   * the second frame, and the whole point of the name in the heading is that it
   * is the board of the harbour you are actually alongside.
   */
  readonly berth: () => string | null;
  /** The world day to ask the board for. `quests.day`, through `main.ts`. */
  readonly day: () => number;
  /**
   * One line per card about the target's own sky, or the empty string.
   *
   * The only thing on a card this file cannot get from the offer, and the
   * reason the whole day/night half of the design is legible at the point of
   * decision rather than only after arriving.
   */
  readonly sky: (offer: QuestOffer) => string;
  /** Called when the screen opens, so `main.ts` can halt the ship. */
  readonly onOpen: () => void;
}

export interface QuestCover {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

/** "1 250 g" — a purse, spaced the way the chandlery prices are. */
function formatGold(gold: number): string {
  return `${gold.toLocaleString('en-GB').replace(/,/g, ' ')} g`;
}

/** "+20 REP" / "-5 REP", always signed: a standing is a change, not a total. */
function formatRep(points: number): string {
  return `${points >= 0 ? '+' : '-'}${Math.abs(points)} REP`;
}

export function createQuestCover(deps: QuestCoverDeps): QuestCover {
  const root = document.getElementById('questcover');
  const backdrop = document.getElementById('questcover-backdrop');
  const closeButton = document.getElementById('questcover-close');
  const titleEl = document.getElementById('questcover-title');
  const repEl = document.getElementById('questcover-rep');
  const offersList = document.getElementById('questcover-offers');
  const activeList = document.getElementById('questcover-active');
  const offersEmpty = document.getElementById('questcover-offers-empty');
  const activeEmpty = document.getElementById('questcover-active-empty');

  if (root === null || offersList === null || activeList === null) {
    // The contract every overlay keeps: a screen that is not in the document
    // must not take the frame loop down with it, and must not be able to accept
    // anything either.
    return {
      isOpen: false,
      open: (): void => undefined,
      close: (): void => undefined,
      dispose: (): void => undefined,
    };
  }

  const overlay: HTMLElement = root;
  const offers: HTMLElement = offersList;
  const held: HTMLElement = activeList;

  let open = false;
  /** The harbour whose board is showing. Read on open and held, never re-read. */
  let board: string | null = null;

  /**
   * Builds one posting.
   *
   * `textContent` everywhere, never markup: a brief is assembled from a cargo
   * noun and a harbour name, and a place name rendered into a page is exactly
   * the kind of thing that later comes from somewhere other than a constant in
   * this repository.
   */
  function offerRow(offer: QuestOffer, full: boolean): HTMLElement {
    const row = document.createElement('li');
    row.className = 'offerq';

    const head = document.createElement('div');
    head.className = 'offerq__head';

    const tier = document.createElement('span');
    tier.className = `offerq__tier offerq__tier--${offer.tier}`;
    // Roman, because the shop's ladders are Mk I to Mk III and a contract's
    // three bands are the same idea said about a different thing.
    tier.textContent = ['I', 'II', 'III'][offer.tier - 1];
    head.appendChild(tier);

    const brief = document.createElement('span');
    brief.className = 'offerq__brief';
    brief.textContent = offer.brief;
    head.appendChild(brief);

    row.appendChild(head);

    const note = deps.sky(offer);
    if (note.length > 0) {
      const sky = document.createElement('p');
      // Its own class and its own colour: this is the line that decides whether
      // the contract is a passage or a problem, and it must not read as part of
      // the brief above it.
      sky.className = 'offerq__sky';
      sky.textContent = note;
      row.appendChild(sky);
    }

    const foot = document.createElement('div');
    foot.className = 'offerq__foot';

    const pay = document.createElement('span');
    pay.className = 'offerq__pay';
    pay.textContent = `${formatGold(offer.gold)}   ${formatRep(offer.reputation)}`;
    foot.appendChild(pay);

    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'fbtn fbtn--go offerq__take';
    accept.textContent = 'Accept';
    if (full) {
      // Dimmed with the reason in a tooltip, on `fishcover.ts`'s pattern. The
      // lock is `quests.accept`; this is the affordance.
      accept.disabled = true;
      accept.title = `Already carrying ${MAX_ACTIVE}`;
    }
    accept.addEventListener('click', () => {
      if (deps.quests.accept(offer)) refresh();
    });
    foot.appendChild(accept);

    row.appendChild(foot);
    return row;
  }

  /** Builds one contract in hand, with the way out of it. */
  function activeRow(quest: { id: string; brief: string; remaining: number | null }): HTMLElement {
    const row = document.createElement('li');
    row.className = 'heldq';

    const brief = document.createElement('span');
    brief.className = 'heldq__brief';
    brief.textContent = quest.brief;
    row.appendChild(brief);

    const clock = document.createElement('span');
    clock.className = 'heldq__clock';
    // An em dash would be the obvious thing for a goal with no deadline and is
    // exactly wrong: the column is read down, and a dash in a column of clocks
    // reads as a missing figure rather than as "no clock".
    clock.textContent = quest.remaining === null ? 'NO LIMIT' : formatSpan(quest.remaining);
    row.appendChild(clock);

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'fbtn heldq__drop';
    drop.textContent = 'Abandon';
    drop.title = 'Costs standing, exactly as a missed deadline does';
    drop.addEventListener('click', () => {
      if (deps.quests.abandon(quest.id)) refresh();
    });
    row.appendChild(drop);

    return row;
  }

  /**
   * Rebuilds both lists.
   *
   * Outright rather than patched, on the HARBOURS page's terms: six rows is one
   * pass of work on a screen that has already frozen the world, and every row
   * carries a figure that is stale the moment anything settles.
   *
   * There is deliberately no per-frame `update` here, unlike `fishcover.ts`.
   * That screen needs one because the power plant keeps running under it and
   * START FISHING has to come alive as the tank fills. Nothing on this board
   * moves while it is up: the contract clocks are world time and the world is
   * stopped, the purse is fixed at issue, and standing only changes on a
   * settlement that this screen is the only possible cause of. So it is rebuilt
   * on the three events that can change it — opening, accepting, abandoning —
   * and not on a clock.
   */
  function refresh(): void {
    if (titleEl !== null) titleEl.textContent = board === null ? 'CONTRACTS' : board.toUpperCase();
    if (repEl !== null) repEl.textContent = `REPUTATION  ${deps.reputation.points}`;

    const full = deps.quests.active.length >= MAX_ACTIVE;
    const posted = board === null ? [] : deps.quests.offers(board, deps.day());

    offers.textContent = '';
    for (const offer of posted) offers.appendChild(offerRow(offer, full));
    if (offersEmpty !== null) offersEmpty.hidden = posted.length > 0;

    held.textContent = '';
    for (const quest of deps.quests.active) held.appendChild(activeRow(quest));
    if (activeEmpty !== null) activeEmpty.hidden = deps.quests.active.length > 0;
  }

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    overlay.hidden = !next;
    overlay.setAttribute('aria-hidden', next ? 'false' : 'true');
    if (!next) {
      // Dropped on the way out so a board cannot be rebuilt for a harbour the
      // ship has since left: `refresh` is reachable from a button handler, and
      // a stale name here would post another harbour's work.
      board = null;
      return;
    }
    board = deps.berth();
    refresh();
    if (closeButton instanceof HTMLButtonElement) closeButton.focus();
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
    },
  };
}

/* ------------------------------------------------------------------ */
/* Exported for the tests                                              */
/* ------------------------------------------------------------------ */

export { formatGold, formatRep };
