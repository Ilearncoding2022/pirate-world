import * as THREE from 'three';
import type { Terrain } from './types';
import type { WorldEnv } from './env';
import type { HeightMap } from './heightmap';
import { HEIGHTMAP_GLSL } from './heightmap';
import { GLOBE_RADIUS } from './geo';
import { NOISE_GLSL } from './noiseglsl';
import { FOG_GLSL } from './fogglsl';
import { fogUniforms } from './fog';
import { bakeTerrain, HORIZON_MAX_DEGREES } from './terrainbake';
import type { Quality } from './quality';

/**
 * Outward displacement of the highest land.
 *
 * World-scale, so it tracks GLOBE_RADIUS: 5% of the radius. Leaving it fixed
 * while the globe grew would flatten every mountain range into a rise.
 */
export const MAX_LAND_RELIEF = GLOBE_RADIUS * 0.05;
/**
 * Minimum lift of land above the water sphere. Keeps coastal faces from
 * z-fighting with the water surface, which sits at exactly GLOBE_RADIUS.
 */
export const COAST_LIFT = GLOBE_RADIUS * 0.0012;
/** Height band above sea level rendered as beach. */
const BEACH_BAND = 0.055;
/**
 * Faces whose vertices are all below this are dropped from the land mesh.
 *
 * Exported because `islets.ts` sinks the islands it culls past this depth. A
 * sunk islet shallower than the margin would keep its faces and go on being
 * drawn as land the ship can sail straight through.
 */
export const CULL_MARGIN = 0.10;

const PALETTE = {
  sand: new THREE.Color('#d9c48b'),
  grass: new THREE.Color('#4f7a4a'),
  forest: new THREE.Color('#2f5540'),
  rock: new THREE.Color('#5b5468'),
  peak: new THREE.Color('#b9b2c9'),
};

/** Colour ramp for land above sea level. */
function colorForLand(h: number, seaLevel: number, out: THREE.Color): THREE.Color {
  const a = Math.max(0, h - seaLevel);
  if (a < BEACH_BAND) return out.copy(PALETTE.sand).lerp(PALETTE.grass, a / BEACH_BAND);
  const t = Math.min(1, (a - BEACH_BAND) / 0.5);
  if (t < 0.4) return out.copy(PALETTE.grass).lerp(PALETTE.forest, t / 0.4);
  if (t < 0.75) return out.copy(PALETTE.forest).lerp(PALETTE.rock, (t - 0.4) / 0.35);
  return out.copy(PALETTE.rock).lerp(PALETTE.peak, (t - 0.75) / 0.25);
}

/** How far below the water surface a fully-submerged kept vertex is pushed. */
const SHORE_DIP = GLOBE_RADIUS * 0.022;

/**
 * Radius at which a vertex of the land mesh sits, given its terrain height.
 *
 * Vertices below sea level are sunk beneath the water sphere rather than
 * clamped to it. Without this, kept coastal faces all flatten onto one radius
 * and read as plates floating on the sea instead of a shore running into it.
 */
export function landRadius(h: number, seaLevel: number): number {
  if (h <= seaLevel) {
    const below = Math.min(1, (seaLevel - h) / 0.08);
    return GLOBE_RADIUS + COAST_LIFT - SHORE_DIP * below;
  }
  const a = Math.min(1, (h - seaLevel) / 0.6);
  // Eased so coastlines stay low and interiors rise.
  return GLOBE_RADIUS + COAST_LIFT + MAX_LAND_RELIEF * a * a;
}

export interface Land {
  mesh: THREE.Mesh;
  update(dt: number, env: WorldEnv): void;
}

/* ------------------------------------------------------------------ */
/* Per-pixel terrain shading (Stream C, docs/RENDER_PLAN.md)           */
/* ------------------------------------------------------------------ */

/**
 * Finite-difference step for slope, curvature and the per-pixel normal.
 *
 * Ship-scale (a fixed world-unit distance, not a fraction of the globe):
 * well under the ~2.2 unit triangle `landDetail` builds, so the derivative
 * reads the height field's own detail rather than averaging across a whole
 * facet, but not so small that it degenerates to the map's own texel noise.
 */
const SLOPE_STEP_WORLD = 1.2;

/**
 * Slope above which bare rock starts to show through the vertex-coloured
 * base -- dimensionless (height-field units per world unit), the same
 * metric `terrainSlope` below computes. Calibrated against the real terrain
 * field: roughly the 90th percentile of slope at SLOPE_STEP_WORLD, so only
 * genuinely steep ground reads as rocky rather than every hillside.
 */
const ROCK_SLOPE = 0.07;
/** Width of the smoothstep easing into "rock", same units as ROCK_SLOPE. */
const ROCK_SLOPE_SOFTNESS = 0.05;

/**
 * Height band above sea level darkened as wet sand -- the height field's own
 * normalized units (same scale as `terrain.seaLevel` and this file's
 * BEACH_BAND), not a world-unit distance.
 */
const WET_BAND = 0.012;
/** Colour multiplier at the waterline, easing to 1 (no darkening) over WET_BAND. */
const WET_DARKEN = 0.55;

/**
 * Scales the raw curvature (an unnormalized second difference of the height
 * field over SLOPE_STEP_WORLD, so this constant absorbs that step's units)
 * into a ridge-lighten / valley-darken multiplier, clamped to ±40% so a rare
 * sharp fold cannot blow a facet out to solid white or black. Calibrated so
 * the real terrain's 90th-percentile curvature reads as roughly a ±15% tint.
 */
