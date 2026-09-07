/**
 * blackout.ts — the fade the world is teleported behind.
 *
 * A maelstrom ends with the hull somewhere else entirely, and a cut straight
 * to that would read as a bug rather than as a shipwreck. So: fade to black,
 * move the ship while nothing can be seen, fade back up.
 *
 * It owns one element and one promise — that `onBlack` is called when the
 * screen is ACTUALLY opaque, not merely on its way there. Everything else in
 * this file exists to keep that promise on a tab the browser has throttled.
 */

export interface Blackout {
  /**
   * Fades to black, calls `onBlack` once the screen is fully covered, holds,
   * and fades back. Re-entrant calls while `active` are ignored: a second
   * wreck cannot start inside the first one's fade.
   */
  run(onBlack: () => void): void;
  /** True from the first frame of the fade until the last frame of the recovery. */
  readonly active: boolean;
}

/* ------------------------------------------------------------------ */
/* Timing                                                              */
/* ------------------------------------------------------------------ */

/*
 * The three durations, in seconds, and they are written TWICE: here, and as
 * the two `transition` durations in style.css's BLACKOUT block. The CSS is
 * what actually animates; these are what this file waits out. If the pair
 * disagree the failure is quiet in both directions — a JS timer shorter than
 * the CSS teleports the ship in front of the player, a longer one leaves the
 * screen black past the end of its own fade — so change them together.
 */

/**
 * Down to black. Fast enough that a player who has just lost the helm is not
 * left watching an empty sea, slow enough to read as a fade rather than a cut.
 */
const FADE_IN = 0.7;

/**
 * Black, with nothing happening. The teleport, the camera snap and the reset
 * all land inside the first millisecond of it; the rest is a beat for the
 * player to register that something ended, without which the fade-out starts
 * before the fade-in has finished being understood.
 */
const HOLD = 0.4;

/**
 * Back up. Deliberately the longest of the three: the fade in is a loss and
 * wants to be over, the fade out is a new place and wants to be looked at.
 */
const FADE_OUT = 1.0;

/**
 * How long past a phase's own duration the timer fallback waits, ms.
 *
 * The fallback exists because a throttled or backgrounded tab may never fire
 * `transitionend` at all, and a screen stuck black is the one failure in this
 * file with no way out. The margin is what keeps it a FALLBACK: it has to lose
 * to the event on every normal frame, or the timer becomes the mechanism and
 * the fade is cut short by however late the compositor started it.
 */
const FALLBACK_MARGIN_MS = 150;

/** The class that raises the sheet. `style.css` owns what it looks like. */
const UP_CLASS = 'blackout--up';

/**
 * Builds the fade against `#blackout`.
 *
 * Returns a working no-op if the element is missing, exactly like the writers
 * in `hud.ts` and `radar.ts`: a UI element that is not in the document must
 * never take the frame loop down with it. "Working" is load-bearing here and
 * is why this is not simply an empty function — `onBlack` is what puts the
 * ship back on the water, so a no-op that skipped it would leave the player
 * spiralling in a funnel forever. Without the sheet the wreck is a hard cut,
 * which is ugly and is still a game.
 */
export function createBlackout(): Blackout {
  const element = document.getElementById('blackout');
  if (!(element instanceof HTMLElement)) {
    return {
      run(onBlack: () => void): void {
        onBlack();
      },
      get active(): boolean {
        return false;
      },
    };
  }
  const sheet: HTMLElement = element;

  let active = false;
  /** The pending fallback or hold timer. The phases never overlap, so one is enough. */
  let timer = 0;

  /**
   * Waits out one phase of `seconds`, whichever of the transition's own end
   * or the fallback timer arrives first, and calls `done` exactly once.
   *
   * The event is filtered on both the target and the property: a transition on
   * anything inside the sheet, or on any property other than opacity, would
   * otherwise end the phase early. Nothing is nested in it today; the filter
   * is there so that adding something later cannot break the teleport.
   */
  function settle(seconds: number, done: () => void): void {
    let fired = false;

    const finish = (): void => {
      if (fired) return;
      fired = true;
      sheet.removeEventListener('transitionend', onTransition);
      window.clearTimeout(timer);
      done();
    };

    const onTransition = (event: TransitionEvent): void => {
      if (event.target !== sheet || event.propertyName !== 'opacity') return;
      finish();
    };

    sheet.addEventListener('transitionend', onTransition);
    timer = window.setTimeout(finish, seconds * 1000 + FALLBACK_MARGIN_MS);
  }

  function run(onBlack: () => void): void {
    // A wreck inside a wreck. `hazards.ts` cannot capture a hull it is already
    // driving, so this should not happen -- which is exactly why it is refused
    // rather than queued: a second fade starting mid-first would move the ship
    // twice and recover the screen once.
    if (active) return;
    active = true;

    sheet.classList.add(UP_CLASS);

    settle(FADE_IN, () => {
      // Opaque. This is the whole promise of the module, and the only moment
      // in the game the world may be rearranged without the player seeing it.
      try {
        onBlack();
      } catch (error) {
        // The screen comes back either way. A handler that threw has left the
        // world in some unknown state, and a player looking at that state can
        // at least sail out of it; a player looking at a black rectangle
        // cannot do anything at all.
        console.error('blackout: the onBlack handler threw; recovering the screen anyway', error);
      }

      timer = window.setTimeout(() => {
        sheet.classList.remove(UP_CLASS);
        settle(FADE_OUT, () => {
          active = false;
        });
      }, HOLD * 1000);
    });
  }

  return {
    run,
    get active(): boolean {
      return active;
    },
  };
}
