import type { BattleState, Combatant } from './types';
import { BALL_SPEED } from './battleconstants';

/**
 * battleai.ts — the enemy gunner and the enemy helm.
 *
 * Decisions 1, 2 and 4 of docs/BATTLE_REWORK_PLAN.md, and nothing else: this
 * file knows nothing about the sea, the ring's shrink or the locker's
 * bookkeeping, only what it is handed through the contract below.
 *
 * Three pieces, each one a fix for the old gunner named in the plan's "Why":
 *
 * - **A two-second delay line.** `observe` records the truth every tick and
 *   `throttle` and `gun` read it `AI_LAG` seconds later, so everything the AI
 *   does is aimed at the player of two seconds ago rather than the player of
 *   right now. A player who never touches the throttle is unaffected — the
 *   extrapolation is exact against a constant rate — but a player who taps a
 *   key steps out from under a solution built on stale data.
 * - **A coin in the helm.** One decision in four ignores the solution outright
 *   and picks a direction at random, so the AI's own steering is no longer a
 *   flawless bang-bang controller.
 * - **A fuse instead of a reaction and a jitter.** The AI commits to a shot
 *   `AI_FUSE` seconds before it fires, and the shot goes whether or not the
 *   solution still holds by then. That is what makes it dodgeable, and it is
 *   the whole of decision 4.
 *
 * The AI does not see the sea. It is shoved, fouled and blocked exactly as the
 * player is and does nothing about any of it: the brief asked for a gunner
 * that is worse, and a helm that dodged rafts would be one that is better.
 */

/** What the AI currently believes about the player, `AI_LAG` seconds stale. */
export interface AiView {
  /** The elapsed time this reading was taken at. */
  readonly t: number;
  readonly angle: number;
  readonly omega: number;
  readonly swayX: number;
  readonly swayZ: number;
}

export interface BattleAi {
  /**
   * Record the truth this tick. Called before `throttle` and `gun`, which see
   * this reading `AI_LAG` seconds from now.
   */
  observe(elapsed: number, player: Combatant, omegaPlayer: number): void;
  /**
   * This tick's throttle, +1 faster or -1 slower. Re-rolled every
   * `AI_HELM_PERIOD`; one roll in four is a coin rather than a solution.
   */
  throttle(dt: number, state: BattleState): 1 | -1;
  /**
   * `'aim'` on the one tick a shot is committed, `'fire'` on the one tick it
   * goes, null otherwise. `battle.ts` turns the first into an event and the
   * second into a round out of the locker.
   */
  gun(dt: number, state: BattleState): 'aim' | 'fire' | null;
  /** Seconds until the committed shot goes, or null. Copied onto `state.fuse`. */
  readonly fuse: number | null;
  /** The delayed reading, for the tests that prove it is delayed. */
  readonly view: AiView | null;
}

/**
 * Seconds the AI's reading of the player runs behind the truth. Decision 1.
 *
 * Two seconds is longer than one helm decision (`AI_HELM_PERIOD`, 1.5 s), so a
 * player who taps the throttle once has already changed course again by the
 * time the AI's view catches up to the tap. It is also short enough that a
 * player who does nothing is read exactly as before: the delay only ever
 * costs the AI something when the player actually moves.
 */
export const AI_LAG = 2;

/**
 * Seconds between the AI's own helm decisions. Unchanged from the old fight —
 * this number is not one of the seven decisions, it is inherited seamanship,
 * and the plan does not ask for it to move.
 */
export const AI_HELM_PERIOD = 1.5;

/**
 * Fraction of helm decisions that ignore the solution and flip a coin
 * instead. Decision 2.
 *
 * A quarter, not a tenth or a half: often enough that a patient player will
 * see the AI visibly pick the wrong way within a minute of watching it (the
 * plan's own acceptance test), rare enough that the helm still reads as
 * mostly-competent rather than drunk.
 */
export const AI_HELM_COIN = 0.25;

