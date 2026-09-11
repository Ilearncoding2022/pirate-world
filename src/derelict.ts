import { Vector3 } from 'three';
import type { HeightMap } from './heightmap';
import type {
  Derelict,
  DerelictState,
  ShipState,
  Terrain,
  Towns,
  WeatherState,
  WindState,
} from './types';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { mulberry32 } from './towns';
import { WEATHER_THRESHOLD } from './salvage';

/**
 * derelict.ts — the dead hull adrift, and the tow.
 *
 * Owns one `DerelictState`, mutated in place for the life of the run, exactly as
 * `salvage.ts` owns its rafts and `aiboats.ts` its raiders. DOM-free and
 * scene-free; `derelicthull.ts` is what puts a grey hull where this says.
 *
 * The brief is docs/SALVAGE_PLAN.md. Two things there are worth having in mind
 * while reading this file, because neither is guessable from the code:
 *
 *   - **There is no deadline.** The owner's call: a tow has no clock, and the
 *     clock it actually runs against is the tank. A tow halves nothing and
 *     takes a quarter off the top speed while doubling the burn, so the voyage
 *     is a power problem — and `lose()` below is what makes that real.
 *   - **It is found, not posted.** A derelict comes off a roll on the open sea
 *     and not off a harbour's contract board, so this module has no idea what a
 *     contract is and the job strip reads it directly.
 *
 * The roll shares `salvage.ts`'s ten-second cadence and its weather sum, and
 * the sharing is deliberate: two sims reading the same sky on two different
 * periods is how a tuning change to one silently retunes the other. The
 * probabilities are this file's own and are an order of magnitude rarer.
 *
 * **What this file does NOT own.** It does not pay: `main.ts` banks the gold and
 * the reputation when `settle` hands it a hull. It does not take the hull's
 * speed or double its burn either — `ship.ts` and `energy.ts` do, off the
 * `towed` flag this publishes. And it does not decide when a tow is lost; it is
 * told, because both conditions (a flat tank, a maelstrom) belong to modules
 * that already own them.
 */

export interface DerelictDeps {
  terrain: Terrain;
  heightMap: HeightMap;
  waterBodies: WaterBodies;
  towns: Towns;
  seed?: number;
}

