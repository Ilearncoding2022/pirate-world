import { Color } from 'three';
import type { WorldEnv } from './env';
import type { WeatherState } from './types';
import { GLOBE_RADIUS } from './geo';
import { ATMOSPHERE_COLOR, skyHorizonColor } from './sky';

/**
 * Aerial-perspective density, as a FRACTION OF GLOBE_RADIUS (world-scale).
 *
 * `applyAerial` (`fogglsl.ts`) uses this as the base rate in
 * `FOG_MAX_AMOUNT * (1 - exp(-dist * density))`, so it has to fall off over a
 * fraction of the globe rather than a fixed number of world units -- written
 * literally it would leave the same absolute haze at the horizon whatever
 * `GLOBE_RADIUS` was, when the horizon itself moves with the radius.
 *
 * The first version of this constant was `0.8 / GLOBE_RADIUS` (0.004 at
 * GLOBE_RADIUS = 200) and was wrong: combined with `FOG_GRAZE_BOOST` and no
 * ceiling, `1 - exp(-200 * 0.004)` alone is already 0.55, so the whole ocean
 * washed pale well before mid zoom, erasing the depth ramp
 * (`uShallow`..`uAbyss` in `water.ts`) that is one of the most deliberately
 * tuned things in the project. `fogglsl.ts` now also caps the blend at
 * `FOG_MAX_AMOUNT` and fades the whole effect with camera altitude, so 2.0 is
 * calibrated against those two together rather than against this rate alone
 * -- see `fogglsl.ts`'s comments on both.
 */
const FOG_DENSITY = 2.0 / GLOBE_RADIUS;

/**
 * How much of the day fog colour is the sun's own current tint, versus the
 * atmosphere shell's base blue. A blend weight in [0, 1], not a world- or
 * ship-scale number -- 0 would leave the haze permanently sky-blue, 1 would
 * make it the sun's colour outright and lose the atmosphere tint entirely at
 * noon. 0.35 keeps the haze blue with a warm edge that grows as the sun does
 * near the horizon, since `env.sunColor` itself warms there.
 */
const FOG_DAY_SUN_WEIGHT = 0.35;

/**
 * How much of the day fog colour is the sky's own horizon, versus the blend of
 * atmosphere blue and sun tint above.
 *
 * There is a real sky now, and the sea has to fade into the colour that sky
 * actually is at the horizon rather than into a constant that merely used to
 * resemble it. Without this the two disagree most at dawn -- exactly when the
 * horizon is the thing the player is looking at -- and the join shows as a
 * seam. 0.25, and no more: the first attempt used 0.55 and washed the whole
 * ocean pale at noon, erasing the `uShallow`..`uAbyss` depth ramp that the
 * comment on FOG_DENSITY above already records losing once before to exactly
 * this mistake. The sea has to fade toward the sky, not turn into it.
 */
const FOG_SKY_WEIGHT = 0.25;

/** Scratch for the horizon colour, so `updateFog` allocates nothing. */
const _horizon = new Color();

/**
 * The resting value of `uFogMax`, and the one `fogglsl.ts` documents at
 * length as `FOG_MAX_AMOUNT`.
 *
 * It is a uniform now rather than a constant, but this is still the number
 * every one of that comment's screenshots was taken against, and clear
 * weather still renders at exactly it. A fog bank raises the ceiling toward
 * `FOG_MAX_BANK`; nothing lowers it.
 */
const FOG_MAX_CLEAR = 0.15;

/**
 * The colour a fog bank fades toward.
 *
 * Deliberately not the sky's blue and not the atmosphere's. Fog is water in
 * the air: it takes the colour OUT of what is behind it rather than tinting
 * it, so the endpoint is a flat pale grey with barely any hue at all. A bank
 * that faded toward `ATMOSPHERE_COLOR` would read as an unusually blue
 * distance rather than as air you cannot see through.
 *
 * It is a CONSTANT uniform, and the two day/night colours above are left
 * alone. That is not a detail: `battlescene.ts` merges this same
 * `fogUniforms` object, and while a fight is up `globe.update` does not run,
 * so anything written here during a storm would FREEZE into the arena's haze
 * for the length of the fight. The greying happens per fragment inside
 * `applyAerial` instead, weighted by a `wx` the arena passes as zero, so a
 * fight looks like a fight whatever the sea outside is doing.
 */
