import type { HuntState } from './types';
import { HUNT_TARGETS, SOUND_BELOW, damageAt } from './leviathan';

/**
 * leviathandial.ts: the hunt's one piece of interface.
 *
 * A bar with a needle sweeping across it, and a strip above saying how many
 * targets are left and what has been banked. It reads `HuntState` and decides
 * nothing, the same division `hud.ts` keeps with `energy.ts`.
 *
 * ## DOM, not canvas
 *
 * `radar.ts` and `fishrender.ts` are already two per-frame 2D contexts and
 * neither of them is drawing a straight line. This is a `<div>` with a CSS
 * gradient for the bands and a needle moved by `transform: translateX()`,
 * which is compositor-only: no layout, no paint, no third context, and it
 * matches `hud.ts`'s write-through style where the element is touched only on
 * change.
 *
 * ## Why it is not under the shadow
 *
 * Nothing in `src/` projects world space to screen space, so an anchored bar
 * means a projection and anchor system built from scratch, and one that every
 * future overlay would then want, so it belongs in its own module rather than
 * arriving inside a hunt. It is also arguably the better place: a fixed bar can
 * be read without taking the eye off the water being steered through, which is
 * the thing the player is actually doing. docs/LEVIATHAN_PLAN.md stages the
 * anchored version as Phase 2.
 *
 * ## It owns Space, and only while it is lit
 *
 * Space already means make-fast inside a berth ring, fire in a fishing session
 * and broadside in a battle. This module binds it too, and the binding is live
 * only while `state.armed` is true, which `leviathan.ts` holds false while
 * docked, while suppressed, and while the marked shadow is outside the bow's
 * arc. That is the same discipline **One owner for the Escape key** in
 * docs/ARCHITECTURE.md keeps: the key belongs to whatever is currently showing
 * the affordance for it.
 *
 * It is NOT sufficient on its own, and that is worth knowing before trusting
 * it. `update` runs on the sailing branch only, so an overlay freezes this bar
 * without clearing `armed`, and a Space meant for the fishing card would reach
 * `onFire` too. `main.ts`'s `fireHarpoon` carries the rest of the guard.
 */

/** Element ids, all inside the `<!-- HUNT -->` block in `index.html`. */
const ROOT_ID = 'hud-hunt';
const NEEDLE_ID = 'hud-hunt-needle';
const TARGETS_ID = 'hud-hunt-targets';
const BANKED_ID = 'hud-hunt-banked';
const HINT_ID = 'hud-hunt-hint';

/**
 * How the needle's [-1, 1] maps onto the bar, as a percentage of the BAR's
 * width.
 *
 * Fifty plus fifty, so -1 is the left edge, 0 the middle and +1 the right.
 *
 * It is the bar's width and not the needle's, and that distinction is the
 * whole reason `.hunt__needle` is a full-width box with the line drawn as its
 * ::before: a percentage translate resolves against the translated element's
 * own width, so a 2px needle told to move 50% would move one pixel. See the
 * rule's comment in `style.css` before changing either half.
 */
function needlePercent(dial: number): number {
  const p = dial < -1 ? -1 : dial > 1 ? 1 : dial;
  return 50 + p * 50;
}

export interface HuntDial {
  /** Every frame of the sailing branch, after `leviathan.update`. */
  update(state: HuntState): void;
  /** Whether the bar is on screen. A live getter, on the pause contract's terms. */
  readonly visible: boolean;
  dispose(): void;
}

export interface HuntDialDeps {
  /**
   * The press. Called on Space, and only while the dial is armed.
   *
   * Wired to `leviathan.fire()`. This module does not know what a harpoon is
   * and never reads the locker: it reports a keystroke and the sim decides
   * whether it was worth anything.
   */
  onFire: () => void;
}

