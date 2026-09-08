/**
 * weather.ts — the weather at the ship, and the one place the two sources of
 * it meet.
 *
 * A SQUALL is rolled off the wind's own phases: a strong event may become a
 * storm, a quiet lull may fill with fog. It has no place and cannot be seen
 * coming; it arrives when the wind does. That is the whole reason it exists
 * beside `weathercells.ts` — a cell is weather you can plan around, a squall
 * is weather that happens to you, and a world with only the first kind is one
 * where nothing is ever a surprise.
 *
 * Squalls and cells are combined here by `max` BEFORE any smoothing, so
 * everything downstream reads one `WeatherState` and cannot tell them apart.
 * That is deliberate: a shader asking which source darkened the sky would be
 * a shader that has to be changed when a third source is added.
 *
 * Two things this file must not do:
 *
 *  - **Draw from the wind's PRNG.** Squalls have their own stream, for the
 *    reason `weathercells.ts` records at the top of itself.
 *  - **Read `weathermap.ts`.** Every number here is a decision, and decisions
 *    read `CellsState`'s analytic sample. See docs/WEATHER_PLAN.md, Trap 3.
 */
import type { CellsState, WeatherKind, WeatherState, WindState } from './types';
import { RADAR_RANGE } from './radar';
import { mulberry32 } from './towns';

export interface Weather {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: WeatherState;
  /**
   * Runs after `wind.update` and before `hazards.update`. After the wind
   * because it reads this frame's phase; before the hazards because the storm
   * multiplier on their spawn rolls is this frame's.
   */
  update(dt: number, wind: WindState, cells: CellsState): void;
}

/**
 * What `?weather=` pins the sky to. Not a game state and not stored on
 * `WeatherState`: it switches the ROLLS off and holds the envelopes at their
 * full values, so a screenshot of a storm is a screenshot of the same storm
 * every time.
 */
export type WeatherPin = 'clear' | 'overcast' | 'rain' | 'storm' | 'lightning' | 'fog';

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * Share of wind events that become a storm, and the share that also carry
 * lightning.
 *
 * A quarter, so that most of the weather a player sails through is ordinary
 * wind and a storm stays worth remarking on. Lightning is 0.10 of ALL events,
 * i.e. 40% of storms: a storm without lightning still has to be a storm, or
 * the rain reads as a preamble to a flash that never comes.
 *
 * Both are drawn from ONE number, `severity`, rather than two: a lightning
 * storm is the top of the same distribution rather than an independent coin,
 * so there is no such thing as a mild storm with lightning in it.
 */
const STORM_SHARE = 0.25;
const LIGHTNING_SHARE = 0.1;

/**
 * Share of lulls that fill with fog, and the shortest lull that may.
 *
 * Fog needs time to arrive and leave -- `FOG_FADE` at each end -- and a
 * five-second lull spent entirely in transit would be a grey flicker rather
 * than a bank. Eight seconds is the first duration that holds full fog for
 * two seconds, which is the least that reads as weather. `LULL_MAX` is 15, so
 * a little under half of all lulls are eligible and 0.35 of those take it.
 */
const FOG_SHARE = 0.35;
const FOG_MIN_LULL = 8;

/**
 * The thinnest a squall's fog may be, as a fraction of full.
 *
 * A fog that is only a quarter there is haze, and the game already has haze
 * -- `fog.ts`'s aerial perspective is on in every frame. If a lull is going to
 * be foggy it should be foggy enough to slow the ship down.
 */
const FOG_FLOOR = 0.5;

/** Seconds a squall's fog spends arriving, and again leaving. Clamped to a quarter of the lull. */
const FOG_FADE = 3;

/**
 * Time constants, seconds, on the three slow envelopes.
 *
 * `STORM_TAU` is a shade under the wind's own 2 s ramp, so a squall arrives a
 * beat behind the gale and leaves a beat after it, which is what a squall
 * does. It is also what a cell arrives over, so sailing into one takes about
 * as long as one forming on top of you.
 *
 * `COVER_TAU` is the slowest thing in the file and the reason is worth
 * keeping: the sky has to clear AFTER the rain stops. Cover that fell as fast
 * as the rain would leave a storm ending in a blue sky within two seconds,
 * which is the single most artificial thing a weather system can do.
 *
 * `FOG_TAU` is short because fog is the one that gates the scope, and a
 * player who has just sailed out of a bank should get their range back
 * promptly rather than sail on blind through clear water.
 */
const STORM_TAU = 1.5;
const COVER_TAU = 4;
const FOG_TAU = 1;

/**
 * How far into a storm the rain starts.
 *
 * Rain is the storm's own envelope with its first quarter cut off and the
 * remainder eased, so the sky darkens before the first drop falls. Weather
 * that arrives all at once reads as a switch.
 */
const RAIN_ONSET = 0.25;

/**
 * How much cloud an ordinary, non-storm event builds.
 *
 * Every gale greys the sky a little; only a storm blackens it. Without this
 * the cloud deck would be a storm flag rather than a sky, and three quarters
 * of the wind in the game would blow under an unchanged noon.
 */
