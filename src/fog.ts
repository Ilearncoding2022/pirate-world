import * as THREE from 'three';
import type { WorldEnv } from './env';

/**
 * Owner of the three uniforms `fogglsl.ts`'s `applyAerial` reads.
 *
 * One shared object rather than one per material: every caller (the water's
 * `colour` hook now, `land.ts` once Stream C lands) merges these into its own
 * `uniforms` map, so there is exactly one place that writes the fog colours
 * and density and every shader agrees on them within a frame — the same
 * pattern `env.ts` uses for the sun.
 *
 * `applyAerial`'s body is currently the identity (see `fogglsl.ts`), so
 * nothing yet reads these values; they are set up now so Stream E only has to
 * write the blend, never the plumbing.
 */
export const fogUniforms = {
  uFogColorDay: { value: new THREE.Color('#7ba4d4') },
  uFogColorNight: { value: new THREE.Color('#02101c') },
  /**
   * World-scale: distance-based fog has to fall off over a fraction of the
   * globe, not a fixed number of world units, or the horizon haze would
   * shrink to nothing the first time GLOBE_RADIUS grew. Stream E's opening
   * bid is `0.8 / GLOBE_RADIUS`; left at a plain placeholder here since the
   * body that would read it is still the identity function.
   */
  uFogDensity: { value: 0.004 },
};

/**
 * Refreshes `fogUniforms` from this frame's environment.
 *
 * Called from `globe.update`, before water and land, so both shaders sample
 * the same fog colours `dayNight.update` just wrote into `env` — the same
 * ordering rule `env.ts` documents for the sun.
 */
export function updateFog(env: WorldEnv): void {
  // Placeholder tuning: track the sun colour so the day endpoint is already
  // in the right neighbourhood once Stream E writes the real blend. No
  // allocation: `copy` writes into the uniform's own Color in place.
  fogUniforms.uFogColorDay.value.copy(env.sunColor);
}
