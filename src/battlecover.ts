import { FIRE_COOLDOWN, HITS_TO_LOSE } from './battle';
import type { AiBoatKind } from './types';

/**
 * battlecover.ts — the card a fight is declared on, and the count into it.
 *
 * A ram used to go straight to the fade: contact, black, arena, guns. That is
 * the correct shape for the END of a fight and the wrong one for the start of
 * it, because the player arrives in the arena already being shot at by a set
 * of rules they have never been told. Three hits, no helm and a gun that
 * fires out of the beam on its own cooldown are all learnable in one sentence
 * and none of them are guessable from the scene.
 *
 * So: one plate of art, one sentence, and three seconds to read it.
 *
 * This is deliberately NOT the exception `battleui.ts` documents. That file's
 * "nothing here hides the scene" is a rule about the fight itself — a result
 * card over a live arena, because a fight that froze would read as the game
 * stopping. This screen is not the fight. It is the beat before it, on the
 * near side of the fade, over a world that has already been halted by the
 * ram, and it is a card over a frozen scene exactly as `fishcover.ts` is.
 *
 * It owns no rules and reads no state. `main.ts` hands it one callback and it
 * calls it when the count runs out; what a fight is and how to enter one is
 * somebody else's business.
 */

/**
 * Seconds on the clock, and the whole reason this screen exists.
 *
 * Three rather than two, and rather than a keypress. Two is not long enough to
 * read the sentence, and a DISMISS button would make the beat optional — which
 * for the one player who most needs it, the one meeting a raider for the first
 * time, is the player most likely to hammer past it. It is short enough that a
 * veteran on their fortieth fight is not being held up: three seconds against
 * a fight that runs up to two minutes.
 *
 * Counted on the WALL CLOCK, not on the frame loop's dt, and that distinction
 * is the whole of `MAX_TICK` below. Three seconds here means three seconds to
 * the player holding the mouse; it does not mean thirty frames.
 */
export const COUNTDOWN = 3;

/**
 * The most one tick may take off the clock, seconds.
 *
 * This screen counts real elapsed time rather than the frame loop's `dt`,
 * because `dt` is capped at 100 ms and a cap is exactly wrong for a number the
 * player is reading as seconds: on a machine rendering the frozen world at
 * 4 fps -- which is what the software renderer in the smoke tier does -- a
 * 100 ms cap advances the count 0.4 s per real second and the three-second
 * beat becomes seven and a half. The slower the machine, the longer the game
 * would hold the player in front of a card they have already read.
 *
 * The clamp is what keeps the other failure from coming back with it. Raw
 * elapsed time would let a tab backgrounded across the count resume with the
 * whole beat already spent, dropping the player straight into a fight they
 * never saw declared. Half a second is comfortably longer than any frame a
 * machine that is actually rendering will take, and short enough that a tab
 * gone for a minute comes back having lost half a second of its three.
 */
const MAX_TICK = 0.5;

export interface BattleCoverDeps {
  /**
   * The count has run out. `main.ts` opens the fight and fades into the arena.
   *
   * Fired exactly once per `open`, from inside `update`, so it lands on a
   * frame boundary like every other state change in the project.
   */
  readonly onReady: () => void;
}

export interface BattleCover {
  /**
   * True from `open()` until `close()`, and read by `main.ts` every frame to
   * decide whether the world is frozen — the pause contract's terms, the same
   * ones `fishCover.isOpen` is on. A live getter, never a latched flag.
   */
  readonly isOpen: boolean;
  /**
   * Raises the card for a fight against `kind`.
   *
   * `playerHitsToLose` is `hull.state.hitsToLose`, sampled by `main.ts` at
   * CONTACT and handed to this screen and to `createBattleSim` from that one
   * read, so the number the card teaches and the number the sim enforces
   * cannot be two different figures. Defaulted to `HITS_TO_LOSE`, which is
   * the fight exactly as it was before hulls existed.
   */
  open(kind: AiBoatKind, playerHitsToLose?: number): void;
  close(): void;
  /**
   * Advances the count. Called once a frame while open.
   *
   * Takes no dt on purpose: it reads the wall clock itself, for the reason
   * `MAX_TICK` gives. A caller passing its own `dt` in here would be handing
   * over the very number this screen exists to not use.
   */
  update(): void;
  dispose(): void;
}

