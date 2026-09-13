import { describe, it, expect } from 'vitest';
import { beamFade, beamBlink, BEAM_FADE_START, BEAM_FADE_FULL } from '../../src/shipbeam';

describe('ship beam', () => {
  it('is absent on the deck and full at the far framing', () => {
    expect(beamFade(0)).toBe(0);
    expect(beamFade(BEAM_FADE_START)).toBe(0);
    expect(beamFade(BEAM_FADE_FULL)).toBe(1);
    expect(beamFade(1)).toBe(1);
  });

  it('fades in without a jump', () => {
    let last = 0;
    for (let z = BEAM_FADE_START; z <= BEAM_FADE_FULL; z += 0.01) {
      const f = beamFade(z);
      expect(f).toBeGreaterThanOrEqual(last);
      expect(f - last).toBeLessThan(0.05);
      last = f;
    }
  });

  it('breathes between a visible floor and full strength', () => {
    let min = 1;
    let max = 0;
    for (let t = 0; t < 10; t += 0.02) {
      const b = beamBlink(t);
      min = Math.min(min, b);
      max = Math.max(max, b);
    }
    expect(min).toBeGreaterThan(0.2);
    expect(max).toBeCloseTo(1, 2);
  });
});
