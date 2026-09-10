import * as THREE from 'three';
import type { Water } from './water';
import type { ShipState } from './types';
import type { Quality } from './quality';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { NOISE_GLSL } from './noiseglsl';
import { waterWavefield } from './waterglsl';
import { HAZARD_GLSL } from './hazardfield';
import {
  SWELL_WAVELENGTH,
  WAVE_WAVELENGTH,
  CHOP_WAVELENGTH,
  DISPLACE_AMPLITUDE,
  freq,
} from './waveconstants';

/**
 * A dense, ship-following patch of the sea that actually displaces in the
 * vertex shader -- the distant full sphere in `water.ts` stays a smooth,
 * undisplaced shell; only the water near the ship gets real geometric height.
 *
 * Uses the SAME fragment shader `water.ts` built for the sphere (read off
 * `water.mesh.material.fragmentShader` at construction time, byte for byte,
 * `WATER_DISPLACED` defined in `defines`), with its own vertex shader that
 * displaces a flat grid onto the sphere and bumps it by the wave field.
 * `wavefield.ts` is the CPU twin of the same field, so the hull rides
 * whatever this patch actually draws.
 */
export interface WaterPatch {
  mesh: THREE.Mesh;
  update(dt: number, ship: ShipState): void;
}

/**
 * Size of the patch, world units (ship-scale: an absolute size that does not
 * grow with GLOBE_RADIUS -- see docs/ARCHITECTURE.md "World scale"). Square,
 * centred under the ship.
 */
const PATCH_EXTENT = 80;

/**
 * Fraction of the patch's half-extent, from the centre, where the skirt
 * begins fading displacement to zero (ship-scale, dimensionless: a fraction
 * of PATCH_EXTENT). The outer 15% is fully faded by the edge, which is what
 * lets the patch meet the undisplaced sphere without a visible seam.
 */
const SKIRT_START = 0.85;

/**
 * Polygon offset pushed toward the camera so the skirt does not z-fight the
 * sphere it fades into. Unitless, in the driver's own depth-bias units (the
 * same mechanism `THREE.Material.polygonOffsetFactor/Units` always uses).
 */
const PATCH_POLYGON_OFFSET_FACTOR = -1;
const PATCH_POLYGON_OFFSET_UNITS = -4;

/**
 * Half-size of the square footprint the SPHERE stops drawing inside, world
 * units, so the patch alone owns those pixels. Read by `waterSurface()` in
 * `waterglsl.ts` through `uPatchCull`.
 *
 * The polygon offset above is why this has to exist at all. It is a depth
 * BIAS -- a few units in the depth buffer -- and it is enough to stop the
 * skirt z-fighting the shell it fades into, which is all it was ever asked
 * to do. It is nothing at all against a maelstrom, which pushes this patch
 * SIX WORLD UNITS below that shell: every pixel of the funnel's inside is
 * then behind the sphere's own flat water along the view ray, and the depth
 * test throws it away. The funnel drew its foam ring and its spiral onto a
 * surface that was never allowed to descend, which is exactly how a 20-unit
 * hole reads as a decal on flat sea from the deck.
 *
 * A crest never showed the fault because a crest goes UP, where nothing is
 * in front of it. That is why doubling FUNNEL_DEPTH from 3.0 to 6.0 bought
 * nothing on screen: both depths were behind the same shell.
 *
 * Inset from the patch's own half-extent rather than equal to it, and the
 * margin is not decoration. The patch's vertices are projected onto the
 * sphere (`normalize(tangentPos)`), so its true footprint measured the way
 * the cut measures it -- a dot product against the tangent axes -- comes up
 * about 0.05 units SHORT of 40 at the mid-edge and further short at the
 * corners. Cutting at exactly 40 would leave a thread of unpainted space
 * between the two. 1.5 units is far past that curvature error and still well
 * outside SKIRT_START, so everything cut away is covered by patch that is
 * either undisplaced or within a rounding error of it.
 */
const PATCH_CULL_HALF = PATCH_EXTENT * 0.5 - 1.5;

const _raw = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _north = new THREE.Vector3();
const _east = new THREE.Vector3();

/**
 * Builds the ship-following displacement patch.
 *
 * `water` must already exist (`water.mesh.material` is read once, here, to
 * copy its current fragment shader and share its uniform objects by
 * reference -- so `uTime`, `uOffsetSwell`, `uWaveIntensity` and the rest stay
 * numerically identical between the sphere and the patch with no extra
 * per-frame bookkeeping in this file).
 */
