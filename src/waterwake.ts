import * as THREE from 'three';
import type { WaterPlugin } from './water';
import type { ShipState } from './types';
import type { WorldEnv } from './env';
import type { Wake } from './wake';
import { WAKE_BREAKUP_GLSL, WAKE_HEIGHT_SCALE, WAKE_MAP_EXTENT, computeWakeFrame, createWakeFrame } from './wakemap';

/**
 * waterwake.ts -- the `WaterPlugin` that samples `wakemap.ts`'s render target
 * back into the water fragment shader. See `docs/RENDER_PLAN.md`, Phase 1
 * stream A, and the class comment in `wakemap.ts` for the channel layout and
 * the write/read frame contract this depends on.
 */

/* ------------------------------------------------------------------ */
/* Tuning -- ship-scale (docs/ARCHITECTURE.md "World scale"): these tune */
/* how the wake reads once sampled, not the globe.                       */
/* ------------------------------------------------------------------ */

/**
 * Finite-difference step for the wake map's height gradient, world units.
 * Converted to uv space below by dividing by WAKE_MAP_EXTENT. Several texels
 * wide even at the smallest quality tier (48 / 256 units per texel =~ 0.19)
 * so the tap reads the surface shape rather than single-texel noise.
 */
const WAKE_NORMAL_STEP = 0.6;
const WAKE_NORMAL_UV_EPS = WAKE_NORMAL_STEP / WAKE_MAP_EXTENT;

/** How strongly the wake's height gradient tilts the water's shading normal. Dimensionless, an opening bid for the owner's eye. */
const WAKE_NORMAL_STRENGTH = 4.0;

/** How much a positive wake height (a Kelvin crest) brightens the foam mask on top of the map's own foam channel. Dimensionless. */
const WAKE_CREST_FOAM_GAIN = 0.12;

/**
 * Cold cyan glow near the stern -- ART-DIRECTION's "weathered timber and cold
 * glow". Desaturated and low-weight so it reads as a glint, not a paint job.
 * Never magenta: magenta is UI-only in this project.
 */
const WAKE_NEON_TINT_HEX = '#8fe8ff';
const WAKE_NEON_WEIGHT = 0.25;

/** Foam-age fraction (0 = just laid, 1 = about to dissolve) over which the neon tint fades astern. Dimensionless. Low, so it stays a stern glow rather than a wake-long stripe. */
const WAKE_NEON_AGE_FALLOFF = 0.4;

/**
 * Builds the wake's `WaterPlugin`. `wake` must be the same `Wake` this
 * plugin is meant to visualise -- its `wakeMap.texture` is sampled directly,
 * and `wake.update` is what fills it every frame, before the water draws.
 */
