import * as THREE from 'three';
import type { Water } from './water';
import type { ShipState } from './types';
import type { Quality } from './quality';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { NOISE_GLSL } from './noiseglsl';
import { waterWavefield } from './waterglsl';
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

  const segments = Math.max(2, quality.patchSegments);
  const geometry = new THREE.PlaneGeometry(PATCH_EXTENT, PATCH_EXTENT, segments - 1, segments - 1);

  const uniforms: Record<string, THREE.IUniform> = {
    ...sphereMaterial.uniforms,
    uPatchCentre: { value: new THREE.Vector3(0, 0, GLOBE_RADIUS) },
    uPatchEast: { value: new THREE.Vector3(1, 0, 0) },
    uPatchNorth: { value: new THREE.Vector3(0, 1, 0) },
    uPatchUp: { value: new THREE.Vector3(0, 0, 1) },
  };

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
    '  vec3 displaced = dir * GLOBE_R + uPatchUp * (h * amp);',
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
