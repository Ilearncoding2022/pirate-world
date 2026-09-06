import * as THREE from 'three';
import type { WaterPlugin, WaterHook } from './water';
import type { WorldEnv } from './env';
import type { ShipState } from './types';
import { GLOBE_RADIUS } from './geo';
import { shipGlow } from './shipfx';

/**
 * The water's `reflection` and `colour` hooks for `reflection.ts`'s cubemap:
 * mixes the decoded cube into the sky colour along the wave's own reflection
 * vector, then paints a fake streak of the hull's neon under the ship, since
 * the hull itself cannot appear in a cube whose camera sits inside it.
 *
 * docs/RENDER_PLAN.md, Phase 1 Stream D.
 */

/**
 * Mix weight of the cube into `skyCol`, by day. Unitless (0-1): the water
 * shader's own blend fraction, not a world- or ship-scale quantity.
 *
 * Lower than night's because the flat `uSkyColor`/`uHorizonColor` gradient
 * already reads as sky in daylight, and the cube -- a 128-256px render of a
 * handful of unlit-by-day beacons and lights -- would otherwise fight it.
 */
const REFL_WEIGHT_DAY = 0.6;

/**
 * Mix weight of the cube into `skyCol`, by night. Unitless (0-1).
 *
 * Almost total: at night the flat sky colour is the one thing in this scene
 * that is NOT doing the work, and the whole point of this stream is that the
 * beacons, the lit sky shell and the town lights are what the water shows
 * instead.
 */
const REFL_WEIGHT_NIGHT = 1.0;

/**
 * Half-width of the fake hull-neon streak, world units (ship-scale: on the
 * order of the hull's own beam).
 */
const NEON_STREAK_WIDTH = 0.9;

/**
 * e-folding length of the streak fore and aft of the ship, world units
 * (ship-scale: a little over half the ~5.6-unit hull `water.ts` sizes WAVE
 * against), so it reads as light bleeding from under the hull rather than a
 * line drawn the length of the ship.
 */
const NEON_STREAK_LENGTH = 3.2;

/**
 * Gain on how much the wave-tilted normal breaks the streak up against the
 * flat surface normal, unitless. What makes it shimmer with the chop instead
 * of sitting on the water as a static decal.
 */
const NEON_BREAKUP_GAIN = 6.0;

export function createWaterReflectPlugin(cubeTexture: THREE.CubeTexture): WaterPlugin {
  const uniforms: Record<string, THREE.IUniform> = {
    uReflCube: { value: cubeTexture },
    uShipPos: { value: new THREE.Vector3() },
    uShipForward: { value: new THREE.Vector3(0, 0, 1) },
    uNeonColor: { value: new THREE.Color(shipGlow.color) },
    uNeonLevel: { value: 0 },
  };

  const declarations = [
    'uniform samplerCube uReflCube;',
    'uniform vec3 uShipPos;',
    'uniform vec3 uShipForward;',
    'uniform vec3 uNeonColor;',
    'uniform float uNeonLevel;',
    `const float REFL_WEIGHT_DAY = ${REFL_WEIGHT_DAY.toFixed(4)};`,
    `const float REFL_WEIGHT_NIGHT = ${REFL_WEIGHT_NIGHT.toFixed(4)};`,
    `const float NEON_STREAK_WIDTH = ${NEON_STREAK_WIDTH.toFixed(4)};`,
    `const float NEON_STREAK_LENGTH = ${NEON_STREAK_LENGTH.toFixed(4)};`,
    `const float NEON_BREAKUP_GAIN = ${NEON_BREAKUP_GAIN.toFixed(4)};`,
  ].join('\n');

  const hooks: Partial<Record<WaterHook, string>> = {
    /*
     * Runs right after `skyCol` is built (`refl`, `lightAmt` and `fres` are
     * all already in scope -- see waterglsl.ts's `reflection` hook doc).
     *
     * Colour-space trap: `reflection.ts`'s cube is filled by a mix of stock
     * materials (self-encoding sRGB regardless of render target -- see
     * postfx.ts) and hand-written ShaderMaterials that also encode to sRGB on
     * their own last line (docks.ts's beacons). Whatever lands in the cube is
     * therefore sRGB, not the linear colour every other term in this shader
     * works in, so it has to be decoded -- roughly `pow(c, 2.2)` -- before
     * it is mixed in below. Do not skip this: it is the kind of bug that
     * looks like "the reflection is a bit washed out" rather than a compile
     * error, and the next person to touch this file will otherwise assume
     * the sample is already linear.
     *
     * The cube is only 128 or 256px (`quality.reflectionSize`), which is
     * already an effective pre-blur, so a plain `textureCube` sample is used
     * rather than an explicit LOD bias: `textureCubeLodEXT` needs
     * `EXT_shader_texture_lod`, which is not exposed to this legacy-GLSL
     * (`varying`/`gl_FragColor`) shader even though the context is WebGL2 --
     * it compiles as GLSL ES 1.00. More blur belongs in `reflection.ts` at
     * generation time, not here at sample time.
     */
    reflection: [
      '  vec3 reflSample = pow(max(textureCube(uReflCube, refl).rgb, 0.0), vec3(2.2));',
      '  float reflWeight = mix(REFL_WEIGHT_NIGHT, REFL_WEIGHT_DAY, lightAmt);',
      '  skyCol = mix(skyCol, reflSample, reflWeight);',
    ].join('\n'),
    /*
     * Runs after all lighting and foam, before `applyAerial` and the sRGB
     * encode. Braced so its locals cannot collide with another plugin's
     * `colour` hook spliced into the same `main()`.
     *
     * The hull cannot be rendered into the cube -- the camera sits inside it
     * -- so this fakes the one reflection that matters most next to the
     * ship: its own neon, bleeding into the water beneath and around it.
     * `uNeonColor`/`uNeonLevel` come from `shipfx.ts`'s `glow`, so the streak
     * carries the same colour and dims with the same flat-battery and
     * dock-flare terms as the neon it stands in for -- it dies with the
     * lights rather than glowing on regardless.
     */
    colour: [
      '  {',
      '    vec3 toShip = vWorldPos - uShipPos;',
      '    float along = dot(toShip, uShipForward);',
      '    vec3 acrossVec = toShip - uShipForward * along;',
      '    float across = length(acrossVec);',
      '    float streak = exp(-(across * across) / (NEON_STREAK_WIDTH * NEON_STREAK_WIDTH))',
      '                 * exp(-abs(along) / NEON_STREAK_LENGTH);',
      '    float breakup = clamp(0.55 + NEON_BREAKUP_GAIN * (N.y - n.y), 0.0, 1.3);',
      '    col += uNeonColor * uNeonLevel * streak * breakup * fres;',
      '  }',
    ].join('\n'),
  };

  return {
    name: 'waterreflect',
    uniforms,
    declarations,
    hooks,
    update(_dt: number, _env: WorldEnv, ship: ShipState, _camera: THREE.Camera): void {
      uniforms.uShipPos.value.copy(ship.position).multiplyScalar(GLOBE_RADIUS);
      uniforms.uShipForward.value.copy(ship.forward);
      uniforms.uNeonColor.value.copy(shipGlow.color);
      uniforms.uNeonLevel.value = shipGlow.level;
    },
  };
}
