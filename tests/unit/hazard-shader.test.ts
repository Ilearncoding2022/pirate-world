import { describe, it, expect } from 'vitest';
import { buildHazardShaderGolden } from '../fixtures/generate';
import fixture from '../fixtures/hazard-shader.json';

/**
 * The water shader with `waterhazard.ts`'s plugin woven in, pinned the same
 * way `water-shader.test.ts` pins the bare sea.
 *
 * `water-shader.json` cannot do this job: it is captured with no plugins
 * registered, so every line of hazard art is invisible to it. Two streams
 * (`docs/TEXTURE_PLAN.md` Wave 1, C and M) are about to edit `hazardcrest.ts`
 * and `hazardfunnel.ts` in parallel, and this fixture is what puts their two
 * diffs -- and the skeleton splice that joins them -- in front of a reviewer
 * as text rather than as a screenshot.
 *
 * A failure here is not by itself a regression. It means the assembled hazard
 * shader moved, and the commit that moved it owes an itemised note saying
 * which lines and why. A failure with no such note is the regression.
 *
 * Moved twice, and both times only inherited: this fixture is the water shader
 * with the hazard plugin in it, so it carries every change itemised in
 * `water-shader.test.ts` -- the weather's three (docs/WEATHER_PLAN.md), and
 * the tripled `FOG_DENSITY_GAIN` after them -- and not a line of its own. No
 * hazard art was touched by either.
 */
function normalize(glsl: string): string {
  return glsl.replace(/\s+/g, ' ').trim();
}

describe('hazard shader', () => {
  it('vertex shader matches the fixture, modulo whitespace', () => {
    expect(normalize(buildHazardShaderGolden().vertexShader)).toBe(
      normalize(fixture.vertexShader),
    );
  });

  it('fragment shader matches the fixture, modulo whitespace', () => {
    expect(normalize(buildHazardShaderGolden().fragmentShader)).toBe(
      normalize(fixture.fragmentShader),
    );
  });

  /*
   * The seam contract, asserted rather than assumed.
   *
   * What is pinned here is that all four locals are still DECLARED at their
   * inert defaults, which is what makes the open sea -- every pixel where
   * `uHazCount` is 0 and the slot loop never runs -- bit-identical to the sea
   * before the seam existed. The crest and funnel art both raise them further
   * down, inside that loop, and this test deliberately says nothing about the
   * values they raise them to: those are art and belong in the fixture diff,
   * not in an assertion.
   */
  it('declares the four steep-seam locals at their inert defaults', () => {
    const glsl = normalize(buildHazardShaderGolden().fragmentShader);
    expect(glsl).toContain('float steep = 0.0;');
    expect(glsl).toContain('vec3 steepN = n;');
    expect(glsl).toContain('float crestLift = 0.0;');
    expect(glsl).toContain('float tiltBoost = 1.0;');
    // The plugin hands the core a normal to gate on, even at steep = 0.
    expect(glsl).toContain('steepN = normalize(n - hazSlope);');
  });

  /*
   * Both art modules raise `steep` with `max`, never plain assignment. A
   * crest and a funnel can be live in adjacent slots of the same loop, and an
   * assignment in either branch would silently discard the other's claim on
   * the pixel where their footprints overlap. Cheap to assert, and the kind
   * of thing that would otherwise only show up as one hazard going flat
   * whenever another happened to be near it.
   */
  it('raises the seam locals with max, so two live hazards cannot clobber each other', () => {
    // Comments have to go first, and not for tidiness: the seam is explained
    // in prose directly above itself ("so that steep = 0 reduces to..."), so
    // matching assignments against the raw source finds the documentation
    // rather than the code.
    const code = buildHazardShaderGolden()
      .fragmentShader.split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const writes = [...code.matchAll(/(\w+\s+)?\bsteep\s*=\s*([^;]+);/g)];
    // One declaration, and every other write a max().
    expect(writes.length).toBeGreaterThan(1);
    for (const [, declaredType, rhs] of writes) {
      if (declaredType?.trim() === 'float') expect(rhs.trim()).toBe('0.0');
      else expect(rhs.trim()).toMatch(/^max\(steep,/);
    }
    // Both art modules raise it, not just one.
    expect(writes.filter(([, d]) => d?.trim() !== 'float')).toHaveLength(2);
  });

  it('splices both art modules into the one slot loop', () => {
    const glsl = normalize(buildHazardShaderGolden().fragmentShader);
    // The crest's mask and the funnel's, from hazardcrest.ts and
    // hazardfunnel.ts respectively -- proof the skeleton reaches both.
    expect(glsl).toContain('hazCrestMask = max(hazCrestMask,');
    expect(glsl).toContain('hazFunnelMask = max(hazFunnelMask,');
  });
});
