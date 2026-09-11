import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  createWeather,
  FOG_MIN_LULL,
  FOG_SHARE,
  LIGHTNING_SHARE,
  STORM_SHARE,
  VIS_MIN,
  RAIN_ONSET,
  RAIN_EPISODE_FLOOR,
  RAIN_EPISODE_STEP,
  RAIN_EPISODE_LEVELS,
  RAIN_EPISODE_MIN,
  RAIN_EPISODE_SHARE,
} from '../../src/weather';
import { RADAR_RANGE } from '../../src/radar';
import type { CellsState, WindState } from '../../src/types';

/**
 * `weather.ts` against a SCRIPTED wind and scripted cells. No terrain, no
 * height map and no PRNG but its own: the whole point of this module is that
 * it is a function of the wind's phases and the cells' sample, so the test
 * drives both directly rather than waiting for the real ones to produce the
 * case it wants.
 */
const NO_CELLS: CellsState = {
  live: [],
  stormAtShip: 0,
  fogAtShip: 0,
  lightningAtShip: false,
  stormCellAtShip: null,
};

function cells(storm: number, fog: number, lightning = false): CellsState {
  return {
    live: [],
    stormAtShip: storm,
    fogAtShip: fog,
    lightningAtShip: lightning,
    stormCellAtShip: null,
  };
}

/** A wind whose phase machine the test drives by hand. */
function scriptedWind(): WindState & {
  phase: 'lull' | 'event';
  phaseTime: number;
  phaseDuration: number;
  phaseIndex: number;
  envelope: number;
} {
  return {
    speed: 1,
    bearing: 0,
    direction: new Vector3(0, 0, 1),
    cap: 10.4,
    along: 0,
    across: 0,
    phase: 'lull',
    phaseTime: 0,
    phaseDuration: 10,
    phaseIndex: 0,
    envelope: 0,
  };
}

/**
 * Run one scripted phase to its end, returning the peak of each envelope
 * reached inside it.
 */
function runPhase(
  weather: ReturnType<typeof createWeather>,
  wind: ReturnType<typeof scriptedWind>,
  phase: 'lull' | 'event',
  duration: number,
  cellState: CellsState = NO_CELLS,
  dt = 0.05,
): { storm: number; fog: number; rain: number; cover: number; flash: number } {
  wind.phaseIndex++;
  wind.phase = phase;
  wind.phaseDuration = duration;
  wind.phaseTime = 0;
  const peak = { storm: 0, fog: 0, rain: 0, cover: 0, flash: 0 };
  const fade = Math.min(2, duration * 0.25);
  for (let t = 0; t < duration; t += dt) {
    wind.phaseTime = t;
    // The wind's own ramp, reproduced: rise and fall over a clamped fade.
    wind.envelope =
      phase === 'event'
        ? Math.max(0, Math.min(1, Math.min(t / fade, (duration - t) / fade)))
        : 0;
    weather.update(dt, wind, cellState);
    peak.storm = Math.max(peak.storm, weather.state.storm);
    peak.fog = Math.max(peak.fog, weather.state.fog);
    peak.rain = Math.max(peak.rain, weather.state.rain);
    peak.cover = Math.max(peak.cover, weather.state.cover);
    peak.flash = Math.max(peak.flash, weather.state.flash);
  }
  return peak;
}

/**
 * The rain an un-episoded storm would have produced: `weather.ts`'s own
 * formula, so a test can divide it out and look at the episode multiplier by
 * itself. Kept here rather than exported from the module, because a helper
 * that imported the answer could not catch the answer changing.
 */
function baseRain(storm: number): number {
  const t = Math.max(0, Math.min(1, (storm - RAIN_ONSET) / (1 - RAIN_ONSET)));
  return t * t * (3 - 2 * t);
}

/**
 * Every episode multiplier a scripted storm passed through, sampled per frame
 * and only while it is actually raining hard enough to divide by.
 */
function episodeTrace(seed: number, duration = 90, dt = 0.05): number[] {
  const weather = createWeather(seed);
  const wind = scriptedWind();
  const out: number[] = [];
  // Walk phases until a storm-class one turns up, then record inside it.
  for (let k = 0; k < 60; k++) {
    wind.phaseIndex++;
    wind.phase = 'event';
    wind.phaseDuration = duration;
    wind.phaseTime = 0;
    const fade = Math.min(2, duration * 0.25);
    const frames: number[] = [];
    let peakStorm = 0;
    for (let t = 0; t < duration; t += dt) {
      wind.phaseTime = t;
      wind.envelope = Math.max(0, Math.min(1, Math.min(t / fade, (duration - t) / fade)));
      weather.update(dt, wind, NO_CELLS);
      peakStorm = Math.max(peakStorm, weather.state.storm);
      const base = baseRain(weather.state.storm);
      if (base > 0.5) frames.push(weather.state.rain / base);
    }
    if (peakStorm > 0.9) {
      out.push(...frames);
      break;
    }
  }
  return out;
}

