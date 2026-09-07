import { Vector3 } from 'three';
import type { Dock, Town, Towns } from './types';
import type { HeightMap } from './heightmap';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS, tangentFrame } from './geo';

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * Placement seed. Fixed, so the same world always gets the same towns.
 *
 * Exported because `citylights.ts` derives its own stream from it rather than
 * sharing it -- see the note on SEED there.
 */
export const TOWN_SEED = 0x5eed17;

/**
 * How many settlements to try to place, and how hard to try.
 *
 * Every settlement is now a port -- a candidate that cannot find a berth is not
 * founded at all -- so this number is the size of the fleet's worth of charging
 * stations as well as the size of the world's population. It came down a
 * quarter, from 76, when that rule came in: 76 towns used to yield 48 berths,
 * and leaving the target alone would have handed the player half again as many
 * places to charge as the world was balanced around.
 *
 * 57 to 40 (2026-09-07, owner's call). It is a TARGET rather than a count --
 * `CLUSTER_TRIES` attempts are made and a candidate that cannot find lowland,
 * open coast, room from its neighbours or reachable water is simply not
 * founded -- so the world ends up with at most this many and usually fewer.
 * What the player feels is a longer run between charges: the reserve, the
 * solar rate and the 2%/s shore rate are all untouched, so a thinner coast is
 * the same tank across a wider gap. `CLUSTER_MIN_ARC` is deliberately NOT
 * relaxed to spread 40 towns over the same coastline: the spacing is what
 * every berth-overlap argument below leans on, and a world with fewer ports
 * should read as emptier rather than as evenly thinned.
 */
const CLUSTER_TARGET = 40;
const CLUSTER_TRIES = 20000;
/**
 * Minimum arc, in radians, between two settlement centres. At GLOBE_RADIUS 200
 * that is 19 world units, which is the spacing every berth-overlap argument
 * below leans on.
 */
const CLUSTER_MIN_ARC = 0.095;

/**
 * Habitable band, as height above sea level. Exported because the individual
 * lamps in `citylights.ts` have to answer the same question about their own
 * spot, and a settlement whose lights disagreed with it about where the water
 * starts would grow houses in the surf.
 */
export const SHORE_MARGIN = 0.004;
/** Settlements found on lowland only; the interior highlands stay empty. */
const CENTRE_CEILING = 0.26;

/** Arc, in radians, of the ring used to test how coastal a spot is. */
const COAST_PROBE_ARC = 0.055;
const COAST_PROBE_SAMPLES = 12;

/* ---- Berths ------------------------------------------------------- */

/**
 * How coastal a town has to be before it is worth looking for a berth.
 *
 * A quarter of the probe ring in water is roughly "the sea is on one side of
 * me". Below that the bearing sweep almost always comes back empty -- there is
 * no water within reach -- so this is mostly a way of not paying for it on
 * inland towns.
 */
const DOCK_MIN_COAST = 0.25;

/**
 * Radius of a charging zone, as a great-circle distance in world units.
 *
 * Settlements are at least CLUSTER_MIN_ARC apart -- 0.095 rad x 200 = 19 world
 * units -- so two zones of radius 8 cannot reach each other as long as a berth
 * stays near its own town, which BERTH_REACH + BERTH_MARGIN below keeps it
 * doing. Where the geometry conspires anyway (two towns either side of the same
 * strait, both berthing toward the middle) the placement loop rejects the
 * second outright -- and with it the town, which is no longer founded at all --
 * so the no-overlap promise on `Towns.dockAt` holds without relying on the
 * arithmetic. It is also many times the 3.12-unit hull, so holding station
 * inside one is steering rather than parking.
 */
const DOCK_RADIUS = 8;

/**
 * Berth search, authored in world units and converted to arc below.
 *
 * REACH is how far out from a town centre a shoreline may lie and still count
 * as that town's water: a little over COAST_PROBE_ARC * GLOBE_RADIUS (11
 * units), so anything the coast score noticed is inside the walk. STEP is the
 * sampling interval along a bearing, well under a zone radius so a waterline is
 * never stepped clean over. MARGIN is how far past the first water the berth is
 * pushed so the ring sits on the sea rather than straddling the beach -- just
 * under DOCK_RADIUS, because pushing a full radius out fails in every inlet
 * narrower than the zone.
 */
