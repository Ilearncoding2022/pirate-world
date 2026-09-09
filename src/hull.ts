/**
 * hull.ts — durability: the second reserve, beside the power reserve.
 *
 * STUB. Step 0 of docs/HARBOURS_PLAN.md publishes this signature so streams
 * C and D can compile and be screenshotted against a sound hull; Stream B
 * replaces the body. Until then every field reads as a ship fresh out of the
 * yard and every method is a no-op, which is exactly the game as it shipped.
 *
 * The shape follows `battery.ts`: a float kept inside, a whole percent
 * published, and `onChange` fired only when that whole percent moves, so a
 * hull wearing at a quarter of a percent a minute writes the save about once
 * every four minutes instead of sixty times a second.
 */
import type { HullState } from './types';

export interface Hull {
  readonly state: HullState;
  /**
   * Advance the wear or the repair.
   *
   * `docked` wins over `weathered`: a ship alongside is being worked on, and
   * the weather it is sitting in does not matter. Called ONLY from the
   * sailing branch of the frame loop, which is what keeps the clock off
   * during fishing, a battle, the shop and the menu — see
   * docs/HARBOURS_PLAN.md, decision 12. It is a property of the call site
   * rather than a flag in here.
   */
  update(dt: number, docked: boolean, weathered: boolean): void;
  /** Knock `points` whole percent off, floored at `HULL_MIN`. */
  damage(points: number): void;
  /** Add `points` whole percent, capped at 100. */
  repair(points: number): void;
  /** Fires when the WHOLE percent changes, for the save. */
  onChange(fn: () => void): void;
}

/** Lowest the hull can ever go. There is no sinking and no game over. */
export const HULL_MIN = 1;

/**
 * The stub's state: a sound hull that nothing can move.
 *
 * `speedCap` is `Infinity` rather than `MAX_FORWARD` deliberately —
 * `ship.ts` takes `Math.min(propulsion.maxForward, speedCap)`, and a finite
 * value here would silently cap a Trim-upgraded ship at the base 10 knots.
 */
const SOUND: HullState = Object.freeze({
  percent: 100,
  speedCap: Infinity,
  canFish: true,
  hitsToLose: 3,
  mode: 'full' as const,
  rate: 0,
});

/**
 * A hull that never wears. Handed to every consumer as the default argument
 * in Step 0 so no call site has to know whether Stream B has landed.
 */
export function createStubHull(): Hull {
  return {
    state: SOUND,
    update: (): void => undefined,
    damage: (): void => undefined,
    repair: (): void => undefined,
    onChange: (): void => undefined,
  };
}

/**
 * The real hull. Stream B replaces this body; the signature is fixed here.
 *
 * @param initialPercent whole percent from the save file, [HULL_MIN, 100].
 */
export function createHull(initialPercent: number): Hull {
  void initialPercent;
  return createStubHull();
}
