import * as THREE from 'three';
import type { WorldEnv } from './env';
import { GLOBE_RADIUS } from './geo';

export interface Celestial {
  group: THREE.Group;
  update(dt: number, env: WorldEnv): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * How far out the two bodies sit, world units.
 *
 * Eight globe radii: outside everything the world draws (the cloud deck tops
 * out at 1.060 R and the atmosphere shell at 1.068 R), inside the starfield's
 * 2000 so both bodies read as being in front of the stars, and well inside the
 * chase camera's 6000 far plane at every zoom. Nothing here is a physical
 * distance -- only the direction matters, and the size constants below are
 * angular, so moving this number does not change how big anything looks.
 */
const CELESTIAL_DISTANCE = GLOBE_RADIUS * 8;

/**
 * Angular radius of the sun's core, radians. The same number the water's
 * specular already draws the sun's reflection at (`SUN_DISC_RADIANS` in
 * `waterglsl.ts`), and it has to stay that way: the glint on the sea is
 * supposed to read as the reflection of the disc in the sky, and it stops
 * doing that the moment the two disagree about how big the sun is.
 *
 * Deliberately larger than the real sun's 0.0047 -- an art choice inherited
 * from the water, not an error.
 */
const SUN_DISC_RADIANS = 0.03;
/** How far the corona reaches past the core, as a multiple of the core radius. */
const SUN_CORONA_SCALE = 3.0;
/**
 * Brightness of the sun's core.
 *
 * Over `postfx.ts`'s bloom threshold of 0.9 by construction, so the glare
 * around the disc comes from the bloom chain that is already running rather
 * than from anything drawn here. Nothing in `postfx.ts` changes for this.
 */
const SUN_CORE_GAIN = 1.7;

/**
 * Angular radius of the moon, radians. A little under the sun's, so a moon
 * near the sun in the sky reads as the smaller of the two rather than as a
 * second sun -- and so the two are never confusable at a glance.
 */
const MOON_DISC_RADIANS = 0.026;
/**
 * Base albedo of the lit face.
 *
 * Darker than it looks. The crater term below multiplies this by up to 1.22,
 * and the product has to stay under `postfx.ts`'s bloom threshold of 0.9 or
 * the moon blooms -- which it did, at the first look, and a blooming moon does
 * not read as a moon at all. It reads as a second sun. The sun is the only
 * thing in this world allowed over that line; MOON_MAX_LUMA in the shader is
 * the hard guard, this is the value that keeps it from being reached.
 */
const MOON_ALBEDO = new THREE.Color('#b4b8c4');

/* ------------------------------------------------------------------ */
/* The sun                                                             */
/* ------------------------------------------------------------------ */

/*
 * A view-space billboard rather than a `THREE.Sprite`.
 *
 * Three's Sprite needs a `SpriteMaterial`, which means the disc has to arrive
 * as a texture, which means a canvas -- and `tests/unit` runs in Node with no
 * DOM (see vitest.config.ts). Offsetting the quad's corners in view space
 * instead billboards it with no camera reference and no texture at all, so the
 * disc stays resolution independent and its shader can be pinned by a golden
 * string test the way every other hand-written shader here is.
 */
const SUN_VERTEX = [
  'uniform float uSize;',
  'varying vec2 vQuad;',
  'void main() {',
  '  vQuad = position.xy;',
  '  // The quad centre in view space, then corners pushed out from it there:',
  '  // that is the billboard, and it needs no camera vector to do it.',
  '  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
  '  mv.xy += position.xy * uSize;',
  '  gl_Position = projectionMatrix * mv;',
  '}',
].join('\n');

const SUN_FRAGMENT = [
  'uniform vec3 uColor;',
  'uniform float uCoreEdge;',
  'uniform float uCoreGain;',
  'varying vec2 vQuad;',
  'void main() {',
  '  float r = length(vQuad);',
  '  // Hard-edged disc, softened by about a sixth of its radius so it does',
  '  // not crawl with aliasing as the camera turns.',
  '  float core = 1.0 - smoothstep(uCoreEdge * 0.84, uCoreEdge, r);',
  '  // Corona: a wide falloff that is gone before the corner of the quad, so',
  '  // the quad itself never shows.',
  '  float corona = pow(clamp(1.0 - r, 0.0, 1.0), 2.5);',
  '  float amount = core * uCoreGain + corona * 0.45;',
  '  // Additive, so alpha is only a mask; the colour carries the brightness.',
  '  gl_FragColor = vec4(uColor * amount, clamp(amount, 0.0, 1.0));',
  '}',
].join('\n');

function buildSun(): THREE.Mesh {
  const coreRadius = Math.tan(SUN_DISC_RADIANS) * CELESTIAL_DISTANCE;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#fff4e4') },
      uSize: { value: coreRadius * SUN_CORONA_SCALE },
      uCoreEdge: { value: 1 / SUN_CORONA_SCALE },
      uCoreGain: { value: SUN_CORE_GAIN },
    },
    vertexShader: SUN_VERTEX,
    fragmentShader: SUN_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Left ON: the planet has to be able to eclipse the sun, which is the
    // whole reason a sunset looks like one from the deck.
    depthTest: true,
  });

  // Corners at +-1, so the vertex shader's offset is in units of uSize.
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.name = 'sun-disc';
  // Billboarded in the shader, so its object-space bounds say nothing about
  // where it lands on screen and Three's frustum test would cull it wrongly.
  mesh.frustumCulled = false;
  mesh.renderOrder = -4;
  return mesh;
}

