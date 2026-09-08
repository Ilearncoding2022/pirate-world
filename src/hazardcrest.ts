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
 * There is no front-face code path here, and there is not meant to be one.
 * The front of a great wave is simply the steep side: a 2.0-world-unit run at
 * about 64 degrees against a 6.0-unit back at about 22 (CREST_FRONT_RATIO and
 * CREST_BACK_RATIO in `hazardfield.ts`). Everything below that treats the two
 * differently does so by reading `hazSlope` or the sign of `hv`, never by
 * branching on which face this is, so the silhouette stays entirely the height
 * field's business.
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
import { CREST_HEIGHT_MAX } from './hazardfield';
import { freq } from './waveconstants';

/* ------------------------------------------------------------------ */
/* Art tuning                                                           */
/* ------------------------------------------------------------------ */

/**
 * Wavelength of the noise that breaks the crest's foam line up, world units.
 *
 * Just under a hull length, so the froth reads as clumps of white water torn
 * off the top rather than as an airbrushed stripe laid along a curve, which is
 * what the bare profile looks like and what gave the first version of this away
 * as a shader. This one noise now does three jobs (breakup, the band's wander,
 * the band's torn ends) and it is still one `snoise` tap, which is why they are
 * all keyed to this wavelength rather than each picking their own.
 */
export const FROTH_WAVELENGTH = 2.2;

/** How fast that breakup noise drifts, direction units per second. Slow: the froth belongs to the wave, not to the wind. */
export const FROTH_DRIFT = 0.35;

/**
 * Where the crest's foam band sits and how wide it is, both as fractions of
 * the crest's own `halfWidth`.
 *
 * The bias is forward -- onto the face the wave is running at -- because that
 * is the side a real crest spills down, and it is the side the hull meets. A
 * band centred on the crest line reads as a stripe painted along the top; one
 * pushed ahead of it reads as water falling over.
 *
 * The width is the whole difference between a wave and a snowdrift, and the
 * pair used to be 0.25/0.70, which put solid froth over `hv` from -1.1 to
 * +2.4 world units: the entire 2.0-unit front face, plus some of the back.
 * Foam is drawn over everything below it, so a face that is all foam is a
 * face with no water in it, and that -- not the geometry -- is what made a
 * great wave read as a slab of clay. At 0.28 the solid band covers roughly
 * -0.4 to +0.9 units: the lip and the first third of the spill, and no more.
 * The rest of the face is now the streaks below, which leave water between
 * them.
 */
export const FOAM_BIAS = 0.1;
export const FOAM_BAND = 0.28;

/**
 * How far the froth noise is allowed to walk that band's centre across the
 * wave, as a fraction of `halfWidth`, and how deep it may eat into the band
 * along the crest's length.
 *
 * These two exist for the silhouette rather than for the foam. `hazardfield.ts`
 * reshaped the crest's along-length profile away from a plateau so that the top
 * of a great wave is a rounded ridge instead of a tabletop with a corner at
 * each shoulder, but at a vertex every 0.5 world units the OUTLINE the eye
 * traces against the sky is still a polyline, and no amount of shading moves an
 * outline. What shading can do is stop the eye trusting it. Both of these do
 * that with noise the foam hook has already paid for:
 *
 * `FOAM_WANDER` walks the lip band's centre with the froth noise, so the white
 * line along the top is not a dead straight rule laid on the crest. 0.12 of a
 * half-width is 0.3 world units against a band 0.7 wide -- the line visibly
 * wanders, and never leaves the top of the wave.
 *
 * `FOAM_TEAR` is the depth of ridge the noise can eat through, so the band ends
 * in clumps rather than fading out evenly along a shoulder. At full ridge
 * height the band is solid whatever the noise is doing (which is what
 * `FOAM_TEAR_INV` is for: it renormalises so the darkest noise still leaves the
 * middle of the crest at 1); by half height the noise swings it between about a
 * quarter and three quarters; past that it is torn through. The wave therefore
 * ends in broken water rather than in a stripe that dims to nothing, and it is
 * the ends that a mesa gave itself away at.
 */
