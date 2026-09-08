import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import type { Hazard, HazardKind } from '../../src/types';
import {
  hazardHeight,
  CREST_BOW_MAX,
  CREST_HALF_LENGTH,
  CREST_HALF_WIDTH,
  CREST_HEIGHT,
  CREST_HEIGHT_MAX,
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
 * the plan specifies -- that a crest peaks at its amplitude, that it peaks
 * there once and on a line, that it stops at its own footprint rather than
 * tinting the whole ocean, that its shoulders roll rather than corner, that a
 * funnel is as deep as it says it is, and that the profile is symmetric across
 * the crest line. Each of those is something a plausible edit (a swapped u/v, a
 * dropped envelope, a sign flip on the funnel) would break without breaking
 * parity, because parity only says the two sides are wrong together.
 *
 * Every threshold here is a fraction of the constant it is measuring against.
 * That is not tidiness: an absolute one in this file has already turned a shape
 * assertion into a scale assertion once, silently, when `FUNNEL_DEPTH` was
 * retuned. See the maelstrom's first-step case for the full account.
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
    // Straight by default, so every shape assertion below still measures the
    // profile rather than the profile plus an arc. The bow has its own cases.
    bow: 0,
    speed: 0,
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

describe('hazardfield: the crest\'s bow', () => {
  /*
   * The bow is the one thing about a crest that is not a profile: it moves
   * WHERE the profile is evaluated rather than what shape it has. So these
   * cases are all about the crest LINE -- the locus of the ridge -- and
   * deliberately say nothing about the height on it, which the profile cases
   * above already own.
   */

  /** Where the ridge actually sits at `u`, found by scanning across the wave. */
  function ridgeV(h: Hazard, u: number): number {
    let best = 0;
    let bestV = 0;
    for (let v = -12; v <= 6; v += 0.001) {
      const y = hazardHeight(at(u, v), [h]);
      if (y > best) {
        best = y;
        bestV = v;
      }
    }
    return bestV;
  }

  it('leaves a straight crest exactly where it always was', () => {
    // Not "close to": a zero bow multiplies the displacement term by exactly
    // zero on both ports, so a wave that rolled no arc has to be bit-for-bit
    // the wave this file drew before the bow existed. This is the case that
    // keeps the change free for every straight crest in the game.
    const straight = makeHazard('wave', { bow: 0 });
    for (const [u, v] of [
      [0, 0],
      [4, 1],
      [-7, -3],
      [9.5, 0.5],
    ] as const) {
      const p = at(u, v);
      expect(hazardHeight(p, [straight])).toBe(hazardHeight(p, [makeHazard('wave')]));
    }
  });

  it('trails the ends behind the centre, on a parabola through the centre', () => {
    const bow = 0.3;
    const h = makeHazard('wave', { bow });
    // The centre of the front is where it always was: the bow is measured
    // FROM the centre, so `centre` still lies on the crest and everything
    // that reads it -- the scope, the contact test, the coast clip -- is
    // still reading a point on the wave.
    expect(ridgeV(h, 0)).toBeCloseTo(0, 2);

    // And the ends trail by `bow * extent`, on the square law in `hazBowV`:
    // a quarter of the way out the wave has given up a sixteenth of it.
    const full = bow * CREST_HALF_LENGTH;
    expect(ridgeV(h, CREST_HALF_LENGTH * 0.5)).toBeCloseTo(-full * 0.25, 1);
    expect(ridgeV(h, -CREST_HALF_LENGTH * 0.5)).toBeCloseTo(-full * 0.25, 1);
    expect(ridgeV(h, CREST_HALF_LENGTH * 0.9)).toBeCloseTo(-full * 0.81, 1);

    // Trailing and not leading: every point of the front behind the centre,
    // which is the middle of the wave arriving first.
    for (const u of [2, 5, 8, -3, -6, -9]) {
      expect(ridgeV(h, u)).toBeLessThan(0);
    }
  });

  it('carries the steep face round the arc rather than leaving it on a plane', () => {
    // The front/back asymmetry is keyed off the BOWED coordinate, so the wall
    // the hull meets stays on the forward side all the way along the front.
    // Measured out at 80% of the half-length, where the arc has moved the
    // crest line by more than the front face is deep.
    const h = makeHazard('wave', { bow: CREST_BOW_MAX });
    const u = CREST_HALF_LENGTH * 0.8;
    const ridge = ridgeV(h, u);
    const face = CREST_HALF_WIDTH * CREST_FRONT_RATIO;
    const back = CREST_HALF_WIDTH * CREST_BACK_RATIO;
    // Zero just past the front face and just past the back of the arc...
    expect(hazardHeight(at(u, ridge + face + 0.01), [h])).toBe(0);
    expect(hazardHeight(at(u, ridge - back - 0.01), [h])).toBe(0);
    // ...and water in between, on the long side and the short one both.
    expect(hazardHeight(at(u, ridge + face * 0.5), [h])).toBeGreaterThan(0);
    expect(hazardHeight(at(u, ridge - back * 0.9), [h])).toBeGreaterThan(0);
  });

  it('does not change the footprint along the front', () => {
    // The bow displaces the wave across its travel line and not along it, so
    // the half-length `hazards.ts` runs its contact test and its coast clip
    // against is the same 10 units it is for a straight crest.
    const h = makeHazard('wave', { bow: CREST_BOW_MAX });
    const beyond = CREST_HALF_LENGTH + 0.01;
    for (let v = -12; v <= 6; v += 0.05) {
      expect(hazardHeight(at(beyond, v), [h])).toBe(0);
      expect(hazardHeight(at(-beyond, v), [h])).toBe(0);
    }
    expect(hazardHeight(at(CREST_HALF_LENGTH * 0.99, ridgeV(h, CREST_HALF_LENGTH * 0.99)), [h]))
      .toBeGreaterThan(0);
  });
});

describe('hazardfield: the crest profile', () => {
  it('peaks at amplitude times envelope at the centre', () => {
    for (const [amplitude, envelope] of [
      [CREST_HEIGHT, 1],
      [CREST_HEIGHT_MAX, 1],
      [CREST_HEIGHT_MAX, 0.4],
    ] as const) {
      const h = makeHazard('wave', { amplitude, envelope });
      expect(hazardHeight(at(0, 0), [h])).toBeCloseTo(amplitude * envelope, 5);
    }
  });

  it('peaks on a line rather than over a plateau, and reaches zero at the same footprint', () => {
    const h = makeHazard('wave', { amplitude: CREST_HEIGHT_MAX });

    /*
     * The profile along the crest's own length was `1 - smoothstep(0.4, 1, |x|)`
     * and this case used to say so, in the one word that has now stopped being
     * true: it HELD full height out to 40% of the half-length. That flat top is
     * what read as a mesa on the water, so the shape it was pinning is the
     * shape that changed, and this case is the record of what replaced it.
     *
     * Every bound below is a FRACTION of the amplitude, never a world-unit
     * height. This file has been caught once by an absolute threshold that
     * quietly turned a shape assertion into a scale assertion when a constant
     * moved (see the maelstrom's first-step case), and a crest's amplitude is
     * exactly the sort of constant that gets retuned by eye.
     */
    const at0 = (u: number) => hazardHeight(at(u, 0), [h]) / CREST_HEIGHT_MAX;

    // Falling already at a quarter of the way out, which is the whole point:
    // a plateau is any profile that is still at exactly 1 here. Falling by
    // under 5%, which is the other half of the point -- the wave has no
    // tabletop and it has not become a spike either, so a hull crossing the
    // middle third still climbs essentially the whole thing.
    expect(at0(CREST_HALF_LENGTH * 0.25)).toBeLessThan(1);
    expect(at0(CREST_HALF_LENGTH * 0.25)).toBeGreaterThan(0.95);

    // Halfway out it is still most of a wave; three quarters out it is still
    // real water rather than a skirt. These two are what stop the profile
    // being replaced by something that merely has no plateau, such as
    // `hazBump` itself, which would be down to 0.56 at half the half-length
    // and would let the hull cross the ends of a great wave unclimbed.
    expect(at0(CREST_HALF_LENGTH * 0.5)).toBeGreaterThan(0.75);
    expect(at0(CREST_HALF_LENGTH * 0.5)).toBeLessThan(0.95);
    expect(at0(CREST_HALF_LENGTH * 0.75)).toBeGreaterThan(0.3);
    expect(at0(CREST_HALF_LENGTH * 0.75)).toBeLessThan(0.6);

    // The maximum is reached ONCE, on the crest's middle line, and the profile
    // only ever falls away from it. A second bump anywhere along the length is
    // a ridge the hull could be caught between, and it is the failure mode a
    // hand-shaped polynomial grows without anyone noticing.
    let previous = at0(0);
    expect(previous).toBeCloseTo(1, 5);
    for (let u = 0.05; u <= CREST_HALF_LENGTH + 1e-9; u += 0.05) {
      const here = at0(u);
      expect(here).toBeLessThan(previous + 1e-9);
      previous = here;
    }

    // And nothing at all beyond the ends, or beyond the tail -- if this ever
    // becomes merely small rather than zero, the crest is tilting the normal
    // and foaming across the whole visible sea. The footprint is deliberately
    // unchanged by the reshaping above: `hazards.ts` runs its contact test
    // against `extent` and `halfWidth`, and a wave that stopped short of its
    // own footprint would be shoving the hull from water it was not standing
    // in. The tail is the far edge: the profile is asymmetric, so `CREST_BACK`
    // half-widths astern is where the water is finally flat again.
    expect(hazardHeight(at(CREST_HALF_LENGTH + 0.01, 0), [h])).toBe(0);
    expect(hazardHeight(at(0, CREST_HALF_WIDTH * CREST_FRONT_RATIO + 0.01), [h])).toBe(0);
    expect(hazardHeight(at(0, -CREST_HALF_WIDTH * CREST_BACK_RATIO - 0.01), [h])).toBe(0);
    expect(hazardHeight(at(40, 40), [h])).toBe(0);
  });

  it('has no step in its curvature along the length: the shoulders roll, they do not corner', () => {
    const h = makeHazard('wave', { amplitude: CREST_HEIGHT_MAX });

    /*
     * The reason the old profile read as a mesa was not only the flat top. It
     * was two corners: `1 - smoothstep(edge, 1, |x|)` is C1 at its shoulder but
     * NOT C2, so at |x| = 0.4 the profile's curvature stepped from exactly zero
     * to its full value inside one vertex, and a curvature step is what the eye
     * reads as an edge on a lit surface however smooth the height itself is.
     *
     * The replacement is a single polynomial over the whole half-length, so its
     * curvature is continuous everywhere inside the footprint and the shoulders
     * roll instead. This measures that with second differences, and the number
     * it asserts is a RATIO -- the largest step between neighbouring curvatures
     * over the largest curvature -- so it says nothing about how tall or how
     * long the wave is, only about whether the profile has a corner in it.
     *
     * At this probe spacing the old profile scores 0.51 and the current one
     * 0.09. The threshold sits between them with room on both sides rather
     * than hugging either.
     *
     * The spacing is a fiftieth of the half-length, which is a fifth of the
     * displacement patch's own vertex step. Probed at a whole vertex step
     * instead, the two profiles score 0.57 and 0.47 and this case would not
     * separate them at all -- which is worth knowing rather than hiding, and is
     * exactly why `hazardcrest.ts` breaks the crest's outline per-pixel as well.
     * Geometry alone does not win this at 0.5 world units a vertex.
     */
    const step = CREST_HALF_LENGTH * 0.01;
    const curvature: number[] = [];
    for (let u = -CREST_HALF_LENGTH + step; u <= CREST_HALF_LENGTH - step + 1e-9; u += step) {
      curvature.push(
        hazardHeight(at(u - step, 0), [h]) - 2 * hazardHeight(at(u, 0), [h]) + hazardHeight(at(u + step, 0), [h]),
      );
    }

    let largest = 0;
    let biggestStep = 0;
    for (let i = 0; i < curvature.length; i++) {
      largest = Math.max(largest, Math.abs(curvature[i]));
      if (i > 0) biggestStep = Math.max(biggestStep, Math.abs(curvature[i] - curvature[i - 1]));
    }
    expect(largest).toBeGreaterThan(0);
    expect(biggestStep / largest).toBeLessThan(0.2);
  });

  it('is symmetric along its length but NOT across it: a steep face, a long back', () => {
    const h = makeHazard('wave');
    /*
     * Along the crest line the wave is the same either side of its middle.
     *
     * This case is unchanged by the reshaping the two above record, and it is
     * worth saying why rather than leaving it looking untouched: the old
     * profile was even because it took `abs(x)` before doing anything else, and
     * the new one is even because it reaches `x` only through `x * x`. The
     * second is the stronger guarantee -- there is no branch and no absolute
     * value anywhere in it to get dropped -- so this case is now cheap
     * insurance rather than the thing holding the symmetry up.
     */
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

/*
 * The funnel is a BOWL -- `-D * (1 - r*r)^2` -- and not the cone `-D *
 * (1 - r)^3` it shipped as. The depth at the centre is the same number; the
 * shape of the descent to it is not, and these five cases are between them
 * what says so. The fifth is the reason the other four moved: the cone had a
 * sharp apex at r = 0 that a single patch vertex had to stand on, and a point
 * with no normal cannot be shaded however good the art over it is.
 */
describe('hazardfield: the maelstrom profile', () => {
  it('is FUNNEL_DEPTH deep at the centre, scaled by the envelope', () => {
    // The sign lives in the profile, not in `amplitude` -- see
    // `hazardStrength`. A funnel that comes back positive is a mountain.
    //
    // Unchanged by the move to a bowl, and deliberately so: the hull falls
    // exactly as far as it did, it just falls along a different curve.
    expect(hazardHeight(at(0, 0), [makeHazard('maelstrom')])).toBeCloseTo(-FUNNEL_DEPTH, 5);
    expect(hazardHeight(at(0, 0), [makeHazard('maelstrom', { envelope: 0.5 })])).toBeCloseTo(-FUNNEL_DEPTH * 0.5, 5);
  });

  it('scales its radius with `size`, so a growing maelstrom is a growing hole', () => {
    const half = makeHazard('maelstrom', { size: 0.5 });
    // Clear of a half-grown funnel, lip and all. The lip's outer edge now
    // lands exactly on the radius rather than 2% past it, so a maelstrom's
    // whole footprint really is its own radius and nothing of it is left
    // standing outside for the hull to trip over.
    expect(hazardHeight(at(MAELSTROM_RADIUS * 0.5 * 1.0001, 0), [half])).toBe(0);
    expect(hazardHeight(at(MAELSTROM_RADIUS * 0.5 * 1.05, 0), [half])).toBe(0);
    // And still a hole in the middle, at full depth.
    expect(hazardHeight(at(0, 0), [half])).toBeCloseTo(-FUNNEL_DEPTH, 5);
  });

  it('raises a lip of exactly RIM_HEIGHT at the rim and is flat outside it', () => {
    const m = makeHazard('maelstrom');
    /*
     * The lip crowns at 0.82 of the radius and carries RIM_HEIGHT exactly,
     * not RIM_HEIGHT minus whatever the funnel underneath had left. That is
     * the difference between adding the lip to the bowl and letting it
     * REPLACE the bowl beneath itself: a bowl is still a third of a unit deep
     * out here, so an added lip would crown short and off-centre.
     */
    expect(hazardHeight(at(MAELSTROM_RADIUS * 0.82, 0), [m])).toBeCloseTo(RIM_HEIGHT, 5);
    expect(hazardHeight(at(MAELSTROM_RADIUS + 1.5, 0), [m])).toBe(0);

    /*
     * And that crown is the whole profile's maximum, reached once. A second
     * ring anywhere would be a trough the hull could be caught circling in,
     * and it is exactly the sort of thing a lip riding on a sloped bowl grows
     * without anyone noticing.
     */
    let highest = -Infinity;
    let highestAt = 0;
    let previous = -Infinity;
    let turned = 0;
    // Half-thousandths of a radius, so the scan lands exactly on 0.82 rather
    // than a whisker either side of it and the crown it finds is the crown.
    for (let i = 0; i <= 2400; i++) {
      const r = i / 2000;
      const here = hazardHeight(at(MAELSTROM_RADIUS * r, 0), [m]);
      if (here > highest) {
        highest = here;
        highestAt = r;
      }
      // Count the times the profile stops climbing: up out of the bowl,
      // over the crown, down to flat water, and never again.
      if (here < previous - 1e-9 && turned === 0) turned = 1;
      else if (here > previous + 1e-9 && turned === 1) turned = 2;
      previous = here;
    }
    expect(highest).toBeCloseTo(RIM_HEIGHT, 5);
    expect(highestAt).toBeCloseTo(0.82, 2);
    expect(turned).toBe(1);
  });

  it('is radially symmetric -- the swirl is art, not geometry', () => {
    const m = makeHazard('maelstrom');
    const r = 4.5;
    const reference = hazardHeight(at(r, 0), [m]);
    for (const angle of [0.4, 1.1, 2.7, 4.9]) {
      expect(hazardHeight(at(r * Math.cos(angle), r * Math.sin(angle)), [m])).toBeCloseTo(reference, 5);
    }
  });

  it('has NO slope at all at the centre -- the apex is flat, not a cone point', () => {
    const m = makeHazard('maelstrom');
    const centre = hazardHeight(at(0, 0), [m]);

    /*
     * This is the case the whole change exists for.
     *
     * `-D * (1 - r)^3` descends at 3D/radius at the centre -- 0.9 world units
     * of height per world unit of ground on a 10-unit, 3-deep funnel -- and
     * it descends at that rate from a single point, in every direction at
     * once. That is a cone apex: not differentiable, no normal, and sampled
     * by about one vertex of the displacement grid, which is why the middle
     * of a maelstrom read as a spike of shading nonsense.
     *
     * `-D * (1 - r*r)^2` reaches the centre with zero slope and is a function
     * of r*r alone, so it is smooth in u and v rather than merely smooth in
     * r. Measured over a step this small the float32 field does not move AT
     * ALL -- the quadratic it now descends by is below half an ulp of 3.0 out
     * here -- so the slope is exactly zero rather than nearly it. The cone
     * gave 0.900 over the same step, which is what the 1e-6 below is really
     * separating this from.
     */
    const tiny = 1e-3;
    for (const [du, dv] of [
      [tiny, 0],
      [-tiny, 0],
      [0, tiny],
      [0, -tiny],
    ] as const) {
      const slope = (hazardHeight(at(du, dv), [m]) - centre) / tiny;
      expect(Math.abs(slope)).toBeLessThan(1e-6);
    }

    /*
     * And it is not merely flat in an interval too small to render. The
     * displacement patch lays a vertex every half world unit, so the first
     * vertex out from the centre is the one that used to sit on the side of
     * the spike: across that first step the cone climbed 0.285 of the funnel's
     * own depth per world unit of ground, the bowl climbs 0.010.
     *
     * Expressed as a FRACTION OF `FUNNEL_DEPTH`, deliberately. What this case
     * pins is the profile's shape near the origin, and the slope of any
     * profile scales with the depth it is scaled to -- so an absolute ceiling
     * here would be a shape assertion that silently becomes a depth assertion
     * the first time the funnel is made deeper. It was: the ceiling opened at
     * 0.05, which was 1.7% of a 3-unit funnel, and doubling the depth to 6
     * failed this line while the apex it exists to check had not moved at all.
     */
    const vertex = 0.5;
    const firstStep = (hazardHeight(at(vertex, 0), [m]) - centre) / vertex;
    expect(firstStep).toBeGreaterThan(0);
    expect(firstStep / FUNNEL_DEPTH).toBeLessThan(0.017);
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
    const many = [crest, crest, crest, makeHazard('wave')];
    expect(many.length).toBeGreaterThan(MAX_HAZARDS);
    expect(hazardHeight(at(0, 0), many)).toBeCloseTo(CREST_HEIGHT * MAX_HAZARDS, 5);
  });
});
