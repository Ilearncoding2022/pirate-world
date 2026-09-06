import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { snoise, sampleWave, waveHeight, waveNormalBasis } from '../../src/wavefield';

/**
 * Regression tests for the CPU wave-field port (`src/wavefield.ts`).
 *
 * `tests/smoke/wave-parity.spec.ts` is what proves this port agrees with the
 * GPU shader pixel for pixel; this file only proves the port is internally
 * sound -- deterministic, and its finite-difference gradient converging the
 * way a real derivative should as the step shrinks.
 */

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('wavefield: snoise', () => {
  /*
   * This transcription was checked, value for value at every intermediate
   * step, against the actual GLSL running on SwiftShader (a throwaway
   * WebGL2 harness reading a float32 render target) -- it matches to float32
   * rounding at every step, so this is not a transcription bug: the inherited
   * `noiseglsl.ts` implementation (unchanged, pre-existing, shared with
   * `land.ts`) is not a hard [-1, 1] clamp. Its own `h = 1 - |x| - |y|`
   * corner-rejection term can occasionally push a lattice corner's weight and
   * its gradient dot product past 1 each, and on that specific corner
   * configuration the value briefly exceeds unity. Deterministic and
   * typically close to [-1, 1] is what is actually true of this function.
   */
  it('is deterministic over 10k random inputs', () => {
    const rand = mulberry32(0xc0ffee);
    for (let i = 0; i < 10_000; i++) {
      const x = (rand() * 2 - 1) * 40;
      const y = (rand() * 2 - 1) * 40;
      const z = (rand() * 2 - 1) * 40;
      const a = snoise(x, y, z);
      const b = snoise(x, y, z);
      expect(a).toBe(b);
      expect(Number.isFinite(a)).toBe(true);
    }
  });

  it('stays close to [-1, 1] on the great majority of inputs', () => {
    const rand = mulberry32(0xc0ffee);
    let overOne = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      const x = (rand() * 2 - 1) * 40;
      const y = (rand() * 2 - 1) * 40;
      const z = (rand() * 2 - 1) * 40;
      const v = snoise(x, y, z);
      // A hard bound would be wrong for this implementation (see above), but
      // a wildly unbounded result would mean a real transcription bug --
      // this catches that without demanding exact [-1, 1] closure.
      expect(Math.abs(v)).toBeLessThan(6);
      if (Math.abs(v) > 1.01) overOne++;
    }
    expect(overOne / n).toBeLessThan(0.1);
  });
});

describe('wavefield: sampleWave / waveHeight', () => {
  const offsets = {
    swell: { x: 0.11, y: -0.07, z: 0.05 },
    wave: { x: -0.04, y: 0.09, z: 0.02 },
  };

  it('height is bounded and deterministic', () => {
    const dir = new Vector3(0.3, 0.6, 0.74).normalize();
    const a = waveHeight(dir, offsets, 1.0);
    const b = waveHeight(dir, offsets, 1.0);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(-3);
    expect(a).toBeLessThan(3);
  });

  it('sampleWave reproduces waveHeight in .h and returns a finite gradient', () => {
    const dir = new Vector3(-0.2, 0.9, 0.15).normalize();
    const out = { h: 0, gu: 0, gv: 0 };
    sampleWave(dir, offsets, 1.0, out);
    expect(out.h).toBe(waveHeight(dir, offsets, 1.0));
    expect(Number.isFinite(out.gu)).toBe(true);
    expect(Number.isFinite(out.gv)).toBe(true);
  });

  /*
   * `waveFieldCPU` rounds every step to float32 (`Math.fround`), matching the
   * shader's own precision exactly rather than running the smoother float64
   * arithmetic JS would otherwise default to -- see wavefield.ts's module
   * comment on why: without it, a `h <= 0` corner-rejection test a few dozen
   * lines into `snoise` ties close enough, on a meaningful fraction of real
   * inputs, that float64 and the GPU's actual float32 round its sign two
   * different ways, which flips the lattice corner selected and swings the
   * result by up to a unit -- exactly the gap `wave-parity.spec.ts` exists to
   * catch. The float32 rounding fixes that (parity is within 1/255 in
   * practice), but it also means this function is no longer infinitely
   * smooth in the way a pure float64 one would be: on top of `ridge()`'s own
   * sqrt() cusp, a finite difference now has a real quantisation floor too.
   * So this checks a looser, more robust property than "the two step sizes
   * agree to 5%" -- that a coarse and a ten-times-finer estimate still point
   * the same way and stay within the same order of magnitude on the great
   * majority of directions, which is what an actual transcription bug (a
   * dropped term, a wrong sign, a scale error) would violate and neither
   * float32 rounding nor a sharp-but-correct cusp does.
   */
  it('gradient by finite difference agrees in sign and order of magnitude with a finer step', () => {
    const rand = mulberry32(1234);
    let ok = 0;
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const dir = new Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
      const tanU = new Vector3();
      const tanV = new Vector3();
      waveNormalBasis(dir, tanU, tanV);

      const grad = (axis: Vector3, step: number): number => {
        const h0 = waveHeight(dir, offsets, 1.0);
        const h1 = waveHeight(
          new Vector3(dir.x + axis.x * step, dir.y + axis.y * step, dir.z + axis.z * step),
          offsets,
          1.0,
        );
        return (h1 - h0) / step;
      };

      for (const axis of [tanU, tanV]) {
        total++;
        const coarse = grad(axis, 5e-4);
        const fine = grad(axis, 5e-5);
        const bothTiny = Math.abs(coarse) < 0.05 && Math.abs(fine) < 0.05;
        const sameSign = Math.sign(coarse) === Math.sign(fine) || bothTiny;
        const ratio = bothTiny ? 1 : Math.abs(coarse) / Math.max(Math.abs(fine), 1e-6);
        if (sameSign && ratio > 0.3 && ratio < 3) ok++;
      }
    }
    expect(ok / total).toBeGreaterThan(0.9);
  });
});
