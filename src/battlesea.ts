import type { ArenaCrest, ArenaFlotsam, ArenaObstacle, BattleEvent, BattleOptions } from './types';
import { ARENA_R0, HIT_RADIUS } from './battleconstants';

/**
 * battlesea.ts — the sea the fight is fought on, and the things floating in it.
 *
 * Three systems, seeded from the sim's own `rng` and switched independently
 * by `BattleOptions`, per docs/BATTLE_REWORK_PLAN.md decisions 5, 6 and 7:
 *
 * - **Crests.** One at a time, a line perpendicular to one of the four
 *   cardinal directions, born off one edge of the arena and swept across it.
 *   Passing a hull's TRACK shoves that hull along the crest's own travel
 *   direction, as a closed-form pulse that peaks and dies on its own — there
 *   is nothing here to integrate and nothing that can go unstable at a capped
 *   `dt`. Sway is then clamped so no hull's centre ever comes nearer the
 *   arena centre than `KEEL_CLEARANCE`, which is what keeps a shoved hull off
 *   the shoals without inventing a fourth way to lose.
 * - **Shoals and wreckage.** One to three, rolled once in the constructor so
 *   the scene can place them on its first frame, standing inside the ring at
 *   every radius the ring ever has. No hull ever meets one; they block firing
 *   lines instead.
 * - **Flotsam.** One raft at a time, drifting across the arena on a straight
 *   line. A hull that runs into it is fouled: half speed and no guns for
 *   `FOUL_SECONDS`. A ball put into it sinks it.
 *
 * Everything rolls from the `rng` it is handed and nothing else, so two sims
 * built from one seed and driven by one input agree to the last bit. An
 * option that is off never draws from `rng` for its own system and never
 * populates its own piece of `state`: a calm sea and a gunner measured on one
 * cannot see each other by so much as one consumed random number.
 */

/**
 * What the sea needs of a combatant: where its track is, and the three fields
 * it writes.
 *
 * Structural on purpose. `battle.ts`'s own mutable combatant satisfies this
 * without either module exporting a type for the other, and the sea can
 * therefore never reach a field it has no business writing.
 */
export interface SwayTarget {
  readonly angle: number;
  swayX: number;
  swayZ: number;
  fouled: number;
  cooldown: number;
}

/** The sea as `BattleState` exposes it: the same objects, read-only. */
export interface BattleSeaState {
  readonly crest: ArenaCrest | null;
  readonly obstacles: readonly ArenaObstacle[];
  readonly flotsam: ArenaFlotsam | null;
}

export interface BattleSea {
  readonly state: BattleSeaState;
  /**
   * One tick of the sea: write both hulls' sway, count their fouling down,
   * move the crest and the raft, launch new ones, and push any `foul` events
   * onto the list `battle.ts` is building for this tick.
   */
  update(
    dt: number,
    elapsed: number,
    radius: number,
    player: SwayTarget,
    ai: SwayTarget,
    events: BattleEvent[],
  ): void;
  /**
   * Where the sweep (ax,az)-(bx,bz) first meets an obstacle or the raft, or
   * null if it meets neither. Meeting the raft sinks it.
   */
  strike(ax: number, az: number, bx: number, bz: number): { x: number; z: number } | null;
}

/** Every system off. The sea a gunner is measured on, and what `?calm=1` asks for. */
export const CALM: BattleOptions = { waves: false, shoals: false, flotsam: false };

/** Every system on. The sea the game is played on. */
export const ROUGH: BattleOptions = { waves: true, shoals: true, flotsam: true };

const TWO_PI = Math.PI * 2;

/**
 * The unit vector a crest of this axis travels — and therefore shoves — in.
 * Pinned by `ArenaCrest`'s own doc comment: north is +z, south is -z, east
 * is +x, west is -x. Agent C draws the crest quad from the same words, so
 * this table may not quietly disagree with them.
 */
