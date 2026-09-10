import type { ArenaCrest, ArenaFlotsam, BattleEvent, BattleOptions } from './types';
import { ARENA_R0, ARENA_R_MIN, HIT_RADIUS } from './battleconstants';

/**
 * battlesea.ts — the sea the fight is fought on, and the things floating in it.
 *
 * Two systems, seeded from the sim's own `rng` and switched independently by
 * `BattleOptions`, per docs/BATTLE_REWORK_PLAN.md decisions 5 and 7:
 *
 * - **Crests.** Up to `CREST_MAX` at once, each a SEGMENT of a line
 *   perpendicular to one of the four cardinal directions, born off one edge
 *   of the arena and swept across it at its own rolled speed. Passing a
 *   hull's TRACK — and only while that track falls inside the crest's own
 *   length — shoves that hull along the crest's travel direction, as a
 *   closed-form pulse that peaks and dies on its own. There is nothing here
 *   to integrate and nothing that can go unstable at a capped `dt`. Sway is
 *   then clamped so no hull's centre ever comes nearer the arena centre than
 *   `KEEL_CLEARANCE`.
 * - **Flotsam.** Three to six rafts adrift at once, each with its own size
 *   and its own speed, drifting across the arena on straight lines. A hull
 *   that runs into one is fouled: half speed and no guns for `FOUL_SECONDS`.
 *   A ball put into one sinks it.
 *
 * There was a third — shoals and wreckage, rolled once and standing still
 * inside the ring. It is gone, and the rafts took over its job of blocking a
 * firing line. A blind spot that never moves is learned once and then costs
 * nothing to respect; one that drifts has to be read again every few seconds,
 * which is the same reason the crests were made finite and given speeds of
 * their own.
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
  readonly crests: readonly ArenaCrest[];
  readonly flotsam: readonly ArenaFlotsam[];
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
   * Where the sweep (ax,az)-(bx,bz) first meets a raft, or null if it meets
   * none. The raft it meets is sunk.
   */
  strike(ax: number, az: number, bx: number, bz: number): { x: number; z: number } | null;
  /** Shove one hull along `(x, z)`. See the implementation for the contract. */
  shove(
    which: 'player' | 'ai',
    x: number,
    z: number,
    amplitude: number,
    elapsed: number,
  ): void;
}

/** Every system off. The sea a gunner is measured on, and what `?calm=1` asks for. */
export const CALM: BattleOptions = { waves: false, flotsam: false };

/**
 * Rafts, but no crests of the arena's own.
 *
 * What a fight in the live world is built with. The sea under the ring is the
 * game's own now, so a second set of flat crest meshes drawn across it would
 * be two seas disagreeing inside the same twenty metres -- and the shove that
 * matters comes from the REAL waves instead, through `shove`. The flotsam
 * stays: it is debris in the water rather than a claim about what the water
 * is doing, and it is what the withdrawn shoals were replaced by.
 */
export const LIVE: BattleOptions = { waves: false, flotsam: true };

/** Every system on. The sea the ARENA was played on. */
export const ROUGH: BattleOptions = { waves: true, flotsam: true };

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

/**
 * The unit vector ALONG a crest of this axis — the direction its own line
 * runs, which is where `length` and `offset` are measured.
 *
 * `(travel.z, -travel.x)`: the travel vector turned a quarter turn. Which of
 * the two perpendiculars it is does not matter to the sim, since a segment is
 * symmetric about its middle and `offset` is signed either way; it matters
 * only that `battlescene.ts` turns the mesh onto the SAME one, which is why
 * `ArenaCrest`'s doc comment writes this formula out.
 */
const ALONG_VECTOR: Record<ArenaCrest['axis'], { readonly x: number; readonly z: number }> = {
  north: { x: 1, z: 0 },
  south: { x: -1, z: 0 },
  east: { x: 0, z: -1 },
  west: { x: 0, z: 1 },
};

/* ------------------------------------------------------------------ */
/* Crests                                                              */
/* ------------------------------------------------------------------ */

/**
 * How many crests may be running at once.
 *
 * Three, and the number matters more than it looks: with one full-width wave
 * the only question was when it arrived, because there was nowhere on the
 * ring it did not reach. Three short ones arriving from three directions at
 * three speeds are a sea to be read rather than a metronome to be counted,
 * and the throttle is what answers them.
 */
export const CREST_MAX = 3;

