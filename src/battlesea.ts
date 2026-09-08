import type { ArenaCrest, ArenaFlotsam, ArenaObstacle, BattleEvent, BattleOptions } from './types';

/**
 * battlesea.ts — the sea the fight is fought on, and the things floating in it.
 *
 * STUB. The contract below is the one `battle.ts` calls and the one
 * docs/BATTLE_REWORK_PLAN.md hands to agent B; the behaviour is a placeholder
 * that holds an empty sea, so the fight builds and plays on flat water while
 * the real one is being written.
 *
 * Three systems, all seeded from the sim's own `rng` and all switched
 * independently by `BattleOptions`, per the plan:
 *
 * - **Crests.** One at a time, rolling along one of the four cardinals, which
 *   shove each hull 2 to 6 units off its track as they pass and let it settle
 *   back. Sway is clamped so no hull's centre ever comes within
 *   `KEEL_CLEARANCE` of the arena centre, which is what keeps a shoved hull
 *   off the shoals without inventing a fourth way to lose.
 * - **Shoals and wreckage.** One to three, rolled once in the constructor so
 *   the scene can place them on its first frame, standing inside the ring
 *   where no hull ever goes. They block firing lines and nothing else.
 * - **Flotsam.** One raft at a time, drifting across the arena on a straight
 *   line. A hull that runs into it is fouled: half speed and no guns for
 *   `FOUL_SECONDS`. A ball put into it sinks it.
 *
 * Everything rolls from the `rng` it is handed and nothing else, so two sims
 * built from one seed and driven by one input agree to the last bit.
 */

/**
 * What the sea needs of a combatant: where its track is, and the three fields
 * it writes.
 *
 * Structural on purpose. `battle.ts`'s own mutable combatant satisfies this
 * without either module exporting a type for the other, and the sea can
 * therefore never reach a field it has no business writing.
 */
export interface SwayTarget {
  readonly angle: number;
  swayX: number;
  swayZ: number;
  fouled: number;
  cooldown: number;
}

/** The sea as `BattleState` exposes it: the same objects, read-only. */
export interface BattleSeaState {
  readonly crest: ArenaCrest | null;
  readonly obstacles: readonly ArenaObstacle[];
  readonly flotsam: ArenaFlotsam | null;
}

export interface BattleSea {
  readonly state: BattleSeaState;
  /**
   * One tick of the sea: write both hulls' sway, count their fouling down,
   * move the crest and the raft, launch new ones, and push any `foul` events
   * onto the list `battle.ts` is building for this tick.
   */
  update(
    dt: number,
    elapsed: number,
    radius: number,
    player: SwayTarget,
    ai: SwayTarget,
    events: BattleEvent[],
  ): void;
  /**
   * Where the sweep (ax,az)-(bx,bz) first meets an obstacle or the raft, or
   * null if it meets neither. Meeting the raft sinks it.
   */
  strike(ax: number, az: number, bx: number, bz: number): { x: number; z: number } | null;
}

/** Every system off. The sea a gunner is measured on, and what `?calm=1` asks for. */
export const CALM: BattleOptions = { waves: false, shoals: false, flotsam: false };

/** Every system on. The sea the game is played on. */
export const ROUGH: BattleOptions = { waves: true, shoals: true, flotsam: true };

/**
 * @param rng the sim's own seeded source.
 * @param options which of the three systems run. An option that is off
 *   produces nothing at all: no crest, no obstacles, no raft, and a `strike`
 *   that is always null.
 */
export function createBattleSea(
  rng: () => number = Math.random,
  options: BattleOptions = ROUGH,
): BattleSea {
  void rng;
  void options;
  const state: BattleSeaState = { crest: null, obstacles: [], flotsam: null };
  return {
    state,
    update(): void {
      /* the stub leaves the water flat */
    },
    strike(): { x: number; z: number } | null {
      return null;
    },
  };
}
