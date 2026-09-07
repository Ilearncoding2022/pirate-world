import type { Object3D, Scene } from 'three';
import type { AiBoat, AiBoatState } from './types';

/**
 * aihulls.ts — the AI boats as things you can see.
 *
 * STUB. Agent B fills this in; see docs/BATTLE_PLAN.md, "aihulls.ts".
 *
 * A pool of at most two hull clones, built lazily from `ship.cloneHull()`,
 * placed on the globe from `aiboats.ts`'s state each frame, with their neon
 * recoloured and `rimglow.ts` installed in the boat's colour. Scene objects
 * only: it decides nothing and moves nothing of its own.
 */
export interface AiHulls {
  /** After `ship.update`, before `globe.update`. Places and lights the clones. */
  update(dt: number, state: AiBoatState): void;
  /**
   * The clone standing in for `boat`, for the arena to borrow, or null before
   * the glTF has loaded.
   */
  hullOf(boat: AiBoat): Object3D | null;
}

export function createAiHulls(scene: Scene, cloneHull: () => Object3D | null): AiHulls {
  void scene;
  void cloneHull;
  return {
    update(): void {
      /* stub */
    },
    hullOf(): Object3D | null {
      return null;
    },
  };
}
