import * as THREE from 'three';
import type { WorldEnv } from './env';
import { GLOBE_RADIUS } from './geo';
import { LAYER_REFLECTED } from './layers';

export interface Sky {
  group: THREE.Group;
  update(dt: number, env: WorldEnv): void;
}

/**
 * Height of the rim glow shell, as a multiple of GLOBE_RADIUS.
 *
 * It has to sit above everything the world puts in the sky, or that thing
 * appears outside the planet's own air at the limb. The binding constraint is
 * the cloud deck in `clouds.ts`, which tops out at SHELL_BASE + SHELL_DEPTH =
 * 1.060; this clears it.
 */
const ATMOSPHERE_SCALE = 1.068;

/**
 * Base tint of the atmosphere shell, read by `fog.ts` (Stream E,
 * docs/RENDER_PLAN.md Phase 1) so the aerial-perspective haze fades toward
 * the same blue the limb glows, rather than an unrelated colour. A plain
 * constant rather than something read off the live uniform: the shell's own
 * tint never changes at runtime, only its intensity and its sunset warmth do,
 * both of which are `update()`'s job below.
 */
export const ATMOSPHERE_COLOR: Readonly<THREE.Color> = new THREE.Color('#4fbaff');

/** Fresnel rim glow shell around the planet. */
function buildAtmosphere(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS * ATMOSPHERE_SCALE, 96, 64);

  const vertexShader = [
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'varying vec3 vDir;',
    'void main() {',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  vNormalV = normalize(normalMatrix * normal);',
    '  vViewDir = normalize(-mvPosition.xyz);',
    '  vDir = normalize(position);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '}',
  ].join('\n');

  const fragmentShader = [
    'uniform vec3 uColor;',
    'uniform vec3 uSunsetColor;',
    'uniform vec3 uSunDirection;',
    'uniform float uIntensity;',
    'uniform float uPower;',
    'uniform float uGlobeRadius;',
    'uniform float uFadeLo;',
    'uniform float uFadeHi;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'varying vec3 vDir;',
    'void main() {',
    '  // BackSide normals point inward, so use the absolute dot to measure the rim.',
    '  float rim = 1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir)));',
    '  float glow = pow(clamp(rim, 0.0, 1.0), uPower) * uIntensity;',
    '  // Fade the glow out on the night side and warm it near the terminator.',
    '  float sun = dot(normalize(vDir), normalize(uSunDirection));',
    '  float lit = smoothstep(-0.35, 0.25, sun);',
    '  float rimWarm = 1.0 - smoothstep(0.0, 0.45, abs(sun));',
    '  vec3 tint = mix(uColor, uSunsetColor, rimWarm * 0.75);',
    '  glow *= mix(0.12, 1.0, lit);',
    '  // A limb is something you see from OUTSIDE an atmosphere. Standing',
    '  // under one, this shell is an additive band sitting exactly where the',
    '  // sky dome is brightest, and at noon the two summed past white and',
    '  // bleached the horizon. So it fades in as the dome fades out -- same',
    '  // two altitudes, opposite directions. Not to nothing: a quarter of it',
    '  // survives at deck level, which is what keeps the dawn band.',
    '  float altitude = length(cameraPosition) - uGlobeRadius;',
    '  glow *= mix(0.25, 1.0, smoothstep(uFadeLo, uFadeHi, altitude));',
    '  // Ordered/hash dither, ±0.5/255. The rim is a smooth exponential falloff',
    '  // written straight into the composer\'s 8-bit target (this material is',
    '  // hand-written and, unlike water.ts, was never gamma-encoded -- see',
    '  // ARCHITECTURE, Post-processing and colour management), so without this',
    '  // it quantizes into visible concentric rings instead of a smooth glow.',
    '  float ditherAmt = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;',
    '  gl_FragColor = vec4(tint * glow + ditherAmt, glow);',
    '}',
  ].join('\n');

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: ATMOSPHERE_COLOR.clone() },
      uSunsetColor: { value: new THREE.Color('#ff7a4f') },
      uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
      uIntensity: { value: 1.15 },
      uPower: { value: 3.0 },
      uGlobeRadius: { value: GLOBE_RADIUS },
      uFadeLo: { value: SKY_FADE_LO },
      uFadeHi: { value: SKY_FADE_HI },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atmosphere';
  // Docs/RENDER_PLAN.md Phase 1 Stream D: the sky shell is one of the four
  // things the water's reflection cube renders. Layer flag only -- Stream E
  // owns this file's shader body in parallel.
  mesh.layers.enable(LAYER_REFLECTED);
  return mesh;
}

