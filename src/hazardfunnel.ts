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
 * Which leaves one problem this module has to answer rather than inherit: a
 * radially symmetric height has a radially symmetric NORMAL, so a spiral drawn
 * only in the foam is a decal sliding over water that is not turning. The fix
 * is to put the spiral into `hazSlope` -- the shading gradient the skeleton
 * hands to `steepN` and to the `normal` hook -- as a purely TANGENTIAL lean.
 * A tangential term has no radial component, so it tilts the surface without
 * raising or lowering it, and `hazardHeight` (the thing the hull rides and the
 * thing parity pins) never learns about it. The eye gets a vortex; the physics
 * gets the same bowl it always had.
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

/**
 * The spiral phase, shared by the normal's ridges and the foam's arm mask so
 * the froth sits ON the ridges rather than beside them.
 *
 * `SPIRAL_ARMS` must stay a WHOLE number. `hth` is an `atan` with a branch cut
 * at +/- pi, and `sin(... + hth * arms)` is only continuous across that cut
 * when `arms` is an integer -- at 3.5 the funnel grows a radial seam.
 */
const SPIRAL_RADIAL_FREQ = 14.0;
const SPIRAL_ARMS = 3.0;

/**
 * Angular rate of the spin, radians per second, and how far the arms are
 * sheared into a spiral, radians across the funnel's radius.
 *
 * `docs/TEXTURE_PLAN.md` asks for a spin that RISES toward the centre
 * (`SPIRAL_SPIN * (0.4 + 1.2 * hin)`), which is how a real vortex reads. It
 * cannot be written that way and was tried: a phase of `uTime * f(r)` winds up
 * without bound, so `d(phase)/dr` grows as `uTime` does, and within a couple of
 * minutes of a session the funnel is wound into hundreds of rings across ten
 * units of water. The first cut of this file shipped it and photographed as a
 * disc of per-pixel static.
 *
 * So the wind-up is made STATIC instead: one rigid rate for the whole funnel,
 * and a fixed `SPIRAL_TWIST` of shear that turns the arms into a spiral and
 * then stops. A rigidly rotating spiral still reads as material running
 * inward, because the arms sweep toward the throat as they turn; what it gives
 * up is the differential itself, which is a fair trade for a pattern that is
 * the same in minute ten as in minute one. Left for the integration pass to
 * revisit only if it is willing to spend a second noise tap on a cross-faded
 * pair of rotations, which is the only bounded way to get the real thing.
 *
 * The sign convention is fixed by `docs/HAZARDS_PLAN.md`: capture spirals the
 * hull through `theta(s) = theta0 + 2*pi*TURNS*(s + s^2)/2`, so theta
 * INCREASES with time, and every phase below is written so that a feature at
 * constant phase moves the same way. Water and hull turn together or the
 * cutscene fights the sea it is set in.
 */
const SPIRAL_SPIN = 2.5;
const SPIRAL_TWIST = 1.8;

/**
 * How far the tangential swirl leans the shading normal, in slope units
 * (world height per world unit), at the throat and at full envelope.
 *
 * The funnel's own wall runs at about 0.2 to 0.46 over most of its radius, so
 * 0.30 is a corrugation of the same order as the wall it sits on: enough to
 * read as water being wound, not so much that the wall stops reading as a
 * smooth bowl underneath it.
 */
const SPIRAL_TILT = 0.3;

/**
 * How far out the swirl in the normal survives, world units of camera
 * distance.
 *
 * The funnel is 20 units across, so past about 150 units it is a smudge and a
 * spiralling normal on a smudge is just noise in the specular. Wider than the
 * wave field's own `nearMid` (50 to 105) because this feature is much larger
 * than the chop that fade is sized for.
 */
const SWIRL_FADE_NEAR = 60.0;
const SWIRL_FADE_FAR = 150.0;

