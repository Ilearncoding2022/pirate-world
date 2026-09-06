import * as THREE from 'three';
import type { Terrain } from './types';
import type { WorldEnv } from './env';
import type { HeightMap } from './heightmap';
import { HEIGHTMAP_GLSL } from './heightmap';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS } from './geo';
import type { WindState } from './types';
import { OCEAN_CAP } from './wind';

export interface Water {
  mesh: THREE.Mesh;
  update(dt: number, env: WorldEnv, wind: WindState): void;
}

/* ------------------------------------------------------------------ */
/* Sea surface, authored in world units                                */
/* ------------------------------------------------------------------ */

/*
 * The shader samples noise over the unit direction, so its frequencies are in
 * units of 1/radian and its drifts in direction-units per second -- neither of
 * which means anything next to a hull. Both are therefore authored here as the
 * world-unit sizes and speeds actually wanted and converted below.
 *
 * That conversion is the only reason the sea still looks like the sea after
 * GLOBE_RADIUS doubled: hard-coded 1/radian frequencies would have doubled
 * every wavelength along with the globe, leaving the ship sailing through
 * swell twice its own length.
 */

/** Wavelengths in world units. The ship is ~5.6 long, so WAVE is hull sized. */
const SWELL_WAVELENGTH = 22;
const WAVE_WAVELENGTH = 5.9;
const CHOP_WAVELENGTH = 1.7;

/**
 * Drift of each layer ALONG THE WIND, world units per second at OCEAN_CAP.
 *
 * These were three fixed world-space vectors, each pointing somewhere
 * arbitrary, and their magnitudes (1.74, 1.78, 1.88) are what these numbers
 * are built around -- a full gale now runs the sea about as fast as the old
 * constants did, so the look at the top of the range is the look that was
 * already tuned.
 *
 * They differ from each other because the layers should not travel as one
 * sheet: chop skitters ahead of the swell it rides on, which is what stops a
 * single direction from reading as a texture being slid across the globe.
 */
const SWELL_SPEED = 1.5;
const WAVE_SPEED = 1.9;
const CHOP_SPEED = 2.4;

/**
 * Fraction of that drift still running in a dead calm.
 *
 * Calms last 3 to 15 seconds (`wind.ts`), which is far too long to look at a
 * sea that has stopped dead: still water is a mirror, and a mirror reads as a
 * bug rather than as weather. The residue keeps the old swell barely moving on
 * the last bearing the wind held -- which is what a real sea does, since swell
 * outlives the wind that raised it.
 */
const CALM_DRIFT = 0.2;

/**
 * Wave height in a dead calm, as a fraction of the height at OCEAN_CAP.
 *
 * The brief was intensity proportional to the SQUARE of the wind speed, and
 * between this floor and 1 that is exactly what happens. The floor itself is
 * the same argument as CALM_DRIFT: strict proportionality puts a plate of
 * glass around the ship for up to fifteen seconds at a time. Set it to 0 for
 * the letter of the rule and a sea that vanishes between gusts.
 */
const CALM_INTENSITY = 0.16;

/** Coastal foam: wavelength in world units, drift in world units per second. */
const FOAM_COARSE_WAVELENGTH = 4.55;
const FOAM_COARSE_DRIFT: [number, number, number] = [1.0, 0.0, -0.8];
const FOAM_SPECK_WAVELENGTH = 0.85;
const FOAM_SPECK_DRIFT: [number, number, number] = [0.0, 3.0, 1.6];

/**
 * Step used for the finite difference that reconstructs the wave normal, in
 * world units. Held at a fixed fraction of the shortest wavelength so the
 * gradient -- and therefore the surface tilt -- is identical at any radius.
 */
const NORMAL_STEP = 0.16;

/** Frequency in 1/radian for a wavelength given in world units. */
function freq(wavelengthWorld: number): string {
  return (GLOBE_RADIUS / wavelengthWorld).toFixed(4);
}

/** Direction-space drift vector for a speed given in world units per second. */
function drift(speedWorld: [number, number, number]): string {
  const [x, y, z] = speedWorld.map((v) => (v / GLOBE_RADIUS).toFixed(7));
  return `vec3(${x}, ${y}, ${z})`;
}

/**
 * Surface motion on unreachable inland water, as a fraction of the open sea:
 * a 75% reduction. It scales the wave field's drift and its ripple height
 * together, which is what separates "a pond" from "the ocean in slow motion".
 */
