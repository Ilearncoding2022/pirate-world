import type { BattleEvent, BattleInput, BattleState, Cannonball, Combatant } from './types';

/**
 * battle.ts — the cannon fight, in flat arena units.
 *
 * The whole ruleset with no DOM and no Three, exactly as `fishsim.ts` is: two
 * boats on a shrinking circle, ten rounds each, three hits to lose. One sim is
 * built per battle and thrown away after, so nothing here has to reset.
 *
 * The brief is docs/BATTLE_PLAN.md. Read it before retuning anything here.
 *
 * The arena is NOT on the globe. `x` and `z` are plain metres about its own
 * centre, `+z` is north and `+x` is east on the same convention `geo.ts` uses
 * for the world, and `heading` is read off the velocity rather than stored:
 * the one habit this file keeps from the sphere, because `battlescene.ts`
 * orients a hull from it.
 *
 * Both boats travel the same circle in the same sense, so each one's inboard
 * beam points at the centre and a broadside is a chord through it. A ball
 * therefore flies down a diameter and meets the enemy only if the enemy is at
 * the far end of that diameter when it arrives. That is what makes the shot a
 * timing skill rather than an aim: you fire as the enemy comes ONTO the line,
 * early enough to lead it, and the lead you owe shrinks as the circle closes.
 */

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * The circle: where it starts, where it stops, and how fast it closes, in
 * arena units and units/s.
 *
 * Twenty units across the diameter is a ball flight of nearly two seconds at
 * BALL_SPEED, which is long enough that the lead is a real judgement. Eight is
 * the point where two 3.1-unit hulls are close enough to read each other's
 * damage and the flight is down to two thirds of a second. Half a minute to
 * cross that gap is slow enough not to be noticed as motion and fast enough
 * that a fight which is going nowhere still ends up somewhere.
 */
export const ARENA_R0 = 20;
export const ARENA_R_MIN = 8;
export const ARENA_SHRINK = 0.4;

/**
 * How fast the boats go round, authored as a tangential speed at the opening
 * radius and divided out into the angular rate that is actually integrated.
 *
 * Written this way for the same reason `ship.ts` derives `ACCEL` from
 * `MAX_FORWARD`: six units a second at twenty units of radius is a fact about
 * how fast the hulls look like they are moving, and 0.3 rad/s is only the
 * consequence. The RATE is what is held constant as the circle shrinks, so the
 * boats visibly slow as they close and the fight tightens rather than
 * spinning up.
 */
export const ARENA_SPEED = 6;
export const ARENA_OMEGA = ARENA_SPEED / ARENA_R0;

/**
 * How much W and S move a boat's angular speed, as a fraction of ARENA_OMEGA.
 *
 * Half. The separation between the two hulls therefore drifts by up to 0.15
 * rad/s, so a player can pull a third of the way off the diameter in two
 * seconds and put themselves back on it in two more. Much less and the
 * throttle does not feel connected to anything; much more and the fight
 * becomes a race rather than a duel.
 */
export const THROTTLE_GAIN = 0.5;

/** Rounds in each side's locker. */
export const ROUNDS = 10;
/** Hits that end a hull's fight. */
export const HITS_TO_LOSE = 3;

/**
 * Seconds between shots from one side.
 *
 * A second is about half a flight time at the opening radius, so a player who
 * fires on every window gets two or three balls in the air at once and has to
 * watch them all. It is also what makes ten rounds last: a locker emptied at
 * will would be gone in three seconds.
 */
export const FIRE_COOLDOWN = 1;

/**
 * The ball: how fast it flies, how long it may live, and how far past the far
 * side it travels before it is written off as a miss.
 *
 * Twenty-two units a second against a tangential six is a lead of about
 * thirty degrees at the opening radius and twelve at the closing one, which is
 * the whole skill of the thing. BALL_LIFE is a backstop and nothing more: at
 * this speed a ball has crossed the circle and cleared the splash margin in
 * well under two seconds, so the only balls it ever collects are ones a
 * shrinking radius has stranded.
 */
export const BALL_SPEED = 22;
export const BALL_LIFE = 4;
export const SPLASH_MARGIN = 3;

/**
 * How close a ball has to pass to a hull's centre to score, arena units.
 *
 * Half a hull length, on a centre-to-centre test, which is the same trade
 * `aiboats.ts`'s CONTACT_RADIUS makes and for the same reason. The test is
 * against the SEGMENT the ball swept this tick rather than the point it ended
 * on: at 22 units a second a tenth-of-a-second frame moves it 2.2 units, which
 * is further than this radius, and a point test would let balls tunnel
 * straight through a hull on a slow machine.
 */
