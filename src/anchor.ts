/**
 * anchor.ts — world position to screen position, in CSS pixels.
 *
 * One job, and it is deliberately the whole module: every HUD element that
 * wants to sit over a thing in the world needs this, and every one of them
 * would otherwise carry its own copy of the same eight lines with its own
 * subtly different answer to the behind-the-camera case.
 *
 * `docs/LEVIATHAN_PLAN.md` staged this as Phase 2 item 3 for exactly that
 * reason. The hunt's floating damage numbers and off-screen pointer are the
 * first two callers; a damage float over an enemy hull, a town label and a
 * salvage marker are the obvious next three, and none of them should have to
 * rediscover that `Vector3.project` returns z > 1 for a point behind the eye.
 *
 * **No `three` scene work here.** It reads a camera's matrices and writes
 * numbers. That keeps it testable under node against a bare `PerspectiveCamera`
 * with no renderer, no canvas and no DOM, which is what the unit tier is.
 */

import type { PerspectiveCamera, Vector3 } from 'three';

/**
 * Where a world point lands on screen.
 *
 * Mutated in place and handed back, on the frame-loop rule the rest of this
 * codebase follows: a projection that allocated would allocate once per
 * floating number per frame, and the numbers are a pool.
 */
export interface ScreenPoint {
  /** CSS pixels from the viewport's left edge. */
  x: number;
  /** CSS pixels from the viewport's top edge. */
  y: number;
  /**
   * True when the point is behind the camera's eye.
   *
   * `x` and `y` are still written, and are still usable as a DIRECTION — the
   * off-screen pointer needs one — but they are mirrored through the centre
   * and must never be treated as a place to put a label. Every caller checks
   * this before drawing anything that claims to sit ON the thing.
   */
  behind: boolean;
  /**
   * True when the point is inside the viewport and in front of the camera.
   *
   * The question nearly every caller actually wants to ask, computed here so
   * that six callers do not each write the same four comparisons and get the
   * edges inconsistent.
   */
  onScreen: boolean;
}

export function createScreenPoint(): ScreenPoint {
  return { x: 0, y: 0, behind: false, onScreen: false };
}

/**
 * Project `position` into viewport pixels.
 *
 * `width` and `height` are CSS pixels, not device pixels: the HUD is laid out
 * in CSS pixels and mixing the two is how an element ends up twice as far from
 * the edge on a retina display as on a plain one.
 *
 * The camera's matrices are used AS THEY STAND. Nothing here calls
 * `updateMatrixWorld`: the frame loop has already done it by the time the HUD
 * runs, and doing it again mid-frame is how a label ends up one frame ahead of
 * the thing it is labelling.
 */
export function project(
  position: Vector3,
  camera: PerspectiveCamera,
  width: number,
  height: number,
  out: ScreenPoint,
): ScreenPoint {
  /*
   * `Vector3.project` would allocate nothing but would also overwrite the
   * caller's vector, and the vectors handed to this are LIVE sim state — a
   * shadow's own position, held by reference on `HuntState`'s rule. Projecting
   * through a scratch avoids writing into the simulation from the HUD, which
   * is a bug that would look like the animal teleporting.
   */
  _scratch.x = position.x;
  _scratch.y = position.y;
  _scratch.z = position.z;
  _scratch.applyMatrix4(camera.matrixWorldInverse);

  /*
   * View space is right-handed with the camera looking down -z, so a point in
   * front of the eye has a NEGATIVE z here. That is the whole of the
   * behind-the-camera test, and doing it in view space rather than after the
   * perspective divide is what makes it reliable: the divide by a negative w
   * is exactly what mirrors the result through the origin.
   */
  out.behind = _scratch.z >= 0;

  _scratch.applyMatrix4(camera.projectionMatrix);

  if (!Number.isFinite(_scratch.x) || !Number.isFinite(_scratch.y)) {
    out.x = width * 0.5;
    out.y = height * 0.5;
    out.onScreen = false;
    return out;
  }

  /*
   * Mirrored on purpose when behind. `applyMatrix4` has already divided by w,
   * and for a point behind the eye that w was negative, so the result is the
   * true direction reflected through the centre. Reflecting it back is what
   * lets the pointer say "astern to port" rather than "ahead to starboard".
   */
  const ndcX = out.behind ? -_scratch.x : _scratch.x;
  const ndcY = out.behind ? -_scratch.y : _scratch.y;

  out.x = (ndcX * 0.5 + 0.5) * width;
  out.y = (-ndcY * 0.5 + 0.5) * height;
  out.onScreen =
    !out.behind && out.x >= 0 && out.x <= width && out.y >= 0 && out.y <= height;
  return out;
}

/**
 * Scratch for the projection, module-level and reused.
 *
 * Typed structurally rather than imported as a class so this module pulls in
 * no runtime `three` at all: it is three numbers and the two matrix applies
 * that `Vector3` would give it, and importing the class for that would put a
 * hundred kilobytes behind a HUD helper.
 */
const _scratch = {
  x: 0,
  y: 0,
  z: 0,
  applyMatrix4(m: { elements: ArrayLike<number> }): void {
    const { x, y, z } = this;
    const e = m.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const invW = w === 0 ? 0 : 1 / w;
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * invW;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * invW;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * invW;
  },
};