const LAKE_CALM = 0.25;

/**
 * Ashima / Stefan Gustavson 3D simplex noise, inlined.
 *
 * Everything in this file is procedural: no textures, no extra dependency. The
 * noise is sampled from the 3D surface direction rather than from UVs, so the
 * pattern has no seam at lon 180 and no pinching at the poles.
 */
const NOISE_GLSL = [
  'vec3 wMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
  'vec4 wMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
  'vec4 wPermute(vec4 x) { return wMod289(((x * 34.0) + 1.0) * x); }',
  'vec4 wTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }',
  'float snoise(vec3 v) {',
  '  const vec2 C = vec2(0.16666666666, 0.33333333333);',
  '  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);',
  '  vec3 i  = floor(v + dot(v, C.yyy));',
  '  vec3 x0 = v - i + dot(i, C.xxx);',
  '  vec3 g = step(x0.yzx, x0.xyz);',
  '  vec3 l = 1.0 - g;',
  '  vec3 i1 = min(g.xyz, l.zxy);',
  '  vec3 i2 = max(g.xyz, l.zxy);',
  '  vec3 x1 = x0 - i1 + C.xxx;',
  '  vec3 x2 = x0 - i2 + C.yyy;',
  '  vec3 x3 = x0 - D.yyy;',
  '  i = wMod289(i);',
  '  vec4 p = wPermute(wPermute(wPermute(',
  '             i.z + vec4(0.0, i1.z, i2.z, 1.0))',
  '           + i.y + vec4(0.0, i1.y, i2.y, 1.0))',
  '           + i.x + vec4(0.0, i1.x, i2.x, 1.0));',
  '  float n_ = 0.142857142857;',
  '  vec3 ns = n_ * D.wyz - D.xzx;',
  '  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);',
  '  vec4 x_ = floor(j * ns.z);',
  '  vec4 y_ = floor(j - 7.0 * x_);',
  '  vec4 x = x_ * ns.x + ns.yyyy;',
  '  vec4 y = y_ * ns.x + ns.yyyy;',
  '  vec4 h = 1.0 - abs(x) - abs(y);',
  '  vec4 b0 = vec4(x.xy, y.xy);',
  '  vec4 b1 = vec4(x.zw, y.zw);',
  '  vec4 s0 = floor(b0) * 2.0 + 1.0;',
  '  vec4 s1 = floor(b1) * 2.0 + 1.0;',
  '  vec4 sh = -step(h, vec4(0.0));',
  '  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;',
  '  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;',
  '  vec3 p0 = vec3(a0.xy, h.x);',
  '  vec3 p1 = vec3(a0.zw, h.y);',
  '  vec3 p2 = vec3(a1.xy, h.z);',
  '  vec3 p3 = vec3(a1.zw, h.w);',
  '  vec4 norm = wTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));',
  '  p0 *= norm.x;',
  '  p1 *= norm.y;',
  '  p2 *= norm.z;',
  '  p3 *= norm.w;',
  '  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);',
  '  m = m * m;',
  '  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));',
  '}',
].join('\n');

/**
 * Water surface: one full sphere at exactly GLOBE_RADIUS.
 *
 * Land sits above it and hides the parts that are dry, so this mesh stays
 * low-poly and smooth. Every bit of surface detail — waves, glint, shallows and
 * surf — is computed per pixel; the geometry only has to be round.
 *
 * Layout of the fragment shader:
 *   1. three drifting simplex octaves make a height field over the sphere
 *      direction; three taps of it give a tangent-space gradient, which tilts
 *      the shading normal. High octaves fade out with camera distance so the
 *      whole planet does not boil into aliased noise.
 *   2. depth ramp from the shared height map, as before, plus a shallow-water
 *      caustic ripple driven by the same wave field.
 *   3. Blinn-Phong glint (sharp + wide lobe) against env.sunDirection, gated by
 *      Fresnel and by the geometric day/night term so it sweeps with the sun.
 *   4. a coastal foam band whose outer edge breathes on a per-place phase, with
 *      a breaker line running shoreward.
 *   5. the whole thing crossfades to a near-black ambient on the night side.
 *
 * Every one of those steps is then crossfaded against `waterbodies.ts`'s
 * inland mask, so lakes and landlocked seas -- water the ship can never sail
 * to -- come out green, glassy and nearly still instead of reading as more
 * ocean. See LAKE_CALM for what "nearly still" means numerically.
 */