export const FOAM_WANDER = 0.12;
export const FOAM_TEAR = 0.35;
export const FOAM_TEAR_INV = 1 / (1 - FOAM_TEAR);

/**
 * The streaks that carry the foam down the face below the lip band, as two
 * world-unit wavelengths and a fall speed.
 *
 * Narrow across the wave and long down it -- about five to one -- because that
 * is what running water leaves behind: fingers of froth with dark water
 * between them, not a wash. Five and not the ten a first pass used: at ten the
 * noise has no variation at all along a streak's own length and the face comes
 * out as a row of white columns with hard parallel edges, which is a picket
 * fence and not a wave. `STREAK_FALL` is in wavelengths per second, so the
 * pattern slides down the face at STREAK_LENGTH * STREAK_FALL, about 1.4 world
 * units a second: a little under a face height per second, which reads as
 * spilling rather than as a texture being scrolled.
 *
 * `STREAK_LIFE` walks the noise's third axis so streaks are born and die
 * where they are instead of being one rigid pattern in transit.
 */
export const STREAK_WIDTH = 0.5;
export const STREAK_LENGTH = 2.4;
export const STREAK_FALL = 0.6;
export const STREAK_LIFE = 0.15;

/**
 * How white the streaks get, and the noise window that decides how much of
 * the face they cover.
 *
 * The window is the coverage knob, and it wants to sit high on the noise:
 * 0.08 to 0.42 was the first try and took roughly the top two fifths of the
 * field, which put wide flat-topped ridges over most of the face. 0.20 to 0.58
 * takes about the top fifth and, because it climbs across the noise's own
 * shoulder rather than its plateau, the ridges come out narrow with soft
 * edges. Multiplied by `STREAK_FOAM` and by the froth breakup the lip band
 * already computes, the face runs at 20 to 35% foam over about a quarter of
 * it, against the 100% over half of it that it used to.
 */
export const STREAK_FOAM = 0.5;
export const STREAK_LO = 0.2;
export const STREAK_HI = 0.58;

/**
 * How hard the crest's own gradient hands the core shader's four smooth-normal
 * gates back to the surface that is actually there (`waterglsl.ts`'s `slope`
 * hook, and `docs/ARCHITECTURE.md` "The water plugin contract").
 *
 * `hazSlope` is a true world-units-per-world-unit gradient, so a great wave's
 * front peaks near 2.0 (64 degrees) and its back near 0.7 (35). At this gain
 * the front saturates the clamp and the back lands around 0.4 of it, which is
 * the ordering asked for: the back is water that has been lifted, the front is
 * a wall. Scaling by `hazCrestMask` afterwards is what keeps it per-kind and
 * fades it with the envelope for free.
 *
 * This is the term to reach for first if the sea starts to glitter: `steep`
 * feeds the sun-road gate, and a value too high lights the whole crest line
 * like tinsel rather than like water.
 */
const CREST_STEEP = 0.6;

/**
 * World units of extra "water to shine through" the backscatter term gets on
 * a crest, per world unit of crest height.
 *
 * The core adds this outside the `uWaveIntensity` factor on purpose, so a
 * rogue wave lit from behind still glows in a flat calm. 0.4 of a 2.4-unit
 * great wave is about a unit of lift, which is the same order as the ordinary
 * wave field's own `w0` in a gale -- enough to read as light coming through
 * the water, not enough to turn the crest into a lamp.
 */
export const CREST_LIFT = 0.4;