const CURVATURE_TINT = 1.8;

/*
 * The blend between the flat geometric (low-poly facet) normal and a
 * per-pixel normal reconstructed from the height-map gradient -- 0 = pure
 * facets, 1 = fully smooth -- used to be a `FACET_BLEND = 0.4` here. It now
 * lives in the quality table as `landFacetBlend` (low 0.6, medium 0.8, high
 * 0.85): at 0.4 the facets were 60% of what the eye saw, and next to water
 * that reads as one continuous surface the land looked chipped out of a
 * block.
 *
 * It is the ONE tunable in this file fed to GLSL as a uniform rather than
 * baked into the source as a `*_C` const. Every other constant here is a
 * shape decision that only changes when someone edits this file, so baking
 * it lets the compiler fold it; this one has to differ per tier, and a
 * per-tier bake would make the shader source -- and so the program cache
 * key -- depend on the tier. A uniform is one register and no branch.
 */

/**
 * How strongly the height gradient tilts the per-pixel normal before the
 * facet blend. Dimensionless, in the same spirit as water.ts's `tilt`: the
 * raw gradient is small (terrain noise is broad relative to
 * SLOPE_STEP_WORLD), so this amplifies it into a visible tilt.
 *
 * Raised from 8 with the blend, and the number comes out of `landRadius`.
 * A gradient in height-field units becomes a real world slope through
 * d(radius)/dh = 2 * MAX_LAND_RELIEF * a / 0.6, i.e. between 0 at the
 * waterline and ~16.7 at full relief -- so a single strength can only be
 * honest at one elevation, and 8 was honest at a ~ 0.48. Above that it
 * UNDER-reads the slope, which did not matter while the facet normal (which
 * carries the true tilt) was 60% of the mix and matters a great deal at 15%.
 * Solving for the strength that reproduces the old blended tilt on a
 * 20-degree slope at a ~ 0.7 -- the hill-and-cliff band where relief
 * actually reads -- gives 9.8; at a ~ 0.85 it gives 11.0 and at a ~ 0.4 it
 * gives 7.2. 10 is the round number in the middle of the band that matters.
 */
const NORMAL_GRADIENT_STRENGTH = 10;

/**
 * Weight of the detail normal (below) where it applies in full. A mix
 * between the height-map normal and that same normal tilted by the fine
 * noise gradient, so 0 is today's surface and 1 is all grain; the mix is
 * between two unit vectors, which is what bounds a noise gradient that is
 * otherwise unbounded in slope.
 */
const DETAIL_NORMAL = 0.35;
/**
 * Finite-difference step for the detail normal, world units. About a third
 * of ROCK_WAVELENGTH_2: small enough to read the octave's own slope, large
 * enough that the difference is not two samples of the same lobe.
 */
const DETAIL_STEP_WORLD = 0.25;

/**
 * Distance fades, world units. The height map is 2048x1024 equirect, so a
 * texel is ~0.6 world units at the equator and every noise term above is
 * finer than that: at orbit height they all land inside one pixel and turn
 * into uniform grain, which is exactly what made land read as "rough" at
 * every zoom. Water solves this with `lod`/`nearMid`/`fadeFine`
 * (waterglsl.ts); these are the same shape.
 *
 * The detail normal goes to zero, because grain the eye cannot resolve is
 * only noise -- and going to zero is also what lets the two extra `snoise`
 * taps be branched away entirely, which is what keeps the orbit framing at
 * today's cost. The mottling and striation only go to half: they are colour
 * variation rather than surface detail, and a continent with none at all
 * reads as painted plastic.
 */
/*
 * The near pair opened at 18/40, which was a guess made before anyone had
 * sailed toward a coast with it on. On the actual chase camera 40 units is
 * practically beached: the detail normal fired only in the last moments of an
 * approach and was invisible on any land the player merely sails past, which
 * is most of the land they ever see. 28/70 puts it on a coastline being
 * approached without reaching orbit, and the branch below still switches the
 * two taps off entirely beyond it, so the cost argument is unchanged.
 */
const DETAIL_FADE_NEAR = 28;
const DETAIL_FADE_FAR = 70;
const GRAIN_FADE_NEAR = 45;
const GRAIN_FADE_FAR = 120;
const GRAIN_FADE_FLOOR = 0.5;

/**
 * Per-mask roughness for the `<roughnessmap_fragment>` chunk. The material's
 * own 0.88 (grass and forest) stays the base and is never restated here --
 * each of these is a mix away from whatever roughness the material carries.
 *
 * This is the only view-dependent term land has: at 0.88 a MeshStandard
 * surface has no usable specular lobe at all, which is why the sea has a sun
 * road, a rim and a sheen and the coast beside it has none of the three. Wet
 * sand is the shiniest thing on a beach, bare rock is polished by weather
 * where turf is not, and a snow-lit peak sits between them.
 */
const WET_ROUGHNESS = 0.45;
const ROCK_ROUGHNESS = 0.6;
const PEAK_ROUGHNESS = 0.7;
/**
 * Height band, in the height field's own units above sea level, over which
 * `colorForLand` is mixing rock into peak. Derived from that ramp rather
 * than typed again so the two cannot drift: `t` there is
 * (a - BEACH_BAND) / 0.5, and peak starts at t = 0.75.
 */