/**
 * How fast a crest travels, arena units per second -- which is knots, on the
 * same one-to-one the HUD prints the ship's own speed at.
 *
 * Rolled per crest rather than shared, so the arena is never a set of
 * parallel lines moving in step. Three knots crosses the ring in about
 * eighteen seconds and is a swell to be timed; ten crosses it in five and a
 * half and is a thing to be got out of the way of. The old single figure was
 * seven, which is now simply the middle of the band.
 */
export const CREST_SPEED_MIN = 3;
export const CREST_SPEED_MAX = 10;

/** How far outside `ARENA_R0` a crest is born and dies, arena units. */
export const CREST_MARGIN = 8;

/**
 * A crest's own length, as a fraction of the arena's full width.
 *
 * A fifth of the arena is about two and a half hull lengths: short enough
 * that a hull on the far side of the ring watches it go by, which is what
 * makes three of them a sea with gaps in it rather than three walls. A full
 * one still spans the ring end to end and cannot be dodged at all -- the old
 * behaviour, kept as the top of the range rather than as the only case.
 */
export const CREST_FULL_LENGTH = 2 * ARENA_R0;
export const CREST_LENGTH_MIN_FRAC = 0.2;
export const CREST_LENGTH_MAX_FRAC = 1;

/**
 * Seconds before the first crest, and between launches after it.
 *
 * Both are far shorter than the single-crest version's (6-10 and 9-15),
 * because they no longer mean the same thing: this is the gap between one
 * wave STARTING and the next starting, with up to `CREST_MAX` alive at once,
 * not the calm between one ending and the next beginning. At these gaps and
 * these speeds the arena usually carries two or three, and the ceiling rather
 * than the timer is what caps it. The clock only runs while there is room, so
 * a full arena is never quietly banking launches to dump the moment one crest
 * dies.
 */
export const CREST_FIRST_MIN = 2;
export const CREST_FIRST_MAX = 5;
export const CREST_GAP_MIN = 3;
export const CREST_GAP_MAX = 7;

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

/**
 * How close a hull's centre may ever come to the arena's, arena units.
 *
 * It used to be read off the shoals -- an obstacle's outer edge plus half a
 * hull -- and with the shoals gone it is stated directly instead, at the same
 * 7.1 it has always been. What it means has not changed, only what it is
 * derived from: a shove may take a hull at most `KEEL_MARGIN` inside the
 * tightest ring the fight ever has, and no further. Without it a wave could
 * throw a hull across the middle of its own circle, which reads as the hull
 * glitching rather than as the sea working.
 *
 * `ARENA_R_MIN` is the ring at its tightest, so this is the worst case by
 * construction: at any wider radius the clamp has more room, not less.
 */
export const KEEL_MARGIN = 0.9;
export const KEEL_CLEARANCE = ARENA_R_MIN - KEEL_MARGIN;

/* ------------------------------------------------------------------ */
/* Flotsam                                                             */
/* ------------------------------------------------------------------ */

/**
 * How many rafts are adrift at once, min and max inclusive.
 *
 * Rolled once per fight and then held: as one is sunk, fouled on, or carried
 * out the far side, another is launched to take its place after its own short
 * gap. Three is a debris field rather than an event; six is a fight where
 * there is always something in the water worth looking at. This is what
 * replaced the shoals, and it replaces them with interest -- what was one to
 * three fixed circles is now three to six moving ones.
 */
export const FLOTSAM_COUNT_MIN = 3;
export const FLOTSAM_COUNT_MAX = 6;

/**
 * A raft's speed, units/s, rolled per raft.
 *
 * The old single figure was 2.5, which crossed the arena in about twenty
 * seconds. The band straddles it: at 1.5 a raft is very nearly a fixed
 * obstacle for the length of a fight, which is the shoals' old job done by
 * something that still has to be watched, and at 4.5 it crosses in eleven and
 * has to be led like anything else that moves.
 */
export const FLOTSAM_SPEED_MIN = 1.5;
export const FLOTSAM_SPEED_MAX = 4.5;

/**
 * A raft's own radius, arena units, rolled per raft. Contact with a hull is
 * this plus `HIT_RADIUS`.
 *
 * Around the old flat 1.2, spread either side of it. The small ones are easy
 * to miss and easy to shoot; the big ones are most of a hull length across
 * and block a firing line the way a wreck used to.
 */
export const FLOTSAM_R_MIN = 0.8;
export const FLOTSAM_R_MAX = 2;

/** How far outside `ARENA_R0` a raft is born and dies, arena units. */
export const FLOTSAM_MARGIN = 6;

