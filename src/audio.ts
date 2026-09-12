/**
 * audio.ts — the sound foundation. Knows nothing about hunts.
 *
 * The first audio in this project. `docs/ROADMAP.md` calls its absence the
 * largest single gap, so the hunt's cues could not simply be added to
 * something — this is the something, and it is deliberately generic: a tone
 * with an envelope and a filtered noise burst are enough to build a groan, a
 * tick, a thud, a splash, a chime and a bass drop between them.
 *
 * ## No asset files
 *
 * Everything is synthesised. That is the project's ethos — the hull is the one
 * authored asset in the whole game — and it is why adding sound costs a
 * kilobyte rather than a pipeline.
 *
 * ## Silent and inert where there is no context
 *
 * The unit tier has no `window`, and the headless browser tier has no audio
 * device. Both construct this. Neither may throw, and neither may be given a
 * different code path to walk: the object is built the same way everywhere and
 * simply does nothing when there is nothing to do it with.
 *
 * ## The one legitimate second clock
 *
 * `now` is the `AudioContext`'s own clock, and scheduling against it rather
 * than against frame `dt` is correct: a note handed to the audio hardware has
 * to be placed on the hardware's timeline or it arrives jittered by whatever
 * the renderer was doing that frame. This is not a second GAME clock — nothing
 * here gates game state, and `docs/ARCHITECTURE.md`'s rule is about state.
 */

/** Persisted under the same prefix `quality.ts` uses for its own row. */
export const MUTE_STORAGE_KEY = 'pirate-world/mute';

/** The master level everything is mixed under. Deliberately conservative. */
const MASTER_GAIN = 0.22;

/** One note: a frequency, an envelope, and how it should move. */
export interface ToneSpec {
  frequency: number;
  /** Seconds. */
  duration: number;
  gain?: number;
  type?: OscillatorType;
  /** Glide to this frequency across `duration`, if given. */
  slideTo?: number;
  /** Vibrato depth in Hz. 0 or absent for none. */
  vibrato?: number;
  /** Vibrato rate in Hz. */
  vibratoRate?: number;
  /** Seconds from now. Lets one cue place two voices a beat apart. */
  delay?: number;
}

/** One filtered noise burst: a splash, a thud, a spout. */
export interface NoiseSpec {
  /** Seconds. */
  duration: number;
  gain?: number;
  /** Band-pass centre, Hz. */
  frequency?: number;
  q?: number;
  delay?: number;
}

export interface Audio {
  muted: boolean;
  /** Start the context if a gesture has happened. A no-op once unlocked. */
  unlock(): void;
  tone(spec: ToneSpec): void;
  noise(spec: NoiseSpec): void;
  /** The context's clock, seconds, or 0 where there is none. */
  readonly now: number;
  dispose(): void;
}

/** Read the persisted mute flag, tolerating storage that throws or is absent. */
function storedMute(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    // Private windows and blocked site data both throw on access rather than
    // returning null. `quality.ts` carries the same guard for the same reason.
    return false;
  }
}

export function createAudio(): Audio {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let muted = storedMute();
  let disposed = false;

  /**
   * The constructor, or null where there is none.
   *
   * Resolved once and lazily rather than at module load: reading
   * `window.AudioContext` at import time would make this module unimportable
   * under node, and the unit tier imports everything.
   */
  function constructorFor(): typeof AudioContext | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    return w.AudioContext ?? w.webkitAudioContext ?? null;
  }

  function ensure(): boolean {
    if (disposed) return false;
    if (context !== null) return true;

    const Ctor = constructorFor();
    if (Ctor === null) return false;
    try {
      context = new Ctor();
      master = context.createGain();
      master.gain.value = muted ? 0 : MASTER_GAIN;
      master.connect(context.destination);
    } catch {
      // A device that refuses to give one. Everything below then no-ops, which
      // is the same path the unit tier walks.
      context = null;
      master = null;
      return false;
    }
    return true;
  }

  /*
   * Suspend on a hidden tab.
   *
   * A backgrounded game is silent, which is manners, and it also stops a
   * suspended-then-resumed context from firing every note that queued up while
   * the tab was away. Registered once, and only where there is a document.
   */
  const onVisibility = (): void => {
    if (context === null) return;
    if (document.hidden) void context.suspend();
    else if (!muted) void context.resume();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return {
    get muted(): boolean {
      return muted;
    },
    set muted(value: boolean) {
      muted = value;
      try {
        globalThis.localStorage?.setItem(MUTE_STORAGE_KEY, value ? '1' : '0');
      } catch {
        // Nothing to do and nothing to say: the setting simply will not
        // survive a reload in a window that refuses storage.
      }
      if (master !== null) master.gain.value = value ? 0 : MASTER_GAIN;
    },

    unlock(): void {
      if (!ensure() || context === null) return;
      // Browsers hand back a context in `suspended` until a gesture has
      // happened. Calling this from a keydown or pointerdown is the gesture.
      if (context.state === 'suspended' && !muted) void context.resume();
    },

    tone(spec: ToneSpec): void {
      if (muted || !ensure() || context === null || master === null) return;
      const at = context.currentTime + (spec.delay ?? 0);
      const duration = Math.max(0.01, spec.duration);

      const osc = context.createOscillator();
      osc.type = spec.type ?? 'sine';
      osc.frequency.setValueAtTime(spec.frequency, at);
      if (spec.slideTo !== undefined) {
        // Exponential, because pitch is perceived logarithmically and a linear
        // ramp between two notes does not sound like a glide between them.
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.slideTo), at + duration);
      }

      const gain = context.createGain();
      const peak = spec.gain ?? 0.5;
      /*
       * A short attack and an exponential decay. The attack is not optional:
       * a gain that jumps from 0 to peak in one sample is a click, and a click
       * is the single most recognisable sign of synthesised audio done badly.
       */
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.02, duration * 0.2));
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

      osc.connect(gain);
      gain.connect(master);
      osc.start(at);
      osc.stop(at + duration + 0.02);

      if (spec.vibrato) {
        const lfo = context.createOscillator();
        const depth = context.createGain();
        lfo.frequency.value = spec.vibratoRate ?? 5;
        depth.gain.value = spec.vibrato;
        lfo.connect(depth);
        depth.connect(osc.frequency);
        lfo.start(at);
        lfo.stop(at + duration + 0.02);
      }
    },

    noise(spec: NoiseSpec): void {
      if (muted || !ensure() || context === null || master === null) return;
      const at = context.currentTime + (spec.delay ?? 0);
      const duration = Math.max(0.02, spec.duration);

      /*
       * A fresh buffer per burst rather than one shared and re-triggered.
       * A splash is at most a few thousand samples and lasts under a second;
       * pooling them would save a fraction of a millisecond and cost the
       * variation that keeps five splashes in a row from sounding identical.
       */
      const frames = Math.ceil(context.sampleRate * duration);
      const buffer = context.createBuffer(1, frames, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

      const source = context.createBufferSource();
      source.buffer = buffer;

      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = spec.frequency ?? 900;
      filter.Q.value = spec.q ?? 0.8;

      const gain = context.createGain();
      const peak = spec.gain ?? 0.4;
      gain.gain.setValueAtTime(peak, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      source.start(at);
      source.stop(at + duration + 0.02);
    },

    get now(): number {
      return context?.currentTime ?? 0;
    },

    dispose(): void {
      disposed = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (context !== null) {
        void context.close();
        context = null;
        master = null;
      }
    },
  };
}
