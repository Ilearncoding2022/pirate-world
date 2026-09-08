import { NOISE_GLSL } from './noiseglsl';
import { FOG_GLSL } from './fogglsl';
import { GLOBE_RADIUS } from './geo';
import {
  SWELL_WAVELENGTH,
  WAVE_WAVELENGTH,
  CHOP_WAVELENGTH,
  AXIS_WAVE,
  AXIS_CHOP,
  vec3Literal,
} from './waveconstants';
import {
  CREST_HEIGHT,
  CREST_HEIGHT_MAX,
  HAZ_CREST_RATIO_GLSL,
  HAZARD_PROFILE_GLSL,
} from './hazardfield';
import {
  CREST_LIFT,
  CREST_SCOPE,
  CREST_THICK,
  FOAM_BAND,
  FOAM_BIAS,
  FOAM_TEAR,
  FOAM_TEAR_INV,
  FOAM_WANDER,
  FROTH_DRIFT,
  FROTH_WAVELENGTH,
  LIP_HI,
  LIP_LO,
  LIP_RIM,
  SHOULDER_CHOP,
  STREAK_FALL,
  STREAK_FOAM,
  STREAK_HI,
  STREAK_LENGTH,
  STREAK_LIFE,
  STREAK_LO,
  STREAK_WIDTH,
  THICK_BLUE,
  THICK_GREEN,
  THICK_SCALE,
} from './hazardcrest';

/**
 * battlewave.ts — the arena's water, and the wall of it that crosses the ring.
 *
 * Split out of `battlescene.ts` the way `hazardcrest.ts` was split out of
 * `waterhazard.ts`: that file owns the meshes, the uniforms and the frame
 * loop, and this one owns the GLSL they are built from.
 *
 * **What changed, and why this file exists.** The arena used to draw its sea
 * as two octaves of plain `snoise` and its crest as a flat translucent quad
 * lying on the water. Both were the shapes the open ocean had grown out of
 * years earlier: smooth noise gives rounded blobs rather than the creased
 * crest lines real sun glitter runs along, and a quad has no front face to
 * meet, no lip to break, and no silhouette at all. Side by side with the sea
 * outside the fight it read as an older draft of the same game.
 *
 * So the arena now compiles the SAME wave the globe does, and shares the code
 * rather than a description of it:
 *
 * - the ridged three-octave field out of `waterglsl.ts`'s `waveField`, at the
 *   wavelengths `waveconstants.ts` authors and stretched along the two axes
 *   it names, so a crest line here creases exactly as one out there does;
 * - the crest's own profile, imported as `HAZARD_PROFILE_GLSL` from
 *   `hazardfield.ts` -- the identical characters the globe's height field
 *   compiles, not a transcription of them;
 * - the crest's art -- the lip band, the torn ends, the streaks down the
 *   face, the thickness tint, the Fresnel rim -- from `hazardcrest.ts`'s own
 *   constants, so retuning a wave out at sea retunes the one in here.
 *
 * **What is still not shared, and must not be.** `water.ts` and
 * `waterpatch.ts` are still off limits (see `battlescene.ts`'s own module
 * comment): the globe's sea is a sphere with a depth ramp, an inland mask, a
 * wake map and a reflection cube, and none of that exists on a flat 300-unit
 * plane. The four things above are the field and the shapes, which are the
 * whole of what "the same wave" means; the rest is the sphere's business.
 *
 * Two departures from the globe are deliberate and are marked at the line
 * they happen: the arena is entirely near field, so every LOD fade the globe
 * carries is compiled out at 1 rather than evaluated, and the night sea is
 * lifted well above the globe's, because a fight has to stay legible on it.
 */

/* ------------------------------------------------------------------ */
/* The field                                                           */
/* ------------------------------------------------------------------ */

/**
 * The wave field's own drift, world units per second, as a direction and a
 * speed per octave.
 *
 * The globe advects its noise with three integrated wind offsets. The arena
 * has no wind -- the fight is ninety seconds on a plane, and `wind.ts` never
 * reaches it -- so each octave simply travels on a fixed bearing at a fixed
 * rate, which is what the arena's own sea always did. The speeds are the ones
 * it was tuned at; the third component of each is the slow walk along the
 * noise's own extra axis, so the field is born and dies where it is instead
 * of being one rigid pattern sliding across the frame.
 */
const DRIFT_SWELL: readonly [number, number, number] = [0.85, 0.06, 0.357];
const DRIFT_WAVE: readonly [number, number, number] = [-0.576, 0.35, 1.6];
const DRIFT_CHOP: readonly [number, number, number] = [1.1, 0.5, 0.44];