export interface Derelicts {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: DerelictState;
  /**
   * Runs with the salvage: after the hazards, before `ship.update`.
   *
   * Before the ship because a towed hull is placed against the hull's position
   * from LAST frame either way — see `tow` — and because `hookReady` has to be
   * true on the frame the player's `Space` is read, not one after it.
   */
  update(
    dt: number,
    ship: ShipState,
    wind: WindState,
    suppressed: boolean,
    weather?: WeatherState,
  ): void;
  /**
   * Puts the towline on, if the ship is lying in a derelict's ring.
   *
   * Returns whether it took, so `main.ts` can raise the notice off the answer
   * rather than re-deriving the eligibility it just asked about — the same
   * contract `energy.toggleMooring` keeps.
   */
  hook(): boolean;
  /** Casts off by hand. Returns the hull that was dropped, or null. */
  release(): Derelict | null;
  /**
   * The towline parts and the hull is GONE: an empty tank, or a maelstrom.
   *
   * Returns what was lost, or null when there was nothing under tow — so a
   * caller can raise a notice only when something actually happened. A derelict
   * merely adrift is untouched by this: losing a tow is about the tow.
   */
  lose(): Derelict | null;
  /**
   * Delivered. Removes the hull and returns it, or null if there is nothing
   * under tow.
   *
   * Whether this is the right harbour is NOT asked here: `main.ts` compares the
   * berth's name against `state.live.bound` and is the only place that knows
   * what the ship is moored to.
   */
  settle(): Derelict | null;
  /** Puts one adrift now, at `position`. The `?derelict=1` dev query and the tests only. */
  force(position: Vector3): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/** Seconds between rolls. `salvage.ts`'s clock, for the reason in the header. */
export const ROLL_PERIOD = 10;

/**
 * The odds of a derelict on one roll: clear air, each band of dirty weather,
 * and the ceiling.
 *
 * An order of magnitude under the salvage, because a derelict is not a find, it
 * is a COMMITMENT: the next minute or two of sailing at three quarters speed
 * and double the burn, toward a harbour somebody else chose. At these figures
 * it is one every ~83 minutes of fair-weather sailing and one every ~5.5
 * minutes of the worst weather the globe has, which puts it in the same bracket
 * as a maelstrom rather than in the salvage's.
 *
 * The weather sum is the same shape as the salvage's and the same threshold
 * (`WEATHER_THRESHOLD`, imported rather than restated). A wreck is likeliest
 * where wrecks happen.
 *
 * **Unlike the salvage's, this ceiling really does bind.** 0.002 plus three
 * terms of 0.01 is 0.032, and the cap takes it back to a round 3% — the
 * clear-air floor's worth, and the only case where it applies is the rare sky
 * that is raining, storming and foggy at once. That is deliberate: 3% is the
 * figure the plan quotes and the one the rate was argued in ("one every ~5.5
 * minutes of the worst weather the globe has"), and a ceiling that quietly sat
 * 7% above its own stated value would be a number nobody could check.
 */
export const P_CLEAR = 0.002;
export const P_TERM = 0.01;
export const P_CEILING = 0.03;

/**
 * How far off the ship a derelict is rolled, world units.
 *
 * The red raider's own band. A derelict never moves under its own power and
 * never expires, so unlike a raft it does not have to be born inside the scope:
 * one rolled at 60 units in clear air is a mark that appears on the rim as the
 * ship happens to close on it, which is the right way to find a wreck.
 */
export const SPAWN_MIN = 30;
export const SPAWN_MAX = 60;

/**
 * How far the harbour it is bound for may be, world units.
 *
 * Argued from the globe's own scale rather than picked. A great circle here is
 * 1257 units and the hull makes 10 of them a second, so one harbour spacing —
 * 36 harbours over 502 000 square units, about 118 apart — is twelve seconds of
 * sailing. 120 is therefore the shortest distance that is a VOYAGE rather than
 * an errand, and 350 is about 47 seconds under tow, which at 1.54x the fuel per
 * unit distance costs about 60% of a full tank. That upper figure is set by the
 * tank and not by patience: it is what makes `lose()` a risk a player can
 * actually run into rather than a rule that never fires.
 *
 * Never the nearest harbour, which is the other half of the same point — a tow
 * to a berth already on the scope is not a voyage either.
 */
export const VOYAGE_MIN = 120;
export const VOYAGE_MAX = 350;

/**
 * How close the ship has to come for the hook to offer itself, world units.
 *
 * A berth's `DOCK_RADIUS` is 8 and this is a little over half of it: a berth is
 * a place the player aims for from miles off and wants to arrive in generously,
 * while a derelict is a small dark object that has to be come alongside.
 *
 * It was 3.5 and that was too tight to hook, which a headless pass over one
 * found before a player had to: both hulls are about 3 units long, so centres
 * 3.5 apart are two boats nearly touching, and "come alongside" had become
 * "ram it". Five is a hull length and a half of clear water between them —
 * close enough that the ring is a place you steer INTO rather than drift
 * through, wide enough that a beam wind carrying the bow a couple of units off
 * does not cost the whole approach.
 */
export const HOOK_RADIUS = 5;

/**
 * How far astern of the hull a towed derelict rides, world units.
 *
 * Six: two hull lengths behind a 3-unit boat, so there is visibly a line's
 * worth of water between them and the dead hull is never inside the player's
 * own wake. Held rigidly rather than on a spring — a spring would be prettier
 * and would need an integrator, a rest length, a damping term and a story about
 * what happens when it is stretched round a headland, none of which a player
 * would read off the screen as anything but "it follows".
 */
export const TOW_DISTANCE = 6;

/** Share of the wind's speed an untowed hull drifts at. `salvage.ts`'s figure. */
export const DRIFT_SHARE = 0.2;

/**
 * What a tow leaves of the ship's top speed: three quarters (owner, 2026-09-11).
 *
 * A quarter off, and NOT a half, and the arithmetic is the whole argument. The
 * burn goes as `(speed / MAX_FORWARD)^2`, so halving the speed quarters the
 * propulsion draw -- and doubling a quarter is a half. A tow at half speed
 * therefore costs 1.11x the fuel per unit distance and takes twice as long: the
 * doubled burn never reaches the panel, and the whole cost lands on the
 * player's patience. A quarter off costs **1.54x** the fuel per unit distance
 * and arrives sooner. It is the better trade on both axes, and it is the one
 * that makes an empty tank -- which parts the line -- a risk rather than a rule
 * that never fires.
 *
 * Worked, from `FULL_SPEED_ENDURANCE = 90`, `IDLE_ENDURANCE = 42 * 60` and
 * `MAX_FORWARD = 10`, all in `energy.ts` and `ship.ts`:
 *
 *   not towing, flat out   10.0 kn   0.111 tank / 100 u   900 u on a full tank
 *   towing (as built)       7.5 kn   0.171 tank / 100 u   584 u
 *   towing at half speed    5.0 kn   0.123 tank / 100 u   813 u
 *
 * `ship.ts` applies this AFTER its own `min(maxForward, hull.speedCap)`. See
 * `PropulsionState.towFactor` in `types.ts` for why it may not join that min.
 */
export const TOW_SPEED_SHARE = 0.75;

/**
 * Seconds a derelict spends fading in.
 *
 * Twice a raider's, because there is nothing to hurry for: a derelict is not
 * closing on anybody and cannot be met by surprise. **There is no fade out.**
 * A hull adrift does not expire — it is hooked, or it is still there — and the
 * three ways it leaves (hooked, released, lost) are all events the player
 * caused and is being told about.
 */
export const FADE_IN = 1;

/** Clearance a spawn keeps from a berth, on top of that berth's radius. `aiboats.ts`'s figure. */
const BERTH_MARGIN = 4;

/** Placement attempts per roll, then give up until the next one. */
const SPAWN_TRIES = 24;

/**
 * Derelict seed. Fixed by default, so a given world puts the same wreck in the
 * same place: `wind.ts`'s argument for WIND_SEED.
 */
const DERELICT_SEED = 0xdead0;

const TWO_PI = Math.PI * 2;
/** World units to radians of arc on this globe. */
const ARC = 1 / GLOBE_RADIUS;

/* ------------------------------------------------------------------ */
/* Module-scope scratch                                                */
/* ------------------------------------------------------------------ */

const _north = new Vector3();
const _east = new Vector3();
const _axis = new Vector3();
const _bearingDir = new Vector3();
const _candidate = new Vector3();
const _drift = new Vector3();
const _astern = new Vector3();

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function stepAlong(out: Vector3, from: Vector3, dir: Vector3, angle: number): boolean {
  _axis.crossVectors(from, dir);
  if (_axis.lengthSq() < 1e-12) return false;
  _axis.normalize();
  out.copy(from).applyAxisAngle(_axis, angle).normalize();
  return true;
}

function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

/** The unit tangent at `at` along the great circle toward `target`, into `out`. */
function pointAt(out: Vector3, at: Vector3, target: Vector3): boolean {
  out.copy(target).addScaledVector(at, -target.dot(at));
  if (out.lengthSq() < 1e-12) return false;
  out.normalize();
  return true;
}

/**
 * The odds of a derelict on one roll, given the sky. Exported so the unit tier
 * can pin the table directly rather than counting wrecks out of a seeded run.
 */
export function oddsFor(weather?: WeatherState): number {
  if (weather === undefined) return P_CLEAR;
  let p = P_CLEAR;
  if (weather.rain > WEATHER_THRESHOLD) p += P_TERM;
  if (weather.storm > WEATHER_THRESHOLD) p += P_TERM;
  if (weather.fog > WEATHER_THRESHOLD) p += P_TERM;
  return p > P_CEILING ? P_CEILING : p;
}

/* ------------------------------------------------------------------ */
/* The derelict                                                        */
/* ------------------------------------------------------------------ */

interface MutableDerelict {
  position: Vector3;
  forward: Vector3;
  bound: string;
  voyage: number;
  towed: boolean;
  envelope: number;
  age: number;
}

interface MutableDerelictState {
  live: MutableDerelict | null;
  hookReady: boolean;
}

export function createDerelicts(deps: DerelictDeps): Derelicts {
  const { terrain, heightMap, waterBodies, towns } = deps;
  const rng = mulberry32(deps.seed ?? DERELICT_SEED);

  const state: MutableDerelictState = { live: null, hookReady: false };
  let rollTimer = 0;

  function sailable(dir: Vector3): boolean {
    return heightMap.sample(dir) < terrain.seaLevel && waterBodies.sample(dir) < 0.5;
  }

  let berthRadius = -1;
  function largestBerthRadius(): number {
    if (berthRadius >= 0) return berthRadius;
    berthRadius = 0;
    for (const town of towns.all) {
      if (town.dock !== null && town.dock.radius > berthRadius) berthRadius = town.dock.radius;
    }
    return berthRadius;
  }

  function nearBerth(dir: Vector3, clearance: number): boolean {
    const all = towns.all;
    for (let i = 0; i < all.length; i++) {
      const dock = all[i].dock;
      if (dock === null) continue;
      if (arcDistance(dir, dock.dir) < clearance) return true;
    }
    return false;
  }

  /**
   * Pick the harbour a hull found at `at` is bound for.
   *
   * Every candidate inside the band is collected and one is drawn from the list,
   * which is what makes the choice uniform over the HARBOURS rather than over
   * the compass: drawing a bearing and taking the nearest harbour along it would
   * favour whichever one happens to sit in a crowded stretch of coast.
   *
   * Exactly one number comes off the stream whether a candidate is found or not,
   * on this project's usual discipline — so a world where the band happens to be
   * empty does not reorder every later draw.
   */
  function pickBound(at: Vector3): { name: string; voyage: number } | null {
    const draw = rng();
    let best: { name: string; voyage: number } | null = null;
    let count = 0;
    for (const town of towns.all) {
      if (town.dock === null) continue;
      const d = arcDistance(at, town.dock.dir);
      if (d < VOYAGE_MIN || d > VOYAGE_MAX) continue;
      count++;
      // Reservoir of one, so the list is never built as an array: the i-th
      // candidate wins with probability 1/i, which leaves every candidate
      // equally likely off the single draw taken above.
      if (draw * count < 1) best = { name: town.name, voyage: d };
    }
    return best;
  }

  function build(position: Vector3, bound: string, voyage: number): MutableDerelict {
    const p = position.clone().normalize();
    tangentFrame(p, _north, _east);
    const derelict: MutableDerelict = {
      position: p,
      // Adrift, a dead hull lies however it lies. The frame at its own centre is
      // as good an answer as any and costs nothing; the wind turns it from the
      // first frame it blows.
      forward: _north.clone(),
      bound,
      voyage,
      towed: false,
      envelope: 0,
      age: 0,
    };
    state.live = derelict;
    return derelict;
  }

  /** Try to put one adrift. Returns whether it was placed. */
  function trySpawn(ship: ShipState): boolean {
    for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
      const d = SPAWN_MIN + rng() * (SPAWN_MAX - SPAWN_MIN);
      const bearing = rng() * TWO_PI;

      tangentFrame(ship.position, _north, _east);
      _bearingDir
        .copy(_north)
        .multiplyScalar(Math.cos(bearing))
        .addScaledVector(_east, Math.sin(bearing));
      if (!stepAlong(_candidate, ship.position, _bearingDir, d * ARC)) continue;

      if (!sailable(_candidate)) continue;
      if (nearBerth(_candidate, largestBerthRadius() + BERTH_MARGIN)) continue;
      // Never inside the hook ring, which would put the offer on screen for a
      // hull the player never saw arrive.
      if (arcDistance(_candidate, ship.position) < HOOK_RADIUS * 2) continue;

      const bound = pickBound(_candidate);
      // No harbour in the band is a world this wreck has no voyage in, and a
      // derelict bound nowhere is worse than no derelict. The next roll tries
      // again somewhere else.
      if (bound === null) continue;

      build(_candidate, bound.name, bound.voyage);
      return true;
    }
    return false;
  }

