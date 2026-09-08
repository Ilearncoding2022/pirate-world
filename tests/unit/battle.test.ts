import { describe, it, expect } from 'vitest';
import {
  ARENA_OMEGA,
  ARENA_R0,
  BALL_SPEED,
  BATTLE_TIMEOUT,
  FIRE_COOLDOWN,
  HITS_TO_LOSE,
  ROUNDS,
  THROTTLE_GAIN,
  createBattleSim,
} from '../../src/battle';
import { CALM, ROUGH } from '../../src/battlesea';
import { mulberry32 } from '../../src/towns';
import type { BattleInput, BattleState, Combatant } from '../../src/types';

/**
 * `battle.ts`'s rule set: the ball's geometry, the locker, the outcomes, and
 * the AI's measured hit rate.
 *
 * The sim is pure and takes its `rng` as an argument, so every case here is
 * deterministic and none of them draws a pixel. The one number that is not
 * asserted from the plan but MEASURED from the code is the AI's hit rate; see
 * the last case, and `AI_SOLUTION_TOLERANCE` in the module for what moves it.
 */

const IDLE: BattleInput = { fire: false, faster: false, slower: false };
const FIRE: BattleInput = { fire: true, faster: false, slower: false };
const SLOWER: BattleInput = { fire: false, faster: false, slower: true };
const FIRE_SLOWER: BattleInput = { fire: true, faster: false, slower: true };

const DT = 1 / 60;

/** The mutable face of the state, for the cases that have to set one up. */
type Mutable = {
  -readonly [K in keyof BattleState]: BattleState[K];
} & { player: Combatant & { angle: number; rounds: number; hits: number }; ai: Combatant & { angle: number; rounds: number; hits: number } };

function mutable(state: BattleState): Mutable {
  return state as unknown as Mutable;
}

function run(sim: ReturnType<typeof createBattleSim>, seconds: number, input: BattleInput): void {
  for (let i = 0; i < seconds / DT; i++) sim.update(DT, input);
}

function count(state: BattleState, kind: 'fire' | 'hit' | 'splash', owner: 'player' | 'ai'): number {
  let n = 0;
  for (const e of state.events) if (e.kind === kind && e.owner === owner) n++;
  return n;
}

describe('battle: the ball', () => {
  /**
   * A ball flies down a diameter, so a shot lands only if the enemy is at the
   * far end of that diameter when it arrives. Both cases below fly one ball at
   * an enemy scripted onto a known track, because that is the only way to say
   * "the exact lead" as a number rather than as whatever the AI happened to do.
   *
   * The enemy is driven at `1 + THROTTLE_GAIN` of the base rate while the
   * player holds S, so the two hulls separate at 0.3 rad/s and a shot taken
   * late is a shot taken at a geometry that has genuinely moved. Its angle is
   * written before every tick and the sim then advances it by its own helm, so
   * the track carries one tick of slop: 0.15 arena units at the opening
   * radius, against a 1.6-unit hit radius.
   */
  const SCRIPT_OMEGA = ARENA_OMEGA * (1 + THROTTLE_GAIN);
  const FLIGHT = (2 * ARENA_R0) / BALL_SPEED;

  /**
   * Fire one ball `delay` seconds into the fight at an enemy that started
   * `lead` radians short of the far end of the diameter, and report what
   * happened to it.
   */
  function shoot(delay: number, lead: number): { hits: number; splashes: number } {
    const sim = createBattleSim(mulberry32(0xba11));
    const state = mutable(sim.state);
    // Silence the AI's own guns: this case is about one ball, not a fight.
    state.ai.rounds = 0;
    const start = state.ai.angle - lead;

    let hits = 0;
    let splashes = 0;
    for (let i = 0; i < (delay + FLIGHT + 1.5) / DT; i++) {
      state.ai.angle = start + SCRIPT_OMEGA * state.elapsed;
      const firing = Math.abs(state.elapsed - delay) < DT / 2;
      sim.update(DT, firing ? FIRE_SLOWER : SLOWER);
      hits += count(sim.state, 'hit', 'player');
      splashes += count(sim.state, 'splash', 'player');
    }
    return { hits, splashes };
  }

  it('hits at the exact lead solution and splashes when the shot is late', () => {
    // The lead the geometry actually owes: the enemy travels for one flight
    // time before the ball gets to the far end of the diameter.
    const onTime = shoot(0, SCRIPT_OMEGA * FLIGHT);
    expect(onTime.hits).toBe(1);
    expect(onTime.splashes).toBe(0);

    // The same shot taken with no lead at all, straight at an enemy sitting on
    // the line right now, is the mistake the lead exists to prevent.
    const noLead = shoot(0, 0);
    expect(noLead.hits).toBe(0);
    expect(noLead.splashes).toBe(1);

    // And the solved shot, taken 0.6 s late, is a splash as well: the two
    // hulls have separated by 0.18 rad in the meantime.
    const late = shoot(0.6, SCRIPT_OMEGA * FLIGHT);
    expect(late.hits).toBe(0);
    expect(late.splashes).toBe(1);
  });
});

