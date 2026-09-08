/**
 * weathercells.ts — regions of weather drifting over the globe.
 *
 * The second of the two weather sources (docs/WEATHER_PLAN.md). A SQUALL, in
 * `weather.ts`, is weather at the ship rolled off the wind's own phases and
 * has no place: it arrives when the wind does and the player cannot see it
 * coming. A CELL has a centre, a radius and a bearing, so it can be seen on
 * the scope and in the sky, sailed around, and outrun.
 *
 * It is a hazard's skeleton with a weather's skin. `hazards.ts` had already
 * solved every geometric problem this file has -- carrying a thing over a
 * sphere without letting it wander at the poles, keeping a population alive
 * around a moving ship, refusing a spawn on land -- so those shapes are
 * copied rather than improved on. What is different is what a cell IS: it
 * shades and it dims, it never displaces the sea, nothing on the CPU has to
 * ride it, and so none of `hazardfield.ts`'s parity discipline applies here.
 *
 * Two rules this file exists to keep:
 *
 *  - **The wind's PRNG is not touched.** `wind.ts` draws a fixed sequence per
 *    phase and two goldens replay it. Cells draw from their own stream.
 *  - **The map is not the truth.** `weathermap.ts` bakes these cells into a
 *    texture for the sky to read; that texture is coarse and a frame stale.
 *    Every number that decides anything -- the envelopes, the visibility, the
 *    wind's floor -- comes from `sampleAtShip` below, which is exact and this
 *    frame's.
 */
import { Vector3 } from 'three';
import type {
  CellKind,
  CellsState,
  EnergyState,
  ShipState,
  Terrain,
  WeatherCell,
} from './types';
import type { HeightMap } from './heightmap';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { mulberry32 } from './towns';