/**
 * The foe's hue, as a class, mirroring `.battle--red` / `.battle--orange`.
 *
 * The card is tinted by which raider rammed you for the same reason the strip
 * and the result card are: red and orange are the one thing the player has
 * been reading off the scope all game, and the screen that names the fight
 * should not be the first place that colour stops meaning anything.
 */
const KIND_CLASS: Record<AiBoatKind, string> = {
  red: 'battlecover--red',
  orange: 'battlecover--orange',
};

/** "RED RAIDER" / "ORANGE RAIDER" — who it is, in the foe's own colour. */
const KIND_LABEL: Record<AiBoatKind, string> = {
  red: 'RED RAIDER',
  orange: 'ORANGE RAIDER',
};

/**
 * The rules, off the constants that actually enforce them.
 *
 * Written from `FIRE_COOLDOWN` and `HITS_TO_LOSE` rather than typed into the
 * markup, on the house rule index.html states for every other figure in an
 * overlay: a number spelled out in HTML is a number that goes stale the first
 * time the fight is retuned, and a screen whose whole job is to teach the
 * rules is the worst possible place to advertise the old ones.
 *
 * The rate is stated as shots per second rather than as the cooldown itself,
 * because a third of a second is not a figure anyone holds in their head
 * while aiming; "three a second" is. It is derived and rounded rather than
 * written, so retuning the gun moves the sentence with it.
 *
 * The sentence about the sea is deliberately NOT built from a constant the
 * same way. `battlesea.ts`'s numbers — how far a crest shoves, how long a
 * foul lasts — are arena units nobody reading this card has a feel for yet,
 * unlike the rate and the hit count, which the player is about to watch on
 * the strip a second later. Naming one here would teach a figure instead of
 * the fact the player actually needs before the first shot: the ring shoves
 * you off its mark, and the water can eat a ball meant for the enemy.
 *
 * The hit count is now the PLAYER'S, off their hull, and it is the reason
 * this is rebuilt on every `open` instead of written once at build time. A
 * player who takes a fight at 20% has one hit to give and the card is the
 * only place in the game they can be told so before the first ball is in the
 * air — the strip's pips say it too, but by then they are being shot at.
 * The singular is spelled out rather than tolerated ("1 hits lose it") for
 * the same reason every other figure here is derived: the one sentence whose
 * whole job is to teach the rules cannot be the sentence that reads as
 * broken.
 */
function blurbText(playerHitsToLose: number): string {
  const perSecond = Math.round(1 / FIRE_COOLDOWN);
  const n = playerHitsToLose;
  return (
    `Unlimited rounds, up to ${perSecond} a second, fired straight out of the ` +
    `inboard beam. ${n} hit${n === 1 ? '' : 's'} lose${n === 1 ? 's' : ''} it. ` +
    `W and S are your place on the ring — there is no helm in a fight. The ` +
    `sea will shove you off it, and the wreckage adrift in it will eat a shot ` +
    `meant for the enemy.`
  );
}

