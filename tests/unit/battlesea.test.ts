import { describe, it, expect } from 'vitest';
import {
  ARENA_OMEGA,
  ARENA_R0,
  ARENA_R_MIN,
  BALL_SPEED,
  createBattleSim,
} from '../../src/battle';
import {
  CREST_FULL_LENGTH,
  CREST_LENGTH_MAX_FRAC,
  CREST_LENGTH_MIN_FRAC,
  CREST_MAX,
  CREST_SPEED_MAX,
  CREST_SPEED_MIN,
  FLOTSAM_COUNT_MAX,
  FLOTSAM_COUNT_MIN,
  FLOTSAM_R_MAX,
  FLOTSAM_R_MIN,
  FLOTSAM_SPEED_MAX,
  FLOTSAM_SPEED_MIN,
  FOUL_SECONDS,
  KEEL_CLEARANCE,
  ROUGH,
  SWAY_MAX,
  SWAY_MIN,
  createBattleSea,
} from '../../src/battlesea';
import type { SwayTarget } from '../../src/battlesea';
import { mulberry32 } from '../../src/towns';
import type { BattleEvent, BattleInput, BattleState } from '../../src/types';

/**
 * `battlesea.ts`'s rule set: the crests' shove and its decay, the keel clamp
 * that keeps a shoved hull out of the middle of its own circle, the fleet of
 * rafts and their own sizes and speeds, the segment-vs-circle `strike` test a
 * ball is judged on, and a raft's foul-and-sink behaviour.
 *
 * Most of this is tested directly against `createBattleSea`, which is the only
 * way to hold a hull's track angle perfectly still while the sea works on it —
 * a hull driven through `createBattleSim` is always turning, if only at the
 * base rate. The two cases that are about the sea's effect ON THE FIGHT (a
 * blocked shot's event, a fouled hull's halved helm) go through
 * `createBattleSim` instead, because that interaction is the point of them.
 *
 * The shoals and wrecks these tests used to cover are gone: everything in the
 * water drifts now. What they proved — that a ball is eaten by a circle it is
 * swept through, and that the gunner does not read a different random stream
 * because of it — is proved against the rafts instead, here and in
 * `battle.test.ts`.
 */

const DT = 1 / 60;
const IDLE: BattleInput = { fire: false, faster: false, slower: false };

/** A minimal, mutable stand-in for a hull's track, for testing the sea alone. */
function hull(angle: number): SwayTarget & { angle: number } {
  return { angle, swayX: 0, swayZ: 0, fouled: 0, cooldown: 0 };
}

/**
 * A source that returns each of `values` in turn, then `tail` forever after.
 *
 * `tail` matters now in a way it did not when one crest ran at a time: the
 * sea goes on launching waves behind the one a case is watching, and the tail
 * is what decides where those land. Every case below picks a tail that keeps
 * them off the hull under test.
 */
function fakeRng(values: number[], tail = 0.5): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : tail);
}

/**
 * The live array `battlesea.ts` is mutating.
 *
 * `BattleState.flotsam` is a getter onto the sea's own array, so a case that
 * wants one raft on the water and no others has to empty THAT array rather
 * than assign a new one over the getter.
 */
function fleet(sim: ReturnType<typeof createBattleSim>): Array<{
  x: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
}> {
  return sim.state.flotsam as unknown as Array<{
    x: number;
    z: number;
    vx: number;
    vz: number;
    radius: number;
  }>;
}