export function createHuntDial(deps: HuntDialDeps): HuntDial {
  const root = document.getElementById(ROOT_ID);
  const needle = document.getElementById(NEEDLE_ID);
  const targets = document.getElementById(TARGETS_ID);
  const banked = document.getElementById(BANKED_ID);
  const hint = document.getElementById(HINT_ID);

  if (root === null || needle === null || targets === null || banked === null || hint === null) {
    /*
     * The contract every view in this project keeps: a thing that is not in
     * the document must not take the frame loop down with it.
     *
     * Harmless here in the way `toast.ts` says it is harmless there (the sim
     * still drifts, still arms, still pays), with one real consequence worth
     * naming: without the element there is no Space binding either, so a hunt
     * simply cannot be fired. That is the correct failure. Binding a key with
     * nothing on screen to explain it would be worse.
     */
    return {
      update: (): void => undefined,
      get visible(): boolean {
        return false;
      },
      dispose: (): void => undefined,
    };
  }

  const bar: HTMLElement = root;
  const pin: HTMLElement = needle;
  const targetsOut: HTMLElement = targets;
  const bankedOut: HTMLElement = banked;
  const hintOut: HTMLElement = hint;

  /* Write-through caches, on `hud.ts`'s terms: the DOM is touched on change. */
  let lastShown = false;
  let lastArmed: boolean | null = null;
  let lastPercent = -1;
  let lastTargets = '';
  let lastBanked = '';
  let lastHint = '';

  /** Live, and read by the key handler rather than latched. */
  let armed = false;

  function write(el: HTMLElement, text: string, cache: string): string {
    if (text === cache) return cache;
    el.textContent = text;
    return text;
  }

  /*
   * The key.
   *
   * Bound for the life of the run rather than added and removed as the dial
   * arms: a listener that came and went sixty times a minute would be the one
   * place in this HUD where a keystroke's fate depended on which side of a
   * frame boundary it landed. The guard is the live `armed` flag instead, read
   * at the moment of the press, which is the same reason the pause contract is
   * derived rather than latched.
   *
   * `preventDefault` only once the key is known to be ours, so a Space aimed
   * at a focused button still presses it. `repeat` is refused because one
   * press is one harpoon and an OS key-repeat would empty the locker in a
   * second.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (!armed) return;
    if (event.repeat) return;
    event.preventDefault();
    deps.onFire();
  }

  window.addEventListener('keydown', onKeyDown);

  return {
    update(state: HuntState): void {
      /*
       * Shown whenever a shoal is on the water, armed or not.
       *
       * A bar that only appeared at the moment of the press would give the
       * player no way to learn what arms it: the dark bar with its hint line
       * IS the teaching, and it is the only place the range-and-arc rule is
       * ever stated.
       */
      const shown = state.phase === 'drifting';
      armed = shown && state.armed;

      if (shown !== lastShown) {
        lastShown = shown;
        bar.hidden = !shown;
      }
      if (!shown) return;

      if (armed !== lastArmed) {
        lastArmed = armed;
        bar.classList.toggle('hunt--armed', armed);
      }

      // Rounded to whole percent: the bar is a few hundred pixels wide, so
      // anything finer is a style write nobody can see. This is what keeps a
      // 60 Hz sweep down to one write per frame at most.
      const percent = armed ? Math.round(needlePercent(state.dial)) : 50;
      if (percent !== lastPercent) {
        lastPercent = percent;
        pin.style.transform = `translateX(${percent}%)`;
      }

      const left = HUNT_TARGETS - state.target;
      lastTargets = write(targetsOut, `${left} LEFT`, lastTargets);
      lastBanked = write(bankedOut, `${state.banked} DMG`, lastBanked);

      /*
       * The hint, which is the whole of the feature's onboarding.
       *
       * Three states and they are the three reasons the dial can be dark, in
       * the order a player meets them. The armed line prints what the press
       * is worth RIGHT NOW rather than a static instruction, because a live
       * number is the fastest way to learn that the middle is worth more, and
       * it is also the honest readout: it is exactly what `fire` would bank.
       */
      const hintText = armed
        ? `${damageAt(state.dial)}`
        : state.banked > 0
          ? 'BRING IT UNDER THE BOW'
          : 'STEER ONTO THE MARK';
      lastHint = write(hintOut, hintText, lastHint);
      // Under the sound threshold the live number is a warning and not a
      // score, and it says so in the colour before it says so in the purse.
      hintOut.classList.toggle(
        'hunt__hint--risk',
        armed && damageAt(state.dial) < SOUND_BELOW,
      );
    },

    get visible(): boolean {
      return lastShown;
    },

    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