export function createWaterPatch(water: Water, quality: Quality): WaterPatch {
  const sphereMaterial = water.mesh.material as THREE.ShaderMaterial;

  /*
   * `patchSegments` is 96/128/160, so a vertex every 0.84/0.63/0.50 world
   * units across PATCH_EXTENT. docs/TEXTURE_PLAN.md's Wave 3 held a row to
   * take the high tier to 192 -- 0.42 units -- once the shader work had
   * landed and the maelstrom's rim could be judged again. It landed; this is
   * the answer, written here rather than left as a number nobody can account
   * for.
   *
   * The two features the rise was for are the maelstrom's lip, 3.6 units
   * wide (hazardfield.ts's HAZ_RIM_C +/- 1/HAZ_RIM_INV, on a radius of 10),
   * and the tallest wave's front face, 2.0 units (CREST_HALF_WIDTH *
   * CREST_FRONT_RATIO). At 160 the lip gets 3.6 vertices from crown to outer
   * edge and the face about 4 quads; at 192, 4.3 and 4.8. That is the whole
   * purchase: one more sample on each, for 25,600 vertices a frame becoming
   * 36,864 -- 44% more vertex shading, every frame, each invocation carrying
   * two simplex octaves and a hazardHeight over three slots.
   *
   * And it buys nothing in the lighting, which is where both features
   * actually read. The patch hands the fragment stage a position and two
   * varyings and no normal at all: `waterglsl.ts` finite-differences its own
   * `N` per PIXEL at NORMAL_STEP, and the hazard's slope comes from three
   * taps at HAZ_STEP_WORLD. Neither knows how finely the grid under it was
   * cut. A denser patch can only sharpen the silhouette and clip a little
   * less off the lip's crown -- and the crown falls between vertices at
   * either resolution, since the grid snaps to the ship and the maelstrom
   * sits where it sits, so that is a phase accident, not something 192 fixes.
   *
   * Left at 160. RENDER_PLAN.md's budget names patch segments as the third
   * thing to drop when a frame runs over; growing it 44% for one sample on a
   * shape whose shading is resolution-blind is the wrong direction.
   *
   * That is an argument from arithmetic, and it is the only kind that was
   * available: nobody has yet put a photograph of the rim at 192 beside one
   * at 160. If the owner looks at a real GPU and finds the lip reading as a
   * polygon after all, this is the number to move, and the reasoning above is
   * what it has to argue with.
   */
  const segments = Math.max(2, quality.patchSegments);
  const geometry = new THREE.PlaneGeometry(PATCH_EXTENT, PATCH_EXTENT, segments - 1, segments - 1);

  // `uPatchCentre`, `uPatchEast` and `uPatchNorth` are deliberately NOT
  // re-declared here. They belong to the sphere's uniform set (`water.ts`)
  // and arrive through the spread, so writing them below writes the objects
  // the sphere is reading -- which is the whole mechanism by which the sphere
  // knows where to cut its shell away. Shadowing them with fresh objects here
  // would leave the sphere reading a patch that never moves off the origin,
  // and the symptom would be a hole in the sea a thousand units away.
  //
  // `uPatchUp` is the exception and is the patch's alone: only the vertex
  // shader below reads it, and the sphere has no use for it.
  const uniforms: Record<string, THREE.IUniform> = {
    ...sphereMaterial.uniforms,
    uPatchUp: { value: new THREE.Vector3(0, 0, 1) },
  };
  // The sphere may stop drawing its shell now that this patch exists to cover
  // it. See PATCH_CULL_HALF.
  uniforms.uPatchCull.value = PATCH_CULL_HALF;

  const vertexShader = [
    'uniform vec3 uOffsetSwell;',
    'uniform vec3 uOffsetWave;',
    'uniform vec3 uOffsetChop;',
    'uniform float uWaveIntensity;',
    'uniform vec3 uPatchCentre;',
    'uniform vec3 uPatchEast;',
    'uniform vec3 uPatchNorth;',
    'uniform vec3 uPatchUp;',
    'varying vec3 vDir;',
    'varying vec3 vWorldPos;',
    NOISE_GLSL,
    ...waterWavefield(freq(SWELL_WAVELENGTH), freq(WAVE_WAVELENGTH), freq(CHOP_WAVELENGTH)),
    // The same chunk `waterhazard.ts` pastes into the fragment shader and
    // `hazardfield.ts` ports to the CPU -- see that module's comment. The
    // uniforms it declares arrive through `...sphereMaterial.uniforms` above,
    // shared by reference with the plugin that writes them.
    HAZARD_GLSL,
    `const float PATCH_EXTENT = ${PATCH_EXTENT.toFixed(1)};`,
    `const float SKIRT_START = ${SKIRT_START.toFixed(4)};`,
    `const float GLOBE_R = ${GLOBE_RADIUS.toFixed(1)};`,
    `const float DISPLACE_AMPLITUDE = ${DISPLACE_AMPLITUDE.toFixed(4)};`,
    'void main() {',
    '  vec3 tangentPos = uPatchCentre + uPatchEast * position.x + uPatchNorth * position.y;',
    '  vec3 dir = normalize(tangentPos);',
    // Swell + wave only, never chop -- fine = 0.0 skips the chop tap
    // entirely (the same `if (fine > 0.004)` gate the fragment shader uses),
    // and mid = 1.0 keeps full ridge sharpness: the patch is always close to
    // the camera, so there is no LOD to fade toward.
    '  float h = waveField(dir, 1.0, 1.0, 0.0);',
    '  float r = length(position.xy) / (PATCH_EXTENT * 0.5);',
    '  float skirt = 1.0 - smoothstep(SKIRT_START, 1.0, r);',
    '  float amp = DISPLACE_AMPLITUDE * uWaveIntensity * skirt;',
    // The skirt multiplies the hazard too, and has to: a crest still standing
    // at the patch's edge would hold the rim of the grid off the sphere it
    // fades into, and the seam that hides would be a metre of open geometry.
    '  vec3 displaced = dir * GLOBE_R + uPatchUp * (h * amp + hazardHeight(dir) * skirt);',
    '  vDir = normalize(displaced);',
    '  vWorldPos = displaced;',
    '  gl_Position = projectionMatrix * viewMatrix * vec4(displaced, 1.0);',
    '}',
  ].join('\n');

  // Byte-for-byte the sphere's own fragment shader, including whatever
  // plugin hooks (Phase 1 A/D/E) were registered on `water` before this
  // patch was built -- see the module comment.
  const fragmentShader = sphereMaterial.fragmentShader;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    defines: { WATER_DISPLACED: 1 },
    polygonOffset: true,
    polygonOffsetFactor: PATCH_POLYGON_OFFSET_FACTOR,
    polygonOffsetUnits: PATCH_POLYGON_OFFSET_UNITS,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water-patch';
  // The vertex shader computes world-space positions directly (ignoring
  // modelMatrix -- this mesh is added at identity transform, like the sphere
  // and every other world mesh), so the geometry's own local bounding volume
  // means nothing for culling; without this the patch can vanish from the
  // very view it exists for.
  mesh.frustumCulled = false;

  let centreInitialised = false;

  function update(_dt: number, ship: ShipState): void {
    _raw.copy(ship.position).multiplyScalar(GLOBE_RADIUS);
    const centre = uniforms.uPatchCentre.value as THREE.Vector3;

    if (!centreInitialised) {
      centre.copy(_raw);
      centreInitialised = true;
    } else {
      _delta.copy(_raw).sub(centre);
      const spacing = PATCH_EXTENT / (segments - 1);
      if (_delta.length() > spacing * 0.5) {
        // Fresh every call, never stored -- tangentFrame(up) is degenerate at
        // the poles and near-degenerate close to them.
        tangentFrame(ship.up, _north, _east);
        const stepsE = Math.round(_delta.dot(_east) / spacing);
        const stepsN = Math.round(_delta.dot(_north) / spacing);
        centre.addScaledVector(_east, stepsE * spacing).addScaledVector(_north, stepsN * spacing);
        // Snapping walked the centre along the tangent plane, off the sphere
        // by a rounding amount; put it back.
        centre.normalize().multiplyScalar(GLOBE_RADIUS);
      }
    }

    tangentFrame(ship.up, _north, _east);
    (uniforms.uPatchEast.value as THREE.Vector3).copy(_east);
    (uniforms.uPatchNorth.value as THREE.Vector3).copy(_north);
    (uniforms.uPatchUp.value as THREE.Vector3).copy(ship.up);
  }

  return { mesh, update };
}