export interface WeatherCells {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: CellsState;
  /**
   * Runs BEFORE `wind.update`, which is the one ordering constraint this
   * module has: the wind reads `stormAtShip` to floor itself, so the sample
   * has to be this frame's.
   *
   * Transport, then ageing, then the roll, then the sample -- in that order,
   * so the sample describes the cells as they stand after everything that
   * happens to them this frame.
   */
  update(dt: number, ship: ShipState, energy: EnergyState): void;
  /** Raises one cell now, centred at `centre` and drifting toward `north`. Tests and `?cell=` only. */
  force(kind: CellKind, centre: Vector3, north: Vector3, radius?: number): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/*
 * Every distance here is SHIP-SCALE: absolute world units, sized against the
 * scope's 50-unit range and a hull that makes 10 knots. See
 * docs/ARCHITECTURE.md "World scale". None of them grows with GLOBE_RADIUS,
 * and they should not: a bigger planet should mean a longer crossing between
 * the same storms, not bigger storms.
 */

/**
 * How many cells are alive around the ship at once.
 *
 * Three, and the number is derived rather than chosen. A point travelling
 * through a field of discs of radius `r` at number density `n` meets one every
 * `1 / (2 * r * n)` units. The bubble below is a spherical cap of area
 * `2 * PI * R^2 * (1 - cos(CELL_BUBBLE / R))` = about 172000 u^2, and the mean
 * radius of the two kinds is about 32, so three cells give a mean free path of
 * roughly 900 units -- 90 seconds at a flat-out 10 knots, and rather more than
 * that in practice because nobody sails in a straight line and the cells are
 * drifting across the track rather than sitting still.
 *
 * That lands in the two-to-three-minute encounter band that was asked for.
 * FOUR would put it near a minute, which is a different game. Measure before
 * moving it: `?debug` publishes `cellEncounters`, a count of the times the
 * ship has crossed into a cell, and one full day (20 minutes) is the sample.
 */
const CELL_TARGET = 3;

/**
 * Seconds between spawn rolls, and the chance of a spawn at an empty bubble.
 *
 * Ten seconds is slow enough that the roll is free and fast enough that a
 * bubble emptied by a long reach refills in about a minute. The probability
 * is scaled by how far under target the population is, so a full bubble never
 * spawns and an empty one fills at 0.6 per roll.
 */
const CELL_ROLL_PERIOD = 10;
const CELL_P_SPAWN = 0.6;

/**
 * How far from the ship a cell may be born, and how far it may drift before
 * it is retired, world units.
 *
 * `CELL_SPAWN_MIN` is 90 rather than the scope's own 50 because a cell has a
 * radius: born at 50 with a radius of 60, a fog bank would be on the
 * instrument -- and on the ship -- the moment it appeared. 90 clears the
 * scope plus the largest radius with a little to spare, so weather always
 * arrives from outside and is always seen coming.
 *
 * The retire margin is generous (`CELL_BUBBLE + CELL_RETIRE`) so that a cell
 * the player is sailing away from is not deleted a moment before they turn
 * round and look at it again.
 */
const CELL_SPAWN_MIN = 90;
const CELL_BUBBLE = 250;
const CELL_RETIRE = 70;

/** Share of cells that are fog rather than storm, and share of storms that carry lightning. */
const CELL_FOG_SHARE = 0.4;
const CELL_LIGHTNING_SHARE = 0.4;

/**
 * Cell radii, world units.
 *
 * A storm is 50 to 80 across: bigger than the scope's 50-unit *radius* is
 * deliberately avoided, so a storm always has an edge on the instrument and
 * the player can see which way to run. A fog bank is larger and vaguer, 70 to
 * 120 across, because a fog you can see the far side of is not much of a fog.
 */
const STORM_R_MIN = 25;
const STORM_R_MAX = 40;
const FOG_R_MIN = 35;
const FOG_R_MAX = 60;

/**
 * How long a cell lives, and how long it spends arriving and leaving,
 * seconds.
 *
 * Three to six minutes against a day of twenty. Long enough that a cell is a
 * feature of the passage rather than a squall, short enough that the weather
 * two minutes from now is not the weather now. Both fades are clamped to a
 * third of the life below, the same rule `wind.ts` applies to its own.
 */
const CELL_LIFE_MIN = 180;
const CELL_LIFE_MAX = 360;
const CELL_GROW = 30;
const CELL_FADE = 45;

/**
 * How fast a cell drifts, world units per second.
 *
 * A fifth of `MAX_FORWARD`. The whole point of a cell over a squall is that
 * it can be avoided, and avoidance means the player is faster than the
 * weather by a margin they can feel. It also means a cell can never chase a
 * ship down: what catches you is one you did not look at.
 */
const CELL_DRIFT = 2;

/**
 * Clearance a fog cell keeps from land, world units, and the spacing between
 * two cells' centres.
 *
 * Fog over a continent is a cloud, and the clouds are `clouds.ts`'s business;
 * a fog cell is a bank sitting on water. Storms may sit anywhere, because a
 * storm over land is a real thing the player watches from the sea.
 *
 * `CELL_SPACING` stops two cells stacking into one indistinguishable mass:
 * they combine by `max`, so a pair on top of each other would read as one
 * cell with a longer life, which is not what a population of three should
 * spend two of its slots on.
 */
const CELL_COAST_MARGIN = 15;
const CELL_SPACING = 60;

/**
 * Where a cell's flat core ends, as a fraction of its radius.
 *
 * Inside 0.55 of the radius the weather is at full strength; from there it
 * eases to nothing at the edge. A cell with no core would only ever be at
 * full strength at a single point and a storm would never quite arrive; a
 * cell that was flat to its edge would switch on and off as the ship crossed
 * the line.
 *
 * THE ONE NUMBER TWO FILES SHARE. `weathermap.ts` bakes the same profile into
 * its texture, and the shader that reads that texture has to agree with the
 * CPU sample below or the sky and the scope will disagree about where a cell
 * ends. Exported for exactly that reason.
 */
export const CELL_CORE = 0.55;

/** Bearings walked by the coast probe when placing a fog cell. */
const PROBE_BEARINGS = 8;

/** How many cells the state's array can ever hold. Cheap insurance against a runaway roll. */
const MAX_CELLS = 8;

/**
 * Weather seed. Fixed by default, and deliberately NOT the wind's.
 *
 * Two streams, because one would mean `weathercells.ts` drawing from the
 * wind's PRNG and shifting every draw `tests/unit/wind.test.ts` and the two
 * goldens replay. See docs/WEATHER_PLAN.md, Trap 1.
 */
const CELL_SEED = 0xc3115;

const TWO_PI = Math.PI * 2;
/** World units to radians on the globe. */
const ARC = 1 / GLOBE_RADIUS;

/* ------------------------------------------------------------------ */
/* Module-scope scratch (no per-frame allocation in the hot path)      */
/* ------------------------------------------------------------------ */

const _north = new Vector3();
const _east = new Vector3();
const _axis = new Vector3();
const _prevCentre = new Vector3();
const _candidate = new Vector3();
const _bearingDir = new Vector3();
const _probe = new Vector3();

/** Clamp to [0, 1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The usual cubic ease, on an already-unclamped argument. */
function smoothstep01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * Rotate `from` by `angle` toward the tangent direction `dir`, about their
 * cross product — the same great-circle step `ship.ts`, `wind.ts` and
 * `hazards.ts` all walk. Returns false, writing nothing, when the two are
 * parallel and no axis exists.
 */
function stepAlong(out: Vector3, from: Vector3, dir: Vector3, angle: number): boolean {
  _axis.crossVectors(from, dir);
  if (_axis.lengthSq() < 1e-12) return false;
  _axis.normalize();
  out.copy(from).applyAxisAngle(_axis, angle).normalize();
  return true;
}

/** Great-circle distance between two unit directions, world units. */
function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

/**
 * A cell's contribution at a point, 0..1.
 *
 * `strength` inside the core, easing to nothing at the edge. The one profile
 * this system has: `weathermap.ts` bakes this exact curve and the scope draws
 * a disc of the same radius, so all three agree about where a cell is.
 */
export function cellProfile(strength: number, distance: number, radius: number): number {
  if (!(radius > 0)) return 0;
  return strength * (1 - smoothstep01((distance / radius - CELL_CORE) / (1 - CELL_CORE)));
}

/* ------------------------------------------------------------------ */
/* Cells                                                               */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only WeatherCell surface. */
interface MutableCell {
  kind: CellKind;
  centre: Vector3;
  north: Vector3;
  radius: number;
  strength: number;
  lightning: boolean;
  age: number;
  life: number;
}

interface MutableCellsState {
  live: MutableCell[];
  stormAtShip: number;
  fogAtShip: number;
  lightningAtShip: boolean;
  stormCellAtShip: MutableCell | null;
}

/**
 * The drifting weather.
 *
 * `terrain` and `heightMap` are the same pair `wind.ts` and `radar.ts` probe,
 * on purpose: a fog bank refused for being over land is refused against the
 * same coastline the scope draws and the hull collides with.
 */
export function createWeatherCells(
  terrain: Terrain,
  heightMap: HeightMap,
  seed = CELL_SEED,
): WeatherCells {
  const rng = mulberry32(seed);

  const state: MutableCellsState = {
    live: [],
    stormAtShip: 0,
    fogAtShip: 0,
    lightningAtShip: false,
    stormCellAtShip: null,
  };

  let rollTimer = 0;

  /** True if `dir` is land, or within `margin` world units of it. */
  function nearLand(dir: Vector3, margin: number): boolean {
    if (heightMap.sample(dir) > terrain.seaLevel) return true;
    tangentFrame(dir, _north, _east);
    const angle = margin * ARC;
    for (let b = 0; b < PROBE_BEARINGS; b++) {
      const theta = (b / PROBE_BEARINGS) * TWO_PI;
      _bearingDir
        .copy(_north)
        .multiplyScalar(Math.cos(theta))
        .addScaledVector(_east, Math.sin(theta));
      if (!stepAlong(_probe, dir, _bearingDir, angle)) continue;
      if (heightMap.sample(_probe) > terrain.seaLevel) return true;
    }
    return false;
  }

  /**
   * Raise a cell at `centre` drifting toward `north`, and file it.
   *
   * `north` is projected onto the tangent plane at `centre` rather than
   * trusted: a caller (`force`, or the placement below) hands in a direction
   * that is only approximately tangent, and a cell whose travel vector has a
   * radial component climbs off the sphere over a six-minute life.
   */
  function build(
    kind: CellKind,
    centre: Vector3,
    north: Vector3,
    radius: number,
    life: number,
    lightning: boolean,
  ): MutableCell {
    const c = centre.clone().normalize();
    const n = north.clone();
    n.addScaledVector(c, -n.dot(c));
    if (n.lengthSq() > 1e-12) n.normalize();
    else tangentFrame(c, n, _east);
    return { kind, centre: c, north: n, radius, strength: 0, lightning, age: 0, life };
  }

  /**
   * One spawn roll.
   *
   * Eight draws, ALWAYS, in a fixed order, whether or not anything is spawned
   * — the discipline `hazards.ts` records on its own `ROLL_ORDER`. A roll that
   * returned early on a full bubble would consume a different number of
   * numbers depending on the population, and the stream would stop replaying.
   */
  function roll(ship: ShipState): void {
    const spawnDraw = rng();
    const kindDraw = rng();
    const rangeDraw = rng();
    const bearingDraw = rng();
    const radiusDraw = rng();
    const lifeDraw = rng();
    const travelDraw = rng();
    const lightningDraw = rng();

    const deficit = (CELL_TARGET - state.live.length) / CELL_TARGET;
    if (deficit <= 0) return;
    if (spawnDraw >= CELL_P_SPAWN * deficit) return;
    if (state.live.length >= MAX_CELLS) return;

    const kind: CellKind = kindDraw < CELL_FOG_SHARE ? 'fog' : 'storm';
    const range = CELL_SPAWN_MIN + rangeDraw * (CELL_BUBBLE - CELL_SPAWN_MIN);
    const radius =
      kind === 'fog'
        ? FOG_R_MIN + radiusDraw * (FOG_R_MAX - FOG_R_MIN)
        : STORM_R_MIN + radiusDraw * (STORM_R_MAX - STORM_R_MIN);
    const life = CELL_LIFE_MIN + lifeDraw * (CELL_LIFE_MAX - CELL_LIFE_MIN);
    const lightning = kind === 'storm' && lightningDraw < CELL_LIGHTNING_SHARE;

    // Where it would go: the ship, stepped along one bearing by one range.
    tangentFrame(ship.position, _north, _east);
    const theta = bearingDraw * TWO_PI;
    _bearingDir
      .copy(_north)
      .multiplyScalar(Math.cos(theta))
      .addScaledVector(_east, Math.sin(theta));
    if (!stepAlong(_candidate, ship.position, _bearingDir, range * ARC)) return;

    // A fog bank sits on water. A storm may sit anywhere -- watching one break
    // over a headland from a mile offshore is worth more than the consistency.
    if (kind === 'fog' && nearLand(_candidate, CELL_COAST_MARGIN)) return;

    // And not on top of one that is already there: two cells combine by `max`,
    // so a stacked pair is one cell wearing two of the three slots.
    for (const other of state.live) {
      if (arcDistance(_candidate, other.centre) < CELL_SPACING) return;
    }

    // Its own travel bearing, unrelated to the bearing it was placed on: a
    // cell born to the north-east is as likely to be leaving as arriving.
    const travel = travelDraw * TWO_PI;
    tangentFrame(_candidate, _north, _east);
    _bearingDir
      .copy(_north)
      .multiplyScalar(Math.cos(travel))
      .addScaledVector(_east, Math.sin(travel));

    state.live.push(build(kind, _candidate, _bearingDir, radius, life, lightning));
  }

  /**
   * Carry one cell a step along its own bearing.
   *
   * `north` is carried by exactly the rotation that moved `centre` — parallel
   * transport, the way `ship.ts` carries the bow and `hazards.ts` a crest —
   * and then pushed back onto the tangent plane, because each step leaves it
   * a rounding error out and a six-minute life is thousands of steps.
   */
  function transport(cell: MutableCell, dt: number): void {
    _prevCentre.copy(cell.centre);
    if (!stepAlong(cell.centre, cell.centre, cell.north, CELL_DRIFT * dt * ARC)) return;

    _axis.crossVectors(_prevCentre, cell.centre);
    const sin = _axis.length();
    if (sin > 1e-12) {
      _axis.multiplyScalar(1 / sin);
      const cos = Math.max(-1, Math.min(1, _prevCentre.dot(cell.centre)));
      cell.north.applyAxisAngle(_axis, Math.atan2(sin, cos));
    }
    cell.north.addScaledVector(cell.centre, -cell.north.dot(cell.centre));
    if (cell.north.lengthSq() > 1e-12) cell.north.normalize();
    else tangentFrame(cell.centre, cell.north, _east);
  }

  /**
   * The lifecycle envelope: up over `CELL_GROW`, down over `CELL_FADE`, both
   * clamped to a third of the life so a short cell still reaches full
   * strength instead of spending its whole life in transit — the same trap
   * `wind.ts`'s `FADE` comment records falling into once.
   */
  function envelopeOf(cell: MutableCell): number {
    const grow = Math.min(CELL_GROW, cell.life / 3);
    const fade = Math.min(CELL_FADE, cell.life / 3);
    const rise = grow > 0 ? cell.age / grow : 1;
    const fall = fade > 0 ? (cell.life - cell.age) / fade : 1;
    return clamp01(Math.min(rise, fall));
  }

  /**
   * The field at the ship, sampled from the cells themselves.
   *
   * `max`, never a sum: two overlapping cells are one weather, and adding
   * them would make a pair of half-strength banks darker than either at full.
   */
  function sampleAtShip(ship: ShipState): void {
    let storm = 0;
    let fog = 0;
    let lightning = false;
    let stormCell: MutableCell | null = null;
    for (const cell of state.live) {
      const v = cellProfile(cell.strength, arcDistance(ship.position, cell.centre), cell.radius);
      if (v <= 0) continue;
      if (cell.kind === 'fog') {
        if (v > fog) fog = v;
      } else if (v > storm) {
        storm = v;
        lightning = cell.lightning;
        stormCell = cell;
      }
    }
    state.stormAtShip = storm;
    state.fogAtShip = fog;
    state.lightningAtShip = lightning;
    // The winner itself, not just its numbers: `weather.ts` places a bolt at
    // its centre, and a second pass looking for "the strongest storm cell"
    // could break a tie the other way from the one this loop just did.
    state.stormCellAtShip = stormCell;
  }

  function update(dt: number, ship: ShipState, _energy: EnergyState): void {
    // A frame that advanced no time moves no weather. Returning leaves the
    // last true sample standing rather than rewriting it with a stale zero.
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    // ---- Transport, ageing and retirement ---------------------------------
    for (let i = state.live.length - 1; i >= 0; i--) {
      const cell = state.live[i];
      transport(cell, dt);
      cell.age += dt;
      cell.strength = envelopeOf(cell);
      const gone =
        cell.age >= cell.life ||
        arcDistance(ship.position, cell.centre) > CELL_BUBBLE + CELL_RETIRE;
      if (gone) state.live.splice(i, 1);
    }

    // ---- The roll ---------------------------------------------------------
    rollTimer += dt;
    while (rollTimer >= CELL_ROLL_PERIOD) {
      rollTimer -= CELL_ROLL_PERIOD;
      roll(ship);
    }

    // ---- What all of that comes to, at the ship ---------------------------
    sampleAtShip(ship);
  }

  function force(kind: CellKind, centre: Vector3, north: Vector3, radius?: number): void {
    const r = radius ?? (kind === 'fog' ? FOG_R_MAX : STORM_R_MAX);
    // A forced cell is for looking at: it opens at full strength rather than
    // spending half a minute arriving, and outlives any screenshot.
    const cell = build(kind, centre, north, r, 600, kind === 'storm');
    cell.age = CELL_GROW;
    cell.strength = 1;
    state.live.push(cell);
  }

  return { state: state as CellsState, update, force };
}

/** Read-only view of one cell, for the debug hook and the tests. */
export type { WeatherCell };