/**
 * Finite-difference step for the surface normal, world units, and the
 * strength the slope it measures is scaled by.
 *
 * Both are `water.ts`'s, converted once. That file steps 0.16 world units --
 * about a tenth of the 1.7-unit chop, which is the smallest thing in the
 * field -- and multiplies the difference it gets by
 * `uWaveStrength * uWaveIntensity`. Its difference is taken in direction
 * units over `NORMAL_STEP / GLOBE_RADIUS`, so its effective coefficient on a
 * true world-unit gradient is `NORMAL_STEP * uWaveStrength * uWaveIntensity`
 * and that is what `ARENA_TILT` is: the same normal, arrived at from a plane
 * instead of a sphere.
 *
 * `ARENA_INTENSITY` is the one number with no counterpart out there, because
 * the globe reads it off the wind. Somewhere between `water.ts`'s calm (0.16)
 * and its full gale (1.0), nearer the middle: the arena is a sea rough enough
 * to be worth drawing and to justify the crest crossing it, and not a gale,
 * which would put more chop on the water than a fight can be read through.
 */
const NORMAL_STEP = 0.16;
const WAVE_STRENGTH = 4.4;
const ARENA_INTENSITY = 0.55;
const ARENA_TILT = NORMAL_STEP * WAVE_STRENGTH * ARENA_INTENSITY;

/**
 * Blinn-Phong exponent and strength, `water.ts`'s own pair.
 *
 * The globe divides its exponent by a roughness that runs `mix(0.28, 1.0,
 * nearMid)`, and `nearMid` is 1 for anything closer than 50 units. The arena
 * camera sits 43 units from the middle of a 40-unit ring, so every pixel in
 * here is near field and that divisor is exactly 1 -- which is why the GGX
 * lobe below is written with the constant folded out rather than with a
 * distance term that could only ever evaluate to one thing.
 */
const SPEC_POWER = 300;
const SPEC_STRENGTH = 1.1;

/** `waterglsl.ts`'s own, and for the same reason: the sun is drawn as a disc, not a point. */
const SUN_DISC_RADIANS = 0.03;

/**
 * How far the arena's night sea sits above the globe's, and the ambient the
 * lit sea keeps.
 *
 * This is the one lighting number in the file that is NOT `water.ts`'s. Out
 * at sea a night ocean is allowed to go almost black -- that is what night on
 * a real ocean is, and the player has a lantern, a wake and a coastline to
 * read the world by. In here there is a fight on the water and nothing else
 * in the frame, so a night arena shaded at the globe's 0.075 of base is a
 * black screen with two boats on it. 0.22 is what the arena's own sea always
 * used as its ambient floor, kept.
 */
const NIGHT_FLOOR = 0.22;

/**
 * World-unit wavelength to the frequency a flat-plane sample multiplies by.
 *
 * The globe's own `freq()` is `GLOBE_RADIUS / wavelength` against a UNIT
 * DIRECTION vector, and an arc of `s` world units subtends `s / GLOBE_RADIUS`
 * radians -- so that expression advances the noise by exactly one unit per
 * wavelength of surface, which is what `1 / wavelength` does against a world
 * position. The two are the same frequency written for two domains, and that
 * is the whole conversion this file needs.
 *
 * It is also the bug the old arena sea had. It multiplied by `2 * PI /
 * wavelength`, so its "22-unit swell" was really a 3.5-unit one: the field
 * was six times too small, which is most of why it read as noise rather than
 * as a sea.
 */
function worldFreq(wavelength: number): string {
  return (1 / wavelength).toFixed(6);
}

/** A fixed 3-vector as a GLSL literal, `waveconstants.ts`'s `vec3Literal` for plain arrays. */
function vec3Of(v: readonly [number, number, number]): string {
  return `vec3(${v[0]}, ${v[1]}, ${v[2]})`;
}

/**
 * Uniforms every surface in the arena shares, plus the noise and the fog
 * contract both fragment shaders lean on.
 *
 * `uShallow` and `uFoam` are `water.ts`'s own two, and they arrive here for
 * the crest alone: the thickness tint is authored as a fraction of the
 * ocean's luminous teal and the foam as the ocean's froth white, and picking
 * new colours for the arena would put a second palette in the world for no
 * reason (ART-DIRECTION.md 2).
 */
const ARENA_UNIFORMS: string[] = [
  'uniform float uTime;',
  'uniform float uDayFactor;',
  'uniform vec3 uSunDirection;',
  'uniform vec3 uSunColor;',
  'uniform vec3 uOcean;',
  'uniform vec3 uDeep;',
  'uniform vec3 uSky;',
  'uniform vec3 uHorizon;',
  'uniform vec3 uShallow;',
  'uniform vec3 uFoam;',
];

