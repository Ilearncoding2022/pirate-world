import { describe, it, expect } from 'vitest';
import {
  fixAllPrice,
  isDevMode,
  HULL_REPAIR_PRICE,
  HULL_REPAIR_STEP,
} from '../../src/shop';

/**
 * `shop.ts`'s two pure exports, and only those two.
 *
 * `docs/TESTING.md` records that the chandlery is unreachable from the browser
 * tier -- `#btn-shop` ships disabled, only a berth arms it, and no container
 * will sail to one at a tenth of wall clock -- and its offers are addressed by
 * template literal, so even grepping the markup for an id proves nothing. The
 * panel itself is owner-eye-only. What CAN be pinned is the arithmetic, and
 * `fixAllPrice` is the only piece of it a retune could get wrong silently: it
 * is the one figure a player is charged that is not simply a constant.
 */
describe('shop', () => {
  describe('fixAllPrice', () => {
    it('is nothing at all for a sound hull', () => {
      expect(fixAllPrice(100)).toBe(0);
    });

    it('charges one whole step for any part of one', () => {
      // The rounding decision 16 asks for, at both ends of the same step: a
      // hull one percent down and a hull ten percent down pay the same
      // hundred, because ten percent is the smallest thing on sale.
      expect(fixAllPrice(99)).toBe(HULL_REPAIR_PRICE);
      expect(fixAllPrice(91)).toBe(HULL_REPAIR_PRICE);
      expect(fixAllPrice(90)).toBe(HULL_REPAIR_PRICE);
      // And 89 is over the step, so it is the first price that is two.
      expect(fixAllPrice(89)).toBe(2 * HULL_REPAIR_PRICE);
    });

    it('charges ten steps at the floor', () => {
      // The hull never goes below 1, so this is the most anyone can ever pay:
      // 99 percent is ten steps rounded up, a thousand gold, which is a backup
      // cell -- expensive enough to still be a decision against sailing home.
      expect(fixAllPrice(1)).toBe(1000);
    });

    it('never quotes a negative price', () => {
      // Not reachable through `HullState`, whose percent is clamped to
      // [1, 100]. Pinned anyway because this function is exported and the
      // clamp lives in another file.
      expect(fixAllPrice(120)).toBe(0);
    });

    it('agrees with the step price at every step of the ladder', () => {
      for (let steps = 1; steps <= 100 / HULL_REPAIR_STEP; steps++) {
        const percent = 100 - steps * HULL_REPAIR_STEP;
        expect(fixAllPrice(percent)).toBe(steps * HULL_REPAIR_PRICE);
      }
    });
  });

  describe('isDevMode', () => {
    it('is on only behind ?dev', () => {
      expect(isDevMode('?dev')).toBe(true);
      expect(isDevMode('?dev=1')).toBe(true);
      expect(isDevMode('?quality=high&dev')).toBe(true);
      expect(isDevMode('')).toBe(false);
      expect(isDevMode('?quality=high')).toBe(false);
    });
  });
});
