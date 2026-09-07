/**
 * `water.ts`'s fragment shader, pulled apart into named chunks so five later
 * agents (`docs/RENDER_PLAN.md` Phase 1: A, B, C, D, E) can each add a
 * `WaterPlugin` instead of all editing this file's `main()` at once.
 *
 * `water.ts` still assembles these into one shader, in this order:
 *
 *   WATER_UNIFORMS
 *   (plugin declarations, noise, height map, fog contract)
 *   waterWavefield(...)
 *   waterSurface()                     -- opens main(), tangent basis, seam
 *   [slope hook]                       -- may raise steep/steepN/…; see below
 *   waterDepth(...)                    -- LOD, builds N, depth ramp
 *   [normal hook]                      -- may rewrite N; see below
 *   WATER_LIGHTING_HEAD                -- through skyCol
 *   [reflection hook]                  -- may rewrite skyCol; see below
 *   WATER_LIGHTING_TAIL                -- glint, day/night mix
 *   waterFoam(...)                     -- fd, and the coastal foam mask
 *   [foam hook]                        -- may raise `foam`; see below
 *   WATER_FOAM_TAIL                    -- foamLit, mixes foam into col
 *   [colour hook, then applyAerial]    -- may rewrite col; see below
 *   WATER_OUTPUT                       -- sRGB encode, closes main()
 *
 * `WATER_LIGHTING_HEAD`/`_TAIL` are, together, the "WATER_LIGHTING chunk" the
 * plan names: split in two only so the reflection hook (Stream D) is a real
 * seam in the array rather than a search-and-splice into one long string.
 * Stream E, which rewrites the lighting math, owns both halves. Likewise
 * `waterFoam`/`WATER_FOAM_TAIL` are the "WATER_FOAM chunk".
 *
 * Every hook slot below is documented directly above the export that ends
 * (for `normal`, `reflection`, `foam`) or precedes (`colour`) the seam, with
 * the GLSL variables in scope at that point.
 */
import { AXIS_WAVE, AXIS_CHOP, vec3Literal } from './waveconstants';

/** Uniforms and varyings the rest of the shader (and every plugin) can read. */
export const WATER_UNIFORMS: string[] = [
  'uniform sampler2D uHeightMap;',
  'uniform sampler2D uInlandMask;',
  'uniform float uSeaLevel;',
  'uniform float uTime;',
  'uniform float uDayFactor;',
  'uniform vec3 uSunDirection;',
  'uniform vec3 uSunColor;',
  'uniform vec3 uShallow;',
  'uniform vec3 uShelf;',
  'uniform vec3 uOcean;',
  'uniform vec3 uDeep;',
  'uniform vec3 uAbyss;',
  'uniform vec3 uLakeShallow;',
  'uniform vec3 uLakeDeep;',
  'uniform float uLakeDepthRange;',
  'uniform float uLakeCalm;',
  'uniform vec3 uFoamColor;',
  'uniform vec3 uSkyColor;',
  'uniform vec3 uHorizonColor;',
  'uniform float uWaveStrength;',
  'uniform float uWaveIntensity;',
  'uniform vec3 uOffsetSwell;',
  'uniform vec3 uOffsetWave;',
  'uniform vec3 uOffsetChop;',
  'uniform float uSpecPower;',
  'uniform float uSpecStrength;',
  'uniform float uFoamWidth;',
  'varying vec3 vDir;',
  'varying vec3 vWorldPos;',
];

/**
 * The three drifting octaves that make the height field, as world-unit
 * frequencies already converted to 1/radian by `water.ts` (see its
 * `freq()`/world-scale comment) -- this chunk never does that conversion
 * itself, so it stays radius-agnostic.
 */
