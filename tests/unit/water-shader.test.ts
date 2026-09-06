import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createWater } from '../../src/water';
import type { HeightMap } from '../../src/heightmap';
import type { WaterBodies } from '../../src/waterbodies';
import { createStubTerrain } from './support/stub-terrain';
import fixture from '../fixtures/water-shader.json';

/**
 * Proof that decomposing `water.ts` into `waterglsl.ts` (plus the fog and
 * noise contracts) changed nothing: with no plugins registered, the rebuilt
 * shader must equal the fixture captured from `main` before the refactor,
 * modulo whitespace.
 *
 * "Modulo whitespace" collapses every run of whitespace (including
 * newlines) to a single space, so a chunk boundary that only moved a line
 * break does not fail this test; an actual token added, removed or reordered
 * does.
 *
 * See the W0 report for the short, itemised list of places the fixture was
 * intentionally updated in this same commit (the fog hook's `applyAerial`
 * call, the foam mask restructured so a later plugin's foam can appear
 * outside the coastal band, and the empty `WATER_DISPLACED` vertex seam) --
 * every one of them is required by `docs/RENDER_PLAN.md`'s plugin contract
 * and none of them changes what the shader renders today, since the fog
 * body is still the identity and no plugin is registered here.
 */
function normalize(glsl: string): string {
  return glsl.replace(/\s+/g, ' ').trim();
}

function buildBareWater() {
  const terrain = createStubTerrain();
  const heightMap = { texture: {} } as unknown as HeightMap;
  const waterBodies = { texture: {} } as unknown as WaterBodies;
  return createWater(terrain, heightMap, waterBodies);
}

describe('water shader', () => {
  it('vertex shader matches the fixture, modulo whitespace', () => {
    const water = buildBareWater();
    const material = water.mesh.material as THREE.ShaderMaterial;
    expect(normalize(material.vertexShader)).toBe(normalize(fixture.vertexShader));
  });

  it('fragment shader matches the fixture, modulo whitespace', () => {
    const water = buildBareWater();
    const material = water.mesh.material as THREE.ShaderMaterial;
    expect(normalize(material.fragmentShader)).toBe(normalize(fixture.fragmentShader));
  });

  it('builds with no plugins registered and no defines set', () => {
    const water = buildBareWater();
    const material = water.mesh.material as THREE.ShaderMaterial;
    expect(material.defines).toEqual({});
  });
});
