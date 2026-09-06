import type { WorldEnv } from './env';
import { GLOBE_RADIUS } from './geo';
import { ATMOSPHERE_COLOR } from './sky';

/**
 * Aerial-perspective density, as a FRACTION OF GLOBE_RADIUS (world-scale).
 *
 * `applyAerial` (`fogglsl.ts`) uses this as the rate in
 * `1 - exp(-dist * uFogDensity)`, so it has to fall off over a fraction of
 * the globe rather than a fixed number of world units -- written literally as
 * `0.004` it would leave the horizon haze exactly as thick the moment
 * `GLOBE_RADIUS` doubled, when the horizon itself moved twice as far away.
 * 0.8 is the opening bid: at GLOBE_RADIUS = 200 it reproduces the same 0.004
 * the placeholder shipped with, so this change is silent until the radius
 * moves.
 */
const FOG_DENSITY = 0.8 / GLOBE_RADIUS;

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
