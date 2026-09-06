import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createSky } from '../../src/sky';
import fixture from '../fixtures/sky-shader.json';

/**
 * Golden string test for the atmosphere shell's shader (Stream E,
 * docs/RENDER_PLAN.md Phase 1: lighting polish and aerial perspective).
 *
 * `sky.ts`'s atmosphere is the other hand-written `ShaderMaterial` this
 * stream touches -- the dither that kills the 8-bit banding on its rim glow
 * lives in its fragment shader, alongside the exported `ATMOSPHERE_COLOR`
 * `fog.ts` reads. This pins both shaders the same way `water-shader.test.ts`
 * pins the water's, so an accidental future edit shows up as a diff here
 * instead of only as a look the owner has to notice by eye.
 *
 * "Modulo whitespace" collapses every run of whitespace (including
 * newlines) to a single space, matching `water-shader.test.ts`.
 */
function normalize(glsl: string): string {
  return glsl.replace(/\s+/g, ' ').trim();
}

function findAtmosphere(group: THREE.Group): THREE.Mesh {
  const mesh = group.children.find((child) => child.name === 'atmosphere');
  if (!mesh) throw new Error('atmosphere mesh not found in sky group');
  return mesh as THREE.Mesh;
}

describe('sky atmosphere shader', () => {
  it('vertex shader matches the fixture, modulo whitespace', () => {
    const sky = createSky();
    const material = findAtmosphere(sky.group).material as THREE.ShaderMaterial;
    expect(normalize(material.vertexShader)).toBe(normalize(fixture.vertexShader));
  });

  it('fragment shader matches the fixture, modulo whitespace', () => {
    const sky = createSky();
    const material = findAtmosphere(sky.group).material as THREE.ShaderMaterial;
    expect(normalize(material.fragmentShader)).toBe(normalize(fixture.fragmentShader));
  });
});
