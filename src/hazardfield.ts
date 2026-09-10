/**
 * hazardfield.ts — the height field for strong waves and maelstroms, in the
 * two forms that have to agree: GLSL for the sea the player sees, and a
 * float32 CPU port for the sea the hull rides.
 *
 * This is `waveconstants.ts` + `wavefield.ts` again, for a second field, and
 * for the same reason: `HAZARD_GLSL` is pasted into the sphere's fragment
 * shader (via `waterhazard.ts`'s plugin declarations), into the displacement
 * patch's vertex shader (`waterpatch.ts`), and into `?probe=hazard`; the CPU
 * `hazardHeight` below is what `ship.ts` samples at the hull. A change to one
 * without the other is a silent desync — nothing fails to compile, the hull
 * just quietly stops riding the water it looks like it is riding.
 *
 * THE ONE RULE, and the reason parity is affordable at all: **the height is
 * polynomial, plus one sqrt**. No sin, cos, exp, pow or noise anywhere in it.
 * Those are the transcendentals whose last bits differ between a GPU and
 * `Math` — `dev/probe.ts` already had to design around exactly that, and its
 * comment on normalising with `sqrt` instead of sin/cos is the same argument.
 * The spin of a maelstrom and the froth on a crest are fragment-side art, in
 * `waterhazard.ts`'s `foam` and `colour` hooks, where sin and snoise are
 * welcome because nothing on the CPU has to match them.
 *
 * Local coordinates are dot products, never angles: for a surface direction
 * `p`, `u = dot(p, east)` and `v = dot(p, north)` in direction units. That is
 * the small-angle approximation — at 30 units on a radius of 200 the error is
 * under 0.2%, and both sides make the same error.
 *
 * One consequence of dotting against `p` itself rather than against
 * `p - centre`: the profile evaluates to its centre value at the hazard's
 * ANTIPODE too, where both dot products pass back through zero. That ghost is
 * unreachable rather than merely unlikely — `hazards.ts` fades `envelope` to
 * zero beyond 38 units from the hull, so any hazard with a non-zero envelope
 * has its antipode about 628 units away: off the displacement patch, over the
 * globe's horizon, and nowhere near the five points the hull samples. Left as
 * written rather than gated, because a gate would be arithmetic on every
 * pixel to suppress something no pixel can show.
 */
import { GLOBE_RADIUS } from './geo';
import type { Hazard } from './types';

/* ------------------------------------------------------------------ */
/* Sizes, world units (ship-scale)                                      */
/* ------------------------------------------------------------------ */

/*
 * Every size here is SHIP-SCALE: an absolute number of world units, sized
 * against a 3.1-unit hull and an 80-unit displacement patch, which does not
 * grow with GLOBE_RADIUS. See docs/ARCHITECTURE.md "World scale". They are
 * converted to direction space (divided by the radius) at the point of use,
 * exactly as `wavefield.ts` converts NORMAL_STEP.
 */

/**
 * How many hazards can be alive at once, and the bound that sizes the
 * shader's uniform arrays and its fragment loop.
 *
 * Six: five crests and one maelstrom (`hazards.ts` owns that split, in
 * CAPACITY). It was three, and it was three because the sea began as one of
 * each of three kinds; two of those kinds became one, and the freed slot was
 * spent on a second crest rather than reclaimed.
 *
 * Doubling it is the owner's ask for a sea that can raise up to five waves at
 * once. The cost is real and is paid per PIXEL, not per hazard: the fragment
 * shader evaluates `hazardHeight` three times to build its normal, so the
 * worst case here is eighteen slot iterations a pixel where it was nine. The
 * loop still breaks on `uHazCount`, so a quiet sea costs exactly what it did
 * -- this is a ceiling on a busy one, not a new floor.
 */
export const MAX_HAZARDS = 6;

/**
 * A crest's half-length and half-width, world units, so the wave is 20 long
 * across its travel line and 5 deep along it.
 *
 * Six hull lengths of front against one and a half of depth: long enough that
 * dodging one means a real course change rather than a flick of the helm,
 * narrow enough that it passes over in about a second at CREST_SPEED_REF and
 * reads as a wave rather than as the sea rising.
 */
export const CREST_HALF_LENGTH = 10;
export const CREST_HALF_WIDTH = 2.5;

