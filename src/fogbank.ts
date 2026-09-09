/**
 * fogbank.ts — the fog you sail INTO, as something in the air rather than a
 * tint on the water.
 *
 * ## Why this module exists
 *
 * `fogglsl.ts` shades fog the only way a surface shader can: it blends the
 * colour of the point being shaded toward a flat grey. That is exactly right
 * for aerial perspective, where the haze is genuinely a property of the miles
 * of air between here and there, and it is exactly wrong for a bank sitting on
 * the water. A surface tint cannot pass in front of the hull, cannot be denser
 * in one place than the next at the same distance, and cannot part as you sail
 * through it -- so a bank built out of it reads as somebody having laid a grey
 * sheet over the sea, which is the note this module was written to answer.
 *
 * So the near field gets geometry. The aerial term keeps the far field, which
 * is what it is good at, and `fogglsl.ts`'s `FOG_BANK_ONSET` is the seam
 * between the two: the flat tint ramps in over the same distance this layer
 * ramps out, so exactly one of them is ever the dominant effect at a given
 * range and neither has to be told about the other.
 *
 * ## What the geometry is
 *
 * A stack of concentric spherical CAPS -- not full spheres, the way
 * `clouds.ts` does it -- centred on the ship's own local up and following it
 * around the globe. A cap rather than a sphere because fog is a near-field
 * effect: the whole visible bank at chase framing is inside 90 world units
 * (see `FOG_CAP_ARC`), and a full sphere would pay for the far hemisphere on
 * every one of a dozen slices to shade nothing.
 *
 * The caps are concentric with the water sphere, so every slice is parallel to
 * the sea beneath it at every point of the cap. That is the property that
 * makes a curved world cost nothing here: no per-frame re-tessellation, no
 * flat slab poking through the horizon, and the layer's thickness is the same
 * eleven units under the bow as it is at the rim.
 *
 * ## What is anchored to what
 *
 * The GROUP follows the ship. The FIELD does not. Noise is sampled from
 * `normalize(vWorldPos)` -- a direction on the globe, not a position in the
 * cap -- so the density is painted on the world and the ship sails through it.
 * Get this backwards and the bank follows the boat, which looks like a bug in
 * the camera rather than like weather. The only thing `uTime` moves is a slow
 * drift of the noise domain, so a bank still evolves while you sit still.
 *
 * ## Cost, and the two early-outs that pay for it
 *
 * A dozen slices of a cap that covers most of the frame is real fill rate, and
 * fog is the one weather where the player is INSIDE the effect, so none of it
 * can be faded off near the camera the way `clouds.ts` fades its deck. Two
 * things keep it affordable:
 *
 *  - The CPU turns the whole group off when no fog cell is within reach of the
 *    ship and there is no squall (`fogInRange`). Clear weather is zero draw
 *    calls, not a dozen cheap ones.
 *  - The fragment shader samples the weather map FIRST and discards where
 *    there is no bank, before it touches a single octave of noise. A bank a
 *    hundred units off the bow therefore costs one texture fetch per pixel of
 *    open sea, not four noise samples.
 *
 * `quality.fogSlices` is 0 on the low tier, where -- exactly as with
 * `rain.ts`'s drops -- the module is ABSENT rather than idle, and fog is the
 * aerial haze alone, which is what it was everywhere before this file.
 */
import * as THREE from 'three';
import type { WorldEnv } from './env';
import type { CellsState, ShipState, WeatherState } from './types';
import { GLOBE_RADIUS } from './geo';
import { NEAR_DISTANCE, NEAR_HEIGHT } from './camera';
import { HEIGHTMAP_GLSL } from './heightmap';
import { WEATHERMAP_GLSL, weatherMapUniforms } from './weathermap';
import { SIMPLEX_GLSL } from './simplexglsl';

export interface FogBank {
  object: THREE.Object3D;
  /**
   * `weather` and `cells` are both optional and absent means clear, the same
   * convention `clouds.ts` uses: a caller that knows nothing about weather
   * gets an invisible layer and pays nothing for it.
   */
  update(dt: number, env: WorldEnv, ship: ShipState, weather?: WeatherState, cells?: CellsState): void;
}

/* ------------------------------------------------------------------ */
/* Tuning — world-scale unless a comment says otherwise                */
/* ------------------------------------------------------------------ */

/**
 * How high the bank stands above the water, in world units.
 *
 * Ship-scale, deliberately, and it is the number that decides what fog DOES
 * to the ship rather than merely to the view. The hull is 3.1 units long and
 * its masthead sits 4.15 up (`rain.ts` quotes both), so at 11 the deck, the
 * rigging and the mast truck are all inside the layer and a thick bank swallows
 * the boat whole -- which is the effect -- while the chase camera at about 21
 * units up is above the top of it looking down into a hole in the fog with a
 * ship in it. That last part is the whole reason the number is not larger: at
 * 25 the chase camera is inside the bank, every frame is a grey wall, and
 * there is no game left to play.
 *
 * It does put the top of a strong bank ABOVE `clouds.ts`'s `SHELL_BASE`, which
 * sits 4.8 units up, and that is a known and accepted overlap rather than an
 * oversight: this game's cloud base is already low against a 4.15-unit
 * masthead, and the deck fades out inside 30 units of the camera anyway, so
 * the two are only ever both drawn far enough away that the fog is fading on
 * altitude. Lowering this under 4.8 to avoid it would buy a carpet the hull
 * stands clear of, which is not fog.
 */
