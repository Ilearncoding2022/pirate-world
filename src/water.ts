import * as THREE from 'three';
import type { Terrain } from './types';
import type { WorldEnv } from './env';
import type { HeightMap } from './heightmap';
import { HEIGHTMAP_GLSL } from './heightmap';
import { GLOBE_RADIUS } from './geo';

export interface Water {
  mesh: THREE.Mesh;
  update(dt: number, env: WorldEnv): void;
}

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
 */
export function createWater(terrain: Terrain, heightMap: HeightMap): Water {
  // Detail is fragment-side; the geometry only needs a smooth silhouette.
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 192, 96);

  const uniforms = {
    uHeightMap: { value: heightMap.texture },
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
    // Surf and reflected sky.
    uFoamColor: { value: new THREE.Color('#e8fbff') },
    uSkyColor: { value: new THREE.Color('#3d74b4') },
    uHorizonColor: { value: new THREE.Color('#7ba4d4') },
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
    'uniform vec3 uFoamColor;',
    'uniform vec3 uSkyColor;',
    'uniform vec3 uHorizonColor;',
    'uniform float uWaveStrength;',
    'uniform float uSpecPower;',
    'uniform float uSpecStrength;',
    'uniform float uFoamWidth;',
    'varying vec3 vDir;',
    'varying vec3 vWorldPos;',
    NOISE_GLSL,
    HEIGHTMAP_GLSL,
    // Frequencies are in units of 1/radian, so a feature spans about
    // GLOBE_RADIUS / FREQ world units: 22, 5.9 and 1.7 respectively. The ship
    // is ~5.6 units long, so the middle layer is roughly hull-sized.
    'const float FREQ_SWELL = 4.5;',
    'const float FREQ_WAVE = 17.0;',
    'const float FREQ_CHOP = 58.0;',
    // Drifts are in direction-units per second; times GLOBE_RADIUS that is
    // about 1.3 to 1.9 world units per second, in three different directions.
    'const vec3 DRIFT_SWELL = vec3(0.0130, 0.0060, -0.0100);',
    'const vec3 DRIFT_WAVE = vec3(-0.0090, 0.0140, 0.0070);',
    'const vec3 DRIFT_CHOP = vec3(0.0060, -0.0050, 0.0170);',
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
    'float waveField(vec3 p, float mid, float fine) {',
    '  // Swell: smooth, long undulation. The two layers above it are ridged,',
    '  // which is what makes the glint run in streaks like real sun glitter.',
    '  float s = snoise((p + DRIFT_SWELL * uTime) * FREQ_SWELL) * 0.55;',
    '  vec3 pw = stretch((p + DRIFT_WAVE * uTime) * FREQ_WAVE, AXIS_WAVE, 1.7);',
    '  s += ridge(snoise(pw), mid) * 0.90 * mid;',
    '  if (fine > 0.004) {',
    '    vec3 pc = stretch((p + DRIFT_CHOP * uTime) * FREQ_CHOP, AXIS_CHOP, 1.3);',
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
    '  const float EPS = 0.0016;',
    '  float w0 = waveField(n, fadeMid, fadeFine);',
    '  float wu = waveField(n + tanU * EPS, fadeMid, fadeFine);',
    '  float wv = waveField(n + tanV * EPS, fadeMid, fadeFine);',
    '  // Flatten the surface as it recedes, so the ocean reads calm from orbit',
    '  // rather than blotchy.',
    '  float tilt = uWaveStrength * mix(0.22, 1.0, nearMid);',
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
    '  // Shallows keep their glow and pick up a moving caustic ripple, which is',
    '  // what reads as translucency over a sandy bottom.',
    '  float shallowMask = 1.0 - smoothstep(0.0, 0.15, depth);',
    '  base *= 1.0 + shallowMask * w0 * 0.30;',
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
    '    float coarse = snoise(n * 22.0 + vec3(uTime * 0.010, 0.0, uTime * -0.008));',
    '    float speck = snoise(n * 118.0 + vec3(0.0, uTime * 0.030, uTime * 0.016)) * foamLod;',
    '    // Per-place phase, so the whole coastline does not pulse in unison.',
    '    float swell = 0.5 + 0.5 * sin(coarse * 3.4 + uTime * 1.25);',
    '    float outer = 0.22 + 0.55 * swell + speck * 0.28;',
    '    float band = 1.0 - smoothstep(outer * 0.30, outer, fd);',
    '    // A breaker line running shoreward and dying as it lands.',
    '    float run = fract(uTime * 0.19 + coarse * 0.5);',
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
    update(_dt: number, env: WorldEnv): void {
      uniforms.uTime.value = env.elapsed;
      uniforms.uDayFactor.value = env.dayFactor;
      uniforms.uSunDirection.value.copy(env.sunDirection);
      uniforms.uSunColor.value.copy(env.sunColor);
    },
  };
}
