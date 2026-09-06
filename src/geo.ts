import { Vector3 } from 'three';

/**
 * Radius of the globe in world units. Everything is scaled relative to this.
 *
 * Two families of constant live downstream of it and they scale differently:
 *
 *   - World-scale things are written as a fraction of this radius, or are
 *     angular (terrain noise is a function of the unit direction, settlements
 *     are placed in radians). They grow with it, so continents, lakes, towns
 *     and the cloud deck all keep their shape and double in size when it does.
 *   - Ship-scale things are absolute world units: the hull, its speed, the
 *     chase camera, the wake, the wave chop alongside it. They stay put.
 *
 * Raising the radius therefore makes the world bigger *relative to the ship*,
 * which is the only sense in which a world can be big: flatter horizon, longer
 * crossings, larger landmasses next to the same hull. Anything absolute that
 * belongs to the world rather than the ship has to be scaled by hand -- see
 * MAX_LAND_RELIEF in `land.ts` and the far end of the zoom in `camera.ts`.
 */
export const GLOBE_RADIUS = 200;

const _tmp = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Convert latitude/longitude (degrees) into a unit direction vector from the globe center.
 * Convention: +Y is the north pole. lon 0 points to +Z, lon +90 points to +X.
 */
export function latLonToDir(latDeg: number, lonDeg: number, out = new Vector3()): Vector3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const c = Math.cos(lat);
  return out.set(c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon));
}

/** Inverse of latLonToDir. `dir` must be a unit vector. Returns degrees, lon in (-180, 180]. */
export function dirToLatLon(dir: Vector3): { latDeg: number; lonDeg: number } {
  const latDeg = (Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI;
  const lonDeg = (Math.atan2(dir.x, dir.z) * 180) / Math.PI;
  return { latDeg, lonDeg };
}

/**
 * Local tangent frame at a unit direction `up` on the sphere.
 * north: tangent toward +Y pole. east: tangent toward increasing longitude.
 * At the exact poles north is degenerate; a fallback tangent is chosen.
 */
export function tangentFrame(
  up: Vector3,
  outNorth = new Vector3(),
  outEast = new Vector3(),
): { north: Vector3; east: Vector3 } {
  // north = normalize(WORLD_UP - (WORLD_UP·up) up)
  _tmp.copy(up).multiplyScalar(WORLD_UP.dot(up));
  outNorth.copy(WORLD_UP).sub(_tmp);
  if (outNorth.lengthSq() < 1e-10) {
    // At a pole: pick +Z projected as "north" so the frame stays valid.
    outNorth.set(0, 0, 1);
    _tmp.copy(up).multiplyScalar(outNorth.dot(up));
    outNorth.sub(_tmp);
  }
  outNorth.normalize();
  outEast.crossVectors(outNorth, up).normalize();
  return { north: outNorth, east: outEast };
}

/**
 * Heading convention: radians, 0 = north, increasing clockwise when viewed from
 * outside the globe looking down at the surface (east = +PI/2).
 */
export function headingToForward(up: Vector3, heading: number, out = new Vector3()): Vector3 {
  const north = new Vector3();
  const east = new Vector3();
  tangentFrame(up, north, east);
  return out.copy(north).multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading));
}

export function normalizeHeadingDeg(headingRad: number): number {
  let deg = (headingRad * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return deg;
}
