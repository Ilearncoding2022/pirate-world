import { Vector3 } from 'three';
import type { Dock, Town, Towns } from './types';
import type { HeightMap } from './heightmap';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS, latLonToDir, tangentFrame } from './geo';
import {
  HARBOUR_COUNT,
  HARBOUR_NAMES,
  NORTH_POLE_INDEX,
  SOUTH_POLE_INDEX,
} from './harbournames';

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
 * How many settlements the world must have, and how hard to try for them.
 *
 * This is a COUNT, not a target, and that is the whole difference between it
 * and the `CLUSTER_TARGET` (40) it replaced. Every settlement is a port and
 * every port has a name, so the world is exactly `HARBOUR_COUNT` harbours or
 * it is not a world: `worldgen.ts` reads a short return as a rejection and
 * draws another seed. Everything downstream -- the name table, the menu page,
 * the per-harbour upgrade roll -- may therefore assume 36 without checking.
 *
 * CLUSTER_TRIES is the budget that makes the failure finite. 20000 rejection
 * samples over the sphere is far more than a healthy world needs (36 harbours
 * land in the first few thousand) and is spent in full only by a world that
 * genuinely cannot hold them -- a mostly-ocean draw, or one whose coast is all
 * cliff. Running out is not an error here; it is how a bad seed is detected.
 */
const CLUSTER_TRIES = 20000;
/**
 * Minimum arc, in radians, between two settlement centres. At GLOBE_RADIUS 200
 * that is 15 world units.
 *
 * Relaxed from 0.095 (19 units) to make room for 36 harbours where 40 used to
 * be a ceiling nobody reached. The consequence is stated plainly in
 * `docs/HARBOURS_PLAN.md`, decision 2: the world reads as more evenly settled.
 *
 * The cost is subtler and matters more. At 0.095 two rings of DOCK_RADIUS 8
 * could not touch by arithmetic alone -- 16 units of ring inside 19 of spacing
 * -- and every argument about `dockAt` returning THE dock rather than A dock
 * leaned on that. At 0.075 the arithmetic no longer says it: 16 units of ring
 * do not fit inside 15 of spacing. So the overlap test on `berthXyz` below is
 * now the sole authority on the no-overlap promise, and it must stay. It
 * always ran; it was merely redundant before.
 */
const CLUSTER_MIN_ARC = 0.075;

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
 * Settlements are at least CLUSTER_MIN_ARC apart -- 0.075 rad x 200 = 15 world
 * units -- which is LESS than the 16 units two zones of this radius span, so
 * unlike the world before 36 harbours the spacing no longer rules an overlap
 * out on its own. The placement loop rejects a candidate whose berth would
 * reach another's outright -- and with it the town, which is then not founded
 * at all -- so the no-overlap promise on `Towns.dockAt` rests entirely on that
 * test now. See CLUSTER_MIN_ARC above.
 *
 * It is many times the 3.12-unit hull either way, so holding station inside one
 * is steering rather than parking.
 */
const DOCK_RADIUS = 8;

/**
 * Berth search, authored in radians because every distance in it is an arc.
 *
 * The berth used to be pushed as far out to sea as it could get -- up to 21
 * units from the town, at the end of a fourteen-unit reach plus a seven-unit
 * margin -- which put a good many of them in the middle of a cove with the
 * town a swim away. `docs/HARBOURS_PLAN.md`, decision 3: the berth belongs at
 * the town's OWN shoreline. So the walk stops at the first water it finds and
 * takes one short step past it instead of running for open sea.
 *
 * SHORE_MARGIN is that step: 0.012 rad, 2.4 units, enough that the zone ring's
 * inner edge clears the surf band rather than straddling the beach. If a ring
 * is ever seen with land showing through it, this is the number that goes up
 * -- before `docks.ts`'s RING_LIFT, which would only hide the symptom.
 *
 * MAX_ARC is how far from its centre a berth may end up at all: 0.04 rad, 8
 * units, a hull and a half. A candidate that cannot find water that close is
 * not on a shoreline, whatever its coast score said, and is not founded.
 *
 * STEP is the sampling interval along a bearing. 0.002 rad is 0.4 units, finer
 * than the 2048x1024 height map's own 0.003 rad texel, so the walk cannot step
 * clean over a waterline the map can actually resolve.
 */