const BERTH_REACH = 14;
const BERTH_STEP = 1.0;
const BERTH_MARGIN = 7;

/** Bearings tried around a town centre: one every 15 degrees. */
const BERTH_BEARINGS = 24;

/**
 * How much of a zone's own rim has to be over reachable water, sampled at how
 * many points.
 *
 * The margin walk only promises water directly outward from the town, which a
 * berth at the head of a creek or in a pocket cove satisfies while its ring
 * still lies mostly on the bank. Sampling a ring at DOCK_RADIUS asks the
 * question the drawn zone actually asks. Three quarters rather than all of it,
 * because a berth inside a harbour SHOULD have land behind it -- that is what a
 * harbour is. What gets turned away is the town with a puddle beside it.
 *
 * That used to cost such a town only its dock. Now that every settlement is a
 * port, it costs the town itself, which makes this constant the sharpest edge
 * in the file: raise it and the map empties out, lower it and the fleet starts
 * finding berths in ponds.
 */
const BERTH_CLEAR = 0.75;
const BERTH_CLEAR_SAMPLES = 12;

/** World units to radians of arc on this globe. */
const ARC = 1 / GLOBE_RADIUS;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic 32-bit PRNG. Same generator as terrain.ts. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform point on the unit sphere, drawn from `rng`. */
export function randomDirection(rng: () => number, out: Vector3): Vector3 {
  const y = rng() * 2 - 1;
  const theta = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return out.set(Math.cos(theta) * r, y, Math.sin(theta) * r);
}

// Private to oceanFraction, and deliberately not shared with the berth search:
// that walk holds a tangent frame across a call to this one, and a shared
// scratch vector would silently rotate it mid-loop.
const _ofNorth = new Vector3();
const _ofEast = new Vector3();
const _ofProbe = new Vector3();

/**
 * Fraction of a ring around `dir` that is open water. 1 = an islet, 0 = inland.
 *
 * This is the number `Town.coast` reports, and `citylights.ts` scores its lone
 * outposts with the same function, so a lighthouse and a harbour cannot end up
 * disagreeing about what counts as coastal.
 */
export function oceanFraction(heightMap: HeightMap, seaLevel: number, dir: Vector3): number {
  tangentFrame(dir, _ofNorth, _ofEast);
  let ocean = 0;
  for (let i = 0; i < COAST_PROBE_SAMPLES; i++) {
    const a = (i / COAST_PROBE_SAMPLES) * Math.PI * 2;
    _ofProbe
      .copy(dir)
      .addScaledVector(_ofNorth, Math.cos(a) * COAST_PROBE_ARC)
      .addScaledVector(_ofEast, Math.sin(a) * COAST_PROBE_ARC)
      .normalize();
    if (heightMap.sample(_ofProbe) <= seaLevel) ocean++;
  }
  return ocean / COAST_PROBE_SAMPLES;
}

/** A `Town` while it is still being assembled; `dock` is tied on at the end. */
type MutableTown = { -readonly [K in keyof Town]: Town[K] };

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Where the world's settlements are. Every one of them is a port.
 *
 * A candidate is rejection-sampled over the sphere and scored by how coastal
 * and how low its spot is, so shorelines are far more likely than highlands and
 * no two centres land on top of each other. It then has to find a berth --
 * water the ship can actually get to, close enough to tie up at -- and a
 * candidate that cannot is not founded. That is what makes `Town.dock`
 * non-null for every town in `all`.
 *
 * The berth search draws nothing from the PRNG, only from the height map, so
 * retuning it moves which candidates survive but never which candidates are
 * offered: the random stream is identical whatever the search decides. Keep it
 * that way. A berth test that rolled a die would make every town downstream of
 * it move whenever the search changed.
 *
 * Reachability is the whole point of the search. The height map alone
 * cannot answer it: a crater lake is under sea level and reads as water, but
 * `ship.ts` will never carry the player over the rim to reach it, so a berth
 * there would be a charging station nobody can dock at. `waterBodies`
 * flood-filled the sea from the ship's own spawn point, so its mask is the
 * authority -- reachable means below sea level AND not flagged inland.
 */