export const HIT_RADIUS = 1.6;

/**
 * How far off its broadside line the AI will accept a firing solution, arena
 * units, and the two numbers that turn that solution into a shot: a reaction
 * before it commits, and a jitter on when the shot actually goes.
 *
 * The AI does not roll for a hit. It solves the same geometry the player has
 * to solve by eye, then fires late and imprecisely, and the misses fall out of
 * that: a ball committed to a solution half a second ago is a ball aimed at
 * where the enemy was going to be before either boat changed its mind. Which
 * is why a player who works the throttle after the AI has committed can step
 * out from under a shot that was solved perfectly.
 *
 * The effective hit rate is emergent, not authored, and it is pinned by
 * `tests/unit/battle.test.ts` at between 35% and 55% against a player who does
 * nothing at all. It measures 46.5% as written, at any frame rate.
 *
 * The tolerance is the dial that actually moves it, and it is wide on purpose:
 * it is a gunner's judgement by eye, not a computation, so it is more than
 * twice HIT_RADIUS and the AI takes shots it ought to know will miss. The
 * plan's 1.2 was tried first and gives 92%; a tolerance tighter than the hit
 * radius only ever accepts solutions that are already good enough to score, so
 * the reaction and the jitter have nothing left to spoil. Pushing the jitter
 * instead does not recover it: at 1.2 units even a full second of delay only
 * drops the rate to 80%, because the AI's helm is hunting the solution the
 * whole time and a late ball is still aimed near it.
 */
export const AI_SOLUTION_TOLERANCE = 4;
export const AI_REACTION_MIN = 0.2;
export const AI_REACTION_MAX = 0.6;
export const AI_JITTER = 0.35;

/**
 * Seconds between the AI's own throttle decisions.
 *
 * The AI works its helm the way the player does, and this is the whole of its
 * seamanship: every AI_HELM_PERIOD it looks at where the player will be when a
 * ball would arrive, and speeds up or drops back to bring that point onto its
 * broadside. It cannot do it any oftener, so it always overshoots, and the two
 * hulls sweep past each other's firing windows instead of locking on the
 * diameter and staying there.
 *
 * That lock is not hypothetical: two boats at the same angular speed hold
 * their separation exactly, and with a lead to solve for, a fight between them
 * has no firing window at all, for either side, ever. The helm is what makes
 * the windows open and close; see docs/BATTLE_PLAN.md, "Broadside geometry in
 * the arena", which asks for exactly that and hands the job to W/S alone.
 * A second and a half is roughly the time the AI needs to cross the window it
 * is aiming for, so it hunts across the solution rather than settling on it.
 */
export const AI_HELM_PERIOD = 1.5;

/**
 * Seconds a fight may run before it is called a draw.
 *
 * The world is frozen behind the arena and the power plant is still burning,
 * so a player who simply never fires may not hold the game there. Two minutes
 * is four times the length of a fight that is actually being fought.
 */
export const BATTLE_TIMEOUT = 120;

const TWO_PI = Math.PI * 2;

/** Wrap to (-PI, PI]. */
function wrapPi(a: number): number {
  const x = ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI;
  return x - Math.PI;
}

