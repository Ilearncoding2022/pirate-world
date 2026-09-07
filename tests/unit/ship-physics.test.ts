import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { Material } from 'three';
import { createShip, MAX_FORWARD, MODEL_SCALE } from '../../src/ship';
import type { HazardState, InputState, EnergyState, WindState } from '../../src/types';
import { createStubTerrain } from './support/stub-terrain';
import { tangentFrame } from '../../src/geo';

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
  it('obeys a hazard drive, and place() sets the hull down stopped on a heading', () => {
    const ship = createShip(createStubTerrain());
    const dt = 1 / 60;
    const canThrust = energy(true);

    // Get real way on first, so the assertions below are about the drive
    // taking the hull over rather than about a ship that was never moving.
    for (let i = 0; i < 3 / dt; i++) ship.update(dt, input({ forward: true }), canThrust, NO_WIND);
    expect(ship.state.speed).toBeGreaterThan(0);

    // A point well clear of both poles: `heading` is read off `forward`
    // through the tangent frame, which is degenerate at them.
    const position = new Vector3(1, 0.3, 0.2).normalize();
    const north = new Vector3();
    const east = new Vector3();
    tangentFrame(position, north, east);

    const drive: HazardState = {
      live: [],
      along: 0,
      across: 0,
      phase: 'spiral',
      drive: { position, forward: east, sink: 1.2 },
    };

    // Helm hard over and the throttle wide open: a captured hull answers
    // neither, so both are held down through the whole step.
    for (let i = 0; i < 10; i++) {
      ship.update(dt, input({ forward: true, left: true }), canThrust, NO_WIND, undefined, drive);
      expect(ship.state.position.distanceTo(position)).toBeLessThan(1e-9);
      expect(ship.state.speed).toBe(0);
      expect(ship.state.groundSpeed).toBe(0);
      expect(ship.state.velocity.length()).toBe(0);
      expect(ship.state.position.length()).toBeCloseTo(1, 9);
      // The bow is the drive's, re-orthogonalised against the position rather
      // than transported: the spiral's own direction of motion.
      expect(ship.state.forward.dot(east)).toBeCloseTo(1, 9);
    }

    // The respawn. `place` is the one call in the game allowed to move the
    // ship without walking it there.
    const home = new Vector3(0.2, -0.4, 1).normalize();
    const heading = Math.PI / 2;
    ship.place(home, heading);

    expect(ship.state.position.distanceTo(home)).toBeLessThan(1e-9);
    expect(ship.state.heading).toBeCloseTo(heading, 9);
    expect(ship.state.speed).toBe(0);
    expect(ship.state.groundSpeed).toBe(0);
    expect(ship.state.velocity.length()).toBe(0);
    // Facing east, which is what a heading of PI/2 means: 0 = north,
    // clockwise positive. See docs/ARCHITECTURE.md "Conventions".
    tangentFrame(home, north, east);
    expect(ship.state.forward.dot(east)).toBeCloseTo(1, 9);
  });

  it('has no hull to clone before the glTF lands', () => {
    const ship = createShip(createStubTerrain());
    // The failed-load half of the contract is the same branch and needs no
    // second case: `loadHull` catches its own error and never adds a model,
    // so the named node `cloneHull` looks for is missing either way and an AI
    // boat is simply not shown. It is never dressed in the stand-in.
    //
    // `ready` is deliberately not awaited. Nothing serves the glTF in Node
    // and the loader's request never settles there, so awaiting it would cost
    // the unit tier a ten-second timeout for an assertion that is already
    // made -- see docs/TESTING.md on the budget.
    expect(ship.cloneHull()).toBeNull();
  });

  it('clones a loaded hull with shared geometry and no shared material', () => {
    const ship = createShip(createStubTerrain());

    // Stands in for the glTF `loadHull` would have added: the name is the
    // only thing `cloneHull` looks for, and one material deliberately serves
    // two meshes, the way the build script's join-by-material leaves them.
    const model = new Group();
    model.name = 'ship-hull';
    const geometry = new BoxGeometry(1, 1, 1);
    const shared = new MeshStandardMaterial({ color: 0x334455 });
    // The flag `postfx.ts` stamps on a material it has already patched.
    // `Material.copy` deep-copies userData but carries neither the hook nor
    // the cache key, so a clone that kept this would be skipped by
    // `postFx.adopt` and render a stop dark.
    shared.userData['pirate-world/srgb-self-encode'] = true;
    const port = new Mesh(geometry, shared);
    const starboard = new Mesh(geometry, shared);
    model.add(port, starboard);
    ship.object.add(model);

    const clone = ship.cloneHull();
    expect(clone).not.toBeNull();
    expect(clone!.scale.x).toBeCloseTo(MODEL_SCALE, 9);

    const materials: Material[] = [];
    const geometries: unknown[] = [];
    clone!.traverse((node) => {
      const mesh = node as Mesh;
      if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
      materials.push(mesh.material as Material);
      geometries.push(mesh.geometry);
    });

    expect(materials).toHaveLength(2);
    for (const material of materials) {
      expect(material).not.toBe(shared);
      // Cleared, so `postFx.adopt` patches the raider's copy for real.
      expect(material.userData).toEqual({});
    }
    // One source material is still one material on the clone: cloning per
    // mesh instead would undo the model's join-by-material and cost the
    // raider a draw call per bolt.
    expect(materials[0]).toBe(materials[1]);
    // Geometry is shared with the player's hull on purpose: same hull, and a
    // 5 MB model's buffers are not worth a second copy.
    expect(geometries[0]).toBe(geometry);
    expect(geometries[1]).toBe(geometry);
    // The player's own material is untouched by any of it, which is the whole
    // reason a raider's recolour can never reach the ship.
    expect(shared.userData['pirate-world/srgb-self-encode']).toBe(true);
  });
});
