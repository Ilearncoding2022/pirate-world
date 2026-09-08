import * as THREE from 'three';
import type { WorldEnv } from './env';
import { GLOBE_RADIUS } from './geo';
import { LAYER_REFLECTED } from './layers';
import { HEIGHTMAP_GLSL } from './heightmap';
import { WEATHERMAP_GLSL, weatherMapUniforms } from './weathermap';
import { SIMPLEX_GLSL } from './simplexglsl';
import type { WeatherState } from './types';

export interface Clouds {
  object: THREE.Object3D;
  /** `weather` is optional and absent means clear: see `update` below. */
  update(dt: number, env: WorldEnv, weather?: WeatherState): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * Radius of the cloud base, as a multiple of GLOBE_RADIUS.
 *
 * Above the water (1.0) and above all but the very highest summits: `land.ts`
 * tops out at 1 + (COAST_LIFT + MAX_LAND_RELIEF) / GLOBE_RADIUS = 1.0512, but
 * relief is eased so only the rare interior peak gets near that. Well inside
 * the atmosphere shell `sky.ts` puts at 1.055. Land is opaque and drawn in the
 * opaque pass, so a summit that does reach through simply punches a hole in
 * the layer, which reads correctly.
 *
 * 1.024 puts the base 4.8 world units up, clear of the ship's 4.15-unit
 * masthead, and leaves room for SHELL_DEPTH under the atmosphere shell that
 * `sky.ts` draws -- which has to contain the deck, or cloud tops appear
 * outside the planet's own air at the limb.
 */
const SHELL_BASE = 1.024;

/**
 * Depth of the deck at its tallest, as a multiple of GLOBE_RADIUS: 7.2 world
 * units of air between the cloud base and the top of the highest tower.
 *
 * This is an envelope, not a uniform slab -- uTowerFloor below decides how much
 * of it any given bank actually fills, so weather ranges from flat sheets at
 * two thirds of this to full towers at all of it.
 */
const SHELL_DEPTH = 0.036;

/**
 * Radial gap between slices, as a multiple of GLOBE_RADIUS.
 *
 * The real constant is this, not the slice count: it is what decides whether
 * the stack reads as continuous cloud or as a stack of plates seen edge on.
 * Deepening the deck therefore has to buy more slices, which is why the count
 * is derived rather than typed.
 *
 * It is also the layer's cost knob -- every slice is another pass of the
 * fragment shader over whatever part of the sky it covers -- so halving it
 * roughly doubles what the clouds cost.
 */
const SLICE_SPACING = 0.0036;

/** Slices the deck is cut into. At least two, or there is no deck to see. */
const SHELL_COUNT = Math.max(2, Math.round(SHELL_DEPTH / SLICE_SPACING) + 1);

/** Mid-deck radius, which the bulk drift rate is quoted at. */
const SHELL_MID = SHELL_BASE + SHELL_DEPTH * 0.5;

/**
 * Per-slice opacity that composites to STACK_OPACITY through the whole deck.
 *
 * Alpha compounds: n slices at `a` leave (1 - a)^n of the background showing.
 * Solving that for a keeps a dense core just as solid as the single shell was,
 * instead of five opaque layers where only the top one is ever seen.
 */
const STACK_OPACITY = 0.985;
const SLICE_OPACITY = 1 - Math.pow(1 - STACK_OPACITY, 1 / SHELL_COUNT);

/**
 * Speed the layer drifts, in world units per second at the shell.
 *
 * About a fifth of the ship flat out -- `MAX_FORWARD` in `ship.ts` is 10,
 * which the HUD reads out as 10.0 kn -- so the weather crawls past at 2.0 kn at
 * the shell, 1.9 measured against the ground the ship actually covers. It was
 * a clean tenth while the ship made 20 and an eighth at 15; the deck has been
 * left where it was through both cuts, because the number that matters is that
 * you outrun it, and at 10 kn against 2.0 you still comfortably do. Fast enough
 * that a bank visibly moves over a minute of sailing, slow enough that you
 * always outrun it.
 */
const DRIFT_SPEED = 2.0;

/** Bulk drift of the whole layer, radians/second. ~11 minutes per rotation. */
const SPIN_RATE = DRIFT_SPEED / (GLOBE_RADIUS * SHELL_MID);

/** Tilted off +Y so the drift is not purely zonal and the poles keep moving. */
const SPIN_AXIS = new THREE.Vector3(0.17, 1.0, -0.11).normalize();

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

// Simplex noise lives in `simplexglsl.ts` now: `fogbank.ts` samples the same
// field at sea level and one copy of it is the point of that module.

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
  'uniform float uAltitude;',
  'uniform float uDome;',
  'uniform float uTowerFloor;',
  'uniform float uShear;',
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
  '// The weather at the ship, and the weather everywhere. A squall has no',
  '// place and arrives as the two scalars; a cell has one and arrives as the',
  '// map, sampled per pixel so a storm forty units away is a black mass on',
  '// the horizon rather than a change to the sky overhead.',
  'uniform float uCover;',
  'uniform float uGloom;',
  'uniform float uFlash;',
  'uniform float uFlashLocal;',
  // `uWeatherMap` is declared by WEATHERMAP_GLSL below, the way FOG_GLSL
  // declares the fog colours: declaring it here too fails to compile.
  'varying vec3 vObjDir;',
  'varying vec3 vWorldPos;',
  SIMPLEX_GLSL,
  HEIGHTMAP_GLSL,
  WEATHERMAP_GLSL,
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
  // Fixed direction the deck leans as it rises. A pure vertical extrusion of
  // one 2D field would stack every slice squarely on the one below and read as
  // a layer cake; shearing the domain with altitude gives the towers overhang.
  'const vec3 ALT_SHEAR = vec3(0.62, -0.46, 0.64);',
  // Very low frequency, so a whole weather system agrees on how tall it builds
  // rather than towers and sheets interleaving every few kilometres.
  'const vec3 TOWER_DRIFT = vec3(0.0031, -0.0024, 0.0027);',
  '// How far a full storm lowers the coverage threshold.',
  '//',
  '// `uThreshold` is 0.5127 and its comment records the measurement behind',
  '// it: over a uniform sample of the sphere at three times of day it covers',
  '// 25.9% of the sky. Subtracting 0.16 takes the same field to about 80%,',
  '// which is a sky with weather in it rather than a sky with a lid on it --',
  '// the gaps a real storm leaves are most of what makes the light under one',
  '// interesting. Retune it by the same measurement that comment describes.',
  'const float COVER_GAIN = 0.16;',
  '// How far a full storm pulls the two lit colours toward the storm grey,',
  '// and how far a flash lifts the underside toward white.',
  'const float GLOOM_MIX = 0.8;',
  'const float FLASH_CLOUD = 0.6;',
  '// The colour a storm cloud is. Not black: a storm cloud lit from above is',
  '// a dark blue-grey, and true black reads as a hole cut in the sky.',
  'const vec3 STORM_CLOUD = vec3(0.227, 0.259, 0.314);',
  'void main() {',
  '  vec3 nWorld = normalize(vWorldPos);',
  '  vec3 viewDir = normalize(vWorldPos - cameraPosition);',
  // How square on this slice is to the view. Near 0 it is edge on, one pixel
  // spans many wavelengths of the field, and a thin translucent shell breaks
  // up into a dotted mesh that follows its own tessellation -- five stacked
  // shells being five times as many chances to see it. Same cure as the ocean
  // in `water.ts`: fade every term that could alias out on this number.
  '  float facing = abs(dot(nWorld, viewDir));',
  '  float lod = smoothstep(0.05, 0.34, facing);',
  '  float t = uTime;',
  '  vec3 p = vObjDir * uScale;',
  // Domain warp: bends cloud edges into wisps and hooks.
  '  float w1 = snoise(p * 1.63 + vec3( 4.7, 1.3, 8.9) + WARP_DRIFT * t);',
  '  float w2 = snoise(p * 1.63 + vec3(-3.1, 6.2, 2.4) - WARP_DRIFT * t);',
  '  vec3 q = p + uWarp * vec3(w1, w2, 0.5 * (w1 - w2)) + ALT_SHEAR * (uShear * uAltitude);',
  // Coverage threshold, gently banded by latitude like real weather, and
  // climbing with altitude so only the densest cores reach the top slices.
  // That ramp is the whole shape of the deck: a flat base at the widest
  // extent, tapering into domes. uAltitude is 0 on the base slice, so the
  // silhouette from above still measures the coverage the base was tuned for.
  '  float thrBase = uThreshold + uBand * sin(nWorld.y * 6.5 + 0.7);',
  '  // The weather here. One texture fetch, whatever the cell population is.',
  '  vec3 wx = weatherAt(uWeatherMap, nWorld);',
  '  float cover = max(uCover, wx.r);',
  '  float gloom = max(uGloom, wx.r);',
  '  // Lowering the threshold is what makes a storm overcast: the same field,',
  '  // asked for less before it counts as cloud. It is deliberately applied',
  '  // to `thrBase` and therefore BEFORE the early-out below, so the sky over',
  '  // a cell genuinely fills in rather than merely darkening the banks that',
  '  // happened to be there already.',
  '  thrBase -= cover * COVER_GAIN;',
  // A tower field decides how tall the weather builds *here*, and altitude is
  // divided by it, so each slice asks "how far up its own bank am I" rather
  // than "how far up the deck". One field then gives flat sheets in one place
  // and full towers in the next, instead of a slab of uniform thickness.
  //
  // tower = 1 is the tallest weather and therefore the lowest this threshold
  // can go, so it is a sound early-out bound and it costs nothing to compute.
  // Testing against it first keeps open sky at two noise samples per slice --
  // with eleven slices that is the difference between 22 samples over the
  // whole sky and 33.
  '  float thr = thrBase + uDome * uAltitude;',
  // Two cheap octaves first, so open sky costs almost nothing.
  '  float a0 = snoise(q * 1.00 + DRIFT0 * t);',
  '  float a1 = snoise(q * 2.03 + DRIFT1 * t);',
  '  float partial = 0.5 * a0 + 0.25 * a1;',
  '  float best = ((partial + 0.1875) / 0.9375) * 0.5 + 0.5 + uWisp;',
  '  if (best < thr) discard;',
  // Only now, having survived that, is the tower worth sampling. uAltitude is
  // a uniform, so this branch is uniform control flow and the base slice --
  // the one covering the most sky -- skips it outright.
  '  if (uAltitude > 0.0) {',
  '    float towerN = snoise(p * 0.47 + vec3(23.1, -5.4, 11.8) + TOWER_DRIFT * t);',
  '    thr = thrBase + uDome * uAltitude / mix(uTowerFloor, 1.0, towerN * 0.5 + 0.5);',
  '    if (best < thr) discard;',
  '  }',
  // Full fractal density.
  '  float a2 = snoise(q * 4.11 + DRIFT2 * t);',
  '  float a3 = snoise(q * 8.07 + DRIFT3 * t);',
  '  float f = (partial + 0.125 * a2 + 0.0625 * a3) / 0.9375;',
  '  float density = f * 0.5 + 0.5;',
  // High frequency erosion. Only bites near the threshold, which is exactly
  // where the ragged edges belong -- and exactly where undersampling shows, so
  // it is the first thing to go at grazing angles. `best` above still adds the
  // full uWisp, so it stays a valid upper bound however far this is faded.
  '  float wisp = uWisp * lod;',
  '  if (wisp > 0.002) {',
  '    float e1 = snoise(q * 6.0 + DRIFT4 * t);',
  '    float e2 = snoise(q * 12.5 + DRIFT5 * t);',
  '    density += wisp * (0.62 * e1 + 0.38 * e2);',
  '  }',
  // A narrow ramp keeps most of the sphere either solidly clouded or open sky
  // rather than one continent-wide veil. `deep` measures how far inside a bank
  // this pixel sits, so cores can shade differently from the thin skirts.
  // Widen the ramp as the slice turns edge on, so its rim resolves as a soft
  // gradient rather than a one-pixel in/out decision.
  '  float cov = smoothstep(thr, thr + uSoft * mix(2.2, 1.0, lod), density);',
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
  '  // The gloom lands on both endpoints BEFORE the shadow mixes between',
  '  // them, so a storm darkens the whole cloud rather than deepening its',
  '  // shadows -- an overcast sky is uniformly grey, and it is the lack of',
  '  // contrast that reads as weather.',
  '  vec3 dayCol = mix(uDayColor, STORM_CLOUD, gloom * GLOOM_MIX);',
  '  vec3 shadowCol = mix(uShadowColor, STORM_CLOUD, gloom * GLOOM_MIX);',
  '  vec3 litCol = mix(dayCol, shadowCol, shadow * uShadowMix) * sunTint;',
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
  '  // Lightning, lighting its own cloud. `uFlashLocal` is 1 when the strike',
  '  // came from a squall -- which has no place, so it lights the whole deck',
  '  // -- and 0 when it came from a cell, in which case `wx.b` says which',
  '  // part of the sky is allowed to be lit. Without that, a strike inside a',
  '  // storm on the horizon would flash the clear sky overhead too.',
  '  float flashHere = uFlash * max(uFlashLocal, wx.b);',
  '  col = mix(col, vec3(1.0), clamp(flashHere * FLASH_CLOUD, 0.0, 1.0));',
  // Alpha. Thicker seen edge on, and faded out close to the camera so the
  // layer never fogs the chase view around the ship.
  '  float graze = 1.0 - facing;',
  '  float thickness = mix(1.0, uGraze, graze * graze);',
  '  float camDist = length(vWorldPos - cameraPosition);',
  '  float alpha = clamp(cov * uOpacity * thickness, 0.0, 1.0);',
  '  alpha *= smoothstep(uFadeNear, uFadeFar, camDist);',
  // Fold the slice away at its own silhouette, where all that is left of it is
  // a hairline of undersampled noise standing off the limb.
  '  alpha *= smoothstep(0.0, 0.07, facing);',
  '  if (alpha < 0.004) discard;',
  '  gl_FragColor = vec4(col, alpha);',
  '}',
].join('\n');

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Translucent cloud deck.
 *
 * A stack of SHELL_COUNT concentric spheres just above the surface, all
 * carrying the same animated fractal density field. Coverage is thresholded
 * with a soft edge so most of the globe stays open sky and the clouds gather
 * into recognisable banks, then lit from `env.sunDirection` so tops catch warm
 * light and the night side goes dark without disappearing.
 *
 * The stack is what gives the deck depth. Each slice reads the field at its
 * own altitude, and the threshold climbs with altitude, so a slice is a
 * horizontal cross-section of a 3D cloud rather than a copy of the one below:
 * wide flat bases, domes on top, an overhang where the shear leans them. Seen
 * edge on -- at the limb, or from the deck of the ship -- the deck has a
 * measurable thickness instead of being a painted decal.
 *
 * Only near hemispheres are drawn (`FrontSide`), so the far side of a sphere
 * can never blend over the near side, and slices are drawn inner to outer so
 * the alpha blend runs back to front.
 */
