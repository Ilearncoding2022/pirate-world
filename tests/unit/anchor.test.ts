import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createScreenPoint, project } from '../../src/anchor';

/**
 * `anchor.ts`'s one job: a world point to viewport pixels, and an honest
 * answer about whether it is behind the eye.
 *
 * A bare `PerspectiveCamera` and no renderer, which is the whole reason this
 * lives in its own module rather than inside a HUD element that would need a
 * document to be tested at all.
 */

const W = 800;
const H = 600;

/** A camera ten units up the +z axis, looking back at the origin. */
function lookingAtOrigin(): PerspectiveCamera {
  const camera = new PerspectiveCamera(55, W / H, 0.1, 6000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('project', () => {
  it('puts a point dead ahead in the middle of the viewport', () => {
    const out = project(new Vector3(0, 0, 0), lookingAtOrigin(), W, H, createScreenPoint());
    expect(out.x).toBeCloseTo(W / 2, 6);
    expect(out.y).toBeCloseTo(H / 2, 6);
    expect(out.behind).toBe(false);
    expect(out.onScreen).toBe(true);
  });

  it('puts a point to the camera right of centre, and above centre for up', () => {
    const camera = lookingAtOrigin();
    // A camera on +z looking back at the origin keeps the default up, so its
    // own right is +x and a point there lands right of centre. Asserting the
    // axes explicitly is the point of the case: these are the signs every
    // caller would otherwise guess at, and guess differently.
    const right = project(new Vector3(1, 0, 0), camera, W, H, createScreenPoint());
    expect(right.x).toBeGreaterThan(W / 2);
    expect(right.y).toBeCloseTo(H / 2, 6);

    const up = project(new Vector3(0, 1, 0), camera, W, H, createScreenPoint());
    // Screen y grows downward, so a point above the eye line is a SMALLER y.
    expect(up.y).toBeLessThan(H / 2);
    expect(up.x).toBeCloseTo(W / 2, 6);
  });

  it('flags a point behind the camera, and still gives a usable direction', () => {
    const camera = lookingAtOrigin();
    // Twenty units up +z is ten units BEHIND a camera sitting at +10 and
    // looking toward the origin.
    const out = project(new Vector3(0, 0, 20), camera, W, H, createScreenPoint());
    expect(out.behind).toBe(true);
    expect(out.onScreen).toBe(false);

    /*
     * The direction has to survive being behind, or the off-screen pointer
     * cannot say which way to turn. A thing astern and to one side must give
     * an x on that same side rather than the mirrored one the raw perspective
     * divide would produce.
     */
    const asternPort = project(new Vector3(-4, 0, 20), camera, W, H, createScreenPoint());
    const aheadPort = project(new Vector3(-4, 0, 0), camera, W, H, createScreenPoint());
    expect(Math.sign(asternPort.x - W / 2)).toBe(Math.sign(aheadPort.x - W / 2));
  });

  it('calls a point outside the viewport off screen without calling it behind', () => {
    const camera = lookingAtOrigin();
    const out = project(new Vector3(60, 0, 0), camera, W, H, createScreenPoint());
    expect(out.behind).toBe(false);
    expect(out.onScreen).toBe(false);
  });

  it('never writes into the vector it was handed', () => {
    /*
     * The vectors this is given are LIVE sim state — a shadow's own position,
     * held by reference. A projection that wrote back into one would look like
     * the animal teleporting whenever the HUD ran.
     */
    const position = new Vector3(3, 4, 5);
    project(position, lookingAtOrigin(), W, H, createScreenPoint());
    expect(position.x).toBe(3);
    expect(position.y).toBe(4);
    expect(position.z).toBe(5);
  });

  it('falls back to the centre rather than emitting NaN', () => {
    const out = project(
      new Vector3(Number.NaN, 0, 0),
      lookingAtOrigin(),
      W,
      H,
      createScreenPoint(),
    );
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.y)).toBe(true);
    expect(out.onScreen).toBe(false);
  });

  it('reuses the point it is handed, allocating nothing', () => {
    const camera = lookingAtOrigin();
    const out = createScreenPoint();
    expect(project(new Vector3(0, 0, 0), camera, W, H, out)).toBe(out);
  });
});