/* ------------------------------------------------------------------ */
/* The sky itself                                                      */
/* ------------------------------------------------------------------ */

/**
 * Radius of the sky dome, world units.
 *
 * Three globe radii. The number only has to be big enough that the camera is
 * always INSIDE the dome, because the colour is a function of the view ray and
 * not of where that ray happens to meet the geometry. The furthest the chase
 * camera ever gets from the globe's centre is about 358 (`camera.ts`:
 * FAR_DISTANCE 0.9 R behind and FAR_HEIGHT 0.55 R above a ship already at R),
 * so 400 would clear it and 600 clears it without anyone having to redo that
 * arithmetic after the next tuning pass.
 */
const SKY_DOME_SCALE = 3.0;

/*
 * The palette. Five colours, and the two horizon entries are the ones `fog.ts`
 * also reads -- the sea has to fade into the same colour the sky above it is,
 * or the horizon shows a seam at dawn.
 */
const SKY_ZENITH_DAY = new THREE.Color('#2d6fc4');
const SKY_HORIZON_DAY = new THREE.Color('#6fa8d8');
const SKY_ZENITH_NIGHT = new THREE.Color('#06091a');
const SKY_HORIZON_NIGHT = new THREE.Color('#141c3a');
/** The warm lobe around a sun near the horizon. */
const SKY_DUSK_GLOW = new THREE.Color('#ff8a4a');

/**
 * How opaque the dome is at night.
 *
 * Not zero, and not one. A quarter leaves a deep navy veil that the stars and
 * the moon still show through, so night reads as a sky rather than as the
 * vacuum the game used to end at, without hiding the starfield the world has
 * always had.
 */
const SKY_NIGHT_OPACITY = 0.25;

/*
 * Camera altitudes, in world units above the surface, over which the sky
 * thins out to nothing.
 *
 * This is the one thing in the file that has to serve two views at once. From
 * the deck the player is under an atmosphere and there should be a sky; from
 * orbit they are looking at a planet in space and there should not be. The
 * chase camera is a continuous wheel between those, so the sky has to leave on
 * the way up rather than switch off. 15 is just above the deck camera's own
 * 9.5, and 60 is around half the zoom range.
 */
const SKY_FADE_LO = 15;
const SKY_FADE_HI = 60;

/**
 * The colour the horizon is right now, for `fog.ts`.
 *
 * Deliberately not a second copy of the shader's arithmetic: it is the same
 * two constants mixed by the same `env.dayFactor` the dome's `uDay` uniform is
 * fed from, so the haze the sea fades into cannot drift away from the sky it
 * is fading toward. Writes into `out` rather than allocating, since this runs
 * every frame.
 */
export function skyHorizonColor(env: WorldEnv, out: THREE.Color): THREE.Color {
  return out.copy(SKY_HORIZON_NIGHT).lerp(SKY_HORIZON_DAY, env.dayFactor);
}

const DOME_VERTEX = [
  'varying vec3 vWorldPos;',
  'void main() {',
  '  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}',
].join('\n');