export function waterWavefield(freqSwell: string, freqWave: string, freqChop: string): string[] {
  return [
    // Derived from the world-unit wavelengths and speeds at the top of the
    // file; see the note there for why they are not written literally.
    `const float FREQ_SWELL = ${freqSwell};`,
    `const float FREQ_WAVE = ${freqWave};`,
    `const float FREQ_CHOP = ${freqChop};`,
    '',
    // Two fixed world axes the noise domain is stretched along. A plain 3x3
    // scale is continuous over the whole sphere, so unlike a tangent-frame
    // stretch it introduces no pole singularity, and the two axes crossing
    // makes the crests read as two interfering wave trains. Both are unit.
    // Values live in waveconstants.ts, shared with the CPU port in
    // wavefield.ts (Phase 1 stream B), so the two can never numerically drift
    // apart -- this is a pure move, the numbers are unchanged.
    `const vec3 AXIS_WAVE = ${vec3Literal(AXIS_WAVE)};`,
    `const vec3 AXIS_CHOP = ${vec3Literal(AXIS_CHOP)};`,
    'vec3 stretch(vec3 q, vec3 axis, float k) { return q + axis * (dot(q, axis) * k); }',
    '// Folding noise through abs() creases it into crest lines, but that crease',
    '// is a gradient discontinuity: once a pixel spans several wavelengths it',
    '// aliases into hard diagonal scratches across the open ocean. sqrt(v*v + r)',
    '// is the same fold with the corner rounded off by r, so the crest stays',
    '// sharp close up and dissolves into smooth swell as the surface recedes.',
    'float ridge(float v, float sharp) {',
    '  return 0.5 - sqrt(v * v + mix(0.11, 0.0005, sharp));',
    '}',
    '// `m` is the motion scale, passed in rather than read off the mask because',
    '// inland water runs slow. The offsets are positions the CPU integrated, so',
    '// scaling them scales the distance travelled -- which is exactly what a',
    '// slower clock means, and is what multiplying uTime used to buy. The two',
    '// clocks only ever meet over the strip of bank between a lake and the sea,',
    '// so the crossfade is hidden under land.',
    'float waveField(vec3 p, float m, float mid, float fine) {',
    '  // Swell: smooth, long undulation. The two layers above it are ridged,',
    '  // which is what makes the glint run in streaks like real sun glitter.',
    '  float s = snoise((p + uOffsetSwell * m) * FREQ_SWELL) * 0.55;',
    '  vec3 pw = stretch((p + uOffsetWave * m) * FREQ_WAVE, AXIS_WAVE, 1.7);',
    '  s += ridge(snoise(pw), mid) * 0.90 * mid;',
    '  if (fine > 0.004) {',
    '    vec3 pc = stretch((p + uOffsetChop * m) * FREQ_CHOP, AXIS_CHOP, 1.3);',
    '    s += ridge(snoise(pc), fine) * 0.44 * fine;',
    '  }',
    '  return s;',
    '}',
  ];
}

/**
 * Opens `main()`: view/sun setup, the inland/motion blend, the tangent basis,
 * and the four `steep`-seam locals a plugin may raise at the `slope` hook.
 *
 * The tangent basis used to be built below the LOD block, with the wave-field
 * sample. It is built here instead so that the `slope` hook has it: a plugin
 * that wants to say "this pixel is a wall of water, not open sea" has to be
 * able to finite-difference its own field, and it has to say so BEFORE the LOD
 * decides how much detail the pixel is worth. Pure reorder -- `ref`, `tanU`
 * and `tanV` depend on `n` alone, and `n` has not moved.
 *
 * --- hook: `slope` ---------------------------------------------------------
 * Runs immediately after this chunk, before `waterDepth`.
 *
 * In scope, may be raised (each is a no-op at its default, and the shader is
 * exactly the shader it was when no plugin touches any of them):
 *
 *   `steep`     0..1, default 0. How far this pixel's true surface normal
 *               should replace the smooth sphere normal `n` in the four
 *               places `n` is used as a "this is open sea" gate: the grazing
 *               LOD, `lightAmt`, the diffuse blend and the sun road. The
 *               whole reason the front of a great wave reads as clay is that
 *               all four of those gates ask the sphere, not the water: a face
 *               tilted 64 degrees off `n` is lit, faded and de-sparkled as
 *               though it were flat. Raising `steep` hands those gates back
 *               to the surface that is actually there.
 *   `steepN`    unit, default `n`. The normal `steep` blends toward. A plugin
 *               that raises `steep` must set this to its own field's normal;
 *               the wave field's own `N` does not exist yet at this point in
 *               main() (it needs the LOD `steep` is about to change) and is
 *               deliberately not what this gate is about.
 *   `crestLift` world units, default 0. Extra thickness of water for the
 *               backscatter term to shine through, added to the ordinary wave
 *               field's `w0`. Unlike `w0` it is NOT scaled by `uWaveIntensity`
 *               -- a rogue wave stands whatever the wind is doing.
 *   `tiltBoost` multiplier, default 1. Scales the wave field's normal `tilt`,
 *               i.e. how choppy the surface reads. For water that is being
 *               torn apart (the wall of a maelstrom) rather than merely
 *               displaced.
 *
 * Read only: `n`, `viewDir`, `camDist`, `sunDir`, `tanU`, `tanV`, `inland`,
 * `motion`, `lakeTime`, `vWorldPos`.
 */
