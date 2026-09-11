import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createWater } from '../../src/water';
import { createWaterPatch } from '../../src/waterpatch';
import { createQuality } from '../../src/quality';
import { createHeightMap } from '../../src/heightmap';
import { createWaterBodies } from '../../src/waterbodies';
import { createStubTerrain } from './support/stub-terrain';
import { GLOBE_RADIUS, headingToForward, latLonToDir } from '../../src/geo';
import type { ShipState } from '../../src/types';

/**
 * Where the displacement patch is, which is a question about TELEPORTS.
 *
 * The patch is the only water in the game that actually displaces, and since
 * the funnel was allowed to descend (commit e829a02) the sphere CUTS ITS SHELL
 * AWAY under the patch's footprint so the patch alone owns those pixels. That
 * makes the patch's centre load-bearing in a way it was not before: a centre
 * that is not under the ship is now a hole in the sea in one place and flat,
 * undisplaced water in the other.
 *
 * `update` follows the ship by snapping the centre along the tangent plane in
 * whole grid steps, which is exactly right for a hull that sails and wrong for
 * a hull that is MOVED. The maelstrom moves one: it eats the ship and puts it
 * back "somewhere else entirely" (`hazards.pickRespawn`), and `?spawn=` does
 * the same on the first frame.
 *
 * Nothing here draws anything or asserts on how any of it looks; it reads the
 * uniform the shader reads.
 */

const quality = createQuality('');

// A flat empty ocean: `createWater` wants a height field for its shoreline
// shading and this file never asks about a shoreline. 64x32 is the coarsest
// raster that builds, and it is built once for the whole file.
const terrain = createStubTerrain();
const heightMap = createHeightMap(terrain, 64, 32);
const waterBodies = createWaterBodies(heightMap, terrain.seaLevel, latLonToDir(0, 0));

function shipAt(dir: THREE.Vector3): ShipState {
  const position = dir.clone().normalize();
  const up = position.clone();
  return {
    position,
    up,
    forward: headingToForward(up, Math.PI / 2),
    heading: Math.PI / 2,
    headingDeg: 90,
    speed: 0,
    groundSpeed: 0,
    velocity: new THREE.Vector3(),
    latDeg: 0,
    lonDeg: 0,
  } as ShipState;
}

function patchAt(start: THREE.Vector3) {
  const water = createWater(terrain, heightMap, waterBodies);
  const patch = createWaterPatch(water, quality);
  const uniforms = (water.mesh.material as THREE.ShaderMaterial).uniforms;
  patch.update(0.05, shipAt(start));
  return { patch, uniforms };
}

/** How far the patch's centre is from the hull it is meant to be under, world units. */
function offset(uniforms: Record<string, THREE.IUniform>, ship: ShipState): number {
  const centre = (uniforms.uPatchCentre.value as THREE.Vector3).clone().normalize();
  return Math.acos(Math.max(-1, Math.min(1, centre.dot(ship.position)))) * GLOBE_RADIUS;
}

describe('waterpatch: following a hull that sails', () => {
  it('stays under the ship, within a grid step', () => {
    const start = latLonToDir(10, 20);
    const { patch, uniforms } = patchAt(start);

    // Walk a few hundred units the long way round, a hull's-worth at a time.
    let here = start.clone();
    const east = headingToForward(here.clone(), Math.PI / 2);
    for (let i = 0; i < 200; i++) {
      const axis = new THREE.Vector3().crossVectors(here, east).normalize();
      here = here.clone().applyAxisAngle(axis, 2 / GLOBE_RADIUS).normalize();
      const ship = shipAt(here);
      patch.update(0.05, ship);
      // One grid step is 80 units over the tier's segment count; two of them is
      // a generous bound on a snap that is meant to be sub-step.
      expect(offset(uniforms, ship)).toBeLessThan(2);
    }
  });
});

describe('waterpatch: following a hull that is MOVED', () => {
  /**
   * The maelstrom's own case: `hazards.pickRespawn` can put the ship anywhere
   * on the globe, and `main.ts` teleports it inside the blackout.
   *
   * A quarter of the planet away is not an extreme — it is an ordinary
   * respawn — and the patch has to be under the ship by the time the fade
   * lifts, which is the very next frame.
   */
  it('is under the ship on the first frame after a teleport', () => {
    const { patch, uniforms } = patchAt(latLonToDir(10, 20));

    for (const destination of [
      latLonToDir(10, 110), // a quarter of the globe east
      latLonToDir(-40, -150), // and the far side of it
      latLonToDir(89, 0), // and a pole, where the tangent frame is worst
      latLonToDir(10, 21), // and a short hop, which the grid snap handles
    ]) {
      const ship = shipAt(destination);
      patch.update(0.05, ship);
      expect(offset(uniforms, ship)).toBeLessThan(2);
    }
  });

  it('does not leave the sphere cutting a hole where the patch is not', () => {
    // The two are one fact: `uPatchCentre` is what the sphere cuts around AND
    // what the patch is drawn around, so a centre that is not under the ship is
    // a hole somewhere the player is not, and no displaced water where they are.
    const { patch, uniforms } = patchAt(latLonToDir(0, 0));
    const ship = shipAt(latLonToDir(0, 179));
    patch.update(0.05, ship);

    const centre = (uniforms.uPatchCentre.value as THREE.Vector3).clone();
    // On the sphere, not somewhere inside it: the tangent-plane walk that
    // follows a sailing hull leaves the centre off the surface when the step is
    // large, and a normalise afterwards cannot put a chord back on an arc.
    expect(centre.length()).toBeCloseTo(GLOBE_RADIUS, 3);
    expect(offset(uniforms, ship)).toBeLessThan(2);
  });
});