/**
 * Extra chop on the crest's two shoulders, as a multiplier on the core's
 * `tilt` (`waterglsl.ts`'s `slope` hook, same seam `hazardfunnel.ts` raises for
 * the funnel wall).
 *
 * This is the curvature term. The shoulder is where the crest's along-length
 * profile is bending hardest -- it is the only place on the wave where the
 * surface turns through a large angle inside a couple of vertices -- so it is
 * the one place the displacement grid cannot help drawing a facet, and a facet
 * with a clean unbroken normal across it is exactly what reads as a corner.
 * Scaling the wave field's own chop up there puts real, moving normal variation
 * over the facet without adding a term of its own, which is both cheaper and
 * more honest than painting a crease out: the shoulder of a wave breaking
 * sideways IS the rough part of it.
 *
 * 1.2 against the funnel's 1.6 because the crest also raises `steep`, and
 * `steep` hands the same pixels the sun road; the two together at full strength
 * light the shoulder like tinsel. Where it lands is `4 * r * (1 - r)` on the
 * ridge profile, which is 1 exactly where the ridge is at half height and 0
 * both at the middle of the crest and at its ends -- two bands, on the two
 * shoulders, and nowhere else.
 */
export const SHOULDER_CHOP = 1.2;

/**
 * The thickness tint: how far a standing wall of water is dragged toward a
 * lighter, greener colour than the trough beside it, and how quickly that
 * scopes in from the crest's edge.
 *
 * A 2.4-unit wall backlit by sky is not the same colour as the sea around it,
 * but the body colour here comes only from the bathymetry ramp, which knows
 * about the sea floor and nothing about what is standing above it -- so today
 * the wall and the trough are exactly the same navy. `CREST_SCOPE` widens
 * `hazCrestMask` into a plain "this is a crest" gate so the tint follows the
 * HEIGHT's shape rather than the mask's square; without it the tint collapses
 * onto the lip, where the foam has already covered it.
 */
export const CREST_THICK = 0.45;
export const CREST_SCOPE = 3.0;

/**
 * The tint itself, derived from `uShallow` rather than from a new uniform.
 *
 * `uShallow` is the ocean family's own luminous teal (`water.ts`'s depth
 * palette, and ART-DIRECTION.md 2: the three colour families stay separate,
 * so a wave gets its colour from the sea's ramp and not from the neon's). Cut
 * a little for a body colour rather than a shallows colour, and lifted in
 * green more than in blue, because thick water backlit through its own body
 * goes green before it goes bright.
 */
export const THICK_SCALE = 0.85;
export const THICK_GREEN = 0.05;
export const THICK_BLUE = 0.02;

/**
 * The lip band the Fresnel rim rides, and how much sky it catches.
 *
 * Read off `hazCrestMask` rather than off `hv`, so it is the top of the crest
 * on both sides and it weakens with the wave's strength: a strong wave is two
 * thirds of a great one and gets two thirds of the rim.
 *
 * Reading it off the mask is also why this band needed nothing done to it when
 * the along-length profile stopped being a plateau. The 0.45 to 0.9 contour of
 * a product of two profiles is whatever shape those profiles make: over a
 * plateau it was a rectangle with a corner at each end, which is the last place
 * a wave wants a bright line; over the ridge it is a lens, so the rim curves
 * down and away with the crest without a constant moving.
 */
export const LIP_LO = 0.45;
export const LIP_HI = 0.9;
export const LIP_RIM = 0.4;

/** `hazHeight0` over a full great wave, so the thickness term is 0..1 in the shader. */
const INV_CREST_HEIGHT = 1 / CREST_HEIGHT_MAX;