/**
 * `stretch`, `ridge` and `arenaWave`: `waterglsl.ts`'s `waveField`, evaluated
 * on the xz plane instead of on the sphere.
 *
 * Every line that is not the domain is that function's, comments included,
 * because the crease `ridge` puts into the two upper octaves is the whole
 * difference between this sea and the blobs the arena used to draw. The
 * globe's LOD weights (`mid`, `fine`) are compiled in at 1: they exist to
 * fade the high octaves out with distance and at grazing angles, and the
 * arena is one plane seen from one fixed camera 43 units away.
 *
 * @param fine whether the third octave is compiled in at all, from
 *   `quality.waveChop` -- the same field, and the same judgement, that
 *   decides whether the globe's own chop runs.
 */
function arenaWaveGLSL(fine: boolean): string[] {
  return [
    `const float FREQ_SWELL = ${worldFreq(SWELL_WAVELENGTH)};`,
    `const float FREQ_WAVE = ${worldFreq(WAVE_WAVELENGTH)};`,
    `const float FREQ_CHOP = ${worldFreq(CHOP_WAVELENGTH)};`,
    `const vec3 DRIFT_SWELL = ${vec3Of(DRIFT_SWELL)};`,
    `const vec3 DRIFT_WAVE = ${vec3Of(DRIFT_WAVE)};`,
    `const vec3 DRIFT_CHOP = ${vec3Of(DRIFT_CHOP)};`,
    // The two fixed axes the WAVE and CHOP domains are stretched along, out
    // of waveconstants.ts. Crossing axes are what make the crests read as two
    // interfering wave trains rather than as one pattern.
    `const vec3 AXIS_WAVE = ${vec3Literal(AXIS_WAVE)};`,
    `const vec3 AXIS_CHOP = ${vec3Literal(AXIS_CHOP)};`,
    'vec3 stretch(vec3 q, vec3 axis, float k) { return q + axis * (dot(q, axis) * k); }',
    '// Folding noise through abs() creases it into crest lines, but that crease',
    '// is a gradient discontinuity that aliases into hard diagonal scratches',
    '// once a pixel spans several wavelengths. sqrt(v*v + r) is the same fold',
    '// with the corner rounded off; the arena is all near field, so `sharp` is',
    '// compiled in at 1 and the rounding is the small one.',
    'float ridge(float v, float sharp) {',
    '  return 0.5 - sqrt(v * v + mix(0.11, 0.0005, sharp));',
    '}',
    '// The plane is the y = 0 slice of the same 3D field the globe samples on',
    '// its sphere, so the drift vectors carry a small y of their own: that is',
    '// the slow walk along the noise\'s third axis, and without it the sea is',
    '// one rigid pattern in transit.',
    '//',
    '// `mid` and `fine` are the globe\'s own two LOD weights, doing the two',
    '// jobs they do out there: they fade an octave out AND round its crease',
    '// off as it goes, which is what stops the far water crawling with moire.',
    '// They are computed rather than compiled in at 1 because the arena plane',
    '// is 300 units across under a camera 43 units back: the middle of the',
    '// ring is near field, the corners of the frame are four times as far, and',
    '// an arena carrying full chop out to the last of them was the one thing',
    '// about this sea that still read as a texture rather than as water.',
    'float arenaWave(vec2 p, float mid, float fine) {',
    '  vec3 q = vec3(p.x, 0.0, p.y);',
    '  float s = snoise((q + DRIFT_SWELL * uTime) * FREQ_SWELL) * 0.55;',
    '  vec3 pw = stretch((q + DRIFT_WAVE * uTime) * FREQ_WAVE, AXIS_WAVE, 1.7);',
    '  s += ridge(snoise(pw), mid) * 0.90 * mid;',
    ...(fine
      ? [
          '  if (fine > 0.004) {',
          '    vec3 pc = stretch((q + DRIFT_CHOP * uTime) * FREQ_CHOP, AXIS_CHOP, 1.3);',
          '    s += ridge(snoise(pc), fine) * 0.44 * fine;',
          '  }',
        ]
      : []),
    '  return s;',
    '}',
  ];
}

/* ------------------------------------------------------------------ */
/* The shading both surfaces share                                     */
/* ------------------------------------------------------------------ */

