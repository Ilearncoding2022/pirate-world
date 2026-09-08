import type {
  BattleEvent,
  BattleInput,
  BattleOptions,
  BattleState,
  Cannonball,
  Combatant,
} from './types';
import {
  ARENA_OMEGA,
  ARENA_R0,
  ARENA_SHRINK,
  ARENA_R_MIN,
  BALL_LIFE,
  BALL_SPEED,
  BATTLE_TIMEOUT,
  FIRE_COOLDOWN,
  HITS_TO_LOSE,
  HIT_RADIUS,
  ROUNDS,
  SPLASH_MARGIN,
  THROTTLE_GAIN,
} from './battleconstants';
import { createBattleAi } from './battleai';
import { ROUGH, createBattleSea } from './battlesea';
import { mulberry32 } from './towns';

/**
 * battle.ts — the cannon fight, in flat arena units.
 *
 * The whole ruleset with no DOM and no Three, exactly as `fishsim.ts` is: two
 * boats on a shrinking circle, ten rounds each, three hits to lose. One sim is
 * built per battle and thrown away after, so nothing here has to reset.
 *
 * The brief is docs/BATTLE_PLAN.md for the fight and
 * docs/BATTLE_REWORK_PLAN.md for the rework. Read both before retuning
 * anything here. The tuning constants live in `battleconstants.ts` and are
 * re-exported below, so every importer that had them from this module still
 * does.
 *
 * This file owns the ring, the throttle, the locker, the balls, the hit test
 * and the outcome. It owns neither of the two things the rework added: the
 * enemy gunner is `battleai.ts` and the sea is `battlesea.ts`, and both are
 * called from `update` in a fixed order set out there.
 *
 * The arena is NOT on the globe. `x` and `z` are plain metres about its own
 * centre, `+z` is north and `+x` is east on the same convention `geo.ts` uses
 * for the world, and `heading` is read off the track rather than stored: the
 * one habit this file keeps from the sphere, because `battlescene.ts`
 * orients a hull from it.
 *
 * **A hull's track and a hull's position are two different things.** `angle`
 * is where it is on the circle, `swayX`/`swayZ` is how far the sea has shoved
 * it off that point, and `x`/`z` is the sum. Both boats travel the same
 * circle in the same sense, so each one's inboard beam points at the centre,
 * and a gun fires along THE TRACK's beam from wherever the hull actually is.
 * With no sway that is a diameter, which is the shot the fight was built on.
 * With sway it is a line parallel to the diameter and a few units off it, and
 * it connects only if the enemy has been shoved the same way. That is the
 * whole of how a wave spoils an aim, and it falls out of the geometry rather
 * than being a rule anybody wrote.
 */

export {
  ARENA_OMEGA,
  ARENA_R0,
  ARENA_R_MIN,
  ARENA_SHRINK,
  ARENA_SPEED,
  BALL_LIFE,
  BALL_SPEED,
  BATTLE_TIMEOUT,
  FIRE_COOLDOWN,
  HITS_TO_LOSE,
  HIT_RADIUS,
  ROUNDS,
  SPLASH_MARGIN,
  THROTTLE_GAIN,
} from './battleconstants';

const TWO_PI = Math.PI * 2;

/** Wrap to [0, 2PI). */
function wrapTwoPi(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * Distance from the point (px, pz) to the segment (ax, az)-(bx, bz).
 *
 * The segment is the ball's sweep over one tick; see HIT_RADIUS for why the
 * end point alone will not do, and why the doubled ball made that matter more
 * rather than less.
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
  swayX: number;
  swayZ: number;
  fouled: number;
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
  fuse: number | null;
}

function combatant(angle: number): MutableCombatant {
  return {
    angle,
    x: 0,
    z: 0,
    heading: 0,
    rounds: ROUNDS,
    hits: 0,
    cooldown: 0,
    swayX: 0,
    swayZ: 0,
    fouled: 0,
  };
}

/**
 * @param rng the one seeded source for the whole fight. The gunner and the
 *   sea both draw from it, so one seed is one repeatable battle.
 * @param options which of the sea's three systems run. Defaults to all of
 *   them; `main.ts` passes CALM under `?calm=1`, and every unit case that
 *   measures the gunner passes CALM so the sea cannot move the answer.
 */