/**
 * Seconds from committing to a shot to firing it. Decision 4.
 *
 * Replaces the old reaction (0.2 to 0.6 s) and jitter (up to 0.35 s) outright
 * — both are deleted and must not come back. Those two existed to blur the
 * moment a fixed solution turned into a fixed shot, which mattered when the
 * shot was solved on live data and any warning at all was a gift to the
 * player. Now the solution is solved AI_LAG seconds stale to begin with, so
 * the fixed fuse does not need to hide anything: it is the telegraph itself,
 * the thing the scene lights and the strip bars, and a shot that goes exactly
 * on time is more legible than one that goes at a random moment nobody can
 * read.
 */
export const AI_FUSE = 1.5;

/**
 * Arena units of lateral offset the AI will accept as a solution. Unchanged
 * from the old fight.
 *
 * The dial that moves the hit rate more than any other number in this file:
 * wider commits to more shots that are already lost by the time they land,
 * narrower means the AI rarely fires at all. Left where the old gunner had it
 * because everything else that used to make that gunner accurate — the live
 * reading, the short reaction, the sub-tenth jitter — is gone, so the same
 * tolerance now sits behind a much harder shot.
 */
export const AI_SOLUTION_TOLERANCE = 4;

/**
 * How many ticks of the delay line to keep.
 *
 * `AI_LAG` seconds of history at 60 Hz is 120 entries; 200 leaves margin for a
 * slower machine's longer `dt` without ever coming close to the fight's own
 * length (a 120-second fight at 60 Hz is 7200 ticks, and this buffer is never
 * more than a few seconds of it). Bounded so a long fight cannot grow this
 * without limit.
 */
const MAX_VIEW_ENTRIES = 200;

/** One entry on the solution's beam: how far down it and how far off it. */
interface Solution {
  /** Distance along the AI's own inboard beam. Positive is in front of the gun. */
  readonly downRange: number;
  /** Perpendicular distance from that beam, signed. */
  readonly lateral: number;
}

/**
 * @param rng the sim's own seeded source, so a seeded fight is repeatable.
 */
