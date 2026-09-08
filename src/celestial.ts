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
 * Brightness of the sun's corona at the centre of the disc, where its falloff
 * peaks. Named rather than inlined in the shader because the moon's glow is
 * defined as a fraction of the sun's TOTAL, and that total is this plus
 * `SUN_CORE_GAIN` -- see MOON_GLOW_GAIN.
 */
const SUN_CORONA_GAIN = 0.45;
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
const MOON_ALBEDO = new THREE.Color('#c6c2b2');

/**
 * Tint of the moon's glow: a silvery yellow-white.
 *
 * The same hue family as MOON_ALBEDO above, deliberately. A halo in a
 * different colour from the body inside it does not read as that body's glow,
 * it reads as a second object behind it -- so the disc was warmed off its old
 * blue-grey at the same time this arrived, and the two move together.
 */
const MOON_GLOW_COLOR = new THREE.Color('#f6f2e2');

/** The moon's glow, as a fraction of the sun's. A tenth, as asked for. */
const MOON_GLOW_FRACTION = 0.1;

/**
 * Peak brightness of the moon's glow, at the centre of the halo.
 *
 * DERIVED from the sun rather than written down, because the whole
 * specification is "a tenth of the sun": retuning either of the sun's two
 * gains has to carry the moon with it, and a number typed here would quietly
 * stop being a tenth the first time one of them moved.
 *
 * The sun's peak is its core and its corona summed at r = 0, where both terms
 * are 1. A tenth of that is 0.215, which is comfortably under `postfx.ts`'s
 * BLOOM_THRESHOLD of 0.9 -- so the glow is a glow and not a second sun, the
 * same line MOON_MAX_LUMA holds for the disc.
 */
const MOON_GLOW_GAIN = (SUN_CORE_GAIN + SUN_CORONA_GAIN) * MOON_GLOW_FRACTION;

/**
 * How far the moon's halo reaches, as a multiple of the moon's disc radius.
 *
 * The sun's own SUN_CORONA_SCALE, so the two bodies wear haloes of the same
 * relative size and only their brightness tells them apart.
 */
const MOON_GLOW_SCALE = SUN_CORONA_SCALE;

/* ------------------------------------------------------------------ */
/* The aurora rim                                                      */
/* ------------------------------------------------------------------ */

/**
 * Where the rim aurora's band sits, in quad radii, and how wide it is.
 *
 * The moon's own limb is at exactly `1 / MOON_GLOW_SCALE` on the halo quad --
 * that is what `coreEdge` means on this billboard -- and the band is centred a
 * few percent OUTSIDE it, so the ring reads as light standing off the edge of
 * the body rather than as a bright stripe painted around the outside of the
 * disc. The width is a third of the moon's own radius, which is narrow enough
 * that the thing is unmistakably a rim and not a second halo, and wide enough
 * to survive the bloom blurring it.
 */
const MOON_AURORA_EDGE = 1.06 / MOON_GLOW_SCALE;
const MOON_AURORA_WIDTH = 0.1;

/**
 * The rim's peak brightness, and it is the same tenth of the sun the halo is:
 * `MOON_GLOW_GAIN` itself, not a number of its own.
 *
 * **This ring glows; it does not go through the bloom pass, and the margin is
 * 1.3%.** Worth writing down, because it is the kind of thing that gets
 * "fixed" by someone who did not measure it. `postfx.ts` thresholds on the
 * peak channel at 0.9. The brightest pixel this rim can ever appear on is the
 * lit limb of a FULL moon over the brightest crater the hash produces:
 * MOON_ALBEDO is 0.565 in the linear space these shaders write, the crater
 * term tops out at 1.22 of it (0.689), MOON_GLOW_COLOR's own peak channel is
 * 0.922, and the rim is additive over the face (see `buildMoonAurora`'s
 * renderOrder). So the best case is 0.689 + 0.922 * 0.215 = 0.887, and the
 * bloom chain never sees it.
 *
 * That is a real tension in what was asked for and not an oversight: a tenth
 * of the sun and a bloom are two different instructions, and on this
 * threshold they are 0.013 apart. The tenth wins because it is the number
 * that was actually written down, and because it is the same tenth the halo
 * has always been held to -- the moon is the one body in this world that is
 * not allowed to glare, which is the whole of MOON_MAX_LUMA's argument.
 *
 * If the ring should genuinely bloom, this is the one constant to move and
 * nothing else changes: about 0.23 puts the brightest full-moon limb over the
 * line, and about 0.36 -- a sixth of the sun rather than a tenth -- puts the
 * whole lit half of an ordinary full moon over it, which is the value that
 * would actually read as glare.
 *
 * What the ring does do is the rest of what was asked, and it does it off the
 * phase: scaled by `moonIllumination` exactly as the halo is, a full moon
 * wears a complete ring, a thin crescent wears one on the lit horn, and a new
 * moon wears none.
 */
