/**
 * waterhazard.ts — the `WaterPlugin` that puts strong waves and maelstroms
 * into the water shader.
 *
 * Four jobs, in four of the five hook slots the contract offers (see
 * docs/ARCHITECTURE.md "The water plugin contract"):
 *
 *   slope   — finite-difference the hazard field once, hand the core shader
 *             the normal its smooth-normal gates should be asking (`steepN`),
 *             and work out how much of this pixel is crest and how much is
 *             funnel. Runs before the LOD, which is the point: a wall of
 *             water has to be declared a wall before the shader decides how
 *             much detail the pixel deserves.
 *   normal  — tilt N by that same gradient, so a crest catches the light as a
 *             wall of water rather than as a flat rise.
 *   foam    — froth along a crest's top and in a maelstrom's spiral bands.
 *             This is the one slot that fires on EVERY pixel rather than only
 *             near a shore, which is what lets it foam in open ocean.
 *   colour  — darken the funnel toward the abyss.
 *
 * The height itself comes from `hazardfield.ts`'s `HAZARD_GLSL`, pasted into
 * `declarations` here and into the displacement patch's vertex shader
 * there — one source, three consumers, per that module's comment.
 *
 * The froth and the spin are art. They used to live in this file too; they
 * are now in `hazardcrest.ts` and `hazardfunnel.ts`, one per kind, and this
 * file is the skeleton that walks the slots and splices them in. Both may use
 * sin and snoise freely, because nothing on the CPU has to match them. The
 * height must not.
 *
 * `bind` is the awkward part and it is the plugin rule's fault, not this
 * module's. A plugin can only be woven into the water shader while it is being
 * assembled, so this has to exist BEFORE `createGlobe`; but `hazards.ts` needs
 * `globe.heightMap` and `globe.towns`, which exist only after. So the plugin is
 * built empty and told about its source once there is one. Unbound, it writes
 * `uHazCount = 0` and the sea is exactly the sea it always was.
 */
import * as THREE from 'three';
import type { WaterPlugin } from './water';
import type { Hazard, HazardState } from './types';
import { CREST_SLOPE_GLSL, CREST_FOAM_GLSL, CREST_COLOUR_GLSL } from './hazardcrest';
import { FUNNEL_SLOPE_GLSL, FUNNEL_FOAM_GLSL, FUNNEL_COLOUR_GLSL } from './hazardfunnel';
import {
  HAZARD_GLSL,
  MAX_HAZARDS,
  HAZ_STEP_DIR,
  HAZ_STEP_WORLD,
  FUNNEL_DEPTH,
  CREST_HEIGHT_MAX,
  hazardExtentDir,
  hazardBow,
  hazardHalfWidthDir,
  hazardShapeKind,
  hazardStrength,
} from './hazardfield';

/* ------------------------------------------------------------------ */
/* Shared normalisers — the two art modules read these through the      */
/* locals the skeleton derives, so neither has to know the field's      */
/* amplitude scale.                                                     */
/* ------------------------------------------------------------------ */

/**
 * Turns `uHazShape.w` (world units of height) back into a 0..1 strength for
 * the art, by dividing out the largest amplitude either kind can carry.
 *
 * A wave grown to the top of its range foams at 1.0 and one that rose at the
 * bottom of it foams at 0.5, which is the ordering the heights already imply,
 * and all of them fade to nothing with the envelope for free. There is no
 * longer a great wave to normalise against -- CREST_HEIGHT_MAX is the ceiling
 * growth may carry ANY wave to, which is the same 2.4 that constant always
 * was.
 */
const FOAM_STRENGTH_NORM = 1 / CREST_HEIGHT_MAX;

/** The same, for a maelstrom: `uHazShape.w` over the funnel's full depth is the growth envelope. */
const FUNNEL_ENV_NORM = 1 / FUNNEL_DEPTH;

export interface WaterHazardPlugin extends WaterPlugin {
  /** Points the plugin at the live `HazardState`. Called once, from `main.ts`. */
  bind(state: HazardState): void;
}

