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
 * intentionally updated in that commit (the fog hook's `applyAerial`
 * call, the foam mask restructured so a later plugin's foam can appear
 * outside the coastal band, and the empty `WATER_DISPLACED` vertex seam) --
 * every one of them is required by `docs/RENDER_PLAN.md`'s plugin contract
 * and none of them changes what the shader renders today, since the fog
 * body is still the identity and no plugin is registered here.
 *
 * `docs/TEXTURE_PLAN.md` Wave 0 updated it a second time. That list, in full:
 *
 *  1. `waterDepth` split into `waterSurface()` + `waterDepth(eps)`, with the
 *     new `slope` hook slot between them. A pure split; no line moved except
 *     as noted next.
 *  2. The tangent basis (`ref`, `tanU`, `tanV`) moved ABOVE the LOD block, so
 *     a `slope`-hook plugin can finite-difference its own field before the
 *     LOD reads it. Pure reorder: all three depend on `n` alone.
 *  3. Four seam locals declared -- `steep` (0), `steepN` (`n`), `crestLift`
 *     (0), `tiltBoost` (1) -- and `gateN = normalize(mix(n, steepN, steep))`.
 *  4. Four gates re-pointed from `n` to `gateN`: `graze`, `sunGeo`, `road`,
 *     and the diffuse blend's factor (`0.45` became `mix(0.45, 0.90, steep)`).
 *     At `steep = 0`, `gateN` is `n` and every one of them is arithmetically
 *     the expression it replaced.
 *  5. `tilt` multiplied by `tiltBoost`, and `crestLift` added inside the
 *     backscatter term, both no-ops at their defaults.
 *  6. `WATER_FOAM_TAIL`'s constant `foamLit` given a Lambert wrap, a Fresnel
 *     rim and a share of `glint`.
 *
 * Only (6) changes a pixel in THIS shader, and only where `foam > 0`: with no
 * plugin registered, `steep` is 0 and `tiltBoost` is 1 by construction, so
 * (3), (4) and (5) are inert here by the same argument the fog body was.
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