const MOON_AURORA_GAIN = MOON_GLOW_GAIN;

/**
 * The aurora's shimmer: how much of the ring's brightness moves, and the two
 * rates it moves at, radians of ring per cycle and cycles per second.
 *
 * A ring of constant brightness is a decal. Two slow sines at coprime
 * frequencies -- the second SUBTRACTED, so the two run opposite ways around
 * the limb rather than in step -- give it the drifting bright and dim arcs
 * that make the thing read as an aurora rather than as a drawn circle. Both
 * are functions of the angle around the quad, so the pattern turns with the
 * moon rather than with the camera.
 *
 * The depth is deliberately under half: at more than that the ring visibly
 * breaks into separate arcs, and a broken ring reads as an artefact.
 */
const MOON_AURORA_SHIMMER = 0.34;
const MOON_AURORA_LOBES_A = 3;
const MOON_AURORA_LOBES_B = 5;
const MOON_AURORA_RATE_A = 0.29;
const MOON_AURORA_RATE_B = 0.17;

/* ------------------------------------------------------------------ */
/* The billboard both haloes are drawn with                            */
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
const GLOW_VERTEX = [
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

/*
 * One fragment shader for all three billboards, and the three gains are what
 * separate them.
 *
 * The sun sets `uCoreGain` and gets a hard disc inside a wide falloff. The
 * moon's halo sets it to ZERO, which drops the core term entirely and leaves
 * only the falloff -- exactly what the moon wants, because the moon already
 * draws its own body as a lit sphere, and a second bright disc behind that
 * sphere would fill in the dark half and destroy the phase. A crescent has to
 * stay a crescent with the glow on. The moon's aurora sets `uRimGain` alone
 * and gets the band by itself, drawn OVER the body rather than under it --
 * which is what lets a ring at a tenth of the sun still be seen against a
 * face several times brighter than it.
 *
 * Sharing the string rather than writing each one its own is deliberate:
 * `celestial-shader.test.ts` pins this by golden, and three near-identical
 * shaders would be three goldens free to drift apart. Every term is exactly
 * zero at its own gain of zero, so a body that does not want one does not pay
 * for it in anything but the arithmetic.
 */
const GLOW_FRAGMENT = [
  'uniform vec3 uColor;',
  'uniform float uCoreEdge;',
  'uniform float uCoreGain;',
  'uniform float uCoronaGain;',
  'uniform float uRimGain;',
  'uniform float uRimEdge;',
  'uniform float uRimWidth;',
  'uniform float uTime;',
  'varying vec2 vQuad;',
  'void main() {',
  '  float r = length(vQuad);',
  '  // Hard-edged disc, softened by about a sixth of its radius so it does',
  '  // not crawl with aliasing as the camera turns. Zero uCoreGain removes it.',
  '  float core = 1.0 - smoothstep(uCoreEdge * 0.84, uCoreEdge, r);',
  '  // Corona: a wide falloff that is gone before the corner of the quad, so',
  '  // the quad itself never shows.',
  '  float corona = pow(clamp(1.0 - r, 0.0, 1.0), 2.5);',
  '  // Rim aurora: a gaussian band standing just outside the body\'s own limb,',
  '  // with its brightness drifting around the ring on two slow lobes running',
  '  // opposite ways. atan() is undefined at the origin, so the shimmer fades',
  '  // out over the middle of the quad -- where the band is zero in any case.',
  '  float rimT = (r - uRimEdge) / max(uRimWidth, 1e-4);',
  '  float rim = exp(-rimT * rimT);',
  '  float ang = atan(vQuad.y, vQuad.x);',
  `  float shimmer = sin(ang * ${MOON_AURORA_LOBES_A.toFixed(1)} + uTime * ${MOON_AURORA_RATE_A.toFixed(2)})`,
  `                * sin(ang * ${MOON_AURORA_LOBES_B.toFixed(1)} - uTime * ${MOON_AURORA_RATE_B.toFixed(2)});`,
  `  rim *= 1.0 - ${MOON_AURORA_SHIMMER.toFixed(2)} * (0.5 - 0.5 * shimmer) * smoothstep(0.0, 0.1, r);`,
  '  float amount = core * uCoreGain + corona * uCoronaGain + rim * uRimGain;',
  '  // Additive, so alpha is only a mask; the colour carries the brightness.',
  '  gl_FragColor = vec4(uColor * amount, clamp(amount, 0.0, 1.0));',
  '}',
].join('\n');

/**
 * A billboarded halo: `size` world units to the corner of the quad, with the
 * hard core filling `coreEdge` of that radius.
 *
 * Shared by all three billboards, so a change to how a halo is drawn cannot
 * reach one and miss another.
 *
 * `rim` is the aurora band: its gain, where it sits in quad radii, and how
 * wide it is. Zero gain removes it, which is what the sun and the moon's own
 * halo pass.
 */
function buildGlow(
  name: string,
  size: number,
  coreEdge: number,
  color: THREE.Color,
  coreGain: number,
  coronaGain: number,
  renderOrder: number,
  rim: { readonly gain: number; readonly edge: number; readonly width: number } = {
    gain: 0,
    edge: 0,
    width: 1,
  },
): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uSize: { value: size },
      uCoreEdge: { value: coreEdge },
      uCoreGain: { value: coreGain },
      uCoronaGain: { value: coronaGain },
      uRimGain: { value: rim.gain },
      uRimEdge: { value: rim.edge },
      uRimWidth: { value: rim.width },
      uTime: { value: 0 },
    },
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Left ON: the planet has to be able to eclipse either body, which is the
    // whole reason a sunset looks like one from the deck.
    depthTest: true,
  });

  // Corners at +-1, so the vertex shader's offset is in units of uSize.
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.name = name;
  // Billboarded in the shader, so its object-space bounds say nothing about
  // where it lands on screen and Three's frustum test would cull it wrongly.
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return mesh;
}