/**
 * How close to the arena centre a raft's straight-line track is aimed,
 * arena units — 90% of `ARENA_R0`, so it always crosses the ring rather than
 * grazing past outside it, however far off-centre the aim point lands.
 */
export const FLOTSAM_AIM = 0.9 * ARENA_R0;

/**
 * Seconds from one raft's end to a replacement's launch.
 *
 * There is no first-raft delay any more: the fleet is on the water from the
 * first frame, because a rolled count of five that only reaches five after a
 * minute of fighting is not a count of five. They are given staggered head
 * starts along their own tracks instead -- see `launchFlotsam` -- so the
 * arena opens with rafts spread across it rather than with a line of them
 * arriving off one edge together.
 *
 * The gap is short on purpose, and much shorter than the old 14-22: it has to
 * be read against a raft's own crossing time, which is eleven seconds for the
 * quickest and thirty-five for the slowest. Replace them more slowly than
 * that and the count is a ceiling the fight never actually reaches -- a fleet
 * rolled at six settles at three and the roll stops meaning anything. At one
 * to three seconds the losses are made good faster than they happen, so the
 * COUNT is what caps the fleet, which is the number the fight was rolled on.
 */
export const FLOTSAM_GAP_MIN = 1;
export const FLOTSAM_GAP_MAX = 3;

/**
 * How far along its own track a raft may be born already, arena units.
 *
 * Used only for the opening fleet, and capped at the ring's own radius plus
 * the margin, so the furthest-advanced raft starts around the middle of its
 * run and none can be born already past the far side and instantly lost.
 */
const FLOTSAM_HEAD_START = ARENA_R0 + FLOTSAM_MARGIN;

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
 * The same projection onto the crest's own LINE: where a hull sits across the
 * wave rather than in front of or behind it.
 *
 * This is the coordinate `length` and `offset` are measured in, and it is
 * what makes a short crest short. A hull whose across-coordinate falls
 * outside the segment watches the wave go past without being touched by it --
 * which the old full-width crest gave nobody the option of.
 */
function trackAcross(radius: number, angle: number, axis: ArenaCrest['axis']): number {
  const v = ALONG_VECTOR[axis];
  return radius * Math.cos(angle) * v.x + radius * Math.sin(angle) * v.z;
}

/** Whether `across` falls within a crest of this length centred on `offset`. */
function underCrest(across: number, crest: { length: number; offset: number }): boolean {
  return Math.abs(across - crest.offset) <= crest.length / 2;
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
  /** The same, along any direction in the arena plane. Need not be unit. */
  triggerAlong(x: number, z: number, amplitude: number, at: number): void;
  /** This tick's displacement, arena units, in world (x, z). */
  advance(elapsed: number): { x: number; z: number };
}