const FOG_LAYER_DEPTH = 11;

/**
 * Radial gap between slices, world units.
 *
 * The real constant, exactly as in `clouds.ts`: it is what decides whether the
 * stack reads as a volume or as a stack of plates seen edge on, and the slice
 * count is derived from it rather than typed. At 0.8 a bank is 14 slices, and
 * the eye can no longer pick an individual one out of the gradient at the top
 * of the layer where they are furthest apart in screen space.
 *
 * It is also this file's cost knob. Halving it doubles what fog costs.
 */
const FOG_SLICE_SPACING = 0.8;

/** Slices at the top tier, and the number `quality.fogSlices` is capped by. */
const FOG_SLICE_MAX = Math.max(2, Math.round(FOG_LAYER_DEPTH / FOG_SLICE_SPACING));

/**
 * How far the cap reaches from the ship, measured along the sea in world units.
 *
 * The horizon from the chase camera's ~21 units of altitude is 94 units away
 * (`sqrt((R + h)^2 - R^2)` at GLOBE_RADIUS = 200), or 88 units of arc, so 150
 * covers the whole chase frame with room to spare and still covers most of
 * what the mid framing can see. Past the rim the aerial term has long since
 * taken over -- `FOG_BANK_ONSET` in `fogglsl.ts` has the tint at full weight
 * by 70 units -- so the rim fade below hands off to something already there
 * rather than ending at an edge.
 *
 * Cheaper than it looks: the cap is 43 degrees of a sphere, about a twentieth
 * of its area, and the far half of a full sphere would have shaded nothing.
 */
const FOG_CAP_ARC = 150;

/** The cap's half-angle, radians. Derived, so the arc above stays the number. */
const FOG_CAP_ANGLE = FOG_CAP_ARC / GLOBE_RADIUS;

/**
 * Where the base slice sits above the water sphere, world units.
 *
 * Small and non-zero. Zero would put the base slice exactly on the water and
 * let the two z-fight along the whole cap; a fifth of a unit is under the
 * wave amplitude, so the base still reads as sitting ON the sea, and the
 * waves push through it in a way that looks like fog lying in the troughs.
 */
const FOG_BASE_LIFT = 0.2;

/**
 * The hull, in world units, and the unit the clearing below is quoted in.
 *
 * 3.12 long and 1.5 across, which is `ship.ts`'s `MODEL_SCALE` measured
 * against `wake.ts`'s bow and stern offsets -- `islets.ts` sizes the smallest
 * surviving island off the same two numbers, and takes them from the same
 * place, so a retuned model moves both together.
 */
const HULL_LENGTH = 3.12;
const HULL_WIDTH = 1.5;

/**
 * The eye of clear air the ship keeps around itself, in world units: fully
 * clear inside `FOG_CLEAR_CORE`, full bank again beyond `FOG_CLEAR_EDGE`.
 *
 * A thick bank is meant to swallow the boat, and it still does at any range
 * past the edge -- but a boat that is only a smudge is a boat you cannot
 * steer, and the whole point of `STACK_OPACITY` stopping short of opaque was
 * to leave a silhouette to read.
 *
 * ## Why the edge is the CHASE CAMERA'S setback and not a hull measurement
 *
 * The first cut of this was a hull's half-length plus one beam, feathered to
 * about 6.8 units: a clearing sized against the BOAT, which is the obvious way
 * to size a clearing around a boat. It looked almost the same as no clearing
 * at all, and the reason is worth writing down, because the obvious way is
 * wrong here for a structural reason that will not change.
 *
 * The chase camera sits `NEAR_HEIGHT` (9.5) up and `NEAR_DISTANCE` (21) BACK,
 * which puts it inside the layer -- the layer is 11 units deep -- so its line
 * of sight to the hull is 23 units travelled almost horizontally through fog.
 * Walk that line and the fog on it is shaped by two fades: `FOG_NEAR_FULL`
 * lets it up to full strength 16 units out from the camera, and this clearing
 * takes it away again near the ship. A clearing of radius r only ever touches
 * the last r units of a 21-unit horizontal run, so at 6.8 the whole middle of
 * the line -- the part at FULL density -- was untouched. Integrated along the
 * ray, the boat-sized clearing removed 39% of the fog in front of the hull and
 * still left a stretch at 100%. That is what "still greatly obscured" was.
 *
 * So the edge has to reach the camera, and `NEAR_DISTANCE` is what "reach the
 * camera" means. At that value the same integral falls to 1.4 units of
 * full-strength-equivalent fog out of 23, peaking at 20% density, and the hull
 * reads as a hull. `tests/unit/fogbank.test.ts` walks the ray and pins both
 * numbers, so a future edit that shrinks this back toward the boat fails
 * rather than merely looking worse.
 *
 * The core stays a boat measurement, because that is the part the eye reads as
 * "clear water around the ship": two hull lengths of it, then the fog comes
 * back over the remaining fourteen units. That long feather is the whole
 * difference between a bank the ship sits in a bowl of and a circle stamped
 * out of the fog.
 *
 * ## What this costs
 *
 * Fog no longer rolls across the hull at chase framing, which was a deliberate
 * choice earlier and is being reversed on purpose: a bank that passes over the
 * boat and a boat you can see are not both available from a camera that sits
 * inside the fog 21 units away. Wisps still cross the hull at the near framing
 * whenever the bank is thin, and the horizon is still gone -- what the bowl
 * removes is the near field, not the effect.
 */