const PEAK_RAMP = 0.5;
const PEAK_START = BEACH_BAND + PEAK_RAMP * 0.75;
const PEAK_FULL = BEACH_BAND + PEAK_RAMP;

/**
 * Ambient occlusion strength: 0 leaves the surface fully lit regardless of
 * the baked value, 1 multiplies indirect and direct diffuse by it outright.
 * The plan's opening bid.
 */
const AO_STRENGTH = 0.8;
/** Soft edge, in degrees, between "sun above the baked horizon" and "sun
 * below it" -- a sun-tracking self shadow with no shadow map. */
const HORIZON_SOFTNESS_DEG = 4;

/** Two-octave direction-space noise strength, as a fraction of diffuseColor:
 * grass mottling applies everywhere, rock striation only where the
 * slope-driven rock mask above has already revealed rock. */
const MOTTLE_STRENGTH = 0.12;
const STRIATION_STRENGTH = 0.18;

/**
 * Mottling/striation wavelengths, world units. World-scale: converted to
 * 1/radian below exactly the way water.ts's wave frequencies are (see
 * `freq()`), so a fixed wavelength does not double in size with
 * GLOBE_RADIUS.
 */
const GRASS_WAVELENGTH_1 = 3.2;
const GRASS_WAVELENGTH_2 = 1.1;
const ROCK_WAVELENGTH_1 = 2.4;
const ROCK_WAVELENGTH_2 = 0.7;

/** Frequency in 1/radian for a wavelength given in world units. */
function freq(wavelengthWorld: number): string {
  return (GLOBE_RADIUS / wavelengthWorld).toFixed(4);
}

// UV-space finite-difference steps, precomputed at JS build time exactly
// like water.ts's freq()/drift() helpers. dv = step/(pi*R) is
// latitude-independent; du's cos(lat) division happens at runtime in the
// shader -- the equirect metric correction docs/RENDER_PLAN.md calls out as
// "the single easiest way to get this stream wrong".
const SLOPE_DV = (SLOPE_STEP_WORLD / (Math.PI * GLOBE_RADIUS)).toFixed(8);
const SLOPE_DU_BASE = (SLOPE_STEP_WORLD / (2 * Math.PI * GLOBE_RADIUS)).toFixed(8);
// The detail normal's step is taken along the unit-direction tangent frame,
// not in UV, so it is a plain angle: arc length over radius.
const DETAIL_STEP_RAD = (DETAIL_STEP_WORLD / GLOBE_RADIUS).toFixed(8);
const HORIZON_SOFTNESS_RAD = ((HORIZON_SOFTNESS_DEG * Math.PI) / 180).toFixed(8);
const HORIZON_MAX_RAD = ((HORIZON_MAX_DEGREES * Math.PI) / 180).toFixed(8);

/**
 * Declarations pasted at `<common>`: uniforms, the shared noise/height-map/
 * fog helpers, this file's tunables baked to GLSL constants, and two small
 * helper functions used by the later injection points.
 */
