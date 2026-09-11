import { Vector3 } from 'three';
import type { HeightMap } from './heightmap';
import type {
  SalvageRaft,
  SalvageState,
  ShipState,
  Terrain,
  Towns,
  WeatherState,
  WindState,
} from './types';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { mulberry32 } from './towns';

/**
 * salvage.ts — the rafts of salvage on the open sea.
 *
 * Owns one `SalvageState`, mutated in place for the life of the run, as
 * `wind.ts` owns `WindState` and `aiboats.ts` owns `AiBoatState`. DOM-free and
 * scene-free: it moves numbers and vectors and raises one callback, which is
 * what lets the whole rule set be measured in the two-second unit tier.
 * `salvagerafts.ts` is what puts timber where this says.
 *
 * The brief is docs/SALVAGE_PLAN.md. Read it before retuning anything here;
 * the odds below moved once before any of this was written and the arithmetic
 * that moved them is recorded there.
 *
 * `aiboats.ts` is the model this file is cut from rather than `hazards.ts`, and
 * the choice is a design decision and not a convenience: **a raft is an
 * ENCOUNTER, like a raider, not weather, like a wave.** So the roll is on the
 * raiders' ten-second cadence, the spawn band straddles the scope the way
 * theirs does, and the fade in and out is theirs. The two geometry rules both
 * of those files carry run through this one unchanged:
 *
 *   - **Nothing is kept as a compass bearing.** A raft is a centre carried
 *     across its own drift by parallel transport. A bearing lives in the
 *     tangent frame at one point and that frame spins arbitrarily fast near a
 *     pole, so `tangentFrame` is built fresh at the point of use, never held.
 *   - **The seeded stream is drawn from unconditionally.** The roll takes its
 *     number whether it can act on it or not, so what happens to be on the
 *     water — or what the sky happens to be doing — cannot reorder the draws
 *     behind it.
 *
 * What a raft is CARRYING is not here. `salvagebounty.ts` owns the payout
 * tables and `main.ts` banks them, on exactly the split `battle.ts` and
 * `bounty.ts` keep: this file decides when one appears and when it is touched.
 */

export interface SalvageDeps {
  terrain: Terrain;
  heightMap: HeightMap;
  waterBodies: WaterBodies;
  towns: Towns;
  seed?: number;
  /**
   * Fired once, the frame the hull reaches a raft. `main.ts` rolls the haul and
   * banks it from here; the raft is already out of `live` by the time this is
   * called, because a raft that has been taken is gone.
   */
  onTake: (raft: SalvageRaft) => void;
}