describe('battle: the locker', () => {
  it('refuses a second shot inside FIRE_COOLDOWN, and never goes below zero', () => {
    const sim = createBattleSim(mulberry32(1));
    const state = mutable(sim.state);
    state.ai.rounds = 0;

    sim.update(DT, FIRE);
    expect(state.player.rounds).toBe(ROUNDS - 1);
    // Held down for most of a second: the cooldown is what makes ten rounds a
    // budget rather than a burst.
    run(sim, FIRE_COOLDOWN - 3 * DT, FIRE);
    expect(state.player.rounds).toBe(ROUNDS - 1);
    run(sim, 4 * DT, FIRE);
    expect(state.player.rounds).toBe(ROUNDS - 2);

    // Firing flat out for far longer than the locker can pay for.
    run(sim, ROUNDS * FIRE_COOLDOWN + 5, FIRE);
    expect(state.player.rounds).toBe(0);
    expect(state.player.cooldown).toBeGreaterThanOrEqual(0);
  });
});

describe('battle: the outcome', () => {
  it('reads three hits the right way round, and calls both at once a draw', () => {
    const win = createBattleSim(mulberry32(2));
    mutable(win.state).ai.hits = HITS_TO_LOSE;
    win.update(DT, IDLE);
    expect(win.state.outcome).toBe('win');

    const loss = createBattleSim(mulberry32(3));
    mutable(loss.state).player.hits = HITS_TO_LOSE;
    loss.update(DT, IDLE);
    expect(loss.state.outcome).toBe('loss');

    const draw = createBattleSim(mulberry32(4));
    mutable(draw.state).player.hits = HITS_TO_LOSE;
    mutable(draw.state).ai.hits = HITS_TO_LOSE;
    draw.update(DT, IDLE);
    expect(draw.state.outcome).toBe('draw');

    // And nothing scores or fires afterwards, though the hulls keep moving so
    // the result card has a live arena under it.
    const before = { x: draw.state.player.x, z: draw.state.player.z };
    run(draw, 2, FIRE);
    expect(draw.state.outcome).toBe('draw');
    expect(draw.state.player.rounds).toBe(ROUNDS);
    expect(draw.state.player.x === before.x && draw.state.player.z === before.z).toBe(false);
  });

  it('calls two empty lockers a draw, and the timeout a draw', () => {
    const empty = createBattleSim(mulberry32(5));
    const emptyState = mutable(empty.state);
    emptyState.player.rounds = 0;
    emptyState.ai.rounds = 0;
    empty.update(DT, FIRE);
    expect(empty.state.outcome).toBe('draw');

    // A player who never fires holds a full locker, so only the clock can end
    // this one. The AI's is emptied so that it cannot win it instead.
    const slow = createBattleSim(mulberry32(6));
    mutable(slow.state).ai.rounds = 0;
    run(slow, BATTLE_TIMEOUT - 1, IDLE);
    expect(slow.state.outcome).toBe(null);
    run(slow, 1.5, IDLE);
    expect(slow.state.outcome).toBe('draw');
  });
});