const BERTH_SHORE_MARGIN = 0.012;
/**
 * Exported because it is a promise the module makes to its callers rather than
 * a private tuning number: every berth in `Towns.docks` is within this arc of
 * its own town's centre, which is what "the berth is at the town" means to
 * `docks.ts`'s label, to the scope, and to `towns.test.ts`.
 */
export const BERTH_MAX_ARC = 0.04;
const BERTH_STEP_ARC = 0.002;

/**
 * Bearings tried around a town centre: one every 30 degrees.
 *
 * Twelve rather than the old 24, and deliberately the same twelve the coast
 * score already sweeps -- these ARE the coastal bearings. The old search
 * scored a whole fourteen-unit ray per bearing and needed the finer spread to
 * tell a sea from a pond at that range; this one only has to find the nearest
 * water inside eight units, and at that range 24 bearings answer the same
 * question twice.
 */
const BERTH_BEARINGS = 12;

/* ---- The two fixed harbours ---------------------------------------- */

/**
 * How far down lon 0 from a pole the polar town's centre sits, and its berth.
 *
 * Not ON the pole, and that is the trap `docs/HARBOURS_PLAN.md` calls Trap 3:
 * `tangentFrame` has no north at a pole and falls back to an arbitrary one, so
 * anything placed exactly there would carry a direction nothing else agrees
 * on. 0.01 rad is 2 units off it -- inside `terrain.ts`'s POLE_LAND_RAD islet,
 * so still on the rock -- and every frame raised there is ordinary.
 *
 * The berth is at 0.05 rad, 10 units, the middle of the moat (`terrain.ts`,
 * POLE_MOAT_RAD 0.08). That puts it exactly BERTH_MAX_ARC from its centre: the
 * polar pair are placed by fiat rather than searched for, so they are allowed
 * to sit on the limit the search would have stopped at.
 */
export const POLE_OFFSET_RAD = 0.01;
const POLE_BERTH_RAD = 0.05;

