import { describe, it, expect } from 'vitest';
import {
  ARENA_OMEGA,
  ARENA_R0,
  ARENA_R_MIN,
  BALL_SPEED,
  createBattleSim,
} from '../../src/battle';
import {
  FOUL_SECONDS,
  KEEL_CLEARANCE,
  OBSTACLE_R_INNER,
  OBSTACLE_ZONE,
  ROUGH,
  SWAY_MAX,
  SWAY_MIN,
  createBattleSea,
} from '../../src/battlesea';
import type { SwayTarget } from '../../src/battlesea';
import { mulberry32 } from '../../src/towns';
import type { BattleInput, BattleState } from '../../src/types';

/**
 * `battlesea.ts`'s rule set: the crest's shove and its decay, the keel clamp
 * that keeps a shoved hull off the shoals, the obstacles rolled once and
 * never overlapping, the segment-vs-circle `strike` test both the shoals and
 * the raft are judged on, and the raft's own foul-and-sink behaviour.
 *
 * Most of this is tested directly against `createBattleSea`, which is the
 * only way to hold a hull's track angle perfectly still while the sea works
 * on it — a hull driven through `createBattleSim` is always turning, if only
 * at the base rate. The two cases that are about the sea's effect ON THE
 * FIGHT (a blocked shot's event, a fouled hull's halved helm) go through
 * `createBattleSim` instead, because that interaction is the point of them.
 */

const DT = 1 / 60;
const IDLE: BattleInput = { fire: false, faster: false, slower: false };

/** A minimal, mutable stand-in for a hull's track, for testing the sea alone. */
function hull(angle: number): SwayTarget & { angle: number } {
  return { angle, swayX: 0, swayZ: 0, fouled: 0, cooldown: 0 };
}

/** A source that returns each of `values` in turn, then 0.5 forever after. */
function fakeRng(values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0.5);
}

/** The mutable face of `BattleState`, for the cases that script a ball by hand. */
type MutableState = {
  -readonly [K in keyof BattleState]: BattleState[K];
} & {
  balls: Array<{
    owner: 'player' | 'ai';
    x: number;
    z: number;
    vx: number;
    vz: number;
    age: number;
    crossed: boolean;
  }>;
};
function mutable(state: BattleState): MutableState {
  return state as unknown as MutableState;
}

describe('battlesea: shoals and wreckage', () => {
  it('rolls 1 to 3 non-overlapping obstacles, each between OBSTACLE_R_INNER and OBSTACLE_ZONE of the centre, reproducibly from one seed', () => {
    for (const seed of [1, 2, 3, 0xf00d, 0xbeef, 0x1234, 0xa11ce]) {
      const a = createBattleSea(mulberry32(seed), { waves: false, shoals: true, flotsam: false });
      const b = createBattleSea(mulberry32(seed), { waves: false, shoals: true, flotsam: false });
      // Same seed, same obstacles, to the object: the roll draws from nothing
      // but `rng`.
      expect(a.state.obstacles).toEqual(b.state.obstacles);

      const obs = a.state.obstacles;
      expect(obs.length).toBeGreaterThanOrEqual(1);
      expect(obs.length).toBeLessThanOrEqual(3);
      for (const o of obs) {
        const dist = Math.hypot(o.x, o.z);
        expect(dist).toBeGreaterThanOrEqual(OBSTACLE_R_INNER);
        expect(dist).toBeLessThanOrEqual(OBSTACLE_ZONE);
      }
      for (let i = 0; i < obs.length; i++) {
        for (let j = i + 1; j < obs.length; j++) {
          const d = Math.hypot(obs[i].x - obs[j].x, obs[i].z - obs[j].z);
          expect(d).toBeGreaterThanOrEqual(obs[i].radius + obs[j].radius);
        }
      }
    }
  });

  it('produces no obstacles at all when shoals are off', () => {
    const sea = createBattleSea(mulberry32(7), { waves: false, shoals: false, flotsam: false });
    expect(sea.state.obstacles).toEqual([]);
  });

  it('blocks a shot that crosses one with a strike and no splash, and lets one that misses splash with no strike', () => {
    // Both hulls parked well off the obstacle zone's own z-range (±5.5 at the
    // outside), so nothing here can coincidentally collide with a hull —
    // this is a test of the shoal, not of the ring.
    function parkedSim(seed: number) {
      const sim = createBattleSim(mulberry32(seed), { waves: false, shoals: true, flotsam: false });
      const s = mutable(sim.state);
      s.player.angle = Math.PI / 2;
      s.ai.angle = -Math.PI / 2;
      return sim;
    }

    const hit = parkedSim(0x50a1);
    const obs = hit.state.obstacles[0];
    expect(obs).toBeDefined();
    mutable(hit.state).balls.push({
      owner: 'player',
      x: obs.x - obs.radius - 5,
      z: obs.z,
      vx: BALL_SPEED,
      vz: 0,
      age: 0,
      crossed: false,
    });
    let hitStrikes = 0;
    let hitSplashes = 0;
    for (let i = 0; i < 60; i++) {
      hit.update(DT, IDLE);
      for (const e of hit.state.events) {
        if (e.owner !== 'player') continue;
        if (e.kind === 'strike') hitStrikes++;
        if (e.kind === 'splash') hitSplashes++;
      }
    }
    expect(hitStrikes).toBeGreaterThanOrEqual(1);
    expect(hitSplashes).toBe(0);

    const miss = parkedSim(0x50a1);
    const obs2 = miss.state.obstacles[0];
    mutable(miss.state).balls.push({
      owner: 'player',
      x: obs2.x - obs2.radius - 5,
      // Clear of the circle by a healthy 3 units, on the same track the hit
      // case fired down the middle of.
      z: obs2.z + obs2.radius + 3,
      vx: BALL_SPEED,
      vz: 0,
      age: 0,
      crossed: false,
    });
    let missStrikes = 0;
    let missSplashes = 0;
    for (let i = 0; i < 200; i++) {
      miss.update(DT, IDLE);
      for (const e of miss.state.events) {
        if (e.owner !== 'player') continue;
        if (e.kind === 'strike') missStrikes++;
        if (e.kind === 'splash') missSplashes++;
      }
    }
    expect(missSplashes).toBeGreaterThanOrEqual(1);
    expect(missStrikes).toBe(0);
  });
});