function buildSun(): THREE.Mesh {
  const coreRadius = Math.tan(SUN_DISC_RADIANS) * CELESTIAL_DISTANCE;
  return buildGlow(
    'sun-disc',
    coreRadius * SUN_CORONA_SCALE,
    1 / SUN_CORONA_SCALE,
    new THREE.Color('#fff4e4'),
    SUN_CORE_GAIN,
    SUN_CORONA_GAIN,
    -3,
  );
}

/**
 * The moon's halo: the same billboard with its core switched off.
 *
 * Sits at renderOrder -6, UNDER the moon's own sphere at -5, so the lit face
 * paints over the middle of its own glow rather than under it. Both are
 * centred on the same point, so Three's back-to-front sort cannot separate
 * them and the order table in `sky.ts` is the only thing that decides.
 *
 * `uCoronaGain` is rewritten every frame from the phase -- see `update` -- so
 * the value passed here is only what it starts at.
 */
function buildMoonGlow(): THREE.Mesh {
  const discRadius = Math.tan(MOON_DISC_RADIANS) * CELESTIAL_DISTANCE;
  return buildGlow(
    'moon-glow',
    discRadius * MOON_GLOW_SCALE,
    1 / MOON_GLOW_SCALE,
    MOON_GLOW_COLOR.clone(),
    0,
    MOON_GLOW_GAIN,
    -6,
  );
}