/**
 * Turns the wall's own gradient into `steep`.
 *
 * Stream C uses 0.6 for a crest, whose front runs at a slope near 2. A funnel
 * wall is far gentler -- 0.46 at its steepest, on the bowl profile -- so the
 * same gain would hand the wall a tenth of the light it needs and the "clay"
 * this file exists to kill would survive. 1.6 puts the mid-wall around 0.7,
 * which is where the diffuse blend, the LOD and the sun road all start asking
 * the water instead of the sphere.
 */
const FUNNEL_STEEP_GAIN = 1.6;

/**
 * Extra chop on the wall: water being torn apart is rougher than water being
 * lifted. 1.6 rather than the plan's 2.0 because the raised `steep` above
 * hands the same wall the sun road as well, and the two together at full
 * strength turn the funnel into a glitter field.
 */
const FUNNEL_TILT_BOOST = 1.6;

/**
 * Noise frequencies, in cells per FUNNEL RADIUS (the sample point is divided
 * by `ha`, so 1.0 is the rim and a frequency of 2.2 is a blob about 4.5 world
 * units across on a 10-unit funnel).
 *
 * Three octaves and no more: broad arms that carry the read, a fine octave for
 * foam specks and torn edges, and a sparse one for the spray thrown past the
 * lip. The two small ones are multiplied by the core shader's own `fadeFine`,
 * which is the single most important line in this file -- see the comment on
 * it in FUNNEL_FOAM_GLSL.
 */
const ARM_FREQ = 2.2;
const SPECK_FREQ = 6.0;
const SPRAY_FREQ = 14.0;

/**
 * Where the arms-plus-noise sum becomes foam at all, and where it saturates.
 *
 * This is the single most important pair of numbers in the file and the first
 * cut did not have them: it used the noise as a level (`0.34 + 0.92 * n`),
 * which puts a fifth of a foam's worth of white on EVERY pixel of the funnel
 * and photographs as a gravel pit. A threshold instead leaves better than half
 * the wall as bare water and gathers the rest into streaks with dark sea
 * between them, which is what surf on a moving wall of water actually looks
 * like.
 */
const FOAM_ON = 0.12;
const FOAM_FULL = 0.52;

/**
 * How hard the three arms carve the noise, near and far.
 *
 * The arm mask is ADDED to the noise before the threshold rather than
 * multiplied over it afterwards, which is the difference between "foam
 * everywhere, a bit brighter on the arms" and "foam on the arms, bare water
 * between them". Multiplying was the second thing tried here and it came out
 * as a fluffy ring with blobs in it.
 *
 * Near the deck the arms are most of the signal. From orbit the same contrast
 * is a 20-pixel disc flickering between two greys, so their weight is halved
 * and the funnel softens into a rotating smudge instead.
 */
const ARM_WEIGHT_NEAR = 0.85;
const ARM_WEIGHT_FAR = 0.35;

/** How fast each octave boils, independently of the spin that carries it round. */
const ARM_DRIFT = 0.2;
const SPECK_DRIFT = 0.55;
const SPRAY_DRIFT = 1.1;

/**
 * The lip, as an art copy of the height's own rim band.
 *
 * `HAZ_RIM_INV` is the reciprocal of a half-width, so multiplying it by 0.85
 * makes the band 1.18 times WIDER (0.141 of the radius rather than 0.12). The
 * height's lip is 2 to 3 patch vertices across and looks like the polygon it
 * is; the light on it does not have to be, and a softer band is what stops the
 * rim reading as a drawn circle.
 *
 * The plan asked for 0.6, which is 1.67 times wider, and at that width the lip
 * alone covers 40% of the funnel's radius: the funnel photographs as a fluffy
 * white doughnut with a puddle in it and no wall anywhere. Most of what 0.6
 * was reaching for is delivered by RIM_RAGGED below instead, which breaks the
 * ring up without spreading it.
 */
const RIM_ART_INV_SCALE = 0.85;

/** How far the noise is allowed to push the lip's radius in or out, in funnel radii. Thrown water, not a compass arc. */
const RIM_RAGGED = 0.055;

/** Brightness of the wall's streaks, of the lip band, and of the spray specks outside it. */
const WALL_STRENGTH = 0.85;
const LIP_STRENGTH = 0.6;
const SPRAY_STRENGTH = 0.55;

