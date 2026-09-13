/**
 * harbourpick.ts — which harbour a double-click on the world meant.
 *
 * No raycast into the scene. A beacon is a three-sided stick and a sprite, and
 * a ray would have to hit one of them exactly; a player aiming at a harbour
 * from orbit is aiming at a few pixels. So every beacon is projected to the
 * screen as a SEGMENT -- the foot of its mast to the top of its name label --
 * and the click takes the nearest one within a pixel radius. That covers the
 * mast, the lamp and the label with one rule, and it is forgiving in exactly
 * the way a finger needs.
 *
 * A beacon over the horizon cannot be picked: the line from the lens to it
 * passes through the planet. Terrain is not tested; a harbour behind a hill is
 * still where the player thinks it is, and the label is depth-tested anyway.
 *
 * Also the double-tap detector, so a mouse and a finger share one gesture.
 */
import { Vector3 } from 'three';
import type { Camera } from 'three';
import { GLOBE_RADIUS } from './geo';

export interface PickTarget {
  readonly name: string;
  readonly foot: Vector3;
  readonly top: Vector3;
}

/** How near a click has to land to a beacon's segment, CSS pixels. */
export const PICK_RADIUS_PX = 28;

const _eye = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

/**
 * True when the straight line from `eye` to `point` passes through the planet
 * before it arrives. The sphere is shrunk a hair so a point ON the surface is
 * not hidden by the surface it stands on.
 */
export function behindGlobe(eye: Vector3, point: Vector3, radius = GLOBE_RADIUS * 0.995): boolean {
  // |eye + t d|^2 = r^2, for t in (0, 1).
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return false;
  const b = 2 * (eye.x * dx + eye.y * dy + eye.z * dz);
  const c = eye.x * eye.x + eye.y * eye.y + eye.z * eye.z - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return false;
  const root = Math.sqrt(disc);
  const t0 = (-b - root) / (2 * a);
  const t1 = (-b + root) / (2 * a);
  return (t0 > 1e-6 && t0 < 1 - 1e-6) || (t1 > 1e-6 && t1 < 1 - 1e-6);
}

/** Distance from (px, py) to the segment (ax, ay)-(bx, by). */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/**
 * The name of the beacon nearest the click at (`x`, `y`), in CSS pixels from
 * the top-left of a `width` x `height` view, or null if none is within
 * `radiusPx`. `camera` must have up-to-date matrices.
 */
export function pickHarbour(
  targets: readonly PickTarget[],
  camera: Camera,
  x: number,
  y: number,
  width: number,
  height: number,
  radiusPx = PICK_RADIUS_PX,
): string | null {
  if (!(width > 0) || !(height > 0)) return null;
  camera.getWorldPosition(_eye);
  let best: string | null = null;
  let bestDistance = radiusPx;

  for (const target of targets) {
    if (behindGlobe(_eye, target.foot) && behindGlobe(_eye, target.top)) continue;
    _a.copy(target.foot).project(camera);
    _b.copy(target.top).project(camera);
    // Behind the lens: a projected point with |z| > 1 is outside the frustum
    // depth range and its x/y are mirrored garbage.
    if (Math.abs(_a.z) > 1 && Math.abs(_b.z) > 1) continue;
    const ax = (_a.x * 0.5 + 0.5) * width;
    const ay = (1 - (_a.y * 0.5 + 0.5)) * height;
    const bx = (_b.x * 0.5 + 0.5) * width;
    const by = (1 - (_b.y * 0.5 + 0.5)) * height;
    const d = distanceToSegment(x, y, ax, ay, bx, by);
    if (d <= bestDistance) {
      bestDistance = d;
      best = target.name;
    }
  }
  return best;
}

/**
 * Two presses close together in time and space are one double-click.
 *
 * Built on raw presses rather than the browser's `dblclick`, which a touch
 * screen does not reliably send, so a mouse and a finger go through the same
 * rule. A completed double consumes both presses: a triple is a double and
 * then the start of the next one, never two doubles.
 */
export interface DoubleTap {
  /** Record a press; true when it completes a double. `time` in milliseconds. */
  tap(x: number, y: number, time: number): boolean;
}

export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 30;

export function createDoubleTap(maxMs = DOUBLE_TAP_MS, maxPx = DOUBLE_TAP_PX): DoubleTap {
  let last: { x: number; y: number; time: number } | null = null;
  return {
    tap(x: number, y: number, time: number): boolean {
      if (
        last !== null &&
        time - last.time <= maxMs &&
        time >= last.time &&
        Math.hypot(x - last.x, y - last.y) <= maxPx
      ) {
        last = null;
        return true;
      }
      last = { x, y, time };
      return false;
    },
  };
}
