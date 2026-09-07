import type { BattleInput, BattleState, Cannonball, Combatant } from './types';

/**
 * battle.ts — the cannon fight, in flat arena units.
 *
 * STUB. The contract is real, the behaviour is not: `update` does nothing and
 * `outcome` stays null. Agent A fills this in; see docs/BATTLE_PLAN.md,
 * "battle.ts, the fight".
 *
 * The whole ruleset with no DOM and no Three, exactly as `fishsim.ts` is: two
 * boats on a shrinking circle, ten rounds each, three hits to lose. One sim is
 * built per battle and thrown away after, so nothing here has to reset.
 */

/** Rounds in each side's locker. */
export const ROUNDS = 10;
/** Hits that end a hull's fight. */
export const HITS_TO_LOSE = 3;

export interface BattleSim {
  /** Live, mutated in place for the length of one fight. */
  readonly state: BattleState;
  update(dt: number, input: BattleInput): void;
}

interface MutableCombatant extends Combatant {
  angle: number;
  x: number;
  z: number;
  heading: number;
  rounds: number;
  hits: number;
  cooldown: number;
}

interface MutableBattleState extends BattleState {
  radius: number;
  player: MutableCombatant;
  ai: MutableCombatant;
  balls: Cannonball[];
  elapsed: number;
  outcome: BattleState['outcome'];
  events: BattleState['events'];
}

function combatant(angle: number): MutableCombatant {
  return { angle, x: 0, z: 0, heading: 0, rounds: ROUNDS, hits: 0, cooldown: 0 };
}

export function createBattleSim(rng: () => number = Math.random): BattleSim {
  void rng;
  const state: MutableBattleState = {
    radius: 20,
    player: combatant(Math.PI),
    ai: combatant(0),
    balls: [],
    elapsed: 0,
    outcome: null,
    events: [],
  };

  return {
    state: state as BattleState,
    update(): void {
      /* stub */
    },
  };
}
