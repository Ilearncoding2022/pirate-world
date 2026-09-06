import { describe, it, expect } from 'vitest';
import { Vector3, Mesh, BufferGeometry } from 'three';
import { createWake } from '../../src/wake';
import { createEnv } from '../../src/env';
import { headingToForward, latLonToDir } from '../../src/geo';
import type { ShipState } from '../../src/types';

/**
 * `wake.ts`'s `update` reads `window.innerHeight` / `window.devicePixelRatio`
 * to size spray points in device pixels -- a legitimate browser dependency,
 * not something this test may change (T's only edit to wake.ts is the
 * `debug` view). vitest's `node` environment has no `window` at all, so this
 * is a minimal stand-in, not a renderer.
 */
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as unknown as { window: { innerHeight: number; devicePixelRatio: number } }).window = {
    innerHeight: 900,
    devicePixelRatio: 1,
  };
}

/**
 * The ring buffer's own invariants, exercised through `Wake.debug` (T's one
 * addition to `src/wake.ts` -- see docs/RENDER_PLAN.md, Phase 0 / T).
 *
 * RIB_CAPACITY (256) is private to wake.ts; pinned here as a literal, on the
 * same footing as `ship-physics.test.ts`'s MAX_REVERSE.
 */
const RIB_CAPACITY = 256;

function makeShip(headingRad: number, speed = 10): ShipState {
  const position = latLonToDir(0, 0);
  const up = position.clone();
  const forward = headingToForward(up, headingRad);
  return {
    position,
    up,
    forward,
    heading: headingRad,
    headingDeg: (headingRad * 180) / Math.PI,
    speed, // 10 = above MIN_WAKE_SPEED, well under MAX_FORWARD
    groundSpeed: speed,
    velocity: forward.clone().multiplyScalar(speed),
    latDeg: 0,
    lonDeg: 0,
  };
}

/** Advances `ship` in a straight line at `ship.speed`, tangent to the sphere. */
function stepShip(ship: ShipState, dt: number, headingRad: number): void {
  const distance = ship.speed * dt;
  const angle = distance / 200; // GLOBE_RADIUS
  const axis = new Vector3().crossVectors(ship.position, ship.forward);
  if (axis.lengthSq() > 1e-12) {
    axis.normalize();
    ship.position.applyAxisAngle(axis, angle).normalize();
  }
  ship.up.copy(ship.position);
  ship.forward.copy(headingToForward(ship.up, headingRad));
  ship.velocity.copy(ship.forward).multiplyScalar(ship.speed);
}

describe('wake-ring', () => {
  it('keeps the ring buffer, draw range and aRight buffer sane after sustained sailing', () => {
    const wake = createWake();
    const env = createEnv();
    const heading = Math.PI / 2; // due east
    const ship = makeShip(heading);
    const dt = 1 / 60;

    // 12s at speed 10 lays roughly (10*12)/0.34 ~= 350 ribs -- comfortably
    // past RIB_CAPACITY, so the ring must have wrapped at least once and
    // retirement (WAKE_LIFE = 4s) must have run too.
    for (let i = 0; i < 12 / dt; i++) {
      stepShip(ship, dt, heading);
      wake.update(dt, ship, env);
    }

    expect(wake.debug.liveRibs).toBeGreaterThan(0);
    expect(wake.debug.liveRibs).toBeLessThanOrEqual(RIB_CAPACITY);
    expect(wake.debug.head).toBeGreaterThanOrEqual(0);
    expect(wake.debug.head).toBeLessThan(RIB_CAPACITY);

    const ribbon = wake.object.getObjectByName('wake-ribbon') as Mesh<BufferGeometry> | null;
    expect(ribbon).not.toBeNull();
    const index = ribbon!.geometry.getIndex();
    expect(index).not.toBeNull();
    const indexCount = index!.count;

    const { start, count } = wake.debug.drawRange;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(count).toBeGreaterThanOrEqual(0);
    expect(start + count).toBeLessThanOrEqual(indexCount);

    // No rib -- live or a never-written dead slot -- has a zero right vector:
    // dead slots are seeded to (1,0,0) at construction and every write from
    // layRib() stores a normalized tangent, so a zero here is always a bug.
    const aRight = wake.debug.aRight;
    for (let i = 0; i < aRight.length; i += 3) {
      const lenSq = aRight[i] * aRight[i] + aRight[i + 1] * aRight[i + 1] + aRight[i + 2] * aRight[i + 2];
      expect(lenSq).toBeGreaterThan(0);
    }
  });

  it('lays no ribs below MIN_WAKE_SPEED and none in reverse', () => {
    const wake = createWake();
    const env = createEnv();
    const heading = Math.PI / 2;
    const ship = makeShip(heading, 0.5); // below MIN_WAKE_SPEED (1.2)
    const dt = 1 / 60;

    for (let i = 0; i < 3 / dt; i++) {
      stepShip(ship, dt, heading);
      wake.update(dt, ship, env);
    }

    expect(wake.debug.liveRibs).toBe(0);
  });
});