  /** One roll. The draw is unconditional; only the acting on it is not. */
  function roll(ship: ShipState, suppressed: boolean, weather?: WeatherState): void {
    const draw = rng();
    if (suppressed) return;
    if (state.live !== null) return;
    if (draw < oddsFor(weather)) trySpawn(ship);
  }

  /** Carry an untowed hull along the wind, and turn its bow to match. */
  function drift(derelict: MutableDerelict, wind: WindState, dt: number): void {
    const speed = wind.speed * DRIFT_SHARE;
    if (!(speed > 0)) return;
    _drift.copy(wind.direction);
    _drift.addScaledVector(derelict.position, -_drift.dot(derelict.position));
    if (_drift.lengthSq() < 1e-12) return;
    _drift.normalize();
    // A hull with no way on lies across the wind as readily as along it, but a
    // dead hull being pushed sideways for a minute would read as a bug in the
    // model rather than as a wreck, so it points where it is going.
    derelict.forward.copy(_drift);
    stepAlong(derelict.position, derelict.position, _drift, speed * dt * ARC);
  }

  /**
   * Put a towed hull where the line holds it: `TOW_DISTANCE` dead astern of the
   * ship, bow toward the ship.
   *
   * Against the ship's CURRENT position and heading, which is what makes the
   * line rigid. There is no lag term and no spring: see `TOW_DISTANCE`.
   */
  function tow(derelict: MutableDerelict, ship: ShipState): void {
    _astern.copy(ship.forward).negate();
    if (!stepAlong(derelict.position, ship.position, _astern, TOW_DISTANCE * ARC)) return;
    // Nose-first on the line. Derived rather than carried, because the hull is
    // not sailing: where it points is a consequence of where the ship is.
    if (!pointAt(derelict.forward, derelict.position, ship.position)) {
      tangentFrame(derelict.position, derelict.forward, _east);
    }
  }