/* ------------------------------------------------------------------ */
/* The moon                                                            */
/* ------------------------------------------------------------------ */

/*
 * Real geometry, not a billboard, and a hand-written shader rather than a
 * standard material. Three reasons, in order of how much they matter:
 *
 *   1. The phase has to come from the same vector `env.moonIllumination` came
 *      from. A sphere lit by `dot(normal, sunDirection)` cannot show a shape
 *      the fill light disagrees with; a texture cycle can, and would.
 *   2. The rig's hemisphere and ambient lights would otherwise light the
 *      moon's dark side, which is exactly the half that has to stay dark.
 *   3. A hand-written shader can be pinned by a golden string test.
 */
const MOON_VERTEX = [
  'varying vec3 vNormalW;',
  'void main() {',
  '  // World space, because the sun direction arrives in world space. The',
  '  // moon is never scaled non-uniformly, so the plain 3x3 is enough.',
  '  vNormalW = normalize(mat3(modelMatrix) * normal);',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}',
].join('\n');

const MOON_FRAGMENT = [
  'uniform vec3 uAlbedo;',
  'uniform vec3 uSunDirection;',
  'uniform float uDayFactor;',
  'varying vec3 vNormalW;',
  '',
  '// Cheap value hash on the surface direction. Craters, not a map.',
  'float hash13(vec3 p) {',
  '  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));',
  '  p += dot(p, p.yzx + 19.19);',
  '  return fract((p.x + p.y) * p.z);',
  '}',
  '',
  'float craters(vec3 n) {',
  '  float m = 0.0;',
  '  float amp = 0.5;',
  '  float freq = 6.0;',
  '  for (int i = 0; i < 3; i++) {',
  '    vec3 cell = floor(n * freq);',
  '    m += (hash13(cell) - 0.5) * amp;',
  '    freq *= 2.03;',
  '    amp *= 0.55;',
  '  }',
  '  return m;',
  '}',
  '',
  'void main() {',
  '  vec3 N = normalize(vNormalW);',
  '  // The terminator, softened a little either side of true grazing so the',
  '  // crescent has an edge rather than a staircase.',
  '  float lit = smoothstep(-0.05, 0.12, dot(N, normalize(uSunDirection)));',
  '  vec3 albedo = uAlbedo * (1.0 + craters(N) * 0.22);',
  '  // The dark limb stays TRANSPARENT rather than black. By day that lets',
  '  // the sky through, so the moon reads as the pale daytime moon; by night',
  '  // it lets space and the stars through. A black disc would read as a hole',
  '  // punched in the sky at both.',
  '  const float EARTHSHINE = 0.08;',
  '  float alpha = max(lit, EARTHSHINE * (1.0 - uDayFactor));',
  '  // Held under postfx.ts BLOOM_THRESHOLD (0.9). The sun is the only body',
  '  // in this world that gets to glare; a moon that blooms reads as a',
  '  // second sun, which is exactly what it looked like before this line.',
  '  const float MOON_MAX_LUMA = 0.86;',
  '  vec3 col = min(albedo * max(lit, EARTHSHINE), vec3(MOON_MAX_LUMA));',
  '  gl_FragColor = vec4(col, alpha);',
  '}',
].join('\n');

function buildMoon(): THREE.Mesh {
  const radius = Math.tan(MOON_DISC_RADIANS) * CELESTIAL_DISTANCE;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uAlbedo: { value: MOON_ALBEDO.clone() },
      uSunDirection: { value: new THREE.Vector3(0, 0, 1) },
      uDayFactor: { value: 1 },
    },
    vertexShader: MOON_VERTEX,
    fragmentShader: MOON_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 24), material);
  mesh.name = 'moon-disc';
  mesh.renderOrder = -5;
  return mesh;
}

/* ------------------------------------------------------------------ */

/**
 * The two bodies in the sky.
 *
 * Draws what `daynight.ts` has already decided; it computes nothing of its own
 * and writes nothing to `env`. Both objects take their direction straight from
 * `env`, so the disc the player sees and the light landing on the deck can
 * never point different ways.
 *
 * Neither body is put on `LAYER_REFLECTED`. That is not an oversight: the
 * reflection cube's far plane is 3 x GLOBE_RADIUS (`reflection.ts`) and both
 * bodies sit at 8, so the cube could not see them in any case -- and the water
 * already draws its own sun disc in the specular, which is the reflection that
 * actually matters.
 */
export function createCelestial(): Celestial {
  const group = new THREE.Group();
  group.name = 'celestial';

  const sun = buildSun();
  const moon = buildMoon();
  group.add(sun);
  group.add(moon);

  const sunUniforms = (sun.material as THREE.ShaderMaterial).uniforms;
  const moonUniforms = (moon.material as THREE.ShaderMaterial).uniforms;

  return {
    group,
    update(_dt: number, env: WorldEnv): void {
      sun.position.copy(env.sunDirection).multiplyScalar(CELESTIAL_DISTANCE);
      // Same tint as the key light, so the disc goes orange on the horizon
      // with the light it is casting rather than a beat after it.
      sunUniforms.uColor.value.copy(env.sunColor);

      moon.position.copy(env.moonDirection).multiplyScalar(CELESTIAL_DISTANCE);
      moonUniforms.uSunDirection.value.copy(env.sunDirection);
      moonUniforms.uDayFactor.value = env.dayFactor;
    },
  };
}
