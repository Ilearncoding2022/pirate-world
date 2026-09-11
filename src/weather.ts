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
import { Vector3 } from 'three';
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
 * Rain is the storm's own envelope with its first tenth cut off and the
 * remainder eased, so the sky still darkens before the first drop falls.
 * Weather that arrives all at once reads as a switch.
 *
 * It was a quarter, and a quarter turned out to be most of the ordinary
 * weather in the game: a squall that peaked below 0.25 greyed the sky and
 * then rained nothing at all, which read as a storm that never arrived. A
 * tenth keeps the lead-in -- there is still a stretch of dark sky before the
 * first drop -- while letting moderate weather actually be wet.
 */
const RAIN_ONSET = 0.1;

/**
 * Rain in EPISODES: the shape of the thing, and the five numbers that make it.
 *
 * Rain used to be one number -- the storm's own envelope, eased -- so a squall
 * rained at exactly one strength for its whole length and only rose and fell
 * with the storm underneath it. Real rain does not do that. It comes in waves:
 * it eases to a drizzle, hangs there, then hardens again, and the waves are
 * short against the weather that carries them. So a live rain is cut into
 * episodes, each one rolled when the last runs out.
 *
 * **How long an episode is.** Between `RAIN_EPISODE_MIN` and half of the rain
 * it belongs to. Half rather than all of it because two episodes is the fewest
 * that can be called alternating -- an episode allowed to fill the whole
 * event would be the old behaviour wearing a new name -- and one second at the
 * bottom because a wave of rain shorter than that is a flicker, not weather.
 *
 * **What "the rain it belongs to" means.** The wind phase the squall was
 * rolled off, `wind.phaseDuration`, which is known in full the moment the
 * phase begins -- so the episodes inside it can be sized against the whole
 * before any of them has run. Rain from a weather CELL has no such number: a
 * cell drifts, and how long it sits on the ship is a fact about a course
 * nobody has steered yet. `RAIN_EPISODE_SPAN` is the nominal length those are
 * cut against instead, and 30 s is about what a cell of ordinary size takes to
 * cross a ship holding its heading.
 *
 * **How hard an episode rains.** A tenth at a time from `RAIN_EPISODE_FLOOR`
 * to full, i.e. one of the nine levels 20%, 30% ... 100% of the rain the
 * storm would otherwise have produced -- never zero, because rain that stops
 * dead and restarts is two rains, and the gap between them belongs to the
 * storm envelope rather than to this. Each roll excludes the level it is
 * replacing, so every boundary is a real change of strength: a re-roll that
 * could return the same tenth would, one time in nine, spend an episode doing
 * nothing at all.
 *
 * **How it gets there.** Over `RAIN_EPISODE_TAU`, not at once. This scales the
 * whole envelope -- the drops, the haze, the scope's own range -- and a
 * multiplier that stepped would take the visible world from a downpour to a
 * drizzle between two frames, which is the "weather that arrives all at once
 * reads as a switch" this file already refuses at `RAIN_ONSET`. 1.2 s is under
 * the shortest episode, so even a one-second wave is most of the way to its
 * own strength before the next is rolled.
 */
const RAIN_EPISODE_MIN = 1;
const RAIN_EPISODE_SHARE = 0.5;
const RAIN_EPISODE_SPAN = 30;
const RAIN_EPISODE_FLOOR = 0.2;
const RAIN_EPISODE_STEP = 0.1;
const RAIN_EPISODE_TAU = 1.2;

/** The nine levels the line above describes. Derived, so only the three tuning numbers are typed. */
const RAIN_EPISODE_LEVELS = Math.round((1 - RAIN_EPISODE_FLOOR) / RAIN_EPISODE_STEP) + 1;

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

/**
 * And the episodes get a third stream, off the same seed.
 *
 * The same argument the squalls make against sharing the wind's: an episode
 * roll happens when the last episode runs out, which is a clock this module
 * owns and no other, so drawing it from the squall stream would make the
 * sequence of squalls depend on how many waves of rain fell inside the last
 * one. Two streams that are never interleaved are two things that can be
 * reasoned about separately -- and a seed that reproduces a storm still
 * reproduces the rain inside it, because this is derived from that seed.
 */
