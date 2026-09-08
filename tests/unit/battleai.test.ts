import { describe, it, expect } from 'vitest';
import { ARENA_OMEGA, ARENA_R0, THROTTLE_GAIN, createBattleSim } from '../../src/battle';
import {
  AI_FUSE,
  AI_HELM_PERIOD,
  createBattleAi,
} from '../../src/battleai';
import { CALM } from '../../src/battlesea';
import { mulberry32 } from '../../src/towns';
import type { BattleInput, BattleState, Combatant } from '../../src/types';

/**
 * `battleai.ts` in isolation: the delay line, the helm's coin and the fuse.
 *
 * The gunner's measured hit rate on a calm sea is pinned in
 * `tests/unit/battle.test.ts` instead, alongside the rest of `battle.ts`'s
 * outcome tests, since it has to run through the whole sim to mean anything.
 */

const DT = 1 / 60;
const IDLE: BattleInput = { fire: false, faster: false, slower: false };

/** A `Combatant` with only the fields `observe` reads set to something real. */
function playerAt(angle: number, swayX = 0, swayZ = 0): Combatant {
  return {
    angle,
    x: 0,
    z: 0,
    heading: 0,
    rounds: 0,
    hits: 0,
    cooldown: 0,
    swayX,
    swayZ,
    fouled: 0,
  };
}

/** A `BattleState` with only the fields `throttle` and `gun` read set. */
function fakeState(overrides: {
  elapsed?: number;
  radius?: number;
  aiAngle?: number;
  aiX?: number;
  aiZ?: number;
  aiRounds?: number;
  aiCooldown?: number;
  aiFouled?: number;
}): BattleState {
  const radius = overrides.radius ?? ARENA_R0;
  const aiAngle = overrides.aiAngle ?? 0;
  return {
    radius,
    elapsed: overrides.elapsed ?? 0,
    player: playerAt(Math.PI),
    ai: {
      angle: aiAngle,
      x: overrides.aiX ?? radius * Math.cos(aiAngle),
      z: overrides.aiZ ?? radius * Math.sin(aiAngle),
      heading: 0,
      rounds: overrides.aiRounds ?? 10,
      hits: 0,
      cooldown: overrides.aiCooldown ?? 0,
      swayX: 0,
      swayZ: 0,
      fouled: overrides.aiFouled ?? 0,
    },
    balls: [],
    outcome: null,
    events: [],
    fuse: null,
    crest: null,
    obstacles: [],
    flotsam: null,
  } as BattleState;
}

/** The mutable face of `BattleState`, for reaching in the way `battle.test.ts` does. */
type Mutable = {
  -readonly [K in keyof BattleState]: BattleState[K];
} & { ai: Combatant & { fouled: number } };

function mutable(state: BattleState): Mutable {
  return state as unknown as Mutable;
}

function countEvents(state: BattleState, kind: 'aim' | 'fire', owner: 'player' | 'ai'): number {
  let n = 0;
  for (const e of state.events) if (e.kind === kind && e.owner === owner) n++;
  return n;
}

describe('battleai: the delay line', () => {
  it('reads a player who holds S from t=5 at the base rate until t=7, and slowed after', () => {
    const ai = createBattleAi(mulberry32(1));
    const baseOmega = ARENA_OMEGA;
    const slowOmega = ARENA_OMEGA * (1 - THROTTLE_GAIN);

    let angle = Math.PI;
    let elapsed = 0;
    // Drive the delay line by hand: no throttle logic here, just the truth
    // `observe` would be handed every tick, with the S press landing at t=5.
    while (elapsed < 9) {
      elapsed += DT;
      const omega = elapsed >= 5 ? slowOmega : baseOmega;
      angle += omega * DT;
      ai.observe(elapsed, playerAt(angle), omega);
    }

    // Rerun to the two check points, well clear of the t=7 boundary itself
    // (AI_LAG=2 stale, so the S press at t=5 only reaches the view at t=7),
    // so a tick of slop either way cannot flip the answer.
    function viewOmegaAt(target: number): number {
      const ai2 = createBattleAi(mulberry32(1));
      let a = Math.PI;
      let e = 0;
      while (e < target) {
        e += DT;
        const omega = e >= 5 ? slowOmega : baseOmega;
        a += omega * DT;
        ai2.observe(e, playerAt(a), omega);
      }
      return ai2.view!.omega;
    }

    expect(viewOmegaAt(6.9)).toBeCloseTo(baseOmega, 5);
    expect(viewOmegaAt(7.1)).toBeCloseTo(slowOmega, 5);
  });

  it('has a view from the first tick, seeded at the starting reading', () => {
    const ai = createBattleAi(mulberry32(2));
    expect(ai.view).toBeNull();
    ai.observe(DT, playerAt(Math.PI), ARENA_OMEGA);
    expect(ai.view).not.toBeNull();
    expect(ai.view!.angle).toBeCloseTo(Math.PI, 5);
    expect(ai.view!.omega).toBeCloseTo(ARENA_OMEGA, 5);
  });
});

