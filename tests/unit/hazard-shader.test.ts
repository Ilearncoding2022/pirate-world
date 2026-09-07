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
   * The seam contract, asserted rather than assumed: Wave 0 cut `slope` into
   * the core shader and moved the hazard normal into it, but shipped every
   * one of the four seam locals at its default. Streams C and M raise them.
   * Until they do, this is what "the seam changes nothing" means in a test.
   */
  it('declares the four steep-seam locals and leaves them at their defaults', () => {
    const glsl = normalize(buildHazardShaderGolden().fragmentShader);
    expect(glsl).toContain('float steep = 0.0;');
    expect(glsl).toContain('vec3 steepN = n;');
    expect(glsl).toContain('float crestLift = 0.0;');
    expect(glsl).toContain('float tiltBoost = 1.0;');
    // The plugin hands the core a normal to gate on, even at steep = 0.
    expect(glsl).toContain('steepN = normalize(n - hazSlope);');
  });

  it('splices both art modules into the one slot loop', () => {
    const glsl = normalize(buildHazardShaderGolden().fragmentShader);
    // The crest's mask and the funnel's, from hazardcrest.ts and
    // hazardfunnel.ts respectively -- proof the skeleton reaches both.
    expect(glsl).toContain('hazCrestMask = max(hazCrestMask,');
    expect(glsl).toContain('hazFunnelMask = max(hazFunnelMask,');
  });
});
