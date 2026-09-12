/**
 * huntaudio.ts — the hunt's voices, built on `audio.ts`.
 *
 * One voice per cue kind and no more. `turn`, `handoff` and `spout` are
 * deliberately silent: a sound for every cue would make the hunt the loudest
 * thing in a game that has no other sound at all, and those three are the ones
 * the player can already see happening.
 *
 * ## The armed tick
 *
 * The only voice with state. While the dial is live it ticks, and the interval
 * shortens as the needle nears the green — so a player steering with their
 * eyes on the water can hear the press coming. It stops on `disarmed`, and it
 * stops when the sim stops being armed, because a cue can be missed and a
 * state cannot.
 *
 * Its clock is frame `dt`, not the audio context's: it decides WHEN to make a
 * sound, which is game-adjacent, and only the note itself is scheduled on the
 * hardware's timeline.
 */

import type { Audio } from './audio';
import type { HuntCue, HuntState } from './types';
import { SOUND_BELOW, damageAt } from './huntsweep';

/** Tick interval at the red edge and at the centre, seconds. */
const TICK_SLOW = 0.32;
const TICK_FAST = 0.07;

export interface HuntAudio {
  cue(cue: HuntCue): void;
  update(dt: number, state: HuntState): void;
  dispose(): void;
}

export function createHuntAudio(audio: Audio): HuntAudio {
  let tickClock = 0;

  return {
    cue(cue: HuntCue): void {
      switch (cue.kind) {
        case 'spawn':
          // A low groan with a slow wobble: something large, a long way off.
          audio.tone({
            frequency: 68,
            duration: 1.6,
            gain: 0.5,
            type: 'sine',
            vibrato: 4,
            vibratoRate: 1.6,
          });
          audio.tone({ frequency: 101, duration: 1.2, gain: 0.18, type: 'sine', delay: 0.1 });
          break;

        case 'armed':
          tickClock = 0;
          break;

        case 'disarmed':
          tickClock = 0;
          break;

        case 'strike': {
          /*
           * Three layers, and the order matters: the thud is the harpoon
           * striking, the splash is the water answering a beat later, and the
           * chime is the reward for a green press and only a green press.
           */
          audio.noise({ duration: 0.16, gain: 0.55, frequency: 180, q: 0.7 });
          audio.noise({ duration: 0.42, gain: 0.4, frequency: 1400, q: 0.5, delay: 0.05 });
          if (cue.band === 'green') {
            audio.tone({ frequency: 784, duration: 0.22, gain: 0.3, type: 'triangle', delay: 0.06 });
            audio.tone({ frequency: 1175, duration: 0.3, gain: 0.2, type: 'triangle', delay: 0.13 });
          }
          break;
        }

        case 'dive':
          // A bass drop. The picture that makes sounding a loss, in sound.
          audio.tone({ frequency: 140, slideTo: 38, duration: 1.5, gain: 0.55, type: 'sine' });
          audio.noise({ duration: 1.1, gain: 0.25, frequency: 320, q: 0.4, delay: 0.15 });
          break;

        case 'settled':
          // A rising figure: the one unambiguously good ending in the feature.
          audio.tone({ frequency: 392, duration: 0.3, gain: 0.28, type: 'triangle' });
          audio.tone({ frequency: 523, duration: 0.3, gain: 0.28, type: 'triangle', delay: 0.16 });
          audio.tone({ frequency: 659, duration: 0.55, gain: 0.3, type: 'triangle', delay: 0.32 });
          break;

        default:
          // `turn`, `handoff`, `spout`: seen, not heard. See the header.
          break;
      }
    },

    update(dt: number, state: HuntState): void {
      if (!(dt > 0)) return;

      /*
       * Driven by STATE rather than by the armed cue alone.
       *
       * A cue can be missed — a frame where the gate opens and closes inside
       * one `dt` emits both and the tick would be left running. The state is
       * the truth about whether the dial is live this frame, so it is what
       * decides whether there is a tick at all.
       */
      if (!state.armed || !state.ready) {
        tickClock = 0;
        return;
      }

      const damage = damageAt(state.dial);
      // Nearer the centre, faster: the ear can follow an accelerating tick far
      // more precisely than it can judge a pitch, which is why this quickens
      // rather than rising.
      const t = Math.max(0, Math.min(1, damage / 100));
      const interval = TICK_SLOW + (TICK_FAST - TICK_SLOW) * t;

      tickClock -= dt;
      if (tickClock > 0) return;
      tickClock = interval;

      /*
       * The tick's own pitch says which side of `SOUND_BELOW` the needle is
       * on, so the one thing a player must not do — press into the deep red —
       * is audible as well as visible.
       */
      const low = damage < SOUND_BELOW;
      audio.tone({
        frequency: low ? 220 : 440 + t * 220,
        duration: 0.045,
        gain: low ? 0.16 : 0.12,
        type: 'square',
      });
    },

    dispose(): void {
      tickClock = 0;
    },
  };
}
