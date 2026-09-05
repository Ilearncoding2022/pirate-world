import { Color, Vector3 } from 'three';

/**
 * Shared, mutable world environment.
 *
 * `daynight.ts` is the sole writer. Every other world module receives it as a
 * read-only input to `update(dt, env)`. Never reassign the object or its
 * Vector3/Color fields; mutate them in place so consumers can hold references.
 */
export interface WorldEnv {
  /** Unit vector from the globe centre toward the sun, in world space. */
  readonly sunDirection: Vector3;
  /** Current sun tint. Warmer near the horizon, white at noon. */
  readonly sunColor: Color;
  /** Seconds since the world was created. Use for shader animation. */
  elapsed: number;
  /** Progress through one full day, in [0, 1). 0 = sun over lon 0. */
  timeOfDay: number;
  /**
   * How lit the sub-camera side of the planet is, in [0, 1].
   * 0 = deep night, 1 = full day. Useful for fading night-only effects.
   */
  dayFactor: number;
}

export function createEnv(): WorldEnv {
  return {
    sunDirection: new Vector3(0.62, 0.42, 0.66).normalize(),
    sunColor: new Color('#fff2d6'),
    elapsed: 0,
    timeOfDay: 0,
    dayFactor: 1,
  };
}