/** How far the funnel's centre is dragged toward the throat colour. Under a full mix, so the hole still reads as water rather than as a hole cut in the frame. */
const FUNNEL_DARKEN = 0.6;

/**
 * The colour the throat is dragged toward, LINEAR (every `u...` colour reaches
 * the shader linear, so a literal beside them has to be too).
 *
 * `uAbyss` was the old target and it is very nearly black: mixed 60% into the
 * funnel it took the hue out along with the value, and a matte grey-black hole
 * is exactly the "decal" read this file is fixing. This is `uShelf`
 * (`#0a6b78`, the sea ramp's own teal) at 0.145 of its value -- the same hue
 * the shallows already carry, taken down to abyssal brightness. So the throat
 * is dark AND saturated, which with the raised `steep` above leaves the
 * specular somewhere to land: dark and glossy rather than dark and matte.
 * Nothing new enters the palette, per ART-DIRECTION.md section 2 (and magenta,
 * section 2.4, is UI-only and cannot appear here at all).
 */
const FUNNEL_THROAT = 'vec3(0.0005, 0.0214, 0.0272)';

/** A share of the sky on the funnel's wall, so wet water reads wet. */
const FUNNEL_GLOSS = 0.22;

/**
 * Raises `hazFunnelMask`, raises the core seam's `steep` and `tiltBoost`, and
 * winds the spiral into the shading gradient.
 *
 * `hazFunnelMask` is `(1 - r)^2` scaled by the growth envelope -- the same term
 * the colour hook has always used to darken the centre, hoisted here so the
 * slope, foam and colour hooks all read one definition instead of three.
 *
 * `hwall` is a SECOND, broader mask, and the difference matters. The darkening
 * mask is peaked at the throat because that is where the water is deepest; the
 * wall the light has to find is at mid-radius, where `(1 - r)^2` has already
 * fallen to a quarter. Gating `steep` on the darkening mask would light the
 * hole and leave the wall around it as flat as it is today.
 *
 * Order inside the branch is load bearing: `steep` is taken from `hazSlope`
 * BEFORE the swirl is added to it. The other way round, how steep the shader
 * believes the wall to be would pulse with the arms turning over it, and the
 * LOD and the sun road would pulse with it.
 */
export const FUNNEL_SLOPE_GLSL: string = [
  '        hazFunnelMask = max(hazFunnelMask, hin * hin * henv);',
  '        if (hin > 0.0) {',
  '          float hwall = smoothstep(0.0, 0.30, hin) * henv;',
  // max(), never assignment: hazardcrest.ts raises the same core local from
  // the crest branch of this same loop and the two must not clobber each
  // other. Both are zero when uHazCount is 0, because this loop does not run.
  `          steep = max(steep, clamp(length(hazSlope) * ${FUNNEL_STEEP_GAIN.toFixed(2)}, 0.0, 1.0) * hwall);`,
  `          tiltBoost = max(tiltBoost, 1.0 + ${FUNNEL_TILT_BOOST.toFixed(2)} * hwall);`,
  '',
  // The outward direction in the funnel's own plane, from the same two tangent
  // vectors the height's dot products are taken against. `hu`/`hv` are already
  // that point's coordinates in that frame, so this is the radial unit vector
  // without a second atan/sin/cos round trip.
  '          vec3 hrad = uHazEast[hi] * hu + uHazNorth[hi] * hv;',
  '          if (length(hrad) > 1e-7) {',
  '            vec3 htan = normalize(cross(n, hrad));',
  '            float hth = atan(hv, hu);',
  `            float hphase = sin(hr * ${SPIRAL_RADIAL_FREQ.toFixed(1)} - uTime * ${SPIRAL_SPIN.toFixed(2)} + hth * ${SPIRAL_ARMS.toFixed(1)});`,
  `            float hswirl = ${SPIRAL_TILT.toFixed(3)} * hphase * hin * henv`,
  `                         * (1.0 - smoothstep(${SWIRL_FADE_NEAR.toFixed(1)}, ${SWIRL_FADE_FAR.toFixed(1)}, camDist));`,
  // Added into `hazSlope` rather than kept aside, because that is the ONE
  // vector that reaches both consumers: the skeleton builds `steepN` from it
  // after this loop, and its `normal` hook leans `N` by it a few lines later.
  // A crest sharing the frame reads the sum, exactly as it already reads the
  // sum of both hazards' height gradients.
  '            hazSlope += htan * hswirl;',
  '          }',
  '        }',
].join('\n');