/**
 * `WATER_LIGHTING_HEAD` and `_TAIL` and `WATER_FOAM_TAIL`, rewritten for a
 * plane, as statements rather than a function so the crest can raise the same
 * locals the globe's plugin hooks raise.
 *
 * The caller declares, before including this:
 *
 *   `vec3 P`         the shaded point in world space.
 *   `float h`        the raw wave field at it, `arenaWave`'s own output.
 *   `vec3 slope`     the horizontal gradient of everything the surface is
 *                    standing on top of the plane -- zero on the open sea,
 *                    the crest's own profile gradient on the wave. This is
 *                    the arena's whole answer to the `steep` seam
 *                    `waterglsl.ts` needs on the sphere: out there the smooth
 *                    normal is the planet's and a wall of water has to be
 *                    handed the gates back one at a time, in here the smooth
 *                    normal simply IS the wave's, because the plane under it
 *                    has no curvature to be confused with.
 *   `float chop`     multiplier on the field's own slope, the globe's
 *                    `tiltBoost`; 1 on open sea.
 *   `float lift`     world units of extra water for the backscatter to shine
 *                    through, the globe's `crestLift`; 0 on open sea.
 *   `float thick`    0..1 gate for the thickness tint; 0 on open sea.
 *   `float foam`     0..1 froth mask; 0 on open sea.
 *   `float lip`      0..1 gate for the Fresnel rim on a crest's lip.
 *   `float alpha`    what the fragment is written out at.
 *
 * and gets back `gl_FragColor`.
 */
