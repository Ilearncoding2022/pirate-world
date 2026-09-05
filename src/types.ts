import type { Vector3 } from 'three';

/** Unified input snapshot. Written by controls.ts, read by ship.ts and camera.ts. */
export interface InputState {
  /** W / ArrowUp / on-screen up button held */
  forward: boolean;
  /** S / ArrowDown / on-screen down button held */
  backward: boolean;
  /** A / ArrowLeft / on-screen left button held */
  left: boolean;
  /** D / ArrowRight / on-screen right button held */
  right: boolean;
  /**
   * Accumulated mouse-wheel scroll since the last frame, in NOTCHES:
   * 1.0 is roughly one detent of a standard mouse wheel (~100px of deltaY).
   * Positive = wheel down = zoom out. Consumers use this value as-is; do not
   * rescale it. Reset to 0 by controls.endFrame(), which main.ts calls at the
   * end of every frame.
   */
  zoomDelta: number;
}

/** Procedural terrain query. Implemented in terrain.ts, used by globe.ts (visuals) and ship.ts (collision). */
export interface Terrain {
  /**
   * Terrain height at a unit direction vector. Roughly in [-1, 1].
   * Values above SEA_LEVEL are land. Deterministic for a given seed.
   */
  heightAt(dir: Vector3): number;
  /** True if the given unit direction is on land (heightAt(dir) > SEA_LEVEL). */
  isLand(dir: Vector3): boolean;
  /** Convenience wrapper around isLand using degrees. */
  isLandLatLon(latDeg: number, lonDeg: number): boolean;
  /** The height threshold that separates water from land. */
  readonly seaLevel: number;
}

/** Read-only view of the ship, produced by ship.ts, consumed by camera.ts and hud.ts. */
export interface ShipState {
  /** Unit vector from globe center to the ship. World position = position * GLOBE_RADIUS. */
  readonly position: Vector3;
  /** Local up = position (unit). */
  readonly up: Vector3;
  /** Unit forward direction, tangent to the sphere, derived from heading. */
  readonly forward: Vector3;
  /** Heading in radians, 0 = north, clockwise positive (east = PI/2). */
  readonly heading: number;
  /** Heading in degrees, normalized to [0, 360). */
  readonly headingDeg: number;
  /** Signed surface speed in world units per second. Negative = reversing. */
  readonly speed: number;
  readonly latDeg: number;
  readonly lonDeg: number;
}
