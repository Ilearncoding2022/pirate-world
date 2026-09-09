import { HITS_TO_LOSE } from './battle';
import { STALEMATE_COST } from './energy';
import type { AiBoatKind, BattleInput, BattleOutcome, BattleState, InputState } from './types';

/**
 * battleui.ts — the strip, the FIRE key and the result card.
 *
 * The overlay a cannon fight is fought through. It owns the markup inside
 * index.html's BATTLE block, the Space capture, and the one card that says how
 * the fight ended; it owns none of the rules, so every figure it prints is one
 * it was handed. The arena underneath keeps running the whole time, card
 * included, which is why nothing here hides the scene.
 *
 * Two more figures joined the strip with the sea: the fuse bar on the FOE
 * side, which reads `state.fuse` and nothing else -- no timer of its own, and
 * no opinion about how long a fuse runs, which is `battleai.ts`'s constant
 * and not an import this file makes -- and the FOULED word over the player's
 * side, which reads `state.player.fouled` the same way. Both are exactly the
 * figures they were handed, on the same rule as the rest of the strip.
 *
 * `isOpen` is a LIVE GETTER, not a latched flag, for the same reason the
 * fishing card's is: `main.ts` derives the frozen world from it every frame,
 * and a stale `false` would strand the game stopped. See **The pause
 * contract** in docs/ARCHITECTURE.md.
 */
export interface BattleUiDeps {
  /** The player pressed CONTINUE on the result card. `main.ts` applies the outcome and fades home. */
  onContinue: () => void;
}

/**
 * What the card prints, handed over by `main.ts` the frame the fight ends.
 *
 * Every number in it has ALREADY been applied to the wallet and the plant.
 * The card is a receipt, not an instruction: it reads the world as it now is,
 * so it can never advertise a payout the purse did not get.
 */
export interface BattleResult {
  readonly outcome: BattleOutcome;
  /** Signed gold, already moved. Positive is a gain, negative a loss, 0 is neither. */
  readonly gold: number;
  /** The backup cell as it stands AFTER the defeat, in main-tank fractions. */
  readonly reserve: number;
  /**
   * Whole percent of hull the fight cost, POSITIVE, and already knocked off.
   *
   * `main.ts` calls `hull.damage()` before it fills this in, the same
   * ordering the gold and the plant already follow there, so the card is
   * still a receipt rather than an instruction. 5 for a win or a stand-off,
   * 15 for a defeat.
   *
   * Optional, and 0 or absent prints no hull line at all. That is not only
   * for the streams that have not wired it yet: a hull already on its floor
   * cannot lose another point, and a card claiming `HULL -15%` over a bar
   * that did not move would be exactly the lie the receipt rule exists to
   * prevent.
   */
  readonly hull?: number;
}

export interface BattleUi {
  /** True from `open()` until CONTINUE. A live getter, never a stored boolean. */
  readonly isOpen: boolean;
  /**
   * Raises the overlay for a fight against `kind`.
   *
   * `playerHitsToLose` is `hull.state.hitsToLose`, sampled once at contact by
   * `main.ts` and handed to `createBattleSim`, `battlecover.ts` and this file
   * from that one read. The player's pip strip is built to it: three pips
   * beside a sim that ends the fight on one would be the instrument lying
   * about the only thing the player is really watching. The FOE's strip stays
   * at `HITS_TO_LOSE` — the raider has no hull of its own.
   *
   * Defaulted, so a caller that knows nothing about hulls gets the fight as
   * it was.
   */
  open(kind: AiBoatKind, playerHitsToLose?: number): void;
  close(): void;
  /** This tick's player intent: the fire edge plus the two throttle keys. */
  input(raw: InputState): BattleInput;
  update(state: BattleState): void;
  /** Raises the result card over the live arena. Called once per fight. */
  result(result: BattleResult): void;
}

/* ------------------------------------------------------------------ */
/* Wording                                                             */
/* ------------------------------------------------------------------ */

/**
 * The three headlines, in the HUD's voice: a verdict, not a sentence.
 *
 * STAND-OFF rather than DRAW because a draw is a scoreboard word and this is
 * two ships out of shot backing away from each other, which is the thing that
 * actually happened.
 */
const TITLES: Record<BattleOutcome, string> = {
  win: 'VICTORY',
  loss: 'DEFEATED',
  draw: 'STAND-OFF',
};

