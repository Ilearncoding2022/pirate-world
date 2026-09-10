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
 * It is KEYED ON THE WORLD SEED, and that is the whole of version 2. The
 * world is drawn at random on every page load (`worldgen.ts`), so a chart is
 * only meaningful against the sea it was drawn over: restoring one into a
 * different world would paint a remembered coastline across open ocean and
 * hide a real one under nothing. The seed rides in the file's own header, and
 * a chart whose seed does not match the world being built is discarded and
 * started blank -- which is not damage, it is a chart of somewhere that no
 * longer exists.
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
  /**
   * Fraction of the globe's AREA that has been discovered, in [0, 1].
   *
   * Area and not texels, which is the whole of the arithmetic below. The grid
   * is equirectangular, so a row beside a pole covers a thin strip of sphere
   * and a row at the equator covers a wide one: counted naively, charting the
   * Arctic would be worth ten times charting the same number of texels at the
   * equator. Every row is therefore weighted by the cosine of its latitude.
   *
   * Kept as a running total rather than scanned, because a `CHART` contract
   * reads this every frame — see `quests.ts`.
   */
  coverage(): number;
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

/**
 * The encoding's version byte. A file that does not start with this is discarded.
 *
 * 2 because the header grew: version 1 was one byte of version and then the
 * bits, and every version 1 file on disk charted a fixed world that this build
 * no longer generates. So the bump costs a player their exploration exactly
 * once, on the first load after this lands, and what it buys is that a chart
 * can never be shown over the wrong sea. There is no migration for the same
 * reason there is no message about it: the data is not wrong, it is about
 * somewhere else.
 */
const CHART_VERSION = 2;

/**
 * The world seed, little-endian, immediately after the version byte.
 *
 * Four bytes because `mulberry32` takes a uint32 and that is what
 * `worldgen.ts` draws. Little-endian for no reason beyond having to pick one:
 * both ends of the wire are two functions in this file, twenty lines apart.
 */
const CHART_SEED_BYTES = 4;

/**
 * Version byte plus seed. Everything past this is bit-packed chart.
 *
 * Named rather than written as `1 + 4` at the four places that need it,
 * because three of those four are offsets into a base64-decoded string, and an
 * off-by-one there is a chart that decodes into a diagonal smear rather than
 * anything that fails a check.
 */
const CHART_HEADER_BYTES = 1 + CHART_SEED_BYTES;

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
function decodeInto(
  data: Uint8Array,
  encoded: string | null | undefined,
  seed: number,
  width: number,
  height: number,
): boolean {
  if (!encoded) return false;
  try {
    const binary = atob(encoded);
    if (binary.length < CHART_HEADER_BYTES) return false;
    if (binary.charCodeAt(0) !== CHART_VERSION) {
      console.warn(`chart: version ${binary.charCodeAt(0)} (this build writes ${CHART_VERSION}); starting blank`);
      return false;
    }
    // The seed is checked BEFORE the length, deliberately: a chart of another
    // world is the ORDINARY case now that the sea is redrawn on every load,
    // and it is not damage. Falling through to the length test would report
    // it as a corrupt file, and put that note in the console on every single
    // reload a player ever does.
    const stored = readSeed(binary);
    if (stored !== seed >>> 0) {
      console.warn(`chart: charted seed ${stored}, this world is ${seed >>> 0}; starting blank`);
      return false;
    }
    const expected = Math.ceil((width * height) / 8);
    if (binary.length - CHART_HEADER_BYTES !== expected) {
      console.warn(`chart: ${binary.length - CHART_HEADER_BYTES} bytes, expected ${expected}; starting blank`);
      return false;
    }
    for (let i = 0; i < width * height; i++) {
      const byte = binary.charCodeAt(CHART_HEADER_BYTES + (i >> 3));
      data[i] = (byte >> (i & 7)) & 1 ? SEEN : 0;
    }
    return true;
  } catch {
    console.warn('chart: could not be read; starting blank');
    return false;
  }
}

