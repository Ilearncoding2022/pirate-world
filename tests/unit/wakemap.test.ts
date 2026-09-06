import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { projectToMapUV, computeWakeFrame, createWakeFrame, WAKE_MAP_EXTENT } from '../../src/wakemap';
import { latLonToDir, headingToForward, GLOBE_RADIUS } from '../../src/geo';
import type { ShipState } from '../../src/types';

/**
 * `wakemap.ts`'s world -> map-uv projection, checked two ways:
 *
 *  1. The map centre reads back as uv (0.5, 0.5) -- the projection is the
 *     inverse of the camera placement in `computeWakeFrame`.
 *  2. `projectToMapUV` agrees, at 32 points scattered near the ship, with
 *     the GLSL formula `waterwake.ts` embeds (`wakeUV`), transcribed here by
 *     hand rather than imported, so this test would catch either side
 *     drifting from the other.
 *
 * A deterministic PRNG (not `Math.random`) so a failure is reproducible.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeShip(latDeg: number, lonDeg: number, headingRad: number): ShipState {
  const position = latLonToDir(latDeg, lonDeg);
  const up = position.clone();
  const forward = headingToForward(up, headingRad);
  return {
    position,
    up,
    forward,
    heading: headingRad,
    headingDeg: (headingRad * 180) / Math.PI,
    speed: 8,
    groundSpeed: 8,
    velocity: forward.clone().multiplyScalar(8),
    latDeg,
    lonDeg,
  };
}

/** `waterwake.ts`'s `wakeUV`, transcribed by hand: u = 0.5 + dot(rel, east) / extent, v likewise with north. */
function glslWakeUV(
  worldPos: Vector3,
  centre: Vector3,
  east: Vector3,
  north: Vector3,
  extent: number,
): { u: number; v: number } {
  const rel = worldPos.clone().sub(centre);
  return { u: 0.5 + rel.dot(east) / extent, v: 0.5 + rel.dot(north) / extent };
}

describe('wakemap projection', () => {
  it('maps the map centre to uv (0.5, 0.5)', () => {
    const ship = makeShip(12, -40, Math.PI / 5);
    const frame = createWakeFrame();
    computeWakeFrame(ship, frame);

    const { u, v } = projectToMapUV(frame.centre, frame.centre, frame.east, frame.north, WAKE_MAP_EXTENT);
    expect(u).toBeCloseTo(0.5, 12);
    expect(v).toBeCloseTo(0.5, 12);
  });

  it('agrees with the GLSL wakeUV formula at 32 points near the ship', () => {
    const rand = mulberry32(20260906);

    for (let i = 0; i < 32; i++) {
      // Kept off the exact poles (|lat| < 80) -- tangentFrame is degenerate
      // there and the write/read agreement this test proves does not depend
      // on that case (both sides call the same fallback identically).
      const lat = (rand() - 0.5) * 160;
      const lon = (rand() - 0.5) * 360;
      const heading = rand() * Math.PI * 2;
      const ship = makeShip(lat, lon, heading);

      const frame = createWakeFrame();
      computeWakeFrame(ship, frame);

      // A point within a couple of map-widths of the ship: "near the ship".
      const worldPos = ship.position
        .clone()
        .multiplyScalar(GLOBE_RADIUS)
        .addScaledVector(ship.forward, (rand() - 0.5) * 2 * WAKE_MAP_EXTENT)
        .addScaledVector(frame.east, (rand() - 0.5) * 2 * WAKE_MAP_EXTENT);

      const ts = projectToMapUV(worldPos, frame.centre, frame.east, frame.north, WAKE_MAP_EXTENT);
      const glsl = glslWakeUV(worldPos, frame.centre, frame.east, frame.north, WAKE_MAP_EXTENT);

      expect(ts.u).toBeCloseTo(glsl.u, 12);
      expect(ts.v).toBeCloseTo(glsl.v, 12);
    }
  });
});
