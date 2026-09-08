/**
 * chart.ts — what the ship has seen, and therefore what the scope may draw.
 *
 * A bitmap over the globe, one byte per texel, set wherever the ship has been
 * close enough to see. `radar.ts` reads it: inside the current visibility a
 * pixel is drawn live, outside it a DISCOVERED pixel is drawn dim (remembered,
 * not seen) and an undiscovered one is not drawn at all.
 *
 * Bytes rather than bits **in memory**, on purpose. The scope samples this
 * about 37000 times per raster, ten times a second, and a byte read beats a
 * shift and a mask every time; half a megabyte of resident memory is a fair
 * price for that. Bits **in storage**, equally on purpose: the same map
 * packed is 64 KB before base64, which is a reasonable thing to put in
 * localStorage and 512 KB is not.
 *
 * It is stored under its OWN key rather than inside `SaveData`. `save.ts`
 * rewrites its whole file on every catch, every purchase and every whole
 * percent of battery -- several times a minute in ordinary play -- and a
 * chart riding along with each of those would be the wrong cadence by two
 * orders of magnitude. This one writes at most every `CHART_SAVE_INTERVAL`
 * while it is actually changing, and not at all while the ship sits still.
 */
import type { Vector3 } from 'three';
import { GLOBE_RADIUS, capColumns } from './geo';

export interface Chart {
  /** True if this direction has ever been within visibility of the ship. */
  discovered(dir: Vector3): boolean;
  /** Stamp a disc of `radius` world units around `centre` as discovered. */
  reveal(centre: Vector3, radius: number): void;
  /** The whole chart, encoded for storage. */
  encode(): string;
  /**
   * Fires at most once per `CHART_SAVE_INTERVAL` while the chart is dirty,
   * and once immediately if it has changed since the last call. The caller
   * persists on this rather than polling.
   */
  onChange(fn: () => void): void;
  /** Drives the throttle above. Called from the same place `reveal` is. */
  tick(dt: number): void;
  width: number;
  height: number;
}

/**
 * Texels across and down.
 *
 * 1024 x 512 is 1.2 world units per texel at the equator, against a scope
 * pixel of 0.52: a discovery edge is about two scope pixels wide, which is
 * the blur of a pencil line and reads as a chart rather than as a mask.
 * Doubling it would quadruple both the memory and the saved file for an edge
 * nobody is looking closely at.
 */
const CHART_WIDTH = 1024;
const CHART_HEIGHT = 512;

/**
 * Seconds between saves while the chart is changing.
 *
 * Five, against a stamp that runs ten times a second. Exploring a new coast
 * therefore costs one write every five seconds rather than fifty, and sailing
 * over water already charted costs none at all.
 */
const CHART_SAVE_INTERVAL = 5;

/** The encoding's version byte. A file that does not start with this is discarded. */
const CHART_VERSION = 1;

/** Set texels are this; the array is otherwise zero. */
const SEEN = 1;

/**
 * Decode a stored chart into `data`, or leave it blank.
 *
 * Tolerant in exactly the way `save.ts` is tolerant, and for the same reason:
 * a chart is a convenience, and there is no version of "your save is corrupt"
 * worth showing a player over one. A missing key, a wrong version, a wrong
 * length, or anything base64 cannot parse all yield a blank chart and one
 * console note.
 */
function decodeInto(data: Uint8Array, encoded: string | null | undefined, width: number, height: number): boolean {
  if (!encoded) return false;
  try {
    const binary = atob(encoded);
    if (binary.length < 1) return false;
    if (binary.charCodeAt(0) !== CHART_VERSION) {
      console.warn(`chart: version ${binary.charCodeAt(0)} (this build writes ${CHART_VERSION}); starting blank`);
      return false;
    }
    const expected = Math.ceil((width * height) / 8);
    if (binary.length - 1 !== expected) {
      console.warn(`chart: ${binary.length - 1} bytes, expected ${expected}; starting blank`);
      return false;
    }
    for (let i = 0; i < width * height; i++) {
      const byte = binary.charCodeAt(1 + (i >> 3));
      data[i] = (byte >> (i & 7)) & 1 ? SEEN : 0;
    }
    return true;
  } catch {
    console.warn('chart: could not be read; starting blank');
    return false;
  }
}

/**
 * The chart.
 *
 * `encoded` is what `save.ts` read out of storage, or null for a new player.
 * Anything unreadable yields a blank chart rather than throwing, so a bad
 * file costs the player their exploration and nothing else.
 */