/**
 * Raises `hazCrestMask`, `steep`, `crestLift` and `tiltBoost`.
 *
 * The mask is the height profile's own shape (`hazRidge` along the crest,
 * `hazCrest` across it, with the same asymmetric front/back widths the height
 * uses) scaled by the wave's strength, so it is 1 on the crest line of a
 * full-strength great wave and fades with the envelope for free. Deriving it
 * from the profile rather than from `hazardHeight` keeps it per-kind: a
 * maelstrom in an adjacent slot must not raise it.
 *
 * All four are `max`, never assignment, and deliberately: the funnel branch
 * raises the same core locals from `hazardfunnel.ts`, and two hazards can
 * overlap. Whichever asks for more gets it.
 *
 * `hridge` is hoisted out of the mask so the shoulder term can read it. It is
 * the along-length profile alone, which is what makes `4 * r * (1 - r)` a
 * shoulder finder rather than a general "half height" finder: across the crest
 * the value does not vary, so the chop lands as two bands running down the two
 * ends of the wave and nowhere else.
 *
 * Everything is inside the loop, which breaks at `hi >= uHazCount`, so with no
 * hazards on the water not one line here executes and the open sea is the sea
 * it was before this file had a slope hook at all.
 */
export const CREST_SLOPE_GLSL: string = [
  '        float hridge = hazRidge(hu / ha);',
  '        float hbw = hb * (hv > 0.0 ? HAZ_CREST_FRONT : HAZ_CREST_BACK);',
  '        hazCrestMask = max(hazCrestMask, hridge * hazCrest(hv / hbw) * hstr);',
  `        steep = max(steep, clamp(length(hazSlope) * ${CREST_STEEP.toFixed(3)}, 0.0, 1.0) * hazCrestMask);`,
  `        crestLift = max(crestLift, hazHeight0 * hazCrestMask * ${CREST_LIFT.toFixed(3)});`,
  '        float hshoulder = 4.0 * hridge * (1.0 - hridge) * hazCrestMask;',
  `        tiltBoost = max(tiltBoost, 1.0 + ${SHOULDER_CHOP.toFixed(2)} * hshoulder);`,
].join('\n');

/**
 * A narrow band ON the lip, and streaks running down the face under it.
 *
 * The band used to be the whole story and used to be wide enough to cover the
 * front face; see FOAM_BAND for why that was the most damaging term on the
 * wave. What is left of it is a lip: the line that tells the eye where the top
 * of the wave is, which is the one job foam has to do here.
 *
 * Below it, `hrun` runs 0 at the crest line to 1 at the front foot, and is
 * clamped, so the whole streak layer is zero on the back face without a branch
 * -- the back of a wave is not spilling and should not be foaming. The noise is
 * sampled in that same (across, down) frame rather than in direction space, so
 * "stretched along the face" means the face and not some fixed world axis, and
 * it is advected toward the foot with `uTime`.
 *
 * Measured against the symmetric `hb`, deliberately, not against the
 * asymmetric front/back widths the HEIGHT uses: the band is a fixed width of
 * water in the world, and scaling it by the long tail would put most of the
 * froth behind the wave. `hrun` is the one exception, because it is measuring
 * the front face and nothing else.
 *
 * The band's two jobs are now the lip AND the silhouette. It wanders across the
 * crest with the froth noise and it tears through along the crest with the same
 * noise (`FOAM_WANDER`, `FOAM_TEAR`), so the brightest line on the wave -- the
 * one the eye follows to read where the top is -- is neither straight nor
 * squarely ended. That is the half of the mesa fix that geometry cannot reach:
 * a vertex every 0.5 world units draws the outline as a polyline whatever
 * profile it is sampling, and the only answer available to a fragment shader is
 * to stop the outline being the most confident thing in the picture.
 */