export function createWaterWakePlugin(wake: Wake): WaterPlugin {
  const uniforms: Record<string, THREE.IUniform> = {
    uWakeMap: { value: wake.wakeMap.texture },
    uWakeCentre: { value: new THREE.Vector3() },
    uWakeEast: { value: new THREE.Vector3() },
    uWakeNorth: { value: new THREE.Vector3() },
    uWakeExtent: { value: wake.wakeMap.extent },
    uWakeNeonTint: { value: new THREE.Color(WAKE_NEON_TINT_HEX) },
  };

  const declarations = [
    'uniform sampler2D uWakeMap;',
    'uniform vec3 uWakeCentre;',
    'uniform vec3 uWakeEast;',
    'uniform vec3 uWakeNorth;',
    'uniform float uWakeExtent;',
    'uniform vec3 uWakeNeonTint;',
    `const float WAKE_NORMAL_UV_EPS = ${WAKE_NORMAL_UV_EPS.toFixed(8)};`,
    `const float WAKE_NORMAL_STRENGTH = ${WAKE_NORMAL_STRENGTH.toFixed(4)};`,
    `const float WAKE_HEIGHT_SCALE = ${WAKE_HEIGHT_SCALE.toFixed(4)};`,
    `const float WAKE_CREST_FOAM_GAIN = ${WAKE_CREST_FOAM_GAIN.toFixed(4)};`,
    `const float WAKE_NEON_WEIGHT = ${WAKE_NEON_WEIGHT.toFixed(4)};`,
    `const float WAKE_NEON_AGE_FALLOFF = ${WAKE_NEON_AGE_FALLOFF.toFixed(4)};`,
    // Shared verbatim with wakemap.ts's ribbon-map material -- see its
    // WAKE_FOAM_WAVELENGTH comment for why the two must never drift apart.
    ...WAKE_BREAKUP_GLSL,
    'vec2 wakeUV(vec3 worldPos) {',
    '  vec3 rel = worldPos - uWakeCentre;',
    '  float x = dot(rel, uWakeEast);',
    '  float y = dot(rel, uWakeNorth);',
    '  return vec2(0.5 + x / uWakeExtent, 0.5 + y / uWakeExtent);',
    '}',
    // The wake map is data, not colour -- see wakemap.ts's class comment.
    // No sRGB decode here; the channels are read exactly as written.
    'void wakeSample(vec3 worldPos, out float foam, out float height, out float age, out vec2 grad) {',
    '  vec2 uv = wakeUV(worldPos);',
    '  vec4 c = texture2D(uWakeMap, uv);',
    '  foam = c.r;',
    '  height = (c.g - 0.5) / WAKE_HEIGHT_SCALE;',
    '  age = c.b;',
    '  // Height\'s gradient by two extra taps (forward difference in u, then v).',
    '  float hu = texture2D(uWakeMap, uv + vec2(WAKE_NORMAL_UV_EPS, 0.0)).g;',
    '  float hv = texture2D(uWakeMap, uv + vec2(0.0, WAKE_NORMAL_UV_EPS)).g;',
    '  grad = vec2(hu - c.g, hv - c.g);',
    '}',
  ].join('\n');

  // Declared without block scope in `normal` (the first hook this plugin
  // fills) so `foam` and `colour` -- spliced later into the same main() --
  // can read them back without a second, redundant sample of the map.
  // Prefixed distinctively so another plugin's own locals can never collide.
  const hooks: WaterPlugin['hooks'] = {
    normal: [
      '  float wakeFoamSample;',
      '  float wakeHeightSample;',
      '  float wakeAgeSample;',
      '  vec2 wakeGradSample;',
      '  wakeSample(vWorldPos, wakeFoamSample, wakeHeightSample, wakeAgeSample, wakeGradSample);',
      '  {',
      '    vec3 wakeTilt = (uWakeEast * wakeGradSample.x + uWakeNorth * wakeGradSample.y) * WAKE_NORMAL_STRENGTH;',
      '    N = normalize(N - wakeTilt);',
      '  }',
    ].join('\n'),
    foam: [
      '  foam = max(foam, wakeFoamSample * wakeBreakup(vWorldPos));',
      '  foam = clamp(foam + max(wakeHeightSample, 0.0) * WAKE_CREST_FOAM_GAIN, 0.0, 1.0);',
    ].join('\n'),
    colour: [
      '  {',
      '    float wakeNearStern = 1.0 - smoothstep(0.0, WAKE_NEON_AGE_FALLOFF, wakeAgeSample);',
      '    col += uWakeNeonTint * (WAKE_NEON_WEIGHT * wakeNearStern * (1.0 - lightAmt) * clamp(wakeFoamSample, 0.0, 1.0));',
      '  }',
    ].join('\n'),
  };

  const frame = createWakeFrame();

  return {
    name: 'wake',
    uniforms,
    declarations,
    hooks,
    update(_dt: number, _env: WorldEnv, ship: ShipState, _camera: THREE.Camera): void {
      // Independent of wakemap.ts's own `render()` call -- both compute this
      // from the same ship state, so they agree regardless of call order.
      // See the write/read frame contract in wakemap.ts's class comment.
      computeWakeFrame(ship, frame);
      (uniforms.uWakeCentre.value as THREE.Vector3).copy(frame.centre);
      (uniforms.uWakeEast.value as THREE.Vector3).copy(frame.east);
      (uniforms.uWakeNorth.value as THREE.Vector3).copy(frame.north);
    },
  };
}