export function waterSurface(): string[] {
  return [
    'void main() {',
    '  vec3 n = normalize(vDir);',
    '  vec3 toCam = cameraPosition - vWorldPos;',
    '  float camDist = length(toCam);',
    '  vec3 viewDir = toCam / max(camDist, 1e-4);',
    '  vec3 sunDir = normalize(uSunDirection);',
    '',
    '  // 1 on water the ship can never reach, 0 on the open ocean.',
    '  float inland = texture2D(uInlandMask, dirToEquirect(n)).r;',
    '  float motion = mix(1.0, uLakeCalm, inland);',
    '  float lakeTime = uTime * motion;',
    '',
    '  // Tangent basis for the finite difference. The reconstructed normal is',
    '  // the tangential gradient, which is basis independent, so swapping the',
    '  // reference axis near the poles does not show up as a seam.',
    '  vec3 ref = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), step(0.95, abs(n.y)));',
    '  vec3 tanU = normalize(cross(ref, n));',
    '  vec3 tanV = cross(n, tanU);',
    '',
    '  // ---- the steep seam --------------------------------------------------',
    '  // See the `slope` hook contract in waterglsl.ts. All four are no-ops at',
    '  // these defaults, and every gate below is written so that steep = 0',
    '  // reduces to the expression that was there before the seam existed.',
    '  float steep = 0.0;',
    '  vec3 steepN = n;',
    '  float crestLift = 0.0;',
    '  float tiltBoost = 1.0;',
  ];
}

/**
 * The LOD fades, the wave-field sample and its finite-difference normal `N`,
 * then the depth colour ramp and the shallow-water caustic ripple.
 *
 * `eps` is `NORMAL_STEP` (world units) converted to direction-space by
 * `water.ts`, exactly like the frequencies above.
 *
 * --- hook: `normal` -------------------------------------------------------
 * Runs immediately after this chunk, before `WATER_LIGHTING_HEAD`.
 * In scope, may be modified: `N` (unit).
 * Read only: `n`, `vWorldPos`, `camDist`, `w0`.
 * (Also still in scope, for a plugin that needs them: `motion`, `lakeTime`,
 * `lod`, `nearMid`, `tanU`, `tanV`, `wu`, `wv`, `tilt`, and the four seam
 * locals `steep`, `steepN`, `crestLift`, `tiltBoost`.)
 */
