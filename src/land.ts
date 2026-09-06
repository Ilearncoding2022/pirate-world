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
 * well under LAND_DETAIL's ~2.2 unit triangle, so the derivative reads the
 * height field's own detail rather than averaging across a whole facet, but
 * not so small that it degenerates to the map's own texel noise.
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

/**
 * Blend between the flat geometric (low-poly facet) normal and a per-pixel
 * normal reconstructed from the height-map gradient. 0 = pure facets, 1 =
 * fully smooth. The art direction wants beveled low-poly forms -- not flat
 * blocks, not photoreal -- so 0.4 is an opening bid at neither extreme.
 */
const FACET_BLEND = 0.4;
/**
 * How strongly the height gradient tilts the per-pixel normal before the
 * FACET_BLEND mix. Dimensionless, in the same spirit as water.ts's `tilt`:
 * the raw gradient is small (terrain noise is broad relative to
 * SLOPE_STEP_WORLD), so this amplifies it into a visible tilt.
 */
const NORMAL_GRADIENT_STRENGTH = 8;

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
  `const float FACET_BLEND_C = ${FACET_BLEND.toFixed(4)};`,
  `const float NORMAL_GRADIENT_STRENGTH_C = ${NORMAL_GRADIENT_STRENGTH.toFixed(4)};`,
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
  'float terrainMottle = snoise(terrainUp * GRASS_FREQ_1) * 0.6 + snoise(terrainUp * GRASS_FREQ_2) * 0.4;',
  'diffuseColor.rgb *= 1.0 + terrainMottle * MOTTLE_STRENGTH_C;',
  'float terrainStriation = snoise(terrainUp * ROCK_FREQ_1) * 0.6 + snoise(terrainUp * ROCK_FREQ_2) * 0.4;',
  'diffuseColor.rgb *= 1.0 + terrainStriation * STRIATION_STRENGTH_C * terrainRockMask;',
].join('\n');

/**
 * Injected right after `<normal_fragment_maps>`, once the flat/geometric
 * `normal` (view space) exists. Reconstructs a per-pixel normal from the
 * same height taps `FRAGMENT_COLOR_INJECT` already sampled, tilts it by the
 * gradient, transforms it into view space with `normalMatrix` (already
 * declared by Three; never redeclared here), and blends it with the facet
 * normal at FACET_BLEND.
 */
const FRAGMENT_NORMAL_INJECT = [
  '#include <normal_fragment_maps>',
  '',
  '// Blend the flat geometric (low-poly facet) normal with a per-pixel',
  '// normal from the height-map gradient -- FACET_BLEND toward 0 keeps the',
  '// facets, toward 1 reads as fully smooth. Neither extreme is the target.',
  'vec3 terrainNorth;',
  'vec3 terrainEast;',
  'terrainTangentFrame(terrainUp, terrainNorth, terrainEast);',
  'float terrainGradE = (terrainHE - terrainHW) / (2.0 * SLOPE_STEP_WORLD_C);',
  'float terrainGradN = (terrainHN - terrainHS) / (2.0 * SLOPE_STEP_WORLD_C);',
  'vec3 terrainHeightNormalObj = normalize(terrainUp - (terrainEast * terrainGradE + terrainNorth * terrainGradN) * NORMAL_GRADIENT_STRENGTH_C);',
  'vec3 terrainHeightNormalView = normalize(normalMatrix * terrainHeightNormalObj);',
  'normal = normalize(mix(normal, terrainHeightNormalView, FACET_BLEND_C));',
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
 * GLOBE_RADIUS 100 this is 96, the value the look was tuned at.
 */
const LAND_DETAIL = Math.round((96 * GLOBE_RADIUS) / 100);

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
 * it, and a height-gradient normal softens (never replaces) the low-poly
 * facets. `postfx.ts`'s chained `onBeforeCompile` (Phase 0 / Q) is what makes
 * this legal: this hook runs first, then the composer's sRGB self-encode
 * chains on top untouched.
 */
export function createLand(terrain: Terrain, heightMap: HeightMap): Land {
  const source = new THREE.IcosahedronGeometry(GLOBE_RADIUS, LAND_DETAIL);
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