function createSwayPulse(): SwayPulse {
  /*
   * A DIRECTION rather than one of the four named axes, which is the one
   * change that lets the open sea shove a hull in here.
   *
   * The arena's own crests only ever ran along the compass points, so an
   * axis name was the whole of what a pulse needed. A crest raised by
   * `hazards.ts` runs wherever the wind put it, and rounding that to the
   * nearest cardinal would turn a wave the player can watch coming into a
   * shove from somewhere adjacent to where it came from. `trigger` still
   * takes the name and converts, so nothing that used to call it changed.
   */
  let dirX = 0;
  let dirZ = 0;
  let live = false;
  let amplitude = 0;
  let start = 0;
  return {
    trigger(a, amp, at) {
      const v = AXIS_VECTOR[a];
      this.triggerAlong(v.x, v.z, amp, at);
    },
    triggerAlong(x, z, amp, at) {
      const len = Math.hypot(x, z);
      if (len < 1e-6) return;
      dirX = x / len;
      dirZ = z / len;
      live = true;
      amplitude = amp;
      start = at;
    },
    advance(elapsed) {
      if (!live) return { x: 0, z: 0 };
      const t = elapsed - start;
      if (t > SWAY_DECAY_HORIZON) {
        live = false;
        return { x: 0, z: 0 };
      }
      const raw = amplitude * (t / SWAY_TAU) * Math.exp(1 - t / SWAY_TAU);
      return { x: raw * dirX, z: raw * dirZ };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Internal, mutable mirrors of the read-only public surfaces          */
/* ------------------------------------------------------------------ */

/**
 * `ArenaCrest` plus the bookkeeping that never leaves this module: which
 * hulls it has already passed.
 *
 * A crest may pass each hull at most once. `at` only ever increases, but a
 * hull's own track coordinate does not -- it is going round a circle -- so
 * without these flags a hull sailing back across a crest's line would be
 * shoved by the same wave twice.
 *
 * The flag is set by the PASSING and not by the shoving. A hull the crest
 * swept past while it sat outside the segment's ends has been passed, and is
 * marked so, even though it was never touched: the wave is behind it now, and
 * a second chance at it would be the sea reaching backwards.
 */
interface MutableCrest {
  axis: ArenaCrest['axis'];
  at: number;
  length: number;
  offset: number;
  speed: number;
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
  crests: MutableCrest[];
  flotsam: MutableFlotsam[];
}

/* ------------------------------------------------------------------ */
/* The sea                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param rng the sim's own seeded source.
 * @param options which of the two systems run. An option that is off produces
 *   nothing at all: no crests, no rafts, and a `strike` that is always null.
 */
export function createBattleSea(
  rng: () => number = Math.random,
  options: BattleOptions = ROUGH,
): BattleSea {
  const wavesOn = options.waves;
  const flotsamOn = options.flotsam;

  /**
   * Every draw below happens only for the system it belongs to, and in a
   * fixed order -- the crest's first delay, then the raft count, then one
   * raft's worth of draws for each of them -- matching `BattleOptions`'s own
   * field order. A system that is off never touches `rng` at all, which is
   * what lets a calm sea and a rough one built from the same seed disagree
   * only about the things that were actually switched.
   */
  let crestTimer = wavesOn ? CREST_FIRST_MIN + rng() * (CREST_FIRST_MAX - CREST_FIRST_MIN) : 0;

  /**
   * How many rafts this fight keeps on the water. Rolled once and then held:
   * `update` launches a replacement whenever the fleet is short of it.
   */
  const flotsamTarget = flotsamOn
    ? FLOTSAM_COUNT_MIN + Math.floor(rng() * (FLOTSAM_COUNT_MAX - FLOTSAM_COUNT_MIN + 1))
    : 0;
  let flotsamTimer = 0;

  const state: MutableSeaState = { crests: [], flotsam: [] };
  const playerPulse = createSwayPulse();
  const aiPulse = createSwayPulse();

  // The opening fleet, each raft already some way along its own track. See
  // FLOTSAM_HEAD_START: launched cold they would arrive as a line off one
  // edge, which is a wave of debris rather than a sea with debris in it.
  for (let i = 0; i < flotsamTarget; i++) {
    state.flotsam.push(launchFlotsam(rng() * FLOTSAM_HEAD_START));
  }

  /**
   * A fresh crest: an axis, a speed, a length, and a place on its own line.
   *
   * The four draws are always taken in that order, so a seed replays its own
   * sea. `offset` is rolled inside whatever room the length leaves over the
   * arena's full width, so a full-length crest is necessarily centred and a
   * short one may be anywhere across the ring -- and never so far out that
   * most of it is sweeping empty water beyond the circle.
   */
  function launchCrest(): MutableCrest {
    const axis = AXES[Math.floor(rng() * AXES.length)];
    const speed = CREST_SPEED_MIN + rng() * (CREST_SPEED_MAX - CREST_SPEED_MIN);
    const length =
      CREST_FULL_LENGTH *
      (CREST_LENGTH_MIN_FRAC + rng() * (CREST_LENGTH_MAX_FRAC - CREST_LENGTH_MIN_FRAC));
    const room = Math.max(0, (CREST_FULL_LENGTH - length) / 2);
    const offset = (rng() * 2 - 1) * room;
    return {
      axis,
      at: -(ARENA_R0 + CREST_MARGIN),
      length,
      offset,
      speed,
      hitPlayer: false,
      hitAi: false,
    };
  }

  /**
   * A fresh raft: born just outside the ring, aimed to cross near the centre,
   * with its own size and its own speed.
   *
   * `headStart` is how far along that track it is already, and is only ever
   * non-zero for the opening fleet. It is applied as a distance rather than
   * as a time because the speed is rolled here too: a slow raft and a quick
   * one handed the same head start should start in the same PLACE, not the
   * quick one three times further on.
   */
  function launchFlotsam(headStart = 0): MutableFlotsam {
    const startDist = ARENA_R0 + FLOTSAM_MARGIN;
    const startBearing = rng() * TWO_PI;
    const bornX = Math.cos(startBearing) * startDist;
    const bornZ = Math.sin(startBearing) * startDist;
    const aimBearing = rng() * TWO_PI;
    const aimDist = rng() * FLOTSAM_AIM;
    const dx = Math.cos(aimBearing) * aimDist - bornX;
    const dz = Math.sin(aimBearing) * aimDist - bornZ;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const speed = FLOTSAM_SPEED_MIN + rng() * (FLOTSAM_SPEED_MAX - FLOTSAM_SPEED_MIN);
    const radius = FLOTSAM_R_MIN + rng() * (FLOTSAM_R_MAX - FLOTSAM_R_MIN);
    return {
      x: bornX + ux * headStart,
      z: bornZ + uz * headStart,
      vx: ux * speed,
      vz: uz * speed,
      radius,
      crossed: false,
    };
  }

  /**
   * Takes one raft off the water and starts the clock on its replacement.
   *
   * Every way a raft can end goes through here -- sunk by a ball, fouled on
   * by a hull, or carried out the far side -- so the fleet can never quietly
   * shrink for the rest of a fight, and a raft cannot be replaced the instant
   * it dies either.
   */
  function removeFlotsam(index: number): void {
    state.flotsam.splice(index, 1);
    flotsamTimer = FLOTSAM_GAP_MIN + rng() * (FLOTSAM_GAP_MAX - FLOTSAM_GAP_MIN);
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

  /**
   * A hull whose actual position has come within reach of a raft: foul it and
   * take that raft off the water.
   *
   * At most one raft per hull per tick, which is why this returns on the
   * first hit rather than running the fleet out. Two rafts overlapping a hull
   * on one frame is a single collision as far as the player can see, and
   * fouling twice for it would cost them four seconds for one mistake.
   */
  function checkFoul(
    target: SwayTarget,
    radius: number,
    owner: 'player' | 'ai',
    events: BattleEvent[],
  ): void {
    const posX = radius * Math.cos(target.angle) + target.swayX;
    const posZ = radius * Math.sin(target.angle) + target.swayZ;
    for (let i = 0; i < state.flotsam.length; i++) {
      const f = state.flotsam[i];
      const reach = f.radius + HIT_RADIUS;
      if ((posX - f.x) * (posX - f.x) + (posZ - f.z) * (posZ - f.z) < reach * reach) {
        target.fouled = FOUL_SECONDS;
        target.cooldown = FOUL_SECONDS;
        events.push({ kind: 'foul', owner, x: posX, z: posZ });
        removeFlotsam(i);
        return;
      }
    }
  }

  /**
   * Shove one hull along `(x, z)`, as if a wave had just passed under it.
   *
   * The way the OPEN SEA reaches into a fight. `main.ts` watches the real
   * crests `hazards.ts` is running and calls this when one crosses a hull,
   * so a front the player watched bearing down on the ring is the front that
   * throws their aim -- rather than a second, invisible set of crests raised
   * inside the arena to imitate the sea outside it.
   *
   * It is the SAME channel the arena's own crests use, on purpose. The pulse
   * shape, its decay, the one-pulse-per-hull rule and the keel clamp are all
   * unchanged and all still apply, so a shove from the ocean is bounded by
   * SWAY_MAX exactly as one from an arena crest was -- which is what keeps
   * `clampKeel`'s argument (one pulse peaks at 6, the ring floors at 8)
   * standing. The caller maps a real crest's height and speed onto
   * SWAY_MIN..SWAY_MAX rather than passing a world amplitude through, for
   * that reason.
   */
  function shove(
    which: 'player' | 'ai',
    x: number,
    z: number,
    amplitude: number,
    elapsed: number,
  ): void {
    const pulse = which === 'player' ? playerPulse : aiPulse;
    pulse.triggerAlong(x, z, amplitude, elapsed);
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
      // The clock only runs while there is room for another. A full arena
      // banking launches would empty them all into the gap the moment one
      // crest died, which is the opposite of what CREST_MAX is for.
      if (state.crests.length < CREST_MAX) {
        crestTimer -= dt;
        if (crestTimer <= 0) {
          state.crests.push(launchCrest());
          crestTimer = CREST_GAP_MIN + rng() * (CREST_GAP_MAX - CREST_GAP_MIN);
        }
      }

      // Backwards, so a crest dropped off the end of its run does not move
      // the one behind it out from under this loop's own index.
      for (let i = state.crests.length - 1; i >= 0; i--) {
        const c = state.crests[i];
        const prevAt = c.at;
        c.at += c.speed * dt;

        // Passing and shoving are two different questions, asked in that
        // order: the crest sweeps past a hull's track coordinate, and THEN
        // the hull is shoved if it was inside the crest's own ends when it
        // did. See MutableCrest on why the flag records the first and not
        // the second.
        if (!c.hitPlayer) {
          const track = trackAlong(radius, player.angle, c.axis);
          if (prevAt < track && c.at >= track) {
            c.hitPlayer = true;
            if (underCrest(trackAcross(radius, player.angle, c.axis), c)) {
              playerPulse.trigger(c.axis, SWAY_MIN + rng() * (SWAY_MAX - SWAY_MIN), elapsed);
            }
          }
        }
        if (!c.hitAi) {
          const track = trackAlong(radius, ai.angle, c.axis);
          if (prevAt < track && c.at >= track) {
            c.hitAi = true;
            if (underCrest(trackAcross(radius, ai.angle, c.axis), c)) {
              aiPulse.trigger(c.axis, SWAY_MIN + rng() * (SWAY_MAX - SWAY_MIN), elapsed);
            }
          }
        }

        if (c.at > ARENA_R0 + CREST_MARGIN) state.crests.splice(i, 1);
      }

    }

    /*
     * Outside the `wavesOn` gate, and that is deliberate.
     *
     * The pulses used to advance only while the arena raised its own crests,
     * which was correct while the arena's crests were the only thing that
     * could ever trigger one. A live-world fight switches those off and takes
     * its shoves from the real sea instead (`shove`, below), so a decay that
     * ran only under `wavesOn` would leave a hull shoved by an ocean crest
     * stuck at the displacement it was shoved to, for ever.
     *
     * One pulse per hull however many waves are running: a hull caught by a
     * second wave inside the first one's decay is thrown by the new one
     * outright rather than by the sum, which is what keeps the shove bounded
     * by SWAY_MAX no matter how busy the sea gets -- and that bound is what
     * the keel clamp below is written against.
     */
    const pv = playerPulse.advance(elapsed);
    player.swayX = pv.x;
    player.swayZ = pv.z;
    const av = aiPulse.advance(elapsed);
    ai.swayX = av.x;
    ai.swayZ = av.z;

    // ---- Keel clearance, on whatever sway is now standing ------------
    clampKeel(player, radius);
    clampKeel(ai, radius);

    // ---- Fouling counts down regardless of who set it ----------------
    player.fouled = Math.max(0, player.fouled - dt);
    ai.fouled = Math.max(0, ai.fouled - dt);

    // ---- Flotsam: launch, drift, drop, foul --------------------------
    if (flotsamOn) {
      // One replacement per gap, however many the fleet is short of. A fight
      // that loses three rafts at once gets them back one at a time, which
      // reads as the sea bringing more along rather than as three appearing
      // together on the edge of the ring.
      if (state.flotsam.length < flotsamTarget) {
        flotsamTimer -= dt;
        if (flotsamTimer <= 0) {
          state.flotsam.push(launchFlotsam());
          flotsamTimer = FLOTSAM_GAP_MIN + rng() * (FLOTSAM_GAP_MAX - FLOTSAM_GAP_MIN);
        }
      }
      for (let i = state.flotsam.length - 1; i >= 0; i--) {
        const f = state.flotsam[i];
        f.x += f.vx * dt;
        f.z += f.vz * dt;
        if (!f.crossed && f.x * f.vx + f.z * f.vz > 0) f.crossed = true;
        if (f.crossed && Math.hypot(f.x, f.z) > ARENA_R0 + FLOTSAM_MARGIN) removeFlotsam(i);
      }
      // A raft is removed the instant it fouls someone, so the second hull is
      // only ever checked against what the first check left on the water.
      checkFoul(player, radius, 'player', events);
      checkFoul(ai, radius, 'ai', events);
    }
  }

  function strike(ax: number, az: number, bx: number, bz: number): { x: number; z: number } | null {
    // The NEAREST raft along the sweep and not merely the first one found: a
    // ball crossing two of them is stopped by the near one, and with several
    // on the water at once that is no longer a rare case worth ignoring.
    let bestT = Infinity;
    let bestIndex = -1;

    for (let i = 0; i < state.flotsam.length; i++) {
      const f = state.flotsam[i];
      const t = segmentCircleEntry(ax, az, bx, bz, f.x, f.z, f.radius);
      if (t !== null && t < bestT) {
        bestT = t;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) return null;

    const point = { x: ax + (bx - ax) * bestT, z: az + (bz - az) * bestT };
    removeFlotsam(bestIndex);
    return point;
  }

  return { state: state as BattleSeaState, update, strike, shove };
}