const AXIS_VECTOR: Record<ArenaCrest['axis'], { readonly x: number; readonly z: number }> = {
  north: { x: 0, z: 1 },
  south: { x: 0, z: -1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
};
const AXES: readonly ArenaCrest['axis'][] = ['north', 'south', 'east', 'west'];

/* ------------------------------------------------------------------ */
/* Crests                                                              */
/* ------------------------------------------------------------------ */

/**
 * How fast a crest travels, and how far outside `ARENA_R0` it is born and
 * dies, arena units and units/s.
 *
 * Seven units a second crosses the forty-unit diameter in about six seconds,
 * which is long enough to be seen coming and short enough that the arena is
 * rarely without one for long. The margin is what lets a crest be born and
 * die off-screen rather than snapping into existence on the ring's own edge.
 */
export const CREST_SPEED = 7;
export const CREST_MARGIN = 8;

/**
 * Seconds before the first crest, and seconds from one crest's end to the
 * next's start.
 *
 * The first is short so a fight is rarely more than ten seconds old before
 * the sea introduces itself. The gap is longer than a crest's own crossing
 * (about eight seconds, margin included) so the arena is genuinely calm
 * between them rather than holding one nose to tail with the last.
 */
export const CREST_FIRST_MIN = 6;
export const CREST_FIRST_MAX = 10;
export const CREST_GAP_MIN = 9;
export const CREST_GAP_MAX = 15;

/**
 * The shove a crest deals a hull it passes, arena units: rolled once per
 * hull per crest, independently, so the two boats are not always thrown the
 * same distance by the same wave.
 */
export const SWAY_MIN = 2;
export const SWAY_MAX = 6;

/**
 * Seconds to the peak of a shove's pulse.
 *
 * `sway(t) = A * (t / SWAY_TAU) * exp(1 - t / SWAY_TAU)` is zero at `t = 0`,
 * exactly `A` at `t = SWAY_TAU`, and under 5% of `A` by `t = 4 * SWAY_TAU` —
 * a closed form chosen so there is no spring to integrate and nothing that
 * can go unstable when `dt` is capped at 0.1. `SWAY_DECAY_HORIZON` is that
 * four-tau point, past which a pulse is treated as dead and dropped rather
 * than carried forever for a contribution too small to matter.
 */
export const SWAY_TAU = 0.8;
const SWAY_DECAY_HORIZON = 4 * SWAY_TAU;

/* ------------------------------------------------------------------ */
/* Shoals and wreckage                                                 */
/* ------------------------------------------------------------------ */

/**
 * How many obstacles a fight rolls, min and max inclusive.
 *
 * One is enough to give a fight a single blind spot; three is enough that a
 * hull working the throttle has to actually think about where it is rather
 * than simply noting that "something" is in the water somewhere.
 */
export const OBSTACLE_COUNT_MIN = 1;
export const OBSTACLE_COUNT_MAX = 3;

/**
 * Where an obstacle's centre may land, distance from the arena centre.
 *
 * Both bounds sit well inside `ARENA_R_MIN` (8) even once `OBSTACLE_R_MAX`
 * is added on: an obstacle at the far edge of `OBSTACLE_ZONE` with the
 * largest radius reaches out to 5.5, and the ring never closes tighter than
 * 8. No hull ever meets one on its track; what they block is the diameters
 * fired across the middle of the ring.
 */
export const OBSTACLE_R_INNER = 2;
export const OBSTACLE_ZONE = 4;

/** An obstacle's own radius, arena units. */
export const OBSTACLE_R_MIN = 1.0;
export const OBSTACLE_R_MAX = 1.5;

/**
 * Placement attempts per obstacle before giving up on that one and moving on
 * with fewer than rolled, the way `hazards.ts`'s `trySpawn` gives up on a
 * hazard rather than looping forever. Twenty is generous for a handful of
 * small circles in a four-unit-deep ring; the rare fight that cannot fit all
 * three simply has a slightly emptier arena.
 */
const OBSTACLE_TRIES = 20;

/**
 * How close a hull's centre may ever come to the arena's, arena units.
 *
 * `OBSTACLE_ZONE + OBSTACLE_R_MAX + HIT_RADIUS`: an obstacle's outer edge,
 * plus half a hull. Clamping sway to keep a hull's distance from the centre
 * at or above this is what keeps a shoved hull off the shoals without a
 * grounding rule of its own — the ring's own `ARENA_R_MIN` (8) already
 * leaves a shove of under a unit's room to push inward here, which is the
 * accepted price of not inventing a fourth way to lose the fight.
 */
export const KEEL_CLEARANCE = OBSTACLE_ZONE + OBSTACLE_R_MAX + HIT_RADIUS;

/* ------------------------------------------------------------------ */
/* Flotsam                                                             */
/* ------------------------------------------------------------------ */

/** Units/s. About sixteen seconds to cross the diameter, twenty or so on a track angled off it. */
export const FLOTSAM_SPEED = 2.5;

/** The raft's own radius, arena units. Contact with a hull is this plus `HIT_RADIUS`. */
export const FLOTSAM_RADIUS = 1.2;

/** How far outside `ARENA_R0` a raft is born and dies, arena units. */
export const FLOTSAM_MARGIN = 6;

/**
 * How close to the arena centre a raft's straight-line track is aimed,
 * arena units — 90% of `ARENA_R0`, so it always crosses the ring rather than
 * grazing past outside it, however far off-centre the aim point lands.
 */
export const FLOTSAM_AIM = 0.9 * ARENA_R0;

/** Seconds before the first raft, and from one raft's end to the next's start. */
export const FLOTSAM_FIRST_MIN = 4;
export const FLOTSAM_FIRST_MAX = 8;
export const FLOTSAM_GAP_MIN = 14;
export const FLOTSAM_GAP_MAX = 22;

/** Seconds a fouled hull runs at half its angular speed with its guns silent. */
export const FOUL_SECONDS = 2;

/* ------------------------------------------------------------------ */
/* Geometry helpers — no rng, no state                                 */
/* ------------------------------------------------------------------ */

/** A hull's TRACK coordinate along a crest's own travel axis: the projection of its point on the circle onto that direction. */
function trackAlong(radius: number, angle: number, axis: ArenaCrest['axis']): number {
  const v = AXIS_VECTOR[axis];
  return radius * Math.cos(angle) * v.x + radius * Math.sin(angle) * v.z;
}

/**
 * Where the segment (ax,az)-(bx,bz) first enters the circle at (cx,cz) of
 * radius `r`, as a fraction of the segment in [0, 1], or null if it never
 * does. If the start point is already inside (or on) the circle, that is the
 * first meeting, at `t = 0` — a ball rarely starts inside an obstacle, but a
 * raft can wander close enough to a hull's last position that it matters.
 *
 * Solving `|A + t*(B-A) - C|^2 = r^2` for `t` and taking the smaller root:
 * with the start outside the circle, both roots share a sign (their product
 * is `c/a` with `c > 0`), so a negative smaller root means the circle is
 * wholly behind the segment's direction of travel and there is nothing to
 * report.
 */
function segmentCircleEntry(
  ax: number, az: number, bx: number, bz: number, cx: number, cz: number, r: number,
): number | null {
  const dx = bx - ax;
  const dz = bz - az;
  const fx = ax - cx;
  const fz = az - cz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dz * dz;
  if (a < 1e-12) return null;
  const b = 2 * (fx * dx + fz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

/** One hull's active shove, or nothing. A closed form needs no per-frame integration to hold. */
interface SwayPulse {
  /** Start a fresh pulse, replacing whatever was running outright. */
  trigger(axis: ArenaCrest['axis'], amplitude: number, at: number): void;
  /** This tick's displacement, arena units, in world (x, z). */
  advance(elapsed: number): { x: number; z: number };
}

function createSwayPulse(): SwayPulse {
  let axis: ArenaCrest['axis'] | null = null;
  let amplitude = 0;
  let start = 0;
  return {
    trigger(a, amp, at) {
      axis = a;
      amplitude = amp;
      start = at;
    },
    advance(elapsed) {
      if (axis === null) return { x: 0, z: 0 };
      const t = elapsed - start;
      if (t > SWAY_DECAY_HORIZON) {
        axis = null;
        return { x: 0, z: 0 };
      }
      const raw = amplitude * (t / SWAY_TAU) * Math.exp(1 - t / SWAY_TAU);
      const v = AXIS_VECTOR[axis];
      return { x: raw * v.x, z: raw * v.z };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Internal, mutable mirrors of the read-only public surfaces          */
/* ------------------------------------------------------------------ */

/**
 * `ArenaCrest` plus the bookkeeping that never leaves this module: which
 * hulls it has already shoved. A crest may pass each hull at most once —
 * `at` only ever increases, so nothing but this flag is needed to stop a
 * hull that happens to sit still from being hit twice by one wave.
 */
interface MutableCrest {
  axis: ArenaCrest['axis'];
  at: number;
  hitPlayer: boolean;
  hitAi: boolean;
}

/** `ArenaFlotsam` plus whether it has already passed the centre, on the loan of the ball's own `crossed` idea in `battle.ts`. */
interface MutableFlotsam {
  x: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
  crossed: boolean;
}

interface MutableSeaState {
  crest: MutableCrest | null;
  obstacles: ArenaObstacle[];
  flotsam: MutableFlotsam | null;
}

/* ------------------------------------------------------------------ */
/* The sea                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param rng the sim's own seeded source.
 * @param options which of the three systems run. An option that is off
 *   produces nothing at all: no crest, no obstacles, no raft, and a `strike`
 *   that is always null.
 */
export function createBattleSea(
  rng: () => number = Math.random,
  options: BattleOptions = ROUGH,
): BattleSea {
  const wavesOn = options.waves;
  const flotsamOn = options.flotsam;

  /**
   * Every draw below happens only for the system it belongs to, and in a
   * fixed order — the crest's first delay, then the obstacles, then the
   * raft's first delay — matching `BattleOptions`'s own field order. A
   * system that is off never touches `rng` at all, which is what lets a calm
   * sea and a rough one built from the same seed disagree only about the
   * three things that were actually switched.
   */
  let crestTimer = wavesOn ? CREST_FIRST_MIN + rng() * (CREST_FIRST_MAX - CREST_FIRST_MIN) : 0;
  const obstacles: ArenaObstacle[] = options.shoals ? rollObstacles() : [];
  let flotsamTimer = flotsamOn
    ? FLOTSAM_FIRST_MIN + rng() * (FLOTSAM_FIRST_MAX - FLOTSAM_FIRST_MIN)
    : 0;

  const state: MutableSeaState = { crest: null, obstacles, flotsam: null };
  const playerPulse = createSwayPulse();
  const aiPulse = createSwayPulse();

  /** One to three non-overlapping circles between `OBSTACLE_R_INNER` and `OBSTACLE_ZONE` of the centre. */
  function rollObstacles(): ArenaObstacle[] {
    const count =
      OBSTACLE_COUNT_MIN + Math.floor(rng() * (OBSTACLE_COUNT_MAX - OBSTACLE_COUNT_MIN + 1));
    const list: ArenaObstacle[] = [];
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < OBSTACLE_TRIES; attempt++) {
        const kind: ArenaObstacle['kind'] = rng() < 0.5 ? 'shoal' : 'wreck';
        const radius = OBSTACLE_R_MIN + rng() * (OBSTACLE_R_MAX - OBSTACLE_R_MIN);
        const dist = OBSTACLE_R_INNER + rng() * (OBSTACLE_ZONE - OBSTACLE_R_INNER);
        const bearing = rng() * TWO_PI;
        const yaw = rng() * TWO_PI;
        const x = Math.cos(bearing) * dist;
        const z = Math.sin(bearing) * dist;
        let overlaps = false;
        for (const o of list) {
          if (Math.hypot(x - o.x, z - o.z) < radius + o.radius) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) {
          list.push({ kind, x, z, radius, yaw });
          break;
        }
      }
    }
    return list;
  }

  /** A fresh raft: born just outside the ring, aimed to cross near the centre. */
  function launchFlotsam(): MutableFlotsam {
    const startDist = ARENA_R0 + FLOTSAM_MARGIN;
    const startBearing = rng() * TWO_PI;
    const x = Math.cos(startBearing) * startDist;
    const z = Math.sin(startBearing) * startDist;
    const aimBearing = rng() * TWO_PI;
    const aimDist = rng() * FLOTSAM_AIM;
    const aimX = Math.cos(aimBearing) * aimDist;
    const aimZ = Math.sin(aimBearing) * aimDist;
    const dx = aimX - x;
    const dz = aimZ - z;
    const len = Math.hypot(dx, dz) || 1;
    return {
      x,
      z,
      vx: (dx / len) * FLOTSAM_SPEED,
      vz: (dz / len) * FLOTSAM_SPEED,
      radius: FLOTSAM_RADIUS,
      crossed: false,
    };
  }

  /** Keep a hull's actual distance from the arena centre at or above `KEEL_CLEARANCE`, adjusting its sway alone. */
  function clampKeel(target: SwayTarget, radius: number): void {
    const trackX = radius * Math.cos(target.angle);
    const trackZ = radius * Math.sin(target.angle);
    const posX = trackX + target.swayX;
    const posZ = trackZ + target.swayZ;
    const dist = Math.hypot(posX, posZ);
    // `dist` is never meaningfully zero: the track alone is never inside
    // ARENA_R_MIN (8) and one pulse's peak is capped at SWAY_MAX (6), so the
    // worst case is a hull's own opening radius less its own worst shove —
    // still short of the centre. The guard is only for a caller handing in a
    // radius this module was never meant to see.
    if (dist < KEEL_CLEARANCE && dist > 1e-9) {
      const scale = KEEL_CLEARANCE / dist;
      target.swayX = posX * scale - trackX;
      target.swayZ = posZ * scale - trackZ;
    }
  }

  /** A hull whose actual position has come within reach of the raft: foul it and remove the raft. */
  function checkFoul(
    target: SwayTarget,
    radius: number,
    owner: 'player' | 'ai',
    events: BattleEvent[],
  ): void {
    const f = state.flotsam;
    if (f === null) return;
    const posX = radius * Math.cos(target.angle) + target.swayX;
    const posZ = radius * Math.sin(target.angle) + target.swayZ;
    const reach = f.radius + HIT_RADIUS;
    if ((posX - f.x) * (posX - f.x) + (posZ - f.z) * (posZ - f.z) < reach * reach) {
      target.fouled = FOUL_SECONDS;
      target.cooldown = FOUL_SECONDS;
      events.push({ kind: 'foul', owner, x: posX, z: posZ });
      state.flotsam = null;
      flotsamTimer = FLOTSAM_GAP_MIN + rng() * (FLOTSAM_GAP_MAX - FLOTSAM_GAP_MIN);
    }
  }

  function update(
    dt: number,
    elapsed: number,
    radius: number,
    player: SwayTarget,
    ai: SwayTarget,
    events: BattleEvent[],
  ): void {
    // ---- Crests: launch, travel, shove, drop -------------------------
    if (wavesOn) {
      if (state.crest === null) {
        crestTimer -= dt;
        if (crestTimer <= 0) {
          const axis = AXES[Math.floor(rng() * AXES.length)];
          state.crest = { axis, at: -(ARENA_R0 + CREST_MARGIN), hitPlayer: false, hitAi: false };
        }
      } else {
        const c = state.crest;
        const prevAt = c.at;
        c.at += CREST_SPEED * dt;

        if (!c.hitPlayer) {
          const track = trackAlong(radius, player.angle, c.axis);
          if (prevAt < track && c.at >= track) {
            playerPulse.trigger(c.axis, SWAY_MIN + rng() * (SWAY_MAX - SWAY_MIN), elapsed);
            c.hitPlayer = true;
          }
        }
        if (!c.hitAi) {
          const track = trackAlong(radius, ai.angle, c.axis);
          if (prevAt < track && c.at >= track) {
            aiPulse.trigger(c.axis, SWAY_MIN + rng() * (SWAY_MAX - SWAY_MIN), elapsed);
            c.hitAi = true;
          }
        }

        if (c.at > ARENA_R0 + CREST_MARGIN) {
          state.crest = null;
          crestTimer = CREST_GAP_MIN + rng() * (CREST_GAP_MAX - CREST_GAP_MIN);
        }
      }

      const pv = playerPulse.advance(elapsed);
      player.swayX = pv.x;
      player.swayZ = pv.z;
      const av = aiPulse.advance(elapsed);
      ai.swayX = av.x;
      ai.swayZ = av.z;
    }

    // ---- Keel clearance, on whatever sway is now standing ------------
    clampKeel(player, radius);
    clampKeel(ai, radius);

    // ---- Fouling counts down regardless of who set it ----------------
    player.fouled = Math.max(0, player.fouled - dt);
    ai.fouled = Math.max(0, ai.fouled - dt);

    // ---- Flotsam: launch, drift, drop, foul --------------------------
    if (flotsamOn) {
      if (state.flotsam === null) {
        flotsamTimer -= dt;
        if (flotsamTimer <= 0) state.flotsam = launchFlotsam();
      } else {
        const f = state.flotsam;
        f.x += f.vx * dt;
        f.z += f.vz * dt;
        if (!f.crossed && f.x * f.vx + f.z * f.vz > 0) f.crossed = true;
        if (f.crossed && Math.hypot(f.x, f.z) > ARENA_R0 + FLOTSAM_MARGIN) {
          state.flotsam = null;
          flotsamTimer = FLOTSAM_GAP_MIN + rng() * (FLOTSAM_GAP_MAX - FLOTSAM_GAP_MIN);
        }
      }
      // The raft is removed the instant it fouls someone, so the second hull
      // is only ever checked if the first check left it standing.
      checkFoul(player, radius, 'player', events);
      checkFoul(ai, radius, 'ai', events);
    }
  }

  function strike(ax: number, az: number, bx: number, bz: number): { x: number; z: number } | null {
    let bestT = Infinity;
    let sinksFlotsam = false;

    for (const o of state.obstacles) {
      const t = segmentCircleEntry(ax, az, bx, bz, o.x, o.z, o.radius);
      if (t !== null && t < bestT) {
        bestT = t;
        sinksFlotsam = false;
      }
    }
    const f = state.flotsam;
    if (f !== null) {
      const t = segmentCircleEntry(ax, az, bx, bz, f.x, f.z, f.radius);
      if (t !== null && t < bestT) {
        bestT = t;
        sinksFlotsam = true;
      }
    }
    if (bestT === Infinity) return null;

    const point = { x: ax + (bx - ax) * bestT, z: az + (bz - az) * bestT };
    if (sinksFlotsam) {
      state.flotsam = null;
      flotsamTimer = FLOTSAM_GAP_MIN + rng() * (FLOTSAM_GAP_MAX - FLOTSAM_GAP_MIN);
    }
    return point;
  }

  return { state: state as BattleSeaState, update, strike };
}