/**
 * Thousands separator, byte for byte the rule `fishing.ts` keeps.
 *
 * A thin space rather than a comma, and only from five digits up. The purse is
 * printed in four places now and the one failure that matters is two of them
 * disagreeing, so the rule is copied rather than reinvented: see
 * **Persistence** in docs/ARCHITECTURE.md.
 */
const THIN_SPACE = '\u2009';

function formatGold(gold: number): string {
  const n = Math.abs(Math.round(gold));
  if (n < 10000) return String(n);
  return String(n).replace(/\B(?=(\d{3})+$)/g, THIN_SPACE);
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Wires the BATTLE block in `index.html` to a fight.
 *
 * Returns a WORKING no-op when the markup is missing, on the terms
 * `blackout.ts` sets rather than the terms `fishing.ts` does. A missing
 * fishing card can simply refuse to open; a missing battle overlay cannot,
 * because by the time `open()` is called `main.ts` has already halted the ship
 * and committed to the fight. So the flag still flips, the fire key still
 * works, and the result still hands control back through `onContinue`: the
 * player loses the strip and the card, and keeps the game.
 */
export function createBattleUi(deps: BattleUiDeps): BattleUi {
  const root = document.getElementById('battle');
  const youPipsEl = document.getElementById('battle-you-pips');
  const foePipsEl = document.getElementById('battle-foe-pips');
  const promptEl = document.getElementById('battle-prompt');
  const fireEl = document.getElementById('battle-fire');
  const fuseEl = document.getElementById('battle-fuse');
  const fuseFillEl = document.getElementById('battle-fuse-fill');
  const fouledEl = document.getElementById('battle-fouled');
  const cardEl = document.getElementById('battle-card');
  const titleEl = document.getElementById('battle-title');
  const goldEl = document.getElementById('battle-gold');
  const powerEl = document.getElementById('battle-power');
  const hitEl = document.getElementById('battle-hit');
  const continueEl = document.getElementById('battle-continue');

  /** True from `open()` until CONTINUE, whether or not there is anything to look at. */
  let open = false;
  /** The card is up: the fight is decided and the fire key is dead. */
  let decided = false;
  /**
   * The press, held for exactly one `input()`.
   *
   * Edge-triggered here rather than in `battle.ts`, so the sim is handed an
   * intent and never a key state. A frame with three clicks in it is one
   * press, the same rule the fishing card's harpoon keeps: FIRE_COOLDOWN is
   * what limits the rate of fire, and an event rate must never be able to
   * beat it.
   */
  let pressed = false;

  if (
    !root ||
    !youPipsEl ||
    !foePipsEl ||
    !promptEl ||
    !(fireEl instanceof HTMLButtonElement) ||
    !fuseEl ||
    !fuseFillEl ||
    !fouledEl ||
    !cardEl ||
    !titleEl ||
    !goldEl ||
    !powerEl ||
    !hitEl ||
    !(continueEl instanceof HTMLButtonElement)
  ) {
    return {
      get isOpen(): boolean {
        return open;
      },
      open(): void {
        open = true;
      },
      close(): void {
        open = false;
      },
      input(raw: InputState): BattleInput {
        const fire = pressed;
        pressed = false;
        return { fire, faster: raw.forward, slower: raw.backward };
      },
      update(): void {
        /* nothing to paint */
      },
      // The one call that cannot be a no-op: without a card there is no
      // CONTINUE to press, and a player left in a decided fight with no way
      // out is the one failure in this file with no recovery.
      result(): void {
        deps.onContinue();
      },
    };
  }

  // Re-bound with narrow types so the closures below see them as such, the
  // same move `fishing.ts` and `radar.ts` make with their elements.
  const overlay: HTMLElement = root;
  const prompt: HTMLElement = promptEl;
  const fire: HTMLButtonElement = fireEl;
  const fuse: HTMLElement = fuseEl;
  const fuseFill: HTMLElement = fuseFillEl;
  const fouled: HTMLElement = fouledEl;
  const card: HTMLElement = cardEl;
  const title: HTMLElement = titleEl;
  const goldLine: HTMLElement = goldEl;
  const powerLine: HTMLElement = powerEl;
  const hitFlash: HTMLElement = hitEl;
  const continueBtn: HTMLButtonElement = continueEl;

  /**
   * The hull line, built here rather than in `index.html`.
   *
   * Every other element on this card is markup. This one is not, and the
   * reason is ownership rather than taste: docs/HARBOURS_PLAN.md splits
   * `index.html` between the streams by SECTION and gives the BATTLE block to
   * nobody, so a fifth line in it would be an edit no stream is allowed to
   * make. Creating it costs one element once, next to the pips this file
   * already creates for the same reason, and it lands in the same place with
   * the same class the power line uses — `battle__power` is exactly the
   * "quiet second line under the gold" this needs, and it brings the
   * `[hidden] { display: none }` rule with it, which the UA sheet alone does
   * not reliably win. Inventing a `battle__hull` rule would mean a
   * `style.css` edit that is also not this stream's to make, so that class
   * rides along as a hook and nothing else: C or D can give it a colour of
   * its own later without touching this file.
   *
   * Inserted directly AFTER the gold line, so the card reads money, hull,
   * power: the two figures every fight moves, then the one only a defeat
   * drains.
   */
  const hullLine = document.createElement('p');
  hullLine.className = 'battle__power battle__hull';
  hullLine.id = 'battle-hull';
  hullLine.hidden = true;
  goldLine.insertAdjacentElement('afterend', hullLine);

  /**
   * One side of the strip: its pips and its own write-through cache.
   *
   * Built once and mutated in place, never rebuilt, for the reason `main.ts`'s
   * resting snapshot is: `update` runs at 60fps for as long as a fight lasts,
   * and a pair of fresh objects per frame is a collection pause in the middle
   * of an aiming problem. Same pattern as `hud.ts`'s caches.
   *
   * The pips are built from the count rather than typed three times into the
   * markup, because the count IS the rule: three pips beside a sim that ended
   * a fight on two would be an instrument lying about the only thing the
   * player is really watching. That was already true when both sides ran on
   * HITS_TO_LOSE; it is load-bearing now that the player's side does not, and
   * it is why `buildSide` takes a number and why the player's strip is REBUILT
   * on every `open` rather than once at wiring time.
   *
   * There used to be a ROUNDS figure beside them, and it went with the locker
   * it counted. A readout that never moves teaches the player to stop looking
   * at the strip, which is where the hits and the foe's fuse live.
   */
  interface Side {
    pips: readonly HTMLElement[];
    /** Last painted, so an unchanged frame touches no DOM at all. */
    hits: number;
  }

  /**
   * (Re)fills `side` with `count` pips, and only when the count has moved.
   *
   * The guard is what keeps this off the per-frame path and off the ordinary
   * fight: a player whose hull has not crossed a band since the last raider
   * gets the same three elements back, and `replaceChildren` is not called at
   * all. `hits` goes to -1 whenever the strip is rebuilt, because the fresh
   * pips are unlit and the cache would otherwise claim they were painted.
   */
  function fillSide(side: Side, host: HTMLElement, count: number): void {
    if (side.pips.length === count) return;
    const pips: HTMLElement[] = [];
    for (let i = 0; i < count; i++) {
      const pip = document.createElement('span');
      pip.className = 'bside__pip';
      pips.push(pip);
    }
    host.replaceChildren(...pips);
    side.pips = pips;
    side.hits = -1;
  }

  function buildSide(pipHost: HTMLElement, count: number): Side {
    const side: Side = { pips: [], hits: -1 };
    fillSide(side, pipHost, count);
    return side;
  }

  const youPips: HTMLElement = youPipsEl;
  // The player's opening strip is the unmodified three, and every `open`
  // resets it to whatever that fight's hull allows.
  const youSide = buildSide(youPips, HITS_TO_LOSE);
  // The foe's is built once and never rebuilt: the raider has no hull of its
  // own by design (docs/HARBOURS_PLAN.md, Out of scope), so its threshold is
  // the constant and cannot move.
  const foeSide = buildSide(foePipsEl, HITS_TO_LOSE);

  /** Whether the prompt is currently down. Null until the first paint. */
  let lastPromptHidden: boolean | null = null;

  /**
   * Whether the player has fired at all this fight. Reset by `open`.
   *
   * The prompt used to read a spent round off the sim for this, and with the
   * locker gone there is nothing on `BattleState` that says "this player has
   * pressed the key at least once". So it is latched here, in `input`, which
   * is the one place that knows a press actually became a shot.
   */
  let hasFired = false;

  /**
   * The fuse bar's own write-through cache.
   *
   * `fuseSpan` is the length the CURRENT commit was lit at, learned rather
   * than imported: `AI_FUSE` belongs to `battleai.ts`, a file this module
   * does not import, and the plan's own rule is "read `state.fuse` and
   * nothing else". The tick `state.fuse` turns from null into a number IS
   * that number's own top -- a fuse only ever counts down -- so the first
   * live reading after a null is banked as the span and every later percentage
   * is read off it. `lastPct` and `lastHidden` are the diff caches every other
   * paint in this file keeps; `null` on both means "never painted", which
   * forces the first `update()` after `open()` to write regardless of what it
   * finds.
   */
  let fuseSpan: number | null = null;
  let lastFusePct = -1;
  let lastFuseHidden: boolean | null = null;

  /** The FOULED word's own diff cache. Null until the first paint. */
  let lastFouledHidden: boolean | null = null;

  /** The colour class on the root, so it can be taken off again on close. */
  let kindClass = '';

  function paintSide(side: Side, hits: number): void {
    if (hits !== side.hits) {
      side.hits = hits;
      for (let i = 0; i < side.pips.length; i++) {
        side.pips[i].classList.toggle('bside__pip--hit', i < hits);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  function tap(): void {
    // Dead once the card is up. The arena keeps circling under it, so the
    // guns would otherwise still answer a Space aimed at the CONTINUE button.
    if (!open || decided) return;
    pressed = true;
  }

  function onFirePointer(ev: PointerEvent): void {
    // The same swallow the fishing canvas makes: on a phone this key is
    // pressed once a second for a minute, and every one of those presses is a
    // candidate for a text selection or a double-tap zoom.
    ev.preventDefault();
    tap();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (!open) return;

    /*
     * Escape is deliberately not handled.
     *
     * Every other overlay in the project leaves on it, and this one must not:
     * a fight the player can dismiss is a fight with no stake in it, and the
     * gold and the power on the line here are exactly the stake. It is left
     * unswallowed rather than swallowed-and-ignored so a future global
     * shortcut is not silently eaten by a battle.
     */

    if (ev.code !== 'Space' && ev.key !== ' ') return;

    // A focused button keeps its own Space, so FIRE and CONTINUE both work
    // from the keyboard like buttons. This is also what gives the card its
    // Enter/Space close for free: CONTINUE takes the focus when it appears,
    // and the browser turns both keys into a click on it.
    if (ev.target instanceof HTMLButtonElement) return;

    // Before the repeat test, not after: a held Space must not scroll the
    // page on the sixty auto-repeats about to be thrown away either.
    ev.preventDefault();
    if (ev.repeat) return;
    tap();
  }

  function onContinueClick(): void {
    if (!open) return;
    deps.onContinue();
  }

  let listening = false;

  function attach(): void {
    if (listening) return;
    listening = true;
    fire.addEventListener('pointerdown', onFirePointer);
    window.addEventListener('keydown', onKeyDown);
    continueBtn.addEventListener('click', onContinueClick);
  }

  function detach(): void {
    if (!listening) return;
    listening = false;
    fire.removeEventListener('pointerdown', onFirePointer);
    window.removeEventListener('keydown', onKeyDown);
    continueBtn.removeEventListener('click', onContinueClick);
  }

  /* ---------------------------------------------------------------- */
  /* Surface                                                           */
  /* ---------------------------------------------------------------- */

  function openOverlay(kind: AiBoatKind, playerHitsToLose: number = HITS_TO_LOSE): void {
    if (open) return;
    open = true;
    decided = false;
    pressed = false;

    // Before anything else on the strip: this fight's pips are the hull's
    // number, and the caches below are reset on the assumption the strip they
    // describe is the one that is about to be painted.
    fillSide(youSide, youPips, playerHitsToLose);

    // The raider's own colour, carried on the root so one class paints the
    // FOE side of the strip, the card's rule and the FIRE key's glow together.
    // `style.css` owns everything that follows from it, the same split the
    // HUD's `.pwr` and `.wnd` rows use.
    kindClass = kind === 'red' ? 'battle--red' : 'battle--orange';
    overlay.classList.add(kindClass);

    card.hidden = true;
    fire.hidden = false;
    prompt.hidden = false;
    lastPromptHidden = false;
    // A fresh fight repaints both sides from scratch: the caches are holding
    // the last fight's figures and the pips are still lit from it.
    hasFired = false;
    youSide.hits = -1;
    foeSide.hits = -1;
    // The fuse and the FOULED word both ship hidden, and both diff caches go
    // back to "never painted" so the first frame of the new fight repaints
    // them regardless of whether they happen to match a stale value.
    fuse.hidden = true;
    fuseFill.style.width = '0%';
    fuseSpan = null;
    lastFusePct = -1;
    lastFuseHidden = null;
    fouled.hidden = true;
    lastFouledHidden = null;
    overlay.hidden = false;
    overlay.removeAttribute('aria-hidden');
    attach();
  }

  function close(): void {
    if (!open) return;
    open = false;
    decided = false;
    pressed = false;
    detach();
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    if (kindClass) overlay.classList.remove(kindClass);
    kindClass = '';
    card.hidden = true;
    hitFlash.classList.remove('battle__hit--on');
  }

  function input(raw: InputState): BattleInput {
    const fired = pressed;
    pressed = false;
    if (fired) hasFired = true;
    // W and S straight off the shared `InputState`, which is what makes the
    // D-pad's up and down keys work in the arena without this file knowing
    // the pad exists. There is no helm here, so `left` and `right` are simply
    // not read.
    return { fire: fired, faster: raw.forward, slower: raw.backward };
  }

  function update(state: BattleState): void {
    if (!open) return;

    paintSide(youSide, state.player.hits);
    paintSide(foeSide, state.ai.hits);

    // The prompt goes as soon as the player has fired once, and never comes
    // back. It is instructions, and instructions that stay up past the moment
    // they were understood are clutter over the one thing being aimed at.
    // `hasFired` is the reading, because it is the one thing that can only
    // have happened by the player pressing the key the prompt names.
    const hide = hasFired;
    if (hide !== lastPromptHidden) {
      lastPromptHidden = hide;
      prompt.hidden = hide;
    }

    /*
     * The fuse bar. Hidden while `state.fuse` is null; while it is live, a
     * bar draining in the FOE's own colour, on `--foe`, the same custom
     * property the rest of that side of the strip already reads -- there is
     * no hue of this element's own to keep in step with `battle--red` versus
     * `battle--orange`.
     *
     * `fuseSpan` is what turns a raw second count into a percentage: see the
     * comment on its declaration for why it is learned rather than imported.
     * The width is written in whole percent so a `dt` that jitters by a
     * fraction of a millisecond does not turn into a fraction-of-a-pixel
     * style write sixty times a second; `lastFusePct` is the diff that skips
     * the write entirely when the rounded value has not moved.
     */
    const fuseHidden = state.fuse === null;
    if (fuseHidden !== lastFuseHidden) {
      lastFuseHidden = fuseHidden;
      fuse.hidden = fuseHidden;
      if (fuseHidden) fuseSpan = null;
    }
    if (!fuseHidden && state.fuse !== null) {
      // The tick a null becomes a number, that number IS the span: a fuse
      // only ever counts down from the moment it is lit.
      if (fuseSpan === null) fuseSpan = state.fuse;
      const pct = fuseSpan > 0 ? Math.round((state.fuse / fuseSpan) * 100) : 0;
      if (pct !== lastFusePct) {
        lastFusePct = pct;
        fuseFill.style.width = pct + '%';
      }
    }

    // The FOULED word, over the player's side, gone the instant the sim clears
    // it. One word because it has to explain, on its own, why the helm has
    // gone sluggish and the FIRE key has gone quiet -- nothing else on this
    // overlay says either.
    const fouledHidden = state.player.fouled <= 0;
    if (fouledHidden !== lastFouledHidden) {
      lastFouledHidden = fouledHidden;
      fouled.hidden = fouledHidden;
    }

    /*
     * A ball on own hull, felt at the edge of the frame; the enemy's shot
     * lighting, felt on the fuse bar.
     *
     * `owner` is who FIRED, so the AI's hits are the player's and the AI's own
     * `aim` is what lights its fuse. Both flashes are a CSS animation
     * restarted by taking the class off, forcing a reflow and putting it back:
     * that is the whole timer, and it means this file holds no clock of its
     * own for an effect that has to be able to fire twice in a second.
     * `state.events` is THIS TICK's only, rebuilt by `battle.ts` every update,
     * so there is nothing here to remember or to clear. The two flags let one
     * pass over the list catch both events without either one's `break`
     * starving the other.
     */
    let hitSeen = false;
    let aimSeen = false;
    for (const event of state.events) {
      if (!hitSeen && event.kind === 'hit' && event.owner === 'ai') {
        hitSeen = true;
        hitFlash.classList.remove('battle__hit--on');
        // Reading a layout property is what commits the removal, so the class
        // going back on starts a new animation instead of continuing the old
        // one. Deleting this line makes a second hit inside one animation do
        // nothing at all, silently.
        void hitFlash.offsetWidth;
        hitFlash.classList.add('battle__hit--on');
      } else if (!aimSeen && event.kind === 'aim' && event.owner === 'ai') {
        aimSeen = true;
        fuse.classList.remove('bfuse--lit');
        void fuse.offsetWidth;
        fuse.classList.add('bfuse--lit');
      }
      if (hitSeen && aimSeen) break;
    }
  }

  function result(res: BattleResult): void {
    if (!open) return;
    decided = true;
    pressed = false;

    title.textContent = TITLES[res.outcome];

    // Signed, and spelled with the sign, because the draw is the one outcome
    // where the direction is not implied by the headline: a STAND-OFF can pay
    // or charge, and "1 200 gold" under it would be unreadable either way.
    const amount = formatGold(res.gold);
    goldLine.textContent =
      res.gold > 0 ? '+' + amount + ' GOLD' : res.gold < 0 ? '-' + amount + ' GOLD' : 'NO GOLD LOST';
    goldLine.classList.toggle('battle__gold--down', res.gold < 0);

    /*
     * What the fight cost the hull, under the gold and above the power.
     *
     * Always negative in the wording, because there is no outcome that mends
     * a hull: a win costs 5 and a defeat 15, and the card's job is to say
     * that the price of winning was still a price. Rounded, since `main.ts`
     * hands over whole percent and a float would be a rounding error printed
     * as a repair bill.
     *
     * Hidden at 0 or absent. See `BattleResult.hull`: a hull already on its
     * floor loses nothing, and a line claiming otherwise would be the one
     * kind of lie this card is written to never tell.
     */
    const hullCost = Math.round(res.hull ?? 0);
    if (hullCost > 0) {
      hullLine.textContent = 'HULL -' + hullCost + '%';
      hullLine.hidden = false;
    } else {
      hullLine.hidden = true;
    }

    /*
     * The power line, and only on the two outcomes that cost power.
     *
     * The cell's figure is read off the plant AFTER the defeat rather than
     * printed from DEFEAT_KEEP, so what the card claims is what the bar
     * beneath it will show. The stand-off's is the constant, because there is
     * nothing to read: it is a fixed number of points off a bar whose new
     * value says nothing about what was charged.
     */
    if (res.outcome === 'loss') {
      const cell = Math.round(res.reserve * 100);
      powerLine.textContent =
        cell > 0 ? 'MAIN TANK DRAINED · BACKUP CELL ' + cell + '%' : 'MAIN TANK AND BACKUP DRAINED';
      powerLine.hidden = false;
    } else if (res.outcome === 'draw') {
      powerLine.textContent = 'MAIN TANK -' + Math.round(STALEMATE_COST * 100) + '%';
      powerLine.hidden = false;
    } else {
      powerLine.hidden = true;
    }

    prompt.hidden = true;
    lastPromptHidden = true;
    // The key goes with the fight. `tap` already refuses once `decided` is
    // set, so this is not the lock; it is the affordance agreeing with it,
    // which is the rule `hud.ts` keeps about `[FISH]`.
    fire.hidden = true;
    card.hidden = false;
    // The card is the only part of this overlay that takes a keystroke of its
    // own, so it takes the focus: that is what turns Enter and Space into a
    // CONTINUE without this file binding either key.
    continueBtn.focus();
  }

  return {
    get isOpen(): boolean {
      return open;
    },
    open: openOverlay,
    close,
    input,
    update,
    result,
  };
}
