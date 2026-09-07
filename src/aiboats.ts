import { Vector3 } from 'three';
import type { HeightMap } from './heightmap';
import type { AiBoat, AiBoatKind, AiBoatState, EnergyState, HazardState, ShipState, Terrain, Towns } from './types';
import type { WaterBodies } from './waterbodies';

/**
 * aiboats.ts — the raiders on the sea.
 *
 * STUB. The contract is real, the behaviour is not: `update` does nothing and
 * `state.live` is always empty. Agent A fills this in; see
 * docs/BATTLE_PLAN.md, "aiboats.ts, the sim".
 *
 * Owns one `AiBoatState`, mutated in place for the life of the run, as
 * `wind.ts` owns `WindState` and `hazards.ts` owns `HazardState`. DOM-free and
 * scene-free: it moves numbers and vectors, and it is the module the unit
 * tests exercise. `aihulls.ts` is what puts meshes where it says.
 */

/** Seconds between spawn rolls. Matches `hazards.ts` deliberately. */
export const ROLL_PERIOD = 10;

export interface AiBoatsDeps {
  terrain: Terrain;
  heightMap: HeightMap;
  waterBodies: WaterBodies;
  towns: Towns;
  seed?: number;
  /**
   * Fired once, the frame a hull touches the player's. `main.ts` halts the
   * ship and opens the battle from here. The boat stays in `live` until
   * `remove` takes it, so the arena has a hull to borrow.
   */
  onContact: (boat: AiBoat) => void;
}

export interface AiBoats {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: AiBoatState;
  /**
   * After `hazards.update`, before `ship.update`: it needs this frame's
   * hazard phase, and contact has to halt the hull the same frame it happens.
   *
   * `suppressed` is `main.ts`'s verdict — docked, mid-blackout, or in a
   * maelstrom — and blocks both spawning and contact.
   */
  update(
    dt: number,
    ship: ShipState,
    energy: EnergyState,
    hazards: HazardState,
    suppressed: boolean,
  ): void;
  /** Removes the boat a fight was fought with, and starts the grace period. */
  remove(boat: AiBoat): void;
  /** Spawns one boat now. Tests and the `?boat=` dev query only. */
  force(kind: AiBoatKind, position: Vector3, forward: Vector3): void;
}

interface MutableAiBoatState {
  live: AiBoat[];
  grace: number;
}

export function createAiBoats(deps: AiBoatsDeps): AiBoats {
  void deps;
  const state: MutableAiBoatState = { live: [], grace: 0 };

  return {
    state: state as AiBoatState,
    update(): void {
      /* stub */
    },
    remove(): void {
      /* stub */
    },
    force(): void {
      /* stub */
    },
  };
}