const DOME_FRAGMENT = [
  'uniform vec3 uZenithDay;',
  'uniform vec3 uHorizonDay;',
  'uniform vec3 uZenithNight;',
  'uniform vec3 uHorizonNight;',
  'uniform vec3 uDuskGlow;',
  'uniform vec3 uSunDirection;',
  'uniform float uDay;',
  'uniform float uNightOpacity;',
  'uniform float uGlobeRadius;',
  'uniform float uFadeLo;',
  'uniform float uFadeHi;',
  'varying vec3 vWorldPos;',
  'void main() {',
  '  // Where the viewer is standing decides which way is up. On a globe that',
  '  // is not a constant, so the whole gradient is built off the camera.',
  '  vec3 zenith = normalize(cameraPosition);',
  '  vec3 ray = normalize(vWorldPos - cameraPosition);',
  '  float rayElev = dot(ray, zenith);',
  '',
  '  // Where the horizon actually IS, which on a globe this small is nowhere',
  '  // near eye level: standing 9.5 units above a radius-200 planet puts the',
  '  // limb about 17 degrees BELOW horizontal, and it drops further as the',
  '  // camera climbs. Every horizon effect below is measured from this rather',
  '  // than from rayElev = 0, which is open sky from any deck.',
  '  float camDist = max(length(cameraPosition), uGlobeRadius + 0.001);',
  '  float limbElev = -sqrt(max(0.0, 1.0 - (uGlobeRadius * uGlobeRadius) / (camDist * camDist)));',
  '  float aboveLimb = rayElev - limbElev;',
  '',
  '  // Blue overhead, pale at the horizon, and the whole ramp slides toward',
  '  // the night pair as the sun goes down.',
  '  vec3 horizon = mix(uHorizonNight, uHorizonDay, uDay);',
  '  vec3 zenithCol = mix(uZenithNight, uZenithDay, uDay);',
  '  vec3 col = mix(horizon, zenithCol, smoothstep(0.0, 0.55, aboveLimb));',
  '',
  '  // Twilight peaks when the sun is ON the horizon, which is exactly where',
  '  // uDay is halfway. Deriving it from uDay rather than from a second',
  '  // elevation ramp keeps the sky, the fog and the key light on one clock.',
  '  float twilight = 1.0 - abs(uDay * 2.0 - 1.0);',
  '  // Dawn and dusk come in two parts, and the broad one matters more.',
  '  // A sunrise warms the WHOLE horizon, not just the arc the sun is in --',
  '  // that band used to come from the atmosphere shell, which is an orbital',
  '  // effect and had to be turned down at deck level to stop it bleaching',
  '  // noon. So the dome carries it instead, where it belongs.',
  '  float band = 1.0 - smoothstep(0.0, 0.45, abs(aboveLimb));',
  '  col = mix(col, uDuskGlow, twilight * band * 0.6);',
  '  // Then the tight lobe around the sun itself, on top of the band.',
  '  float toSun = max(dot(ray, normalize(uSunDirection)), 0.0);',
  '  float glow = pow(toSun, 8.0) * twilight * (1.0 - smoothstep(0.0, 0.5, aboveLimb));',
  '  col = mix(col, uDuskGlow, clamp(glow, 0.0, 1.0));',
  '',
  '  // Leaving the atmosphere. From the deck there is a sky; from orbit there',
  '  // is a planet in space. The camera is a continuous wheel between the two,',
  '  // so the sky has to thin out on the way up rather than switch off.',
  '  float altitude = length(cameraPosition) - uGlobeRadius;',
  '  float inAir = 1.0 - smoothstep(uFadeLo, uFadeHi, altitude);',
  '  // Opacity follows the day, but twilight gets a lift: it is the moment',
  '  // the sky has the most colour in it and would otherwise be showing it',
  '  // through the thinnest veil.',
  '  float alpha = mix(uNightOpacity, 1.0, uDay);',
  '  alpha = min(1.0, alpha + twilight * 0.30) * inAir;',
  '',
  '  // Same dither as the atmosphere shell above, and for the same reason:',
  '  // this is a smooth gradient written into an 8-bit target, and without it',
  '  // the sky bands into visible steps.',
  '  float ditherAmt = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;',
  '  gl_FragColor = vec4(col + ditherAmt, alpha);',
  '}',
].join('\n');