export function createWater(
  terrain: Terrain,
  heightMap: HeightMap,
  waterBodies: WaterBodies,
): Water {
  // Detail is fragment-side; the geometry only needs a smooth silhouette.
  // Segment counts track the radius: the chords have to sag less than
  // `wake.ts`'s SURFACE_LIFT clears, and the silhouette has to stay round.
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 256, 128);

  const uniforms = {
    uHeightMap: { value: heightMap.texture },
    uInlandMask: { value: waterBodies.texture },
    uSeaLevel: { value: terrain.seaLevel },
    uTime: { value: 0 },
    uDayFactor: { value: 1 },
    uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
    uSunColor: { value: new THREE.Color('#fff2d6') },
    /*
     * Depth palette, re-authored for the sRGB encode at the end of the shader.
     *
     * The flat baseline wrote linear values straight out (Three does not
     * colour-manage raw ShaderMaterial output, and postfx deliberately keeps
     * that behaviour), so its '#48e0d0' etc. actually reached the screen as the
     * much darker linear triples. These hexes ARE those darker presented
     * colours, so the encoded result lands back on the approved look: luminous
     * shelf at the coast, genuinely dark navy offshore.
     */
    uShallow: { value: new THREE.Color('#1fd0b4') },
    uShelf: { value: new THREE.Color('#0a6b78') },
    uOcean: { value: new THREE.Color('#04243a') },
    uDeep: { value: new THREE.Color('#02101c') },
    uAbyss: { value: new THREE.Color('#01070c') },
    /*
     * Fresh water, in the same presented-colour space as the ocean ramp above.
     * Deliberately green rather than cyan: it is the one cue that reads as
     * "lake" at a glance, from the deck and from orbit alike. The ramp is also
     * far shorter than the ocean's -- a pond bottoms out at pond colour rather
     * than running on down to abyssal navy.
     */
    uLakeShallow: { value: new THREE.Color('#46ad84') },
    uLakeDeep: { value: new THREE.Color('#0e3b35') },
    /** How far below sea level an inland body reaches its deepest colour. */
    uLakeDepthRange: { value: 0.22 },
    /** Wave drift and ripple height on inland water, as a fraction of the sea. */
    uLakeCalm: { value: LAKE_CALM },
    // Surf and reflected sky.
    uFoamColor: { value: new THREE.Color('#e8fbff') },
    uSkyColor: { value: new THREE.Color('#3d74b4') },
    uHorizonColor: { value: new THREE.Color('#7ba4d4') },
    /*
     * Where each wave layer has drifted to, in direction space.
     *
     * A POSITION, accumulated on the CPU below, and not a velocity multiplied
     * by uTime the way it used to be. That distinction is the whole reason the
     * wind can steer the sea at all: with `offset = drift * t`, changing the
     * drift changes where the field has always been, so every shift of the
     * wind would teleport the ocean by minutes of travel. Integrating instead
     * means a change of wind changes only where the sea goes NEXT.
     */
    uOffsetSwell: { value: new THREE.Vector3() },
    uOffsetWave: { value: new THREE.Vector3() },
    uOffsetChop: { value: new THREE.Vector3() },
    /** Wave height now, as a fraction of the height at a full gale. */
    uWaveIntensity: { value: CALM_INTENSITY },
    // Surface tuning.
    uWaveStrength: { value: 4.4 },
    uSpecPower: { value: 300 },
    uSpecStrength: { value: 1.1 },
    uFoamWidth: { value: 0.024 },
  };

  const vertexShader = [
    'varying vec3 vDir;',
    'varying vec3 vWorldPos;',
    'void main() {',
    '  vDir = normalize(position);',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vWorldPos = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}',
  ].join('\n');

  const fragmentShader = [
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
    NOISE_GLSL,
    HEIGHTMAP_GLSL,
    // Derived from the world-unit wavelengths and speeds at the top of the
    // file; see the note there for why they are not written literally.
    `const float FREQ_SWELL = ${freq(SWELL_WAVELENGTH)};`,
    `const float FREQ_WAVE = ${freq(WAVE_WAVELENGTH)};`,
    `const float FREQ_CHOP = ${freq(CHOP_WAVELENGTH)};`,

    // Two fixed world axes the noise domain is stretched along. A plain 3x3
    // scale is continuous over the whole sphere, so unlike a tangent-frame
    // stretch it introduces no pole singularity, and the two axes crossing
    // makes the crests read as two interfering wave trains. Both are unit.
    'const vec3 AXIS_WAVE = vec3(0.42, 0.78, -0.46);',
    'const vec3 AXIS_CHOP = vec3(-0.71, 0.35, 0.61);',
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
    `  const float EPS = ${(NORMAL_STEP / GLOBE_RADIUS).toFixed(8)};`,
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
    '',
    '  // ---- coastal foam ----------------------------------------------------',
    '  float fd = depth / max(uFoamWidth, 1e-4);',
    '  if (fd < 2.6) {',
    '    // The fine speckle has to fade with distance like the wave chop does,',
    '    // or a coastline seen from far off stipples instead of foaming.',
    '    float foamNear = 1.0 - smoothstep(42.0, 92.0, camDist);',
    '    float foamLod = foamNear * mix(0.35, 1.0, lod);',
    `    float coarse = snoise(n * ${freq(FOAM_COARSE_WAVELENGTH)} + ${drift(FOAM_COARSE_DRIFT)} * lakeTime);`,
    `    float speck = snoise(n * ${freq(FOAM_SPECK_WAVELENGTH)} + ${drift(FOAM_SPECK_DRIFT)} * lakeTime) * foamLod;`,
    '    // Per-place phase, so the whole coastline does not pulse in unison.',
    '    float swell = 0.5 + 0.5 * sin(coarse * 3.4 + lakeTime * 1.25);',
    '    float outer = 0.22 + 0.55 * swell + speck * 0.28;',
    '    float band = 1.0 - smoothstep(outer * 0.30, outer, fd);',
    '    // A breaker line running shoreward and dying as it lands.',
    '    float run = fract(lakeTime * 0.19 + coarse * 0.5);',
    '    float lineAt = 1.70 - 1.55 * run;',
    '    float dl = (fd - lineAt) / 0.22;',
    '    float breaker = exp(-dl * dl) * (0.30 + 0.70 * run);',
    '    float foam = clamp(band + breaker * 0.85, 0.0, 1.0);',
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
    '    vec3 foamLit = uFoamColor * mix(0.09, 0.52, lightAmt) * mix(vec3(1.0), uSunColor, 0.30);',
    '    col = mix(col, foamLit, clamp(foam, 0.0, 1.0) * 0.85);',
    '  }',
    '',
    '  // Manual linear -> sRGB. ShaderMaterial output is not converted for us,',
    '  // so without this the ocean sits a stop darker than the land beside it.',
    '  col = max(col, vec3(0.0));',
    '  gl_FragColor = vec4(pow(col, vec3(0.4545454545)), 1.0);',
    '}',
  ].join('\n');

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water';
  mesh.renderOrder = -1;

  return {
    mesh,
    update(dt: number, env: WorldEnv, wind: WindState): void {
      uniforms.uTime.value = env.elapsed;
      uniforms.uDayFactor.value = env.dayFactor;
      uniforms.uSunDirection.value.copy(env.sunDirection);
      uniforms.uSunColor.value.copy(env.sunColor);

      /*
       * The wind, integrated into the sea.
       *
       * `strength` is the wind as a fraction of the strongest the world blows,
       * which is the same OCEAN_CAP the radar arrow scales its length by -- so
       * a full-length arrow and a full sea arrive together rather than one of
       * them topping out first.
       *
       * Height goes as the SQUARE of it and drift goes linearly, which is the
       * asymmetry that makes weather read: a freshening wind lengthens the
       * swell noticeably before it starts throwing it about, and the last
       * quarter of the range is where most of the height lives.
       */
      const strength = Math.min(1, Math.max(0, wind.speed / OCEAN_CAP));
      uniforms.uWaveIntensity.value =
        CALM_INTENSITY + (1 - CALM_INTENSITY) * strength * strength;

      // Integrate, never multiply by elapsed time: see uOffsetSwell. `dir`
      // holds its last bearing through a calm, so the residual swell keeps
      // running the way the wind that raised it was going.
      const flow = CALM_DRIFT + (1 - CALM_DRIFT) * strength;
      const step = (dt * flow) / GLOBE_RADIUS;
      const dir = wind.direction;
      uniforms.uOffsetSwell.value.addScaledVector(dir, SWELL_SPEED * step);
      uniforms.uOffsetWave.value.addScaledVector(dir, WAVE_SPEED * step);
      uniforms.uOffsetChop.value.addScaledVector(dir, CHOP_SPEED * step);
    },
  };
}