const FRAGMENT_DECLARATIONS = [
  'varying vec3 vTerrainDir;',
  'varying vec3 vTerrainWorldPos;',
  // Three auto-declares `normalMatrix` in the VERTEX prefix only (confirmed
  // against WebGLProgram's shader prefix generator) -- unlike
  // `cameraPosition`, which it declares in both. Redeclaring the ones it
  // does inject fails to compile per ARCHITECTURE's Shader notes; this one
  // it does not inject here, so it has to be declared for the fragment
  // stage to use it for the object-to-view normal transform below.
  'uniform mat3 normalMatrix;',
  'uniform sampler2D uHeightMap;',
  'uniform sampler2D uAux;',
  'uniform sampler2D uHorizon0;',
  'uniform sampler2D uHorizon1;',
  'uniform float uSeaLevel;',
  'uniform vec3 uSunDirection;',
  'uniform float uDayFactor;',
  // The quality table's `landFacetBlend`, and the one tunable here that is a
  // uniform rather than a baked const -- see the comment where FACET_BLEND
  // used to be, above, for why.
  'uniform float uFacetBlend;',
  NOISE_GLSL,
  HEIGHTMAP_GLSL,
  FOG_GLSL,
  `const float SLOPE_DV = ${SLOPE_DV};`,
  `const float SLOPE_DU_BASE = ${SLOPE_DU_BASE};`,
  `const float SLOPE_STEP_WORLD_C = ${SLOPE_STEP_WORLD.toFixed(4)};`,
  `const float ROCK_SLOPE_C = ${ROCK_SLOPE.toFixed(4)};`,
  `const float ROCK_SLOPE_SOFTNESS_C = ${ROCK_SLOPE_SOFTNESS.toFixed(4)};`,
  `const float WET_BAND_C = ${WET_BAND.toFixed(6)};`,
  `const float WET_DARKEN_C = ${WET_DARKEN.toFixed(4)};`,
  `const float CURVATURE_TINT_C = ${CURVATURE_TINT.toFixed(4)};`,
  `const float NORMAL_GRADIENT_STRENGTH_C = ${NORMAL_GRADIENT_STRENGTH.toFixed(4)};`,
  `const float DETAIL_NORMAL_C = ${DETAIL_NORMAL.toFixed(4)};`,
  `const float DETAIL_STEP_WORLD_C = ${DETAIL_STEP_WORLD.toFixed(4)};`,
  `const float DETAIL_STEP_RAD_C = ${DETAIL_STEP_RAD};`,
  `const float DETAIL_FADE_NEAR_C = ${DETAIL_FADE_NEAR.toFixed(4)};`,
  `const float DETAIL_FADE_FAR_C = ${DETAIL_FADE_FAR.toFixed(4)};`,
  `const float GRAIN_FADE_NEAR_C = ${GRAIN_FADE_NEAR.toFixed(4)};`,
  `const float GRAIN_FADE_FAR_C = ${GRAIN_FADE_FAR.toFixed(4)};`,
  `const float GRAIN_FADE_FLOOR_C = ${GRAIN_FADE_FLOOR.toFixed(4)};`,
  `const float WET_ROUGHNESS_C = ${WET_ROUGHNESS.toFixed(4)};`,
  `const float ROCK_ROUGHNESS_C = ${ROCK_ROUGHNESS.toFixed(4)};`,
  `const float PEAK_ROUGHNESS_C = ${PEAK_ROUGHNESS.toFixed(4)};`,
  `const float PEAK_START_C = ${PEAK_START.toFixed(6)};`,
  `const float PEAK_FULL_C = ${PEAK_FULL.toFixed(6)};`,
  `const float AO_STRENGTH_C = ${AO_STRENGTH.toFixed(4)};`,
  `const float HORIZON_SOFTNESS_RAD_C = ${HORIZON_SOFTNESS_RAD};`,
  `const float HORIZON_MAX_RAD_C = ${HORIZON_MAX_RAD};`,
  `const float MOTTLE_STRENGTH_C = ${MOTTLE_STRENGTH.toFixed(4)};`,
  `const float STRIATION_STRENGTH_C = ${STRIATION_STRENGTH.toFixed(4)};`,
  `const float GRASS_FREQ_1 = ${freq(GRASS_WAVELENGTH_1)};`,
  `const float GRASS_FREQ_2 = ${freq(GRASS_WAVELENGTH_2)};`,
  `const float ROCK_FREQ_1 = ${freq(ROCK_WAVELENGTH_1)};`,
  `const float ROCK_FREQ_2 = ${freq(ROCK_WAVELENGTH_2)};`,
  // Picks channel `i` (0-3, need not be a compile-time constant) out of a
  // vec4 without GLSL ES dynamic component indexing, via a one-hot mask
  // built from step() rather than a chain of if/else.
  'float terrainPick4(vec4 v, float i) {',
  '  vec4 lo = vec4(-0.5, 0.5, 1.5, 2.5);',
  '  vec4 hi = vec4(0.5, 1.5, 2.5, 3.5);',
  '  vec4 sel = step(lo, vec4(i)) - step(hi, vec4(i));',
  '  return dot(v, sel);',
  '}',
  // Decodes one of the 8 baked azimuths (0-7, wrapped) at `uv` into radians.
  'float terrainHorizonAt(sampler2D tex0, sampler2D tex1, vec2 uv, float azIndex) {',
  '  float i = mod(azIndex, 8.0);',
  '  vec4 t0 = texture2D(tex0, uv);',
  '  vec4 t1 = texture2D(tex1, uv);',
  '  float byteVal = i < 4.0 ? terrainPick4(t0, i) : terrainPick4(t1, i - 4.0);',
  '  return byteVal * HORIZON_MAX_RAD_C;',
  '}',
  // Local tangent frame at a unit direction, matching geo.ts's tangentFrame:
  // north toward +Y, east = cross(north, up). Used both to tilt the normal
  // and, later, to read the sun's bearing for the horizon-shadow test.
  'void terrainTangentFrame(vec3 up, out vec3 north, out vec3 east) {',
  '  vec3 worldUp = vec3(0.0, 1.0, 0.0);',
  '  vec3 n = worldUp - up * dot(worldUp, up);',
  '  if (dot(n, n) < 1e-8) {',
  '    n = vec3(0.0, 0.0, 1.0);',
  '    n -= up * dot(n, up);',
  '  }',
  '  north = normalize(n);',
  '  east = normalize(cross(north, up));',
  '}',
].join('\n');

/**
 * Injected right after `<color_fragment>` (which has just multiplied
 * `diffuseColor` by the vertex colour -- the PALETTE ramp from
 * `colorForLand` above). Everything here MODULATES that base rather than
 * replacing it, per the plan: samples height/slope/curvature from the
 * shared height map (5 taps: centre plus one step each side, north/south and
 * east/west, corrected for the equirect metric via SLOPE_DU_BASE/cos(lat)),
 * then darkens wet sand, reveals rock on steep slopes, tints ridges/valleys
 * by curvature, and mottles grass and striates rock with two-octave
 * direction-space noise (4 snoise calls total).
 *
 * It also builds the two distance fades and the masks that the later
 * injection points read: `<roughnessmap_fragment>` and
 * `<normal_fragment_maps>` both run after `<color_fragment>` in Three's
 * meshphysical fragment shader, in that order, and all three injections land
 * in the same function scope -- which is how the normal injection already
 * reuses this one's five height taps rather than taking them twice.
 */