export function waterDepth(eps: string): string[] {
  return [
    '',
    '  // The normal the four smooth-normal gates below ask instead of `n`.',
    '  // At steep = 0 this is `n` to the last bit, so an unhooked shader is',
    '  // unchanged.',
    '  vec3 gateN = normalize(mix(n, steepN, steep));',
    '',
    '  // Poor-man LOD. A pixel covers more surface both with distance and at',
    '  // grazing angles, so fade the high octaves out on both counts; without',
    '  // the grazing term the water near the horizon crawls with moire.',
    '  //',
    '  // Gated on `gateN`: a near-vertical wall of water faces the camera even',
    '  // where the sphere under it is edge-on, and stripping that wall of its',
    '  // chop -- which is what asking `n` here does -- is half of why it reads',
    '  // as clay.',
    '  float graze = clamp(dot(gateN, viewDir), 0.0, 1.0);',
    '  float lod = smoothstep(0.06, 0.38, graze);',
    '  float nearMid = 1.0 - smoothstep(50.0, 105.0, camDist);',
    '  float fadeMid = nearMid * mix(0.30, 1.0, lod);',
    '  float fadeFine = (1.0 - smoothstep(28.0, 80.0, camDist)) * lod;',
    '',
    `  const float EPS = ${eps};`,
    '  float w0 = waveField(n, motion, fadeMid, fadeFine);',
    '  float wu = waveField(n + tanU * EPS, motion, fadeMid, fadeFine);',
    '  float wv = waveField(n + tanV * EPS, motion, fadeMid, fadeFine);',
    '  // Flatten the surface as it recedes, so the ocean reads calm from orbit',
    '  // rather than blotchy, and flatten it again over inland water so a pond',
    '  // is close to a mirror.',
    '  // uWaveIntensity is the wind term: it runs as the SQUARE of the wind',
    '  // speed, so a gale is not twice the sea of half a gale but four times',
    '  // it, and the difference between weathers is felt rather than measured.',
    '  // `tiltBoost` is 1 unless a plugin raised it at the `slope` hook: water',
    '  // that is being torn apart carries more chop than water that is merely',
    '  // being lifted.',
    '  float tilt = uWaveStrength * uWaveIntensity * mix(0.22, 1.0, nearMid) * motion * tiltBoost;',
    '  vec3 N = normalize(n - (tanU * (wu - w0) + tanV * (wv - w0)) * tilt);',
    '',
    '  // ---- depth colour ----------------------------------------------------',
    '  float h = terrainHeight(uHeightMap, n);',
    '  float depth = max(0.0, uSeaLevel - h);',
    '  vec3 base;',
    '  if (depth < 0.11) {',
    '    base = mix(uShallow, uShelf, depth / 0.11);',
    '  } else {',
    '    float t = clamp((depth - 0.11) / 0.55, 0.0, 1.0);',
    '    if (t < 0.5) base = mix(uShelf, uOcean, t / 0.5);',
    '    else if (t < 0.85) base = mix(uOcean, uDeep, (t - 0.5) / 0.35);',
    '    else base = mix(uDeep, uAbyss, (t - 0.85) / 0.15);',
    '  }',
    '  // Fresh water: its own short ramp, so even a deep tarn stays lake green',
    '  // instead of sliding down the ocean palette into abyssal navy.',
    '  if (inland > 0.002) {',
    '    float ld = smoothstep(0.0, max(uLakeDepthRange, 1e-4), depth);',
    '    base = mix(base, mix(uLakeShallow, uLakeDeep, ld), inland);',
    '  }',
    '  // Shallows keep their glow and pick up a moving caustic ripple, which is',
    '  // what reads as translucency over a sandy bottom.',
    '  float shallowMask = 1.0 - smoothstep(0.0, 0.15, depth);',
    '  base *= 1.0 + shallowMask * w0 * 0.30 * motion;',
  ];
}

/** First half of the lighting chunk: sun/diffuse terms, then the sky colour. */
export const WATER_LIGHTING_HEAD: string[] = [
  '',
  '  // ---- lighting --------------------------------------------------------',
  '  float sunGeo = dot(gateN, sunDir);',
  '  float lightAmt = smoothstep(-0.17, 0.22, sunGeo);',
  '  // Diffuse uses a half-strength normal: the full one makes the body',
  '  // colour crawl with the chop. The specular keeps the full normal.',
  '  //',
  '  // Half strength is right for chop, which is small and everywhere, and',
  '  // wrong for a wall, which is large and somewhere: at 0.45 a face tilted',
  '  // 64 degrees is shaded as though tilted 29, and the tonal step that would',
  '  // make it read as a wall is more than halved. `steep` opens the blend',
  '  // toward the true normal exactly where a plugin says there is a wall.',
  '  vec3 diffN = normalize(mix(n, N, mix(0.45, 0.90, steep)));',
  '  float diff = clamp(dot(diffN, sunDir), 0.0, 1.0);',
  '  vec3 sunTint = mix(vec3(1.0), uSunColor, 0.45);',
  '',
  '  float ndv = clamp(dot(N, viewDir), 0.0, 1.0);',
  '  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);',
  '  vec3 refl = reflect(-viewDir, N);',
  '  float skyUp = clamp(dot(refl, n), 0.0, 1.0);',
  '  vec3 skyCol = mix(uHorizonColor, uSkyColor, smoothstep(0.0, 0.55, skyUp));',
];

/*
 * --- hook: `reflection` ----------------------------------------------------
 * Runs immediately after WATER_LIGHTING_HEAD, before WATER_LIGHTING_TAIL.
 * In scope, may be modified: `skyCol`.
 * Read only: everything WATER_LIGHTING_HEAD and waterDepth built --
 * `n`, `N`, `viewDir`, `refl`, `skyUp`, `lightAmt`, `fres`, `camDist`, etc.
 */

