import type { BattleState, Combatant } from './types';
import { ARENA_OMEGA, ARENA_R_MIN, ARENA_SHRINK, BALL_SPEED, THROTTLE_GAIN } from './battleconstants';

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
   * **The AI's own beam is NOT the one it is on right now.** `battle.ts`'s
   * `fire()` throws the ball down whatever beam the hull is actually on the
   * tick it fires, and that tick is `AI_FUSE` seconds after this is solved —
   * every bit as far in the future as the ball's own flight. A gunner who
   * ignored that would be aiming down a line he is about to leave: on a real
   * fight this measured as a ~0.3-0.68 rad gap between the beam a shot was
   * solved against and the one it actually left on, several times
   * `AI_SOLUTION_TOLERANCE`'s own width, and it alone was most of why the
   * gunner missed almost everything even against a player who never touched
   * the helm. So the beam is built from the AI's own PREDICTED angle at fire
   * time, `AI_FUSE` seconds of its own current throttle further round the
   * circle — the same throttle `throttle()` is about to re-roll, so this is a
   * guess at the AI's own near future and not knowledge of anything outside
   * itself. It stays imperfect on purpose: the helm can re-decide before the
   * fuse burns out and can never see its own next coin flip, and that
   * residual error is exactly what decisions 1, 2 and 4 ask for. The AI's own
   * sway is carried forward UNCHANGED, same reasoning as the target's: it
   * cannot predict the sea either. The ring's own shrink over `AI_FUSE`
   * seconds (under a unit, at `ARENA_SHRINK`'s rate) is cheap enough to
   * predict too, so the AI's own future radius is advanced the same way
   * `battle.ts` advances it, clamped the same floor. The TARGET's radius
   * above is deliberately left where it was already decided — current, not
   * predicted forward by the fuse — since re-deriving that approximation is
   * no part of this fix.
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

    // The AI's own position AI_FUSE seconds from now, on the throttle it is
    // currently holding — `battle.ts`'s own formula for omega, halved while
    // fouled to match it exactly.
    let omegaAiNow = ARENA_OMEGA * (1 + THROTTLE_GAIN * throttleValue);
    if (state.ai.fouled > 0) omegaAiNow *= 0.5;
    const aiAngleAtFire = state.ai.angle + omegaAiNow * AI_FUSE;
    const aiRadiusAtFire = Math.max(ARENA_R_MIN, state.radius - ARENA_SHRINK * AI_FUSE);
    const aiX = aiRadiusAtFire * Math.cos(aiAngleAtFire) + state.ai.swayX;
    const aiZ = aiRadiusAtFire * Math.sin(aiAngleAtFire) + state.ai.swayZ;

    const dx = targetX - aiX;
    const dz = targetZ - aiZ;
    // The track's inboard beam AT FIRE TIME: the way the centre lies from
    // where the AI's point ON THE CIRCLE will be, not where it is now.
    const beamX = -Math.cos(aiAngleAtFire);
    const beamZ = -Math.sin(aiAngleAtFire);
    const downRange = dx * beamX + dz * beamZ;
    // Perpendicular to the beam, rotated 90 degrees: (-beamZ, beamX). Positive
    // still means the AI needs more speed to bring its future beam onto the
    // target — proved in battleai.test.ts — though since the beam itself now
    // moves with the throttle, this is no longer an exact match for the old
    // gunner's `solutionError`; it agrees with it only in the limit where the
    // AI's own predicted motion is zero.
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

    if (state.ai.cooldown <= 0) {
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