/** The mutable face of `BattleState`, for the cases that script a ball or a hull by hand. */
type MutableState = {
  -readonly [K in keyof BattleState]: BattleState[K];
} & {
  player: BattleState['player'] & { angle: number };
  ai: BattleState['ai'] & { angle: number };
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

describe('battlesea: crests', () => {
  it('shoves an idle hull east between SWAY_MIN and SWAY_MAX at the peak, settles back under 0.1 within 4s, and never touches its track angle', () => {
    // The draws a crest takes, in order: the first delay (0 -> CREST_FIRST_MIN,
    // so it launches quickly), then the axis, the speed, the length and the
    // offset. AXES is [north, south, east, west], so 0.6 lands on index 2,
    // 'east'; the 1 on the length rolls a full-width crest, which the room
    // calculation then forces to offset 0 — a wave that cannot be dodged, so
    // the shove is guaranteed and the peak is what is under test.
    //
    // The tail of 0 is what keeps the rest of the sea out of this case: every
    // crest launched after it comes out shortest, slowest and pushed to the
    // far end of a `north` line, which is nowhere near a hull parked at
    // angle 0. Only the first wave here ever touches the player.
    const rng = fakeRng([0, 0.6, 0.5, 1, 0.5], 0);
    const sea = createBattleSea(rng, { waves: true, flotsam: false });

    const player = hull(0); // trackX = ARENA_R0, trackZ = 0
    const ai = hull(Math.PI); // out of the way; the east crest reaches it first, which must not touch `player`
    const radius = ARENA_R0;
    const events: BattleEvent[] = [];

    // Twelve seconds: the crest launches at CREST_FIRST_MIN and then has 48
    // units to cover at the 6.5 units/s the 0.5 rolled, which is 7.4 of them.
    let elapsed = 0;
    let peak = 0;
    for (let i = 0; i < 12 / DT; i++) {
      elapsed += DT;
      sea.update(DT, elapsed, radius, player, ai, events);
      if (player.swayX > peak) peak = player.swayX;
    }

    expect(peak).toBeGreaterThanOrEqual(SWAY_MIN);
    expect(peak).toBeLessThanOrEqual(SWAY_MAX);
    expect(player.angle).toBe(0);

    // Four more seconds. Other crests are running by now — the gaps are short
    // and three may be alive at once — but see the tail above: none of them
    // can reach this hull while its own pulse dies away.
    for (let i = 0; i < 4 / DT; i++) {
      elapsed += DT;
      sea.update(DT, elapsed, radius, player, ai, events);
    }
    expect(Math.hypot(player.swayX, player.swayZ)).toBeLessThan(0.1);
  });

  it('runs up to CREST_MAX at once, each with its own speed, length and place on its own line', () => {
    const sea = createBattleSea(mulberry32(0xc7e5), { waves: true, flotsam: false });
    const player = hull(0);
    const ai = hull(Math.PI / 2);
    const events: BattleEvent[] = [];

    let most = 0;
    let seenShort = false;
    const speeds = new Set<number>();
    let elapsed = 0;
    for (let i = 0; i < 120 / DT; i++) {
      elapsed += DT;
      player.angle += ARENA_OMEGA * DT;
      ai.angle += ARENA_OMEGA * DT;
      sea.update(DT, elapsed, ARENA_R0, player, ai, events);

      most = Math.max(most, sea.state.crests.length);
      // The ceiling is a hard rule, not a tendency.
      expect(sea.state.crests.length).toBeLessThanOrEqual(CREST_MAX);
      for (const crest of sea.state.crests) {
        speeds.add(crest.speed);
        expect(crest.speed).toBeGreaterThanOrEqual(CREST_SPEED_MIN);
        expect(crest.speed).toBeLessThanOrEqual(CREST_SPEED_MAX);
        expect(crest.length).toBeGreaterThanOrEqual(CREST_FULL_LENGTH * CREST_LENGTH_MIN_FRAC);
        expect(crest.length).toBeLessThanOrEqual(CREST_FULL_LENGTH * CREST_LENGTH_MAX_FRAC);
        if (crest.length < CREST_FULL_LENGTH * 0.9) seenShort = true;
        // Whatever its length, the whole segment lies over the arena's width:
        // a crest is never mostly sweeping water outside the ring.
        expect(Math.abs(crest.offset) + crest.length / 2).toBeLessThanOrEqual(
          CREST_FULL_LENGTH / 2 + 1e-9,
        );
      }
    }

    expect(most).toBe(CREST_MAX);
    expect(seenShort).toBe(true);
    // Speeds are rolled per crest off a continuous range, so two minutes of
    // sea that produced one repeated figure would mean they are shared.
    expect(speeds.size).toBeGreaterThan(5);
  });

  it('lets a short crest pass a hull that is not under it', () => {
    // A `north` crest (AXES index 0) travelling +z, at the shortest length
    // the sim rolls and pushed as far along its own line as the room allows.
    // The line for `north` is +x, so the crest sits far out on +x and the
    // hull is parked at the opposite end of the same line.
    const shortest = CREST_FULL_LENGTH * CREST_LENGTH_MIN_FRAC;
    // Tail 0 again, and for a sharper reason here: this case asserts a hull
    // was touched by NOTHING, so every wave behind the first has to miss it
    // too. At 0 they are all short, slow `north` crests pushed to the +x end
    // of their line, and the hull is parked at the -x end of it.
    const rng = fakeRng([0, 0, 0.5, 0, 1], 0);
    const sea = createBattleSea(rng, { waves: true, flotsam: false });

    const player = hull(Math.PI); // trackX = -ARENA_R0: the far end of the crest's line
    const ai = hull(-Math.PI / 2);
    const events: BattleEvent[] = [];

    // Eight seconds. The crest launches at 2 and passes this hull's own
    // along-coordinate 4.3 later, so it is well by; the next one is slower
    // and cannot reach it inside the window at all.
    let elapsed = 0;
    for (let i = 0; i < 8 / DT; i++) {
      elapsed += DT;
      sea.update(DT, elapsed, ARENA_R0, player, ai, events);
    }

    // The crest was rolled short and off to one side, and the hull sat at the
    // other: it has been passed and never touched. A full-width crest would
    // have thrown it several units.
    expect(shortest).toBeLessThan(CREST_FULL_LENGTH);
    expect(Math.hypot(player.swayX, player.swayZ)).toBe(0);
  });

  it('never lets either hull fall under KEEL_CLEARANCE, across 60s of crests at the tightest radius the ring ever reaches', () => {
    const sea = createBattleSea(mulberry32(0xbeef), { waves: true, flotsam: false });
    const player = hull(0);
    const ai = hull(Math.PI / 2);
    const events: BattleEvent[] = [];
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
    const sea = createBattleSea(mulberry32(9), { waves: false, flotsam: false });
    const player = hull(0);
    const ai = hull(Math.PI);
    const events: BattleEvent[] = [];
    for (let i = 0; i < 30 / DT; i++) {
      sea.update(DT, i * DT, ARENA_R0, player, ai, events);
    }
    expect(sea.state.crests).toEqual([]);
    expect(player.swayX).toBe(0);
    expect(player.swayZ).toBe(0);
  });
});

describe('battlesea: flotsam', () => {
  it('opens with FLOTSAM_COUNT_MIN to MAX rafts already spread across the arena, no two alike', () => {
    const radii = new Set<number>();
    const speeds = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const sim = createBattleSim(mulberry32(0xf1a + seed), { waves: false, flotsam: true });
      const fleet = sim.state.flotsam;
      expect(fleet.length).toBeGreaterThanOrEqual(FLOTSAM_COUNT_MIN);
      expect(fleet.length).toBeLessThanOrEqual(FLOTSAM_COUNT_MAX);
      for (const raft of fleet) {
        radii.add(raft.radius);
        expect(raft.radius).toBeGreaterThanOrEqual(FLOTSAM_R_MIN);
        expect(raft.radius).toBeLessThanOrEqual(FLOTSAM_R_MAX);
        const speed = Math.hypot(raft.vx, raft.vz);
        speeds.add(speed);
        expect(speed).toBeGreaterThanOrEqual(FLOTSAM_SPEED_MIN - 1e-9);
        expect(speed).toBeLessThanOrEqual(FLOTSAM_SPEED_MAX + 1e-9);
      }
    }
    // Both are rolled per raft off a continuous range: a handful of distinct
    // values across forty fleets would mean they are shared again.
    expect(radii.size).toBeGreaterThan(50);
    expect(speeds.size).toBeGreaterThan(50);
  });

  it('keeps the fleet up to strength as rafts are lost', () => {
    const sim = createBattleSim(mulberry32(0x1eee), { waves: false, flotsam: true });
    const target = sim.state.flotsam.length;

    // Sink the lot, the way a ball would.
    fleet(sim).length = 0;
    let restored = 0;
    for (let i = 0; i < 120 / DT; i++) {
      sim.update(DT, IDLE);
      restored = Math.max(restored, sim.state.flotsam.length);
      // The target is a ceiling as well as a floor: nothing may pile up past it.
      expect(sim.state.flotsam.length).toBeLessThanOrEqual(target);
    }
    expect(restored).toBe(target);
  });

  it('fouls a hull it drifts onto for FOUL_SECONDS, halves its angular speed for exactly that long, and is gone afterward', () => {
    const sim = createBattleSim(mulberry32(0x1234), { waves: false, flotsam: true });
    // Clear the water down to ONE raft, then walk it onto the player and stop
    // it there, rather than waiting on a fleet's own random aim to cross the
    // hull -- what matters here is what contact DOES.
    const only = sim.state.flotsam[0];
    fleet(sim).splice(1);
    const raft = only as { x: number; z: number; vx: number; vz: number };
    raft.x = sim.state.player.x;
    raft.z = sim.state.player.z;
    raft.vx = 0;
    raft.vz = 0;

    sim.update(DT, IDLE);
    expect(sim.state.player.fouled).toBeCloseTo(FOUL_SECONDS, 5);
    expect(sim.state.flotsam.includes(only)).toBe(false);
    const fouled = sim.state.events.find((e) => e.kind === 'foul' && e.owner === 'player');
    expect(fouled).toBeDefined();

    // Half the base rate for exactly one tick right after the foul.
    const angleBefore = sim.state.player.angle;
    sim.update(DT, IDLE);
    expect(sim.state.player.angle - angleBefore).toBeCloseTo(ARENA_OMEGA * 0.5 * DT, 10);

    // Run out the clock, then confirm the very next tick is back at full rate.
    // A replacement raft may launch in the meantime; it is born outside the
    // ring and cannot reach the hull inside this window.
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
    const sim = createBattleSim(mulberry32(11), { waves: false, flotsam: false });
    for (let i = 0; i < 30 * 60; i++) sim.update(DT, IDLE);
    expect(sim.state.flotsam).toEqual([]);
  });

  it('sinks with a strike when a ball is swept through it, and lets a ball that misses splash', () => {
    /**
     * One raft, parked in the open water between the two hulls' tracks, and a
     * ball walked into it. Both hulls are pushed to the top and bottom of the
     * ring first so that nothing here can coincidentally collide with a hull:
     * this is a test of the raft, not of the fight.
     */
    function parked(seed: number): ReturnType<typeof createBattleSim> {
      const sim = createBattleSim(mulberry32(seed), { waves: false, flotsam: true });
      const s = mutable(sim.state);
      s.player.angle = Math.PI / 2;
      s.ai.angle = -Math.PI / 2;
      fleet(sim).splice(1);
      const raft = fleet(sim)[0];
      raft.x = 0;
      raft.z = 0;
      raft.vx = 0;
      raft.vz = 0;
      return sim;
    }

    const hit = parked(0x5a17);
    const target = hit.state.flotsam[0];
    mutable(hit.state).balls.push({
      owner: 'player',
      x: target.x - target.radius - 5,
      z: target.z,
      vx: BALL_SPEED,
      vz: 0,
      age: 0,
      crossed: false,
    });
    let strikes = 0;
    let splashes = 0;
    for (let i = 0; i < 30; i++) {
      hit.update(DT, IDLE);
      for (const e of hit.state.events) {
        if (e.owner !== 'player') continue;
        if (e.kind === 'strike') strikes++;
        if (e.kind === 'splash') splashes++;
      }
    }
    expect(strikes).toBe(1);
    expect(splashes).toBe(0);
    expect(hit.state.flotsam.includes(target)).toBe(false);

    const miss = parked(0x5a17);
    const spared = miss.state.flotsam[0];
    mutable(miss.state).balls.push({
      owner: 'player',
      x: spared.x - spared.radius - 5,
      // Clear of the circle by a healthy 3 units, on the same track the hit
      // case fired down the middle of.
      z: spared.z + spared.radius + 3,
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

describe('battlesea: determinism', () => {
  it('two sims built from the same seed and driven the same way agree on every position after 60s', () => {
    function runFor(seconds: number, seed: number): BattleState {
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
    // The sea itself, not merely the hulls it moved.
    expect(a.crests).toEqual(b.crests);
    expect(a.flotsam).toEqual(b.flotsam);
  });
});
