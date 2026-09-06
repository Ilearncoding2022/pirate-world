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

/* ------------------------------------------------------------------ */
/* Settlements and their docks                                         */
/* ------------------------------------------------------------------ */

/**
 * A settlement. Placed once at startup by `towns.ts`, which owns the only
 * copy: `citylights.ts` lights them, `docks.ts` draws their charging zones and
 * `radar.ts` plots them, all from this same list. Nothing here changes after
 * construction.
 */
export interface Town {
  /** Unit direction from the globe centre to the town centre. */
  readonly dir: Vector3;
  /** Terrain height at `dir`, on `heightMap.sample`'s scale. */
  readonly height: number;
  /** Fraction of a probe ring around the centre that is open water, in [0, 1]. */
  readonly coast: number;
  /** Null for a landlocked town, or one whose only water the ship cannot reach. */
  readonly dock: Dock | null;
}

/** A charging berth on reachable water beside a town. */
export interface Dock {
  /** Unit direction to the centre of the charging zone, over open water. */
  readonly dir: Vector3;
  /** Radius of the zone as a great-circle distance in world units. */
  readonly radius: number;
  /** The town this berth serves. */
  readonly town: Town;
}

/** The world's settlements, built once by `towns.ts`. */
export interface Towns {
  readonly all: readonly Town[];
  /** Just the towns that have a berth, which is the subset the ship cares about. */
  readonly docks: readonly Dock[];
  /**
   * The berth whose zone contains `dir`, or null. Zones never overlap, so the
   * first hit is the only hit.
   */
  dockAt(dir: Vector3): Dock | null;
}

/* ------------------------------------------------------------------ */
/* Ship energy                                                         */
/* ------------------------------------------------------------------ */

/**
 * What the power plant is doing, for the HUD to label and colour.
 *
 * `empty` outranks the rest: it holds until the reserve has climbed back over
 * the restart threshold, so the tag does not flicker between EMPTY and SOLAR
 * while the panels trickle the first percent back in.
 */
export type EnergyMode = 'docked' | 'solar' | 'drain' | 'empty';

/** Read-only view of the ship's power, produced by `energy.ts`. */
export interface EnergyState {
  /** Charge in [0, 1]. The HUD is the only thing that turns this into a percentage. */
  readonly level: number;
  /** Net change in `level` per second: negative under way, positive on solar or at a dock. */
  readonly rate: number;
  readonly mode: EnergyMode;
  /** The berth currently charging the ship, or null. */
  readonly dock: Dock | null;
  /**
   * False once the tank has run dry, until it has recovered past the restart
   * threshold. `ship.ts` refuses thrust while this is false; steering, drag and
   * the sea keep working, so the ship coasts and drifts rather than freezing.
   */
  readonly canThrust: boolean;
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
