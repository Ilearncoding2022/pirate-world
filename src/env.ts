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
  /**
   * Unit vector from the globe centre toward the moon, in world space.
   *
   * The moon keeps its own orbit rather than sitting opposite the sun, so this
   * is not derivable from `sunDirection` and has to be carried here.
   */
  readonly moonDirection: Vector3;
  /**
   * Illuminated fraction of the moon's disc, [0, 1]. 0 is new, 1 is full.
   *
   * Derived from the angle between `sunDirection` and `moonDirection`, so the
   * number and the lit sphere `celestial.ts` draws can never disagree -- the
   * same discipline `solartime.ts` follows in taking elevation from a dot
   * product rather than from a clock.
   */
  moonIllumination: number;
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
    moonDirection: new Vector3(-0.62, 0.42, -0.66).normalize(),
    moonIllumination: 1,
    elapsed: 0,
    timeOfDay: 0,
    dayFactor: 1,
  };
}