/**
 * The half-length a crest may ROLL for itself at spawn, world units, and the
 * ceiling it may grow to afterwards.
 *
 * `CREST_HALF_LENGTH` above is no longer the length of every wave; it is the
 * middle of this range and the reference every other size here is still
 * argued against. A wave now draws its own half-length uniformly between
 * these two -- 12 to 24 world units of front, against a 3.1-unit hull -- for
 * the same reason it already drew its own width: a sea in which every wave is
 * the same twenty units long is a sea a player reads once.
 *
 * The MIN is doubled from the 3 this shipped with, on the owner's reading
 * that the shortest waves were too narrow to be waves. It was 6 world units
 * of front against a hull half that long: a wave the ship could simply pass
 * by the end of, and one that read as a lump in the water rather than as a
 * front worth altering course for. 12 units is four hull lengths, which is
 * the least that still asks a question of the helm. The MAX is deliberately
 * untouched, so this narrows the rolled range rather than sliding it: the sea
 * loses its stubs and keeps everything it had above them.
 *
 * The CAP is what stops item 3's growth running away. A crest gains 10% of
 * its length a second and the longest-lived one on the slowest roll is on the
 * water for CREST_LIFE_MAX seconds, which compounds well past anything the
 * displacement patch can draw: the patch is 80 world units square and skirts
 * its own displacement from 34 units out, so a front wider than about 40
 * units has ends hanging in undisplaced water. 20 of half-length is that 40,
 * and it is twice the wave this file shipped with.
 */
export const CREST_HALF_LENGTH_MIN = 6;
export const CREST_HALF_LENGTH_MAX = 12;
export const CREST_HALF_LENGTH_CAP = 20;

/**
 * Peak crest height, world units: the middle of the rolled range, the two
 * ends a wave may RISE at, and the ceiling growth may carry it to.
 *
 * The ordinary sea peaks at DISPLACE_AMPLITUDE (0.3) in a full gale, so even
 * the smallest wave here is four times the worst weather. The hull's
 * freeboard is about a unit: a wave at the top of this range is meant to
 * tower over the deck.
 *
 * `CREST_HEIGHT_MAX` is the number that used to be called GREAT_CREST_HEIGHT,
 * unchanged at 2.4, and that is deliberate. The great wave is gone as a KIND,
 * but the silhouette it drew is exactly what a tall wave that has lived a
 * while now grows into, so nothing on screen is bigger than the game already
 * shipped -- the difference is that the player meets the whole range between
 * the two rather than one of two fixed sizes.
 */
export const CREST_HEIGHT = 1.6;
export const CREST_HEIGHT_MIN = 1.2;
export const CREST_HEIGHT_MAX_START = 2.0;
export const CREST_HEIGHT_MAX = 2.4;

/**
 * A maelstrom's radius at full size, world units, so the funnel is 20 across.
 *
 * Six hull lengths, and two fifths of the scope's 50-unit range: big enough
 * to be a landmark on the radar and to be genuinely hard to slip past at
 * close quarters, small enough to steer around with any warning at all.
 */
export const MAELSTROM_RADIUS = 10;

/**
 * How far the funnel's centre sinks below the sea, and how high its lip
 * stands above it, world units.
 *
 * Ten times the gale's own amplitude down. It has to read as a hole rather
 * than as a dark patch from the chase camera, which looks along the surface
 * rather than down onto it.
 *
 * That last sentence was the goal at 3.0 and 3.0 did not meet it, so it was
 * doubled to 6.0 -- and the doubling was chasing the wrong fault. None of
 * either depth was reaching the screen: the sphere's own flat water shell was
 * drawn over the hole and depth-killed every pixel inside it, so 3.0 and 6.0
 * photographed identically, as a foam ring on flat sea. `waterpatch.ts`'s
 * PATCH_CULL_HALF is the fix for that, and it is what makes any of this
 * number visible at all.
 *
 * With the hole actually drawn, 6.0 is more than the shape needs: 30% depth
 * to width is a shaft, and from the chase camera the far wall climbs high
 * enough to read as a crater rather than as water turning. 4.0 -- 20% depth
 * to width, a hole twenty units across and four deep -- keeps the descent the
 * eye can follow down and gives back the openness. Still well past the 15%
 * that made it a saucer, and still about two thirds of a hull length of drop.
 *
 * Three things this deliberately does NOT change. The lip stays 0.35: a
 * higher rim on a deeper bowl reads as a crater. `MAELSTROM_RADIUS` stays 10,
 * so the thing is no harder to steer around than it was. And the profile is
 * the same polynomial, so parity is untouched -- this is one constant, and
 * both ports read it.
 */
export const FUNNEL_DEPTH = 4.0;
export const RIM_HEIGHT = 0.35;

/**
 * Finite-difference step for the hazard normal, world units.
 *
 * Deliberately its OWN step and not `water.ts`'s private NORMAL_STEP (0.16):
 * that one is sized to the 1.7-unit chop wavelength, and a hazard's smallest
 * feature is the 0.3-wide rim band, so a step three times larger samples the
 * shape rather than the noise floor and costs nothing in accuracy on a field
 * this smooth.
 */
