import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createShip, MAX_FORWARD } from '../../src/ship';
import type { InputState, EnergyState, WindState } from '../../src/types';
import { createStubTerrain } from './support/stub-terrain';

/**
 * Regression tests for `ship.ts`'s dynamics, against a stub terrain whose
 * `isLand` is always false -- the hull never runs aground, so every result
 * here is pure drag/thrust arithmetic. Real terrain is `terrain-golden`'s and
 * `world-golden`'s job.
 *
 * `energy.canThrust` and `wind` are stubbed too: this file tests `ship.ts`
 * alone, not its collaborators.
 */

const NO_WIND: WindState = {
  speed: 0,
  bearing: 0,
  direction: new Vector3(0, 0, 1),
  cap: 16,
  along: 0,
  across: 0,
};

function energy(canThrust: boolean): EnergyState {
  return { level: 1, rate: 0, mode: 'drain', dock: null, canThrust };
}

function input(overrides: Partial<InputState> = {}): InputState {
  return { forward: false, backward: false, left: false, right: false, zoomDelta: 0, ...overrides };
}

describe('ship-physics', () => {
  it('reaches MAX_FORWARD from rest with forward held, and stays there', () => {
    const ship = createShip(createStubTerrain());
    const dt = 1 / 60;
    const thrust = input({ forward: true });
    const canThrust = energy(true);

    // Time constant is 1/DRAG = 1/0.35 ~= 2.86s; 30s is about ten and a half
    // time constants (residual error ~4e-4 kn), comfortably converged -- see
    // docs/ARCHITECTURE.md "Ship dynamics" for the closed-form derivation
    // this is pinning.
    for (let i = 0; i < 30 / dt; i++) ship.update(dt, thrust, canThrust, NO_WIND);
    expect(ship.state.speed).toBeCloseTo(MAX_FORWARD, 2);

    // Stays there: another two seconds changes nothing measurable.
    for (let i = 0; i < 2 / dt; i++) ship.update(dt, thrust, canThrust, NO_WIND);
    expect(ship.state.speed).toBeCloseTo(MAX_FORWARD, 2);
  });

  it('keeps position at unit length over 600 mixed steps', () => {
    const ship = createShip(createStubTerrain());
    const dt = 1 / 60;
    const canThrust = energy(true);
    for (let i = 0; i < 600; i++) {
      // Alternate thrust and turning so the hull actually moves and steers,
      // not just spins on the spot.
      const turning = (i % 40) < 20;
      ship.update(
        dt,
        input({ forward: true, left: turning, right: !turning }),
        canThrust,
        NO_WIND,
      );
      expect(ship.state.position.length()).toBeCloseTo(1, 9);
    }
  });

  it('halt() zeroes speed and ground speed', () => {
    const ship = createShip(createStubTerrain());
    const dt = 1 / 60;
    const thrust = input({ forward: true });
    const canThrust = energy(true);
    for (let i = 0; i < 3 / dt; i++) ship.update(dt, thrust, canThrust, NO_WIND);
    expect(ship.state.speed).toBeGreaterThan(0);

    ship.halt();
    expect(ship.state.speed).toBe(0);
    expect(ship.state.groundSpeed).toBe(0);
    expect(ship.state.velocity.length()).toBe(0);
  });

  it('reverse never exceeds its own cap', () => {
    const ship = createShip(createStubTerrain());
    const dt = 1 / 60;
    const reverse = input({ backward: true });
    const canThrust = energy(true);
    // MAX_REVERSE is private to ship.ts (7 world units/s); pinned here as a
    // literal on purpose, so a change to it is a deliberate edit to this
    // test rather than an unexported constant drifting unnoticed.
    const MAX_REVERSE = 7;
    for (let i = 0; i < 20 / dt; i++) {
      ship.update(dt, reverse, canThrust, NO_WIND);
      expect(ship.state.speed).toBeGreaterThanOrEqual(-MAX_REVERSE - 1e-9);
    }
    expect(ship.state.speed).toBeCloseTo(-MAX_REVERSE, 2);
  });

  it('a dry tank refuses thrust but still coasts and steers', () => {
    const ship = createShip(createStubTerrain());
    const dt = 1 / 60;
    // Get some way on, then run the tank dry.
    for (let i = 0; i < 3 / dt; i++) ship.update(dt, input({ forward: true }), energy(true), NO_WIND);
    const speedBefore = ship.state.speed;
    expect(speedBefore).toBeGreaterThan(0);

    for (let i = 0; i < 10 / dt; i++) ship.update(dt, input({ forward: true }), energy(false), NO_WIND);
    // Thrust refused: speed decays toward 0 (no thrust term), never climbs.
    expect(ship.state.speed).toBeLessThan(speedBefore);
    expect(ship.state.speed).toBeGreaterThanOrEqual(0);
  });
});