export function createClouds(): Clouds {
  const object = new THREE.Group();
  object.name = 'clouds';

  // One unit sphere, scaled per slice. `vObjDir` is normalize(position), which
  // is scale invariant, so every slice samples the same field direction.
  const geometry = new THREE.SphereGeometry(1, 128, 64);

  // Shared by every slice: these are the same `{ value }` objects in each
  // material, so `update` writes them once and the whole stack sees it.
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
    /**
     * Density above this becomes cloud. Higher = more open sky.
     *
     * Not eyeballed: the density field is a fixed fractal, so the sky fraction
     * it covers can be integrated. Over a uniform sample of the sphere at
     * three times of day, the old 0.556 with uSoft 0.1 and uWisp 0.045 covered
     * 19.9% of the sky. This value is the one that covers 25.9% -- thirty per
     * cent more weather -- given the softer, wispier settings below. Retune it
     * by the same measurement if uSoft, uWisp, uScale or uWarp ever move.
     */
    uThreshold: { value: 0.5127 },
    /**
     * Width of the coverage ramp. Wider = softer, more diffuse cloud edges,
     * which is half of what makes a bank read as billowed rather than stamped.
     */
    uSoft: { value: 0.14 },
    uBand: { value: 0.05 },
    /** High-frequency erosion. Doubled: the other half of the fluff. */
    uWisp: { value: 0.09 },
    /** Per slice; the stack composites to STACK_OPACITY. See SLICE_OPACITY. */
    uOpacity: { value: SLICE_OPACITY },
    /**
     * How much higher the coverage threshold sits at the top of the deck than
     * at its base. This is the deck's profile: 0 extrudes the base straight up
     * into a slab, larger values pull the top slices in until only the densest
     * cores tower. Sized against uSoft (0.14) so the top slice still exists
     * over a good bank rather than vanishing.
     */
    uDome: { value: 0.09 },
    /**
     * Shallowest weather, as a fraction of the deck's full depth.
     *
     * Two thirds, so a bank reaches somewhere between 2/3 and all of
     * SHELL_DEPTH. With the depth set to three times what a flat single-height
     * deck needed, that is the range asked for: banks run from twice to three
     * times the old thickness, and which one you get varies from place to
     * place instead of the whole sky agreeing.
     */
    uTowerFloor: { value: 0.667 },
    /**
     * How far the domain leans between base and top, in noise-domain units.
     * Scaled with SHELL_DEPTH so the lean stays an angle rather than becoming
     * a shear that flattens out as the deck grows.
     */
    uShear: { value: 0.09 },
    uShadowStep: { value: 0.22 },
    uShadowMix: { value: 0.85 },
    /** Gain on the sunward density difference that fakes cloud relief. */
    uRelief: { value: 7.0 },
    /**
     * Extra optical depth through a slice seen edge on, on top of the real
     * depth the stack now provides. Kept high because a slice is still a
     * surface, not a volume, and a long slant path through cloud should read
     * as denser than a look straight down at it.
     */
    uGraze: { value: 2.5 },
    uSilver: { value: 0.5 },
    /** Camera distance fade, world units. Keeps the layer off the chase view. */
    ...weatherMapUniforms,
    /**
     * The at-ship weather. Zero in fair weather, which is what makes every
     * term above inert: `max(0, wx)` is the map alone, and an empty map is
     * zero everywhere, so the deck renders exactly what it always did.
     */
    uCover: { value: 0 },
    uGloom: { value: 0 },
    uFlash: { value: 0 },
    /** 1 when the live flash belongs to a squall rather than to a cell. */
    uFlashLocal: { value: 0 },
    uFadeNear: { value: 30 },
    uFadeFar: { value: 85 },
  };

  for (let i = 0; i < SHELL_COUNT; i++) {
    // 0 on the base slice, 1 on the top one. A single slice sits on the base,
    // where the coverage was measured.
    const altitude = SHELL_COUNT > 1 ? i / (SHELL_COUNT - 1) : 0;

    const material = new THREE.ShaderMaterial({
      // Spread copies the references, not the values, so every slice shares
      // one uTime / uSunDirection / ... and only uAltitude differs.
      uniforms: { ...uniforms, uAltitude: { value: altitude } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: false,
    });

    const slice = new THREE.Mesh(geometry, material);
    slice.name = `cloud-slice-${i}`;
    slice.scale.setScalar(GLOBE_RADIUS * (SHELL_BASE + SHELL_DEPTH * altitude));
    // After the opaque world and after any additive night side emissives, so
    // the deck occludes what sits beneath it. Ascending within the stack: with
    // FrontSide only the camera-facing cap of each sphere is drawn, so the
    // outermost slice is always the nearest, and inner-to-outer is back to
    // front. Three cannot sort these itself -- they are concentric, so every
    // slice has the same centroid distance.
    slice.renderOrder = 2 + i;
    // Docs/RENDER_PLAN.md Phase 1 Stream D: every slice of the deck is one of
    // the four things the water's reflection cube renders. Three does not
    // inherit layers to children, so each slice needs this individually.
    slice.layers.enable(LAYER_REFLECTED);
    object.add(slice);
  }

  return {
    object,
    update(_dt: number, env: WorldEnv, weather?: WeatherState): void {
      uniforms.uTime.value = env.elapsed;
      uniforms.uSunDirection.value.copy(env.sunDirection);
      uniforms.uSunColor.value.copy(env.sunColor);
      // Optional, and absent means clear: a caller that knows nothing about
      // weather gets the deck the game shipped with.
      uniforms.uCover.value = weather ? weather.cover : 0;
      uniforms.uGloom.value = weather ? weather.storm : 0;
      uniforms.uFlash.value = weather ? weather.flash : 0;
      uniforms.uFlashLocal.value = weather && weather.flashLocal ? 1 : 0;
      // Bulk drift, derived from elapsed so it never accumulates float error.
      object.setRotationFromAxisAngle(SPIN_AXIS, env.elapsed * SPIN_RATE);
    },
  };
}
