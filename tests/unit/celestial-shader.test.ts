import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createCelestial } from '../../src/celestial';
import fixture from '../fixtures/celestial-shader.json';

/**
 * Golden string tests for the sun disc and the moon.
 *
 * Both are hand-written `ShaderMaterial`s, so they get the same treatment
 * `sky-shader.test.ts` gives the atmosphere shell and `water-shader.test.ts`
 * gives the water: an accidental future edit shows up as a diff here rather
 * than only as a look the owner has to catch by eye. Nothing below asserts
 * that either body is pretty -- only that its shader is the one that was
 * approved (docs/TESTING.md).
 *
 * These also stand in for a compile check the unit tier cannot do. There is no
 * GL context here, so a syntax error in the GLSL would otherwise survive all
 * the way to the browser tier.
 *
 * "Modulo whitespace" collapses every run of whitespace (including newlines)
 * to a single space, matching the other two files.
 */
function normalize(glsl: string): string {
  return glsl.replace(/\s+/g, ' ').trim();
}

function materialNamed(group: THREE.Group, name: string): THREE.ShaderMaterial {
  const mesh = group.children.find((child) => child.name === name);
  if (!mesh) throw new Error(`${name} not found in celestial group`);
  return (mesh as THREE.Mesh).material as THREE.ShaderMaterial;
}

describe('celestial shaders', () => {
  it('the sun disc matches the fixture, modulo whitespace', () => {
    const material = materialNamed(createCelestial().group, 'sun-disc');
    expect(normalize(material.vertexShader)).toBe(normalize(fixture.sunVertexShader));
    expect(normalize(material.fragmentShader)).toBe(normalize(fixture.sunFragmentShader));
  });

  it('the moon matches the fixture, modulo whitespace', () => {
    const material = materialNamed(createCelestial().group, 'moon-disc');
    expect(normalize(material.vertexShader)).toBe(normalize(fixture.moonVertexShader));
    expect(normalize(material.fragmentShader)).toBe(normalize(fixture.moonFragmentShader));
  });
});

describe('celestial placement', () => {
  it('paints the moon and sun over the starfield, never under it', () => {
    // Everything in the sky is centred on the world origin, so Three's
    // distance sort cannot separate these and renderOrder is load-bearing.
    // The starfield is pinned at -20 in sky.ts.
    const group = createCelestial().group;
    const order = (name: string): number => {
      const mesh = group.children.find((child) => child.name === name);
      if (!mesh) throw new Error(`${name} not found`);
      return mesh.renderOrder;
    };
    expect(order('moon-disc')).toBeGreaterThan(-20);
    expect(order('sun-disc')).toBeGreaterThan(-20);
    // And the clouds, at 2 + i, stay in front of both.
    expect(order('moon-disc')).toBeLessThan(2);
    expect(order('sun-disc')).toBeLessThan(2);
  });
});