const FOG_CLEAR_CORE = HULL_LENGTH * 2;
const FOG_CLEAR_EDGE = NEAR_DISTANCE;

/**
 * How far out from the ship the displaced fog banks up, world units.
 *
 * The clearing on its own SUBTRACTS: fog inside the bowl simply stops being
 * drawn, which is cheap and correct and reads, if you look for it, as fog that
 * was deleted rather than fog that was moved. Real air does not work that way.
 * A hull pushing through a bank shoves the fog aside and it piles against the
 * outside of the hole, which is the difference between a bubble that the boat
 * is making and a bubble the boat merely happens to be inside.
 *
 * So a bow wave: a band of raised density from `FOG_CLEAR_CORE` out to here,
 * peaking near the clearing's own edge, where the alpha ramp has already let
 * the fog most of the way back up. Half again the clearing's reach, so the
 * wall it makes is well outside the bowl and never closes over the boat.
 *
 * It is not a conservation law and does not pretend to be -- the field is
 * procedural, there is no quantity of fog to conserve -- it is the visual
 * consequence of one, at the cost of one clamp and a multiply.
 */
const FOG_PILE_REACH = FOG_CLEAR_EDGE * 1.5;

/** The band the bow wave is spread over. Derived, so only the reach is tuned. */
const FOG_PILE_SPAN = FOG_PILE_REACH - FOG_CLEAR_CORE;

/**
 * The chase camera's own line of sight to the hull, world units, and the
 * geometry the two constants above are justified against. Exported for the
 * test that walks it; nothing in the shader reads it.
 */
export const CHASE_SIGHT_LENGTH = Math.hypot(NEAR_HEIGHT, NEAR_DISTANCE);

/**
 * Total opacity the whole stack composites to in the core of a full bank, and
 * the per-slice value that gets there.
 *
 * Alpha compounds: n slices at `a` leave `(1 - a)^n` of the background, so
 * the per-slice number has to be solved from the stack's rather than typed,
 * or the layer's density would change every time the slice count moved --
 * including between quality tiers, where a medium machine would get visibly
 * thinner fog than a high one for no reason anybody could name.
 *
 * 0.97 rather than 1.0 because a bank has to BLOCK the ship, not delete it:
 * the note this module answers asks for something "partially blocking
 * objects", and three per cent of the hull surviving the thickest core of the
 * thickest bank is what keeps a silhouette there to steer by.
 */
const STACK_OPACITY = 0.97;

/**
 * How close to the camera fog stops contributing, and where it is back to
 * full, in world units.
 *
 * `clouds.ts` fades its deck out over 30 to 85 units for the opposite reason
 * this exists: a cloud must never fog the chase view, and fog must. These two
 * only stop the slice that happens to intersect the near plane from painting
 * the entire frame a flat grey with no shape in it -- which is not fog, it is
 * a failed render. Two and a half units is inside the hull's own length, so
 * the bank still closes over the deck.
 */
const FOG_NEAR_MIN = 2.5;
const FOG_NEAR_FULL = 16;

/**
 * Camera altitudes, world units, over which the layer fades out.
 *
 * The same argument `fogglsl.ts` makes for its `FOG_ALTITUDE_FALLOFF`, and
 * for the same reason: a bank is a thing that sits on water, and from orbit
 * you should see the sea through it and the cell in the CLOUD deck above it.
 *
 * The first cut was 100 and 260, on the theory that -- unlike a flat tint --
 * this layer looks RIGHT from above, a white patch lying on the ocean being
 * what a fog bank seen from height is. It does, and the numbers were still
 * wrong: `?weather=fog` pins the bank everywhere at once, and at 70% weight
 * from 160 units up a `far.png` was a planet with a salmon carpet pulled over
 * it, limb to terminator. 40 and 120 keep the chase framing (~21 up) at full,
 * leave the mid one (~70) at a bit over half -- a bank you look down INTO,
 * which is the shot worth having -- and have the layer gone before far (~160),
 * where `fogglsl.ts`'s own altitude term has taken the haze away too.
 */
const FOG_ALT_FULL = 40;
const FOG_ALT_GONE = 120;

/**
 * How far a fog cell has to be from the ship before the layer can be switched
 * off entirely, in world units.
 *
 * `FOG_CAP_ARC` plus the largest radius a cell is built with, so a cell whose
 * skirt reaches the rim of the cap still turns the layer on. Generous on
 * purpose: the cost of being wrong the safe way is a dozen slices that discard
 * on their first texture fetch, and the cost of being wrong the other way is a
 * bank that pops into existence at the edge of the frame.
 */
const FOG_WAKE_RANGE = FOG_CAP_ARC + 140;

/** Below this the bank is not worth a draw call. Matches `weather.ts`'s own floor. */
const FOG_EPSILON = 0.004;

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