/** Wrap to [0, 2PI). */
function wrapTwoPi(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * Distance from the point (px, pz) to the segment (ax, az)-(bx, bz).
 *
 * The segment is the ball's sweep over one tick; see HIT_RADIUS for why the
 * end point alone will not do.
 */
function segmentDistance(
  ax: number, az: number, bx: number, bz: number, px: number, pz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len = dx * dx + dz * dz;
  let t = len > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / len : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + dx * t - px;
  const cz = az + dz * t - pz;
  return Math.hypot(cx, cz);
}

/* ------------------------------------------------------------------ */
/* The fight                                                           */
/* ------------------------------------------------------------------ */

export interface BattleSim {
  /** Live, mutated in place for the length of one fight. */
  readonly state: BattleState;
  update(dt: number, input: BattleInput): void;
}

interface MutableCombatant extends Combatant {
  angle: number;
  x: number;
  z: number;
  heading: number;
  rounds: number;
  hits: number;
  cooldown: number;
}

/** A ball, plus the one bit of bookkeeping the splash rule needs. */
interface MutableCannonball extends Cannonball {
  owner: 'player' | 'ai';
  x: number;
  z: number;
  vx: number;
  vz: number;
  age: number;
  /** True once it has passed through the centre and is on its way out. */
  crossed: boolean;
}

interface MutableBattleState extends BattleState {
  radius: number;
  player: MutableCombatant;
  ai: MutableCombatant;
  balls: MutableCannonball[];
  elapsed: number;
  outcome: BattleState['outcome'];
  events: BattleEvent[];
}

function combatant(angle: number): MutableCombatant {
  return { angle, x: 0, z: 0, heading: 0, rounds: ROUNDS, hits: 0, cooldown: 0 };
}

export function createBattleSim(rng: () => number = Math.random): BattleSim {
  const state: MutableBattleState = {
    radius: ARENA_R0,
    // The player on the near side, at the bottom of the frame the arena
    // camera is parked in, and the enemy across the circle from it.
    player: combatant(Math.PI),
    ai: combatant(0),
    balls: [],
    elapsed: 0,
    outcome: null,
    events: [],
  };

  /** The AI's throttle this interval: +1 faster, -1 slower. */
  let aiThrottle = 1;
  let helmTimer = 0;
  /** When the AI's committed shot goes, or null while nothing is pending. */
  let pendingShot: number | null = null;

  place(state.player);
  place(state.ai);

  /**
   * Put a combatant on the circle from its angle, and read its heading off the
   * direction it is travelling.
   *
   * The tangent to `angle` increasing is `(-sin, cos)` in `(x, z)`, and
   * heading is that vector as a compass bearing on `geo.ts`'s convention: 0 is
   * +z, clockwise positive. Derived every tick, never stored, so it cannot
   * drift away from the motion it describes.
   */
  function place(c: MutableCombatant): void {
    c.x = state.radius * Math.cos(c.angle);
    c.z = state.radius * Math.sin(c.angle);
    c.heading = wrapTwoPi(Math.atan2(-Math.sin(c.angle), Math.cos(c.angle)));
  }

  /**
   * Spend a round out of `c`'s locker, straight out of its inboard beam.
   *
   * The ball leaves toward the arena centre, which is where the beam points
   * for a boat on this circle, and flies straight from there. Returns whether
   * the shot went.
   */
  function fire(c: MutableCombatant, owner: 'player' | 'ai'): boolean {
    if (c.cooldown > 0 || c.rounds <= 0) return false;
    const r = Math.hypot(c.x, c.z);
    if (r < 1e-6) return false;
    c.rounds -= 1;
    c.cooldown = FIRE_COOLDOWN;
    state.balls.push({
      owner,
      x: c.x,
      z: c.z,
      vx: (-c.x / r) * BALL_SPEED,
      vz: (-c.z / r) * BALL_SPEED,
      age: 0,
      crossed: false,
    });
    state.events.push({ kind: 'fire', owner, x: c.x, z: c.z });
    return true;
  }

  /**
   * The AI's firing solution, as an angle error.
   *
   * A ball leaving the AI now arrives at the far end of its own diameter after
   * `2 * radius / BALL_SPEED`, so the question is where the player will be
   * then. The error is the angle between that predicted position and the far
   * end of the diameter: positive means the player is running ahead of the
   * point the ball is going to, and the AI has to speed up to catch them.
   *
   * `omegaPlayer` is the player's angular speed THIS tick, so a player who
   * changes speed after the AI has committed is no longer where the solution
   * said they would be. That is the dodge.
   */
  function solutionError(omegaPlayer: number): number {
    const flight = (2 * state.radius) / BALL_SPEED;
    const predicted = state.player.angle + omegaPlayer * flight;
    return wrapPi(predicted - state.ai.angle - Math.PI);
  }

  /**
   * The AI's gunnery: commit to a solution after a reaction, fire after a
   * jitter. See AI_SOLUTION_TOLERANCE for why it is built this way round.
   */
  function aiGun(error: number): void {
    const ai = state.ai;
    if (pendingShot === null && ai.rounds > 0 && ai.cooldown <= 0) {
      // `cos` positive is the player down-range rather than behind the gun:
      // the broadside line runs both ways out of the hull and only one half of
      // it is where the ball is going.
      const offset = state.radius * Math.sin(error);
      if (Math.cos(error) > 0 && Math.abs(offset) < AI_SOLUTION_TOLERANCE) {
        const reaction = AI_REACTION_MIN + rng() * (AI_REACTION_MAX - AI_REACTION_MIN);
        const jitter = (rng() * 2 - 1) * AI_JITTER;
        pendingShot = state.elapsed + reaction + jitter;
      }
    }
    if (pendingShot !== null && state.elapsed >= pendingShot) {
      fire(ai, 'ai');
      pendingShot = null;
    }
  }

  /** One tick of every ball in the air. */
  function advanceBalls(dt: number): void {
    for (let i = state.balls.length - 1; i >= 0; i--) {
      const b = state.balls[i];
      const fromX = b.x;
      const fromZ = b.z;
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      b.age += dt;
      if (!b.crossed && b.x * b.vx + b.z * b.vz > 0) b.crossed = true;

      // Nothing scores once the fight is decided: the card sits over a live
      // arena and the balls still in the air are scenery.
      if (state.outcome === null) {
        const target = b.owner === 'player' ? state.ai : state.player;
        if (segmentDistance(fromX, fromZ, b.x, b.z, target.x, target.z) < HIT_RADIUS) {
          target.hits += 1;
          // `owner` is who FIRED, here as on every other event; the position
          // is the hull that took it.
          state.events.push({ kind: 'hit', owner: b.owner, x: target.x, z: target.z });
          state.balls.splice(i, 1);
          continue;
        }
      }

      // A ball is written off once it is past the far side of the circle, not
      // merely far from the centre: it starts a full radius out, travelling
      // inward, and would otherwise splash on the frame it was fired.
      const d = Math.hypot(b.x, b.z);
      if ((b.crossed && d > state.radius + SPLASH_MARGIN) || b.age >= BALL_LIFE) {
        state.events.push({ kind: 'splash', owner: b.owner, x: b.x, z: b.z });
        state.balls.splice(i, 1);
      }
    }
  }

  /** The outcome rules, in the order the plan states them: first match wins. */
  function settle(): void {
    if (state.outcome !== null) return;
    const playerOut = state.player.hits >= HITS_TO_LOSE;
    const aiOut = state.ai.hits >= HITS_TO_LOSE;
    if (playerOut && aiOut) state.outcome = 'draw';
    else if (aiOut) state.outcome = 'win';
    else if (playerOut) state.outcome = 'loss';
    else if (state.player.rounds === 0 && state.ai.rounds === 0 && state.balls.length === 0) {
      state.outcome = 'draw';
    } else if (state.elapsed >= BATTLE_TIMEOUT) state.outcome = 'draw';
  }

  function update(dt: number, input: BattleInput): void {
    // THIS TICK's events and no others. Cleared before the guard below, so a
    // zero-length frame leaves an empty list rather than last tick's, which a
    // scene reading it would replay as a second muzzle flash.
    state.events.length = 0;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    state.elapsed += dt;
    state.radius = Math.max(ARENA_R_MIN, state.radius - ARENA_SHRINK * dt);

    // ---- The helm ---------------------------------------------------
    let omegaPlayer = ARENA_OMEGA;
    if (input.faster && !input.slower) omegaPlayer *= 1 + THROTTLE_GAIN;
    else if (input.slower && !input.faster) omegaPlayer *= 1 - THROTTLE_GAIN;

    const error = solutionError(omegaPlayer);
    helmTimer -= dt;
    if (helmTimer <= 0) {
      helmTimer += AI_HELM_PERIOD;
      aiThrottle = error >= 0 ? 1 : -1;
    }
    const omegaAi = ARENA_OMEGA * (1 + THROTTLE_GAIN * aiThrottle);

    state.player.angle = wrapTwoPi(state.player.angle + omegaPlayer * dt);
    state.ai.angle = wrapTwoPi(state.ai.angle + omegaAi * dt);
    place(state.player);
    place(state.ai);

    state.player.cooldown = Math.max(0, state.player.cooldown - dt);
    state.ai.cooldown = Math.max(0, state.ai.cooldown - dt);

    // ---- Guns -------------------------------------------------------
    // Nothing fires once the outcome is set; the boats and the balls keep
    // moving because the result card sits over a live arena.
    if (state.outcome === null) {
      if (input.fire) fire(state.player, 'player');
      aiGun(error);
    }

    advanceBalls(dt);
    settle();
  }

  return { state: state as BattleState, update };
}