/** The graded sky the player sees from the deck. */
function buildSkyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS * SKY_DOME_SCALE, 64, 48);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uZenithDay: { value: SKY_ZENITH_DAY.clone() },
      uHorizonDay: { value: SKY_HORIZON_DAY.clone() },
      uZenithNight: { value: SKY_ZENITH_NIGHT.clone() },
      uHorizonNight: { value: SKY_HORIZON_NIGHT.clone() },
      uDuskGlow: { value: SKY_DUSK_GLOW.clone() },
      uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
      uDay: { value: 1 },
      uNightOpacity: { value: SKY_NIGHT_OPACITY },
      uGlobeRadius: { value: GLOBE_RADIUS },
      uFadeLo: { value: SKY_FADE_LO },
      uFadeHi: { value: SKY_FADE_HI },
    },
    vertexShader: DOME_VERTEX,
    fragmentShader: DOME_FRAGMENT,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky-dome';
  // Over the stars, under everything else. See the order table on the
  // starfield below.
  mesh.renderOrder = -10;
  // Unlike the two bodies, this one IS worth reflecting: it is inside the
  // cube camera's 3 x GLOBE_RADIUS far plane, and a sea that reflects a dawn
  // sky rather than a fixed blue is most of what the reflection is for.
  mesh.layers.enable(LAYER_REFLECTED);
  return mesh;
}

function buildStars(): THREE.Points {
  const COUNT = 3000;
  const RADIUS = 2000;
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);
  const c = new THREE.Color();

  for (let i = 0; i < COUNT; i++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    positions[i * 3] = Math.cos(th) * s * RADIUS;
    positions[i * 3 + 1] = u * RADIUS;
    positions[i * 3 + 2] = Math.sin(th) * s * RADIUS;

    const warm = Math.random();
    c.setHSL(warm < 0.8 ? 0.58 : 0.09, 0.35, 0.6 + Math.random() * 0.4);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'starfield';
  /*
   * Every transparent thing in the sky is centred on the world origin, so
   * Three's back-to-front distance sort sees them all at the same depth and
   * `renderOrder` is the only thing deciding who paints over whom. The stars
   * are the backdrop, so they go first and everything else is explicit about
   * sitting on top of them:
   *
   *   starfield -20 | sky dome -10 | moon glow -6 | moon -5 |
   *   moon aurora -4 | sun disc -3 | atmosphere 0 | clouds 2 + i
   *
   * The moon is the one body with something on both sides of it: its halo is
   * light behind the sphere and has to be painted over by the lit face, its
   * aurora is light standing at the sphere's edge and has to be painted over
   * it. See `celestial.ts`'s `buildMoonGlow` and `buildMoonAurora`.
   */
  points.renderOrder = -20;
  return points;
}

export function createSky(): Sky {
  const group = new THREE.Group();
  group.name = 'sky';

  const atmosphere = buildAtmosphere();
  group.add(atmosphere);

  const dome = buildSkyDome();
  group.add(dome);

  const starPivot = new THREE.Group();
  starPivot.name = 'starfield-pivot';
  starPivot.add(buildStars());
  group.add(starPivot);

  const atmoUniforms = (atmosphere.material as THREE.ShaderMaterial).uniforms;
  const domeUniforms = (dome.material as THREE.ShaderMaterial).uniforms;

  return {
    group,
    update(dt: number, env: WorldEnv): void {
      starPivot.rotation.y += dt * 0.004;
      atmoUniforms.uSunDirection.value.copy(env.sunDirection);
      domeUniforms.uSunDirection.value.copy(env.sunDirection);
      // The one clock: `fog.ts` mixes its horizon by this same number.
      domeUniforms.uDay.value = env.dayFactor;
    },
  };
}