/**
 * Writes `live` into the uniform arrays and returns the count `uHazCount`
 * should carry. Mutates the vectors in place — never reassigns an array, and
 * never allocates.
 *
 * Exported because `dev/probe.ts` builds the same uniforms for the parity
 * harness: the test then measures the packing the game actually ships rather
 * than a second copy of it that could drift.
 */
export function packHazards(
  live: readonly Hazard[],
  centres: THREE.Vector3[],
  easts: THREE.Vector3[],
  norths: THREE.Vector3[],
  shapes: THREE.Vector4[],
  bows: number[],
): number {
  const count = Math.min(live.length, MAX_HAZARDS);
  for (let i = 0; i < count; i++) {
    const h = live[i];
    centres[i].copy(h.centre);
    easts[i].copy(h.east);
    norths[i].copy(h.north);
    shapes[i].set(hazardShapeKind(h), hazardExtentDir(h), hazardHalfWidthDir(h), hazardStrength(h));
    // The bow is its own uniform rather than a fifth component of `shapes`
    // because `shapes` is a vec4 and all four of its lanes are spoken for.
    bows[i] = hazardBow(h);
  }
  // Slots at or past the count are never read -- `hazardHeight` breaks out of
  // its loop there -- so they are left holding whatever they last held rather
  // than being cleared for tidiness nobody can see.
  return count;
}

