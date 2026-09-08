/**
 * lightning.test.ts — the bolt's shape, without a renderer.
 *
 * `buildBolt` is the only part of `lightning.ts` that can be tested without a
 * WebGL context, and it is also the only part that has to be right for the
 * module's two promises to hold: that a bolt never writes past the buffer it
 * was given, and that the same strike draws the same bolt twice. Everything
 * else in the module places a group and writes an opacity, which the smoke
 * test exercises in a real frame.
 *
 * Nothing here touches `weather.ts`. The seed is the whole contract between
 * the two, so the tests hand one over directly rather than waiting for a
 * storm to produce one.
 */
import { describe, expect, it } from 'vitest';
import {
  BOLT_FOOT,
  BOLT_TOP,
  MAX_SEGMENTS,
  TRUNK_STEPS,
  TRUNK_STRANDS,
  buildBolt,
} from '../../src/lightning';

/** A buffer the size `createLightning` allocates, plus a guard past the end. */
const GUARD = 12;

function fresh(): Float32Array {
  const buf = new Float32Array(MAX_SEGMENTS * 2 * 3 + GUARD);
  // The guard is poisoned rather than left at 0, so an overrun that happened
  // to write zeros would still be caught.
  for (let i = buf.length - GUARD; i < buf.length; i++) buf[i] = -999;
  return buf;
}

/** Every vertex of the bolt, as [x, y, z] triples, up to `segments`. */
function vertices(buf: Float32Array, segments: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < segments * 2; i++) out.push([buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]]);
  return out;
}

describe('lightning bolt geometry', () => {
  it('draws the same bolt for the same seed, and a different one for a different seed', () => {
    const a = fresh();
    const b = fresh();
    const c = fresh();

    const na = buildBolt(a, 0x1234abcd);
    const nb = buildBolt(b, 0x1234abcd);
    const nc = buildBolt(c, 0x1234abce);

    expect(nb).toBe(na);
    expect(Array.from(b)).toEqual(Array.from(a));
    // Not a strict requirement of the module, but a bolt that came out
    // identical from a neighbouring seed would mean the seed is not reaching
    // the walk at all.
    expect(Array.from(c)).not.toEqual(Array.from(a));
    expect(nc).toBeGreaterThan(0);
  });

  it('never writes past the buffer the caller allocated', () => {
    const buf = fresh();
    for (let seed = 1; seed <= 400; seed++) {
      const segments = buildBolt(buf, seed * 2654435761);
      expect(segments).toBeGreaterThan(0);
      expect(segments).toBeLessThanOrEqual(MAX_SEGMENTS);
      for (let i = buf.length - GUARD; i < buf.length; i++) expect(buf[i]).toBe(-999);
    }
  });

  it('always draws every strand of the trunk, and at least one fork', () => {
    const buf = fresh();
    for (let seed = 1; seed <= 200; seed++) {
      const segments = buildBolt(buf, seed * 40503);
      // The trunk is unconditional; the forks are 1 or BRANCH_MAX, never 0.
      expect(segments).toBeGreaterThan(TRUNK_STRANDS * TRUNK_STEPS);
    }
  });

  it('stays inside the cloud base and never reaches the water', () => {
    const buf = fresh();
    for (let seed = 1; seed <= 200; seed++) {
      const segments = buildBolt(buf, seed * 2246822519);
      for (const [, y] of vertices(buf, segments)) {
        expect(y).toBeLessThanOrEqual(BOLT_TOP + 1e-6);
        // The foot is the reason a bolt does not z-fight the sea along its
        // last segment. A fork that overshot it would put a bright line in
        // the water, which is the one failure that would be obvious in play
        // and invisible in a type check.
        expect(y).toBeGreaterThanOrEqual(BOLT_FOOT - 1e-6);
      }
    }
  });

  it('descends: no segment of the trunk ever climbs', () => {
    const buf = fresh();
    const segments = buildBolt(buf, 0xfeedface);
    const verts = vertices(buf, segments);
    for (let i = 0; i < segments; i++) {
      const top = verts[i * 2][1];
      const foot = verts[i * 2 + 1][1];
      expect(foot).toBeLessThan(top);
    }
  });

  it('zeroes the tail rather than leaving the last bolt standing in it', () => {
    const buf = fresh();
    // A seed that forks once leaves a whole fork's worth of the buffer unused;
    // one that forks twice fills more of it. Whichever way round they come
    // out, the shorter bolt must not be able to show the longer one's tail.
    let short = -1;
    let long = -1;
    for (let seed = 1; short < 0 || long < 0; seed++) {
      const n = buildBolt(buf, seed * 22695477);
      if (n < MAX_SEGMENTS) short = seed * 22695477;
      else long = seed * 22695477;
      expect(seed).toBeLessThan(500);
    }

    buildBolt(buf, long);
    const segments = buildBolt(buf, short);
    for (let i = segments * 6; i < MAX_SEGMENTS * 6; i++) expect(buf[i]).toBe(0);
  });
});