export const CREST_FOAM_GLSL: string = [
  '      float hridge = hazRidge(hu / ha);',
  // One noise, read twice: `hnoise` raw for the band's wander, because the
  // clamped `hbreak` below saturates for much of its range and a wander driven
  // by it would snap between two positions rather than wandering.
  `      vec3 hq = n * ${freq(FROTH_WAVELENGTH)} + vec3(uTime * ${FROTH_DRIFT.toFixed(4)});`,
  '      float hnoise = snoise(hq);',
  '      float hbreak = clamp(0.40 + 0.75 * hnoise, 0.0, 1.0);',
  `      float hcentre = ${FOAM_BIAS.toFixed(3)} + ${FOAM_WANDER.toFixed(3)} * hnoise;`,
  `      float hband = (hv - hb * hcentre) / (hb * ${FOAM_BAND.toFixed(3)});`,
  // The ridge, eaten into by the same noise, so the band ends in clumps
  // instead of dimming evenly down a shoulder. Solid at full ridge height
  // whatever the noise does; gone entirely once the ridge has fallen below
  // FOAM_TEAR on a dark patch of it.
  `      float htorn = clamp((hridge - ${FOAM_TEAR.toFixed(3)} * (1.0 - hbreak)) * ${FOAM_TEAR_INV.toFixed(4)}, 0.0, 1.0);`,
  '      float hcrest = htorn * hazBump(hband);',
  '      foam = max(foam, hcrest * hstr * hbreak);',
  '      float hrun = clamp(hv / (hb * HAZ_CREST_FRONT), 0.0, 1.0);',
  '      vec3 hsq = vec3(',
  `        hu * ${freq(STREAK_WIDTH)},`,
  `        hv * ${freq(STREAK_LENGTH)} - uTime * ${STREAK_FALL.toFixed(4)},`,
  `        uTime * ${STREAK_LIFE.toFixed(4)});`,
  `      float hstreak = smoothstep(${STREAK_LO.toFixed(3)}, ${STREAK_HI.toFixed(3)}, snoise(hsq));`,
  '      // Fading in under the lip band and out again over most of the run, so',
  '      // the streaks belong to the spill rather than starting or stopping on',
  '      // a line of their own. The fade out is long and starts early on',
  '      // purpose: a short one gives every streak the same clean bottom edge.',
  '      hstreak *= smoothstep(0.10, 0.40, hrun) * (1.0 - smoothstep(0.35, 1.0, hrun));',
  '      // Clumped by the same breakup noise the lip band uses, at a longer',
  '      // wavelength than the streaks themselves. Free (`hbreak` is already',
  '      // in hand) and it is what stops fifteen equally bright fingers from',
  '      // reading as a colonnade.',
  `      foam = max(foam, hstreak * hridge * hstr * (0.35 + 0.65 * hbreak) * ${STREAK_FOAM.toFixed(3)});`,
].join('\n');

/**
 * The thickness tint, and the Fresnel rim on the lip.
 *
 * Both are `hazCrestMask`-gated and both are exactly zero with no crest on
 * this pixel: `mix(col, x, 0.0)` and `col += x * 0.0` are the identity, so the
 * open sea is untouched to the last bit.
 *
 * The thickness term takes the SQUARE ROOT of the normalised height, because
 * the crest profile is already a cube and multiplying two copies of it
 * together would leave the tint on the lip alone. Fresnel is a floor plus a
 * slope rather than the `pow(fres, 0.5)` the plan sketched: a wave face seen
 * from the deck is close to head-on, `fres` there is a couple of percent, and
 * a bare Fresnel factor takes the tint away at exactly the framing this whole
 * stream exists for.
 */
export const CREST_COLOUR_GLSL: string = [
  `    float hthick = sqrt(clamp(hazHeight0 * ${INV_CREST_HEIGHT.toFixed(6)}, 0.0, 1.0));`,
  `    float hscope = clamp(hazCrestMask * ${CREST_SCOPE.toFixed(1)}, 0.0, 1.0);`,
  `    vec3 hbody = uShallow * ${THICK_SCALE.toFixed(3)} + vec3(0.0, ${THICK_GREEN.toFixed(3)}, ${THICK_BLUE.toFixed(3)});`,
  `    col = mix(col, hbody, hthick * hscope * (0.35 + 0.65 * fres) * ${CREST_THICK.toFixed(3)});`,
  `    float hazLip = smoothstep(${LIP_LO.toFixed(3)}, ${LIP_HI.toFixed(3)}, hazCrestMask);`,
  `    col += skyCol * fres * hazLip * ${LIP_RIM.toFixed(3)};`,
].join('\n');
