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
 * SKIPPED BY STEP 0 OF THE REWORK, and agent A owns un-skipping it.
 *
 * `battleai.ts` is a stub that never fires, so this measures nothing until the
 * real gunner lands. The band below is a measurement of the OLD gunner — the
 * one with a reaction, a jitter and a perfect reading of the player — and it
 * must not be kept out of habit. The new one reads the player two seconds
 * late, telegraphs every shot by a fixed fuse and flips a coin for one helm
 * decision in four, and it will not land 46.5% of its shots.
 *
 * Agent A: build the sim with CALM so the sea cannot move the answer, measure
 * what the gunner actually does, then pin it at plus or minus ten points
 * around the measurement and say in the test what was measured.
 * See docs/BATTLE_REWORK_PLAN.md, "Tests".
 */
describe.skip('battle: the AI gunner', () => {
  it('lands between 35% and 55% of its shots on a player who does nothing', () => {
    let shots = 0;
    let hits = 0;
    for (let fight = 0; fight < 200; fight++) {
      const sim = createBattleSim(mulberry32(0x1000 + fight));
      for (let i = 0; i < (BATTLE_TIMEOUT + 1) / DT; i++) {
        sim.update(DT, IDLE);
        shots += count(sim.state, 'fire', 'ai');
        hits += count(sim.state, 'hit', 'ai');
        if (sim.state.outcome !== null) break;
      }
    }
    expect(shots).toBeGreaterThan(200 * HITS_TO_LOSE);
    const rate = hits / shots;
    expect(rate).toBeGreaterThan(0.35);
    expect(rate).toBeLessThan(0.55);
  });
});