describe('weather', () => {
  it('turns about a quarter of events into storms and a tenth into lightning', () => {
    const weather = createWeather(9001);
    const wind = scriptedWind();
    let storms = 0;
    let lightning = 0;
    const N = 400;

    for (let i = 0; i < N; i++) {
      const peak = runPhase(weather, wind, 'event', 20);
      // A storm-class event drives the storm envelope up; a plain one leaves
      // it at the floor its cover ramp implies, which is nothing.
      if (peak.storm > 0.5) storms++;
      if (peak.flash > 0) lightning++;
      // The lull between, so each event starts from a settled sky.
      runPhase(weather, wind, 'lull', 12);
    }

    expect(storms / N).toBeGreaterThan(STORM_SHARE - 0.05);
    expect(storms / N).toBeLessThan(STORM_SHARE + 0.05);
    // Lightning is the top of the same distribution, so it is a subset.
    expect(lightning).toBeLessThanOrEqual(storms);
    expect(lightning / N).toBeGreaterThan(LIGHTNING_SHARE - 0.03);
    expect(lightning / N).toBeLessThan(LIGHTNING_SHARE + 0.03);
  });

  it('fogs about a third of long lulls and none at all of short ones', () => {
    const long = createWeather(4242);
    const windLong = scriptedWind();
    let fogged = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      if (runPhase(long, windLong, 'lull', 12).fog > 0.2) fogged++;
      runPhase(long, windLong, 'event', 8);
    }
    expect(fogged / N).toBeGreaterThan(FOG_SHARE - 0.05);
    expect(fogged / N).toBeLessThan(FOG_SHARE + 0.05);

    // A lull shorter than FOG_MIN_LULL never fogs: it would be spent entirely
    // in the fade and read as a grey flicker.
    const short = createWeather(4242);
    const windShort = scriptedWind();
    for (let i = 0; i < N; i++) {
      expect(runPhase(short, windShort, 'lull', FOG_MIN_LULL - 3).fog).toBeLessThan(0.05);
      runPhase(short, windShort, 'event', 8);
    }
  });

  it('never lets a squall out-run the wind that carries it, and never fogs an event', () => {
    const weather = createWeather(777);
    const wind = scriptedWind();
    const dt = 0.05;

    /*
     * The storm EASES toward the wind's ramp, so it lags in both directions:
     * behind on the way up, and deliberately still high a beat after the gale
     * has gone. That lag is the design, so "never above the ramp" is the
     * wrong claim and any fixed tolerance on it is a fudge.
     *
     * The exact invariant of an exponential ease is that it never lands
     * outside the interval between where it was and where it is going. With
     * no cells the target is the wind's own ramp, so this is the whole
     * contract: the storm is either falling, or climbing toward the ramp, and
     * never anywhere the wind is not taking it.
     */
    let previous = 0;
    for (let i = 0; i < 60; i++) {
      wind.phaseIndex++;
      wind.phase = i % 2 === 0 ? 'event' : 'lull';
      wind.phaseDuration = 20;
      const fade = 2;
      for (let t = 0; t < wind.phaseDuration; t += dt) {
        wind.phaseTime = t;
        wind.envelope =
          wind.phase === 'event'
            ? Math.max(0, Math.min(1, Math.min(t / fade, (wind.phaseDuration - t) / fade)))
            : 0;
        weather.update(dt, wind, NO_CELLS);
        expect(weather.state.storm).toBeLessThanOrEqual(Math.max(previous, wind.envelope) + 1e-9);
        previous = weather.state.storm;
        // And an event is never foggy: fog belongs to the quiet phase.
        if (wind.phase === 'event' && t > 5) expect(weather.state.fog).toBeLessThan(0.05);
      }
    }
  });

  it('takes the max of squall and cell, so a cell alone can make a storm in a lull', () => {
    const weather = createWeather(31337);
    const wind = scriptedWind();
    // A dead lull, and a storm cell sitting right on top of the ship.
    const peak = runPhase(weather, wind, 'lull', 40, cells(1, 0, true));
    expect(peak.storm).toBeGreaterThan(0.9);
    expect(peak.rain).toBeGreaterThan(0.5);
    expect(peak.cover).toBeGreaterThan(0.8);
    // Lightning follows the cell's own flag, not the squall's class.
    expect(peak.flash).toBeGreaterThan(0);
  });

  it('rains under a moderate storm, and still darkens the sky before it does', () => {
    // The onset is what decides whether ordinary weather is ever wet. At the
    // quarter it opened at, a storm that peaked at 0.3 produced a rain
    // envelope of 0.02 -- a greyed sky and no drops, which read as a storm
    // that never turned up. These two assertions are the whole of the rule:
    // moderate weather rains, and the sky is always ahead of the rain.
    const weather = createWeather(4242);
    const wind = scriptedWind();
    const peak = runPhase(weather, wind, 'lull', 40, cells(0.35, 0, false));
    // 0.19 at the tenth, against 0.05 at the quarter -- a storm a third of the
    // way up now rains about four times as hard, which is the difference
    // between a curtain and a rumour of one.
    expect(peak.rain).toBeGreaterThan(0.15);
    // The lead-in survives: cover is a slower envelope than rain, and rain is
    // the storm with its first tenth cut off, so the sky is never behind the
    // weather.
    expect(peak.cover).toBeGreaterThan(peak.rain);

    // And the cut is still there at the bottom: a whisper of a storm is dry.
    const faint = createWeather(4242);
    const faintWind = scriptedWind();
    const faintPeak = runPhase(faint, faintWind, 'lull', 40, cells(0.08, 0, false));
    expect(faintPeak.rain).toBe(0);
  });

  it('rains in episodes: waves of 20% to 100%, a tenth at a time', () => {
    // The shape of the feature. A storm's rain is cut into episodes and each
    // one is rolled to one of nine levels, so the multiplier over a long
    // storm visits several plainly different strengths and never leaves the
    // band -- it is a wave of rain, not a rain that stops.
    const trace = episodeTrace(4242);
    expect(trace.length).toBeGreaterThan(100);
    const lo = Math.min(...trace);
    const hi = Math.max(...trace);
    expect(lo).toBeGreaterThanOrEqual(RAIN_EPISODE_FLOOR - 1e-6);
    expect(hi).toBeLessThanOrEqual(1 + 1e-6);
    // Two episodes at least, and the rule that neighbours differ means two
    // episodes differ by a tenth at the very least. In practice far more.
    expect(hi - lo).toBeGreaterThan(RAIN_EPISODE_STEP - 1e-6);
    // Every level it SETTLES on is one of the nine. Sampled where the trace
    // is flat, since the ramp between two levels passes through every value
    // in between by design.
    for (let i = 1; i < trace.length; i++) {
      if (Math.abs(trace[i] - trace[i - 1]) > 1e-6) continue;
      const tenths = (trace[i] - RAIN_EPISODE_FLOOR) / RAIN_EPISODE_STEP;
      expect(Math.abs(tenths - Math.round(tenths))).toBeLessThan(0.02);
      expect(Math.round(tenths)).toBeGreaterThanOrEqual(0);
      expect(Math.round(tenths)).toBeLessThan(RAIN_EPISODE_LEVELS);
    }
  });

  it('eases between episodes rather than stepping', () => {
    // `RAIN_EPISODE_TAU`, and the reason it exists: this multiplier scales the
    // drops, the haze and the scope's own range together, so a step would take
    // the visible world from a downpour to a drizzle between two frames.
    const dt = 0.05;
    const trace = episodeTrace(4242, 90, dt);
    let worst = 0;
    for (let i = 1; i < trace.length; i++) {
      worst = Math.max(worst, Math.abs(trace[i] - trace[i - 1]));
    }
    // One frame may move the scale by at most `dt / tau` of the full range,
    // and the full range is 0.8. Well under a tenth either way.
    expect(worst).toBeLessThan(0.05);
  });

  it('fits at least two episodes into the rain that carries them', () => {
    // An episode is at most half its wind phase, so a phase always holds two
    // or more -- an episode allowed to fill the whole event would be the old
    // single-strength rain wearing a new name. Counted as settled plateaus,
    // which is what an episode looks like from outside.
    const dt = 0.05;
    const trace = episodeTrace(4242, 40, dt);
    const plateaus: number[] = [];
    for (let i = 1; i < trace.length; i++) {
      if (Math.abs(trace[i] - trace[i - 1]) > 1e-6) continue;
      if (plateaus.length === 0 || Math.abs(plateaus[plateaus.length - 1] - trace[i]) > 1e-6) {
        plateaus.push(trace[i]);
      }
    }
    expect(plateaus.length).toBeGreaterThanOrEqual(2);
    // And no episode is shorter than the floor: the shortest plateau-to-
    // plateau stretch, plus the ramp it took to get there, is at least
    // `RAIN_EPISODE_MIN`. Checked on the bound rather than by timing each
    // one, since the ramp belongs to the episode it is arriving at.
    expect(RAIN_EPISODE_MIN).toBe(1);
    expect(RAIN_EPISODE_SHARE).toBe(0.5);
  });

  it('never lets an episode stop the rain, and never raises it past the storm', () => {
    // The floor is 20% and not 0: rain that stops dead and restarts is two
    // rains, and the gap between them belongs to the storm envelope. The
    // ceiling is the storm's own rain, so an episode can only ever take away.
    const trace = episodeTrace(4242);
    for (const scale of trace) {
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('leaves a pinned rain alone, so a shot is the same shot every time', () => {
    // `?weather=rain` has to photograph one rain. The episode clock is off
    // under a pin for the same reason the squall roll is.
    const pinned = createWeather(7, 'rain');
    const wind = scriptedWind();
    const seen = new Set<number>();
    for (let t = 0; t < 60; t += 0.05) {
      pinned.update(0.05, wind, NO_CELLS);
      seen.add(Math.round(pinned.state.rain * 1e6));
    }
    expect(seen.size).toBe(1);
    expect(pinned.state.rain).toBeCloseTo(0.7, 6);
  });

  it('shrinks visibility with fog and rain, and never past the floor', () => {
    const weather = createWeather(5);
    const wind = scriptedWind();

    // Clear: the scope is exactly what it always was. This is the zero
    // contract -- at all-zero envelopes nothing downstream may see a change.
    runPhase(weather, wind, 'lull', 20);
    expect(weather.state.storm).toBeLessThan(1e-3);
    expect(weather.state.fog).toBeLessThan(1e-3);
    expect(weather.state.visibility).toBeCloseTo(RADAR_RANGE, 3);
    expect(weather.state.kind).toBe('clear');

    // Thick fog and a heavy storm together, held long enough to settle.
    for (let i = 0; i < 8; i++) runPhase(weather, wind, 'lull', 30, cells(1, 1, false));
    expect(weather.state.visibility).toBeGreaterThanOrEqual(VIS_MIN);
    expect(weather.state.visibility).toBeLessThan(RADAR_RANGE * 0.35);
    expect(weather.state.kind).toBe('fog');
  });

  it('holds the flash inside its gate and inside [0, 1]', () => {
    const weather = createWeather(24680);
    const wind = scriptedWind();

    // A storm with no lightning in it: dark and wet, and never lit.
    for (let i = 0; i < 6; i++) {
      const peak = runPhase(weather, wind, 'lull', 30, cells(1, 0, false));
      expect(peak.flash).toBe(0);
    }

    // And one with lightning: lit, in bursts, never over 1.
    let lit = 0;
    for (let i = 0; i < 6; i++) {
      const peak = runPhase(weather, wind, 'lull', 30, cells(1, 0, true));
      expect(peak.flash).toBeLessThanOrEqual(1);
      if (peak.flash > 0) lit++;
    }
    expect(lit).toBeGreaterThan(0);
  });

  it('pins the envelopes under ?weather=, and clear pins to exactly today', () => {
    const wind = scriptedWind();

    const storm = createWeather(1, 'storm');
    runPhase(storm, wind, 'lull', 10);
    expect(storm.state.storm).toBe(1);
    expect(storm.state.rain).toBe(1);
    expect(storm.state.kind).toBe('storm');

    // `clear` is the regression pin: every envelope zero and the scope whole.
    const clear = createWeather(1, 'clear');
    runPhase(clear, wind, 'event', 30);
    expect(clear.state.storm).toBe(0);
    expect(clear.state.rain).toBe(0);
    expect(clear.state.fog).toBe(0);
    expect(clear.state.cover).toBe(0);
    expect(clear.state.flash).toBe(0);
    expect(clear.state.visibility).toBe(RADAR_RANGE);
    expect(clear.state.kind).toBe('clear');
  });

  it('replays: the same seed and the same script give the same trace', () => {
    function trace(): string[] {
      const weather = createWeather(0xbeef);
      const wind = scriptedWind();
      const out: string[] = [];
      for (let i = 0; i < 60; i++) {
        const peak = runPhase(weather, wind, i % 2 === 0 ? 'event' : 'lull', 14);
        out.push(
          `${peak.storm.toFixed(6)}:${peak.fog.toFixed(6)}:${peak.cover.toFixed(6)}:${peak.flash.toFixed(6)}`,
        );
      }
      return out;
    }
    expect(trace()).toEqual(trace());
  });
});