/** The four seed bytes out of a decoded header, as a uint32. */
function readSeed(binary: string): number {
  let seed = 0;
  for (let b = 0; b < CHART_SEED_BYTES; b++) {
    seed |= (binary.charCodeAt(1 + b) & 0xff) << (b * 8);
  }
  return seed >>> 0;
}

/**
 * The chart.
 *
 * `seed` is the world this chart is about -- the uint32 `worldgen.ts` drew and
 * handed `createTerrain`. It is the FIRST parameter, and the only one with no
 * default, because a chart with no world is a chart of nothing: defaulting it
 * would make the commonest possible mistake -- passing the seed to the wrong
 * slot -- silent, and the symptom would be a remembered coast in the wrong
 * ocean rather than an error.
 *
 * `saved` is what `save.ts` read out of storage, or null for a new player.
 * Anything unreadable -- and anything charted over a different sea -- yields a
 * blank chart rather than throwing, so a bad file costs the player their
 * exploration and nothing else.
 */
export function createChart(
  seed: number,
  saved: string | null = null,
  width = CHART_WIDTH,
  height = CHART_HEIGHT,
): Chart {
  const data = new Uint8Array(width * height);

  /*
   * Row weights, and the total they sum to.
   *
   * `cos(lat)` at each row's centre, which is the relative area of one texel on
   * that row. Built once: it is a function of `height` alone, so nothing about
   * the world or the save can move it.
   */
  const rowWeight = new Float64Array(height);
  let totalWeight = 0;
  for (let y = 0; y < height; y++) {
    const lat = ((y + 0.5) / height - 0.5) * Math.PI;
    rowWeight[y] = Math.cos(lat);
    totalWeight += rowWeight[y] * width;
  }

  decodeInto(data, saved, seed, width, height);

  /*
   * Weighted area discovered so far, kept as a running total.
   *
   * Initialised by one full pass over the decoded grid — half a million byte
   * reads, once, at boot, against a per-frame read from `quests.ts` that would
   * otherwise cost the same. Every later change goes through `reveal`, which is
   * the only writer, so the total cannot drift from the grid.
   */
  let seenWeight = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] !== 0) seenWeight += rowWeight[y];
    }
  }

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
            seenWeight += rowWeight[y];
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
          seenWeight += rowWeight[y];
          dirty = true;
        }
      }
    }
  }

  function coverage(): number {
    // Clamped, because the running total is a sum of floats and a fully
    // charted globe has to read exactly 1 rather than 1.0000000002.
    const fraction = seenWeight / totalWeight;
    return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  }

  /**
   * Bit-packed, behind a version byte and four seed bytes, base64'd.
   *
   * 64 KB packed becomes about 87 KB of base64, which is a reasonable thing
   * to hand localStorage and is written at most every five seconds. The five
   * header bytes are lost in that rounding.
   */
  function encode(): string {
    const packed = new Uint8Array(CHART_HEADER_BYTES + Math.ceil((width * height) / 8));
    packed[0] = CHART_VERSION;
    // Little-endian, matching `readSeed`. `>>> 0` first, because a seed that
    // arrived from a bitwise expression is a signed int32 in JS, and the two
    // ends have to agree on which four bytes -100 is.
    const seed32 = seed >>> 0;
    for (let b = 0; b < CHART_SEED_BYTES; b++) packed[1 + b] = (seed32 >>> (b * 8)) & 0xff;
    for (let i = 0; i < width * height; i++) {
      if (data[i] !== 0) packed[CHART_HEADER_BYTES + (i >> 3)] |= 1 << (i & 7);
    }
    // Built in chunks: `String.fromCharCode(...packed)` on 64 KB overflows
    // the argument limit in every engine that has one. The loop walks `packed`
    // ENTIRE, header included, which is why the five header bytes needed no
    // handling of their own above -- and must not get any, because a header
    // base64'd separately and concatenated would land the payload on a
    // different three-byte boundary and decode as noise.
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

  return { discovered, coverage, reveal, encode, onChange, tick, width, height };
}

export { CHART_WIDTH, CHART_HEIGHT, CHART_SAVE_INTERVAL, CHART_VERSION, CHART_HEADER_BYTES };