  function update(
    dt: number,
    ship: ShipState,
    wind: WindState,
    suppressed: boolean,
    weather?: WeatherState,
  ): void {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    rollTimer += dt;
    while (rollTimer >= ROLL_PERIOD) {
      rollTimer -= ROLL_PERIOD;
      roll(ship, suppressed, weather);
    }

    const derelict = state.live;
    if (derelict === null) {
      state.hookReady = false;
      return;
    }

    derelict.age += dt;
    derelict.envelope = clamp01(derelict.age < FADE_IN ? derelict.age / FADE_IN : 1);

    if (derelict.towed) {
      tow(derelict, ship);
      // A hull on the line is never offering itself, whatever the distance says.
      state.hookReady = false;
      return;
    }

    drift(derelict, wind, dt);

    // Driven ashore and it is gone, the rule every drifting thing in this game
    // keeps. A wreck on the rocks is not a tow, and leaving one aground would
    // put an un-hookable offer on the scope for the rest of the run.
    if (!sailable(derelict.position)) {
      state.live = null;
      state.hookReady = false;
      return;
    }

    /*
     * The ring's own verdict, and nothing more — the shape `energy.ts` keeps for
     * `berthReady`. It says the hull MAY be hooked; `hook()` is the act.
     *
     * Suppressed covers the cases where a press means something else or nothing
     * at all: moored, mid-blackout, inside a maelstrom. A hookable offer while
     * the ship is being swallowed by a funnel would be a notice about a rope.
     */
    state.hookReady = !suppressed && arcDistance(ship.position, derelict.position) < HOOK_RADIUS;
  }