export function createBattleSim(
  rng: () => number = Math.random,
  options: BattleOptions = ROUGH,
): BattleSim {
  // Two streams off the one source, drawn in a FIXED order before either
  // module exists and before `options` has been looked at.
  //
  // Handing both modules the same `rng` looked equivalent and is not. The sea
  // draws in its own constructor -- `rollObstacles` alone takes five numbers
  // per obstacle -- and how many it takes depends on which systems are
  // switched on, so a shared stream leaves the gunner reading from a
  // different offset in a rough fight than in a calm one. Its coin flips and
  // its solutions would then differ between the two for no reason connected
  // to the sea at all, which is exactly the comparison `?calm=1` and the
  // gunner's own pinned test exist to make. Two draws here, always the same
  // two whatever the options say, and the gunner's dice are its own.
  const aiRng = mulberry32(Math.floor(rng() * 0x100000000));
  const seaRng = mulberry32(Math.floor(rng() * 0x100000000));
  const ai = createBattleAi(aiRng);
  const sea = createBattleSea(seaRng, options);

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
    fuse: null,
    // The sea's own three, exposed as getters rather than copied every tick:
    // they are the SAME objects `battlesea.ts` is mutating, so nothing here
    // can hand the scene a stale crest or a raft that has already sunk.
    get crest() {
      return sea.state.crest;
    },
    get obstacles() {
      return sea.state.obstacles;
    },
    get flotsam() {
      return sea.state.flotsam;
    },
  };

  place(state.player);
  place(state.ai);

  /**
   * Put a combatant where it actually is, and read its heading off the track.
   *
   * Position is the point on the circle at `angle` plus whatever the sea has
   * shoved it by. The tangent to `angle` increasing is `(-sin, cos)` in
   * `(x, z)`, and heading is that vector as a compass bearing on `geo.ts`'s
   * convention: 0 is +z, clockwise positive. Both are derived every tick and
   * neither is stored, so they cannot drift away from the motion they
   * describe. Heading is off the TRACK and not off the sway: a hull shoved
   * sideways by a wave is still pointed the way it is going.
   */
  function place(c: MutableCombatant): void {
    c.x = state.radius * Math.cos(c.angle) + c.swayX;
    c.z = state.radius * Math.sin(c.angle) + c.swayZ;
    c.heading = wrapTwoPi(Math.atan2(-Math.sin(c.angle), Math.cos(c.angle)));
  }

  /**
   * Spend a round out of `c`'s locker, along its track's inboard beam.
   *
   * The direction is `(-cos angle, -sin angle)`: the way the centre lies from
   * this hull's point ON THE CIRCLE, regardless of where the sea has put the
   * hull itself. The ball leaves from the hull's real position and flies
   * parallel to the diameter. Returns whether the shot went.
   */
  function fire(c: MutableCombatant, owner: 'player' | 'ai'): boolean {
    if (c.cooldown > 0 || c.rounds <= 0) return false;
    c.rounds -= 1;
    c.cooldown = FIRE_COOLDOWN;
    state.balls.push({
      owner,
      x: c.x,
      z: c.z,
      vx: -Math.cos(c.angle) * BALL_SPEED,
      vz: -Math.sin(c.angle) * BALL_SPEED,
      age: 0,
      crossed: false,
    });
    state.events.push({ kind: 'fire', owner, x: c.x, z: c.z });
    return true;
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

      // The sea eats what the hulls did not. Tested on the same sweep and
      // AFTER the hull, so a ball that would have scored is never stopped by
      // a rock a hair in front of the hull it was going to hit.
      const struck = sea.strike(fromX, fromZ, b.x, b.z);
      if (struck !== null) {
        state.events.push({ kind: 'strike', owner: b.owner, x: struck.x, z: struck.z });
        state.balls.splice(i, 1);
        continue;
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

  /**
   * One tick, in the order docs/BATTLE_REWORK_PLAN.md sets out.
   *
   * The order is load bearing in two places. The AI observes BEFORE it steers
   * or shoots, so the reading it acts on is one it took `AI_LAG` ago rather
   * than one from this instant. And the sea runs AFTER both hulls have moved
   * along their tracks and BEFORE they are placed, so a wave shoves a hull to
   * where it now is rather than to where it was.
   */
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
    // A fouled hull is dragging a raft of somebody's rigging. Applied to the
    // rate the keys asked for, so the throttle still does something.
    if (state.player.fouled > 0) omegaPlayer *= 0.5;

    // The truth, handed over before anything reads the AI's stale copy of it.
    ai.observe(state.elapsed, state.player, omegaPlayer);

    let omegaAi = ARENA_OMEGA * (1 + THROTTLE_GAIN * ai.throttle(dt, state));
    if (state.ai.fouled > 0) omegaAi *= 0.5;

    state.player.angle = wrapTwoPi(state.player.angle + omegaPlayer * dt);
    state.ai.angle = wrapTwoPi(state.ai.angle + omegaAi * dt);

    // ---- The sea ----------------------------------------------------
    // Writes both hulls' sway, counts their fouling down, moves and launches
    // the crest and the raft, and pushes any `foul` events onto this tick's
    // list. Both hulls are placed from the result.
    sea.update(dt, state.elapsed, state.radius, state.player, state.ai, state.events);
    place(state.player);
    place(state.ai);

    state.player.cooldown = Math.max(0, state.player.cooldown - dt);
    state.ai.cooldown = Math.max(0, state.ai.cooldown - dt);

    // ---- Guns -------------------------------------------------------
    // Nothing fires once the outcome is set; the boats and the balls keep
    // moving because the result card sits over a live arena.
    if (state.outcome === null) {
      if (input.fire && state.player.fouled <= 0) fire(state.player, 'player');
      // The fouling rule for the AI lives inside `gun`, which is also what
      // snuffs a fuse that was already lit when the raft hit: one owner for
      // the whole of the gunner's behaviour, and none of it duplicated here.
      const shot = ai.gun(dt, state);
      if (shot === 'aim') {
        state.events.push({ kind: 'aim', owner: 'ai', x: state.ai.x, z: state.ai.z });
      } else if (shot === 'fire') {
        fire(state.ai, 'ai');
      }
    }
    // Read after `gun` has moved it, so the strip and the scene see the fuse
    // this tick set rather than the one it had last tick.
    state.fuse = ai.fuse;

    advanceBalls(dt);
    settle();
  }

  return { state: state as BattleState, update };
}