const COVER_PLAIN = 0.35;

/**
 * The storm depth below which lightning does not strike, the mean seconds
 * between strikes above it, and the shape of one strike.
 *
 * A strike is two or three pulses rather than one: a single exponential decay
 * reads as a lamp being switched, and the double-flicker is most of what
 * makes lightning recognisable. `FLASH_DECAY` at 0.12 s puts a pulse just
 * inside the eye's persistence, so it registers as a flash and not as a
 * frame.
 */
const FLASH_GATE = 0.6;
const FLASH_MEAN = 6;
const FLASH_GAP = 0.08;
const FLASH_DECAY = 0.12;

/**
 * How much of the scope thick fog and heavy rain take away, and the floor
 * under what is left, world units.
 *
 * The owner's numbers: a third of the scope in thick fog, a bit over half in
 * heavy rain. `VIS_MIN` is about four hull lengths and exists for one
 * concrete reason -- a berth ring has to stay visible or docking in fog is a
 * guess rather than a piece of seamanship.
 */
const FOG_VIS_CUT = 0.67;
const STORM_VIS_CUT = 0.4;
const VIS_MIN = 12;

/** The labels, at the thresholds the HUD switches on. */
const KIND_FOG = 0.5;
const KIND_RAIN = 0.1;
const KIND_COVER = 0.4;

/**
 * Squall seed. Its own stream, and not the wind's or the cells'.
 */
const WEATHER_SEED = 0x5c0a11;

/* ------------------------------------------------------------------ */
/* Weather                                                             */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only WeatherState surface. */
interface MutableWeatherState {
  kind: WeatherKind;
  cover: number;
  rain: number;
  storm: number;
  fog: number;
  flash: number;
  flashLocal: boolean;
  visibility: number;
}

/** The envelopes a `?weather=` pin holds everything at. */
const PINS: Record<WeatherPin, { cover: number; rain: number; storm: number; fog: number }> = {
  clear: { cover: 0, rain: 0, storm: 0, fog: 0 },
  overcast: { cover: 0.7, rain: 0, storm: 0, fog: 0 },
  rain: { cover: 0.85, rain: 0.7, storm: 0.5, fog: 0 },
  storm: { cover: 1, rain: 1, storm: 1, fog: 0 },
  lightning: { cover: 1, rain: 1, storm: 1, fog: 0 },
  fog: { cover: 0.4, rain: 0, storm: 0, fog: 1 },
};

/** Clamp to [0, 1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The usual cubic ease, on an already-unclamped argument. */
function smoothstep01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * The weather at the ship.
 *
 * `pin` is `?weather=`'s: it disables the squall roll and holds the envelopes
 * at fixed values, for `npm run shots` and for the owner's eye. Cells still
 * run under a pin, so `?weather=storm&cell=fog` is a fog bank seen from
 * inside a storm.
 */