const FOG_BANK_COLOR = new Color('#aeb4b8');

/**
 * Night fog colour, as a fraction of the atmosphere shell's own brightness.
 * A dimensionless multiplier -- there is no sun to tint the haze warm once it
 * is this dark, so night fog is just the atmosphere's hue turned most of the
 * way down rather than a second, unrelated colour.
 */
const FOG_NIGHT_DARKEN = 0.08;

/**
 * Owner of the three uniforms `fogglsl.ts`'s `applyAerial` reads.
 *
 * One shared object rather than one per material: every caller (the water's
 * `colour` hook now, `land.ts` once Stream C lands) merges these into its own
 * `uniforms` map, so there is exactly one place that writes the fog colours
 * and density and every shader agrees on them within a frame — the same
 * pattern `env.ts` uses for the sun.
 */
export const fogUniforms = {
  uFogColorDay: { value: ATMOSPHERE_COLOR.clone() },
  uFogColorNight: { value: ATMOSPHERE_COLOR.clone().multiplyScalar(FOG_NIGHT_DARKEN) },
  uFogDensity: { value: FOG_DENSITY },
  /**
   * The ceiling `applyAerial` blends toward, which used to be a GLSL constant
   * and is now a uniform so a fog bank can raise it. Its resting value is that
   * constant, so a build with no weather in it renders what it always did.
   */
  uFogMax: { value: FOG_MAX_CLEAR },
  /** The flat grey a bank fades toward. Constant; only its WEIGHT moves. */
  uFogBankColor: { value: FOG_BANK_COLOR.clone() },
  /**
   * The at-ship squall, for the half of the weather that has no place on the
   * map. Both 0 in clear weather, which is what makes every term above inert.
   */
  uFogHere: { value: 0 },
  uRainHere: { value: 0 },
};

/**
 * Refreshes `fogUniforms` from this frame's environment.
 *
 * Called from `globe.update`, before water and land, so both shaders sample
 * the same fog colours `dayNight.update` just wrote into `env` — the same
 * ordering rule `env.ts` documents for the sun.
 *
 * Both endpoints are driven from the atmosphere shell's own colour
 * (`sky.ts`'s `ATMOSPHERE_COLOR`) rather than a second, unrelated pair of
 * hexes, so the haze the sea fades into always matches the sky it is fading
 * toward. Only the day endpoint needs a per-frame update -- it leans toward
 * the sun's current tint, which is what lets the haze warm up at sunrise and
 * sunset with no special case here, since `env.sunColor` already carries
 * that warmth. The night endpoint is two constants multiplied together and
 * never changes, so it is set once at declaration above and left alone.
 */
export function updateFog(env: WorldEnv, weather?: WeatherState): void {
  fogUniforms.uFogColorDay.value.copy(ATMOSPHERE_COLOR).lerp(env.sunColor, FOG_DAY_SUN_WEIGHT);
  // Then pulled most of the way to the sky's own horizon. `skyHorizonColor`
  // mixes the dome's two horizon constants by `env.dayFactor`, which is the
  // same number the dome's shader mixes them by, so these cannot drift apart.
  fogUniforms.uFogColorDay.value.lerp(skyHorizonColor(env, _horizon), FOG_SKY_WEIGHT);

  /*
   * The weather, and nothing else in this file, is optional.
   *
   * A caller that passes no weather -- every test that predates it, and the
   * arena, which has weather of its own to not have -- leaves these three at
   * the values that make every weather term in `applyAerial` multiply out to
   * zero. That is the zero contract in its cheapest possible form: the
   * uniforms exist, and in clear weather they are the numbers the shader had
   * baked in before they were uniforms at all.
   */
  fogUniforms.uFogHere.value = weather ? weather.fog : 0;
  fogUniforms.uRainHere.value = weather ? weather.rain : 0;
  fogUniforms.uFogMax.value = FOG_MAX_CLEAR;
}