  function hook(): boolean {
    if (!state.hookReady || state.live === null) return false;
    state.live.towed = true;
    state.hookReady = false;
    return true;
  }

  /** The three ways a tow ends, as one line each. Only `settle` is a success. */
  function detach(requireTowed: boolean): Derelict | null {
    const derelict = state.live;
    if (derelict === null) return null;
    if (requireTowed && !derelict.towed) return null;
    state.live = null;
    state.hookReady = false;
    return derelict as Derelict;
  }

  return {
    state: state as DerelictState,
    update,
    hook,
    release: () => detach(true),
    lose: () => detach(true),
    settle: () => detach(true),
    force(position: Vector3): void {
      const bound = pickBound(position);
      // A forced hull in a world with no harbour in the band is still worth
      // putting on the water for a look, so it is bound for the farthest
      // harbour there is rather than refused. `?derelict=1` is a dev query; it
      // may be generous where the roll is strict.
      if (bound !== null) {
        build(position, bound.name, bound.voyage);
        return;
      }
      let far: { name: string; voyage: number } | null = null;
      for (const town of towns.all) {
        if (town.dock === null) continue;
        const d = arcDistance(position, town.dock.dir);
        if (far === null || d > far.voyage) far = { name: town.name, voyage: d };
      }
      build(position, far?.name ?? 'NOWHERE', far?.voyage ?? 0);
    },
  };
}