export interface Salvage {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: SalvageState;
  /**
   * Runs where the raiders run: after the hazards and before `ship.update`.
   *
   * After the hazards because `main.ts`'s `suppressed` is derived from them,
   * and before the ship because a raft taken this frame should be gone from
   * the scene this frame rather than next.
   *
   * `weather` is optional and absent means a clear sky — the rate a world with
   * no weather system would run at, which is what the tuning tests want.
   * `suppressed` is `main.ts`'s own verdict (docked, mid-blackout, in a
   * maelstrom, in a fight) and blocks both the roll and the taking.
   */
  update(
    dt: number,
    ship: ShipState,
    wind: WindState,
    suppressed: boolean,
    weather?: WeatherState,
  ): void;
  /** Floats one raft now, at `position`. The `?salvage=` dev query and the tests only. */
  force(position: Vector3): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * Seconds between rolls.
 *
 * `aiboats.ts`'s `ROLL_PERIOD`, deliberately, and ten times `hazards.ts`'s.
 * See the file header: a raft is a thing you meet, not weather you are in.
 *
 * Move this and every rate below moves with it, which is almost never what was
 * wanted; move a probability instead.
 */
export const ROLL_PERIOD = 10;

/**
 * The odds of a raft on one roll: the floor in clear air, what each band of
 * dirty weather adds, and the ceiling.
 *
 * **The weather terms SUM** (owner, 2026-09-11). Rain, storm and fog each add
 * their own share, so being in more than one at once is worth more than being
 * deep in any one of them — which is the whole reason salvage exists where it
 * does. What that buys, at `salvagebounty.ts`'s expected value of 550 gold:
 *
 * | Sky                          | P per roll | A raft every | Gold/min |
 * |------------------------------|-----------|--------------|----------|
 * | Clear                        | 0.5%      | ~33 min      | ~17      |
 * | One term (rain, or fog)      | 3.5%      | ~4.8 min     | ~115     |
 * | Two (a storm with rain)      | 6.5%      | ~2.6 min     | ~215     |
 * | Three at once (the ceiling)  | 9.5%      | ~1.8 min     | ~310     |
 *
 * A 19:1 ratio between the worst sky and the clearest. The ceiling sits under
 * a fishing session's rate and an order of magnitude under the 1900-2800 gold
 * a minute the plan's first draft would have printed at 100-3000 gold on a
 * one-second roll. If this needs pulling again, pull `P_TERM` and not
 * `salvagebounty.ts`'s band: the band is the figure a player reads.
 *
 * `P_CEILING` is not doing any work today and is kept deliberately — 0.005
 * plus three terms of 0.03 is exactly 0.095, so the ceiling IS the sum. It is
 * here so a fourth weather term cannot quietly raise it without somebody
 * rereading this comment.
 */
export const P_CLEAR = 0.005;
export const P_TERM = 0.03;
export const P_CEILING = 0.095;

/**
 * How strong one of rain, storm or fog has to be to count as weather.
 *
 * Not a new number: `main.ts` already calls a cell MET at
 * `stormAtShip > 0.1 || fogAtShip > 0.1` for its own encounter counter. A
 * second threshold for the same judgement is how two opinions of the weather
 * start.
 */
export const WEATHER_THRESHOLD = 0.1;

/**
 * Rafts afloat at once (owner: three).
 *
 * It binds rarely and is meant to: at the 9.5% ceiling a raft arrives about
 * every 110 seconds against a 120-second life, so the sea usually carries one.
 * What the cap actually stops is a player parked in a storm collecting a
 * flotilla.
 */
export const LIVE_MAX = 3;

/**
 * How far off the ship a raft is rolled, world units.
 *
 * Inside the scope at both ends, unlike a raider's band, and that is the
 * difference between the two: a raider announces itself by closing, and a raft
 * never moves, so one rolled beyond `RADAR_RANGE` would be a reward the player
 * is never told about. 20 at the near end keeps one from appearing under the
 * bow, which would read as the game dropping gold on the deck.
 */
export const SPAWN_MIN = 20;
export const SPAWN_MAX = 50;

/**
 * Seconds a raft floats before it sinks unclaimed.
 *
 * 120 is about 1200 units of sailing at 10 kn — far enough that a raft on the
 * rim of the scope is always worth turning for, short enough that the sea does
 * not silt up with timber nobody collected.
 */
export const LIFE = 120;

/**
 * Seconds of fade at each end, and the raiders' own figures.
 *
 * The rise is short because salvage that brightens slowly reads as a bug; the
 * fall is longer because a raft vanishing in one frame reads as a dropped draw
 * call. Unlike a raider's, this fade is on the timber itself — a raft has no
 * lights — so `salvagerafts.ts` spends it on the group's scale.
 */
export const FADE_IN = 0.5;
export const FADE_OUT = 1;

/**
 * The radius band a raft rolls its own size from, world units.
 *
 * Centred on `raftmesh.ts`'s `RAFT_NOMINAL_R` of 1.2, so the authored pile is
 * the middle of the range and the extremes are a modest pile and a big one.
 * The arena rolls its rafts the same way, which is most of why they read as
 * the same object in both seas.
 */
export const RADIUS_MIN = 0.9;
export const RADIUS_MAX = 1.7;

/**
 * How close the hull has to come to take a raft, world units.
 *
 * Wider than the raiders' `CONTACT_RADIUS` of 2.4 because a raft is wider than
 * a hull: 1.5 of hull plus 1.2 of nominal raft is 2.7 before any mercy. It is
 * a centre-to-centre test, so a raft is taken slightly before the timber is
 * visibly under the bow, which is the right way for this one to err — the
 * alternative is a player steering at a pile of wood and missing it.
 *
 * Taking is deliberately NOT a foul. The owner chose contact over a ring, and
 * a pickup that punished contact would be asking the player to hit a thing
 * carefully.
 */
export const TAKE_RADIUS = 3;

/**
 * Share of the wind's speed a raft drifts at.
 *
 * A fifth. A raft is flotsam: it has no way of its own, it goes where the
 * water goes, and at a fifth of a 10-knot blow it covers 120 units over its
 * whole life — enough that a raft left alone is somewhere else when the player
 * comes back for it, not enough to chase one down.
 */
export const DRIFT_SHARE = 0.2;

/**
 * Clearance a raft keeps from a berth, on top of that berth's own radius.
 *
 * `aiboats.ts`'s `BERTH_MARGIN`, and the same argument: a berth is shelter,
 * `energy.ts` says a docked ship is not to be shoved by the sea, and salvage
 * floating inside a charging ring would be gold a player collects by tying up
 * rather than by sailing.
 */
const BERTH_MARGIN = 4;

/** Placement attempts per roll, then give up until the next one. `aiboats.ts`'s figure. */
const SPAWN_TRIES = 24;

/**
 * Salvage seed. Fixed by default, so a given world always floats the same
 * salvage: the argument `wind.ts` makes for WIND_SEED and `aiboats.ts` for
 * AIBOAT_SEED. Tuning a rate needs the same sea back on the next run.
 */
const SALVAGE_SEED = 0x5a1fa6;

const TWO_PI = Math.PI * 2;
/** World units to radians of arc on this globe. */
const ARC = 1 / GLOBE_RADIUS;

/* ------------------------------------------------------------------ */
/* Module-scope scratch (no per-frame allocation in the hot path)      */
/* ------------------------------------------------------------------ */

const _north = new Vector3();
const _east = new Vector3();
const _axis = new Vector3();
const _bearingDir = new Vector3();
const _candidate = new Vector3();
const _drift = new Vector3();

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Rotate `from` by `angle` toward the tangent direction `dir`, about their
 * cross product: the great-circle step `ship.ts` walks in `stepAlong` and both
 * sims take for their own travel. False, writing nothing, when the two are
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
 * The odds of a raft on one roll, given the sky.
 *
 * Exported because it is the whole of the rate and the unit tier pins it
 * directly: a table of skies against probabilities is a far better test than
 * counting rafts out of a seeded run, and the two would only ever disagree
 * about sampling noise.
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
/* Salvage                                                             */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only `SalvageRaft` surface. */
interface MutableRaft {
  position: Vector3;
  radius: number;
  yaw: number;
  age: number;
  life: number;
  envelope: number;
}

interface MutableSalvageState {
  live: MutableRaft[];
}

export function createSalvage(deps: SalvageDeps): Salvage {
  const { terrain, heightMap, waterBodies, towns, onTake } = deps;
  const rng = mulberry32(deps.seed ?? SALVAGE_SEED);

  const state: MutableSalvageState = { live: [] };
  let rollTimer = 0;

  /*
   * Asked of the same rasterised height field the water shader, the scope,
   * `hazards.ts` and `aiboats.ts` read, never of `terrain.heightAt`. Readings
   * of one field cannot disagree about where the shoreline is.
   */
  function sailable(dir: Vector3): boolean {
    return heightMap.sample(dir) < terrain.seaLevel && waterBodies.sample(dir) < 0.5;
  }

  /** The widest berth in the world, cached once. `aiboats.ts`'s trick, same reason. */
  let berthRadius = -1;
  function largestBerthRadius(): number {
    if (berthRadius >= 0) return berthRadius;
    berthRadius = 0;
    for (const town of towns.all) {
      if (town.dock !== null && town.dock.radius > berthRadius) berthRadius = town.dock.radius;
    }
    return berthRadius;
  }

  /** True if any berth's centre is within `clearance` of `dir`. */
  function nearBerth(dir: Vector3, clearance: number): boolean {
    const all = towns.all;
    for (let i = 0; i < all.length; i++) {
      const dock = all[i].dock;
      if (dock === null) continue;
      if (arcDistance(dir, dock.dir) < clearance) return true;
    }
    return false;
  }

  /** Put one raft on the water at `position` and file it. */
  function build(position: Vector3): MutableRaft {
    const raft: MutableRaft = {
      position: position.clone().normalize(),
      radius: RADIUS_MIN + rng() * (RADIUS_MAX - RADIUS_MIN),
      yaw: rng() * TWO_PI,
      age: 0,
      life: LIFE,
      envelope: 0,
    };
    state.live.push(raft);
    return raft;
  }

  /** Try to float one raft. Returns whether it was placed. */
  function trySpawn(ship: ShipState): boolean {
    for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
      const d = SPAWN_MIN + rng() * (SPAWN_MAX - SPAWN_MIN);
      const bearing = rng() * TWO_PI;

      // Resolved in a frame raised at the SHIP and used immediately, never
      // stored: see the file header on why a bearing may not be kept.
      tangentFrame(ship.position, _north, _east);
      _bearingDir
        .copy(_north)
        .multiplyScalar(Math.cos(bearing))
        .addScaledVector(_east, Math.sin(bearing));
      if (!stepAlong(_candidate, ship.position, _bearingDir, d * ARC)) continue;

      // The cheapest test first, and the one that rejects most.
      if (!sailable(_candidate)) continue;
      if (nearBerth(_candidate, largestBerthRadius() + BERTH_MARGIN)) continue;
      // Never inside arm's reach of the bow: a raft rolled at 20 units cannot
      // land on the hull, but `force` and a future retune of SPAWN_MIN could.
      if (arcDistance(_candidate, ship.position) < TAKE_RADIUS * 2) continue;

      build(_candidate);
      return true;
    }
    return false;
  }

