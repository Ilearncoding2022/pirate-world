import * as THREE from 'three';
import type { WorldEnv } from './env';
import { GLOBE_RADIUS } from './geo';

export interface Clouds {
  object: THREE.Object3D;
  update(dt: number, env: WorldEnv): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * Shell radius as a multiple of GLOBE_RADIUS.
 *
 * Above the water (1.0) and above all but the very highest summits: `land.ts`
 * tops out at 1 + (COAST_LIFT + MAX_LAND_RELIEF) / GLOBE_RADIUS = 1.0512, but
 * relief is eased so only the rare interior peak gets near that. Well inside
 * the atmosphere shell `sky.ts` puts at 1.055. Land is opaque and drawn in the
 * opaque pass, so a summit that does reach through simply punches a hole in
 * the layer, which reads correctly.
 */
const SHELL_SCALE = 1.03;

/** Bulk drift of the whole layer, radians/second. ~8.7 minutes per rotation. */
const SPIN_RATE = 0.012;

/** Tilted off +Y so the drift is not purely zonal and the poles keep moving. */
const SPIN_AXIS = new THREE.Vector3(0.17, 1.0, -0.11).normalize();

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

/**
 * Simplex 3D noise (Ashima Arts / Stefan Gustavson, public domain).
 *
 * Sampled from the unit direction vector, so the field is continuous over the
 * whole sphere: no UV seam and no pole pinching.
 */
const SIMPLEX_GLSL = [
  'vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
  'vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
  'vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }',
  'vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }',
  'float snoise(vec3 v) {',
  '  const vec2 C = vec2(0.166666666666666667, 0.333333333333333333);',
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
  '  i = mod289(i);',
  '  vec4 p = permute(permute(permute(',
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
  '  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));',
  '  p0 *= norm.x;',
  '  p1 *= norm.y;',
  '  p2 *= norm.z;',
  '  p3 *= norm.w;',
  '  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);',
  '  m = m * m;',
  '  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));',
  '}',
].join('\n');

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

const VERTEX_SHADER = [
  // Object space direction drives the noise, so the pattern is painted on the
  // shell and rides its rotation. World space drives lighting and camera fade.
  'varying vec3 vObjDir;',
  'varying vec3 vWorldPos;',
  'void main() {',
  '  vObjDir = normalize(position);',
  '  vec4 wp = modelMatrix * vec4(position, 1.0);',
  '  vWorldPos = wp.xyz;',
  '  gl_Position = projectionMatrix * viewMatrix * wp;',
  '}',
].join('\n');

const FRAGMENT_SHADER = [
  'uniform float uTime;',
  'uniform vec3 uSunDirection;',
  'uniform vec3 uSunColor;',
  'uniform vec3 uDayColor;',
  'uniform vec3 uShadowColor;',
  'uniform vec3 uNightColor;',
  'uniform vec3 uSunsetColor;',
  'uniform float uScale;',
  'uniform float uWarp;',
  'uniform float uThreshold;',
  'uniform float uSoft;',
  'uniform float uBand;',
  'uniform float uWisp;',
  'uniform float uOpacity;',
  'uniform float uShadowStep;',
  'uniform float uShadowMix;',
  'uniform float uRelief;',
  'uniform float uGraze;',
  'uniform float uSilver;',
  'uniform float uFadeNear;',
  'uniform float uFadeFar;',
  'varying vec3 vObjDir;',
  'varying vec3 vWorldPos;',
  SIMPLEX_GLSL,
  // Each octave slides through the noise field along its own direction. That
  // decorrelates the layers over time, so banks grow and dissolve instead of
  // the whole pattern sliding past as one rigid painted sphere.
  'const vec3 DRIFT0 = vec3( 0.0071,  0.0052, -0.0064);',
  'const vec3 DRIFT1 = vec3(-0.0128,  0.0097,  0.0081);',
  'const vec3 DRIFT2 = vec3( 0.0193, -0.0166,  0.0142);',
  'const vec3 DRIFT3 = vec3(-0.0281,  0.0224, -0.0247);',
  'const vec3 DRIFT4 = vec3( 0.0362, -0.0298,  0.0331);',
  'const vec3 DRIFT5 = vec3(-0.0455,  0.0409,  0.0376);',
  'const vec3 WARP_DRIFT = vec3(0.0044, -0.0061, 0.0038);',
  'void main() {',
  '  vec3 nWorld = normalize(vWorldPos);',
  '  vec3 viewDir = normalize(vWorldPos - cameraPosition);',
  '  float t = uTime;',
  '  vec3 p = vObjDir * uScale;',
  // Domain warp: bends cloud edges into wisps and hooks.
  '  float w1 = snoise(p * 1.63 + vec3( 4.7, 1.3, 8.9) + WARP_DRIFT * t);',
  '  float w2 = snoise(p * 1.63 + vec3(-3.1, 6.2, 2.4) - WARP_DRIFT * t);',
  '  vec3 q = p + uWarp * vec3(w1, w2, 0.5 * (w1 - w2));',
  // Coverage threshold, gently banded by latitude like real weather.
  '  float thr = uThreshold + uBand * sin(nWorld.y * 6.5 + 0.7);',
  // Two cheap octaves first, so open sky costs almost nothing.
  '  float a0 = snoise(q * 1.00 + DRIFT0 * t);',
  '  float a1 = snoise(q * 2.03 + DRIFT1 * t);',
  '  float partial = 0.5 * a0 + 0.25 * a1;',
  '  float best = ((partial + 0.1875) / 0.9375) * 0.5 + 0.5 + uWisp;',
  '  if (best < thr) discard;',
  // Full fractal density.
  '  float a2 = snoise(q * 4.11 + DRIFT2 * t);',
  '  float a3 = snoise(q * 8.07 + DRIFT3 * t);',
  '  float f = (partial + 0.125 * a2 + 0.0625 * a3) / 0.9375;',
  '  float density = f * 0.5 + 0.5;',
  // High frequency erosion. Only bites near the threshold, which is exactly
  // where the ragged edges belong.
  '  float e1 = snoise(q * 6.0 + DRIFT4 * t);',
  '  float e2 = snoise(q * 12.5 + DRIFT5 * t);',
  '  density += uWisp * (0.62 * e1 + 0.38 * e2);',
  // A narrow ramp keeps most of the sphere either solidly clouded or open sky
  // rather than one continent-wide veil. `deep` measures how far inside a bank
  // this pixel sits, so cores can shade differently from the thin skirts.
  '  float cov = smoothstep(thr, thr + uSoft, density);',
  '  if (cov <= 0.002) discard;',
  '  float deep = smoothstep(thr, thr + 0.28, density);',
  // Fake self shadowing. Probe the same two octaves a short step toward the
  // sun and compare: denser here than sunward means this face is turned into
  // the light, thinner here means it sits in a neighbour's lee. The signed
  // difference follows the fractal structure, so whole banks get relief
  // instead of one flat wash of shadow.
  '  float sunDot = dot(nWorld, uSunDirection);',
  '  vec3 st = uSunDirection - nWorld * sunDot;',
  '  vec3 sunTan = st / max(length(st), 1e-4);',
  '  vec3 sq = q + sunTan * uShadowStep;',
  '  float here = partial / 0.75;',
  '  float sunward = (0.5 * snoise(sq + DRIFT0 * t) + 0.25 * snoise(sq * 2.03 + DRIFT1 * t)) / 0.75;',
  '  float relief = clamp((here - sunward) * uRelief, -1.0, 1.0);',
  '  float shadow = clamp(-relief, 0.0, 1.0) * mix(0.45, 1.0, deep);',
  // Colour: warm lit tops, blue-grey lee sides, soft terminator, dark night.
  '  vec3 sunTint = mix(vec3(1.0), uSunColor, 0.42);',
  '  vec3 litCol = mix(uDayColor, uShadowColor, shadow * uShadowMix) * sunTint;',
  '  float twilight = 1.0 - smoothstep(0.0, 0.30, abs(sunDot));',
  '  litCol = mix(litCol, litCol * uSunsetColor * 1.12, twilight * 0.45);',
  '  float lit = smoothstep(-0.26, 0.20, sunDot);',
  // Night: dim, but shaped enough to read as cloud rather than a hole.
  '  vec3 nightCol = uNightColor * (0.78 + 0.42 * clamp(relief, 0.0, 1.0));',
  '  vec3 col = mix(nightCol, litCol, lit);',
  // Silver lining: thin edges glow when the sun sits behind them.
  '  float edge = clamp(cov * (1.0 - deep) * 1.6, 0.0, 1.0);',
  '  float forward = clamp(dot(viewDir, uSunDirection), 0.0, 1.0);',
  '  col += uSunColor * (pow(forward, 6.0) * edge * lit * uSilver);',
  // Alpha. Thicker seen edge on, and faded out close to the camera so the
  // layer never fogs the chase view around the ship.
  '  float graze = 1.0 - abs(dot(nWorld, viewDir));',
  '  float thickness = mix(1.0, uGraze, graze * graze);',
  '  float camDist = length(vWorldPos - cameraPosition);',
  '  float alpha = clamp(cov * uOpacity * thickness, 0.0, 1.0);',
  '  alpha *= smoothstep(uFadeNear, uFadeFar, camDist);',
  '  if (alpha < 0.004) discard;',
  '  gl_FragColor = vec4(col, alpha);',
  '}',
].join('\n');

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Translucent cloud shell.
 *
 * A single sphere just above the surface carrying an animated fractal density
 * field. Coverage is thresholded with a soft edge so most of the globe stays
 * open sky and the clouds gather into recognisable banks, then lit from
 * `env.sunDirection` so tops catch warm light and the night side goes dark
 * without disappearing.
 *
 * Only the near hemisphere is drawn (`FrontSide`), so the far side of the
 * shell can never blend over the near side.
 */
export function createClouds(): Clouds {
  const object = new THREE.Group();
  object.name = 'clouds';

  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS * SHELL_SCALE, 128, 64);

