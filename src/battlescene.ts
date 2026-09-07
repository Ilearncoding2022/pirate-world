import { PerspectiveCamera, Scene } from 'three';
import type { Object3D } from 'three';
import type { Quality } from './quality';
import type { BattleState } from './types';

/**
 * battlescene.ts — the arena the fight happens in.
 *
 * STUB. Agent B fills this in; see docs/BATTLE_PLAN.md, "battlescene.ts".
 *
 * A second `Scene`, rendered through the same `postFx` the world is: an empty
 * flat sea, one sun at the elevation the world had at the moment of contact,
 * a fixed camera, and the cannonballs. It is NOT the globe water and must
 * never import `water.ts` — a plane and a small shader, not the planet.
 *
 * It borrows both hulls rather than owning them: `main.ts` reparents the
 * player's real hull and the AI's clone in on the way through the fade, and
 * takes them back on the way out.
 */
export interface BattleScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Takes both hulls in. `sunElevation` is `dot(ship.up, env.sunDirection)` at contact. */
  enter(playerHull: Object3D, aiHull: Object3D | null, sunElevation: number): void;
  update(dt: number, state: BattleState): void;
  /** Clears the balls and the flashes. The hulls are `main.ts`'s to move back. */
  exit(): void;
}

export function createBattleScene(quality: Quality): BattleScene {
  void quality;
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 2000);
  camera.position.set(0, 26, 34);
  camera.lookAt(0, 0, 0);

  return {
    scene,
    camera,
    enter(): void {
      /* stub */
    },
    update(): void {
      /* stub */
    },
    exit(): void {
      /* stub */
    },
  };
}
