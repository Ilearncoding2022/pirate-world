import type { BattleState, Combatant } from './types';

/**
 * battleai.ts — the enemy gunner and the enemy helm.
 *
 * STUB. The contract below is the one `battle.ts` calls and the one
 * docs/BATTLE_REWORK_PLAN.md hands to agent A; the behaviour is a placeholder
 * that steers one way and never fires, so the fight builds and plays while the
 * real gunner is being written.
 *
 * What replaces it, per the plan:
 *
 * - **A two-second delay line.** `observe` records the truth every tick and
 *   `throttle` and `gun` read it `AI_LAG` seconds later, so everything the AI
 *   does is aimed at the player of two seconds ago. That is the dodge.
 * - **A coin in the helm.** One helm decision in four ignores the solution and
 *   picks a direction at random.
 * - **A fuse instead of a reaction.** The AI commits to a shot `AI_FUSE`
 *   seconds before it fires and the shot goes whether or not the solution
 *   still holds. The old reaction and jitter are deleted; this replaces both.
 *
 * The AI does not see the sea. It is shoved, fouled and blocked exactly as the
 * player is and does nothing about any of it, which is deliberate: the brief
 * asked for a gunner that is worse, and a helm that dodged rafts would be one
 * that is better.
 */

/** What the AI currently believes about the player, `AI_LAG` seconds stale. */
export interface AiView {
  /** The elapsed time this reading was taken at. */
  readonly t: number;
  readonly angle: number;
  readonly omega: number;
  readonly swayX: number;
  readonly swayZ: number;
}

export interface BattleAi {
  /**
   * Record the truth this tick. Called before `throttle` and `gun`, which see
   * this reading `AI_LAG` seconds from now.
   */
  observe(elapsed: number, player: Combatant, omegaPlayer: number): void;
  /**
   * This tick's throttle, +1 faster or -1 slower. Re-rolled every
   * `AI_HELM_PERIOD`; one roll in four is a coin rather than a solution.
   */
  throttle(dt: number, state: BattleState): 1 | -1;
  /**
   * `'aim'` on the one tick a shot is committed, `'fire'` on the one tick it
   * goes, null otherwise. `battle.ts` turns the first into an event and the
   * second into a round out of the locker.
   */
  gun(dt: number, state: BattleState): 'aim' | 'fire' | null;
  /** Seconds until the committed shot goes, or null. Copied onto `state.fuse`. */
  readonly fuse: number | null;
  /** The delayed reading, for the tests that prove it is delayed. */
  readonly view: AiView | null;
}

/** @param rng the sim's own seeded source, so a seeded fight is repeatable. */
export function createBattleAi(rng: () => number = Math.random): BattleAi {
  void rng;
  return {
    observe(): void {
      /* the stub remembers nothing */
    },
    throttle(): 1 | -1 {
      return 1;
    },
    gun(): 'aim' | 'fire' | null {
      return null;
    },
    get fuse(): number | null {
      return null;
    },
    get view(): AiView | null {
      return null;
    },
  };
}
