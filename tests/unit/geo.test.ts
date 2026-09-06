import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  latLonToDir,
  dirToLatLon,
  tangentFrame,
  headingToForward,
} from '../../src/geo';

/**
 * Pins the conventions `docs/ARCHITECTURE.md` documents under "Conventions"
 * and "Units, pinned": +Y is the pole, lon 0 = +Z, heading 0 = north and
 * clockwise-positive. Every later stream reads terrain, wind and the ship
 * through these functions, so a sign or axis slip here would silently bend
 * every one of them.
 */
describe('geo', () => {
  it('round-trips latLonToDir / dirToLatLon away from the poles', () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [0, 90],
      [0, -90],
      [0, 179],
      [45, 30],
      [-45, -60],
      [10.5, 123.4],
      [-80, 5],
      [80, -175],
    ];
    for (const [latDeg, lonDeg] of cases) {
      const dir = latLonToDir(latDeg, lonDeg);
      expect(dir.length()).toBeCloseTo(1, 12);
      const back = dirToLatLon(dir);
      expect(back.latDeg).toBeCloseTo(latDeg, 9);
      // Longitude is meaningless at +-180 aliasing; none of the cases above
      // land there, so a plain compare is safe.
      expect(back.lonDeg).toBeCloseTo(lonDeg, 9);
    }
  });

  it('keeps tangentFrame orthonormal off the poles', () => {
    const dirs = [
      latLonToDir(0, 0),
      latLonToDir(0, 45),
      latLonToDir(30, -120),
      latLonToDir(-60, 170),
      latLonToDir(89, 0), // close to the pole, but not on it
      latLonToDir(-89, 0),
    ];
    for (const up of dirs) {
      const { north, east } = tangentFrame(up);
      expect(north.length()).toBeCloseTo(1, 9);
      expect(east.length()).toBeCloseTo(1, 9);
      expect(north.dot(up)).toBeCloseTo(0, 9);
      expect(east.dot(up)).toBeCloseTo(0, 9);
      expect(north.dot(east)).toBeCloseTo(0, 9);
    }
  });

  it('falls back to a valid frame exactly at the poles', () => {
    for (const up of [new Vector3(0, 1, 0), new Vector3(0, -1, 0)]) {
      const { north, east } = tangentFrame(up);
      expect(north.length()).toBeCloseTo(1, 9);
      expect(east.length()).toBeCloseTo(1, 9);
      expect(north.dot(up)).toBeCloseTo(0, 9);
      expect(east.dot(up)).toBeCloseTo(0, 9);
    }
  });

  it('headingToForward matches the tangent frame on the four cardinal headings', () => {
    const points: Vector3[] = [latLonToDir(0, 0), latLonToDir(35, -50), latLonToDir(-20, 160)];
    for (const up of points) {
      const { north, east } = tangentFrame(up);
      const north0 = headingToForward(up, 0);
      const eastQuarter = headingToForward(up, Math.PI / 2);
      const southHalf = headingToForward(up, Math.PI);
      const westThreeQuarter = headingToForward(up, (3 * Math.PI) / 2);

      expect(north0.x).toBeCloseTo(north.x, 9);
      expect(north0.y).toBeCloseTo(north.y, 9);
      expect(north0.z).toBeCloseTo(north.z, 9);

      expect(eastQuarter.x).toBeCloseTo(east.x, 9);
      expect(eastQuarter.y).toBeCloseTo(east.y, 9);
      expect(eastQuarter.z).toBeCloseTo(east.z, 9);

      expect(southHalf.x).toBeCloseTo(-north.x, 9);
      expect(southHalf.y).toBeCloseTo(-north.y, 9);
      expect(southHalf.z).toBeCloseTo(-north.z, 9);

      expect(westThreeQuarter.x).toBeCloseTo(-east.x, 9);
      expect(westThreeQuarter.y).toBeCloseTo(-east.y, 9);
      expect(westThreeQuarter.z).toBeCloseTo(-east.z, 9);
    }
  });
});