const FRAGMENT_COLOR_INJECT = [
  '#include <color_fragment>',
  '',
  '// ---- terrain per-pixel shading (Stream C, docs/RENDER_PLAN.md) --------',
  'vec3 terrainUp = normalize(vTerrainDir);',
  'float terrainLat = asin(clamp(terrainUp.y, -1.0, 1.0));',
  'float terrainCosLat = max(cos(terrainLat), 0.05);',
  'vec2 terrainUv0 = dirToEquirect(terrainUp);',
  'float terrainDv = SLOPE_DV;',
  'float terrainDu = SLOPE_DU_BASE / terrainCosLat;',
  '',
  'float terrainH0 = texture2D(uHeightMap, terrainUv0).r;',
  'float terrainHE = texture2D(uHeightMap, terrainUv0 + vec2(terrainDu, 0.0)).r;',
  'float terrainHW = texture2D(uHeightMap, terrainUv0 - vec2(terrainDu, 0.0)).r;',
  'float terrainHN = texture2D(uHeightMap, terrainUv0 + vec2(0.0, terrainDv)).r;',
  'float terrainHS = texture2D(uHeightMap, terrainUv0 - vec2(0.0, terrainDv)).r;',
  '',
  'float terrainSlope = length(vec2(terrainHE - terrainHW, terrainHN - terrainHS)) / (2.0 * SLOPE_STEP_WORLD_C);',
  'float terrainCurvature = terrainHE + terrainHW + terrainHN + terrainHS - 4.0 * terrainH0;',
  '',
  '// ---- distance and grazing fades --------------------------------------',
  '// Built the way waterglsl.ts builds `lod`/`nearMid`/`fadeFine`, and for',
  '// the same reason: a pixel covers more ground both with distance and at',
  '// a grazing angle, and every noise term below is finer than a height-map',
  '// texel. Held at full amplitude the way they were, they are the same',
  '// grain from the deck and from orbit, which is what reads as roughness',
  '// rather than as texture.',
  'vec3 terrainToCam = cameraPosition - vTerrainWorldPos;',
  'float terrainCamDist = length(terrainToCam);',
  'vec3 terrainViewDir = terrainToCam / max(terrainCamDist, 1e-4);',
  'float terrainGraze = clamp(dot(terrainUp, terrainViewDir), 0.0, 1.0);',
  'float terrainLod = smoothstep(0.06, 0.38, terrainGraze);',
  'float terrainDetailFade = (1.0 - smoothstep(DETAIL_FADE_NEAR_C, DETAIL_FADE_FAR_C, terrainCamDist)) * terrainLod;',
  'float terrainGrainFade = mix(1.0, GRAIN_FADE_FLOOR_C, smoothstep(GRAIN_FADE_NEAR_C, GRAIN_FADE_FAR_C, terrainCamDist));',
  '',
  '// Wet sand: darken just above the waterline, fading out over WET_BAND.',
  'float terrainWetT = 1.0 - smoothstep(0.0, WET_BAND_C, max(0.0, terrainH0 - uSeaLevel));',
  'diffuseColor.rgb *= mix(1.0, WET_DARKEN_C, terrainWetT);',
  '',
  '// Rock reveal on steep slopes: desaturate and darken slightly, modulating',
  '// the vertex-coloured base rather than replacing it with a flat colour.',
  'float terrainRockMask = smoothstep(ROCK_SLOPE_C, ROCK_SLOPE_C + ROCK_SLOPE_SOFTNESS_C, terrainSlope);',
  'float terrainGrey = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));',
  'diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, vec3(terrainGrey), 0.6) * 0.85, terrainRockMask);',
  '',
  '// Ridge lighten / valley darken from curvature.',
  'diffuseColor.rgb *= 1.0 + clamp(terrainCurvature * CURVATURE_TINT_C, -0.4, 0.4);',
  '',
  '// Two-octave direction-space noise: grass mottling everywhere, rock',
  '// striation only where the slope mask above has already revealed rock.',
  '// Both are held down by terrainGrainFade with distance rather than being',
  '// the same amplitude at every zoom.',
  'float terrainMottle = snoise(terrainUp * GRASS_FREQ_1) * 0.6 + snoise(terrainUp * GRASS_FREQ_2) * 0.4;',
  'diffuseColor.rgb *= 1.0 + terrainMottle * MOTTLE_STRENGTH_C * terrainGrainFade;',
  '// ROCK_FREQ_2 is 0.7 world units, which is also the wavelength the detail',
  '// normal wants, so this centre tap is deliberately shared with it: the',
  '// grain and the streaks are then the same rock rather than two unrelated',
  '// fields, and the normal injection needs only its two offset taps to stay',
  '// inside the stream\'s +2 snoise budget.',
  'float terrainDetail = snoise(terrainUp * ROCK_FREQ_2);',
  'float terrainStriation = snoise(terrainUp * ROCK_FREQ_1) * 0.6 + terrainDetail * 0.4;',
  'diffuseColor.rgb *= 1.0 + terrainStriation * STRIATION_STRENGTH_C * terrainRockMask * terrainGrainFade;',
  '',
  '// The peak band, for roughness below: the same slice of the height ramp',
  '// `colorForLand` is mixing rock into peak over.',
  'float terrainPeakMask = smoothstep(PEAK_START_C, PEAK_FULL_C, terrainH0 - uSeaLevel);',
].join('\n');

/**
 * Injected right after `<roughnessmap_fragment>`, which has just set
 * `roughnessFactor` from the material's own `roughness` (0.88).
 *
 * At 0.88 across the whole surface there is no usable specular lobe
 * anywhere: no glint, no Fresnel rim, nothing that changes as the camera
 * moves. The water beside it has all three, and that difference alone is
 * most of why land reads as clay next to a sea that reads as water. Driving
 * roughness from the masks this file already computes costs nothing -- the
 * masks exist -- and gives the coast a wet sheen, the cliffs a hard
 * highlight and the turf exactly what it has today.
 */