describe('battleai: the helm coin', () => {
  it('flips -1 on 10% to 15% of about 4000 decisions against a fixed positive error', () => {
    const ai = createBattleAi(mulberry32(3));
    // A static, non-moving player sitting well short of dead-opposite the AI
    // (angle 0). `solve` now aims the AI's beam from where its OWN throttle
    // will have carried it AI_FUSE seconds from now, not from where it is
    // this instant, so "dead-opposite" itself moves depending on which way
    // the AI is currently throttling. -1.0 rad is chosen far enough short of
    // either branch's opposite point (0.225 to 0.675 rad away from angle 0,
    // so the true opposite point sits between about 3.37 and 3.82 rad) that
    // the lateral offset stays clearly positive whichever throttle the AI
    // happens to be holding when this is solved — verified below, and the
    // coin is the only thing that can still flip the answer.
    ai.observe(0, playerAt(-1.0), 0);

    const state = fakeState({ elapsed: 10, aiAngle: 0 });

    let minusOnes = 0;
    const decisions = 4000;
    for (let i = 0; i < decisions; i++) {
      const t = ai.throttle(AI_HELM_PERIOD, state);
      if (t === -1) minusOnes++;
    }
    const rate = minusOnes / decisions;
    // A quarter of decisions are a coin, and the coin lands wrong half the
    // time: 0.25 * 0.5 = 12.5%. The other three quarters always read the
    // (fixed, positive) error correctly and never come out -1.
    expect(rate).toBeGreaterThan(0.10);
    expect(rate).toBeLessThan(0.15);
  });

  it('reads a fixed positive error as +1 and a fixed negative one as -1, with the coin off', () => {
    // rng() that never dips under AI_HELM_COIN, so every decision is solved
    // rather than flipped — isolates the sign convention from the coin.
    const noCoin = () => 0.9;

    // A fresh AI's throttle defaults to +1 before its first decision, so
    // `solve`'s self-projection (still unexercised at the moment `throttle`
    // is first called) puts its predicted beam at
    // ARENA_OMEGA*(1+THROTTLE_GAIN)*AI_FUSE rad past angle 0, and the point
    // truly opposite THAT is the reference the sign is tested against — not
    // Math.PI, which was only ever the opposite point of the AI's CURRENT
    // angle, the thing this fix retired.
    const opposite = Math.PI + ARENA_OMEGA * (1 + THROTTLE_GAIN) * AI_FUSE;

    const aiPositive = createBattleAi(noCoin);
    aiPositive.observe(0, playerAt(opposite + 0.1), 0);
    expect(aiPositive.throttle(AI_HELM_PERIOD, fakeState({ elapsed: 10, aiAngle: 0 }))).toBe(1);

    const aiNegative = createBattleAi(noCoin);
    aiNegative.observe(0, playerAt(opposite - 0.1), 0);
    expect(aiNegative.throttle(AI_HELM_PERIOD, fakeState({ elapsed: 10, aiAngle: 0 }))).toBe(-1);
  });
});

describe('battleai: the fuse', () => {
  it('fires every AI fire exactly AI_FUSE after its aim, with state.fuse null outside the window and never negative', () => {
    let sawAny = false;
    for (let seed = 0; seed < 8; seed++) {
      const sim = createBattleSim(mulberry32(0x5eed + seed), CALM);
      let pendingAim: number | null = null;
      for (let i = 0; i < (120 + 1) / DT; i++) {
        sim.update(DT, IDLE);
        const state = sim.state;

        if (countEvents(state, 'aim', 'ai') > 0) {
          expect(pendingAim).toBeNull();
          pendingAim = state.elapsed;
          expect(state.fuse).not.toBeNull();
          expect(state.fuse!).toBeCloseTo(AI_FUSE, 5);
        }
        if (countEvents(state, 'fire', 'ai') > 0) {
          expect(pendingAim).not.toBeNull();
          expect(state.elapsed - pendingAim!).toBeCloseTo(AI_FUSE, 1);
          pendingAim = null;
          sawAny = true;
        }

        if (pendingAim === null) {
          expect(state.fuse).toBeNull();
        } else {
          expect(state.fuse).not.toBeNull();
          expect(state.fuse!).toBeGreaterThanOrEqual(0);
        }

        if (state.outcome !== null) break;
      }
    }
    // A sanity check on the harness itself: if the AI never fired across
    // eight seeded fights, the invariants above were never exercised.
    expect(sawAny).toBe(true);
  });
});

describe('battleai: fouling', () => {
  it('never aims while fouled', () => {
    const sim = createBattleSim(mulberry32(0x100), CALM);
    mutable(sim.state).ai.fouled = 100;
    for (let i = 0; i < 2 / DT; i++) {
      sim.update(DT, IDLE);
      expect(countEvents(sim.state, 'aim', 'ai')).toBe(0);
      expect(sim.state.fuse).toBeNull();
    }
  });

  it('snuffs a fuse lit before a foul, on the tick after the foul lands', () => {
    const sim = createBattleSim(mulberry32(0x200), CALM);
    let fused = false;
    for (let i = 0; i < 60 / DT; i++) {
      sim.update(DT, IDLE);
      if (sim.state.fuse !== null) {
        fused = true;
        break;
      }
    }
    expect(fused).toBe(true);

    // The foul lands between ticks, the way the sea would apply it mid-flow —
    // the AI only sees it the next time `gun` runs.
    mutable(sim.state).ai.fouled = 5;
    sim.update(DT, IDLE);
    expect(sim.state.fuse).toBeNull();
    expect(countEvents(sim.state, 'fire', 'ai')).toBe(0);
  });
});