export const HAZ_STEP_WORLD = 0.5;

/** Direction-space forms, for the shader literals and the CPU port. */
export const CREST_HALF_LENGTH_DIR = CREST_HALF_LENGTH / GLOBE_RADIUS;
export const CREST_HALF_WIDTH_DIR = CREST_HALF_WIDTH / GLOBE_RADIUS;
export const MAELSTROM_RADIUS_DIR = MAELSTROM_RADIUS / GLOBE_RADIUS;
export const HAZ_STEP_DIR = HAZ_STEP_WORLD / GLOBE_RADIUS;

/** `uHazShape.x` — which profile a slot carries. Shared by the GLSL and the CPU port. */
export const SHAPE_CREST = 0;
export const SHAPE_MAELSTROM = 1;

/* ------------------------------------------------------------------ */
/* Profile numbers, baked once for both sides                           */
/* ------------------------------------------------------------------ */

/**
 * A number in the two forms the two sides need: the decimal literal the
 * shader compiles, and the float32 that literal becomes.
 *
 * Same trick, and the same reason, as `waveconstants.ts`'s `freq`/
 * `freqNumber` pair: the CPU port bakes in the value the shader ACTUALLY
 * compiles rather than the more precise ratio it was rounded from, so a
 * constant the two sides share can never be rounded two different ways.
 */
interface Baked {
  readonly glsl: string;
  readonly value: number;
}

function bake(n: number): Baked {
  const glsl = n.toFixed(8);
  return { glsl, value: Math.fround(Number(glsl)) };
}

/*
 * The crest's profile along its own length used to need two constants here --
 * a shoulder position and the reciprocal of its width -- because it was
 * `1 - smoothstep(edge, 1, |x|)`. `hazRidge` below needs neither, and that is
 * worth a line: every baked constant is a number the shader's literal and the
 * CPU's float32 have to be rounded from identically, so a profile that needs
 * none of them is one fewer thing the two ports can drift on.
 */

/**
 * The crest's front and back half-widths, as multiples of `halfWidth`.
 *
 * A wave is not symmetric about its own crest line and the first cut of this
 * file made it one: `bump(v / halfWidth)` gave a rounded hump 5 units through
 * with 2.4 of height on it, and at that aspect it reads as a slab of ice with
 * a flat top rather than as a sea running.
 *
 * So the profile is asymmetric about `v = 0`, which is the crest line itself.
 * Ahead of it -- `v > 0`, the way the wave is travelling -- the face is 2
 * units of run against 2.4 of rise, which is the steep wall the hull meets.
 * Behind it the water lets down over 6, so the wave has a back to it and the
 * ship rides off rather than falling off. The two are read against the SAME
 * `halfWidth` the contact test uses, so widening the tail here never widens
 * what the hull can be hit by.
 *
 * The branch on `v > 0` is safe for parity, which is the only reason it is
 * allowed to exist: at `v` near zero both widths give a crest factor of very
 * nearly 1, and the two differ by O(v^2), so a GPU and a CPU that round `v`
 * to opposite sides of zero disagree by something around 1e-18.
 *
 * Both numbers were re-examined when `hazRidge` was reshaped and both are
 * deliberately unchanged. The ask was a face that is steeper near the lip and
 * gentler at the base, the way a spilling breaker is, and a height field
 * cannot have one. `hazCrest` starts at the crest line with zero slope --
 * which is what makes the crest line a rounded top rather than a knife edge,
 * and what lets the two branches meet there without a crease -- so its
 * steepest point is necessarily inside the face rather than at its lip. It
 * already is: on a great wave the front runs 0 degrees at the lip, 64 at 45%
 * of the way down and back toward flat at the foot. Buying a steeper lip means
 * either a slope discontinuity along the crest line, which is the same hard
 * corner `hazRidge` was reshaped to remove, only turned ninety degrees, or
 * a surface that folds over itself, which no height field is. And there is
 * nowhere to spend the difference anyway: the front is 2.0 world units against
 * a vertex every 0.5, so the whole face is four quads and redistributing slope
 * inside four quads is arithmetic nobody can see.
 */
/**
 * The most a crest's ends may trail behind its centre, as a fraction of its
 * own half-length. `hazards.ts` rolls each wave a `bow` in [0, this].
 *
 * A wave was a straight wall of water: `hazardHeight` measured the along-
 * travel coordinate `v` as a plain dot product, so the crest line was the
 * intersection of a plane with the sphere and every wave in the game was the
 * same geodesic segment. That is what a wave looks like in a tank and not
 * what one looks like at sea, where a front radiating out from wherever it
 * was raised reaches the observer bowed, middle first.
 *
 * `hazBowV` below is the whole of the change and it is one term: `v` is
 * displaced by `bow * a * (u/a)^2`, so the crest line runs from the centre
 * back to `bow * a` behind it at each end. A parabola and not a true circular
 * arc, on purpose -- it is polynomial, which is the one rule this file has
 * (see the module comment), so the GPU and the CPU port can still be held
 * bit-identical, and over a half-length of 20 units the two curves differ by
 * less than the patch's own vertex spacing anyway.
 *
 * 0.35 against the longest wave this can roll is 7 world units of trail at
 * each end: a little over two hull lengths, which is an arc the player can
 * plainly see from the chase camera and still a front rather than a ring.
 */