const FRAGMENT_ROUGHNESS_INJECT = [
  '#include <roughnessmap_fragment>',
  '',
  '// Each of these is a mix away from whatever the material carries, so the',
  '// grass/forest case stays the material\'s own roughness by construction',
  '// rather than by a constant repeated here. Wet sand is applied last: at',
  '// the waterline it is the whole surface, whatever else is under it.',
  'roughnessFactor = mix(roughnessFactor, ROCK_ROUGHNESS_C, terrainRockMask);',
  'roughnessFactor = mix(roughnessFactor, PEAK_ROUGHNESS_C, terrainPeakMask);',
  'roughnessFactor = mix(roughnessFactor, WET_ROUGHNESS_C, terrainWetT);',
].join('\n');

/**
 * Injected right after `<normal_fragment_maps>`, once the flat/geometric
 * `normal` (view space) exists. Reconstructs a per-pixel normal from the
 * same height taps `FRAGMENT_COLOR_INJECT` already sampled, tilts it by the
 * gradient, adds a fine detail tilt where the surface is rock and the camera
 * is close enough to resolve it, transforms the result into view space with
 * `normalMatrix` (already declared by Three; never redeclared here), and
 * blends it with the facet normal at `uFacetBlend`.
 *
 * The height map is 2048x1024 equirect, so its texels are ~0.6 world units
 * apart at the equator and there is simply no data between them: from the
 * deck a cliff face is smooth and blank however hard the gradient is
 * pushed. The detail octave is the only thing here that adds information
 * rather than amplifying what the map already holds.
 */
const FRAGMENT_NORMAL_INJECT = [
  '#include <normal_fragment_maps>',
  '',
  '// Blend the flat geometric (low-poly facet) normal with a per-pixel',
  '// normal from the height-map gradient -- uFacetBlend toward 0 keeps the',
  '// facets, toward 1 reads as fully smooth. Neither extreme is the target.',
  'vec3 terrainNorth;',
  'vec3 terrainEast;',
  'terrainTangentFrame(terrainUp, terrainNorth, terrainEast);',
  'float terrainGradE = (terrainHE - terrainHW) / (2.0 * SLOPE_STEP_WORLD_C);',
  'float terrainGradN = (terrainHN - terrainHS) / (2.0 * SLOPE_STEP_WORLD_C);',
  'vec3 terrainHeightNormalObj = normalize(terrainUp - (terrainEast * terrainGradE + terrainNorth * terrainGradN) * NORMAL_GRADIENT_STRENGTH_C);',
  '',
  '// Detail normal: the fine octave already sampled at the centre for the',
  '// striation, finite-differenced along the same tangent frame. Masked to',
  '// rock so turf stays soft and stone gets grain, and branched on the fade',
  '// so the two taps are not paid for at all past DETAIL_FADE_FAR -- which',
  '// is what returns the orbit framing to its old cost. The branch is',
  '// coherent at that range (the whole screen fails it together), which is',
  '// the only kind of branch worth writing in a fragment shader.',
  'float terrainDetailAmt = DETAIL_NORMAL_C * terrainRockMask * terrainDetailFade;',
  'if (terrainDetailAmt > 0.002) {',
  '  float terrainDetailE = snoise((terrainUp + terrainEast * DETAIL_STEP_RAD_C) * ROCK_FREQ_2);',
  '  float terrainDetailN = snoise((terrainUp + terrainNorth * DETAIL_STEP_RAD_C) * ROCK_FREQ_2);',
  '  vec3 terrainDetailTilt = terrainEast * (terrainDetailE - terrainDetail) + terrainNorth * (terrainDetailN - terrainDetail);',
  '  // The tilt is applied to the height normal and re-normalized BEFORE the',
  '  // mix, so the mix is between two unit vectors that differ only by the',
  '  // grain. Mixing toward a normal built around `terrainUp` instead would',
  '  // pull the macro slope back toward flat, and a noise gradient has no',
  '  // bound on its slope, so this is also what keeps a rare steep lobe from',
  '  // flipping the normal outright.',
  '  vec3 terrainDetailNormalObj = normalize(terrainHeightNormalObj - terrainDetailTilt / DETAIL_STEP_WORLD_C);',
  '  terrainHeightNormalObj = normalize(mix(terrainHeightNormalObj, terrainDetailNormalObj, terrainDetailAmt));',
  '}',
  '',
  'vec3 terrainHeightNormalView = normalize(normalMatrix * terrainHeightNormalObj);',
  'normal = normalize(mix(normal, terrainHeightNormalView, uFacetBlend));',
].join('\n');

/**
 * Injected right after `<lights_fragment_end>`, once `reflectedLight`'s four
 * fields are final. Multiplies indirect and direct diffuse (and indirect
 * specular) by the baked ambient occlusion, then compares the sun's
 * elevation at this point against the baked horizon angle -- interpolated
 * between the two nearest of the 8 azimuths by the sun's bearing in the
 * local tangent frame `FRAGMENT_NORMAL_INJECT` just built -- and attenuates
 * direct diffuse over a soft edge. This is the "sun-tracking self shadow
 * with no shadow map" the plan asks for; it approximates by scaling every
 * direct light together rather than isolating the sun's own contribution
 * from the rig's fill lights, which is simpler and, since a ridge blocking
 * the sun plausibly dims the whole area, a reasonable reading of the brief.
 */
