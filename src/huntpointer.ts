/**
 * huntpointer.ts — an edge arrow toward a mark the camera cannot see.
 *
 * The chase camera looks forward and down, so a shoal astern is invisible
 * except as a dot on the scope. A player who has overshot — which is the most
 * common way to lose a mark, because closing is the instinct and the gate has
 * a FLOOR — has nothing telling them which way to come about.
 *
 * ## Hidden while armed
 *
 * Deliberate, and not an optimisation. Once the dial is live the player's eyes
 * belong on the bar and the animal, and an arrow pointing at something already
 * in frame is clutter competing with the one thing that matters.
 *
 * ## Why it needs `anchor.ts`
 *
 * A mark behind the camera projects to a point mirrored through the centre,
 * and every naive implementation of this gets that wrong and points the arrow
 * exactly backwards. `anchor.ts` flags `behind` and un-mirrors the direction,
 * which is the whole reason it is its own module.
 */

import type { PerspectiveCamera } from 'three';
import type { HuntState, ShipState } from './types';
import { createScreenPoint, project } from './anchor';
import { GLOBE_RADIUS } from './geo';

/** How far in from the viewport edge the arrow rides, CSS pixels. */
const MARGIN = 54;

export interface HuntPointer {
  update(state: HuntState, camera: PerspectiveCamera, ship: ShipState): void;
  dispose(): void;
}

export function createHuntPointer(): HuntPointer {
  const root = document.getElementById('hunt-pointer');
  const arrow = document.getElementById('hunt-pointer-arrow');
  const range = document.getElementById('hunt-pointer-range');
  const point = createScreenPoint();

  let shown = false;

  function hide(): void {
    if (!shown || root === null) return;
    shown = false;
    // `style.css` carries `.huntfx__pointer[hidden]`, so the attribute is the
    // one switch. It is also what the markup boots with, which is why an
    // early return while `shown` is false is safe.
    root.hidden = true;
  }

  return {
    update(state: HuntState, camera: PerspectiveCamera, ship: ShipState): void {
      if (root === null || arrow === null || range === null) return;

      const mark = state.shadows.find((s) => s.marked);
      if (state.phase !== 'drifting' || mark === undefined || state.armed) {
        hide();
        return;
      }

      const width = window.innerWidth;
      const height = window.innerHeight;
      project(mark.position, camera, width, height, point);

      // In frame and in front: the player can see the animal, so say nothing.
      if (point.onScreen) {
        hide();
        return;
      }

      /*
       * Clamp the projected point to a rectangle inset from the edge. For a
       * point behind the camera `anchor.ts` has already un-mirrored x and y,
       * so the direction is honest and this is the same clamp either way.
       */
      const cx = width / 2;
      const cy = height / 2;
      let dx = point.x - cx;
      let dy = point.y - cy;
      if (dx === 0 && dy === 0) dy = -1;

      // Scale the offset out until it touches the inset rectangle, so the
      // arrow sits ON the edge in the true direction rather than wherever the
      // projection happened to land.
      const limitX = cx - MARGIN;
      const limitY = cy - MARGIN;
      const scale = Math.min(
        limitX / Math.max(1e-6, Math.abs(dx)),
        limitY / Math.max(1e-6, Math.abs(dy)),
      );
      dx *= scale;
      dy *= scale;

      root.style.left = `${cx + dx}px`;
      root.style.top = `${cy + dy}px`;
      // The glyph is an up arrow, so the rotation is measured from up.
      arrow.style.transform = `rotate(${Math.atan2(dy, dx) * (180 / Math.PI) + 90}deg)`;

      const arc =
        Math.acos(Math.max(-1, Math.min(1, ship.position.dot(mark.position)))) * GLOBE_RADIUS;
      range.textContent = `${Math.round(arc)}`;

      if (!shown) {
        shown = true;
        root.hidden = false;
      }
    },

    dispose(): void {
      hide();
    },
  };
}
