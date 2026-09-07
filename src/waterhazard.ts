/**
 * waterhazard.ts — the `WaterPlugin` that puts strong waves and maelstroms
 * into the water shader.
 *
 * Three jobs, in the three hook slots the contract offers (see
 * docs/ARCHITECTURE.md "The water plugin contract"):
 *
 *   normal  — tilt N by the hazard field's own gradient, so a crest catches
 *             the light as a wall of water rather than as a flat rise.
 *   foam    — froth along a crest's top and in a maelstrom's spiral bands.
 *             This is the one slot that fires on EVERY pixel rather than only
 *             near a shore, which is what lets it foam in open ocean.
 *   colour  — darken the funnel toward the abyss.
 *
 * The height itself comes from `hazardfield.ts`'s `HAZARD_GLSL`, pasted into
 * `declarations` here and into the displacement patch's vertex shader
 * there — one source, three consumers, per that module's comment.
 *
 * The froth and the spin are art and live ONLY here: they use sin and snoise
 * freely, because nothing on the CPU has to match them. The height must not.
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
import { freq } from './waveconstants';
import {
  HAZARD_GLSL,
  MAX_HAZARDS,
  HAZ_STEP_DIR,
  HAZ_STEP_WORLD,
  FUNNEL_DEPTH,
  GREAT_CREST_HEIGHT,
  hazardExtentDir,
  hazardHalfWidthDir,
  hazardShapeKind,
  hazardStrength,
} from './hazardfield';

/* ------------------------------------------------------------------ */
/* Art tuning — fragment side only, nothing on the CPU matches any of   */
/* it, which is exactly why sin and snoise are allowed below.           */
/* ------------------------------------------------------------------ */

/**
 * Wavelength of the noise that breaks the crest's foam line up, world units.
 *
 * Just under a hull length, so the froth reads as clumps of white water torn
 * off the top rather than as an airbrushed stripe along a mathematical
 * plateau — which is what the bare profile looks like, and what gave the
 * first version of this away as a shader.
 */
const FROTH_WAVELENGTH = 2.2;

/** How fast that breakup noise drifts, direction units per second. Slow: the froth belongs to the wave, not to the wind. */
const FROTH_DRIFT = 0.35;

/**
 * Turns `uHazShape.w` (world units of height) back into a 0..1 strength for
 * the art, by dividing out the largest amplitude either kind can carry.
 *
 * A great wave at full envelope therefore foams at 1.0 and a strong one at
 * 0.67, which is the ordering the sizes already imply, and both fade to
 * nothing with the envelope for free.
 */
const FOAM_STRENGTH_NORM = 1 / GREAT_CREST_HEIGHT;

/** The same, for a maelstrom: `uHazShape.w` over the funnel's full depth is the growth envelope. */
const FUNNEL_ENV_NORM = 1 / FUNNEL_DEPTH;

/**
 * Where the crest's foam band sits and how wide it is, both as fractions of
 * the crest's own `halfWidth`.
 *
 * The bias is forward -- onto the face the wave is running at -- because that
 * is the side a real crest spills down, and it is the side the hull meets. A
 * band centred on the crest line reads as a stripe painted along the top; one
 * pushed a quarter of a half-width ahead of it reads as water falling over.
 *
 * The width is the whole difference between a wave and a snowdrift. At 0.7 of
 * a half-width the froth covers about 3.5 of the 8 units the wave runs
 * through, so the flanks stay sea-coloured and take their shading from the
 * normal instead of being painted out white.
 */
const FOAM_BIAS = 0.25;
const FOAM_BAND = 0.7;

/** Spiral bands per turn, and how fast they wind, for the funnel's foam. Three arms, spinning inward at a bit over a turn every two seconds. */
const SPIRAL_RADIAL_FREQ = 14.0;
const SPIRAL_SPIN = 2.5;
const SPIRAL_ARMS = 3.0;

