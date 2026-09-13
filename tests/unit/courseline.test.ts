import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { sampleArc } from '../../src/courseline';

describe('course line arc', () => {
  it('runs from the ship to the berth on the unit sphere', () => {
    const from = new Vector3(1, 0, 0);
    const to = new Vector3(0, 1, 0);
    const arc = sampleArc(from, to, 33);
    expect(arc).toHaveLength(33);
    expect(arc[0].distanceTo(from)).toBeLessThan(1e-9);
    expect(arc[32].distanceTo(to)).toBeLessThan(1e-9);
    for (const p of arc) expect(p.length()).toBeCloseTo(1, 9);
  });

  it('takes the short way round in even steps', () => {
    const arc = sampleArc(new Vector3(1, 0, 0), new Vector3(0, 0, 1), 11);
    const step = arc[0].angleTo(arc[1]);
    expect(step).toBeCloseTo(Math.PI / 2 / 10, 9);
    for (let i = 1; i < arc.length; i++) expect(arc[i - 1].angleTo(arc[i])).toBeCloseTo(step, 9);
  });

  it('survives antipodal and identical ends', () => {
    const arc = sampleArc(new Vector3(0, 1, 0), new Vector3(0, -1, 0), 9);
    for (const p of arc) {
      expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
      expect(p.length()).toBeCloseTo(1, 9);
    }
    expect(arc[8].y).toBeCloseTo(-1, 9);
    const same = sampleArc(new Vector3(0, 0, 1), new Vector3(0, 0, 1), 4);
    for (const p of same) expect(p.z).toBeCloseTo(1, 9);
  });
});
