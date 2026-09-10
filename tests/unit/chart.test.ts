import { describe, it, expect, vi } from 'vitest';
import { Vector3 } from 'three';
import {
  createChart,
  CHART_SAVE_INTERVAL,
  CHART_VERSION,
  CHART_HEADER_BYTES,
} from '../../src/chart';
import { GLOBE_RADIUS, latLonToDir } from '../../src/geo';

/**
 * `chart.ts` on its own: the stamp's geometry, the round trip through
 * storage, and the tolerance the loader owes a player whose file is damaged.
 *
 * Built at a small size in most cases -- the projection is the same at any
 * resolution, and a 1024 x 512 array per test would spend more time in
 * allocation than in the code being tested.
 *
 * Every chart is now built against a SEED, because the world is redrawn on
 * every page load and a chart only means anything over the sea it was drawn
 * on. `SEED` below is the one these cases share; the seed cases at the bottom
 * are the only ones that use a second.
 */

/** The world every case here charts, unless it is testing the seed itself. */
const SEED = 1337;

/**
 * The fraction of TEXELS a chart has stamped, counted by probing every one.
 *
 * The naive measure `coverage()` deliberately is not, kept here so the
 * cosine-weighting case can show the difference rather than merely assert the
 * weighted number. Probes through `discovered`, using the same projection
 * `chart.ts` indexes by, so it reads the grid the way the scope does.
 */
function texelFraction(chart: { discovered(dir: Vector3): boolean }, width: number, height: number): number {
  let seen = 0;
  for (let y = 0; y < height; y++) {
    const latDeg = (((y + 0.5) / height - 0.5) * Math.PI * 180) / Math.PI;
    for (let x = 0; x < width; x++) {
      const lonDeg = (((x + 0.5) / width - 0.5) * 2 * Math.PI * 180) / Math.PI;
      if (chart.discovered(latLonToDir(latDeg, lonDeg))) seen++;
    }
  }
  return seen / (width * height);
}

/**
 * A v2 header: one version byte, then the seed little-endian over four.
 *
 * Built out of `String.fromCharCode` rather than typed into the string
 * literal. It used to be typed in -- a raw 0x01 for the version and a raw NUL
 * for the padding below -- and the cost was that git and grep both classed
 * this whole file as BINARY, so its diffs could not be read. Same rule
 * `shop.ts` states over THIN_SPACE: a character nobody can see in a diff is
 * written as an escape or built, never pasted.
 */
function header(version: number, seed: number = SEED): string {
  let out = String.fromCharCode(version & 0xff);
  for (let b = 0; b < 4; b++) out += String.fromCharCode((seed >>> (b * 8)) & 0xff);
  return out;
}

/** A direction `distance` world units north of `from`, along the meridian. */
function northOf(latDeg: number, lonDeg: number, distance: number): Vector3 {
  return latLonToDir(latDeg + (distance / GLOBE_RADIUS) * (180 / Math.PI), lonDeg);
}

