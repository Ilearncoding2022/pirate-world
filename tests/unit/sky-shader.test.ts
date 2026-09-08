import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createSky, skyHorizonColor } from '../../src/sky';
import { createEnv } from '../../src/env';
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
 *
 * The weather (docs/WEATHER_PLAN.md) moved the DOME's two fixtures and left
 * the atmosphere shell's alone, which is itself the point. The dome gained
 * `uStormColor`, `uGloom` and `uFlash`: the storm greys the day pair before
 * the day/night mix (so a stormy midnight is still midnight) and the flash is
 * added after the dither. The SHELL is untouched, because a limb is an
 * orbital effect and a storm is a deck one, and the two already cross-fade
 * against each other over camera altitude -- greying both would double the
 * effect at exactly the altitude where each is half on.
 *
 * At zero weather `uGloom` and `uFlash` are zero, both terms vanish, and the
 * dome renders what it always did.
 */
function normalize(glsl: string): string {
  return glsl.replace(/\s+/g, ' ').trim();
}

function findNamed(group: THREE.Group, name: string): THREE.Mesh {
  const mesh = group.children.find((child) => child.name === name);
  if (!mesh) throw new Error(`${name} mesh not found in sky group`);
  return mesh as THREE.Mesh;
}

function findAtmosphere(group: THREE.Group): THREE.Mesh {
  return findNamed(group, 'atmosphere');
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

/**
 * The sky dome is the second hand-written shader in this file: the graded sky
 * the player sees from the deck, which thins out to nothing as the camera
 * climbs toward orbit. Pinned the same way, and for the same reason.
 */
describe('sky dome shader', () => {
  it('vertex shader matches the fixture, modulo whitespace', () => {
    const material = findNamed(createSky().group, 'sky-dome')
      .material as THREE.ShaderMaterial;
    expect(normalize(material.vertexShader)).toBe(normalize(fixture.domeVertexShader));
  });

  it('fragment shader matches the fixture, modulo whitespace', () => {
    const material = findNamed(createSky().group, 'sky-dome')
      .material as THREE.ShaderMaterial;
    expect(normalize(material.fragmentShader)).toBe(normalize(fixture.domeFragmentShader));
  });

  it('is drawn over the stars and under the two bodies', () => {
    // Everything in the sky is centred on the world origin, so Three's
    // distance sort cannot separate any of it and renderOrder is the only
    // thing holding the layering up. The moon sits at -5.
    const group = createSky().group;
    const stars = group.children.find((child) => child.name === 'starfield-pivot');
    const dome = findNamed(group, 'sky-dome');
    expect(dome.renderOrder).toBe(-10);
    expect(stars?.children[0]?.renderOrder).toBe(-20);
    expect(dome.renderOrder).toBeLessThan(-5);
  });
});

describe('sky horizon colour', () => {
  it('is the same mix fog.ts fades the sea into', () => {
    // Not a re-derivation of the shader: `skyHorizonColor` and the dome's
    // `uDay` uniform are fed from the same `env.dayFactor`, which is what
    // stops the sea and the sky above it drifting apart at dawn.
    const env = createEnv();
    const out = new THREE.Color();

    env.dayFactor = 1;
    const day = skyHorizonColor(env, out).clone();
    env.dayFactor = 0;
    const night = skyHorizonColor(env, out).clone();

    // Day horizon is the pale one, night the deep one. If these ever swap,
    // the sea fades to the wrong colour at exactly the wrong time of day.
    expect(day.r + day.g + day.b).toBeGreaterThan(night.r + night.g + night.b);

    env.dayFactor = 0.5;
    const mid = skyHorizonColor(env, out).clone();
    expect(mid.b).toBeGreaterThan(night.b);
    expect(mid.b).toBeLessThan(day.b);
  });
});