export const CREST_BOW_MAX = 0.35;

export const CREST_FRONT_RATIO = 0.8;
export const CREST_BACK_RATIO = 2.4;
const CREST_FRONT = bake(CREST_FRONT_RATIO);
const CREST_BACK = bake(CREST_BACK_RATIO);

/**
 * Where the maelstrom's raised lip sits as a fraction of the funnel radius,
 * and the reciprocal of its half-width (0.18 of the radius: 1.8 units on a
 * 10-unit funnel).
 *
 * The two are one number really: 0.82 + 0.18 is exactly 1, so the lip's outer
 * edge dies precisely where the bowl does and the whole maelstrom has compact
 * support inside its own radius. Nothing of it, not a thousandth of a unit of
 * standing water, is left outside `r = 1` for the hull to trip over or for
 * the patch to shade -- which the 0.9-centred, 0.12-wide lip this shipped
 * with could not say, since it ran out to 1.02 radii.
 *
 * The half-width is 1.5x what it was, and that is the whole reason the centre
 * moved in. The displacement patch lays a vertex every half world unit, so
 * 1.2 units of half-width was two and a half vertices a side: the lip drew as
 * a ragged polygonal ring rather than as a ring of thrown water. 1.8 is
 * nearer four a side, which is about the least a curve can be drawn with.
 */
const RIM_CENTRE = bake(0.82);
const RIM_INV = bake(1 / 0.18);

/**
 * The lip's height as a fraction of the funnel's depth.
 *
 * The whole maelstrom profile is scaled by `uHazShape.w` (the depth times the
 * envelope), so the lip has to be carried as a RATIO rather than as an
 * absolute height: that is what makes it grow in with the funnel and leave
 * with it, instead of leaving a 0.35-unit ring of standing water behind a
 * maelstrom that has finished shrinking.
 *
 * Since the lip replaces the bowl beneath it rather than riding on top of it
 * (see `hazardHeight`), this ratio is also the exact maximum of the whole
 * maelstrom profile, reached exactly at `RIM_CENTRE`: RIM_HEIGHT of water
 * above the sea, no more, whatever the bowl underneath is doing.
 */
const RIM_RATIO = bake(RIM_HEIGHT / FUNNEL_DEPTH);

/**
 * Floor under a slot's radius and half-width before anything divides by them.
 *
 * A maelstrom's radius is `extent * size` and `size` starts at exactly 0, so
 * without this the first frame of a spawn divides 0 by 0 at the centre pixel
 * and one NaN poisons the whole sum for every hazard behind it. Small enough
 * to change no real size: 1e-9 direction units is 200 nanometres of ocean.
 */
const MIN_SIZE: Baked = { glsl: '1e-9', value: Math.fround(1e-9) };

/* ------------------------------------------------------------------ */
/* Slot packing — the one place a Hazard becomes four numbers           */
/* ------------------------------------------------------------------ */

/*
 * `waterhazard.ts` writes the uniforms with these and the CPU port below
 * reads them, so the GPU's slot and the CPU's Hazard can never disagree about
 * what a hazard's size or strength is — not even in the last bit, since both
 * get the identical float32 out of the identical expression. Each rounds
 * ONCE, at the end, which is exactly what happens to a float64 JS value when
 * Three uploads it into a float32 uniform.
 */

/** `uHazShape.x` — which of the two profiles this hazard's slot carries. */
export function hazardShapeKind(h: Hazard): number {
  return h.kind === 'maelstrom' ? SHAPE_MAELSTROM : SHAPE_CREST;
}

/**
 * `uHazShape.y` — half-length (crest) or radius (maelstrom), direction units.
 *
 * Scaled by `size`, which is how a maelstrom grows and shrinks; `size` is
 * always 1 for a crest, which fades by its envelope instead.
 */
export function hazardExtentDir(h: Hazard): number {
  return Math.fround((h.extent * h.size) / GLOBE_RADIUS);
}

/** `uHazShape.z` — a crest's half-width, direction units. 0 for a maelstrom. */
export function hazardHalfWidthDir(h: Hazard): number {
  return Math.fround(h.halfWidth / GLOBE_RADIUS);
}

