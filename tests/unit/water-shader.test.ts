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
 *
 * The weather (docs/WEATHER_PLAN.md) updated it again, and that list, in
 * full:
 *
 *  1. `applyAerial` gained a sixth parameter, `vec2 wx` -- the rain and fog
 *     AT THIS FRAGMENT. It is an argument rather than a uniform read inside
 *     the body so that `battlescene.ts`, which calls the same contract from a
 *     flat arena nowhere on the globe, can pass `vec2(0.0)` and keep exactly
 *     the arena it had.
 *  2. `WEATHERMAP_GLSL` is pasted after `HEIGHTMAP_GLSL`, whose
 *     `dirToEquirect` it is built on, and the call site gained the two lines
 *     that sample it and hand the result to `applyAerial`.
 *  3. `FOG_GLSL` gained five uniforms (`uFogMax`, `uFogBankColor`,
 *     `uFogHere`, `uRainHere`, and the map's own sampler is declared by the
 *     chunk above) and six constants, plus the `aerialWeather` helper that
 *     combines the map's sample with the at-ship squall.
 *
 * At zero weather every one of those terms multiplies out and the function
 * computes exactly what it computed before -- the ceiling is a uniform whose
 * resting value is the constant it replaced, and both weather gains are
 * multiplied by a component of `wx`. That is the zero contract, and the
 * screenshots taken at `?weather=clear` against `main` are what actually
 * check it; this fixture only pins the text.
 *
 * Moved once more by thicker fog, and this time by one token and a block of
 * comment. That list, in full:
 *
 *  1. `FOG_DENSITY_GAIN` is 10.5 rather than 3.5 -- fog three times as thick,
 *     asked for at every intensity and answered here in the only unit this
 *     chunk has room in, the RATE. No ceiling moved: `FOG_MAX_AMOUNT`,
 *     `FOG_MAX_BANK` and `STORM_MAX_GAIN` are the numbers they were.
 *  2. The comment above it, and the one on `STORM_DENSITY_GAIN` whose stale
 *     "1.0 against the 6.0 above" ratio no longer described either constant.
 *
 * The zero contract is untouched by both: the gain is multiplied by `bank`,
 * which is `wx.y` ramped over distance, so at clear weather this shader still
 * computes what it computed before to the bit. What it does change is every
 * frame with fog in it, which is the point -- `?weather=fog` and a bank seen
 * from outside are where it is meant to be checked, not here.
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