const ARENA_SHADE_GLSL: string[] = [
  '  vec3 sun = normalize(uSunDirection);',
  '  vec3 toCam = cameraPosition - P;',
  '  float camDist = length(toCam);',
  '  vec3 view = toCam / max(camDist, 1e-4);',
  '',
  '  // `gateN` is the surface without its chop -- straight up on open water,',
  '  // the crest\'s own profile normal on the wave -- and it is what every',
  '  // "is this open sea" gate below asks. It is built BEFORE the field',
  '  // because the LOD fades ask it too: a wall of water faces the camera',
  '  // even where the plane under it is edge-on, and stripping that wall of',
  '  // its chop is half of what makes one read as clay.',
  '  vec3 gateN = normalize(vec3(-slope.x, 1.0, -slope.z));',
  '',
  '  // The globe\'s poor-man LOD, distances and all: a pixel covers more',
  '  // surface both with distance and at grazing angles, so the two upper',
  '  // octaves fade out on both counts.',
  '  float graze = clamp(dot(gateN, view), 0.0, 1.0);',
  '  float lod = smoothstep(0.06, 0.38, graze);',
  '  float nearMid = 1.0 - smoothstep(50.0, 105.0, camDist);',
  '  float fadeMid = nearMid * mix(0.30, 1.0, lod);',
  '  float fadeFine = (1.0 - smoothstep(28.0, 80.0, camDist)) * lod;',
  '',
  '  // `N` is the surface as it actually is, and it is what the specular and',
  '  // the Fresnel ask.',
  '  float h = arenaWave(P.xz, fadeMid, fadeFine);',
  '  float hx = arenaWave(P.xz + vec2(NORMAL_STEP, 0.0), fadeMid, fadeFine);',
  '  float hz = arenaWave(P.xz + vec2(0.0, NORMAL_STEP), fadeMid, fadeFine);',
  '  // Flattened as it recedes, the same way and for the same reason the',
  '  // globe flattens its own: an ocean that kept full chop into the distance',
  '  // reads as blotchy rather than as calm.',
  `  vec2 fieldSlope = vec2(hx - h, hz - h) * (${ARENA_TILT.toFixed(6)} / NORMAL_STEP)`,
  '                  * mix(0.22, 1.0, nearMid) * chop;',
  '  vec3 N = normalize(vec3(-slope.x - fieldSlope.x, 1.0, -slope.z - fieldSlope.y));',
  '',
  '  // On a sphere this is `smoothstep(-0.17, 0.22, dot(gateN, sunDir))`. The',
  '  // arena is flat and `battlescene.ts` grades `uDayFactor` off the sun\'s',
  '  // elevation with that same smoothstep, so the term is already in the',
  '  // uniform and computing it a second time would only disagree with the',
  '  // key light standing over the same water.',
  '  float lightAmt = clamp(uDayFactor, 0.0, 1.0);',
  '',
  '  // Body colour. The globe reads this off the bathymetry; a flat arena has',
  '  // one depth, so the field itself is the only thing left to key it to and',
  '  // crests come out a shade lighter than troughs.',
  '  vec3 base = mix(uDeep, uOcean, clamp(0.5 + h * 0.5, 0.0, 1.0));',
  '',
  '  float ndv = clamp(dot(N, view), 0.0, 1.0);',
  '  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);',
  '',
  '  // Thickness: a standing wall of water is not the colour of the trough',
  '  // beside it. hazardcrest.ts owns both the tint and how far it scopes in.',
  `  vec3 body = uShallow * ${THICK_SCALE.toFixed(3)} + vec3(0.0, ${THICK_GREEN.toFixed(3)}, ${THICK_BLUE.toFixed(3)});`,
  `  base = mix(base, body, thick * (0.35 + 0.65 * fres) * ${CREST_THICK.toFixed(3)});`,
  '',
  '  // Diffuse on a normal blended most of the way to the true one. The globe',
  '  // holds this at 0.45 on open sea and opens it toward 0.90 where a plugin',
  '  // says there is a wall; `slope` is that same statement, so the blend is',
  '  // written the same way round it.',
  '  float wall = clamp(length(slope), 0.0, 1.0);',
  '  vec3 diffN = normalize(mix(gateN, N, mix(0.45, 0.90, wall)));',
  '  float diff = clamp(dot(diffN, sun), 0.0, 1.0);',
  '  vec3 sunTint = mix(vec3(1.0), uSunColor, 0.45);',
  '',
  '  vec3 refl = reflect(-view, N);',
  '  float skyUp = clamp(refl.y, 0.0, 1.0);',
  '  vec3 skyCol = mix(uHorizon, uSky, smoothstep(0.0, 0.55, skyUp));',
  '',
  '  // GGX, normalised by its own peak and widened by the sun\'s angular',
  '  // radius, then gathered into a road around the mirror direction. The',
  '  // whole of waterglsl.ts\'s reasoning applies unchanged; only the',
  '  // roughness is a constant here, because the arena is all near field.',
  '  vec3 halfVec = normalize(sun + view);',
  '  float nh = clamp(dot(N, halfVec), 0.0, 1.0);',
  `  const float SPEC_POWER = ${SPEC_POWER.toFixed(1)};`,
  '  float alphaR = sqrt(2.0 / (SPEC_POWER + 2.0));',
  `  float alphaDisc = alphaR + ${SUN_DISC_RADIANS.toFixed(3)};`,
  '  float a2 = alphaDisc * alphaDisc;',
  '  float ggxDenom = nh * nh * (a2 - 1.0) + 1.0;',
  '  float ggxNorm = a2 / ggxDenom;',
  '  float ggxD = ggxNorm * ggxNorm;',
  '  float road = pow(clamp(dot(gateN, halfVec), 0.0, 1.0), 10.0);',
  '  float glint = ggxD * lightAmt * (0.30 + 0.70 * fres) * (0.08 + 0.92 * road);',
  '',
  '  // Backscatter: light glowing through a crest, seen when the camera looks',
  '  // toward the sun through it. `lift` is outside the intensity factor for',
  '  // the reason waterglsl.ts gives -- a wave that is standing there stands',
  '  // whatever the weather is doing.',
  `  float scatter = pow(clamp(dot(view, -sun), 0.0, 1.0), 4.0)`,
  `                * (max(h, 0.0) * ${ARENA_INTENSITY.toFixed(3)} + lift) * lightAmt;`,
  '',
  '  vec3 dayCol = base * (0.20 + 0.72 * diff) * sunTint;',
  '  dayCol += skyCol * fres * 0.085;',
  `  vec3 nightCol = mix(base, uDeep, 0.60) * ${NIGHT_FLOOR.toFixed(3)} + skyCol * fres * 0.05;`,
  '  vec3 col = mix(nightCol, dayCol, lightAmt);',
  `  col += uSunColor * glint * ${SPEC_STRENGTH.toFixed(3)};`,
  '  col += uShallow * scatter * 0.35;',
  '  col += base * mix(0.012, 0.030, lightAmt);',
  '',
  '  // Foam is water, so it takes the water\'s normal: a Lambert wrap that',
  '  // keeps froth bright on the shadow side, a Fresnel rim, and a share of',
  '  // the glint the surface already computed.',
  '  float foamDiff = clamp(dot(N, sun), 0.0, 1.0);',
  '  vec3 foamLit = uFoam * mix(0.09, 0.52, lightAmt)',
  '               * (0.62 + 0.38 * foamDiff)',
  '               * (1.0 + 0.55 * fres)',
  '               * mix(vec3(1.0), uSunColor, 0.30);',
  `  foamLit += uSunColor * glint * ${SPEC_STRENGTH.toFixed(3)} * 0.35;`,
  '  col = mix(col, foamLit, clamp(foam, 0.0, 1.0) * 0.85);',
  `  col += skyCol * fres * lip * ${LIP_RIM.toFixed(3)};`,
  '',
  '  // The arena is flat and centred on the origin, so a point on it has no',
  '  // local vertical of its own; lifting both the point and the camera by',
  '  // GLOBE_RADIUS puts them where the same pair would sit on the globe, so',
  '  // the grazing-angle and altitude terms in the aerial contract mean here',
  '  // what they mean out there.',
  // The weather the fight is fought in is the weather it interrupted: the fog
  // uniform block is `fog.ts`'s own, shared into this scene and last written
  // before the contact froze the world, so `uRainHere` is the storm that was
  // over the ship at the moment of the ram.
  //
  // The storm comes in and the fog does not, and the second half of that is
  // deliberate rather than an omission. A storm's haze darkens the air, which
  // an arena can carry -- a fight in foul weather should look like one. A
  // bank whitens it, and this camera sits close over a twenty-unit ring: fog
  // thick enough to read as fog would hide the enemy hull, and a fight the
  // player cannot see is not a harder fight, it is a broken one. There is no
  // map sample either, and there could not be: the arena is a flat sea
  // nowhere on the globe, so an equirectangular lookup here would be
  // meaningless.
  '  col = applyAerial(col, P + ARENA_LIFT, cameraPosition + ARENA_LIFT, sun, uDayFactor, vec2(uRainHere, 0.0));',
  '  // A hand-written ShaderMaterial, so postfx.ts leaves it out of the',
  '  // self-encode patch and it does the linear to sRGB step itself.',
  '  gl_FragColor = vec4(pow(col, vec3(0.4545454545)), alpha);',
];