export function createChart(
  width = CHART_WIDTH,
  height = CHART_HEIGHT,
  encoded: string | null = null,
): Chart {
  const data = new Uint8Array(width * height);
  decodeInto(data, encoded, width, height);

  let dirty = false;
  let sinceSave = 0;
  let listener: (() => void) | null = null;

  /**
   * The texel index for a direction, nearest rather than bilinear.
   *
   * Deliberately the same projection `heightmap.ts` and `waterbodies.ts`
   * sample by, so the scope's three lookups per pixel -- height, water body,
   * discovered -- all mean the same place. A chart in its own projection
   * would put a remembered coastline half a texel off the coastline it
   * remembers.
   */
  function indexOf(dir: Vector3): number {
    const lat = Math.asin(dir.y < -1 ? -1 : dir.y > 1 ? 1 : dir.y);
    const lon = Math.atan2(dir.x, dir.z);
    let x = Math.floor((lon / (2 * Math.PI) + 0.5) * width);
    let y = Math.floor((lat / Math.PI + 0.5) * height);
    x = ((x % width) + width) % width;
    y = y < 0 ? 0 : y >= height ? height - 1 : y;
    return y * width + x;
  }

  function discovered(dir: Vector3): boolean {
    return data[indexOf(dir)] !== 0;
  }

  /**
   * Stamp a spherical cap.
   *
   * Walks the rows the cap reaches and, for each, the columns `capColumns`
   * gives -- the same function `weathermap.ts` stamps a cell with, shared
   * through `geo.ts` precisely so a remembered coast and a drawn storm cannot
   * end up using two different definitions of "a disc on a sphere".
   *
   * About 6500 texels for a 50-unit radius, and every one of them a byte
   * write. At the scope's 10 Hz that is nothing.
   */
  function reveal(centre: Vector3, radius: number): void {
    if (!(radius > 0)) return;
    const angRadius = radius / GLOBE_RADIUS;
    const lat0 = Math.asin(centre.y < -1 ? -1 : centre.y > 1 ? 1 : centre.y);
    const lon0 = Math.atan2(centre.x, centre.z);

    const rowSpan = Math.ceil((angRadius / Math.PI) * height) + 1;
    const centreRow = (lat0 / Math.PI + 0.5) * height;
    const row0 = Math.max(0, Math.floor(centreRow - rowSpan));
    const row1 = Math.min(height - 1, Math.ceil(centreRow + rowSpan));

    for (let y = row0; y <= row1; y++) {
      const lat = ((y + 0.5) / height - 0.5) * Math.PI;
      const half = capColumns(lat, lat0, angRadius);
      if (half < 0) continue;

      const row = y * width;
      if (half >= Math.PI) {
        // A cap over a pole covers the row entire, so there is no band to
        // wrap and no arithmetic worth doing.
        for (let x = 0; x < width; x++) {
          if (data[row + x] === 0) {
            data[row + x] = SEEN;
            dirty = true;
          }
        }
        continue;
      }

      const colSpan = Math.ceil((half / (2 * Math.PI)) * width) + 1;
      const colCentre = (lon0 / (2 * Math.PI) + 0.5) * width;
      for (let k = -colSpan; k <= colSpan; k++) {
        let x = Math.floor(colCentre + k);
        x = ((x % width) + width) % width;
        if (data[row + x] === 0) {
          data[row + x] = SEEN;
          dirty = true;
        }
      }
    }
  }

  /**
   * Bit-packed, version byte first, base64'd.
   *
   * 64 KB packed becomes about 87 KB of base64, which is a reasonable thing
   * to hand localStorage and is written at most every five seconds.
   */
  function encode(): string {
    const packed = new Uint8Array(1 + Math.ceil((width * height) / 8));
    packed[0] = CHART_VERSION;
    for (let i = 0; i < width * height; i++) {
      if (data[i] !== 0) packed[1 + (i >> 3)] |= 1 << (i & 7);
    }
    // Built in chunks: `String.fromCharCode(...packed)` on 64 KB overflows
    // the argument limit in every engine that has one.
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < packed.length; i += CHUNK) {
      binary += String.fromCharCode(...packed.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function tick(dt: number): void {
    if (!dirty) return;
    sinceSave += dt;
    if (sinceSave < CHART_SAVE_INTERVAL) return;
    sinceSave = 0;
    dirty = false;
    if (listener) listener();
  }

  function onChange(fn: () => void): void {
    listener = fn;
  }

  return { discovered, reveal, encode, onChange, tick, width, height };
}

export { CHART_WIDTH, CHART_HEIGHT, CHART_SAVE_INTERVAL, CHART_VERSION };