  /**
   * One roll. The draw is unconditional; only the acting on it is not.
   *
   * Two numbers come off the stream per roll at most — this draw, then
   * `trySpawn`'s own — and exactly one when nothing can be placed, which is
   * the same discipline `aiboats.ts` keeps.
   */
  function roll(ship: ShipState, suppressed: boolean, weather?: WeatherState): void {
    const draw = rng();
    if (suppressed) return;
    if (state.live.length >= LIVE_MAX) return;
    if (draw < oddsFor(weather)) trySpawn(ship);
  }

  /**
   * Carry one raft along the wind.
   *
   * `wind.direction` is a world vector in the tangent plane at the SHIP, and a
   * raft is up to 50 units away where that plane is a fraction of a degree
   * off, so it is projected onto the tangent plane at the raft and
   * renormalised rather than used as it stands — `hazards.ts`'s `crestHeading`,
   * for the same reason. A raft keeps no heading of its own: it is re-derived
   * from the live wind every frame, which is exactly right for something with
   * no way of its own.
   */
  function drift(raft: MutableRaft, wind: WindState, dt: number): void {
    const speed = wind.speed * DRIFT_SHARE;
    if (!(speed > 0)) return;
    _drift.copy(wind.direction);
    _drift.addScaledVector(raft.position, -_drift.dot(raft.position));
    if (_drift.lengthSq() < 1e-12) return;
    _drift.normalize();
    stepAlong(raft.position, raft.position, _drift, speed * dt * ARC);
  }