const EPISODE_SEED_MIX = 0x9e3779b1;

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
  flashOrigin: Vector3 | null;
  flashSeed: number;
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
  /** The episode stream. See `EPISODE_SEED_MIX`. */
  const episodeRng = mulberry32((seed ^ EPISODE_SEED_MIX) >>> 0);
  // And warmed before anything reads it. `mulberry32` advances by a fixed
  // addend, so two seeds a few bits apart produce CORRELATED first outputs --
  // seeds 7, 11 and 23 all give a second draw under 0.09, which is the draw
  // that picks the level, so all three opened their first storm at the 20%
  // floor and looked like a bug rather than like a roll. The game runs one
  // seed and would never have shown it; the tests run many and did. Eight
  // discards is past where the correlation is visible, and costs eight
  // multiplies once.
  for (let i = 0; i < 8; i++) episodeRng();

  const state: MutableWeatherState = {
    kind: 'clear',
    cover: 0,
    rain: 0,
    storm: 0,
    fog: 0,
    flash: 0,
    flashLocal: false,
    flashOrigin: null,
    flashSeed: 0,
    visibility: RADAR_RANGE,
  };

  /**
   * Where a cell strike is, owned by this module and handed out through
   * `state.flashOrigin`.
   *
   * Copied from the cell rather than aliased to it: a cell's `centre` is
   * mutated in place as it drifts, and a bolt that followed it would slide
   * across the sky over the third of a second it is lit.
   */
  const flashOrigin = new Vector3();

  /** The phase the last roll was made for. -1 so the opening phase rolls. */
  let rolledIndex = -1;

  /** What the current event is, decided once when it began. */
  let squallStormClass = false;
  let squallLightningClass = false;
  /** What the current lull is, likewise. 0 when it is not foggy. */
  let squallFogDepth = 0;

  /**
   * The live rain episode: seconds left in it, the strength it was rolled at,
   * the strength actually being applied this frame, and which of the nine
   * levels the last roll picked so the next one can pick another.
   *
   * `episodeScale` is the smoothed one and the only one anything outside this
   * module ever feels. It idles at 1 -- full rain, the behaviour before any of
   * this existed -- so a `WeatherState` read before the first drop falls is
   * the one it always was.
   */
  let episodeLeft = 0;
  let episodeTarget = 1;
  let episodeScale = 1;
  let episodeLevel = -1;

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
   * One episode roll, made when the last one runs out.
   *
   * TWO draws, always, and in this order -- the length, then the level -- for
   * the reason `roll` above records about its own pair: a draw count that
   * varied would make the stream depend on the thing it is meant to be
   * independent of.
   *
   * The parent duration is the wind phase when the rain is a squall's, and the
   * nominal span when it is a cell's. See `RAIN_EPISODE_SPAN`: a cell has no
   * duration to be half of, and inventing one out of its drift would be a
   * guess dressed as a measurement.
   */
  function rollEpisode(wind: WindState): void {
    const parent =
      squallStormClass && wind.phase === 'event' ? wind.phaseDuration : RAIN_EPISODE_SPAN;
    // `max`, so a phase shorter than two seconds still yields an episode of
    // the floor rather than one of half a second or of a negative length.
    const longest = Math.max(RAIN_EPISODE_MIN, parent * RAIN_EPISODE_SHARE);
    episodeLeft = RAIN_EPISODE_MIN + episodeRng() * (longest - RAIN_EPISODE_MIN);

    // One of the nine levels, never the one it is replacing: draw from the
    // eight others and shift past the hole. A plain re-roll loop would draw a
    // variable number of times, which is the trap the comment above is about.
    const choices = episodeLevel >= 0 ? RAIN_EPISODE_LEVELS - 1 : RAIN_EPISODE_LEVELS;
    let idx = Math.min(choices - 1, Math.floor(episodeRng() * choices));
    if (episodeLevel >= 0 && idx >= episodeLevel) idx++;
    episodeLevel = idx;
    episodeTarget = clamp01(RAIN_EPISODE_FLOOR + idx * RAIN_EPISODE_STEP);
  }

  /**
   * The episode clock, and the multiplier it comes to.
   *
   * Runs only while rain is actually falling. `state.rain` is exactly 0 below
   * `RAIN_ONSET` -- `smoothstep01` clamps -- so "falling" needs no epsilon of
   * its own, and a dry stretch resets the clock rather than running it, which
   * is what makes the first frame of the next rain roll a fresh episode
   * instead of finishing the one the last storm was halfway through.
   *
   * `episodeLevel` is cleared with it, so the first episode of a new rain may
   * be any of the nine. The exclusion is between neighbours inside one rain,
   * and two rains an hour apart are not neighbours.
   */
  function updateEpisode(dt: number, raining: boolean, wind: WindState): void {
    if (raining) {
      episodeLeft -= dt;
      if (episodeLeft <= 0) rollEpisode(wind);
    } else {
      episodeLeft = 0;
      episodeLevel = -1;
    }
    // Eased toward the roll, never stepped. See `RAIN_EPISODE_TAU`. The scale
    // is left where it is across a dry stretch rather than pulled back to 1:
    // nothing reads it while `state.rain` is 0, and the next rain rolls its
    // own target on its first frame anyway.
    episodeScale += (episodeTarget - episodeScale) * (1 - Math.exp(-dt / RAIN_EPISODE_TAU));
  }

  /**
   * Lightning, in bursts.
   *
   * The gate is a pure function of already-replayed state — the storm depth,
   * and whether either source is a lightning one — so the per-frame draw
   * below cannot desynchronise a replay that agrees about everything else.
   */
  function updateFlash(
    dt: number,
    lightningLive: boolean,
    local: boolean,
    cells: CellsState,
  ): void {
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
      if (strikeAge > strikePulses * FLASH_GAP + 6 * FLASH_DECAY) {
        strikeAge = -1;
        // The place and the shape go with it. Nothing reads either while
        // `flash` is 0, but leaving last strike's numbers standing would make
        // the state lie about what is happening.
        state.flashOrigin = null;
        state.flashSeed = 0;
      }
    } else {
      state.flash = 0;
    }

    if (!lightningLive || state.storm <= FLASH_GATE) return;
    if (strikeAge >= 0) return;
    // Poisson: one strike per FLASH_MEAN seconds on average.
    if (rng() < dt / FLASH_MEAN) {
      strikeAge = 0;
      strikePulses = rng() < 0.5 ? 2 : 3;
      // All three recorded at the moment of the strike, not read per frame: a
      // cell drifting off the ship mid-flash must not turn that flash into a
      // placeless one halfway through its own decay, nor drag its bolt across
      // the sky, nor reshape it.
      state.flashLocal = local;
      // The bolt's shape comes off this module's own stream, so a replay that
      // agrees about the weather agrees about the lightning down to the fork.
      state.flashSeed = (rng() * 0xffffffff) >>> 0;
      // A squall is wherever the ship is and gets no origin at all; a cell
      // strike is at the cell that is doing the striking, copied out of it so
      // the cell's own drift cannot move a bolt that is already lit.
      const cell = local ? null : cells.stormCellAtShip;
      if (cell) {
        flashOrigin.copy(cell.centre);
        state.flashOrigin = flashOrigin;
      } else {
        state.flashOrigin = null;
      }
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
      // And the episode clock is off with the roll, for the same reason the
      // roll is: `?weather=rain` has to photograph the same rain every time,
      // and a pinned shot taken during a 20% wave would be a different picture
      // from one taken during a 100% wave with nothing in the URL to say so.
      // A pin is the rain at full, which is what it has always been.
      const p = PINS[pin];
      state.cover = Math.max(p.cover, cells.stormAtShip);
      state.storm = Math.max(p.storm, cells.stormAtShip);
      state.rain = Math.max(p.rain, smoothstep01((state.storm - RAIN_ONSET) / (1 - RAIN_ONSET)));
      state.fog = Math.max(p.fog, cells.fogAtShip);
      // A pinned flash is placeless: `?weather=lightning` is for looking at
      // the effect, and it should light the sky whether a cell is there or not.
      updateFlash(dt, pin === 'lightning' || cells.lightningAtShip, pin === 'lightning', cells);
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

      // Then cut into episodes -- waves of harder and lighter rain inside the
      // one storm. The scale is applied to the ENVELOPE and not to the drops,
      // so an easing wave eases everything rain drives at once: the curtain in
      // `rain.ts`, the wet darkening of the distance through `uRainHere`, the
      // scope's own range below, and the label. A drizzle you can see further
      // through is the whole reason it is here rather than in `rain.ts`.
      updateEpisode(dt, state.rain > 0, wind);
      state.rain *= episodeScale;

      updateFlash(dt, squallLightningClass || cells.lightningAtShip, squallLightningClass, cells);
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
export {
  VIS_MIN,
  FLASH_GATE,
  STORM_SHARE,
  LIGHTNING_SHARE,
  FOG_SHARE,
  FOG_MIN_LULL,
  RAIN_ONSET,
  RAIN_EPISODE_MIN,
  RAIN_EPISODE_SHARE,
  RAIN_EPISODE_SPAN,
  RAIN_EPISODE_FLOOR,
  RAIN_EPISODE_STEP,
  RAIN_EPISODE_LEVELS,
};