/**
 * Second half of the lighting chunk: specular, backscatter, then the
 * day/night mix.
 *
 * Stream E (docs/RENDER_PLAN.md, Phase 1) rewrote this half: the old two-lobe
 * Blinn-Phong glint (`glintSharp` + `glintWide`) is now a single GGX `D` term
 * (no Smith visibility, no extra Fresnel lobe of its own -- `fres` and `road`
 * below already do that job) widened by the sun's own angular radius, plus a
 * backscatter term that lights up a wave crest when the camera looks toward
 * the sun through it. Both are art choices tuned by eye, not a physical
 * sun/ocean model.
 */
export const WATER_LIGHTING_TAIL: string[] = [
  '',
  '  vec3 halfVec = normalize(sunDir + viewDir);',
  '  float nh = clamp(dot(N, halfVec), 0.0, 1.0);',
  '  // Distance doubles as roughness: close up the water is choppy and the',
  '  // highlight is broad and sparkly; from orbit it is a mirror, so the sun',
  '  // reflection has to tighten to a small spot instead of a white continent.',
  '  float rough = mix(0.28, 1.0, nearMid);',
  '  float specPow = uSpecPower / rough;',
  '  // `alpha` is the standard Blinn-Phong-exponent -> GGX-roughness',
  '  // conversion, so uSpecPower keeps its old meaning and tuning range while',
  '  // the lobe itself becomes a proper GGX normal distribution.',
  '  float alpha = sqrt(2.0 / (specPow + 2.0));',
  '  // The sun is drawn with an angular radius, not as a point: without this,',
  '  // `alpha` shrinks toward the far/orbital view until the highlight is a',
  '  // sub-pixel spike -- scattered pin pricks rather than a road of small',
  '  // discs. SUN_DISC_RADIANS is an art choice, deliberately larger than the',
  '  // real sun (about 0.0047 rad) so the discs read at all against the chop.',
  '  const float SUN_DISC_RADIANS = 0.03;',
  '  float alphaDisc = alpha + SUN_DISC_RADIANS;',
  '  float a2 = alphaDisc * alphaDisc;',
  '  float ggxDenom = nh * nh * (a2 - 1.0) + 1.0;',
  '  // Raw GGX D is a DISTRIBUTION, not a reflectance: it integrates to 1',
  '  // against the cosine over the hemisphere, so a narrow lobe is supposed to',
  '  // have a huge peak (1 / (PI * a2), which is about 25 at the near-field',
  '  // roughness this shader runs) rather than the ~1 a Blinn-Phong term',
  '  // topped out at. Adding that raw would blow the highlight out; clamping',
  '  // it flattens the lobe\'s top into a broad plateau instead of narrowing',
  '  // it, which is worse -- most of the near field ends up at the same',
  '  // maximum brightness. Normalising by the peak keeps the true GGX shape',
  '  // (the wider-than-Blinn tail the sun disc widening above is for) and',
  '  // brings it back to 1.0 exactly at the mirror direction. The PI cancels',
  '  // algebraically against the PI already in the peak, leaving a plain',
  '  // squared ratio.',
  '  float ggxNorm = a2 / ggxDenom;',
  '  float ggxD = ggxNorm * ggxNorm;',
  '  // Gate on the SMOOTH normal too, so the sparkle gathers into a sun road',
  '  // around the mirror direction instead of covering the whole ocean.',
  '  //',
  '  // `gateN` rather than `n`: off the road this gate leaves only the 0.08',
  '  // floor, i.e. 8% of the highlight, and it leaves it there no matter how',
  '  // exactly the surface points at the mirror direction. On open sea that is',
  '  // the point. On the face of a wave it means the wave cannot catch the sun',
  '  // at all, which no amount of tuning further down can give back.',
  '  float road = pow(clamp(dot(gateN, halfVec), 0.0, 1.0), 10.0 / rough);',
  '  float glint = ggxD * lightAmt * (0.30 + 0.70 * fres) * (0.08 + 0.92 * road);',
  '',
  '  // Backscatter: light glowing through a wave crest, seen when sailing',
  '  // toward the sun so the crest is lit from behind. `w0` is the same wave-',
  '  // height field already sampled for the normal; the tint reuses the',
  '  // existing shallow-water colour (uShallow) rather than adding a new one,',
  '  // and it is gated on daylight -- there is nothing to scatter once the sun',
  '  // is below the horizon.',
  '  const float SCATTER_POWER = 4.0;',
  '  const float SCATTER_STRENGTH = 0.35;',
  '  // `crestLift` is the same idea for water a plugin put there rather than',
  '  // the wave field: thickness to shine through. It is added OUTSIDE the',
  '  // uWaveIntensity factor on purpose -- `w0` is wind-driven and should fade',
  '  // with the wind, a rogue wave stands in a calm and should still glow.',
  '  float scatter = pow(clamp(dot(viewDir, -sunDir), 0.0, 1.0), SCATTER_POWER)',
  '                * (max(w0, 0.0) * uWaveIntensity + crestLift) * lightAmt;',
  '',
  '  vec3 dayCol = base * (0.20 + 0.72 * diff) * sunTint;',
  '  dayCol += skyCol * fres * 0.085;',
  '  vec3 nightCol = mix(base, uAbyss, 0.60) * 0.075 + skyCol * fres * 0.015;',
  '  vec3 col = mix(nightCol, dayCol, lightAmt);',
  '  col += uSunColor * glint * uSpecStrength;',
  '  col += uShallow * scatter * SCATTER_STRENGTH;',
  '  col += base * mix(0.012, 0.030, clamp(uDayFactor, 0.0, 1.0));',
];