/**
 * `uHazBow[i]` — how far this crest's ends trail behind its centre, as a
 * fraction of its own half-length.
 *
 * DIMENSIONLESS, so unlike its neighbours here there is no division by the
 * radius: it is a ratio of two lengths and it means the same thing in world
 * units and in direction units. Forced to 0 for a maelstrom, whose profile
 * never reads it, so a slot recycled from a crest cannot leave a funnel
 * carrying a bow.
 */
export function hazardBow(h: Hazard): number {
  return h.kind === 'maelstrom' ? 0 : Math.fround(h.bow);
}

/**
 * `uHazBreak[i]` — how far each end of this crest has been broken by the
 * coast, 0..1: the -east end and the +east end.
 *
 * DIMENSIONLESS, like `hazardBow` and for the same reason: a share, not a
 * length, so no division by the radius. Forced to 0 for a maelstrom, whose
 * profile never reads it, so a slot recycled from a broken crest cannot leave
 * a funnel with a bite taken out of it.
 */
export function hazardBreakNeg(h: Hazard): number {
  return h.kind === 'maelstrom' ? 0 : Math.fround(h.breakNeg);
}

export function hazardBreakPos(h: Hazard): number {
  return h.kind === 'maelstrom' ? 0 : Math.fround(h.breakPos);
}

/**
 * `uHazShape.w` — the profile's scale in WORLD units: peak height for a
 * crest, funnel depth for a maelstrom, times the envelope (which already
 * carries the distance fade — see `Hazard.envelope`).
 *
 * POSITIVE for both kinds. A maelstrom's `amplitude` is the funnel's DEPTH,
 * not a signed height: the minus sign lives inside the profile, so the lip
 * can be a positive fraction of the same number. A negative `amplitude` out
 * of `hazards.ts` would raise a mountain where the hole belongs — on both
 * sides identically, so the parity test would still pass and only the sea
 * would be wrong.
 */
export function hazardStrength(h: Hazard): number {
  return Math.fround(h.amplitude * h.envelope);
}

/* ------------------------------------------------------------------ */
/* GLSL                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The uniform block and `float hazardHeight(vec3 p)`, pasted verbatim into
 * every consumer. Built as a joined array of lines, per the house rule in
 * docs/ARCHITECTURE.md "Shader notes".
 *
 * The loop runs to the CONSTANT `MAX_HAZARDS` and breaks on `uHazCount`
 * rather than looping to `uHazCount` directly. These legacy-style
 * `ShaderMaterial`s compile as GLSL ES 1.00, which only lets a fragment
 * shader index a uniform array by a constant-index-expression, and a loop
 * index only counts as one when the loop's own bound is constant. Written the
 * obvious way this compiles on some drivers and not on others.
 *
 * Both profiles are branchless inside themselves: `max(..., 0.0)` is what
 * gives `bump` and the funnel their compact support, rather than an `if`.
 */
/**
 * The two half-width ratios, as the GLSL `const float`s both crests compile.
 *
 * Split out of `HAZARD_GLSL` below so the arena's own wall of water
 * (`battlewave.ts`) can declare the identical pair without dragging the
 * sphere's uniform block in with it. Spliced back into `HAZARD_GLSL`
 * unchanged, so the shader the globe compiles is the string it always was.
 */
export const HAZ_CREST_RATIO_GLSL: string = [
  `const float HAZ_CREST_FRONT = ${CREST_FRONT.glsl};`,
  `const float HAZ_CREST_BACK = ${CREST_BACK.glsl};`,
].join('\n');

/**
 * `hazBump`, `hazCrest` and `hazRidge`: the three profiles, and nothing that
 * knows where they are being evaluated.
 *
 * Split out for the same reason `HAZ_CREST_RATIO_GLSL` above is, and it is
 * the more important of the two: the arena's crest is meant to be the SAME
 * wave the open sea raises, and the only way to be sure of that is for both
 * to compile these characters rather than two transcriptions of them. Nothing
 * here reads a uniform, so it costs the arena no slot block; it is spliced
 * back into `HAZARD_GLSL` unchanged.
 */
