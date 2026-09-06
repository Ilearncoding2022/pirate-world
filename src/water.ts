import * as THREE from 'three';
import type { Terrain } from './types';
import type { WorldEnv } from './env';
import type { HeightMap } from './heightmap';
import { HEIGHTMAP_GLSL } from './heightmap';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS } from './geo';
import type { ShipState, WindState } from './types';
import { OCEAN_CAP } from './wind';
import { NOISE_GLSL } from './noiseglsl';
import { FOG_GLSL } from './fogglsl';
import { fogUniforms } from './fog';
import {
  WATER_UNIFORMS,
  waterWavefield,
  waterDepth,
  WATER_LIGHTING_HEAD,
  WATER_LIGHTING_TAIL,
  waterFoam,
  WATER_FOAM_TAIL,
  WATER_OUTPUT,
} from './waterglsl';

export interface Water {
  mesh: THREE.Mesh;
  update(dt: number, env: WorldEnv, wind: WindState, ship: ShipState, camera: THREE.Camera): void;
}

/**
 * The four points in the fragment shader a plugin may hook into. Documented,
 * with the GLSL variables in scope at each, in `waterglsl.ts` above the chunk
 * that contains the seam.
 */
export type WaterHook = 'normal' | 'foam' | 'reflection' | 'colour';

/**
 * What Phase 1 streams A (wake), B (offsets only, see `water.offsets` below),
 * D (reflection) and E (lighting/fog) each add to the water shader, instead
 * of all editing `water.ts` at once.
 *
 * Uniform names are prefixed per plugin (`uWake…`, `uRefl…`, …) so two
 * plugins can never collide.
 */
export interface WaterPlugin {
  name: string;
  uniforms: Record<string, THREE.IUniform>;
  /** GLSL pasted before main(): uniforms, samplers, helper functions. */
  declarations: string;
  /** Each hook is a GLSL statement block, or omitted. See the slots. */
  hooks: Partial<Record<WaterHook, string>>;
  update?(dt: number, env: WorldEnv, ship: ShipState, camera: THREE.Camera): void;
}

/** Every plugin's `declarations`, in registration order, skipping the empty ones. */
function pluginDeclarations(plugins: WaterPlugin[]): string[] {
  return plugins.map((p) => p.declarations).filter((d) => d.length > 0);
}

/** One hook slot's code across every plugin that fills it, in registration order. */
function pluginHooks(plugins: WaterPlugin[], hook: WaterHook): string[] {
  const lines: string[] = [];
  for (const plugin of plugins) {
    const code = plugin.hooks[hook];
    if (code) lines.push(code);
  }
  return lines;
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
 * Water surface: one full sphere at exactly GLOBE_RADIUS.
 *
 * Land sits above it and hides the parts that are dry, so this mesh stays
 * low-poly and smooth. Every bit of surface detail — waves, glint, shallows and
 * surf — is computed per pixel; the geometry only has to be round.
 *
 * Layout of the fragment shader (chunks live in `waterglsl.ts`; see its
 * top-of-file comment for the exact assembly order and the four plugin hook
 * seams):
 *   1. three drifting simplex octaves make a height field over the sphere
 *      direction; three taps of it give a tangent-space gradient, which tilts
 *      the shading normal (`normal` hook runs right after). High octaves fade
 *      out with camera distance so the whole planet does not boil into
 *      aliased noise.
 *   2. depth ramp from the shared height map, as before, plus a shallow-water
 *      caustic ripple driven by the same wave field.
 *   3. Blinn-Phong glint (sharp + wide lobe) against env.sunDirection, gated by
 *      Fresnel and by the geometric day/night term so it sweeps with the sun
 *      (`reflection` hook runs partway through, right after the sky colour).
 *   4. a coastal foam band whose outer edge breathes on a per-place phase, with
 *      a breaker line running shoreward (`foam` hook runs right after, and
 *      unlike the rest also fires far from any coast -- see `waterglsl.ts`).
 *   5. the whole thing crossfades to a near-black ambient on the night side,
 *      then `colour` hook plugins and `applyAerial` (the aerial-perspective
 *      contract; see `fogglsl.ts`) get a last pass at `col` before the sRGB
 *      encode.
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
  plugins: WaterPlugin[] = [],
): Water {
  // Detail is fragment-side; the geometry only needs a smooth silhouette.
  // Segment counts track the radius: the chords have to sag less than
  // `wake.ts`'s SURFACE_LIFT clears, and the silhouette has to stay round.
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 256, 128);

  const uniforms: Record<string, THREE.IUniform> = {
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
    // Aerial perspective (`fogglsl.ts`'s contract): one shared object so the
    // water and the land (once Stream C lands) always agree on the fog.
    ...fogUniforms,
  };
  for (const plugin of plugins) {
    Object.assign(uniforms, plugin.uniforms);
  }

  const vertexShader = [
    'varying vec3 vDir;',
    'varying vec3 vWorldPos;',
    'void main() {',
    '  vDir = normalize(position);',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  #ifdef WATER_DISPLACED',
    '  #endif',
    '  vWorldPos = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}',
  ].join('\n');

  const fragmentShader = [
    ...WATER_UNIFORMS,
    NOISE_GLSL,
    HEIGHTMAP_GLSL,
    FOG_GLSL,
    ...pluginDeclarations(plugins),
    ...waterWavefield(freq(SWELL_WAVELENGTH), freq(WAVE_WAVELENGTH), freq(CHOP_WAVELENGTH)),
    ...waterDepth((NORMAL_STEP / GLOBE_RADIUS).toFixed(8)),
    ...pluginHooks(plugins, 'normal'),
    ...WATER_LIGHTING_HEAD,
    ...pluginHooks(plugins, 'reflection'),
    ...WATER_LIGHTING_TAIL,
    ...waterFoam(
      freq(FOAM_COARSE_WAVELENGTH),
      drift(FOAM_COARSE_DRIFT),
      freq(FOAM_SPECK_WAVELENGTH),
      drift(FOAM_SPECK_DRIFT),
    ),
    ...pluginHooks(plugins, 'foam'),
    ...WATER_FOAM_TAIL,
    ...pluginHooks(plugins, 'colour'),
    '  col = applyAerial(col, vWorldPos, cameraPosition, sunDir, uDayFactor);',
    ...WATER_OUTPUT,
  ].join('\n');

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    // Empty until Stream B's displacement patch reuses this same fragment
    // shader with WATER_DISPLACED set; the sphere itself never defines it.
    defines: {},
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water';
  mesh.renderOrder = -1;

  return {
    mesh,
    update(dt: number, env: WorldEnv, wind: WindState, ship: ShipState, camera: THREE.Camera): void {
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

      // The wake map and the reflection cube both follow the ship, so every
      // plugin's own update gets it and the camera directly.
      for (const plugin of plugins) {
        plugin.update?.(dt, env, ship, camera);
      }
    },
  };
}