/**
 * The coastal foam mask. `fd` (distance into the foam band, in foam widths)
 * is computed unconditionally; the shoreline computation that raises `foam`
 * above zero only runs `if (fd < 2.6)`, but `foam` itself is declared, and
 * mixed into `col`, unconditionally -- see WATER_FOAM_TAIL and the `foam`
 * hook below. That split (not the original single `if` block) is what lets
 * the wake plugin (Stream A) light up foam far out at sea, where `fd` is
 * nowhere near the coastal band.
 *
 * `coarseFreq`/`coarseDrift`/`speckFreq`/`speckDrift` are the two foam
 * octaves' world-unit frequency and drift, converted by `water.ts` exactly
 * like the wave frequencies above.
 *
 * --- hook: `foam` -----------------------------------------------------------
 * Runs immediately after this chunk, before WATER_FOAM_TAIL. Also runs when
 * `fd >= 2.6`, i.e. outside the coastal band -- this is the one hook slot
 * that fires unconditionally, every pixel, not just near a shore.
 * In scope, may be modified: `foam` (0-1 mask).
 * Read only: everything above, including `fd`, `depth`, `inland`, `col`.
 */
export function waterFoam(
  coarseFreq: string,
  coarseDrift: string,
  speckFreq: string,
  speckDrift: string,
): string[] {
  return [
    '',
    '  // ---- coastal foam ----------------------------------------------------',
    '  float fd = depth / max(uFoamWidth, 1e-4);',
    '  float foam = 0.0;',
    '  if (fd < 2.6) {',
    '    // The fine speckle has to fade with distance like the wave chop does,',
    '    // or a coastline seen from far off stipples instead of foaming.',
    '    float foamNear = 1.0 - smoothstep(42.0, 92.0, camDist);',
    '    float foamLod = foamNear * mix(0.35, 1.0, lod);',
    `    float coarse = snoise(n * ${coarseFreq} + ${coarseDrift} * lakeTime);`,
    `    float speck = snoise(n * ${speckFreq} + ${speckDrift} * lakeTime) * foamLod;`,
    '    // Per-place phase, so the whole coastline does not pulse in unison.',
    '    float swell = 0.5 + 0.5 * sin(coarse * 3.4 + lakeTime * 1.25);',
    '    float outer = 0.22 + 0.55 * swell + speck * 0.28;',
    '    float band = 1.0 - smoothstep(outer * 0.30, outer, fd);',
    '    // A breaker line running shoreward and dying as it lands.',
    '    float run = fract(lakeTime * 0.19 + coarse * 0.5);',
    '    float lineAt = 1.70 - 1.55 * run;',
    '    float dl = (fd - lineAt) / 0.22;',
    '    float breaker = exp(-dl * dl) * (0.30 + 0.70 * run);',
    '    foam = clamp(band + breaker * 0.85, 0.0, 1.0);',
    '    // Punch holes in it so the surf breaks up into streaks and patches',
    '    // instead of ringing every island in a clean neon outline.',
    '    foam *= 0.34 + 0.80 * smoothstep(-0.45, 0.55, speck + coarse * 0.35);',
    '    // Squared in distance and with no floor: real surf from the deck,',
    '    // nothing at all from orbit. With a floor every island ends up ringed',
    '    // in neon and the planet reads as a wireframe map.',
    '    foam *= foamNear * foamNear * mix(0.35, 1.0, lod);',
    '    // A lake shore laps; it does not break. Leave a trace of a waterline',
    '    // and take the surf away entirely.',
    '    foam *= mix(1.0, 0.12, inland);',
    '  }',
  ];
}

