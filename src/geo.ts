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

/**
 * Longitude half-width, radians, of the row at latitude `lat` inside a
 * spherical cap of angular radius `angRadius` centred at latitude `lat0`.
 *
 * The one piece of arithmetic two unrelated systems both need and must not
 * each derive: `chart.ts` stamps a disc of discovered water into an
 * equirectangular bitmap, and `weathermap.ts` stamps a weather cell into an
 * equirectangular texture. Both walk rows of latitude and need to know how
 * many columns of that row the disc covers. Written twice they would drift,
 * and the drift would show as a cell whose shading did not line up with the
 * cell the scope drew.
 *
 * Returns:
 *   - `Math.PI` when the whole row is inside the cap, which is what a cap
 *     covering a pole does to every row above it. The caller writes the
 *     entire row rather than a band, and the antimeridian is not a special
 *     case because there is no band to wrap.
 *   - `-1` when no part of the row is inside. The caller skips the row.
 *   - otherwise a half-width in (0, PI): the row is covered between
 *     `lon0 - w` and `lon0 + w`, which the caller wraps itself.
 *
 * From the spherical law of cosines,
 * `cos θ = sin φ0 sin φ + cos φ0 cos φ cos Δλ`, solved for `Δλ`. Near a pole
 * `cos φ0 cos φ` goes to zero and the quotient blows up; the two clamps below
 * catch that before it becomes a NaN, so a cap at the pole and a row at the
 * pole are both ordinary answers rather than special cases.
 */
export function capColumns(lat: number, lat0: number, angRadius: number): number {
  if (!(angRadius > 0)) return -1;
  const denom = Math.cos(lat0) * Math.cos(lat);
  const num = Math.cos(angRadius) - Math.sin(lat0) * Math.sin(lat);
  // A row through or beside a pole: `denom` is zero or all but, and the
  // comparison is between the two latitudes alone.
  if (denom < 1e-9) return num <= 0 ? Math.PI : -1;
  const c = num / denom;
  if (c <= -1) return Math.PI;
  if (c >= 1) return -1;
  return Math.acos(c);
}