export function createTowns(
  heightMap: HeightMap,
  waterBodies: WaterBodies,
  seaLevel: number,
): Towns {
  const rng = mulberry32(TOWN_SEED);

  const _dir = new Vector3();
  const _north = new Vector3();
  const _east = new Vector3();
  const _probe = new Vector3();
  // The rim test raises a frame at the candidate berth while the bearing walk
  // still holds one at the town, so it gets its own.
  const _rimNorth = new Vector3();
  const _rimEast = new Vector3();
  const _rimProbe = new Vector3();

  /* ---- 1. The berth search ---------------------------------------- */

  const towns: MutableTown[] = [];
  const docks: Dock[] = [];
  /** Berth directions, flattened, for the overlap test and for `dockAt`. */
  const berthXyz: number[] = [];

  /** Where the ship could float: below sea level and not an enclosed body. */
  function reachableWater(dir: Vector3): boolean {
    return heightMap.sample(dir) <= seaLevel && waterBodies.sample(dir) < 0.5;
  }

  /** Fraction of the rim of a zone centred on `dir` that is reachable water. */
  function rimClearance(dir: Vector3): number {
    tangentFrame(dir, _rimNorth, _rimEast);
    let open = 0;
    for (let i = 0; i < BERTH_CLEAR_SAMPLES; i++) {
      const a = (i / BERTH_CLEAR_SAMPLES) * Math.PI * 2;
      _rimProbe
        .copy(dir)
        .addScaledVector(_rimNorth, Math.cos(a) * DOCK_RADIUS * ARC)
        .addScaledVector(_rimEast, Math.sin(a) * DOCK_RADIUS * ARC)
        .normalize();
      if (reachableWater(_rimProbe)) open++;
    }
    return open / BERTH_CLEAR_SAMPLES;
  }

  /** The point `arc` radians from `centre` along `bearing`, in the given frame. */
  function stepOut(
    centre: Vector3,
    north: Vector3,
    east: Vector3,
    bearing: number,
    arc: number,
    out: Vector3,
  ): Vector3 {
    return out
      .copy(centre)
      .addScaledVector(north, Math.cos(bearing) * arc)
      .addScaledVector(east, Math.sin(bearing) * arc)
      .normalize();
  }

  // Zones may not overlap: `dockAt` returns the first hit and its callers are
  // promised it is the only one. A candidate therefore has to clear every berth
  // already placed by two radii.
  const berthMinDot = Math.cos(2 * DOCK_RADIUS * ARC);
  const steps = Math.round(BERTH_REACH / BERTH_STEP);
  const marginSteps = Math.round(BERTH_MARGIN / BERTH_STEP);

  /**
   * The berth for a town at `centre`, or null if it has no water to tie up in.
   *
   * Null is now fatal to the town, not merely to its dock, so this is the gate
   * that decides most of what the world looks like: everything it turns away is
   * a settlement that never existed.
   */
  function findBerth(centre: Vector3): Vector3 | null {
    tangentFrame(centre, _north, _east);

    // The seaward bearing: the one with the most reachable water along it.
    // Scoring the whole ray rather than a single sample is what keeps a berth
    // out of the pond in the next valley -- an open-sea bearing scores most of
    // its length, a pond scores two or three steps and loses. Only this one
    // bearing is ever tried. Falling back to the next best when it fails was
    // tried and abandoned: with 24 bearings to choose from nearly every coastal
    // town finds water somewhere, which in the world of the day took the fleet
    // from 48 berths to 66 -- and every one of those extra eighteen sat on a
    // bearing with strictly less water than the town's own best, which is one
    // way of describing the wrong side of the headland. Ties go to the lower
    // bearing index -- arbitrary, but fixed, so the world does not reshuffle
    // between runs.
    let bearing = 0;
    let bestScore = 0;
    for (let b = 0; b < BERTH_BEARINGS; b++) {
      const a = (b / BERTH_BEARINGS) * Math.PI * 2;
      let open = 0;
      for (let st = 1; st <= steps; st++) {
        stepOut(centre, _north, _east, a, st * BERTH_STEP * ARC, _probe);
        if (reachableWater(_probe)) open++;
      }
      if (open > bestScore) {
        bestScore = open;
        bearing = a;
      }
    }
    if (bestScore === 0) return null;

    // Walk out to the waterline, then keep going while the water holds, up to
    // MARGIN. Taking the last wet step rather than a fixed push past the first
    // one is what stops the berth crossing onto the far bank of anything
    // narrower than MARGIN.
    let found = -1;
    for (let st = 1; st <= steps; st++) {
      stepOut(centre, _north, _east, bearing, st * BERTH_STEP * ARC, _probe);
      if (reachableWater(_probe)) {
        found = st;
        break;
      }
    }
    if (found < 0) return null;

    let last = found;
    for (let st = found + 1; st <= found + marginSteps; st++) {
      stepOut(centre, _north, _east, bearing, st * BERTH_STEP * ARC, _probe);
      if (!reachableWater(_probe)) break;
      last = st;
    }
    stepOut(centre, _north, _east, bearing, last * BERTH_STEP * ARC, _probe);
    if (rimClearance(_probe) < BERTH_CLEAR) return null;

    for (let i = 0; i < berthXyz.length; i += 3) {
      const d = berthXyz[i] * _probe.x + berthXyz[i + 1] * _probe.y + berthXyz[i + 2] * _probe.z;
      if (d > berthMinDot) return null;
    }

    return _probe.clone();
  }

  /* ---- 2. Settlement centres, each with its berth ------------------ */

  const minDot = Math.cos(CLUSTER_MIN_ARC);

  for (let attempt = 0; attempt < CLUSTER_TRIES && towns.length < CLUSTER_TARGET; attempt++) {
    randomDirection(rng, _dir);
    const h = heightMap.sample(_dir);
    if (h <= seaLevel + SHORE_MARGIN || h > seaLevel + CENTRE_CEILING) continue;

    const coast = oceanFraction(heightMap, seaLevel, _dir);
    const lowland = 1 - Math.min(1, (h - seaLevel) / CENTRE_CEILING);
    // Ports first, then flat inland towns, and hardly ever anything else.
    // The roll stays ahead of every rejection below it: those consume no
    // randomness, so the stream advances once per candidate regardless.
    if (rng() > (0.10 + 0.75 * coast) * (0.35 + 0.65 * lowland)) continue;

    // Cheap gates before the expensive one. A spot with almost no water around
    // it will not find a berth, and a spot too near an existing town cannot be
    // founded even if it would.
    if (coast < DOCK_MIN_COAST) continue;

    let tooClose = false;
    for (let i = 0; i < towns.length; i++) {
      if (towns[i].dir.dot(_dir) > minDot) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const berth = findBerth(_dir);
    if (berth === null) continue;

    const town: MutableTown = { dir: _dir.clone(), height: h, coast, dock: null };
    const dock: Dock = { dir: berth, radius: DOCK_RADIUS, town };
    town.dock = dock;
    towns.push(town);
    docks.push(dock);
    berthXyz.push(dock.dir.x, dock.dir.y, dock.dir.z);
  }

  /* ---- 3. The per-frame lookup ------------------------------------- */

  // Flattened once, because `dockAt` runs every frame over every berth. The
  // whole test is then three multiplies against a contiguous array: no Vector3
  // property chasing, no temporaries, nothing for the collector to sweep up.
  const berths = Float64Array.from(berthXyz);
  const insideDot = Math.cos(DOCK_RADIUS * ARC);

  return {
    all: towns,
    docks,
    dockAt(dir: Vector3): Dock | null {
      const x = dir.x;
      const y = dir.y;
      const z = dir.z;
      for (let i = 0, n = docks.length; i < n; i++) {
        const b = i * 3;
        if (berths[b] * x + berths[b + 1] * y + berths[b + 2] * z > insideDot) return docks[i];
      }
      return null;
    },
  };
}