export function createBattleCover(deps: BattleCoverDeps): BattleCover {
  const root = document.getElementById('battlecover');
  const foeEl = document.getElementById('battlecover-foe');
  const blurbEl = document.getElementById('battlecover-blurb');
  const countEl = document.getElementById('battlecover-count');

  if (root === null) {
    /*
     * The same contract every other overlay keeps, and it matters more here
     * than anywhere else in the project: this screen sits between a ram and a
     * fight, so a no-op that failed to call `onReady` would strand the player
     * halted in front of a raider forever. The fallback therefore still fires
     * — on the next `update`, with no card and no count. A ram with no beat
     * in front of it is the game as it shipped in v0.8.0, which is ugly here
     * and is still a game.
     */
    let pending = false;
    return {
      get isOpen(): boolean {
        return pending;
      },
      open(): void {
        pending = true;
      },
      close(): void {
        pending = false;
      },
      update(): void {
        if (!pending) return;
        pending = false;
        deps.onReady();
      },
      dispose(): void {
        pending = false;
      },
    };
  }

  const overlay: HTMLElement = root;

  /**
   * The hit count the blurb was last written with, so the sentence is rebuilt
   * only when it would actually read differently.
   *
   * It used to be written once at build, when it could not change between
   * fights. It can now: it is the player's threshold and it moves with the
   * hull. This is the same write-through cache every paint in the overlays
   * keeps, and `-1` is "never written", which forces the first `open` to do
   * the work whatever it finds.
   */
  let blurbHits = -1;

  let open = false;
  /** Seconds left. Only meaningful while `open`. */
  let remaining = COUNTDOWN;
  /** `performance.now()` at the previous tick, ms. The wall clock this screen keeps. */
  let lastTick = 0;
  /** The digit currently painted, so the DOM is touched three times, not 180. */
  let shown = -1;
  /** `onReady` is fired once per fight, and this is what makes that true. */
  let fired = false;
  /** The kind class on the root, kept so `close` removes exactly what it added. */
  let kindClass: string | null = null;

  /**
   * Paints the digit, and only when it changes.
   *
   * Floored at 1 rather than allowed to reach 0: the count is a countdown TO
   * the fight, and a 0 on screen would be a frame of "no time left" that the
   * fade has not yet covered. The card goes out on 1, which is what the fade
   * is for.
   */
  function paint(): void {
    if (countEl === null) return;
    const next = Math.max(1, Math.ceil(remaining));
    if (next === shown) return;
    shown = next;
    countEl.textContent = String(next);
    /*
     * Restarted by hand on every digit. A CSS animation on a class that is
     * already present does not replay, and the three ticks are the same
     * animation three times: drop the class, force a reflow, put it back.
     * This is the `.battle__hit` problem and it is solved the same way, minus
     * the two-name trick, because there is only ever one animation here.
     */
    countEl.classList.remove('battlecover__count--tick');
    void countEl.offsetWidth;
    countEl.classList.add('battlecover__count--tick');
  }

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    overlay.hidden = !next;
    overlay.setAttribute('aria-hidden', next ? 'false' : 'true');
  }

  return {
    get isOpen(): boolean {
      return open;
    },

    open(kind: AiBoatKind, playerHitsToLose: number = HITS_TO_LOSE): void {
      if (open) return;
      remaining = COUNTDOWN;
      lastTick = performance.now();
      shown = -1;
      fired = false;
      if (blurbEl !== null && playerHitsToLose !== blurbHits) {
        blurbHits = playerHitsToLose;
        blurbEl.textContent = blurbText(playerHitsToLose);
      }
      if (foeEl !== null) foeEl.textContent = KIND_LABEL[kind];
      if (kindClass !== null) overlay.classList.remove(kindClass);
      kindClass = KIND_CLASS[kind];
      overlay.classList.add(kindClass);
      // Before the card is raised, so the first frame the player sees already
      // says 3 rather than whatever the last fight ended on.
      paint();
      setOpen(true);
    },

    close(): void {
      setOpen(false);
    },

    /**
     * One tick of the count.
     *
     * `fired` rather than `close()` at zero, deliberately: the card stays up
     * through the fade that follows and is taken down by `main.ts` from inside
     * `onBlack`, on an opaque screen. Closing here would pop the art off in
     * front of a player who is still looking at it, half a second before the
     * arena arrives — the same mistake the HUD's `body.in-battle` class exists
     * to avoid.
     */
    update(): void {
      if (!open || fired) return;
      const now = performance.now();
      // Clamped, never trusted raw. See MAX_TICK.
      remaining -= Math.min((now - lastTick) / 1000, MAX_TICK);
      lastTick = now;
      paint();
      if (remaining > 0) return;
      fired = true;
      deps.onReady();
    },

    dispose(): void {
      setOpen(false);
      if (kindClass !== null) overlay.classList.remove(kindClass);
      kindClass = null;
    },
  };
}
