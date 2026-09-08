import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createCelestial } from '../../src/celestial';
import type { WorldEnv } from '../../src/env';
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

/** `postfx.ts`'s BLOOM_THRESHOLD, which is private to that module. */
const BLOOM_THRESHOLD = 0.9;

/** A `WorldEnv` that says nothing except what phase the moon is in. */
function envWith(illumination: number): WorldEnv {
  return {
    sunDirection: new THREE.Vector3(0, 0, 1),
    sunColor: new THREE.Color('#fff4e4'),
    moonDirection: new THREE.Vector3(1, 0, 0),
    moonIllumination: illumination,
    elapsed: 0,
    timeOfDay: 0.25,
    dayFactor: 0,
  };
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

describe('the moon\'s rim aurora', () => {
  it('is the same billboard as the other two, not a third copy of it', () => {
    const group = createCelestial().group;
    const sun = materialNamed(group, 'sun-disc');
    const aurora = materialNamed(group, 'moon-aurora');
    expect(aurora.vertexShader).toBe(sun.vertexShader);
    expect(aurora.fragmentShader).toBe(sun.fragmentShader);
  });

  it('is a rim and nothing else: no core, no corona', () => {
    // The band alone is what "a rim aurora" means. A corona under it would be
    // a second halo and a core would be a disc over the moon's own face.
    const aurora = materialNamed(createCelestial().group, 'moon-aurora').uniforms;
    expect(aurora.uCoreGain.value).toBe(0);
    expect(aurora.uCoronaGain.value).toBe(0);
    expect(aurora.uRimGain.value).toBeGreaterThan(0);
  });

  it('sits on the moon\'s own limb, on the halo quad it shares', () => {
    // The band is positioned in quad radii, so it only lands on the limb if
    // the two quads are the same size and the edge is read off the same
    // scale. A few percent outside, so it stands off the body rather than
    // being painted around it.
    const group = createCelestial().group;
    const glow = materialNamed(group, 'moon-glow').uniforms;
    const aurora = materialNamed(group, 'moon-aurora').uniforms;
    expect(aurora.uSize.value).toBe(glow.uSize.value);
    const limb = aurora.uCoreEdge.value;
    expect(aurora.uRimEdge.value).toBeGreaterThan(limb);
    expect(aurora.uRimEdge.value).toBeLessThan(limb * 1.2);
    // Narrow enough to read as a rim rather than as a second halo.
    expect(aurora.uRimWidth.value).toBeLessThan(limb);
  });

  it('is a tenth of the sun, and cannot glare on its own', () => {
    const group = createCelestial().group;
    const sun = materialNamed(group, 'sun-disc').uniforms;
    const aurora = materialNamed(group, 'moon-aurora').uniforms;
    const sunPeak = sun.uCoreGain.value + sun.uCoronaGain.value;
    // The rim term peaks at 1 at the centre of its own band.
    expect(aurora.uRimGain.value).toBeCloseTo(sunPeak * 0.1, 10);
    // postfx.ts BLOOM_THRESHOLD. Nothing at a tenth of the sun reaches it.
    expect(aurora.uRimGain.value).toBeLessThan(BLOOM_THRESHOLD);
  });

  it('cannot push even the brightest lit limb past the bloom line', () => {
    // The ring is additive and paints OVER the moon, so what the bright pass
    // sees on a lit limb is the disc plus the ring -- and at a tenth of the
    // sun the pair still does not reach 0.9. That is a deliberate outcome and
    // it is pinned here, because it is exactly the sort of thing a later
    // brightness tweak would cross without meaning to. See MOON_AURORA_GAIN
    // for the arithmetic and for the value that WOULD make it glare.
    const group = createCelestial().group;
    const moonSource = materialNamed(group, 'moon-disc').fragmentShader;
    const cap = /MOON_MAX_LUMA = ([0-9.]+)/.exec(moonSource);
    expect(cap).not.toBeNull();
    expect(Number(cap?.[1])).toBeLessThan(BLOOM_THRESHOLD);

    const aurora = materialNamed(group, 'moon-aurora').uniforms;
    // The albedo's own peak channel times the crater term's ceiling, which is
    // the brightest the lit face can be. Read off the material rather than
    // written down, so a recoloured moon is measured and not assumed.
    const albedo = materialNamed(group, 'moon-disc').uniforms.uAlbedo.value as THREE.Color;
    const brightestFace = Math.max(albedo.r, albedo.g, albedo.b) * 1.22;
    const rimColor = aurora.uColor.value as THREE.Color;
    const brightestRim = Math.max(rimColor.r, rimColor.g, rimColor.b) * aurora.uRimGain.value;
    expect(brightestFace + brightestRim).toBeLessThan(BLOOM_THRESHOLD);
    // And it is close enough to matter: the moon is meant to be the body that
    // very nearly glares and does not.
    expect(brightestFace + brightestRim).toBeGreaterThan(BLOOM_THRESHOLD * 0.95);
  });

  it('paints over its own body, where the halo paints under it', () => {
    const group = createCelestial().group;
    const order = (name: string): number => {
      const mesh = group.children.find((child) => child.name === name);
      if (!mesh) throw new Error(`${name} not found`);
      return mesh.renderOrder;
    };
    // This ordering is the whole difference between a halo and a rim: light
    // behind the sphere has to be covered by the lit face, light standing at
    // its edge has to be added to it.
    expect(order('moon-glow')).toBeLessThan(order('moon-disc'));
    expect(order('moon-aurora')).toBeGreaterThan(order('moon-disc'));
    // And still under the atmosphere shell at 0 and the clouds at 2 + i.
    expect(order('moon-aurora')).toBeLessThan(0);
  });

  it('goes out with the phase, so a new moon wears no ring', () => {
    const celestial = createCelestial();
    const aurora = materialNamed(celestial.group, 'moon-aurora').uniforms;
    const full = aurora.uRimGain.value;

    celestial.update(0.016, envWith(0));
    expect(aurora.uRimGain.value).toBe(0);

    celestial.update(0.016, envWith(1));
    expect(aurora.uRimGain.value).toBeCloseTo(full, 12);

    celestial.update(0.016, envWith(0.5));
    expect(aurora.uRimGain.value).toBeCloseTo(full * 0.5, 12);
  });

  it('shimmers on its own clock, not on the day clock', () => {
    // The drift is a thing the light does, and it has to run at the same rate
    // at noon and at midnight -- so it is accumulated from `dt` rather than
    // read off the world's own elapsed time.
    const celestial = createCelestial();
    const aurora = materialNamed(celestial.group, 'moon-aurora').uniforms;
    celestial.update(0.5, envWith(1));
    expect(aurora.uTime.value).toBeCloseTo(0.5, 12);
    celestial.update(0.25, envWith(1));
    expect(aurora.uTime.value).toBeCloseTo(0.75, 12);
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