/**
 * Measured 2026-09-08, on a calm sea (CALM: no crests, no shoals, no raft, so
 * nothing but the gunner itself can move the answer) against a player who
 * never touches the throttle, 200 fights, seeds 0x1000 through 0x10c7:
 * **596 hits out of 896 shots, 66.5%**. Pinned at plus or minus ten points
 * around that.
 *
 * An earlier pass of this file measured 3.25% and very nearly pinned it.
 * That number was real but it was measuring a bug: `solve()` aimed the AI's
 * own beam from `state.ai.angle` — where the hull was AT THE MOMENT the shot
 * was solved — while `battle.ts`'s `fire()` throws the ball from wherever the
 * hull actually is on the tick it fires, `AI_FUSE` (1.5 s) later. The AI's
 * own helm keeps travelling that whole time (up to about 0.68 rad, several
 * times `AI_SOLUTION_TOLERANCE`'s own width at a mid-fight radius), so the
 * committed shot was routinely thrown down a line the hull had already left,
 * even against a player who never moved at all. That is not what decisions 1
 * and 4 ask for — the AI is supposed to be shooting at a stale picture of the
 * PLAYER, not down a line it is no longer on — so it was fixed in
 * `battleai.ts`'s `solve`: the AI now predicts its own angle, radius and beam
 * forward across `AI_FUSE` on the throttle it currently holds (which
 * `throttle()` is about to re-roll, so it is still only a guess at its own
 * near future, not knowledge of the player), and builds both the aim and the
 * commit test from that. Decisions 1, 2 and 4 are unchanged; `AI_FUSE` itself
 * was not touched, per the plan's own note not to retune it before the owner
 * has played the result.
 *
 * The owner should know this before playing it: 66.5% against a fully idle
 * player is HIGHER than the pre-rework gunner's own 46.5%, because the fixed
 * fuse now times out with no reaction or jitter to blur it and the AI's own
 * motion is correctly led rather than fought. This is the ceiling, not the
 * typical case — decisions 1 and 2 only cost the AI anything once the player
 * actually touches the throttle or the AI's own coin comes up wrong, neither
 * of which an idle player exercises — but an idle player is exactly the
 * player who never gives the AI a reason to miss, and 66.5% is what is left
 * once the AI stops missing for a reason nothing asked for.
 */
describe('battle: the AI gunner', () => {
  it('lands about 66.5% of its shots on a calm sea against a player who does nothing', () => {
    let shots = 0;
    let hits = 0;
    for (let fight = 0; fight < 200; fight++) {
      const sim = createBattleSim(mulberry32(0x1000 + fight), CALM);
      for (let i = 0; i < (BATTLE_TIMEOUT + 1) / DT; i++) {
        sim.update(DT, IDLE);
        shots += count(sim.state, 'fire', 'ai');
        hits += count(sim.state, 'hit', 'ai');
        if (sim.state.outcome !== null) break;
      }
    }
    expect(shots).toBeGreaterThan(200 * HITS_TO_LOSE);
    const rate = hits / shots;
    // Measured 66.5%; neither the pre-rework 35%-55% band nor this file's own
    // earlier (buggy) 3.25% measurement describes the gunner as it now is.
    expect(rate).toBeGreaterThan(0.565);
    expect(rate).toBeLessThan(0.765);
  });
});

/**
 * The whole system, on the sea the game is actually played on.
 *
 * The case above measures the GUNNER, and to do that honestly it has to run on
 * a sea that is not shoving anybody, so `CALM` is the right setting there and
 * its 66.5% is a laboratory number. It is not what a fight looks like. Nobody
 * plays on a calm sea: `?calm=1` is a dev query, and every real battle runs
 * `ROUGH`.
 *
 * With the crests, the shoals and the raft switched on, the same gunner
 * against the same idle player measures **31.3%** (476 of 1519, seeds 0x1000
 * through 0x10c7, 2026-09-08), and takes 120 of the 200 fights. The sea is
 * doing two thirds of the work of making this fight fair: it shoves the AI off
 * its own solution, it eats shots on the wreckage, and it fouls the gunner
 * outright now and again.
 *
 * The floor below is the one the rework has to keep. An AI that lands nothing
 * cannot lose a fight to the player either, and a battle where the enemy never
 * scores is not a battle. If a later change drops this under about a fifth,
 * the fight has stopped being one; if it climbs back over about a half, the
 * gunner is the thing the owner asked to have fixed all over again.
 */
describe('battle: the whole system, on the sea the game is played on', () => {
  it('reaches an outcome every time, and the AI lands enough to be a threat', () => {
    let shots = 0;
    let hits = 0;
    let decided = 0;
    for (let fight = 0; fight < 200; fight++) {
      const sim = createBattleSim(mulberry32(0x1000 + fight), ROUGH);
      for (let i = 0; i < (BATTLE_TIMEOUT + 1) / DT; i++) {
        sim.update(DT, IDLE);
        shots += count(sim.state, 'fire', 'ai');
        hits += count(sim.state, 'hit', 'ai');
        if (sim.state.outcome !== null) break;
      }
      // The timeout is itself an outcome, so a fight that hangs is the only
      // way this can fail — and it is exactly what a sim that stopped
      // advancing, or a raft that fouled a hull forever, would look like.
      if (sim.state.outcome !== null) decided++;
    }
    expect(decided).toBe(200);
    expect(shots).toBeGreaterThan(200 * HITS_TO_LOSE);
    const rate = hits / shots;
    expect(rate).toBeGreaterThan(0.2);
    expect(rate).toBeLessThan(0.45);
  });
});