export function createWaterHazardPlugin(): WaterHazardPlugin {
  const centres: THREE.Vector3[] = [];
  const easts: THREE.Vector3[] = [];
  const norths: THREE.Vector3[] = [];
  const shapes: THREE.Vector4[] = [];
  const bows: number[] = [];
  for (let i = 0; i < MAX_HAZARDS; i++) {
    centres.push(new THREE.Vector3(0, 1, 0));
    easts.push(new THREE.Vector3(1, 0, 0));
    norths.push(new THREE.Vector3(0, 0, 1));
    shapes.push(new THREE.Vector4());
    bows.push(0);
  }

  const uniforms: Record<string, THREE.IUniform> = {
    uHazCount: { value: 0 },
    uHazCentre: { value: centres },
    uHazEast: { value: easts },
    uHazNorth: { value: norths },
    uHazShape: { value: shapes },
    uHazBow: { value: bows },
  };

  let source: HazardState | null = null;

  const hooks: WaterPlugin['hooks'] = {
    /*
     * Declared without an outer block, the way `waterwake.ts` declares its
     * samples, so every hook spliced further down the same main() can read
     * these back instead of walking the slots again.
     *
     * The normal of a height field is the up vector leaned back by the
     * field's own slope, and `hazSlope` is that slope. The height difference
     * is in world units over a step of HAZ_STEP_WORLD world units, so
     * dividing by the step gives a true slope and there is NO art factor here
     * to tune -- a great crest's flank is genuinely about 45 degrees and
     * should shade like it. (`water.ts`'s own tilt does carry a factor,
     * because it is fighting an unnormalised difference; this is not.)
     *
     * It is computed HERE rather than in the `normal` hook, where it used to
     * live, because the core shader's `steepN` wants it before the LOD runs
     * and the `normal` hook is downstream of that. Same three taps, same
     * arithmetic, used twice instead of once.
     *
     * The loop derives, per slot, only the locals both art modules share, and
     * hands each kind's branch to its own file. `hazCrestMask` and
     * `hazFunnelMask` come back out of it as 0..1 "how much of this pixel is
     * this kind of hazard", which is what lets the two modules raise `steep`
     * and tint `col` without either one having to know the other exists.
     */
    slope: [
      '  float hazCrestMask = 0.0;',
      '  float hazFunnelMask = 0.0;',
      '  vec3 hazSlope = vec3(0.0);',
      '  float hazHeight0 = 0.0;',
      '  {',
      `    float hazEps = ${HAZ_STEP_DIR.toFixed(8)};`,
      '    hazHeight0 = hazardHeight(n);',
      '    float hzu = hazardHeight(n + tanU * hazEps);',
      '    float hzv = hazardHeight(n + tanV * hazEps);',
      `    hazSlope = (tanU * (hzu - hazHeight0) + tanV * (hzv - hazHeight0)) / ${HAZ_STEP_WORLD.toFixed(4)};`,
      '    for (int hi = 0; hi < MAX_HAZARDS; hi++) {',
      '      if (hi >= uHazCount) break;',
      '      vec4 hsh = uHazShape[hi];',
      '      float hu = dot(n, uHazEast[hi]);',
      '      float hv = dot(n, uHazNorth[hi]);',
      '      float ha = max(hsh.y, HAZ_MIN_SIZE);',
      // The art has to read the SAME along-travel coordinate the height field
      // does or the foam band, the streaks and the spray all stay on the
      // straight line the geometry no longer follows. A maelstrom's bow is
      // packed as 0, so this is `hv` again on that branch.
      '      hv = hazBowV(hu, hv, ha, uHazBow[hi]);',
      '      if (hsh.x < 0.5) {',
      `        float hstr = clamp(hsh.w * ${FOAM_STRENGTH_NORM.toFixed(6)}, 0.0, 1.0);`,
      '        float hb = max(hsh.z, HAZ_MIN_SIZE);',
      CREST_SLOPE_GLSL,
      '      } else {',
      `        float henv = clamp(hsh.w * ${FUNNEL_ENV_NORM.toFixed(6)}, 0.0, 1.0);`,
      '        float hr = sqrt(hu * hu + hv * hv) / ha;',
      '        float hin = max(1.0 - hr, 0.0);',
      FUNNEL_SLOPE_GLSL,
      '      }',
      '    }',
      // Set unconditionally: with no hazards `hazSlope` is zero and this is
      // `n` again, and `steep` is still 0, so the core's gates are untouched.
      // Setting it here rather than behind a test is what lets an art module
      // raise `steep` without also having to edit this skeleton.
      '    steepN = normalize(n - hazSlope);',
      '  }',
    ].join('\n'),

    /** The same slope the `slope` hook already measured, leaning `N` back. */
    normal: [
      '  {',
      '    N = normalize(N - hazSlope);',
      '  }',
    ].join('\n'),

    /*
     * Everything in here is art: the profiles are re-derived from the same
     * dot products the height uses, but sin, atan and snoise are free to
     * appear because no CPU code compares against any of it.
     */
    foam: [
      '  for (int hi = 0; hi < MAX_HAZARDS; hi++) {',
      '    if (hi >= uHazCount) break;',
      '    vec4 hsh = uHazShape[hi];',
      '    float hu = dot(n, uHazEast[hi]);',
      '    float hv = dot(n, uHazNorth[hi]);',
      '    float ha = max(hsh.y, HAZ_MIN_SIZE);',
      // Same bow as the `slope` hook above, and for the same reason.
      '    hv = hazBowV(hu, hv, ha, uHazBow[hi]);',
      '    if (hsh.x < 0.5) {',
      `      float hstr = clamp(hsh.w * ${FOAM_STRENGTH_NORM.toFixed(6)}, 0.0, 1.0);`,
      '      float hb = max(hsh.z, HAZ_MIN_SIZE);',
      CREST_FOAM_GLSL,
      '    } else {',
      `      float henv = clamp(hsh.w * ${FUNNEL_ENV_NORM.toFixed(6)}, 0.0, 1.0);`,
      '      float hr = sqrt(hu * hu + hv * hv) / ha;',
      '      float hin = max(1.0 - hr, 0.0);',
      '      float hth = atan(hv, hu);',
      FUNNEL_FOAM_GLSL,
      '    }',
      '  }',
    ].join('\n'),

    colour: ['  {', CREST_COLOUR_GLSL, FUNNEL_COLOUR_GLSL, '  }']
      .filter((line) => line.length > 0)
      .join('\n'),
  };

  return {
    name: 'hazard',
    uniforms,
    declarations: HAZARD_GLSL,
    hooks,
    bind(state: HazardState): void {
      source = state;
    },
    update(): void {
      // Unbound, or bound to a state with nothing on the water, the count is
      // 0 and every consumer skips the loop entirely -- which is what makes
      // this plugin free on the frames where nothing is happening.
      uniforms.uHazCount.value = source
        ? packHazards(source.live, centres, easts, norths, shapes, bows)
        : 0;
    },
  };
}
