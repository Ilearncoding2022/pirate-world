/**
 * hazardfunnel.ts — the fragment-side art for a maelstrom.
 *
 * Split out of `waterhazard.ts` (which still owns the uniforms, the slot loop
 * and every local named below) so that the crest and the maelstrom can be
 * worked on as two files rather than as two branches of one string. See
 * `docs/TEXTURE_PLAN.md` Wave 0.
 *
 * The height of a maelstrom is radially symmetric on purpose (`hazardfield.ts`,
 * and `docs/HAZARDS_PLAN.md`: "the swirl is not in the geometry") because the
 * hull has to ride the same field the eye sees, and parity is only affordable
 * while the field stays polynomial. The spiral is therefore this file's job
 * entirely, and this file is under no such rule: nothing on the CPU compares
 * against a line of it, so `sin`, `atan` and `snoise` are all free.
 *
 * The locals the skeleton guarantees are in scope, per hook:
 *
 *   slope   `hsh` `hu` `hv` `ha` `henv` `hr` `hin`, and the accumulator
 *           `hazFunnelMask` to raise. May also raise the core seam's `steep`,
 *           `crestLift` and `tiltBoost` (see `waterglsl.ts`'s `slope` hook).
 *   foam    the same, plus `hth` and `foam` to raise.
 *   colour  `hazFunnelMask`, `hazSlope`, `hazHeight0`, and everything the
 *           water shader has by then (`col`, `N`, `fres`, `skyCol`, ...).
 */

/* ------------------------------------------------------------------ */
/* Art tuning                                                           */
/* ------------------------------------------------------------------ */

/** Spiral bands per turn, and how fast they wind, for the funnel's foam. Three arms, spinning inward at a bit over a turn every two seconds. */
const SPIRAL_RADIAL_FREQ = 14.0;
const SPIRAL_SPIN = 2.5;
const SPIRAL_ARMS = 3.0;

/** How far the funnel's centre is dragged toward `uAbyss`. Under a full mix, so the hole still reads as water rather than as a hole cut in the frame. */
const FUNNEL_DARKEN = 0.6;

/**
 * Raises `hazFunnelMask`: how much this pixel is inside a funnel, 0..1.
 *
 * `(1 - r)^2` scaled by the growth envelope -- the same term the colour hook
 * has always used to darken the centre, hoisted here so the slope, foam and
 * colour hooks all read one definition instead of three.
 */
export const FUNNEL_SLOPE_GLSL: string = [
  '        hazFunnelMask = max(hazFunnelMask, hin * hin * henv);',
].join('\n');

/**
 * Three arms winding inward, plus the lip.
 *
 * Fourth power: thin bright arms with dark water between them, rather than a
 * sine's even grey wash.
 */
export const FUNNEL_FOAM_GLSL: string = [
  `      float hband = 0.5 + 0.5 * sin(hr * ${SPIRAL_RADIAL_FREQ.toFixed(1)} - uTime * ${SPIRAL_SPIN.toFixed(1)} + hth * ${SPIRAL_ARMS.toFixed(1)});`,
  '      hband = hband * hband;',
  '      hband = hband * hband;',
  '      float hlip = hazBump((hr - HAZ_RIM_C) * HAZ_RIM_INV);',
  '      foam = max(foam, clamp((hband * hin + hlip * 0.8) * henv, 0.0, 1.0));',
].join('\n');

/** Drags the funnel's centre toward the abyss colour. */
export const FUNNEL_COLOUR_GLSL: string = [
  `  col = mix(col, uAbyss, clamp(hazFunnelMask * ${FUNNEL_DARKEN.toFixed(4)}, 0.0, 1.0));`,
].join('\n');
