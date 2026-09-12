/**
 * screenfx.ts — the viewport vignette and the camera kick.
 *
 * Two channels of "the screen itself reacted", and both are deliberately the
 * cheapest possible version of that: a DOM gradient whose opacity is written
 * each frame, and a field-of-view offset on the chase camera.
 *
 * ## Not a post-processing pass
 *
 * `postfx.ts` owns the composer chain. Adding a stage to it for a vignette
 * would put a full-screen pass in the frame budget for something a DOM overlay
 * draws for nothing, on a project whose low tier is a software rasteriser.
 *
 * ## Reduced motion
 *
 * The kick and the pulses are disabled OUTRIGHT when
 * `prefers-reduced-motion: reduce` matches — not scaled down. A player who
 * asked the system for no motion has asked for no motion, and nothing here
 * carries information: the dial, the reticle and the floating numbers already
 * say everything this says.
 */

import type { FollowCamera } from './camera';
import type { HuntCue, HuntState } from './types';
import { SOUND_BELOW, damageAt } from './huntsweep';

/** How hard a green strike kicks the camera, 0..1 into `FollowCamera.kick`. */
const GREEN_KICK = 0.8;
const YELLOW_KICK = 0.35;

/** The armed vignette's resting strength, and how much the pulse adds. */
const ARMED_ALPHA = 0.35;
const PULSE_GAIN = 0.45;
const PULSE_DECAY = 3;

/** How fast the vignette eases toward what it wants. Per second. */
const EASE = 9;

export interface ScreenFx {
  cue(cue: HuntCue): void;
  update(dt: number, state: HuntState): void;
  dispose(): void;
}

export function createScreenFx(camera?: Pick<FollowCamera, 'kick'>): ScreenFx {
  const vignette = document.getElementById('hunt-vignette');

  /*
   * Read once at construction rather than per frame. It is a user preference,
   * not a per-frame condition, and `matchMedia` on every frame of every hunt
   * would be a layout read in the middle of the loop.
   *
   * Guarded because `matchMedia` does not exist in every environment this is
   * constructed in — the unit tier has no window at all.
   */
  const reduced =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  let pulse = 0;
  let alpha = 0;
  let applied = -1;
  let danger = false;

  return {
    cue(cue: HuntCue): void {
      if (reduced) return;

      if (cue.kind === 'armed') pulse = 1;

      if (cue.kind === 'strike') {
        /*
         * The kick is proportional to the press. A green strike lurches; a red
         * one barely registers, which is itself feedback — a contemptible
         * press should not feel like a good one.
         */
        const amount =
          cue.band === 'green' ? GREEN_KICK : cue.band === 'yellow' ? YELLOW_KICK : 0;
        if (amount > 0) camera?.kick(amount);
      }
    },

    update(dt: number, state: HuntState): void {
      if (vignette === null || !(dt > 0)) return;

      if (reduced) {
        if (applied !== 0) {
          vignette.style.opacity = '0';
          applied = 0;
        }
        return;
      }

      if (pulse > 0) pulse = Math.max(0, pulse - dt * PULSE_DECAY);

      /*
       * Red while the live press would sound the animal.
       *
       * This is the one piece of the screen layer that carries information the
       * bar does not already shout: the player is looking at the WATER while
       * steering, and the edge of the screen going red tells them the needle
       * has run into the part of its sweep that would end the hunt.
       */
      const live = state.armed && state.ready;
      const wantDanger = live && damageAt(state.dial) < SOUND_BELOW;
      if (wantDanger !== danger) {
        danger = wantDanger;
        vignette.className = `huntfx__vignette huntfx__vignette--${danger ? 'danger' : 'armed'}`;
      }

      const want = (state.armed ? ARMED_ALPHA : 0) + pulse * PULSE_GAIN;
      alpha += (want - alpha) * Math.min(1, dt * EASE);

      // Written only when it has actually moved a hundredth: a style write is
      // a layout invalidation and a hunt runs for a minute at sixty frames.
      const rounded = Math.round(alpha * 100) / 100;
      if (rounded !== applied) {
        vignette.style.opacity = `${rounded}`;
        applied = rounded;
      }
    },

    dispose(): void {
      if (vignette !== null) vignette.style.opacity = '0';
    },
  };
}