export const HAZARD_PROFILE_GLSL: string = [
  '// (1 - x*x)^2 inside |x| < 1, zero outside. Its own square root is the',
  '// wider, softer skirt the foam hook rides, and it is also the maelstrom',
  '// bowl and the maelstrom lip below: one shape, rounded one way, is one',
  '// fewer thing for the two ports to disagree about.',
  'float hazBump(float x) {',
  '  float t = max(1.0 - x * x, 0.0);',
  '  return t * t;',
  '}',
  '// (1 - x*x)^3: `hazBump` sharpened by one more factor, so the crest peaks',
  '// on a line instead of over a broad top. Still polynomial, still C2.',
  'float hazCrest(float x) {',
  '  float t = max(1.0 - x * x, 0.0);',
  '  return t * t * t;',
  '}',
  // The crest's profile ALONG its own length, and it is `hazBump` again with
  // x*x handed to it -- (1 - x^4)^2 -- rather than the third shape this file
  // used to carry.
  //
  // That third shape was `1 - smoothstep(0.4, 1, |x|)`, and it held FULL
  // height across the inner 40% before it began to fall at all: eight flat
  // units of the twenty, ending at a shoulder where the profile's curvature
  // stepped from nothing to 16.7 in the space of one vertex. That is a mesa,
  // and it photographed as one. It was tolerable while a great wave's face was
  // a dark slab; once the face was lit as water and came out LIGHTER than the
  // sea behind it, the tabletop and its two corners became the most
  // conspicuous thing about the whole hazard.
  //
  // Reusing the bump fixes both faults at once and introduces no arithmetic
  // the two ports have to be kept in step over. There is no interior
  // curvature step anywhere, because the whole thing is one polynomial, so
  // nothing along the ridge catches the light as an edge; and the maximum is
  // reached once, at x = 0, so the wave peaks on a line rather than over a
  // top. It is not a narrower wave -- it still reaches exactly zero at
  // x = 1, so the footprint `hazards.ts` runs its contact test against has
  // not moved -- and it is not a steeper one: its steepest shoulder is 2.42
  // of profile per half-length against the plateau's 2.50, which on a great
  // wave is 30 degrees where the plateau was 31. What moved is where the
  // height sits BETWEEN those two ends, and at the ends it moved in the
  // wave's favour: three quarters of the way out this still carries 0.47 of
  // full height where the plateau had fallen to 0.38.
  'float hazRidge(float x) {',
  '  return hazBump(x * x);',
  '}',
  // The bow: the along-travel coordinate a curved crest is actually measured
  // in. `bow` is a fraction of the half-length `a` (CREST_BOW_MAX above), so
  // the crest line -- the locus where this returns zero -- runs
  // `v = -bow * a * (u/a)^2`: through the centre at u = 0 and `bow * a`
  // BEHIND it at each end, which is a front whose middle arrives first.
  //
  // Everything downstream reads this one value and nothing else changes:
  // `hazCrest`'s asymmetric front/back branch keys off it, so the steep face
  // stays on the forward side all the way along the arc, and the finite
  // difference that builds the normal picks the curvature up for free.
  //
  // `bow = 0` returns `v` exactly -- `0.0 * a * anything` is exactly zero in
  // both ports -- so a straight wave is bit-for-bit the wave this file drew
  // before the bow existed.
  'float hazBowV(float u, float v, float a, float bow) {',
  '  float xr = u / a;',
  '  return v + bow * a * (xr * xr);',
  '}',
].join('\n');