/**
 * Lights the foam mask and mixes it into `col`.
 *
 * This used to be a constant: `uFoamColor` scaled by the day factor and
 * nothing else. Against the coastal band, where the surf is a thin line on
 * near-flat water, a constant passes. Against anything with a shape under it
 * -- the front of a great wave, the wall of a maelstrom, both of which the
 * hazard plugin foams heavily -- it is the single most damaging term in the
 * shader: roughly half of the face's colour becomes a flat mid grey that
 * swamps every lit term underneath, and the face reads as clay rather than as
 * water. Foam is water, so it takes the water's normal.
 *
 * Three terms, all deliberately gentle so the coastline is not re-lit into
 * something new: a Lambert wrap that keeps foam bright on the shadow side
 * (real surf is thick and scatters, it does not go black), a Fresnel rim so
 * froth seen edge-on catches the sky, and a small share of the same `glint`
 * the water already computes so wet foam sparkles instead of sitting matte.
 * At noon on a flat coast the three multiply out to within a few percent of
 * the old constant, which is what keeps this from being a coastline change.
 */
export const WATER_FOAM_TAIL: string[] = [
  '  float foamDiff = clamp(dot(N, sunDir), 0.0, 1.0);',
  '  vec3 foamLit = uFoamColor * mix(0.09, 0.52, lightAmt)',
  '               * (0.62 + 0.38 * foamDiff)',
  '               * (1.0 + 0.55 * fres)',
  '               * mix(vec3(1.0), uSunColor, 0.30);',
  '  foamLit += uSunColor * glint * uSpecStrength * 0.35;',
  '  col = mix(col, foamLit, clamp(foam, 0.0, 1.0) * 0.85);',
];

/*
 * --- hook: `colour` ---------------------------------------------------------
 * Runs after WATER_FOAM_TAIL, before `applyAerial` and the sRGB encode
 * (WATER_OUTPUT).
 * In scope, may be modified: `col`.
 * Read only: everything above -- `n`, `N`, `vWorldPos`, `sunDir`, `lightAmt`,
 * `depth`, `inland`, `foam`, etc.
 *
 * `water.ts` calls `applyAerial(col, vWorldPos, cameraPosition, sunDir,
 * uDayFactor)` right after any plugin colour hooks, so plugin tints (a neon
 * streak, a wake's cold glow) are part of the surface colour the aerial haze
 * is then applied over -- not the other way round.
 */

/**
 * Manual linear -> sRGB encode, and the end of `main()`.
 *
 * The dither (Stream E, docs/RENDER_PLAN.md Phase 1) is what kills the
 * concentric rings on smooth colour ramps (the deep-water gradient here, the
 * atmosphere shell in `sky.ts`) once they hit the composer's 8-bit target.
 * The target stays RGBA8 by deliberate choice -- multisampled half float is
 * not renderable on every GPU, see ARCHITECTURE's Post-processing section --
 * so the fix is noise, not more bits: a hash of the screen position gives
 * every pixel an independent ±0.5/255 offset, applied to the linear colour
 * before this encode, so the banding breaks up into dither too fine to see
 * instead of a visible step.
 */
export const WATER_OUTPUT: string[] = [
  '',
  '  float ditherAmt = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;',
  '  // Manual linear -> sRGB. ShaderMaterial output is not converted for us,',
  '  // so without this the ocean sits a stop darker than the land beside it.',
  '  col = max(col + ditherAmt, vec3(0.0));',
  '  gl_FragColor = vec4(pow(col, vec3(0.4545454545)), 1.0);',
  '}',
];