/** Shared head: uniforms, noise, fog, the field, and the arena's lift. */
function arenaHead(fine: boolean): string[] {
  return [
    ...ARENA_UNIFORMS,
    'varying vec3 vWorldPos;',
    NOISE_GLSL,
    // Declares uFogColorDay, uFogColorNight and uFogDensity itself; they are
    // merged into the material's uniforms from `fog.ts` and must not be
    // declared a second time here.
    FOG_GLSL,
    `const float NORMAL_STEP = ${NORMAL_STEP.toFixed(3)};`,
    `const vec3 ARENA_LIFT = vec3(0.0, ${GLOBE_RADIUS.toFixed(1)}, 0.0);`,
    ...arenaWaveGLSL(fine),
  ];
}

/* ------------------------------------------------------------------ */
/* The open sea                                                        */
/* ------------------------------------------------------------------ */

export const SEA_VERTEX = [
  'varying vec3 vWorldPos;',
  'void main() {',
  '  vec4 world = modelMatrix * vec4(position, 1.0);',
  '  vWorldPos = world.xyz;',
  '  gl_Position = projectionMatrix * viewMatrix * world;',
  '}',
].join('\n');

/**
 * The open water of the arena: the shared shading with every crest local left
 * at the value that makes it an identity.
 *
 * `slope` is zero, so `gateN` is straight up and `N` is the field's own
 * normal; `thick`, `lift`, `foam` and `lip` are zero, so the four terms they
 * gate contribute exactly nothing. That is the same discipline the water
 * plugin contract keeps out at sea, and it means the sea in here is the sea
 * whether or not a wave is crossing it.
 */
