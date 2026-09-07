import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import type { Hazard, HazardKind } from '../../src/types';
import {
  hazardHeight,
  CREST_HALF_LENGTH,
  CREST_HALF_WIDTH,
  CREST_HEIGHT,
  GREAT_CREST_HEIGHT,
  MAELSTROM_RADIUS,
  FUNNEL_DEPTH,
  RIM_HEIGHT,
  MAX_HAZARDS,
  CREST_FRONT_RATIO,
  CREST_BACK_RATIO,
} from '../../src/hazardfield';
import { GLOBE_RADIUS } from '../../src/geo';

/**
 * Regression tests for the hazard height field's CPU port
 * (`src/hazardfield.ts`).
 *
 * `tests/smoke/wave-parity.spec.ts` is what proves this port agrees with the
 * GLSL the player actually sees; this file only proves the SHAPE is the shape
 * the plan specifies -- that a crest peaks at its amplitude, that it stops at
 * its own footprint rather than tinting the whole ocean, that a funnel is as
 * deep as it says it is, and that the profile is symmetric across the crest
 * line. Each of those is something a plausible edit (a swapped u/v, a dropped
 * envelope, a sign flip on the funnel) would break without breaking parity,
 * because parity only says the two sides are wrong together.
 */

/** A hazard at the north pole, so `east`/`north` are exactly the world X and Z axes and `u`/`v` are exactly the offsets fed in. */
function makeHazard(kind: HazardKind, overrides: Partial<Hazard> = {}): Hazard {
  const crest = kind !== 'maelstrom';
  return {
    kind,
    centre: new Vector3(0, 1, 0),
    east: new Vector3(1, 0, 0),
    north: new Vector3(0, 0, 1),
    extent: crest ? CREST_HALF_LENGTH : MAELSTROM_RADIUS,
    halfWidth: crest ? CREST_HALF_WIDTH : 0,
    amplitude: crest ? CREST_HEIGHT : FUNNEL_DEPTH,
    envelope: 1,
    size: 1,
    age: 0,
    consumed: false,
    ...overrides,
  };
}

/**
 * A unit direction whose local coordinates in the hazard's frame are exactly
 * `u` and `v` world units -- `east` and `north` above are the world X and Z
 * axes, so `dot(p, east)` is p.x and the third component is whatever makes it
 * unit length.
 *
 * Built this way rather than by walking the tangent plane and normalizing,
 * which lands a point at u = 10.01 on a dot product of 9.9975: that gap is
 * the small-angle approximation the field is built on (0.125% at 10 units,
 * and both sides of the parity test make it identically), but it would leave
 * these tests unable to say where an edge actually is.
 */
function at(u: number, v: number): Vector3 {
  const x = u / GLOBE_RADIUS;
  const z = v / GLOBE_RADIUS;
  return new Vector3(x, Math.sqrt(Math.max(1 - x * x - z * z, 0)), z);
}

describe('hazardfield: an empty sea', () => {
  it('returns exactly zero with no hazards', () => {
    // Exactly, not nearly: this is the value every pixel of open ocean and
    // every frame of a normal run gets, and it must not nudge the hull.
    expect(hazardHeight(at(0, 0), [])).toBe(0);
    expect(hazardHeight(at(7, -3), [])).toBe(0);
  });
});

describe('hazardfield: the crest profile', () => {
  it('peaks at amplitude times envelope at the centre', () => {
    for (const [amplitude, envelope] of [
      [CREST_HEIGHT, 1],
      [GREAT_CREST_HEIGHT, 1],
      [GREAT_CREST_HEIGHT, 0.4],
    ] as const) {
      const h = makeHazard('wave', { amplitude, envelope });
      expect(hazardHeight(at(0, 0), [h])).toBeCloseTo(amplitude * envelope, 5);
    }
  });

  it('holds full height across the plateau and reaches zero at the footprint', () => {
    const h = makeHazard('greatwave', { amplitude: GREAT_CREST_HEIGHT });
    // Flat out to 40% of the half-length: a hull crossing the middle of the
    // wave climbs the whole thing, wherever along it it crosses.
    expect(hazardHeight(at(CREST_HALF_LENGTH * 0.35, 0), [h])).toBeCloseTo(GREAT_CREST_HEIGHT, 5);
    // And nothing at all beyond the ends, or beyond the tail -- if this ever
    // becomes merely small rather than zero, the crest is tilting the normal
    // and foaming across the whole visible sea. The tail is the far edge now:
    // the profile is asymmetric, so `CREST_BACK` half-widths astern is where
    // the water is finally flat again.
    expect(hazardHeight(at(CREST_HALF_LENGTH + 0.01, 0), [h])).toBe(0);
    expect(hazardHeight(at(0, CREST_HALF_WIDTH * CREST_FRONT_RATIO + 0.01), [h])).toBe(0);
    expect(hazardHeight(at(0, -CREST_HALF_WIDTH * CREST_BACK_RATIO - 0.01), [h])).toBe(0);
    expect(hazardHeight(at(40, 40), [h])).toBe(0);
  });

  it('is symmetric along its length but NOT across it: a steep face, a long back', () => {
    const h = makeHazard('wave');
    // Along the crest line the wave is the same either side of its middle.
    for (const u of [1, 4, 7, 9.5]) {
      expect(hazardHeight(at(u, 0.6), [h])).toBeCloseTo(hazardHeight(at(-u, 0.6), [h]), 6);
    }
    /*
     * Across it, it is deliberately not. `v > 0` is the way the wave is
     * travelling -- the face the hull meets -- and it has to be the steep
     * side: the same distance astern must still be carrying real water when
     * the face has already run out. This asymmetry IS the retune; a symmetric
     * crest reads as a slab of ice with a flat top.
     */
    const front = CREST_HALF_WIDTH * CREST_FRONT_RATIO;
    const back = CREST_HALF_WIDTH * CREST_BACK_RATIO;
    expect(front).toBeLessThan(back);
    expect(hazardHeight(at(0, front * 1.01), [h])).toBe(0);
    expect(hazardHeight(at(0, -front * 1.01), [h])).toBeGreaterThan(0);
    // Monotonic away from the crest line, on both sides, so the surface never
    // doubles back on itself into a second ridge.
    for (const sign of [1, -1]) {
      const reach = sign > 0 ? front : back;
      let previous = Infinity;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const here = hazardHeight(at(0, sign * reach * t), [h]);
        expect(here).toBeLessThanOrEqual(previous + 1e-9);
        previous = here;
      }
    }
  });
});