  /** Up over FADE_IN from birth, down over the last FADE_OUT of its life. */
  function envelopeOf(raft: MutableRaft): number {
    let e = raft.age < FADE_IN ? raft.age / FADE_IN : 1;
    if (raft.life < FADE_OUT) {
      const out = raft.life / FADE_OUT;
      if (out < e) e = out;
    }
    return clamp01(e);
  }

  function update(
    dt: number,
    ship: ShipState,
    wind: WindState,
    suppressed: boolean,
    weather?: WeatherState,
  ): void {
    // A frame that advanced no time floats no salvage. Returning leaves the
    // last true state standing rather than rewriting it with a stale zero.
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    rollTimer += dt;
    while (rollTimer >= ROLL_PERIOD) {
      rollTimer -= ROLL_PERIOD;
      roll(ship, suppressed, weather);
    }

    for (let i = state.live.length - 1; i >= 0; i--) {
      const raft = state.live[i];
      raft.age += dt;
      raft.life -= dt;
      if (raft.life <= 0) {
        state.live.splice(i, 1);
        continue;
      }

      drift(raft, wind, dt);

      // Driven onto a beach, or into water the player could never sail to, and
      // it is gone that frame: the rule the crests and the raiders both keep.
      if (!sailable(raft.position)) {
        state.live.splice(i, 1);
        continue;
      }

      raft.envelope = envelopeOf(raft);
    }

    // ---- Taking -------------------------------------------------------
    // Last, so a raft that has drifted onto the hull this frame is taken this
    // frame. Removed from `live` BEFORE the callback: `main.ts` raises a
    // notice from in there, and a raft still listed would be drawn for one
    // more frame under the words saying it had been recovered.
    if (suppressed) return;
    for (let i = state.live.length - 1; i >= 0; i--) {
      const raft = state.live[i];
      if (arcDistance(ship.position, raft.position) >= TAKE_RADIUS) continue;
      state.live.splice(i, 1);
      onTake(raft as SalvageRaft);
    }
  }

  function force(position: Vector3): void {
    build(position);
  }

  return { state: state as SalvageState, update, force };
}