/**
 * The moon's rim aurora: the same billboard again, with the core and the
 * corona switched off and only the band standing.
 *
 * Sits at renderOrder -4, OVER the moon's own sphere at -5, and that is the
 * whole difference between this and the halo below it. The halo is light
 * BEHIND the body and has to be painted over by the lit face; the aurora is
 * light standing at the body's edge, so it is painted over the face and adds
 * to it -- which is also what lets a lit limb plus a ring cross `postfx.ts`'s
 * bloom threshold when neither could alone. See MOON_AURORA_GAIN.
 *
 * The quad is the halo's, to the unit: the band is positioned in quad radii
 * off `MOON_GLOW_SCALE`, so the two must be the same size or the ring lands
 * somewhere other than the limb.
 *
 * `uRimGain` is rewritten every frame from the phase -- see `update` -- so the
 * value passed here is only what it starts at.
 */
function buildMoonAurora(): THREE.Mesh {
  const discRadius = Math.tan(MOON_DISC_RADIANS) * CELESTIAL_DISTANCE;
  return buildGlow(
    'moon-aurora',
    discRadius * MOON_GLOW_SCALE,
    1 / MOON_GLOW_SCALE,
    MOON_GLOW_COLOR.clone(),
    0,
    0,
    -4,
    { gain: MOON_AURORA_GAIN, edge: MOON_AURORA_EDGE, width: MOON_AURORA_WIDTH },
  );
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
  const moonGlow = buildMoonGlow();
  const moon = buildMoon();
  const moonAurora = buildMoonAurora();
  group.add(sun);
  // Added in painting order for readability only; renderOrder, not insertion
  // order, is what actually decides which paints first. See buildMoonGlow and
  // buildMoonAurora, which sit either side of the sphere between them.
  group.add(moonGlow);
  group.add(moon);
  group.add(moonAurora);

  const sunUniforms = (sun.material as THREE.ShaderMaterial).uniforms;
  const moonUniforms = (moon.material as THREE.ShaderMaterial).uniforms;
  const moonGlowUniforms = (moonGlow.material as THREE.ShaderMaterial).uniforms;
  const moonAuroraUniforms = (moonAurora.material as THREE.ShaderMaterial).uniforms;

  /**
   * The aurora's own clock, in seconds, and the only state this module keeps.
   *
   * Accumulated from `dt` rather than read off `env.elapsed`, because that one
   * is the world's day clock and runs at whatever rate the day is running at;
   * the shimmer is a thing the water does, not a thing the calendar does, and
   * it should drift at the same rate at noon and at midnight.
   */
  let auroraTime = 0;

  return {
    group,
    update(dt: number, env: WorldEnv): void {
      auroraTime += dt;
      sun.position.copy(env.sunDirection).multiplyScalar(CELESTIAL_DISTANCE);
      // Same tint as the key light, so the disc goes orange on the horizon
      // with the light it is casting rather than a beat after it.
      sunUniforms.uColor.value.copy(env.sunColor);

      moon.position.copy(env.moonDirection).multiplyScalar(CELESTIAL_DISTANCE);
      moonUniforms.uSunDirection.value.copy(env.sunDirection);
      moonUniforms.uDayFactor.value = env.dayFactor;

      /*
       * The halo rides the body exactly, and its strength is the phase.
       *
       * Scaled by `moonIllumination` rather than held at MOON_GLOW_GAIN,
       * because a glow is light coming off the lit face and a new moon has no
       * lit face to give any. Left flat, the one night the moon is a dark
       * disc would be the night it wore its brightest ring -- and it is the
       * same number the sphere's own terminator is drawn from, so the halo
       * cannot brighten while the crescent it surrounds thins.
       *
       * Not faded by `dayFactor`. At a tenth of the sun the halo is already
       * far under a daylit sky and does not need a second control, and the
       * pale daytime moon keeps the same faint ring it has at night.
       */
      moonGlow.position.copy(moon.position);
      moonGlowUniforms.uCoronaGain.value = MOON_GLOW_GAIN * env.moonIllumination;

      /*
       * The aurora rides the body exactly too, and scales with the phase for
       * the same reason the halo does: a ring is light coming off the lit
       * face, and a new moon has no lit face to give any. It is the same
       * number the sphere's own terminator is drawn from, so the ring cannot
       * brighten while the crescent it wraps thins.
       */
      moonAurora.position.copy(moon.position);
      moonAuroraUniforms.uRimGain.value = MOON_AURORA_GAIN * env.moonIllumination;
      moonAuroraUniforms.uTime.value = auroraTime;
    },
  };
}