/**
 * How much of a zone's own rim has to be over reachable water, sampled at how
 * many points.
 *
 * The bearing walk only promises water directly outward from the town, which a
 * berth at the head of a creek or in a pocket cove satisfies while its ring
 * still lies mostly on the bank. Sampling a ring at DOCK_RADIUS asks the
 * question the drawn zone actually asks, and what gets turned away is the town
 * with a puddle beside it.
 *
 * Three quarters MEANS MORE NOW THAN IT USED TO, and the number was left alone
 * anyway. The berth used to be shoved up to 21 units offshore, where three
 * quarters of an eight-unit ring is open water almost by default. It now sits
 * 2.4 units off the beach, where a ring that size over a straight coast is
 * only about three fifths water -- so this no longer reads as "mostly clear",
 * it reads as "on a point, a spit or a narrow shore, with the sea round most
 * of it". The berths that survive are the convex parts of the coastline, and
 * that is a deliberate keep rather than an oversight: at 0.75 the pinned seed
 * founds all 36 harbours and so did all 50 random seeds measured, so nothing
 * is being paid for it. Lower it if a shot ever shows the fleet tied up in the
 * open rather than at a shore.
 *
 * It is still the sharpest edge in the file. It used to cost a town only its
 * dock; now that every settlement is a port it costs the town itself, and 36
 * of them is a hard count -- so raising it does not thin the map, it starts
 * throwing whole worlds away.
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
 * Where the world's settlements are. Every one of them is a port, and there
 * are exactly HARBOUR_COUNT of them or the world is thrown away.
 *
 * Two are PLACED and thirty-four are FOUND. The two polar harbours go down
 * first, at fixed points on lon 0 either side of the globe, and they draw
 * nothing at all from the PRNG -- which is the whole reason they go first
 * rather than last. The random stream that finds the other thirty-four is
 * therefore bit-identical to what it would be if the poles did not exist, so
 * adding them moved no other harbour in any world, and removing them would
 * move none either.
 *
 * The thirty-four are rejection-sampled over the sphere and scored by how
 * coastal and how low the spot is, so shorelines are far more likely than
 * highlands and no two centres land on top of each other. Each then has to
 * find a berth -- water the ship can actually get to, close enough to tie up
 * at -- and a candidate that cannot is not founded. That is what makes
 * `Town.dock` non-null for every town in `all`.
 *
 * Coming up short is not an error and is not repaired here: `createTowns`
 * returns however many it managed, and `worldgen.ts` reads anything under
 * HARBOUR_COUNT as a rejected world and draws a new seed. A pole that cannot
 * reach the sea takes its own slot with it, so a world with a continent on the
 * pole comes back at 35 and is redrawn for that reason alone.
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
  seed: number = TOWN_SEED,
): Towns {
  const rng = mulberry32(seed);

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
  // already placed by two radii. With CLUSTER_MIN_ARC relaxed to 15 units this
  // is no longer a formality -- it is the only thing enforcing the promise.
  const berthMinDot = Math.cos(2 * DOCK_RADIUS * ARC);
  const berthMaxSteps = Math.round(BERTH_MAX_ARC / BERTH_STEP_ARC);
  const marginSteps = Math.round(BERTH_SHORE_MARGIN / BERTH_STEP_ARC);

  /** True if `berth` reaches a berth already placed. */
  function overlapsAPlacedBerth(berth: Vector3): boolean {
    for (let i = 0; i < berthXyz.length; i += 3) {
      const d = berthXyz[i] * berth.x + berthXyz[i + 1] * berth.y + berthXyz[i + 2] * berth.z;
      if (d > berthMinDot) return true;
    }
    return false;
  }

  /**
   * The berth for a town at `centre`, or null if it has no shoreline to tie up
   * at.
   *
   * Null is fatal to the town, not merely to its dock, so this is the gate that
   * decides most of what the world looks like: everything it turns away is a
   * settlement that never existed. It is also, now, the gate that decides
   * whether a whole SEED survives -- turn away four candidates too many and the
   * count comes up short and the world is redrawn.
   *
   * The shape changed with `docs/HARBOURS_PLAN.md`, decision 3. The old search
   * picked one seaward bearing by scoring a long ray along each, then ran as
   * far out to sea as the water held. This one walks every coastal bearing out
   * to the FIRST reachable sea texel, steps BERTH_SHORE_MARGIN past it, and
   * keeps whichever of those landings has the most open water around it. Same
   * two questions -- where is the sea, and is it sea rather than a puddle --
   * asked at the town's own doorstep instead of a fifth of the way to the
   * horizon.
   *
   * It still draws nothing from the PRNG, only from the height map, so retuning
   * it moves which candidates survive but never which candidates are offered.
   * Keep it that way. A berth test that rolled a die would make every town
   * downstream of it move whenever the search changed.
   *
   * Reachability is the whole point. The height map alone cannot answer it: a
   * crater lake is under sea level and reads as water, but `ship.ts` will never
   * carry the player over the rim to reach it, so a berth there would be a
   * charging station nobody can dock at. `waterBodies` flood-filled the sea
   * from the ship's own spawn point, so its mask is the authority -- reachable
   * means below sea level AND not flagged inland.
   */
  function findBerth(centre: Vector3): Vector3 | null {
    tangentFrame(centre, _north, _east);

    let best: Vector3 | null = null;
    let bestScore = -1;

    for (let b = 0; b < BERTH_BEARINGS; b++) {
      const a = (b / BERTH_BEARINGS) * Math.PI * 2;

      // Out to the first reachable sea texel, and no further: this bearing's
      // shoreline is where the town's own water begins.
      let shore = -1;
      for (let st = 1; st <= berthMaxSteps; st++) {
        stepOut(centre, _north, _east, a, st * BERTH_STEP_ARC, _probe);
        if (reachableWater(_probe)) {
          shore = st;
          break;
        }
      }
      if (shore < 0) continue;

      // One fixed step past it, so the ring's inner edge clears the surf. Fixed
      // rather than "as far as the water holds" on purpose: the old walk's
      // greed is exactly what put berths in the middle of coves.
      const berthStep = shore + marginSteps;
      if (berthStep > berthMaxSteps) continue;
      stepOut(centre, _north, _east, a, berthStep * BERTH_STEP_ARC, _probe);
      if (!reachableWater(_probe)) continue;

      // Which of the landings to keep. `oceanFraction` is the same ring probe
      // `Town.coast` is scored with, so a harbour and its berth cannot end up
      // disagreeing about what counts as open water -- and reading it AT THE
      // BERTH rather than at the town is what still separates a real anchorage
      // from a pond two hundred metres inland.
      const score = oceanFraction(heightMap, seaLevel, _probe);
      if (score > bestScore) {
        bestScore = score;
        best = (best ?? new Vector3()).copy(_probe);
      }
    }

    if (best === null) return null;
    if (rimClearance(best) < BERTH_CLEAR) return null;
    if (overlapsAPlacedBerth(best)) return null;
    return best;
  }

  /* ---- 1b. The two poles, placed rather than found ------------------ */

  /**
   * Founds the harbour at `sign * +Y`, or returns false if the moat there is
   * not sea the ship can reach.
   *
   * Placed, not searched: `terrain.ts` has already guaranteed rock at the pole
   * and water around it, so there is nothing to score and nothing to choose.
   * The one thing terrain CANNOT guarantee is that the moat joins the ocean --
   * a continent may be sitting on the pole with the dimple punched into the
   * middle of it -- and that is the single question asked here. A false answer
   * costs the world its 36th harbour and `worldgen.ts` redraws.
   *
   * `rimClearance` is deliberately not consulted. A ring of DOCK_RADIUS around
   * a berth in a sixteen-unit moat crosses the islet on the inside and the fade
   * band on the outside, so it would fail a test written for an open coast, and
   * failing it would mean no polar harbour in any world at all. The moat is a
   * harbour by construction; the test exists to catch a puddle nobody designed.
   */
  function foundPole(sign: number, index: number): boolean {
    const centre = latLonToDir(
      sign * (90 - (POLE_OFFSET_RAD * 180) / Math.PI),
      0,
      new Vector3(),
    );
    const berth = latLonToDir(sign * (90 - (POLE_BERTH_RAD * 180) / Math.PI), 0, new Vector3());
    if (!reachableWater(berth)) return false;
    if (overlapsAPlacedBerth(berth)) return false;

    const town: MutableTown = {
      dir: centre,
      height: heightMap.sample(centre),
      coast: oceanFraction(heightMap, seaLevel, centre),
      dock: null,
      name: HARBOUR_NAMES[index],
      index,
    };
    const dock: Dock = { dir: berth, radius: DOCK_RADIUS, town };
    town.dock = dock;
    towns.push(town);
    docks.push(dock);
    berthXyz.push(berth.x, berth.y, berth.z);
    return true;
  }

  // Before the random loop, and the return value deliberately dropped: a pole
  // that could not be founded is not an error to handle here, it is a harbour
  // missing from the count, which `worldgen.ts` reads as a rejected world.
  foundPole(1, NORTH_POLE_INDEX);
  foundPole(-1, SOUTH_POLE_INDEX);

  /* ---- 2. Settlement centres, each with its berth ------------------ */

  const minDot = Math.cos(CLUSTER_MIN_ARC);

  // Names are dealt by index, and the poles have already taken 0 and 1 --
  // whether or not they were founded. A world that lost a pole therefore runs
  // out of names at 35 towns rather than quietly promoting a found harbour into
  // Marine Stronghold's slot, and comes back short, which is the rejection.
  let nextIndex = SOUTH_POLE_INDEX + 1;

  for (let attempt = 0; attempt < CLUSTER_TRIES && nextIndex < HARBOUR_COUNT; attempt++) {
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

    // Names are dealt by PLACEMENT ORDER, which is a function of the seed, so
    // `Rustwharf` is a different island in every world. That is intended: the
    // name is the identity a save keys on, the ground under it is not.
    const index = nextIndex++;
    const town: MutableTown = {
      dir: _dir.clone(),
      height: h,
      coast,
      dock: null,
      name: HARBOUR_NAMES[index],
      index,
    };
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

  // Built once. `byName` is asked for on a menu open and on a scope repaint,
  // never in the hot path, but a linear walk of 36 strings per icon per frame
  // would still be the kind of thing that turns up in a profile later.
  const byName = new Map<string, Town>();
  for (const town of towns) byName.set(town.name, town);

  return {
    all: towns,
    docks,
    byName(name: string): Town | null {
      return byName.get(name) ?? null;
    },
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