describe('battlesea: crests', () => {
  it('shoves an idle hull east between SWAY_MIN and SWAY_MAX at the peak, settles back under 0.1 within 4s, and never touches its track angle', () => {
    // The first draw is the first crest's delay (0 -> CREST_FIRST_MIN, so it
    // launches quickly); the second is the axis roll. AXES is
    // [north, south, east, west], so 0.6 lands on index 2, 'east'.
    const rng = fakeRng([0, 0.6]);
    const sea = createBattleSea(rng, { waves: true, shoals: false, flotsam: false });

    const player = hull(0); // trackX = ARENA_R0, trackZ = 0
    const ai = hull(Math.PI); // out of the way; the east crest reaches it first, which must not touch `player`
    const radius = ARENA_R0;
    const events: import('../../src/types').BattleEvent[] = [];

    let elapsed = 0;
    let peak = 0;
    for (let i = 0; i < 20 / DT; i++) {
      elapsed += DT;
      sea.update(DT, elapsed, radius, player, ai, events);
      if (player.swayX > peak) peak = player.swayX;
    }

    expect(peak).toBeGreaterThanOrEqual(SWAY_MIN);
    expect(peak).toBeLessThanOrEqual(SWAY_MAX);
    expect(player.angle).toBe(0);

    // Four more seconds, well clear of the next crest (its gap alone is at
    // least CREST_GAP_MIN = 9s after this one drops).
    for (let i = 0; i < 4 / DT; i++) {
      elapsed += DT;
      sea.update(DT, elapsed, radius, player, ai, events);
    }
    expect(Math.hypot(player.swayX, player.swayZ)).toBeLessThan(0.1);
  });

  it('never lets either hull fall under KEEL_CLEARANCE, across 60s of crests at the tightest radius the ring ever reaches', () => {
    const sea = createBattleSea(mulberry32(0xbeef), { waves: true, shoals: false, flotsam: false });
    const player = hull(0);
    const ai = hull(Math.PI / 2);
    const events: import('../../src/types').BattleEvent[] = [];
    // ARENA_R_MIN is the ring's tightest point, where the clamp has the
    // least room to work with -- the tightest a wave's inward shove can ever
    // be tested against.
    const radius = ARENA_R_MIN;

    let elapsed = 0;
    for (let i = 0; i < 60 / DT; i++) {
      elapsed += DT;
      // The hulls keep travelling their own tracks, as a real fight's would.
      player.angle += ARENA_OMEGA * DT;
      ai.angle += ARENA_OMEGA * DT;
      sea.update(DT, elapsed, radius, player, ai, events);

      const pd = Math.hypot(
        radius * Math.cos(player.angle) + player.swayX,
        radius * Math.sin(player.angle) + player.swayZ,
      );
      const ad = Math.hypot(
        radius * Math.cos(ai.angle) + ai.swayX,
        radius * Math.sin(ai.angle) + ai.swayZ,
      );
      expect(pd).toBeGreaterThanOrEqual(KEEL_CLEARANCE - 1e-9);
      expect(ad).toBeGreaterThanOrEqual(KEEL_CLEARANCE - 1e-9);
    }
  });

  it('produces no crest at all when waves are off', () => {
    const sea = createBattleSea(mulberry32(9), { waves: false, shoals: false, flotsam: false });
    const player = hull(0);
    const ai = hull(Math.PI);
    const events: import('../../src/types').BattleEvent[] = [];
    for (let i = 0; i < 30 / DT; i++) {
      sea.update(DT, i * DT, ARENA_R0, player, ai, events);
    }
    expect(sea.state.crest).toBe(null);
    expect(player.swayX).toBe(0);
    expect(player.swayZ).toBe(0);
  });
});