  const uniforms = {
    uTime: { value: 0 },
    uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
    uSunColor: { value: new THREE.Color('#fff2d6') },
    uDayColor: { value: new THREE.Color('#eeece6') },
    uShadowColor: { value: new THREE.Color('#6f7d95') },
    uNightColor: { value: new THREE.Color('#262f3f') },
    uSunsetColor: { value: new THREE.Color('#ffb184') },
    /** Base noise frequency over the unit sphere. Higher = smaller systems. */
    uScale: { value: 2.5 },
    uWarp: { value: 0.28 },
    /** Density above this becomes cloud. Higher = more open sky. */
    uThreshold: { value: 0.556 },
    uSoft: { value: 0.1 },
    uBand: { value: 0.05 },
    uWisp: { value: 0.045 },
    uOpacity: { value: 0.96 },
    uShadowStep: { value: 0.22 },
    uShadowMix: { value: 0.7 },
    /** Gain on the sunward density difference that fakes cloud relief. */
    uRelief: { value: 4.0 },
    uGraze: { value: 1.25 },
    uSilver: { value: 0.5 },
    /** Camera distance fade, world units. Keeps the layer off the chase view. */
    uFadeNear: { value: 30 },
    uFadeFar: { value: 85 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
  });

  const shell = new THREE.Mesh(geometry, material);
  shell.name = 'cloud-shell';
  // After the opaque world and after any additive night side emissives, so the
  // layer occludes what sits beneath it.
  shell.renderOrder = 2;
  object.add(shell);

  return {
    object,
    update(_dt: number, env: WorldEnv): void {
      uniforms.uTime.value = env.elapsed;
      uniforms.uSunDirection.value.copy(env.sunDirection);
      uniforms.uSunColor.value.copy(env.sunColor);
      // Bulk drift, derived from elapsed so it never accumulates float error.
      object.setRotationFromAxisAngle(SPIN_AXIS, env.elapsed * SPIN_RATE);
    },
  };
}