export function createBattleAi(rng: () => number = Math.random): BattleAi {
  // The delay line. Pushed every `observe`, oldest dropped once it grows past
  // MAX_VIEW_ENTRIES, and always read from the near end backward: the entry
  // sought is usually only AI_LAG-worth of ticks from the front.
  const buffer: AiView[] = [];
  let seeded = false;
  let view: AiView | null = null;

  let helmTimer = 0;
  let throttleValue: 1 | -1 = 1;

  let fuseValue: number | null = null;

  /**
   * The newest entry at or before `elapsed - AI_LAG`, or the OLDEST entry the
   * line holds if even that is later than the horizon.
   *
   * The fallback is what "seeded... with the player's starting state at
   * t = 0" actually buys: for the whole of the fight's first AI_LAG seconds
   * the horizon is negative, before anything the line has ever recorded, and
   * without the fallback that would read as no view at all rather than the
   * (correct, because nothing has happened yet) starting reading.
   */
  function refreshView(elapsed: number): void {
    const horizon = elapsed - AI_LAG;
    let found: AiView | null = buffer.length > 0 ? buffer[0] : null;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].t <= horizon) {
        found = buffer[i];
        break;
      }
    }
    view = found;
  }

  function observe(elapsed: number, player: Combatant, omegaPlayer: number): void {
    if (!seeded) {
      // There is no player to read at construction time — `createBattleAi`
      // is handed only `rng` — so this, the first tick the truth is ever
      // available, is the earliest the seed can be taken. It costs nothing:
      // on the very first tick the player is still at its starting angle to
      // within one frame, so a seed of "now" stamped t = 0 is the starting
      // state in every fight that matters.
      buffer.push({ t: 0, angle: player.angle, omega: omegaPlayer, swayX: player.swayX, swayZ: player.swayZ });
      seeded = true;
    }
    buffer.push({ t: elapsed, angle: player.angle, omega: omegaPlayer, swayX: player.swayX, swayZ: player.swayZ });
    if (buffer.length > MAX_VIEW_ENTRIES) buffer.shift();
    refreshView(elapsed);
  }

  /**
   * The firing solution, decomposed onto the AI's own broadside line.
   *
   * Solved on the STALE view, never on the truth. The predicted angle
   * extrapolates the view forward across three things at once: the staleness
   * itself (`elapsed - view.t`), the fuse the AI is about to light
   * (`AI_FUSE`), and the ball's flight (`flight`). That stack is the roughly
   * 4.4-second horizon docs/BATTLE_REWORK_PLAN.md warns about at the opening
   * radius, and it is why a player only has to touch the helm once in that
   * window to spoil a shot the AI has already committed to.
   *
   * The target point is that angle on the CURRENT ring (the radius has moved
   * on since the view was taken; the ring's shrink is not part of what is
   * stale) plus the view's sway, carried forward unchanged because the AI has
   * no way to predict what the sea will do next.
   *
   * The AI's own beam is drawn from its ACTUAL position — `state.ai.x/z`,
   * which include its own sway, because a gunner knows where his own ship is
   * even if he cannot see the enemy's — along its TRACK's inboard beam,
   * exactly the line `battle.ts`'s `fire()` throws a ball down. Using any
   * other line would aim the AI somewhere it cannot shoot.
   *
   * Returns null only when nothing has been observed yet, which in practice
   * cannot happen once a fight has run a single tick: `observe` always runs
   * before `throttle` or `gun` in `battle.ts`'s update order and seeds itself
   * on its first call.
   */
  function solve(state: BattleState): Solution | null {
    if (view === null) return null;
    const flight = (2 * state.radius) / BALL_SPEED;
    const predictedAngle = view.angle + view.omega * (state.elapsed - view.t + AI_FUSE + flight);
    const targetX = state.radius * Math.cos(predictedAngle) + view.swayX;
    const targetZ = state.radius * Math.sin(predictedAngle) + view.swayZ;

    const dx = targetX - state.ai.x;
    const dz = targetZ - state.ai.z;
    // The track's inboard beam: the way the centre lies from the AI's point
    // ON THE CIRCLE, the same direction `fire()` sends a ball down.
    const beamX = -Math.cos(state.ai.angle);
    const beamZ = -Math.sin(state.ai.angle);
    const downRange = dx * beamX + dz * beamZ;
    // Perpendicular to the beam, rotated 90 degrees: (-beamZ, beamX). Its
    // sign matches the old gunner's `solutionError` exactly (proved in
    // battleai.test.ts): positive means the player is running ahead of the
    // point the ball is going to, and the AI has to speed up to catch them.
    const lateral = dx * -beamZ + dz * beamX;
    return { downRange, lateral };
  }

  function throttle(dt: number, state: BattleState): 1 | -1 {
    helmTimer -= dt;
    if (helmTimer <= 0) {
      helmTimer += AI_HELM_PERIOD;
      if (rng() < AI_HELM_COIN) {
        // Decision 2: ignore the solution entirely and flip a coin.
        throttleValue = rng() < 0.5 ? 1 : -1;
      } else {
        const solution = solve(state);
        // No solution yet (should not happen past the first tick) is treated
        // the same as a dead-ahead one: hold course rather than guess wrong.
        throttleValue = solution !== null && solution.lateral < 0 ? -1 : 1;
      }
    }
    return throttleValue;
  }

  function gun(dt: number, state: BattleState): 'aim' | 'fire' | null {
    if (state.ai.fouled > 0) {
      // A fouled gunner neither aims nor fires, and a fuse already lit when
      // the raft hit is snuffed. `battle.ts` deliberately does not duplicate
      // this rule — see its own comment at the call site — so it lives here
      // and only here.
      fuseValue = null;
      return null;
    }

    if (fuseValue !== null) {
      fuseValue -= dt;
      if (fuseValue <= 0) {
        fuseValue = null;
        // The committed shot goes whether or not the solution still holds.
        // That is decision 4, and it is the entire point: a solved shot from
        // AI_FUSE seconds ago is not re-checked against where the player
        // actually is now.
        return 'fire';
      }
      return null;
    }

    if (state.ai.rounds > 0 && state.ai.cooldown <= 0) {
      const solution = solve(state);
      if (solution !== null && solution.downRange > 0 && Math.abs(solution.lateral) < AI_SOLUTION_TOLERANCE) {
        fuseValue = AI_FUSE;
        return 'aim';
      }
    }
    return null;
  }

  return {
    observe,
    throttle,
    gun,
    get fuse(): number | null {
      return fuseValue;
    },
    get view(): AiView | null {
      return view;
    },
  };
}
