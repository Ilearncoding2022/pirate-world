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

  it('the moon glow reuses the sun billboard rather than a copy of it', () => {
    // Not a second golden. The point of the shared shader is that there is
    // exactly ONE billboard in the file, and asserting the two strings are
    // the same object's is what would actually catch someone forking it.
    const group = createCelestial().group;
    const sun = materialNamed(group, 'sun-disc');
    const glow = materialNamed(group, 'moon-glow');
    expect(glow.vertexShader).toBe(sun.vertexShader);
    expect(glow.fragmentShader).toBe(sun.fragmentShader);
  });

  it('draws the moon halo with no core, so a crescent stays a crescent', () => {
    // uCoreGain is the whole of what separates the two bodies' haloes: the
    // sun gets its hard disc, the moon must not, or the glow would fill in
    // the dark half of a phase the sphere behind it is drawing correctly.
    const group = createCelestial().group;
    expect(materialNamed(group, 'moon-glow').uniforms.uCoreGain.value).toBe(0);
    expect(materialNamed(group, 'sun-disc').uniforms.uCoreGain.value).toBeGreaterThan(0);
  });

  it('keeps the moon halo at a tenth of the sun, and under the bloom line', () => {
    const group = createCelestial().group;
    const sun = materialNamed(group, 'sun-disc').uniforms;
    const glow = materialNamed(group, 'moon-glow').uniforms;
    // Peak brightness is core + corona at r = 0, where both terms are 1.
    const sunPeak = sun.uCoreGain.value + sun.uCoronaGain.value;
    const moonPeak = glow.uCoreGain.value + glow.uCoronaGain.value;
    expect(moonPeak).toBeCloseTo(sunPeak * 0.1, 10);
    // postfx.ts BLOOM_THRESHOLD. The sun is the only body allowed to glare.
    expect(moonPeak).toBeLessThan(0.9);
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
    expect(order('moon-glow')).toBeGreaterThan(-20);
    // And the clouds, at 2 + i, stay in front of all three.
    expect(order('moon-disc')).toBeLessThan(2);
    expect(order('sun-disc')).toBeLessThan(2);
    expect(order('moon-glow')).toBeLessThan(2);
    // The halo goes UNDER its own body, or it paints over the terminator.
    expect(order('moon-glow')).toBeLessThan(order('moon-disc'));
    // And over the sky dome at -10, or the dome's night veil sits on top.
    expect(order('moon-glow')).toBeGreaterThan(-10);
  });
});