describe('chart', () => {
  it('starts blank, and knows nothing until something is revealed', () => {
    const chart = createChart(SEED, null, 256, 128);
    expect(chart.discovered(latLonToDir(0, 0))).toBe(false);
    expect(chart.discovered(latLonToDir(45, 120))).toBe(false);
  });

  it('reveals a disc: the centre, most of the radius, and nothing past it', () => {
    const chart = createChart(SEED, null, 1024, 512);
    const centre = latLonToDir(12, -40);
    chart.reveal(centre, 50);

    expect(chart.discovered(centre)).toBe(true);
    expect(chart.discovered(northOf(12, -40, 45))).toBe(true);
    // Past the edge, allowing a texel of slop: at this resolution one texel
    // is 1.2 units, and the stamp rounds outward.
    expect(chart.discovered(northOf(12, -40, 70))).toBe(false);
    expect(chart.discovered(latLonToDir(-60, 150))).toBe(false);
  });

  it('wraps across the antimeridian rather than clipping at the row end', () => {
    const chart = createChart(SEED, null, 1024, 512);
    chart.reveal(latLonToDir(0, 180), 50);
    const deg = (30 / GLOBE_RADIUS) * (180 / Math.PI);
    // Thirty units either side of the seam, which is one step over it.
    expect(chart.discovered(latLonToDir(0, 180 - deg))).toBe(true);
    expect(chart.discovered(latLonToDir(0, -180 + deg))).toBe(true);
  });

  it('covers a whole row when the disc swallows a pole', () => {
    const chart = createChart(SEED, null, 256, 128);
    // Within its own radius of the north pole, so the cap covers it.
    chart.reveal(latLonToDir(89, 0), 60);
    // Every longitude at the top of the world is then charted, which is the
    // case a band-and-wrap stamp gets wrong and `capColumns` gets right.
    for (let lon = -180; lon < 180; lon += 30) {
      expect(chart.discovered(latLonToDir(89.9, lon))).toBe(true);
    }
  });

  it('round-trips through encode and back, bit for bit', () => {
    const source = createChart(SEED, null, 256, 128);
    source.reveal(latLonToDir(20, 30), 40);
    source.reveal(latLonToDir(-50, 170), 30);

    const restored = createChart(SEED, source.encode(), 256, 128);
    const probes: Vector3[] = [];
    for (let lat = -80; lat <= 80; lat += 10) {
      for (let lon = -170; lon <= 170; lon += 10) probes.push(latLonToDir(lat, lon));
    }
    for (const dir of probes) {
      expect(restored.discovered(dir)).toBe(source.discovered(dir));
    }
    // And a non-trivial chart, so the comparison above is not vacuous.
    expect(probes.some((d) => source.discovered(d))).toBe(true);
  });

  it('starts blank on anything it cannot read, and never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = latLonToDir(0, 0);

    // Garbage, an empty string, a truncated file, and a version this build
    // does not know -- every one of them a blank chart and a console note,
    // exactly as `save.ts` treats its own file.
    expect(createChart(SEED, 'not base64 at all !!', 256, 128).discovered(probe)).toBe(false);
    expect(createChart(SEED, '', 256, 128).discovered(probe)).toBe(false);
    expect(
      createChart(SEED, btoa(header(CHART_VERSION) + 'short'), 256, 128).discovered(probe),
    ).toBe(false);

    const wrongVersion = btoa(
      header(CHART_VERSION + 1) + '.'.repeat((256 * 128) / 8),
    );
    expect(createChart(SEED, wrongVersion, 256, 128).discovered(probe)).toBe(false);

    warn.mockRestore();
  });

  it('is a blank chart, not a crash, when a stored chart is the wrong size', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const small = createChart(SEED, null, 256, 128);
    small.reveal(latLonToDir(0, 0), 40);
    // A file written by a build with a different CHART_WIDTH.
    const bigger = createChart(SEED, small.encode(), 512, 256);
    expect(bigger.discovered(latLonToDir(0, 0))).toBe(false);
    warn.mockRestore();
  });

  it('throttles onChange to one call per save interval, and none while nothing changes', () => {
    const chart = createChart(SEED, null, 256, 128);
    let saves = 0;
    chart.onChange(() => saves++);

    // A hundred reveals inside one second is one save at most, and in fact
    // none yet: the interval has not passed.
    for (let i = 0; i < 100; i++) {
      chart.reveal(latLonToDir(0, i * 0.01), 20);
      chart.tick(0.01);
    }
    expect(saves).toBe(0);

    // Past the interval, exactly one.
    chart.tick(CHART_SAVE_INTERVAL);
    expect(saves).toBe(1);

    // And then nothing at all, however long the ship sits still: re-revealing
    // water already charted sets no texel and marks nothing dirty.
    for (let i = 0; i < 50; i++) {
      chart.reveal(latLonToDir(0, 0), 20);
      chart.tick(CHART_SAVE_INTERVAL);
    }
    expect(saves).toBe(1);
  });

  /*
   * The seed, which is the whole of version 2.
   *
   * The world is drawn at random on every load, so restoring a chart into a
   * world it was not drawn over would paint a remembered coastline across open
   * ocean. These three cases are what stops that.
   */
  it('starts blank when the stored chart was drawn over another world', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = createChart(SEED, null, 256, 128);
    source.reveal(latLonToDir(0, 0), 40);

    const elsewhere = createChart(SEED + 1, source.encode(), 256, 128);
    expect(elsewhere.discovered(latLonToDir(0, 0))).toBe(false);
    warn.mockRestore();
  });

  it('restores the chart when the seed matches', () => {
    const source = createChart(SEED, null, 256, 128);
    source.reveal(latLonToDir(0, 0), 40);

    const same = createChart(SEED, source.encode(), 256, 128);
    expect(same.discovered(latLonToDir(0, 0))).toBe(true);
  });

  it('carries the seed through a uint32 round trip, sign and all', () => {
    // 0x80000000 and up are negative as int32, which is what a bitwise
    // expression in JS produces. Both ends normalise with `>>> 0`, so a seed
    // handed in either way has to match the same file.
    const seed = 0xdeadbeef;
    const source = createChart(seed, null, 256, 128);
    source.reveal(latLonToDir(10, 10), 30);
    const restored = createChart(seed | 0, source.encode(), 256, 128);
    expect(restored.discovered(latLonToDir(10, 10))).toBe(true);
  });

  it('grew the encoding by exactly four bytes, before base64', () => {
    const chart = createChart(SEED, null, 256, 128);
    const bytes = atob(chart.encode()).length;
    // Version byte, four seed bytes, then the bit-packed map. Version 1 was
    // the version byte and the map alone, so this is that plus four -- the
    // one assertion that would catch a header change made on one side of the
    // wire and not the other.
    expect(CHART_HEADER_BYTES).toBe(5);
    expect(bytes).toBe(CHART_HEADER_BYTES + (256 * 128) / 8);
    expect(bytes - (1 + (256 * 128) / 8)).toBe(4);
  });

  it('ignores a zero or negative radius rather than stamping a row', () => {
    const chart = createChart(SEED, null, 256, 128);
    chart.reveal(latLonToDir(0, 0), 0);
    chart.reveal(latLonToDir(0, 0), -10);
    expect(chart.discovered(latLonToDir(0, 0))).toBe(false);
  });
  /* ---------------------------------------------------------------- */
  /* coverage() — area, not texels                                    */
  /* ---------------------------------------------------------------- */

  it('reads 0 on a blank chart and 1 on a full one', () => {
    const chart = createChart(SEED, null, 64, 32);
    expect(chart.coverage()).toBe(0);
    // A cap of more than half a circumference covers the globe entire. The
    // exact 1 is the assertion: the running total is a sum of floats, and a
    // fully charted world reading 0.9999999 would leave a 35% contract
    // unfinishable forever.
    chart.reveal(latLonToDir(0, 0), Math.PI * GLOBE_RADIUS);
    expect(chart.coverage()).toBe(1);
  });

  it('weights a row by the cosine of its latitude', () => {
    /*
     * The whole of the arithmetic, and the failure it exists to catch.
     *
     * Two caps of identical ANGULAR radius, one at the equator and one at 80
     * degrees north. They cover the same area of sphere, and wildly different
     * numbers of texels: the grid is equirectangular, so a cap near the pole is
     * smeared across most of the row it sits on.
     *
     * So the weighted figures must come out close, and the raw texel counts must
     * not. Counted naively, a player could finish a 35% contract by sailing two
     * small circles around the top of the world -- and nothing on screen would
     * look wrong while they did it.
     */
    const angular = 0.2;
    const equator = createChart(SEED, null, 512, 256);
    equator.reveal(latLonToDir(0, 0), angular * GLOBE_RADIUS);
    const polar = createChart(SEED, null, 512, 256);
    polar.reveal(latLonToDir(80, 0), angular * GLOBE_RADIUS);

    // Within a quarter of each other, which is the grid's resolution at this
    // size rather than slack: the stamp is nearest-texel with a one-column
    // margin, and that margin is a bigger share of a small cap than of a big one.
    expect(polar.coverage()).toBeGreaterThan(equator.coverage() * 0.75);
    expect(polar.coverage()).toBeLessThan(equator.coverage() * 1.25);

    // And the naive count, which is what the weighting is there to refuse: the
    // polar cap occupies several times the texels for the same sphere.
    expect(texelFraction(polar, 512, 256)).toBeGreaterThan(
      texelFraction(equator, 512, 256) * 3,
    );
  });

  it('matches the spherical-cap formula for a cap at the equator', () => {
    /*
     * The closed form, as the one check that this is measuring AREA rather than
     * something merely monotonic in it. A cap of angular radius r covers
     * `(1 - cos r) / 2` of a sphere.
     *
     * The tolerance is the grid's: at 512 x 256 a texel is about 0.7 degrees,
     * and the stamp is nearest-texel with a one-column margin, so a few percent
     * relative error is the resolution rather than a mistake.
     */
    const angular = 0.3;
    const chart = createChart(SEED, null, 512, 256);
    chart.reveal(latLonToDir(0, 0), angular * GLOBE_RADIUS);
    const expected = (1 - Math.cos(angular)) / 2;
    expect(chart.coverage()).toBeGreaterThan(expected * 0.85);
    expect(chart.coverage()).toBeLessThan(expected * 1.3);
  });

  it('never goes down, and does not double-count a texel revealed twice', () => {
    const chart = createChart(SEED, null, 256, 128);
    chart.reveal(latLonToDir(0, 0), 20);
    const once = chart.coverage();
    chart.reveal(latLonToDir(0, 0), 20);
    expect(chart.coverage()).toBe(once);
    chart.reveal(latLonToDir(0, 40), 20);
    expect(chart.coverage()).toBeGreaterThan(once);
  });

  it('survives a round trip through storage', () => {
    // The running total is initialised by a full pass over the DECODED grid, so
    // a chart read back off disk has to report what it reported before. Without
    // that pass a reload would silently reset a contract's progress to zero.
    const source = createChart(SEED, null, 256, 128);
    source.reveal(latLonToDir(12, 34), 40);
    const restored = createChart(SEED, source.encode(), 256, 128);
    expect(restored.coverage()).toBeCloseTo(source.coverage(), 10);
  });

  it('reads 0 for a chart whose saved bitmap belonged to another world', () => {
    // A chart of another sea starts blank, which is the ordinary case now that
    // the world is redrawn on every load -- and the total has to start blank
    // with it.
    const source = createChart(SEED, null, 256, 128);
    source.reveal(latLonToDir(0, 0), 60);
    const other = createChart(SEED + 1, source.encode(), 256, 128);
    expect(other.coverage()).toBe(0);
  });
});