const VERTEX_SHADER = [
  'varying vec3 vWorldPos;',
  '// The cap is built around +Y and then turned to the ship, so object-space',
  '// height above the cap centre is what says how far out toward the rim this',
  '// vertex is. Passing it as a varying keeps an `acos` out of the fragment.',
  'varying float vRim;',
  '// How far this vertex is from the SHIP\'s own local vertical axis, in world',
  '// units. Free to compute here and needs no uniform: the cap is built around',
  '// +Y and then turned so that +Y is the ship\'s up, so in object space that',
  '// axis IS +Y, and `dir.xz` is the radial part of a unit direction. The',
  '// ship\'s axis passes through the globe centre (its position and its up are',
  '// the same unit vector), and the cap is concentric with the globe, so the',
  '// world radius of this vertex times that radial part is the distance from',
  '// the axis exactly, on every slice, with no per-slice uniform for the scale.',
  'varying float vAxisDist;',
  'uniform float uCapCos;',
  'void main() {',
  '  vec3 dir = normalize(position);',
  '  vRim = clamp((1.0 - dir.y) / max(1.0 - uCapCos, 1e-4), 0.0, 1.0);',
  '  vec4 wp = modelMatrix * vec4(position, 1.0);',
  '  vAxisDist = length(wp.xyz) * length(dir.xz);',
  '  vWorldPos = wp.xyz;',
  '  gl_Position = projectionMatrix * viewMatrix * wp;',
  '}',
].join('\n');

