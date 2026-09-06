/**
 * Wave-field numbers shared between the GPU shader (`waterglsl.ts`, assembled
 * by `water.ts` for the sphere and by `waterpatch.ts` for the ship-following
 * displacement patch) and the CPU port of the same field (`wavefield.ts`),
 * so the three can never drift out of numeric agreement -- the whole point
 * of Phase 1 stream B is that the hull rides the SAME sea the player sees.
 *
 * This file used to be three constants inside `water.ts` (the wavelengths)
 * plus two inside `waterglsl.ts` (the stretch axes). Moving them here is a
 * pure move: the values are unchanged, only their address is shared.
 */
import { GLOBE_RADIUS } from './geo';

/**
 * Wavelengths in world units (world-scale: see docs/ARCHITECTURE.md "World
 * scale" -- these are converted to 1/radian frequencies below, exactly as
 * `water.ts` always did, so the look does not change when GLOBE_RADIUS does).
 * The ship is ~5.6 long, so WAVE is hull sized.
 */
export const SWELL_WAVELENGTH = 22;
export const WAVE_WAVELENGTH = 5.9;
export const CHOP_WAVELENGTH = 1.7;

/**
 * Frequency in 1/radian for a wavelength given in world units, formatted to
 * the same 4-decimal precision `water.ts` always baked into the GLSL
 * constant -- `wavefield.ts` rounds to this same precision (see
 * `freqNumber`) so the CPU port matches the literal the shader actually
 * compiles, not the more precise ratio it was rounded from.
 */
export function freq(wavelengthWorld: number): string {
  return (GLOBE_RADIUS / wavelengthWorld).toFixed(4);
}

/** `freq()`, parsed back to a number -- what the CPU port bakes in for parity. */
export function freqNumber(wavelengthWorld: number): number {
  return Number(freq(wavelengthWorld));
}

/**
 * Two fixed world axes the WAVE and CHOP noise domains are stretched along.
 * A plain 3x3 scale is continuous over the whole sphere, so unlike a
 * tangent-frame stretch it introduces no pole singularity, and the two axes
 * crossing is what makes the crests read as two interfering wave trains.
 * Both are unit vectors. Direction-space: no world-scale conversion applies.
 */
export const AXIS_WAVE: readonly [number, number, number] = [0.42, 0.78, -0.46];
export const AXIS_CHOP: readonly [number, number, number] = [-0.71, 0.35, 0.61];

/** Formats a fixed 3-vector as a GLSL `vec3(...)` literal, for the shader chunk. */
export function vec3Literal(v: readonly [number, number, number]): string {
  return `vec3(${v[0]}, ${v[1]}, ${v[2]})`;
}

/**
 * Vertical displacement at a full gale, world units (ship-scale: this is an
 * absolute height, not a fraction of the globe). Multiplied by `uWaveIntensity`
 * (0..1, from the wind) and by the patch's skirt fade in `waterpatch.ts`'s
 * vertex shader; `ship.ts` uses the identical number so the hull's heave never
 * disagrees with the surface the patch actually draws.
 */
export const DISPLACE_AMPLITUDE = 0.3;