export function createWeather(seed = WEATHER_SEED, pin: WeatherPin | null = null): Weather {
  const rng = mulberry32(seed);

  const state: MutableWeatherState = {
    kind: 'clear',
    cover: 0,
    rain: 0,
    storm: 0,
    fog: 0,
    flash: 0,
    flashLocal: false,
    visibility: RADAR_RANGE,
  };

  /** The phase the last roll was made for. -1 so the opening phase rolls. */
  let rolledIndex = -1;

  /** What the current event is, decided once when it began. */
  let squallStormClass = false;
  let squallLightningClass = false;
  /** What the current lull is, likewise. 0 when it is not foggy. */
  let squallFogDepth = 0;

  /** Seconds since the live strike began, and how many pulses it has. Negative age = no strike. */
  let strikeAge = -1;
  let strikePulses = 0;

  /**
   * One squall roll, made when the wind steps into a new phase.
   *
   * TWO draws, always, whichever phase it is. An event uses the first and
   * discards the second; a lull uses both. Drawing a different COUNT per
   * phase would make the stream depend on the wind's phase pattern, and the
   * whole point of a separate PRNG is that this file's sequence is its own.
   */
  function roll(wind: WindState): void {
    const a = rng();
    const b = rng();

    if (wind.phase === 'event') {
      squallStormClass = a < STORM_SHARE;
      squallLightningClass = a < LIGHTNING_SHARE;
      squallFogDepth = 0;
    } else {
      squallStormClass = false;
      squallLightningClass = false;
      squallFogDepth =
        a < FOG_SHARE && wind.phaseDuration >= FOG_MIN_LULL
          ? FOG_FLOOR + b * (1 - FOG_FLOOR)
          : 0;
    }
  }

  /**
   * The squall's own fog envelope: a trapezoid over the lull, on the same
   * clamped-fade rule the wind uses on its events.
   */
  function squallFog(wind: WindState): number {
    if (squallFogDepth <= 0 || wind.phase !== 'lull') return 0;
    const fade = Math.min(FOG_FADE, wind.phaseDuration * 0.25);
    if (!(fade > 0)) return squallFogDepth;
    const rise = wind.phaseTime / fade;
    const fall = (wind.phaseDuration - wind.phaseTime) / fade;
    return squallFogDepth * clamp01(Math.min(rise, fall));
  }

  /**
   * Lightning, in bursts.
   *
   * The gate is a pure function of already-replayed state — the storm depth,
   * and whether either source is a lightning one — so the per-frame draw
   * below cannot desynchronise a replay that agrees about everything else.
   */
  function updateFlash(dt: number, lightningLive: boolean, local: boolean): void {
    if (strikeAge >= 0) {
      strikeAge += dt;
      let flash = 0;
      for (let i = 0; i < strikePulses; i++) {
        const t = strikeAge - i * FLASH_GAP;
        if (t < 0) continue;
        const v = Math.exp(-t / FLASH_DECAY);
        if (v > flash) flash = v;
      }
      state.flash = clamp01(flash);
      // Retire the strike once even its last pulse is under a 255th.
      if (strikeAge > strikePulses * FLASH_GAP + 6 * FLASH_DECAY) strikeAge = -1;
    } else {
      state.flash = 0;
    }

    if (!lightningLive || state.storm <= FLASH_GATE) return;
    if (strikeAge >= 0) return;
    // Poisson: one strike per FLASH_MEAN seconds on average.
    if (rng() < dt / FLASH_MEAN) {
      strikeAge = 0;
      strikePulses = rng() < 0.5 ? 2 : 3;
      // Recorded at the moment of the strike, not read per frame: a cell
      // drifting off the ship mid-flash must not turn that flash into a
      // placeless one halfway through its own decay.
      state.flashLocal = local;
    }
  }

  /** The label. Derived last, from the envelopes, and read by nothing but the HUD. */
  function labelOf(): WeatherKind {
    if (state.fog > KIND_FOG) return 'fog';
    if (state.storm > FLASH_GATE) return 'storm';
    if (state.rain > KIND_RAIN) return 'rain';
    if (state.cover > KIND_COVER) return 'overcast';
    return 'clear';
  }

  function update(dt: number, wind: WindState, cells: CellsState): void {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    if (pin) {
      // Pinned: the squall roll is off, the cells still count, and the
      // envelopes are held. `lightning` differs from `storm` only in that it
      // opens the flash gate.
      const p = PINS[pin];
      state.cover = Math.max(p.cover, cells.stormAtShip);
      state.storm = Math.max(p.storm, cells.stormAtShip);
      state.rain = Math.max(p.rain, smoothstep01((state.storm - RAIN_ONSET) / (1 - RAIN_ONSET)));
      state.fog = Math.max(p.fog, cells.fogAtShip);
      // A pinned flash is placeless: `?weather=lightning` is for looking at
      // the effect, and it should light the sky whether a cell is there or not.
      updateFlash(dt, pin === 'lightning' || cells.lightningAtShip, pin === 'lightning');
    } else {
      // ---- The roll -------------------------------------------------------
      if (wind.phaseIndex !== rolledIndex) {
        rolledIndex = wind.phaseIndex;
        roll(wind);
      }

      /*
       * ---- The combine ----------------------------------------------------
       *
       * `max` of the two sources, and it happens BEFORE the smoothing below
       * rather than after. Smoothing each source separately and combining the
       * results would let a squall ending inside a cell pull the total down
       * for a moment -- the max of two eased numbers is not the ease of their
       * max -- and the sky would flicker at exactly the moment two pieces of
       * weather overlapped.
       */
      const stormTarget = Math.max(
        squallStormClass ? wind.envelope : 0,
        cells.stormAtShip,
      );
      const coverTarget = Math.max(stormTarget, COVER_PLAIN * wind.envelope, cells.stormAtShip);
      const fogTarget = Math.max(squallFog(wind), cells.fogAtShip);

      const kStorm = 1 - Math.exp(-dt / STORM_TAU);
      const kCover = 1 - Math.exp(-dt / COVER_TAU);
      const kFog = 1 - Math.exp(-dt / FOG_TAU);
      state.storm += (stormTarget - state.storm) * kStorm;
      state.cover += (coverTarget - state.cover) * kCover;
      state.fog += (fogTarget - state.fog) * kFog;

      // Rain is the storm, with its first quarter cut off and the rest eased:
      // the sky darkens before the first drop falls.
      state.rain = smoothstep01((state.storm - RAIN_ONSET) / (1 - RAIN_ONSET));

      updateFlash(dt, squallLightningClass || cells.lightningAtShip, squallLightningClass);
    }

    // ---- What all of that comes to --------------------------------------
    let visibility = RADAR_RANGE * (1 - FOG_VIS_CUT * state.fog) * (1 - STORM_VIS_CUT * state.rain);
    if (visibility > RADAR_RANGE) visibility = RADAR_RANGE;
    if (visibility < VIS_MIN) visibility = VIS_MIN;
    state.visibility = visibility;
    state.kind = labelOf();
  }

  return { state: state as WeatherState, update };
}

/* Exported for the tests and for `radar.ts`'s own floor on the scope mask. */
export { VIS_MIN, FLASH_GATE, STORM_SHARE, LIGHTNING_SHARE, FOG_SHARE, FOG_MIN_LULL };