describe('hazardfield: the maelstrom profile', () => {
  it('is FUNNEL_DEPTH deep at the centre, scaled by the envelope', () => {
    // The sign lives in the profile, not in `amplitude` -- see
    // `hazardStrength`. A funnel that comes back positive is a mountain.
    expect(hazardHeight(at(0, 0), [makeHazard('maelstrom')])).toBeCloseTo(-FUNNEL_DEPTH, 5);
    expect(hazardHeight(at(0, 0), [makeHazard('maelstrom', { envelope: 0.5 })])).toBeCloseTo(-FUNNEL_DEPTH * 0.5, 5);
  });

  it('scales its radius with `size`, so a growing maelstrom is a growing hole', () => {
    const half = makeHazard('maelstrom', { size: 0.5 });
    // Clear of a half-grown funnel, lip and all -- the lip's outer edge is at
    // 1.02 radii, so "outside" for a maelstrom is a little past its radius.
    expect(hazardHeight(at(MAELSTROM_RADIUS * 0.5 * 1.05, 0), [half])).toBe(0);
    // And still a hole in the middle, at full depth.
    expect(hazardHeight(at(0, 0), [half])).toBeCloseTo(-FUNNEL_DEPTH, 5);
  });

  it('raises a lip near the rim and is flat outside it', () => {
    const m = makeHazard('maelstrom');
    // The lip peaks at 0.9 of the radius, where the funnel it sits on is
    // already down to (1 - 0.9)^3 of its depth -- three thousandths of a
    // unit. RIM_HEIGHT minus that is the whole of the arithmetic.
    const lip = hazardHeight(at(MAELSTROM_RADIUS * 0.9, 0), [m]);
    expect(lip).toBeCloseTo(RIM_HEIGHT - FUNNEL_DEPTH * 0.001, 5);
    expect(hazardHeight(at(MAELSTROM_RADIUS + 1.5, 0), [m])).toBe(0);
  });

  it('is radially symmetric -- the swirl is art, not geometry', () => {
    const m = makeHazard('maelstrom');
    const r = 4.5;
    const reference = hazardHeight(at(r, 0), [m]);
    for (const angle of [0.4, 1.1, 2.7, 4.9]) {
      expect(hazardHeight(at(r * Math.cos(angle), r * Math.sin(angle)), [m])).toBeCloseTo(reference, 5);
    }
  });
});

describe('hazardfield: several at once', () => {
  it('sums the live slots and ignores anything past MAX_HAZARDS', () => {
    const crest = makeHazard('wave');
    const funnel = makeHazard('maelstrom', { east: new Vector3(1, 0, 0), north: new Vector3(0, 0, 1) });
    // Both centred on the same point: the crest lifts, the funnel digs, and
    // the field is their sum rather than either one winning.
    expect(hazardHeight(at(0, 0), [crest, funnel])).toBeCloseTo(CREST_HEIGHT - FUNNEL_DEPTH, 5);

    // The shader has three slots and no fourth to read, so neither side may
    // count a fourth hazard -- that is a desync the parity test cannot see,
    // because it would only ever hand the GPU three.
    const many = [crest, crest, crest, makeHazard('greatwave')];
    expect(many.length).toBeGreaterThan(MAX_HAZARDS);
    expect(hazardHeight(at(0, 0), many)).toBeCloseTo(CREST_HEIGHT * MAX_HAZARDS, 5);
  });
});