const FRAGMENT_SHADER = [
  'uniform float uTime;',
  'uniform vec3 uSunDirection;',
  'uniform vec3 uSunColor;',
  'uniform vec3 uLitColor;',
  'uniform vec3 uShadowColor;',
  'uniform vec3 uNightColor;',
  'uniform float uScale;',
  'uniform float uWarp;',
  'uniform float uThreshold;',
  'uniform float uSoft;',
  'uniform float uWisp;',
  'uniform float uAltitude;',
  'uniform float uTopTaper;',
  'uniform float uShear;',
  'uniform float uOpacity;',
  'uniform float uGraze;',
  'uniform float uRelief;',
  'uniform float uSilver;',
  'uniform float uPile;',
  'uniform float uSeaRadius;',
  '// The bank AT THE SHIP, for the half of the weather that has no place --',
  '// the same scalar `fogglsl.ts` reads as `uFogHere`, and combined with the',
  '// map by `max` for the same reason: two banks in one place are one bank.',
  'uniform float uFogHere;',
  '// `uWeatherMap` is declared by WEATHERMAP_GLSL below, exactly as in',
  '// `clouds.ts`: declaring it here as well fails to compile.',
  'varying vec3 vWorldPos;',
  'varying float vRim;',
  'varying float vAxisDist;',
  SIMPLEX_GLSL,
  HEIGHTMAP_GLSL,
  WEATHERMAP_GLSL,
  '// Each octave slides through the field along its own direction, so a bank',
  '// grows and dissolves instead of sliding past as one rigid painted shape.',
  '// An order of magnitude slower than `clouds.ts`\'s equivalents: a cloud is',
  '// seen from four kilometres and fog from forty metres, and the same domain',
  '// speed that reads as weather up there boils like a lava lamp down here.',
  'const vec3 DRIFT0 = vec3( 0.0021,  0.0016, -0.0019);',
  'const vec3 DRIFT1 = vec3(-0.0038,  0.0029,  0.0024);',
  'const vec3 DRIFT2 = vec3( 0.0058, -0.0050,  0.0043);',
  'const vec3 DRIFT3 = vec3(-0.0084,  0.0067, -0.0074);',
  'const vec3 WARP_DRIFT = vec3(0.0013, -0.0018, 0.0011);',
  '// Fixed direction the layer leans as it rises. Pure vertical extrusion of',
  '// one field stacks every slice squarely on the one below and reads as a',
  '// layer cake; the lean is what gives the top of a bank its overhang.',
  'const vec3 ALT_SHEAR = vec3(0.58, -0.51, 0.63);',
  '// How much of the bank strength is needed before a pixel is worth any',
  '// noise at all. The early-out that makes open water cost one fetch.',
  'const float PRESENCE_FLOOR = 0.02;',
  'void main() {',
  '  vec3 nWorld = normalize(vWorldPos);',
  '  // The bank here. One texture fetch, whatever the cell population is, and',
  '  // it comes FIRST: everything below this line is noise, and there is no',
  '  // point sampling a fractal to shade air that has no fog in it.',
  '  float bank = max(uFogHere, weatherAt(uWeatherMap, nWorld).g);',
  '  if (bank < PRESENCE_FLOOR) discard;',
  '  vec3 toCam = cameraPosition - vWorldPos;',
  '  float camDist = length(toCam);',
  '  vec3 viewDir = -toCam / max(camDist, 1e-4);',
  '  float facing = abs(dot(nWorld, viewDir));',
  '  // How square on this slice is to the view. Near 0 it is edge on, one',
  '  // pixel spans many wavelengths of the field, and a thin translucent',
  '  // shell breaks into a dotted mesh following its own tessellation. Same',
  '  // cure as `clouds.ts` and `water.ts`: fade whatever could alias out on',
  '  // this number.',
  '  float lod = smoothstep(0.03, 0.40, facing);',
  '  // Every fade that can reject this pixel outright, before the noise.',
  '  float camAlt = length(cameraPosition) - uSeaRadius;',
  '  // Written as `1 - smoothstep(full, gone, x)` rather than the reversed-edge',
  '  // form it reads as: GLSL leaves smoothstep undefined when edge0 >= edge1,',
  '  // and a driver that happens to do the intuitive thing is not a contract.',
  '  float fade = 1.0 - smoothstep(FOG_ALT_FULL_C, FOG_ALT_GONE_C, camAlt);',
  '  fade *= smoothstep(FOG_NEAR_MIN_C, FOG_NEAR_FULL_C, camDist);',
  '  // Rim: hand off to the aerial tint over the outer fifth of the cap',
  '  // rather than ending the layer at a visible circular edge.',
  '  fade *= 1.0 - smoothstep(0.8, 1.0, vRim);',
  '  // And the eye of clear air the ship keeps around itself, so the hull',
  '  // stays a boat inside a bank rather than a smudge. See FOG_CLEAR_CORE:',
  '  // it is a column about the ship\'s vertical axis, not a bubble, and it is',
  '  // applied here with the other fades so a pixel near the hull discards',
  '  // before it costs a single octave.',
  '  fade *= smoothstep(FOG_CLEAR_CORE_C, FOG_CLEAR_EDGE_C, vAxisDist);',
  '  if (fade < 0.004) discard;',
  '  float t = uTime;',
  '  vec3 p = nWorld * uScale;',
  '  // Domain warp, which is most of what turns a fractal into something with',
  '  // billows and hooks in it rather than lumps.',
  '  float w1 = snoise(p * 1.57 + vec3( 2.9, 7.1, 4.3) + WARP_DRIFT * t);',
  '  float w2 = snoise(p * 1.57 + vec3(-5.8, 1.7, 9.2) - WARP_DRIFT * t);',
  '  vec3 q = p + uWarp * vec3(w1, w2, 0.5 * (w1 - w2)) + ALT_SHEAR * (uShear * uAltitude);',
  '  // The coverage threshold, and the whole shape of the layer is in it.',
  '  //',
  '  // Fog is BOTTOM heavy -- that is the one thing that separates it from a',
  '  // cloud, which is why `clouds.ts` has the same term with the opposite',
  '  // sense. The threshold climbs steeply with altitude, so the base slice is',
  '  // near solid wherever the bank is at all and only the densest cores reach',
  '  // the top of the layer as ragged tongues. Raised to a power so the lower',
  '  // half of the stack stays thick and the taper is spent in the upper half,',
  '  // where the top of a real bank frays.',
  '  float alt = pow(uAltitude, 1.35);',
  '  // The bow wave: the fog the bowl takes out of the middle banks up against',
  '  // the outside of it, so the clearing reads as the hull shouldering the',
  '  // bank aside rather than as fog quietly deleted. See FOG_PILE_REACH.',
  '  //',
  '  // Applied to the THRESHOLD rather than added to `density` further down,',
  '  // and that is not a style choice: `best` below is an upper bound on the',
  '  // density used for the two-octave early-out, so a term added after it',
  '  // would discard pixels that should have become fog and punch holes in the',
  '  // wall. Lowering the threshold before the bound is computed is the same',
  '  // effect with the bound still sound -- the trick `bank * 0.42` above',
  '  // already uses.',
  '  //',
  '  // Scaled by `bank` so a thin bank does not grow a hard ring: the wave is a',
  '  // consequence of there being fog to push, and there is none at bank 0.',
  '  float pileT = clamp((vAxisDist - FOG_CLEAR_CORE_C) / FOG_PILE_SPAN_C, 0.0, 1.0);',
  '  float pileUp = uPile * bank * (pileT * (1.0 - pileT) * 4.0);',
  '  // A strong bank does not merely go greyer, it goes DEEPER: the threshold',
  '  // drops with strength, so a bank at full does not just thicken where it',
  '  // already was, it fills in the gaps and closes over the ship. The subtract',
  '  // is what makes `?weather=fog` a whiteout instead of a thicker mist.',
  '  float thr = uThreshold + uTopTaper * alt - bank * 0.42 - pileUp;',
  '  // Two cheap octaves and an early-out on their own upper bound, exactly as',
  '  // the cloud deck does it: `uWisp` is added to `best` in full and only ever',
  '  // subtracted from below, so this stays a sound bound however far the',
  '  // erosion term is later faded.',
  '  float a0 = snoise(q * 1.00 + DRIFT0 * t);',
  '  float a1 = snoise(q * 2.07 + DRIFT1 * t);',
  '  float partial = 0.5 * a0 + 0.25 * a1;',
  '  float best = ((partial + 0.1875) / 0.9375) * 0.5 + 0.5 + uWisp;',
  '  if (best < thr) discard;',
  '  float a2 = snoise(q * 4.13 + DRIFT2 * t);',
  '  float a3 = snoise(q * 8.31 + DRIFT3 * t);',
  '  float f = (partial + 0.125 * a2 + 0.0625 * a3) / 0.9375;',
  '  float density = f * 0.5 + 0.5;',
  '  // High-frequency erosion, and it only bites near the threshold, which is',
  '  // where the ragged edges belong and where undersampling shows -- so it is',
  '  // the first thing to go at a grazing angle.',
  '  float wisp = uWisp * lod;',
  '  if (wisp > 0.002) {',
  '    density += wisp * snoise(q * 15.3 - DRIFT2 * t);',
  '  }',
  '  // Widen the coverage ramp as the slice turns edge on, so its rim resolves',
  '  // as a gradient rather than as a one-pixel in/out decision.',
  '  float cov = smoothstep(thr, thr + uSoft * mix(2.4, 1.0, lod), density);',
  '  if (cov <= 0.002) discard;',
  '  // How far INSIDE the bank this pixel sits, so a core can shade differently',
  '  // from a thin skirt.',
  '  float deep = smoothstep(thr, thr + 0.30, density);',
  '  // Fake self shadowing, the same probe `clouds.ts` uses: sample the two',
  '  // cheap octaves a short step toward the sun and compare. Denser here than',
  '  // sunward means this face is turned into the light. Fog is far more',
  '  // uniform than cloud, so the gain is a fraction of the deck\'s -- the',
  '  // point is to keep a bank from being one flat grey card, not to carve',
  '  // relief into it.',
  '  float sunDot = dot(nWorld, uSunDirection);',
  '  vec3 st = uSunDirection - nWorld * sunDot;',
  '  vec3 sunTan = st / max(length(st), 1e-4);',
  '  vec3 sq = q + sunTan * 0.16;',
  '  float here = partial / 0.75;',
  '  float sunward = (0.5 * snoise(sq + DRIFT0 * t) + 0.25 * snoise(sq * 2.07 + DRIFT1 * t)) / 0.75;',
  '  float relief = clamp((here - sunward) * uRelief, -1.0, 1.0);',
  '  float shade = clamp(-relief, 0.0, 1.0) * mix(0.5, 1.0, deep);',
  '  // Colour. Fog is LIT water in the air -- it is bright, and it takes the',
  '  // colour out of what is behind it rather than tinting it, which is the',
  '  // same argument `fog.ts` makes for `FOG_BANK_COLOR` being a near-neutral',
  '  // grey. The depth term darkens the core, because the deeper into a bank',
  '  // you look the less of the daylight above it reaches back out.',
  '  // 0.14, not the cloud deck\'s 0.42. A cloud top is SUPPOSED to take the',
  '  // sun\'s colour -- that warmth at dawn is most of what a sunrise is -- and',
  '  // a first cut here reused the deck\'s weight and produced a bank that was',
  '  // frankly pink in a `?weather=fog` shot taken at 06:00. Fog is asked to be',
  '  // GREYER than a cloud, not merely darker, and this is the term that decides',
  '  // it: the sun may warm the fog\'s edge and must not dye its body.',
  '  vec3 sunTint = mix(vec3(1.0), uSunColor, 0.14);',
  '  vec3 litCol = mix(uLitColor, uShadowColor, max(shade, deep * 0.62)) * sunTint;',
  '  float lit = smoothstep(-0.24, 0.22, sunDot);',
  '  vec3 col = mix(uNightColor, litCol, lit);',
  '  // Forward scatter: looking toward a low sun through the thin edge of a',
  '  // bank is the brightest thing fog ever does, and it is most of why a',
  '  // morning bank reads as glowing rather than as dirty.',
  '  float edge = clamp(cov * (1.0 - deep) * 1.5, 0.0, 1.0);',
  '  float forward = clamp(dot(viewDir, uSunDirection), 0.0, 1.0);',
  '  // A 7th power rather than the deck\'s 6th, and see `uSilver`: this is the',
  '  // other half of the pink, and the cure for both is to make it a glow on',
  '  // the few degrees around a low sun instead of a wash over the sea.',
  '  col += uSunColor * (pow(forward, 7.0) * edge * lit * uSilver);',
  '  // Alpha. Thicker seen edge on, because a slice is a surface standing in',
  '  // for a volume and a long slant path through fog really is denser.',
  '  float graze = 1.0 - facing;',
  '  float alpha = cov * uOpacity * mix(1.0, uGraze, graze * graze);',
  '  // The bank\'s own strength, applied to the ALPHA as well as to the',
  '  // threshold above, so a bank fades in as thin real fog rather than',
  '  // snapping on as a smaller patch of thick fog.',
  '  alpha *= smoothstep(0.0, 0.35, bank);',
  '  alpha *= fade;',
  '  // Fold the slice away at its own silhouette, where all that is left of it',
  '  // is a hairline of undersampled noise.',
  '  //',
  '  // Much wider than the deck\'s 0.07, and the reason is a stacking artefact',
  '  // this layer has and the deck does not. Fourteen concentric spheres seen',
  '  // from above go edge on at fourteen slightly different radii, so a narrow',
  '  // fold draws fourteen crisp concentric RINGS on the sea -- plainly visible',
  '  // in the first `far.png`, arcing along the limb. A fold this wide overlaps',
  '  // its neighbours and the rings blur into each other; `uShear` decorrelates',
  '  // what is left. The cost is a thinner bank at a grazing angle, which is',
  '  // paid back by `uGraze` on the same number.',
  '  alpha *= smoothstep(0.0, 0.16, facing);',
  '  if (alpha < 0.004) discard;',
  '  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));',
  '}',
]
  .join('\n')
  // The four fade distances are tuning constants of this MODULE, not of the
  // shader, so they are substituted in rather than being four more uniforms
  // nobody ever writes twice. Same reason `rain.ts` bakes its lane counts.
  .replace(/FOG_ALT_GONE_C/g, FOG_ALT_GONE.toFixed(1))
  .replace(/FOG_ALT_FULL_C/g, FOG_ALT_FULL.toFixed(1))
  .replace(/FOG_NEAR_MIN_C/g, FOG_NEAR_MIN.toFixed(1))
  .replace(/FOG_NEAR_FULL_C/g, FOG_NEAR_FULL.toFixed(1))
  .replace(/FOG_CLEAR_CORE_C/g, FOG_CLEAR_CORE.toFixed(3))
  .replace(/FOG_CLEAR_EDGE_C/g, FOG_CLEAR_EDGE.toFixed(3))
  .replace(/FOG_PILE_SPAN_C/g, FOG_PILE_SPAN.toFixed(3));

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/** Scratch, so `update` allocates nothing per frame. */
const _up = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);

