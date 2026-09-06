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
 *   waterDepth(...)                    -- opens main(), builds N
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
 * Opens `main()`: view/sun setup, the inland/motion blend, the LOD fades, the
 * tangent basis, the wave-field sample and its finite-difference normal `N`,
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
 * `lod`, `nearMid`, `tanU`, `tanV`, `wu`, `wv`, `tilt`.)
 */
export function waterDepth(eps: string): string[] {
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
    '  // Poor-man LOD. A pixel covers more surface both with distance and at',
    '  // grazing angles, so fade the high octaves out on both counts; without',
    '  // the grazing term the water near the horizon crawls with moire.',
    '  float graze = clamp(dot(n, viewDir), 0.0, 1.0);',
    '  float lod = smoothstep(0.06, 0.38, graze);',
    '  float nearMid = 1.0 - smoothstep(50.0, 105.0, camDist);',
    '  float fadeMid = nearMid * mix(0.30, 1.0, lod);',
    '  float fadeFine = (1.0 - smoothstep(28.0, 80.0, camDist)) * lod;',
    '',
    '  // Tangent basis for the finite difference. The reconstructed normal is',
    '  // the tangential gradient, which is basis independent, so swapping the',
    '  // reference axis near the poles does not show up as a seam.',
    '  vec3 ref = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), step(0.95, abs(n.y)));',
    '  vec3 tanU = normalize(cross(ref, n));',
    '  vec3 tanV = cross(n, tanU);',
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
    '  float tilt = uWaveStrength * uWaveIntensity * mix(0.22, 1.0, nearMid) * motion;',
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
  '  float sunGeo = dot(n, sunDir);',
  '  float lightAmt = smoothstep(-0.17, 0.22, sunGeo);',
  '  // Diffuse uses a half-strength normal: the full one makes the body',
  '  // colour crawl with the chop. The specular keeps the full normal.',
  '  vec3 diffN = normalize(mix(n, N, 0.45));',
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

/** Second half of the lighting chunk: specular, then the day/night mix. */
export const WATER_LIGHTING_TAIL: string[] = [
  '',
  '  vec3 halfVec = normalize(sunDir + viewDir);',
  '  float nh = clamp(dot(N, halfVec), 0.0, 1.0);',
  '  // Distance doubles as roughness: close up the water is choppy and the',
  '  // highlight is broad and sparkly; from orbit it is a mirror, so the sun',
  '  // reflection has to tighten to a small spot instead of a white continent.',
  '  float rough = mix(0.28, 1.0, nearMid);',
  '  float specPow = uSpecPower / rough;',
  '  float glintSharp = pow(nh, specPow);',
  '  float glintWide = pow(nh, specPow * 0.14) * rough;',
  '  // Gate on the SMOOTH normal too, so the sparkle gathers into a sun road',
  '  // around the mirror direction instead of covering the whole ocean.',
  '  float road = pow(clamp(dot(n, halfVec), 0.0, 1.0), 10.0 / rough);',
  '  float glint = (glintSharp + glintWide * 0.045) * lightAmt',
  '              * (0.30 + 0.70 * fres) * (0.08 + 0.92 * road);',
  '',
  '  vec3 dayCol = base * (0.20 + 0.72 * diff) * sunTint;',
  '  dayCol += skyCol * fres * 0.085;',
  '  vec3 nightCol = mix(base, uAbyss, 0.60) * 0.075 + skyCol * fres * 0.015;',
  '  vec3 col = mix(nightCol, dayCol, lightAmt);',
  '  col += uSunColor * glint * uSpecStrength;',
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

/** Lights the foam mask and mixes it into `col`. */
export const WATER_FOAM_TAIL: string[] = [
  '  vec3 foamLit = uFoamColor * mix(0.09, 0.52, lightAmt) * mix(vec3(1.0), uSunColor, 0.30);',
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

/** Manual linear -> sRGB encode, and the end of `main()`. */
export const WATER_OUTPUT: string[] = [
  '',
  '  // Manual linear -> sRGB. ShaderMaterial output is not converted for us,',
  '  // so without this the ocean sits a stop darker than the land beside it.',
  '  col = max(col, vec3(0.0));',
  '  gl_FragColor = vec4(pow(col, vec3(0.4545454545)), 1.0);',
  '}',
];