export const HAZARD_GLSL: string = [
  `const int MAX_HAZARDS = ${MAX_HAZARDS};`,
  'uniform int uHazCount;',
  'uniform vec3 uHazCentre[MAX_HAZARDS];',
  'uniform vec3 uHazEast[MAX_HAZARDS];',
  'uniform vec3 uHazNorth[MAX_HAZARDS];',
  '// x: kind (0 crest, 1 maelstrom). y: half-length or radius, direction units.',
  '// z: half-width, direction units (0 for a maelstrom).',
  '// w: amplitude * envelope * distance fade, WORLD units.',
  'uniform vec4 uHazShape[MAX_HAZARDS];',
  '// How far this crest\'s ends trail behind its centre, as a fraction of its',
  '// half-length. 0 for a straight crest and for every maelstrom.',
  'uniform float uHazBow[MAX_HAZARDS];',
  '// How far each end has been broken by the coast, 0..1: x is the -east end',
  '// and y the +east end. 0 on open water and for every maelstrom.',
  'uniform vec2 uHazBreak[MAX_HAZARDS];',
  HAZ_CREST_RATIO_GLSL,
  `const float HAZ_RIM_C = ${RIM_CENTRE.glsl};`,
  `const float HAZ_RIM_INV = ${RIM_INV.glsl};`,
  `const float HAZ_RIM_RATIO = ${RIM_RATIO.glsl};`,
  `const float HAZ_MIN_SIZE = ${MIN_SIZE.glsl};`,
  HAZARD_PROFILE_GLSL,
  // The broken end's sag, as a multiplier on the ridge.
  //
  // `1 - t * x * x` is exactly 1 at the crest's centre whatever `t` is, and
  // `1 - t` at the very end, so a fully broken end comes down to nothing
  // while the middle of the front is untouched. Quadratic rather than
  // anything sharper because what is being drawn is a front losing its
  // footing over a stretch of itself, not a cut.
  //
  // Declared HERE rather than in HAZARD_PROFILE_GLSL, which the arena splices
  // into its own wall of water: the arena has no coast to break on, and a
  // shared chunk that grows a function only one side can use is a shared
  // chunk that has stopped being shared.
  //
  // The branch on `x < 0.0` is safe for parity on exactly the argument
  // `hazCrest`'s front/back branch is: at x = 0 the term `t * x * x` is
  // exactly zero on both sides whichever `t` was chosen, so the two branches
  // return bit-identical values there and a GPU and a CPU that round `x` to
  // opposite sides of zero cannot disagree.
  'float hazBreakFade(float x, vec2 brk) {',
  '  float t = x < 0.0 ? brk.x : brk.y;',
  '  return 1.0 - t * x * x;',
  '}',
  'float hazardHeight(vec3 p) {',
  '  float h = 0.0;',
  '  for (int i = 0; i < MAX_HAZARDS; i++) {',
  '    if (i >= uHazCount) break;',
  '    vec4 sh = uHazShape[i];',
  '    float u = dot(p, uHazEast[i]);',
  '    float v = dot(p, uHazNorth[i]);',
  '    float a = max(sh.y, HAZ_MIN_SIZE);',
  '    if (sh.x < 0.5) {',
  '      float b = max(sh.z, HAZ_MIN_SIZE);',
  '      float vq = hazBowV(u, v, a, uHazBow[i]);',
  '      float bw = b * (vq > 0.0 ? HAZ_CREST_FRONT : HAZ_CREST_BACK);',
  '      float xr = u / a;',
  '      h += sh.w * (hazRidge(xr) * hazCrest(vq / bw) * hazBreakFade(xr, uHazBreak[i]));',
  '    } else {',
  // The bowl is `hazBump(r)` -- (1 - r*r)^2 -- and not the (1 - r)^3 this
  // shipped with. A cube of (1 - r) has a CONE APEX at the centre: it is not
  // differentiable there, it falls at about 0.9 units of height per unit of
  // radius at exactly the point one patch vertex lands on, and a point with
  // no normal is a shading singularity that no art in `hazardfunnel.ts` can
  // cover. `hazBump` depends on r only through r*r, so it is smooth through
  // the origin in u and v both, its slope at the centre is exactly zero, and
  // its steepest wall moves out to r = 0.58 where there are a dozen vertices
  // to draw it with instead of one. The hull still falls as far as it did:
  // hazBump(0) is 1, so the centre is FUNNEL_DEPTH * envelope down as before
  // and only the shape of the descent has moved.
  //
  // Still polynomial, and still on the one sqrt the radius already needed --
  // see this file's module comment for why that is not a stylistic point.
  '      float r = sqrt(u * u + v * v) / a;',
  '      float bowl = hazBump(r);',
  '      float lip = hazBump((r - HAZ_RIM_C) * HAZ_RIM_INV);',
  // The lip REPLACES the bowl beneath itself rather than standing on top of
  // it. On the old cone the funnel was down to three thousandths of its depth
  // by the rim, so a lip added there stood at RIM_HEIGHT all by itself; a
  // bowl is still a third of a unit deep under the crown, so adding would
  // leave the crown short and put the profile's true peak off to one side of
  // it. Written this way `lip` is at most 1 and the term it scales is never
  // negative, so the maximum of the whole profile is exactly HAZ_RIM_RATIO,
  // and it is reached exactly at HAZ_RIM_C.
  '      h += sh.w * (HAZ_RIM_RATIO * lip - bowl * (1.0 - lip));',
  '    }',
  '  }',
  '  return h;',
  '}',
].join('\n');

/* ------------------------------------------------------------------ */
/* CPU port                                                             */
/* ------------------------------------------------------------------ */

/*
 * Every arithmetic result below is rounded through `F` (`Math.fround`) to
 * float32, step for step with the GLSL above, matching the shader's own
 * `highp float` rather than the smoother float64 arithmetic JS would
 * otherwise use — see `wavefield.ts`'s module comment for why that is not
 * paranoia. It matters less here than it does there, because this field has
 * no near-cancelling tie in it to round the wrong way, but it costs nothing
 * and it means the parity margin is set by the GPU's own permitted slop
 * rather than by a difference this file chose to introduce.
 */
const F = Math.fround;

function bumpCPU(x: number): number {
  const t = Math.max(F(1 - F(x * x)), 0);
  return F(t * t);
}

function crestCPU(x: number): number {
  const t = Math.max(F(1 - F(x * x)), 0);
  return F(F(t * t) * t);
}

