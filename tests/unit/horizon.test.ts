import { describe, it, expect } from 'vitest';
import { limbSin, sunAppearsSin, SUN_APPEARS_SIN } from '../../src/horizon';
import { CHASE_CAMERA_RADIUS } from '../../src/camera';
import { GLOBE_RADIUS } from '../../src/geo';
import { SUN_DISC_RADIANS } from '../../src/celestial';
import { createDayNight, DAY_LENGTH } from '../../src/daynight';
import { createEnv } from '../../src/env';

/**
 * The drawn horizon, and the light that has to agree with it.
 *
 * This file exists because the number it pins is invisible. Nothing on screen
 * says "the sea is 25 degrees below eye level"; it is a consequence of a radius
 * and a camera distance, and it decides when the day starts, when the light
 * comes up, and when a fight is lit like dusk. Wrong by ten degrees and
 * everything still renders, just at the wrong hour.
 */

const degrees = (sine: number): number => (Math.asin(sine) * 180) / Math.PI;

describe('the drawn horizon', () => {
  it('puts the sea well below eye level at the framing the game opens on', () => {
    // ~220.7 units out from a radius-200 globe: the chase camera's opening
    // distance and height, plus the hull's own altitude. If this drifts, the
    // camera was retuned and every number below moved with it -- which is the
    // point of deriving them, but it should be a deliberate move.
    expect(CHASE_CAMERA_RADIUS).toBeCloseTo(220.7, 1);
    expect(degrees(limbSin(CHASE_CAMERA_RADIUS))).toBeCloseTo(-25.0, 1);
  });

  it('agrees with the expression sky.ts draws the limb from', () => {
    // `sky.ts` recomputes `-sqrt(1 - R^2 / d^2)` per pixel for its gradient and
    // its twilight band. The sun has to rise out of the same band it is drawn
    // against, so the two cannot be allowed to drift apart.
    for (const radius of [210, CHASE_CAMERA_RADIUS, 300, 900]) {
      const shader = -Math.sqrt(1 - (GLOBE_RADIUS * GLOBE_RADIUS) / (radius * radius));
      expect(limbSin(radius)).toBeCloseTo(shader, 12);
    }
  });

  it('drops further as the camera climbs, and answers 0 rather than NaN inside', () => {
    expect(limbSin(300)).toBeLessThan(limbSin(210));
    expect(limbSin(GLOBE_RADIUS)).toBe(0);
    expect(limbSin(0)).toBe(0);
  });

  it('holds the disc back by its own radius, at both ends of the day', () => {
    /*
     * The sun appears when its TOP edge clears the limb, so its centre is still
     * a disc radius under. The same subtraction serves nightfall, because the
     * top edge is the last part to go under as well as the first to come up --
     * which is why daybreak and nightfall are one threshold and cannot fall out
     * of step with each other.
     */
    const limb = Math.asin(limbSin(CHASE_CAMERA_RADIUS));
    expect(Math.asin(SUN_APPEARS_SIN)).toBeCloseTo(limb - SUN_DISC_RADIANS, 12);
    expect(SUN_APPEARS_SIN).toBeLessThan(limbSin(CHASE_CAMERA_RADIUS));
    expect(SUN_APPEARS_SIN).toBeCloseTo(-0.45, 2);
  });

  it('answers a deeper horizon for a higher camera, and pins the shipped one', () => {
    // The drop is real, and both consumers ignore it on purpose -- the dial so
    // that zooming cannot set the sun, the lighting so that zooming out at
    // dusk cannot brighten the sea. `sky.ts` is the one that follows it, per
    // pixel, because the dome is what is drawn against the horizon.
    expect(sunAppearsSin(CHASE_CAMERA_RADIUS)).toBe(SUN_APPEARS_SIN);
    expect(sunAppearsSin(400)).toBeLessThan(SUN_APPEARS_SIN);
  });
});

describe('the light the horizon grades', () => {
  /**
   * `env.dayFactor` with the sun standing at a given elevation over the
   * reference view direction.
   *
   * With no renderer the camera probe never fires, so `daynight.ts` falls back
   * to lon 0 at the opening framing -- which is exactly the case being tested.
   * The sun's declination is zero, so its elevation there is `cos(tod * 2PI)`.
   */
  function dayFactorAt(sinElevation: number): number {
    const env = createEnv();
    env.elapsed = (Math.acos(sinElevation) / (Math.PI * 2)) * DAY_LENGTH;
    createDayNight().update(0, env);
    return env.dayFactor;
  }

  it('is still dark with the sun under the sea', () => {
    expect(dayFactorAt(SUN_APPEARS_SIN - 0.1)).toBe(0);
    expect(dayFactorAt(SUN_APPEARS_SIN)).toBeCloseTo(0, 6);
  });

  it('comes up while the disc is visible but below eye level', () => {
    /*
     * The bug this change exists to fix. The old grading ran from -0.2, so
     * every elevation here reported flat zero: a sun drawn plainly over the
     * water with the sea lit as midnight, for a quarter of the sky's worth of
     * climb.
     */
    const justUp = dayFactorAt(SUN_APPEARS_SIN + 0.05);
    const higher = dayFactorAt(-0.2);
    const atEyeLevel = dayFactorAt(0);

    expect(justUp).toBeGreaterThan(0);
    expect(higher).toBeGreaterThan(justUp);
    expect(atEyeLevel).toBeGreaterThan(higher);
    // Well into daylight by the time the sun reaches eye level.
    expect(atEyeLevel).toBeGreaterThan(0.7);
  });

  it('reaches full daylight where it always did', () => {
    // Only the low end of the ramp moved. Its top is the same 0.22 it was.
    expect(dayFactorAt(0.22)).toBeCloseTo(1, 6);
    expect(dayFactorAt(0.6)).toBe(1);
  });
});