/**
 * Three arms winding inward, the lip, and spray thrown past it.
 *
 * What this replaces was `0.5 + 0.5 * sin(...)` raised to the fourth: perfectly
 * circular, perfectly regular, every arm identical, and rotating rigidly. The
 * eye reads that as a printed pattern sliding over the sea, which is precisely
 * what the baseline screenshots show.
 *
 * The arms are noise sampled in a frame rotated about the funnel's centre and
 * sheared into a spiral, then thresholded into streaks and masked by the three
 * arms. Three octaves: the arms themselves, a finer one for specks and for the
 * lip's torn edge, and a sparse one for spray outside the rim. The two small
 * ones ride the core shader's own `fadeFine` and are gone by orbit; the broad
 * one stays, because it is what says "maelstrom" from up there.
 *
 * The whole body is gated on `hr < 1.30`. The slot loop runs on every pixel of
 * the ocean, and three `snoise` taps on open water to draw a funnel 20 units
 * across is the sort of thing that makes a plugin cost what a feature costs.
 */
export const FUNNEL_FOAM_GLSL: string = [
  '      if (hr < 1.30) {',
  // The sample frame, turned about the funnel's centre. Rotating the frame
  // rather than adding to `hth` is not a stylistic choice: `hth` has a branch
  // cut at +/- pi and noise is not periodic in its argument, so
  // `snoise(vec3(hr, hth + drift, ...))` puts a hard radial seam down one side
  // of every funnel. A rotation in the funnel's own Cartesian plane has none.
  `        float hang = -uTime * ${SPIRAL_SPIN.toFixed(2)};`,
  '        float hcos = cos(hang);',
  '        float hsin = sin(hang);',
  '        vec2 hp = vec2(hu, hv) / ha;',
  '        vec2 hq = vec2(hcos * hp.x - hsin * hp.y, hsin * hp.x + hcos * hp.y);',
  // And a second copy of it, sheared by a fixed angle per unit radius: this is
  // the spiral. Static, so it costs two trig calls and never winds tighter
  // than it is here. Only the broad octave is twisted -- shearing the fine one
  // as well would multiply its tangential frequency by the same factor and put
  // it straight back over the pixel it is being faded to avoid.
  `        float htw = -${SPIRAL_TWIST.toFixed(2)} * hr;`,
  '        float htc = cos(htw);',
  '        float hts = sin(htw);',
  '        vec2 hqa = vec2(htc * hq.x - hts * hq.y, hts * hq.x + htc * hq.y);',
  '',
  // The low-frequency arms. Kept as a MASK over the noise rather than as the
  // pattern itself: without it the funnel foams like static, with it the read
  // is still a whirlpool. Same phase as the spiral in the normal above, so the
  // froth lies along the ridges rather than across them.
  `        float harmMask = 0.5 + 0.5 * sin(hr * ${SPIRAL_RADIAL_FREQ.toFixed(1)} - uTime * ${SPIRAL_SPIN.toFixed(2)} + hth * ${SPIRAL_ARMS.toFixed(1)});`,
  `        float hbroad = snoise(vec3(hqa * ${ARM_FREQ.toFixed(2)}, uTime * ${ARM_DRIFT.toFixed(2)}));`,
  // A THRESHOLD, not a level. See FOAM_ON/FOAM_FULL: this is what makes the
  // wall streaky rather than uniformly pale, and it is the difference between
  // a whirlpool and a gravel pit. The arms are added INTO what is thresholded,
  // so they carve the noise into bands rather than merely brightening it.
  `        float harmWeight = mix(${ARM_WEIGHT_FAR.toFixed(2)}, ${ARM_WEIGHT_NEAR.toFixed(2)}, nearMid);`,
  '        float hmix = hbroad * 0.65 + (harmMask - 0.45) * harmWeight;',
  `        float harms = smoothstep(${FOAM_ON.toFixed(2)}, ${FOAM_FULL.toFixed(2)}, hmix);`,
  '',
  // `fadeFine` is the core shader's own answer to "how much fine detail is
  // this pixel worth", distance and grazing angle together (waterglsl.ts). At
  // orbit height this funnel is about 20 pixels wide and a six-cells-per-radius
  // octave there is a shimmering mess; riding the same fade the wave field's
  // own chop rides means the funnel loses its speckle at exactly the distance
  // the sea loses its.
  `        float hspeck = snoise(vec3(hq * ${SPECK_FREQ.toFixed(2)}, uTime * ${SPECK_DRIFT.toFixed(2)} + 17.3)) * fadeFine;`,
  '        harms = clamp(harms * (0.80 + 0.45 * hspeck), 0.0, 1.0);',
  '',
  // Streaks over the whole wall, not a bright disc at the throat. `hin` alone
  // (which is what the old band used) puts everything in the middle and leaves
  // the wall between the throat and the lip bare, which is the half of the
  // funnel the camera actually looks at from the deck.
  `        float hwallFoam = harms * smoothstep(0.0, 0.18, hin) * ${WALL_STRENGTH.toFixed(2)};`,
  '',
  // The lip. The noise displaces the band's RADIUS rather than its brightness,
  // so the ring comes out ragged like thrown water instead of like a circle
  // with the contrast turned down.
  `        float hlipR = hr + (hbroad * 0.6 + hspeck * 0.4) * ${RIM_RAGGED.toFixed(3)};`,
  `        float hlip = hazBump((hlipR - HAZ_RIM_C) * HAZ_RIM_INV * ${RIM_ART_INV_SCALE.toFixed(2)});`,
  '',
  `        foam = max(foam, clamp((hwallFoam + hlip * ${LIP_STRENGTH.toFixed(2)}) * henv, 0.0, 1.0));`,
  '',
  // Spray, outside the lip only, and nested so the sea past the rim does not
  // pay for a tap it cannot show. Faded by `fadeFine` as hard as the speckle
  // is: sparse bright dots are the first thing to alias when the funnel is
  // twenty pixels wide.
  '        if (hr > 0.88) {',
  `          float hsp = snoise(vec3(hq * ${SPRAY_FREQ.toFixed(2)}, uTime * ${SPRAY_DRIFT.toFixed(2)} + 31.7));`,
  '          float hspray = smoothstep(0.55, 0.95, hsp)',
  '                       * smoothstep(0.88, 0.99, hr) * (1.0 - smoothstep(1.02, 1.30, hr));',
  `          foam = max(foam, clamp(hspray * ${SPRAY_STRENGTH.toFixed(2)} * fadeFine * henv, 0.0, 1.0));`,
  '        }',
  '      }',
].join('\n');

/**
 * Drags the funnel's throat toward a saturated deep green-blue, and puts a
 * share of the sky back on its wall.
 *
 * The second line is what makes the first survivable. Darkening alone gives a
 * matte hole; a Fresnel share of `skyCol` gives the near wall -- the one the
 * camera sees at a grazing angle, so `fres` is high there and low on the far
 * wall facing it -- a wet rim that moves with the view. Together with the
 * `steep` raised in the slope hook they are the whole of "dark and glossy".
 */
export const FUNNEL_COLOUR_GLSL: string = [
  `  col = mix(col, ${FUNNEL_THROAT}, clamp(hazFunnelMask * ${FUNNEL_DARKEN.toFixed(4)}, 0.0, 1.0));`,
  `  col += skyCol * fres * hazFunnelMask * ${FUNNEL_GLOSS.toFixed(4)};`,
].join('\n');