export function seaFragment(fine: boolean): string {
  return [
    ...arenaHead(fine),
    'void main() {',
    '  vec3 P = vWorldPos;',
    '  vec3 slope = vec3(0.0);',
    '  float chop = 1.0;',
    '  float lift = 0.0;',
    '  float thick = 0.0;',
    '  float foam = 0.0;',
    '  float lip = 0.0;',
    '  float alpha = 1.0;',
    ...ARENA_SHADE_GLSL,
    '}',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* The crest                                                           */
/* ------------------------------------------------------------------ */

/**
 * Peak height of the arena's crest, world units.
 *
 * `hazardfield.ts`'s own strong-wave height, imported rather than chosen: the
 * two seas raise the same wave, and a wave that stood 1.6 out at sea and
 * something else in here would be the exact drift this file exists to stop.
 * Against a 3.1-unit hull that is a wall about half a hull high, which is
 * what the shove `battlesea.ts` deals -- two to six units of sway -- is worth.
 */
export const ARENA_CREST_HEIGHT = CREST_HEIGHT;

/**
 * Vertices along the crest and across it.
 *
 * `waterpatch.ts` lays the globe's displacement grid at one vertex every half
 * world unit and the wave is drawn on that, so the along-crest step matches
 * it exactly: 60 units of front at 0.5 is 120 segments. Across, the whole
 * footprint is a little over three half-widths -- about 9.6 units at the
 * arena's own `CREST_WIDTH` -- and that is where the silhouette lives, so it
 * gets a finer step: 40 segments is 0.24, about half the patch's.
 */
const CREST_SEGMENTS_ALONG = 120;
const CREST_SEGMENTS_ACROSS = 40;

/**
 * How hard the profile mask is driven into the alpha channel.
 *
 * The mesh is a flat rectangle with a wave standing in the middle of it, so
 * its own skirt lies exactly on the sea and must not be seen: alpha is the
 * profile, gained up so the body of the wave is solid and only the last of
 * the skirt fades. At 6 the mask is fully opaque wherever the crest is more
 * than a sixth of its height, which on a 1.6-unit wave is a quarter of a unit
 * of standing water -- below that there is nothing to draw anyway.
 */
const CREST_ALPHA_GAIN = 6;

/**
 * The crest's vertex shader: the game's own profile, raised on a plane.
 *
 * `position.xz` is the crest's own frame -- x along the front, z across it
 * and positive the way the wave is travelling -- because `battlescene.ts`
 * rotates the whole mesh onto the crest's axis and the profile is therefore
 * evaluated in local coordinates and nothing has to be un-rotated.
 *
 * The height is `hazRidge(u / halfLength) * hazCrest(v / bw)` with the same
 * asymmetric front and back widths the globe uses, out of the same compiled
 * characters. Nothing else is displaced: the sea this stands in is a flat
 * plane whose waves are a per-pixel normal, so a skirt that rose with the
 * field would part company with the water beside it.
 */
export const CREST_VERTEX = [
  'uniform float uCrestHeight;',
  'uniform float uHalfLength;',
  'uniform float uHalfWidth;',
  'varying vec3 vWorldPos;',
  'varying vec2 vLocal;',
  HAZ_CREST_RATIO_GLSL,
  HAZARD_PROFILE_GLSL,
  'float crestProfile(vec2 lp) {',
  '  float bw = uHalfWidth * (lp.y > 0.0 ? HAZ_CREST_FRONT : HAZ_CREST_BACK);',
  '  return hazRidge(lp.x / uHalfLength) * hazCrest(lp.y / max(bw, 1e-4));',
  '}',
  'void main() {',
  '  vLocal = position.xz;',
  '  vec3 local = vec3(position.x, uCrestHeight * crestProfile(vLocal), position.z);',
  '  vec4 world = modelMatrix * vec4(local, 1.0);',
  '  vWorldPos = world.xyz;',
  '  gl_Position = projectionMatrix * viewMatrix * world;',
  '}',
].join('\n');

/**
 * The crest's fragment shader: the arena's water, plus `hazardcrest.ts`'s art.
 *
 * Everything from `hridge` down is that file's, term for term and constant
 * for constant, moved from the sphere's local frame (`hu`, `hv`, `hb`) to
 * this one (`vLocal.x`, `vLocal.y`, `uHalfWidth`) and from direction-space
 * noise to world-space noise. The froth breakup, the band's wander, the torn
 * ends, the streaks running down the face and the fade they start and stop
 * on are all reproduced rather than re-invented, because the wave they were
 * tuned against is the wave standing here.
 *
 * What is deliberately NOT carried over is the `steep` seam. Out at sea the
 * four gates it opens are asking the sphere's normal about a wall of water;
 * in here `gateN` is built from the crest's own profile gradient in the first
 * place, so the gates already have the surface that is actually there and
 * there is nothing to hand back.
 *
 * @param fine as `seaFragment` -- the field's third octave, off the quality
 *   tier. The crest is shaded with the same sea it stands in, so it loses its
 *   chop on exactly the tiers the water does.
 */
export function crestFragment(fine: boolean): string {
  return [
    ...arenaHead(fine),
    'uniform float uCrestHeight;',
    'uniform float uHalfLength;',
    'uniform float uHalfWidth;',
    '// The crest frame in world space: where local +x and local +z point, so',
    '// the profile gradient below can be turned into a world horizontal',
    '// without a matrix the fragment stage does not have.',
    'uniform vec3 uCrestAlong;',
    'uniform vec3 uCrestAcross;',
    'varying vec2 vLocal;',
    HAZ_CREST_RATIO_GLSL,
    HAZARD_PROFILE_GLSL,
    'float crestProfile(vec2 lp) {',
    '  float bw = uHalfWidth * (lp.y > 0.0 ? HAZ_CREST_FRONT : HAZ_CREST_BACK);',
    '  return hazRidge(lp.x / uHalfLength) * hazCrest(lp.y / max(bw, 1e-4));',
    '}',
    'void main() {',
    '  vec3 P = vWorldPos;',
    '',
    '  // The profile, and its gradient by the same finite difference the',
    '  // field uses. Polynomials, so three evaluations cost less than the one',
    '  // noise tap above them.',
    '  float mask = crestProfile(vLocal);',
    '  float pu = crestProfile(vLocal + vec2(NORMAL_STEP, 0.0));',
    '  float pv = crestProfile(vLocal + vec2(0.0, NORMAL_STEP));',
    '  vec3 slope = (uCrestAlong * (pu - mask) + uCrestAcross * (pv - mask))',
    '             * (uCrestHeight / NORMAL_STEP);',
    '',
    '  float hazHeight0 = uCrestHeight * mask;',
    '  // The along-length profile on its own, which is what makes the shoulder',
    '  // term below a shoulder finder: across the crest it does not vary, so',
    '  // the extra chop lands as two bands down the two ends of the wave.',
    '  float hridge = hazRidge(vLocal.x / uHalfLength);',
    `  float hshoulder = 4.0 * hridge * (1.0 - hridge) * mask;`,
    `  float chop = 1.0 + ${SHOULDER_CHOP.toFixed(2)} * hshoulder;`,
    `  float lift = hazHeight0 * mask * ${CREST_LIFT.toFixed(3)};`,
    '  // Normalised against a GREAT wave rather than against this one, so an',
    '  // arena crest is tinted exactly as hard as a wave of its height is out',
    '  // at sea and no harder. The square root is hazardcrest.ts\'s: the crest',
    '  // profile is already a cube, and multiplying two copies of it together',
    '  // would leave the tint on the lip alone.',
    `  float thick = sqrt(clamp(hazHeight0 * ${(1 / CREST_HEIGHT_MAX).toFixed(6)}, 0.0, 1.0))`,
    `             * clamp(mask * ${CREST_SCOPE.toFixed(1)}, 0.0, 1.0);`,
    '',
    '  // ---- hazardcrest.ts, verbatim in this frame -----------------------',
    '  // One noise, read twice: raw for the band\'s wander, because the clamped',
    '  // breakup saturates for much of its range and a wander driven by it',
    '  // would snap between two positions rather than wandering.',
    `  vec3 hq = vec3(P.x, P.z, 0.0) * ${worldFreq(FROTH_WAVELENGTH)} + vec3(uTime * ${FROTH_DRIFT.toFixed(4)});`,
    '  float hnoise = snoise(hq);',
    '  float hbreak = clamp(0.40 + 0.75 * hnoise, 0.0, 1.0);',
    `  float hcentre = ${FOAM_BIAS.toFixed(3)} + ${FOAM_WANDER.toFixed(3)} * hnoise;`,
    `  float hband = (vLocal.y - uHalfWidth * hcentre) / (uHalfWidth * ${FOAM_BAND.toFixed(3)});`,
    '  // The ridge, eaten into by the same noise, so the band ends in clumps',
    '  // instead of dimming evenly down a shoulder.',
    `  float htorn = clamp((hridge - ${FOAM_TEAR.toFixed(3)} * (1.0 - hbreak)) * ${FOAM_TEAR_INV.toFixed(4)}, 0.0, 1.0);`,
    '  float foam = htorn * hazBump(hband) * hbreak;',
    '  // `hrun` is 0 at the crest line and 1 at the front foot, clamped, so the',
    '  // streak layer is zero on the back face without a branch: the back of a',
    '  // wave is not spilling and should not be foaming.',
    '  float hrun = clamp(vLocal.y / (uHalfWidth * HAZ_CREST_FRONT), 0.0, 1.0);',
    '  vec3 hsq = vec3(',
    `    vLocal.x * ${worldFreq(STREAK_WIDTH)},`,
    `    vLocal.y * ${worldFreq(STREAK_LENGTH)} - uTime * ${STREAK_FALL.toFixed(4)},`,
    `    uTime * ${STREAK_LIFE.toFixed(4)});`,
    `  float hstreak = smoothstep(${STREAK_LO.toFixed(3)}, ${STREAK_HI.toFixed(3)}, snoise(hsq));`,
    '  hstreak *= smoothstep(0.10, 0.40, hrun) * (1.0 - smoothstep(0.35, 1.0, hrun));',
    `  foam = max(foam, hstreak * hridge * (0.35 + 0.65 * hbreak) * ${STREAK_FOAM.toFixed(3)});`,
    `  float lip = smoothstep(${LIP_LO.toFixed(3)}, ${LIP_HI.toFixed(3)}, mask);`,
    '',
    `  float alpha = clamp(mask * ${CREST_ALPHA_GAIN.toFixed(1)}, 0.0, 1.0);`,
    ...ARENA_SHADE_GLSL,
    '}',
  ].join('\n');
}

/** The geometry the crest is drawn on, in segments. Read by `battlescene.ts`. */
export const CREST_GRID = {
  along: CREST_SEGMENTS_ALONG,
  across: CREST_SEGMENTS_ACROSS,
} as const;