/**
 * The GLSL's `hazRidge`, and deliberately written the same way it is: the
 * square is taken once, into its own float32, and handed to the bump. Inlining
 * the fourth power here instead would be the same value in exact arithmetic
 * and a different one in float32 the moment the rounding order differed, which
 * is the class of desync this whole file is built to make impossible.
 */
function ridgeCPU(x: number): number {
  return bumpCPU(F(x * x));
}

/**
 * The GLSL's `hazBreakFade`, operation for operation: the two multiplications
 * are `(t * x)` and that product times `x`, because `t * x * x` parses left
 * to right in GLSL and a float32 product is not associative.
 */
function breakFadeCPU(x: number, brkNeg: number, brkPos: number): number {
  const t = x < 0 ? brkNeg : brkPos;
  return F(1 - F(F(t * x) * x));
}

/**
 * The GLSL's `hazBowV`, operation for operation. `v + bow * a * (xr * xr)`
 * parses left to right in GLSL, so the two multiplications are `(bow * a)`
 * and `(xr * xr)` and the product of those -- written here the same way,
 * because a float32 sum is not associative and reordering it is exactly the
 * class of desync `tests/smoke/wave-parity.spec.ts` exists to catch.
 */
function bowVCPU(u: number, v: number, a: number, bow: number): number {
  const xr = F(u / a);
  return F(v + F(F(bow * a) * F(xr * xr)));
}

/** GLSL `dot(p, q)`, left to right, float32 at every step. */
function dotCPU(px: number, py: number, pz: number, q: { x: number; y: number; z: number }): number {
  return F(F(F(px * F(q.x)) + F(py * F(q.y))) + F(pz * F(q.z)));
}

/**
 * The same arithmetic as `hazardHeight` in the GLSL above, float32 at every
 * step, over the `Hazard` objects `hazards.ts` owns rather than over the
 * uniform slots `waterhazard.ts` packs them into — the packing functions
 * above are what keep those two views of one hazard identical.
 *
 * Returns WORLD units of height, unlike `wavefield.ts`'s `waveHeight` which
 * returns a raw field value the caller scales. A hazard's amplitude is
 * already absolute, so `ship.ts` adds this on AFTER its
 * `DISPLACE_AMPLITUDE * waveGain` scaling and never through it.
 *
 * The tangent vectors are read through `F` because that is what the shader
 * sees: Three uploads a `Vector3`'s float64 components into a float32
 * uniform, so the GPU's `uHazEast[i]` is a rounded copy of the `east` the sim
 * is steering with, not that double itself.
 *
 * `tests/smoke/wave-parity.spec.ts` proves this agrees with the GLSL;
 * `tests/unit/hazardfield.test.ts` proves the shape itself is right.
 */
export function hazardHeight(dir: { x: number; y: number; z: number }, hazards: readonly Hazard[]): number {
  const px = F(dir.x);
  const py = F(dir.y);
  const pz = F(dir.z);
  let h = 0;
  // Slots past MAX_HAZARDS have no uniform to live in, so the shader cannot
  // see them; ignoring them here too keeps both sides summing the same list
  // even if `hazards.ts` ever hands over a longer one.
  const count = Math.min(hazards.length, MAX_HAZARDS);
  for (let i = 0; i < count; i++) {
    const hz = hazards[i];
    const u = dotCPU(px, py, pz, hz.east);
    const v = dotCPU(px, py, pz, hz.north);
    const a = Math.max(hazardExtentDir(hz), MIN_SIZE.value);
    const w = hazardStrength(hz);
    if (hazardShapeKind(hz) === SHAPE_CREST) {
      const b = Math.max(hazardHalfWidthDir(hz), MIN_SIZE.value);
      // Multiply first, then divide -- the same two operations in the same
      // order the GLSL does them, which is what keeps the two bit-identical.
      const vq = bowVCPU(u, v, a, F(hazardBow(hz)));
      const bw = F(b * (vq > 0 ? CREST_FRONT.value : CREST_BACK.value));
      const xr = F(u / a);
      const ridge = F(ridgeCPU(xr) * crestCPU(F(vq / bw)));
      const faded = F(ridge * breakFadeCPU(xr, hazardBreakNeg(hz), hazardBreakPos(hz)));
      h = F(h + F(w * faded));
    } else {
      // Same three terms in the same order as the GLSL: the radius, the bowl
      // that radius sits in, the lip that replaces the bowl near the rim.
      const r = F(F(Math.sqrt(F(F(u * u) + F(v * v)))) / a);
      const bowl = bumpCPU(r);
      const lip = bumpCPU(F(F(r - RIM_CENTRE.value) * RIM_INV.value));
      h = F(h + F(w * F(F(RIM_RATIO.value * lip) - F(bowl * F(1 - lip)))));
    }
  }
  return h;
}
