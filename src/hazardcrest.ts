/**
 * hazardcrest.ts — the fragment-side art for a strong or great wave's crest.
 *
 * Split out of `waterhazard.ts` (which still owns the uniforms, the slot loop
 * and every local named below) so that the crest and the maelstrom can be
 * worked on as two files rather than as two branches of one string. See
 * `docs/TEXTURE_PLAN.md` Wave 0.
 *
 * Everything here is art. `hazardfield.ts` owns the height, and the one rule
 * that file states -- polynomial plus one sqrt, mirrored on the CPU -- does
 * NOT apply in this module: nothing on the CPU compares against a single line
 * of it, so `sin`, `atan` and `snoise` are all free.
 *
 * The locals the skeleton guarantees are in scope, per hook:
 *
 *   slope   `hsh` `hu` `hv` `ha` `hb` `hstr`, and the accumulator
 *           `hazCrestMask` to raise. May also raise the core seam's `steep`,
 *           `crestLift` and `tiltBoost` (see `waterglsl.ts`'s `slope` hook).
 *   foam    the same, plus `foam` to raise.
 *   colour  `hazCrestMask`, `hazSlope`, `hazHeight0`, and everything the
 *           water shader has by then (`col`, `N`, `fres`, `skyCol`, ...).
 */
import { freq } from './waveconstants';

/* ------------------------------------------------------------------ */
/* Art tuning                                                           */
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

/**
 * Raises `hazCrestMask`: how much this pixel belongs to a crest, 0..1.
 *
 * It is the height profile's own shape (`hazPlateau` along the crest,
 * `hazCrest` across it, with the same asymmetric front/back widths the height
 * uses) scaled by the wave's strength, so it is 1 on the crest line of a
 * full-strength great wave and fades with the envelope for free. Deriving it
 * from the profile rather than from `hazardHeight` keeps it per-kind: a
 * maelstrom in an adjacent slot must not raise it.
 */
export const CREST_SLOPE_GLSL: string = [
  '        float hbw = hb * (hv > 0.0 ? HAZ_CREST_FRONT : HAZ_CREST_BACK);',
  '        hazCrestMask = max(hazCrestMask, hazPlateau(hu / ha) * hazCrest(hv / hbw) * hstr);',
].join('\n');

/**
 * A band ON the crest, biased onto the face the wave is breaking down.
 *
 * This used to be `sqrt(hazBump(hv / hb))` -- a wash over the whole shoulder
 * -- and between that and the flat-topped profile the height field used to
 * carry, a great wave came out as a white slab with square ends. Foam is what
 * tells the eye which line is the crest, so it has to be a line.
 *
 * Measured against the symmetric `hb`, deliberately, not against the
 * asymmetric front/back widths the HEIGHT uses: the band is a fixed width of
 * water in the world, and scaling it by the long tail would put most of the
 * froth behind the wave.
 */
export const CREST_FOAM_GLSL: string = [
  `      float hband = (hv - hb * ${FOAM_BIAS.toFixed(3)}) / (hb * ${FOAM_BAND.toFixed(3)});`,
  '      float hcrest = hazPlateau(hu / ha) * hazBump(hband);',
  `      vec3 hq = n * ${freq(FROTH_WAVELENGTH)} + vec3(uTime * ${FROTH_DRIFT.toFixed(4)});`,
  '      float hbreak = clamp(0.40 + 0.75 * snoise(hq), 0.0, 1.0);',
  '      foam = max(foam, hcrest * hstr * hbreak);',
].join('\n');

/**
 * Nothing yet. Stream C (`docs/TEXTURE_PLAN.md` Wave 1) owns this slot: the
 * thickness tint that makes a backlit wall of water lighter and greener than
 * the trough beside it, and the Fresnel rim on the lip.
 */
export const CREST_COLOUR_GLSL: string = '';
