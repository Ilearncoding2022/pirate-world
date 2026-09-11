import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { world1337 } from './support/world-1337';
import { BAND_GUARANTEE_RAD, BAND_WANDER_RAD } from '../../src/terrain';
import { GLOBE_RADIUS, latLonToDir } from '../../src/geo';

/**
 * The equatorial strip's connectivity half.
 *
 * `tests/unit/terrain.test.ts` pins the arithmetic the promise rests on, which
 * is a statement about one point at a time. This file pins the part that only
 * a rasterised world can answer: whether the LANDMASSES -- connected things,
 * not heights -- keep off the equator, and whether the islands the strip is
 * allowed to keep stayed small.
 *
 * One world, shared from `world-1337`, because building one costs 1.3 s of the
 * five minutes `docs/TESTING.md` gives the whole job. That makes this a pin on
 * the pinned seed and not evidence about worlds in general; `npm run
 * world:measure` is what surveys fifty of them, and its numbers are quoted in
 * `terrain.ts`. The division of labour is deliberate: the cheap tier catches a
 * regression in seconds, the sweep is run by a person when the constants move.
 */
describe('the equatorial strip, as landmasses', () => {
  /*
   * The promise itself. `mainlandMinAbsLat` is measured over every surviving
   * landmass that is NOT one of the strip's own islets, so this is exactly
   * "how close did the coast get".
   */
  it('keeps every mainland coast outside the guaranteed strip', () => {
    const { data } = world1337();
    const approach = data.isletCull.mainlandMinAbsLat;
    expect(approach).toBeGreaterThanOrEqual(BAND_GUARANTEE_RAD);
    // ...and in units, which is the form the promise is written in: 20.
    expect(approach * GLOBE_RADIUS).toBeGreaterThanOrEqual(20);
  });

  /*
   * The failure `mainlandMinAbsLat` alone cannot express, and the one that
   * actually fired during calibration: a chain of band specks 4-connected out
   * to a continent puts mainland-connected land inside the strip without any
   * continent having crossed the veto. `worldgen.ts` rejects such a world, so
   * the pinned seed must not be one.
   */
  it('has no landmass bridging into the strip from outside it', () => {
    expect(world1337().data.isletCull.bandBridges).toBe(0);
  });

  /*
   * The cap, on whatever the strip happened to keep.
   *
   * Deliberately NOT "at least one island". That assertion was here while the
   * strip was fifty units wide and seed 1337 had one; at forty it has none, and
   * the surveyed rate is 12 islands across 50 worlds -- so roughly three
   * worlds in four have an empty strip and the pinned seed is one of them.
   * Pinning a population property to a single world was wrong even when it
   * passed: it would have failed on the narrowing without anything being
   * broken, which is the definition of a test that costs more than it catches.
   *
   * What that leaves unguarded is real and worth naming: if someone retunes
   * `BAND_CEILING` until NO world has an island in the strip, the feature
   * quietly becomes "no land at the equator" and every assertion here still
   * passes. `npm run world:measure` is where that shows up -- its islet count
   * is the acceptance figure, and `docs/ARCHITECTURE.md` quotes it. The unit
   * tier pins the caps; the survey pins the density.
   */
  it('keeps no island inside the strip larger than the cap', () => {
    const { data } = world1337();
    // 0 when the strip is empty, which is a pass: the cap is an upper bound.
    expect(data.isletCull.largestBandIslet).toBeLessThanOrEqual(150);
    expect(data.isletCull.bandIsletsKept).toBeGreaterThanOrEqual(0);
  });

  /*
   * And the whole point of the strip, in the terms a player would put it:
   * there is water at every longitude along the equator, so the world can be
   * sailed round. `worldgen.ts`'s `equatorOpen` is the gate; this samples the
   * same fact through the finished map, at a resolution a blocked meridian
   * could not hide inside.
   */
  it('leaves open water at every longitude on the equator itself', () => {
    const { data, terrain } = world1337();
    const dir = new Vector3();
    for (let lon = -180; lon < 180; lon += 0.5) {
      latLonToDir(0, lon, dir);
      expect(data.heightMap.sample(dir), `lon ${lon}`).toBeLessThanOrEqual(terrain.seaLevel);
    }
  });

  /*
   * The islets are inside the strip, by construction of the rule that judges
   * them: `islets.ts` only treats a landmass as one of the strip's if it lies
   * ENTIRELY within BAND_GUARANTEE_RAD + BAND_WANDER_RAD. Pinned because that
   * reach is the one number shared between two files, and an import that went
   * stale would quietly widen or narrow what counts as an islet.
   */
  it('judges an islet against the veto’s full reach, not its guarantee', () => {
    expect(BAND_GUARANTEE_RAD + BAND_WANDER_RAD).toBeCloseTo(0.16, 10);
  });
});