const FRAGMENT_LIGHTS_INJECT = [
  '#include <lights_fragment_end>',
  '',
  '// Ambient occlusion, baked once at startup (terrainbake.ts).',
  'float terrainAO = texture2D(uAux, terrainUv0).r;',
  'float terrainAOFactor = mix(1.0, terrainAO, AO_STRENGTH_C);',
  'reflectedLight.indirectDiffuse *= terrainAOFactor;',
  'reflectedLight.indirectSpecular *= terrainAOFactor;',
  'reflectedLight.directDiffuse *= terrainAOFactor;',
  '',
  '// Sun-tracking self shadow: the sun\'s elevation here against the baked',
  '// horizon angle interpolated between the two nearest azimuths.',
  'vec3 terrainSunDir = normalize(uSunDirection);',
  'vec3 terrainSunTangent = terrainSunDir - terrainUp * dot(terrainSunDir, terrainUp);',
  'float terrainSunBearing = 0.0;',
  'if (dot(terrainSunTangent, terrainSunTangent) > 1e-10) {',
  '  terrainSunBearing = atan(dot(terrainSunTangent, terrainEast), dot(terrainSunTangent, terrainNorth));',
  '  if (terrainSunBearing < 0.0) terrainSunBearing += 6.28318530718;',
  '}',
  'float terrainAzIndex = terrainSunBearing / 6.28318530718 * 8.0;',
  'float terrainAz0 = floor(terrainAzIndex);',
  'float terrainAzFrac = terrainAzIndex - terrainAz0;',
  'float terrainAz1 = mod(terrainAz0 + 1.0, 8.0);',
  'float terrainHz0 = terrainHorizonAt(uHorizon0, uHorizon1, terrainUv0, terrainAz0);',
  'float terrainHz1 = terrainHorizonAt(uHorizon0, uHorizon1, terrainUv0, terrainAz1);',
  'float terrainHorizonAngle = mix(terrainHz0, terrainHz1, terrainAzFrac);',
  'float terrainSunElevation = asin(clamp(dot(terrainSunDir, terrainUp), -1.0, 1.0));',
  'float terrainSunVisible = smoothstep(-HORIZON_SOFTNESS_RAD_C, HORIZON_SOFTNESS_RAD_C, terrainSunElevation - terrainHorizonAngle);',
  'reflectedLight.directDiffuse *= terrainSunVisible;',
].join('\n');

/**
 * Injected in place of `<opaque_fragment>` (which still runs, via the
 * re-included marker below): calls `applyAerial` on `outgoingLight` before
 * that chunk turns it into `gl_FragColor`, and before the composer's chained
 * sRGB self-encode (see postfx.ts) touches it -- "before the encode", as the
 * plan asks. `fogUniforms` is merged into this material's uniforms below, so
 * land and water always agree on the fog colours within a frame.
 */
const FRAGMENT_OPAQUE_INJECT = [
  'outgoingLight = applyAerial(outgoingLight, vTerrainWorldPos, cameraPosition, normalize(uSunDirection), uDayFactor);',
  '#include <opaque_fragment>',
].join('\n');

const VERTEX_COMMON_INJECT = [
  '#include <common>',
  'varying vec3 vTerrainDir;',
  'varying vec3 vTerrainWorldPos;',
].join('\n');

const VERTEX_BEGIN_INJECT = [
  '#include <begin_vertex>',
  'vTerrainDir = normalize(transformed);',
  'vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
].join('\n');

/**
 * Icosphere subdivision.
 *
 * Sized so a triangle stays about 2.2 world units across -- a little under half
 * the ship's length -- which is the low-poly look the world is built around.
 * It is quadratic in cost, both in triangles and in the terrain samples taken
 * to build them, so it tracks the radius rather than being fixed: at
 * GLOBE_RADIUS 100 the high tier is 96, the value the look was tuned at.
 *
 * The 96 is the quality table's `landDetail` now, because until this became a
 * row there was no tier that could say anything about it at all: one icosphere
 * of 745k source triangles, filtered to 289k that survive the cull below, on
 * every machine that could open the page. That is the largest single vertex
 * buffer the game allocates and it is paid at startup, before a frame is ever
 * drawn. High keeps the 96 exactly -- `world-golden.json` pins the surviving
 * vertex count at that tier -- and low and medium buy back a mesh two thirds
 * and five sixths as fine.
 *
 * What the lower tiers do NOT give up is which islands exist. All 93 of the
 * world's landmasses still carry icosphere vertices above sea level at two
 * thirds of this, and at a third of it: none of them vanishes. What a coarser
 * sphere costs is how wide the beach triangle straddling the waterline is,
 * and that does show on the smallest. The smallest islet in the world is 25
 * square units, about six across; `high` draws it with 50 triangles, 16 of
 * them wholly above water, and `low` with 28, of which 6 are. Its drawn
 * footprint grows about a quarter in the trade, against 3% for the world's
 * land taken together. So a small island's outline softens on `low`, and
 * nobody has yet checked that by eye.
 *
 * The shape the player steers around is not this mesh in any case. Collision
 * asks `terrain.isLand`, and the coastline the eye reads -- the foam line,
 * the shallow ramp, this file's own per-pixel slope and wetness -- comes from
 * the height map at full resolution whatever the geometry underneath it is
 * doing.
 */
function landDetail(quality: Quality): number {
  return Math.round((quality.landDetail * GLOBE_RADIUS) / 100);
}