/** How far the funnel's centre is dragged toward `uAbyss`. Under a full mix, so the hole still reads as water rather than as a hole cut in the frame. */
const FUNNEL_DARKEN = 0.6;

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
): number {
  const count = Math.min(live.length, MAX_HAZARDS);
  for (let i = 0; i < count; i++) {
    const h = live[i];
    centres[i].copy(h.centre);
    easts[i].copy(h.east);
    norths[i].copy(h.north);
    shapes[i].set(hazardShapeKind(h), hazardExtentDir(h), hazardHalfWidthDir(h), hazardStrength(h));
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
  for (let i = 0; i < MAX_HAZARDS; i++) {
    centres.push(new THREE.Vector3(0, 1, 0));
    easts.push(new THREE.Vector3(1, 0, 0));
    norths.push(new THREE.Vector3(0, 0, 1));
    shapes.push(new THREE.Vector4());
  }

  const uniforms: Record<string, THREE.IUniform> = {
    uHazCount: { value: 0 },
    uHazCentre: { value: centres },
    uHazEast: { value: easts },
    uHazNorth: { value: norths },
    uHazShape: { value: shapes },
  };

  let source: HazardState | null = null;

  const hooks: WaterPlugin['hooks'] = {
    /*
     * The normal of a height field is the up vector leaned back by the
     * field's own slope, and that is all this is. The height difference is in
     * world units over a step of HAZ_STEP_WORLD world units, so dividing by
     * the step gives a true slope and there is NO art factor here to tune --
     * a great crest's flank is genuinely about 45 degrees and should shade
     * like it. (`water.ts`'s own tilt does carry a factor, because it is
     * fighting an unnormalised difference; this is not.)
     */
    normal: [
      '  {',
      `    float hazEps = ${HAZ_STEP_DIR.toFixed(8)};`,
      '    float hz0 = hazardHeight(n);',
      '    float hzu = hazardHeight(n + tanU * hazEps);',
      '    float hzv = hazardHeight(n + tanV * hazEps);',
      `    vec3 hazSlope = (tanU * (hzu - hz0) + tanV * (hzv - hz0)) / ${HAZ_STEP_WORLD.toFixed(4)};`,
      '    N = normalize(N - hazSlope);',
      '  }',
    ].join('\n'),

    /*
     * Declared without a block, the way `waterwake.ts` declares its samples,
     * so the `colour` hook spliced further down the same main() can read the
     * funnel term back instead of walking the slots a second time.
     *
     * Everything in here is art: the profiles are re-derived from the same
     * dot products the height uses, but sin, atan and snoise are free to
     * appear because no CPU code compares against any of it.
     */
    foam: [
      '  float hazFunnel = 0.0;',
      '  for (int hi = 0; hi < MAX_HAZARDS; hi++) {',
      '    if (hi >= uHazCount) break;',
      '    vec4 hsh = uHazShape[hi];',
      '    float hu = dot(n, uHazEast[hi]);',
      '    float hv = dot(n, uHazNorth[hi]);',
      '    float ha = max(hsh.y, HAZ_MIN_SIZE);',
      '    if (hsh.x < 0.5) {',
      `      float hstr = clamp(hsh.w * ${FOAM_STRENGTH_NORM.toFixed(6)}, 0.0, 1.0);`,
      '      float hb = max(hsh.z, HAZ_MIN_SIZE);',
      /*
       * A band ON the crest, biased onto the face the wave is breaking down.
       *
       * This used to be `sqrt(hazBump(hv / hb))` -- a wash over the whole
       * shoulder -- and between that and the flat-topped profile the height
       * field used to carry, a great wave came out as a white slab with
       * square ends. Foam is what tells the eye which line is the crest, so
       * it has to be a line.
       *
       * Measured against the symmetric `hb`, deliberately, not against the
       * asymmetric front/back widths the HEIGHT uses: the band is a fixed
       * width of water in the world, and scaling it by the long tail would
       * put most of the froth behind the wave.
       */
      `      float hband = (hv - hb * ${FOAM_BIAS.toFixed(3)}) / (hb * ${FOAM_BAND.toFixed(3)});`,
      '      float hcrest = hazPlateau(hu / ha) * hazBump(hband);',
      `      vec3 hq = n * ${freq(FROTH_WAVELENGTH)} + vec3(uTime * ${FROTH_DRIFT.toFixed(4)});`,
      '      float hbreak = clamp(0.40 + 0.75 * snoise(hq), 0.0, 1.0);',
      '      foam = max(foam, hcrest * hstr * hbreak);',
      '    } else {',
      `      float henv = clamp(hsh.w * ${FUNNEL_ENV_NORM.toFixed(6)}, 0.0, 1.0);`,
      '      float hr = sqrt(hu * hu + hv * hv) / ha;',
      '      float hin = max(1.0 - hr, 0.0);',
      '      float hth = atan(hv, hu);',
      `      float hband = 0.5 + 0.5 * sin(hr * ${SPIRAL_RADIAL_FREQ.toFixed(1)} - uTime * ${SPIRAL_SPIN.toFixed(1)} + hth * ${SPIRAL_ARMS.toFixed(1)});`,
      // Fourth power: thin bright arms with dark water between them, rather
      // than a sine's even grey wash.
      '      hband = hband * hband;',
      '      hband = hband * hband;',
      '      float hlip = hazBump((hr - HAZ_RIM_C) * HAZ_RIM_INV);',
      '      foam = max(foam, clamp((hband * hin + hlip * 0.8) * henv, 0.0, 1.0));',
      '      hazFunnel = max(hazFunnel, hin * hin * henv);',
      '    }',
      '  }',
    ].join('\n'),

    colour: [
      '  {',
      `    col = mix(col, uAbyss, clamp(hazFunnel * ${FUNNEL_DARKEN.toFixed(4)}, 0.0, 1.0));`,
      '  }',
    ].join('\n'),
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
      uniforms.uHazCount.value = source ? packHazards(source.live, centres, easts, norths, shapes) : 0;
    },
  };
}