/**
 * Per-slice opacity that composites to `STACK_OPACITY` through the stack.
 *
 * Exported because it is the one number in this file a test can check without
 * a GPU, and because the invariant it encodes -- that the layer's density is
 * the same on every quality tier even though the slice count is not -- is the
 * kind that fails silently.
 */
export function sliceOpacity(slices: number): number {
  if (slices <= 0) return 0;
  return 1 - Math.pow(1 - STACK_OPACITY, 1 / slices);
}

/**
 * True when a fog bank is close enough to the ship to be worth drawing.
 *
 * The CPU half of the two early-outs described at the top of this file, and
 * the more valuable of the two: it takes a clear frame from a dozen draw calls
 * that discard immediately to no draw calls at all.
 *
 * Reads `cells.live` analytically rather than `weathermap.ts`'s texture, for
 * the reason that module's own comment gives: the map is data for shading and
 * is a frame stale, and anything that decides a NUMBER reads the cells.
 */
export function fogInRange(ship: ShipState, weather?: WeatherState, cells?: CellsState): boolean {
  if (weather && weather.fog > FOG_EPSILON) return true;
  if (!cells) return false;
  for (const cell of cells.live) {
    if (cell.kind !== 'fog' || cell.strength <= FOG_EPSILON) continue;
    // Great-circle distance between two unit directions, in world units.
    const cosD = Math.max(-1, Math.min(1, cell.centre.dot(ship.position)));
    if (Math.acos(cosD) * GLOBE_RADIUS <= FOG_WAKE_RANGE + cell.radius) return true;
  }
  return false;
}