/**
 * Land-only mesh.
 *
 * An icosphere is generated, then every face lying entirely below sea level is
 * discarded, so only continents and islands remain. Everything below is left to
 * the water surface. PolyhedronGeometry is non-indexed, which makes the face
 * filter a simple stride-9 walk over the position buffer.
 *
 * Heights come from the shared height map rather than from `terrain.heightAt`.
 * That is not only far cheaper -- a bilinear read against fifteen octaves of
 * fBm, three times per face, half a million faces -- it is also more correct:
 * the water shader reads the same texture, so land and sea agree on exactly
 * where the coastline is instead of differing by whatever the raster lost. The
 * map is finer than this mesh by a factor of three, so nothing is given up.
 *
 * The material stays a `MeshStandardMaterial` -- it keeps the three-light rig
 * and is shadow-ready -- extended through `onBeforeCompile` per
 * docs/RENDER_PLAN.md Phase 1 stream C, so the flat vertex-coloured look does
 * not read as clay: per-pixel slope, curvature, wetness and noise modulate the
 * PALETTE base, a baked ambient-occlusion and 8-azimuth horizon shadow light
 * it, a height-gradient normal plus a fine detail octave soften (never
 * replace) the low-poly facets, and the same masks drive roughness so wet
 * sand and bare rock catch the sun the way the water beside them does.
 * `postfx.ts`'s chained `onBeforeCompile` (Phase 0 / Q) is what makes
 * this legal: this hook runs first, then the composer's sRGB self-encode
 * chains on top untouched.
 */
export function createLand(terrain: Terrain, heightMap: HeightMap, quality: Quality): Land {
  const source = new THREE.IcosahedronGeometry(GLOBE_RADIUS, landDetail(quality));
  const srcPos = source.attributes.position as THREE.BufferAttribute;
  const faceCount = srcPos.count / 3;

  const keptPositions: number[] = [];
  const keptColors: number[] = [];

  const dir = new THREE.Vector3();
  const color = new THREE.Color();
  const cutoff = terrain.seaLevel - CULL_MARGIN;

  const vh = [0, 0, 0];
  const vx = [0, 0, 0];
  const vy = [0, 0, 0];
  const vz = [0, 0, 0];

  for (let f = 0; f < faceCount; f++) {
    let anyLand = false;

    for (let k = 0; k < 3; k++) {
      const i = f * 3 + k;
      dir.fromBufferAttribute(srcPos, i).normalize();
      const h = heightMap.sample(dir);
      vh[k] = h;
      vx[k] = dir.x;
      vy[k] = dir.y;
      vz[k] = dir.z;
      if (h > cutoff) anyLand = true;
    }

    // Keep any face touching land, so coastlines get a full triangle of beach
    // rather than a ragged edge.
    if (!anyLand) continue;

    for (let k = 0; k < 3; k++) {
      const r = landRadius(vh[k], terrain.seaLevel);
      keptPositions.push(vx[k] * r, vy[k] * r, vz[k] * r);
      colorForLand(vh[k], terrain.seaLevel, color);
      keptColors.push(color.r, color.g, color.b);
    }
  }

  source.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(keptPositions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(keptColors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  // The startup bake (terrainbake.ts): ambient occlusion and 8-azimuth
  // horizon angles over the shared height map. Called here, inside
  // createLand, rather than from globe.ts (which C does not own) -- globe.ts
  // already constructs `land` after `cullIslets` has run and `flush()` has
  // been called, which is the ordering the bake requires: baking any earlier
  // would occlude islands about to be sunk and never drawn.
  const bake = bakeTerrain(heightMap, terrain.seaLevel);
  heightMap.aux = bake.aux;
  heightMap.horizon = bake.horizon;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.88,
    metalness: 0.02,
  });

  const uniforms: Record<string, THREE.IUniform> = {
    uHeightMap: { value: heightMap.texture },
    uAux: { value: bake.aux },
    uHorizon0: { value: bake.horizon[0] },
    uHorizon1: { value: bake.horizon[1] },
    uSeaLevel: { value: terrain.seaLevel },
    uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
    uDayFactor: { value: 1 },
    // The quality table's `landFacetBlend`. `globe.ts` builds the land
    // without handing it a Quality, so this reads the one `main.ts` already
    // Handed in by `globe.ts`, which already holds the session's settings.
    uFacetBlend: { value: quality.landFacetBlend },
    // Aerial perspective (`fogglsl.ts`'s contract): the one shared object, so
    // land and water always agree on the fog within a frame.
    ...fogUniforms,
  };

  material.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERTEX_COMMON_INJECT)
      .replace('#include <begin_vertex>', VERTEX_BEGIN_INJECT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_DECLARATIONS)
      .replace('#include <color_fragment>', FRAGMENT_COLOR_INJECT)
      .replace('#include <roughnessmap_fragment>', FRAGMENT_ROUGHNESS_INJECT)
      .replace('#include <normal_fragment_maps>', FRAGMENT_NORMAL_INJECT)
      .replace('#include <lights_fragment_end>', FRAGMENT_LIGHTS_INJECT)
      .replace('#include <opaque_fragment>', FRAGMENT_OPAQUE_INJECT);
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'land';

  return {
    mesh,
    update(_dt: number, env: WorldEnv): void {
      // Land is static; only the shading uniforms move with the day/night
      // cycle. No allocation: copy() writes into the uniform's own Vector3.
      uniforms.uSunDirection.value.copy(env.sunDirection);
      uniforms.uDayFactor.value = env.dayFactor;
    },
  };
}