describe('battlesea: flotsam', () => {
  /** Run `sim` until a raft exists, then hand it back for the test to steer. */
  function waitForRaft(sim: ReturnType<typeof createBattleSim>): void {
    let guard = 0;
    while (sim.state.flotsam === null) {
      sim.update(DT, IDLE);
      if (++guard > 10 * 60 * 60) throw new Error('no raft launched in 10 simulated minutes');
    }
  }

  it('fouls a hull it drifts onto for FOUL_SECONDS, halves its angular speed for exactly that long, and is gone afterward', () => {
    const sim = createBattleSim(mulberry32(0x1234), { waves: false, shoals: false, flotsam: true });
    waitForRaft(sim);

    // Walk the raft onto the player and stop it there, rather than waiting on
    // its own random aim to cross the hull -- what matters here is what
    // contact DOES, not whether one particular seed's raft happens to find it.
    const raft = sim.state.flotsam as { x: number; z: number; vx: number; vz: number };
    raft.x = sim.state.player.x;
    raft.z = sim.state.player.z;
    raft.vx = 0;
    raft.vz = 0;

    sim.update(DT, IDLE);
    expect(sim.state.player.fouled).toBeCloseTo(FOUL_SECONDS, 5);
    expect(sim.state.flotsam).toBe(null);
    const fouled = sim.state.events.find((e) => e.kind === 'foul' && e.owner === 'player');
    expect(fouled).toBeDefined();

    // Half the base rate for exactly one tick right after the foul.
    const angleBefore = sim.state.player.angle;
    sim.update(DT, IDLE);
    expect(sim.state.player.angle - angleBefore).toBeCloseTo(ARENA_OMEGA * 0.5 * DT, 10);

    // Run out the clock, then confirm the very next tick is back at full rate.
    let ticks = 1;
    while (sim.state.player.fouled > 0) {
      sim.update(DT, IDLE);
      ticks++;
    }
    expect(ticks * DT).toBeCloseTo(FOUL_SECONDS, 1);
    const angleAfter = sim.state.player.angle;
    sim.update(DT, IDLE);
    expect(sim.state.player.angle - angleAfter).toBeCloseTo(ARENA_OMEGA * DT, 10);
  });

  it('produces no raft at all when flotsam is off', () => {
    const sim = createBattleSim(mulberry32(11), { waves: false, shoals: false, flotsam: false });
    for (let i = 0; i < 30 * 60; i++) sim.update(DT, IDLE);
    expect(sim.state.flotsam).toBe(null);
  });

  it('sinks with a strike when a ball is swept through it', () => {
    const sim = createBattleSim(mulberry32(0x5a17), { waves: false, shoals: false, flotsam: true });
    waitForRaft(sim);
    // A raft is born a healthy margin outside the ring -- beyond where a ball
    // is ever still in flight rather than already splashed -- and only
    // becomes reachable once its own drift has carried it back in. Let it
    // drift to a spot comfortably inside the ring before testing contact,
    // the same way a player would only ever meet one that has come to them.
    let guard = 0;
    while (sim.state.flotsam !== null && Math.hypot(sim.state.flotsam.x, sim.state.flotsam.z) > 8) {
      sim.update(DT, IDLE);
      if (++guard > 20 * 60 * 60) throw new Error('raft never drifted into reach');
    }
    expect(sim.state.flotsam).not.toBe(null);

    const raft = sim.state.flotsam as { x: number; z: number; vx: number; vz: number };
    raft.vx = 0;
    raft.vz = 0;
    mutable(sim.state).balls.push({
      owner: 'player',
      x: raft.x - 5,
      z: raft.z,
      vx: BALL_SPEED,
      vz: 0,
      age: 0,
      crossed: false,
    });

    let strikes = 0;
    for (let i = 0; i < 30; i++) {
      sim.update(DT, IDLE);
      for (const e of sim.state.events) if (e.kind === 'strike' && e.owner === 'player') strikes++;
    }
    expect(strikes).toBe(1);
    expect(sim.state.flotsam).toBe(null);
  });
});

describe('battlesea: determinism', () => {
  it('two sims built from the same seed and driven the same way agree on every position after 60s', () => {
    function runFor(seconds: number, seed: number) {
      const sim = createBattleSim(mulberry32(seed), ROUGH);
      for (let i = 0; i < seconds / DT; i++) {
        const t = i * DT;
        // A fully deterministic script that actually moves the helm and
        // pulls the trigger, rather than 60 seconds of standing still.
        const input: BattleInput = {
          fire: Math.floor(t * 3) % 2 === 0,
          faster: Math.floor(t) % 4 === 0,
          slower: Math.floor(t) % 4 === 2,
        };
        sim.update(DT, input);
      }
      return sim.state;
    }

    const a = runFor(60, 0x5eed);
    const b = runFor(60, 0x5eed);
    expect(a.player.x).toBe(b.player.x);
    expect(a.player.z).toBe(b.player.z);
    expect(a.ai.x).toBe(b.ai.x);
    expect(a.ai.z).toBe(b.ai.z);
    expect(a.player.angle).toBe(b.player.angle);
    expect(a.ai.angle).toBe(b.ai.angle);
    expect(a.elapsed).toBe(b.elapsed);
    expect(a.outcome).toBe(b.outcome);
  });
});
