import type { WorldEnv } from './env';
import { GLOBE_RADIUS } from './geo';
import { ATMOSPHERE_COLOR } from './sky';

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
export function updateFog(env: WorldEnv): void {
  fogUniforms.uFogColorDay.value.copy(ATMOSPHERE_COLOR).lerp(env.sunColor, FOG_DAY_SUN_WEIGHT);
}
