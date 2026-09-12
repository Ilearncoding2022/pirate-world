/**
 * huntnumbers.ts — floating damage numbers and the green streak.
 *
 * On a `strike` the damage pops at the mark's screen position in its band
 * colour and floats up over `NUMBER_LIFE`, with the streak beside it from the
 * second consecutive green onward.
 *
 * ## The band is never recomputed here
 *
 * It comes off the cue. The sim publishes its own reading of its ramp so that
 * five consumers cannot each get the thresholds wrong — the same reason
 * `SOUND_BELOW` is exported rather than restated in the dial. A number that
 * said "green" while the bar said "yellow" would be worse than no number.
 *
 * ## Clocks
 *
 * The float and the fade are a CSS transition, which is allowed: they are
 * decoration with no gameplay meaning. How long a number LIVES before its
 * element goes back in the pool is counted in frame `dt` by `update`, because
 * that is a lifetime and lifetimes in this codebase are `dt`.
 *
 * ## Missing markup
 *
 * `leviathandial.ts`'s contract, inherited: a document without the
 * `<!-- HUNT FX -->` block must not take the frame loop down. Every method
 * here is a no-op when the container is absent.
 */

import type { PerspectiveCamera } from 'three';
import type { HuntCue } from './types';
import { createScreenPoint, project } from './anchor';

/** How long one number lives, seconds. */
const NUMBER_LIFE = 0.8;

/** How far it floats in that time, CSS pixels. */
const RISE = 46;

/** The pool. Five presses a hunt, and a number outlives a press by under a second. */
const POOL = 8;

interface Slot {
  element: HTMLElement;
  value: HTMLElement;
  streak: HTMLElement;
  age: number;
  x: number;
  y: number;
}

export interface HuntNumbers {
  /**
   * @param streak the sim's consecutive-green count, read at the fan-out.
   *
   * Passed in rather than added to `HuntCue`, deliberately. A cue is what
   * HAPPENED; the streak is a running total on `HuntState`, and five other
   * consumers have no use for it. `main.ts` is the one place that holds both,
   * so it is the one place that pairs them.
   */
  cue(cue: HuntCue, camera: PerspectiveCamera, streak: number): void;
  update(dt: number): void;
  dispose(): void;
}

export function createHuntNumbers(): HuntNumbers {
  const host = document.getElementById('hunt-numbers');
  const point = createScreenPoint();

  const slots: Slot[] = [];
  if (host !== null) {
    for (let i = 0; i < POOL; i++) {
      const element = document.createElement('div');
      element.className = 'huntfx__num';
      element.style.opacity = '0';
      const value = document.createElement('span');
      const streak = document.createElement('span');
      streak.className = 'huntfx__streak';
      element.appendChild(value);
      element.appendChild(streak);
      host.appendChild(element);
      slots.push({ element, value, streak, age: NUMBER_LIFE, x: 0, y: 0 });
    }
  }

  /** The oldest slot, so a burst of presses replaces the stalest number. */
  function claim(): Slot | null {
    if (slots.length === 0) return null;
    let oldest = slots[0];
    for (const slot of slots) if (slot.age > oldest.age) oldest = slot;
    return oldest;
  }

  return {
    cue(cue: HuntCue, camera: PerspectiveCamera, streak: number): void {
      if (cue.kind !== 'strike' || !cue.position) return;
      const slot = claim();
      if (slot === null) return;

      project(cue.position, camera, window.innerWidth, window.innerHeight, point);
      /*
       * A number for a strike that happened behind the camera is dropped
       * rather than drawn. `behind` means the projection is mirrored through
       * the centre, so drawing it would put the damage on the opposite side of
       * the screen from the animal — worse than silence.
       */
      if (point.behind) return;

      slot.age = 0;
      slot.x = point.x;
      slot.y = point.y;
      slot.value.textContent = `${cue.damage ?? 0}`;
      // From the SECOND consecutive green onward. A "x1" beside every good
      // press would be noise; a streak only means something once it is one.
      slot.streak.textContent = streak >= 2 ? `x${streak}` : '';
      slot.element.className = `huntfx__num huntfx__num--${cue.band ?? 'yellow'}`;
      slot.element.style.transition = 'none';
      slot.element.style.transform = `translate(-50%, -50%)`;
      slot.element.style.left = `${point.x}px`;
      slot.element.style.top = `${point.y}px`;
      slot.element.style.opacity = '1';

      /*
       * The transition is armed on the NEXT frame, not this one. Setting
       * `transition: none`, the start value and the end value in one go lets
       * the browser collapse them and the number would teleport. Reading
       * `offsetHeight` forces the style flush that separates the two.
       */
      void slot.element.offsetHeight;
      slot.element.style.transition = `transform ${NUMBER_LIFE}s ease-out, opacity ${NUMBER_LIFE}s ease-in`;
      slot.element.style.transform = `translate(-50%, calc(-50% - ${RISE}px))`;
      slot.element.style.opacity = '0';
    },

    /** Called by the sim's own counter, so the streak text is never guessed. */
    update(dt: number): void {
      if (!(dt > 0)) return;
      for (const slot of slots) {
        if (slot.age >= NUMBER_LIFE) continue;
        slot.age += dt;
        if (slot.age >= NUMBER_LIFE) {
          slot.element.style.opacity = '0';
          slot.element.style.transition = 'none';
        }
      }
    },

    dispose(): void {
      for (const slot of slots) slot.element.remove();
      slots.length = 0;
    },
  };
}