/**
 * The bank.
 *
 * `slices` is `quality.fogSlices`, and 0 means this is never called: `globe.ts`
 * builds no module at all on the low tier, exactly as `main.ts` builds no rain
 * there. Anything above `FOG_SLICE_MAX` is clamped, because past that the gaps
 * are finer than the noise and the extra slices buy overdraw and nothing else.
 */
export function createFogBank(slices: number): FogBank {
  const count = Math.max(2, Math.min(FOG_SLICE_MAX, Math.round(slices)));
  const object = new THREE.Group();
  object.name = 'fog-bank';
  object.visible = false;

  // One unit cap, scaled per slice. `phiLength` = FOG_CAP_ANGLE makes a bowl
  // around +Y; the group is turned so that +Y is the ship's local up.
  const geometry = new THREE.SphereGeometry(1, 96, 28, 0, Math.PI * 2, 0, FOG_CAP_ANGLE);

  // Shared by every slice -- the same `{ value }` objects in each material, so
  // `update` writes them once and the whole stack sees it. Only `uAltitude`
  // differs, exactly as in `clouds.ts`.
  const uniforms = {
    uTime: { value: 0 },
    uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
    uSunColor: { value: new THREE.Color('#fff2d6') },
    /**
     * The lit face of the fog, and it is nearly white on purpose. Fog is lit
     * water in the air; a bank that is grey where the sun hits it reads as
     * smoke. The GREY of a fog bank comes from `uShadowColor` below winning
     * everywhere the light does not reach, which is most of a thick one.
     */
    uLitColor: { value: new THREE.Color('#e6e9ea') },
    /** And the greyer, thicker body the note asked for. */
    uShadowColor: { value: new THREE.Color('#8d9599') },
    /** Dim but shaped: fog at night is a darker fog, never a hole in the sea. */
    uNightColor: { value: new THREE.Color('#2b323b') },
    /**
     * Base noise frequency over the unit sphere, so a feature is
     * `GLOBE_RADIUS / uScale` world units across: 5.0 puts the largest at 40
     * units, about thirteen hull lengths, with the fourth octave down at 5.
     * That range is what makes a bank read as having a near edge and a far
     * one instead of being uniform soup at every distance.
     */
    uScale: { value: 5.0 },
    uWarp: { value: 0.34 },
    /**
     * Density above this is fog. Higher = more open water.
     *
     * Well above `clouds.ts`'s 0.5127 because this threshold is DROPPED by the
     * bank strength (`bank * 0.42` in the shader) rather than being the final
     * word: at rest almost nothing passes it, and a full bank takes it to 0.24,
     * which the field clears nearly everywhere. That is the difference between
     * fog that gets patchier as it strengthens and fog that closes in.
     */
    uThreshold: { value: 0.66 },
    /** Width of the coverage ramp. Wider = softer edges; half of the fluff. */
    uSoft: { value: 0.16 },
    /** High-frequency erosion. The other half. */
    uWisp: { value: 0.075 },
    /**
     * How much higher the threshold sits at the top of the layer than at its
     * base -- the layer's profile, and the term that makes this fog rather
     * than a low cloud. Sized against `uSoft` so the top slice still exists
     * over a strong bank instead of vanishing into a hard ceiling.
     */
    uTopTaper: { value: 0.30 },
    /**
     * How far the domain leans between base and top, in noise-domain units.
     *
     * Four times the cloud deck's, and it earns it twice. A bank wants real
     * overhang -- fog rolls, it does not stack -- and, less obviously, it is
     * the term that decorrelates the slices from each other: at 0.07 all
     * fourteen sample almost the same field and their edge-on bands line up
     * into concentric rings, which is what the first `far.png` showed.
     */
    uShear: { value: 0.30 },
    uOpacity: { value: sliceOpacity(count) },
    /**
     * Extra optical depth through a slice seen edge on. Well under the cloud
     * deck's 2.5, for two reasons: the deck is eleven slices spanning 7.2
     * units and this is fourteen spanning 11, so there is more real depth here
     * to stand in for -- and a strong value brightens each slice exactly at
     * the radius where the wide silhouette fold above is taking it away, which
     * is what turns the stack's edge-on bands into visible rings rather than
     * into a gradient.
     */
    uGraze: { value: 1.25 },
    /** Gain on the sunward density difference that fakes relief. */
    uRelief: { value: 3.4 },
    /**
     * Forward scatter, and it is a quarter of the cloud deck's silver lining
     * on purpose. Fog sits at sea level, so at dawn the sun is not merely
     * behind the bank, it is behind the bank AND aligned with the view for
     * minutes at a time -- which is the geometry the deck's value never meets
     * and which turned an early shot salmon from limb to terminator.
     */
    uSilver: { value: 0.15 },
    /**
     * How far the bow wave lowers the coverage threshold at its crest.
     *
     * Sized against `uSoft` (0.16), which is the width of the coverage ramp:
     * at 0.10 the wall is most of a ramp-width thicker than the bank around
     * it, which reads as fog heaped up without becoming a second, denser
     * weather system sitting in a ring around the boat. Push it past `uSoft`
     * and the ring stops being a consequence and starts being the subject.
     */
    uPile: { value: 0.10 },
    /** The radius the camera's altitude is measured against. */
    uSeaRadius: { value: GLOBE_RADIUS },
    /** cos of the cap half-angle, for the vertex shader's rim term. */
    uCapCos: { value: Math.cos(FOG_CAP_ANGLE) },
    ...weatherMapUniforms,
    /**
     * The squall at the ship. 0 in fair weather, which -- with an empty map
     * being zero everywhere -- makes the shader discard on its first branch.
     */
    uFogHere: { value: 0 },
  };

  for (let i = 0; i < count; i++) {
    // 0 on the base slice, 1 on the top one.
    const altitude = count > 1 ? i / (count - 1) : 0;

    const material = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uAltitude: { value: altitude } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      // Both faces, unlike the cloud deck's `FrontSide`. The camera is
      // routinely INSIDE this layer, and a slice below the eye has to be seen
      // from beneath while one above it is seen from on top; culling either
      // one puts a hole in the fog exactly where the player is standing.
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });

    const slice = new THREE.Mesh(geometry, material);
    slice.name = `fog-slice-${i}`;
    slice.scale.setScalar(GLOBE_RADIUS + FOG_BASE_LIFT + FOG_LAYER_DEPTH * altitude);
    // After the opaque world and after the cloud deck, whose slices take
    // renderOrder 2..12: this layer sits at sea level, so wherever the two are
    // both in frame the fog is the nearer of them and belongs on top.
    //
    // Descending WITHIN the stack, which is the opposite of the deck's order
    // and for a concrete reason: the deck is drawn from above and its outer
    // slice is nearest, while fog is drawn from a camera that sits above the
    // top of the layer at every framing the fade above leaves it visible, so
    // here the outer slice is nearest and back-to-front runs top DOWN. The
    // slices share a colour to within the shading of one bank, so the cost of
    // being wrong on this is small -- but it is free to be right.
    slice.renderOrder = 20 + (count - 1 - i);
    // Deliberately NOT on LAYER_REFLECTED. The reflection cube gathers the
    // sky, the deck and the lights -- things far enough away to be a constant
    // over the patch of water reflecting them. A bank is at sea level and
    // metres away, so what it reflects into is different for every wave, and
    // the cube would smear one sample of it over the whole ocean.
    object.add(slice);
  }

  return {
    object,
    update(_dt: number, env: WorldEnv, ship: ShipState, weather?: WeatherState, cells?: CellsState): void {
      const live = fogInRange(ship, weather, cells);
      object.visible = live;
      if (!live) return;

      uniforms.uTime.value = env.elapsed;
      uniforms.uSunDirection.value.copy(env.sunDirection);
      uniforms.uSunColor.value.copy(env.sunColor);
      uniforms.uFogHere.value = weather ? weather.fog : 0;

      // Turn the cap so its pole is under the ship. The group is never moved:
      // the caps are concentric with the globe, so following the ship is a
      // rotation and nothing else, and the noise is sampled from a world
      // direction, so this rotation cannot drag the field along with it.
      _up.copy(ship.up);
      _quat.setFromUnitVectors(_yAxis, _up);
      object.quaternion.copy(_quat);
    },
  };
}

export {
  FOG_PILE_REACH,
  FOG_CLEAR_CORE,
  FOG_CLEAR_EDGE,
  FOG_NEAR_FULL,
  FOG_NEAR_MIN,
  FOG_LAYER_DEPTH,
  FOG_CAP_ARC,
  FOG_SLICE_MAX,
  STACK_OPACITY,
  FOG_WAKE_RANGE,
  HULL_WIDTH,
  HULL_LENGTH,
};
