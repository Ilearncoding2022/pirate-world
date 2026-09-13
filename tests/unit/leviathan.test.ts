import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  BOW_ARC,
  DESPAWN_RANGE,
  DIAL_PERIOD,
  FADE_OUT,
  HARPOON_MIN_RANGE,
  HARPOON_RANGE,
  ARM_UP,
  AGROUND_SECONDS,
  BODY_LENGTH,
  BODY_SPACING,
  ENDING_FADE,
  FLEE_RADIUS,
  SWEEP_SLOW,
  HUNT_GOLD_PER_DAMAGE,
  HUNT_TARGETS,
  LEVEL_MULTIPLIER,
  ROLL_PERIOD,
  SHOAL_COUNT,
  SHOAL_SPAWN_MAX,
  SHOAL_SPAWN_MIN,
  SOUND_BELOW,
  createLeviathan,
  damageAt,
  huntGoldFor,
} from '../../src/leviathan';
import type { HuntEvent, HuntLocker, Leviathan } from '../../src/leviathan';
import type { HuntCue } from '../../src/types';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createHeightMap } from '../../src/heightmap';
import { createWaterBodies } from '../../src/waterbodies';
import { createTowns } from '../../src/towns';
import { createStubTerrain } from './support/stub-terrain';
import { GLOBE_RADIUS, headingToForward, latLonToDir, tangentFrame } from '../../src/geo';
import type { ShipState, Towns } from '../../src/types';

/**
 * `leviathan.ts`'s rule set: the roll's one-shoal promise, the parallel
 * transport every shadow is carried by, the range-and-arc gate that is the
 * whole design, the dial's sweep, the purse, and the three ways a hunt ends
 * without a press.
 *
 * Two worlds, on purpose, and the same two `aiboats.test.ts` uses. The roll
 * runs against the REAL coastline, because placing a shoal is a question about
 * water, reachability and berths and there is no point asking it of a sea with
 * none. Everything after it runs against a flat, empty ocean, because those
 * are questions about geometry and a real shoreline would only decide them by
 * accident.
 *
 * Nothing here asserts on how any of it looks; that is rule 1 in
 * docs/TESTING.md and it is what keeps this file cheap.
 */

/* ---- The real world, built once ---------------------------------------- */

const terrain = createTerrain(DEFAULT_SEED);
const heightMap = createHeightMap(terrain, 256, 128);
const spawnDir = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
const waterBodies = createWaterBodies(heightMap, terrain.seaLevel, spawnDir);
const towns = createTowns(heightMap, waterBodies, terrain.seaLevel);

/* ---- A flat empty ocean, for the geometry ------------------------------- */

const NO_TOWNS: Towns = { all: [], docks: [], dockAt: () => null };

function stubWorld() {
  const stub = createStubTerrain();
  const map = createHeightMap(stub, 128, 64);
  return {
    terrain: stub,
    heightMap: map,
    waterBodies: createWaterBodies(map, stub.seaLevel, latLonToDir(0, 0)),
    towns: NO_TOWNS,
  };
}

const OPEN_OCEAN = stubWorld();

/* ---- Helpers ------------------------------------------------------------ */

/** A locker with `n` spares, counting what it hands out. */
function locker(n: number): HuntLocker & { taken: number } {
  let count = n;
  return {
    taken: 0,
    get count(): number {
      return count;
    },
    spend(want: number): number {
      const take = want < count ? want : count;
      count -= take;
      this.taken += take;
      return take;
    },
  };
}

/** A hull stopped at `dir`, heading `headingRad` (0 = north). */
function shipAt(dir: Vector3, headingRad = Math.PI / 2): ShipState {
  const position = dir.clone().normalize();
  const up = position.clone();
  return {
    position,
    up,
    forward: headingToForward(up, headingRad),
    heading: headingRad,
    headingDeg: (headingRad * 180) / Math.PI,
    speed: 0,
    groundSpeed: 0,
    velocity: new Vector3(),
    latDeg: 0,
    lonDeg: 0,
  };
}

/** The great-circle step the module walks, for placing a hull relative to a shoal. */
function step(from: Vector3, dir: Vector3, worldUnits: number): Vector3 {
  const axis = new Vector3().crossVectors(from, dir).normalize();
  return from.clone().applyAxisAngle(axis, worldUnits / GLOBE_RADIUS).normalize();
}

/** Great-circle distance between two unit directions, world units. */
function arc(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

interface Harness {
  hunt: Leviathan;
  events: HuntEvent[];
  spares: HuntLocker & { taken: number };
}

function open(spares = 20, seed = 7): Harness {
  const events: HuntEvent[] = [];
  const store = locker(spares);
  const hunt = createLeviathan({
    ...OPEN_OCEAN,
    harpoons: store,
    seed,
    onEvent: (event) => events.push(event),
  });
  return { hunt, events, spares: store };
}

/**
 * Put a shoal on the water and park the hull dead ahead of its marked shadow
 * at `range`, pointing straight at it.
 *
 * `force` lays the shoal ahead of the bow and then the hull is MOVED to suit,
 * rather than the shoal being moved to suit the hull: `leviathan.ts` never
 * exposes a setter for a shadow and it should not, so every geometry case in
 * this file is set up by steering the one thing a player can steer.
 */
function parkOnMark(h: Harness, range: number, offArcRad = 0): ShipState {
  const shadow = h.hunt.state.shadows.find((s) => s.marked);
  expect(shadow).toBeDefined();
  const mark = shadow!.position;

  // A bearing from the mark, `range` units out, then turned back to face it.
  const north = new Vector3();
  const east = new Vector3();
  tangentFrame(mark, north, east);
  const where = step(mark, north, range);

  // The tangent at `where` that points at the mark, rotated off it by
  // `offArcRad` so a caller can ask for a target outside the bow's arc.
  const toMark = mark.clone().addScaledVector(where, -mark.dot(where)).normalize();
  const bow = toMark.clone().applyAxisAngle(where, offArcRad).normalize();

  const position = where;
  return {
    position,
    up: position.clone(),
    forward: bow,
    heading: 0,
    headingDeg: 0,
    speed: 0,
    groundSpeed: 0,
    velocity: new Vector3(),
    latDeg: 0,
    lonDeg: 0,
  };
}

/**
 * The frame that arms the dial, seconds.
 *
 * Deliberately tiny rather than a realistic 1/60. Arming resets the sweep and
 * THEN advances it by the frame's own dt, so the first readable dial position
 * is `sin(2*PI*dt/DIAL_PERIOD)` and never exactly zero. At 1/240 that is worth
 * 99 damage rather than 100, which is a real property of the sim and not a bug
 * -- a player cannot press on the same instant the dial arms either. Where a
 * test wants the CENTRE it asks for a frame short enough that the rounding
 * lands on it, and where it wants the real thing it sails at 1/240.
 */
const ARM_DT = 1e-4;

/**
 * A range to shadow the body at: outside the gate, outside the flee radius.
 *
 * Three times `HARPOON_RANGE`, so the dial never arms and the animal never
 * takes fright, which leaves a case free to watch the body do its own thing
 * for a minute without either mechanism firing.
 */
const SHADOW_RANGE = HARPOON_RANGE * 3;

/** Runs `seconds` of frames at `dt`, holding the ship still. */
function sail(h: Harness, ship: ShipState, seconds: number, dt = 1 / 60): void {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) h.hunt.update(dt, ship, false);
}

/**
 * Sail with a perfect helm: re-aim at the mark after every frame.
 *
 * Phase 2 made a press something that has to be WAITED for — the sweep starts
 * at the red edge and `ARM_UP` refuses the first quarter-second — so a test
 * that wants a real press has to hold the gate for the better part of a
 * second while the body drifts. A stationary hull loses the arc in that time,
 * which would make every press test a test of the drift instead.
 *
 * Teleporting the hull onto the mark each frame is the same affordance
 * `force(ship, true)` already is, and for the same reason the module's own
 * header gives for it: the armed state cannot be reached by waiting, only by
 * steering, and a test that has to steer is a test that fails when the shoal
 * turns.
 */
function holdOnMark(h: Harness, range: number, seconds: number, dt = 1 / 480): ShipState {
  let ship = parkOnMark(h, range);
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    h.hunt.update(dt, ship, false);
    if (h.hunt.state.phase !== 'drifting') break;
    ship = parkOnMark(h, range);
  }
  return ship;
}

/**
 * Hold the mark until the needle reaches the middle of the bar, then press.
 *
 * Returns what `fire` returned, so a caller can assert on the damage. The
 * frame budget is generous because the sweep's rate rises with the level: the
 * fifth target's needle runs half again as fast as the first's, and a fixed
 * number of frames would quietly stop finding the centre partway up the
 * escalation.
 */
function strikeWhen(
  h: Harness,
  range: number,
  want: (damage: number) => boolean,
  dt = 1 / 480,
): number {
  let ship = parkOnMark(h, range);
  for (let i = 0; i < 4000; i++) {
    h.hunt.update(dt, ship, false);
    if (h.hunt.state.phase !== 'drifting') return -1;
    if (h.hunt.state.ready && want(damageAt(h.hunt.state.dial))) return h.hunt.fire();
    ship = parkOnMark(h, range);
  }
  return -1;
}

function strikeAtCentre(h: Harness, range: number, dt = 1 / 480): number {
  return strikeWhen(h, range, (d) => d === 100, dt);
}

/**
 * Hold the mark and press as feebly as the sim will let you.
 *
 * Note what this has to do: it CANNOT press below the threshold on the way in.
 * At `centring` 0 the arm-up ends with the needle already worth about fifteen,
 * so a contemptible press is only reachable on the far side of the centre, a
 * second and a quarter later. That is a real and welcome property of item 3 —
 * the cheapest press a masher can reach is no longer the cheapest press there
 * is — and it is why this waits rather than firing early.
 */
function strikeBelowThreshold(h: Harness, range: number): number {
  return strikeWhen(h, range, (d) => d > 0 && d < SOUND_BELOW);
}

/**
 * Put one feeble press into the water so the animal sounds, and hand back a
 * hull to run the fade out with.
 *
 * The hull's geometry stops mattering the instant the phase turns to
 * `settling` — that branch returns before the gate is ever consulted — so the
 * one captured before the press is as good as any.
 */
function strikeToEnding(h: Harness, range: number): ShipState {
  const ship = parkOnMark(h, range);
  strikeBelowThreshold(h, range);
  return ship;
}

/**
 * What a flawless hunt banks: 100 damage a press, each multiplied by its
 * level.
 *
 * `LEVEL_MULTIPLIER` sums to 6.1, so this is 610 rather than the MVP's 500.
 * Computed from the table rather than written as a literal, so retuning the
 * escalation retunes the expectation with it and does not quietly leave a test
 * asserting a figure the game stopped paying.
 */
const PERFECT_BANK = LEVEL_MULTIPLIER.slice(0, HUNT_TARGETS).reduce(
  (sum, m) => sum + 100 * m,
  0,
);

/* ------------------------------------------------------------------ */

describe('the damage ramp', () => {
  it('is 100 at the centre and 0 at either end', () => {
    expect(damageAt(0)).toBe(100);
    expect(damageAt(1)).toBe(0);
    expect(damageAt(-1)).toBe(0);
  });

  it('is symmetric and linear in the magnitude', () => {
    expect(damageAt(0.5)).toBe(50);
    expect(damageAt(-0.5)).toBe(50);
    expect(damageAt(0.25)).toBe(75);
  });

  it('puts the sound threshold at nine tenths out', () => {
    // SOUND_BELOW is 10 damage, which is |p| > 0.9: the outer tenth of the bar
    // at each end, and the two notches `style.css` draws. Both sides of the
    // edge, because this is the number that decides whether a hunt continues.
    expect(damageAt(0.89)).toBeGreaterThanOrEqual(SOUND_BELOW);
    expect(damageAt(0.91)).toBeLessThan(SOUND_BELOW);
  });

  it('refuses a number that is not one', () => {
    expect(damageAt(Number.NaN)).toBe(0);
    expect(damageAt(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('the purse', () => {
  it('pays ten a point, rounded to fifty', () => {
    expect(huntGoldFor(500)).toBe(500 * HUNT_GOLD_PER_DAMAGE);
    expect(huntGoldFor(0)).toBe(0);
    expect(huntGoldFor(-5)).toBe(0);
  });

  it('never pays a figure that is not a quoted price', () => {
    for (const banked of [1, 37, 182, 425, 499, 610]) {
      expect(huntGoldFor(banked) % 50).toBe(0);
    }
  });

  it('escalates to 6 100 on a flawless hunt', () => {
    /*
     * Phase 2's `LEVEL_MULTIPLIER` sums to 6.1, so five perfect presses bank
     * 610 rather than the MVP's 500. The figure matters because the ordering
     * it sits in was argued for rather than picked: see the table in
     * docs/LEVIATHAN_PHASE2_PLAN.md.
     */
    expect(PERFECT_BANK).toBeCloseTo(610, 6);
    expect(huntGoldFor(PERFECT_BANK)).toBe(6100);
  });

  it('sits under a won fight, and over the best contract, at its very best', () => {
    /*
     * `bounty.ts`'s top tier is 20 000 and the best contract pays 5 250. A
     * perfect hunt must beat the contract and lose to the fight, or one of the
     * two stops having a reason to exist. This is the ordering the MVP's purse
     * argued for and the escalation had to preserve rather than break.
     */
    expect(huntGoldFor(PERFECT_BANK)).toBeLessThan(20000);
    expect(huntGoldFor(PERFECT_BANK)).toBeGreaterThan(5250);
  });
});

describe('the roll', () => {
  it('lands a shoal in open water, and never two at once', () => {
    const events: HuntEvent[] = [];
    const hunt = createLeviathan({
      terrain,
      heightMap,
      waterBodies,
      towns,
      harpoons: locker(100),
      seed: 3,
      onEvent: (event) => events.push(event),
    });
    const ship = shipAt(spawnDir.clone());

    let sawShoal = false;
    // 3 000 seconds of rolls. Each frame asserts the cap, so a second shoal
    // laid on top of the first would fail on the frame it happened rather
    // than at the end.
    for (let i = 0; i < 3000 * 10; i++) {
      hunt.update(0.1, ship, false);
      const n = hunt.state.shadows.length;
      expect(n === 0 || n === SHOAL_COUNT).toBe(true);
      if (hunt.state.phase === 'drifting') sawShoal = true;
    }
    expect(sawShoal).toBe(true);
  });

  it('lands nothing while suppressed', () => {
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    for (let i = 0; i < 3000 * 10; i++) h.hunt.update(0.1, ship, true);
    expect(h.hunt.state.phase).toBe('idle');
    expect(h.hunt.state.shadows).toHaveLength(0);
  });

  it('draws its number whether or not it can act on it', () => {
    /*
     * The seeded stream must not be reordered by what is on the water. Two
     * sims on one seed: the first is suppressed for a stretch and then let go,
     * the second is suppressed for the same stretch. If the draw were skipped
     * while suppressed the two would diverge, because the first would have
     * consumed a different count by the time it was free.
     */
    const a = open(20, 11);
    const b = open(20, 11);
    const ship = shipAt(latLonToDir(0, 0));
    for (let i = 0; i < 50; i++) {
      a.hunt.update(ROLL_PERIOD, ship, true);
      b.hunt.update(ROLL_PERIOD, ship, true);
    }
    for (let i = 0; i < 200; i++) {
      a.hunt.update(ROLL_PERIOD, ship, false);
      b.hunt.update(ROLL_PERIOD, ship, false);
    }
    expect(a.hunt.state.phase).toBe(b.hunt.state.phase);
    expect(a.hunt.state.shadows.length).toBe(b.hunt.state.shadows.length);
  });

  it('never lays a shoal whose edge is aground', () => {
    /*
     * The centre being on water is not enough: a shadow sits up to
     * SHOAL_RADIUS from it and `update` ends a hunt the moment the MARKED one
     * is aground, so a lay that only cleared its middle would scatter on the
     * frame after it landed and reach the player as a notice about a shoal
     * they never saw. Against the REAL coastline, because that is the only
     * place the question has an answer.
     */
    const events: HuntEvent[] = [];
    const hunt = createLeviathan({
      terrain,
      heightMap,
      waterBodies,
      towns,
      harpoons: locker(100),
      seed: 5,
      onEvent: (event) => events.push(event),
    });
    const ship = shipAt(spawnDir.clone());

    let lays = 0;
    for (let i = 0; i < 3000 * 10; i++) {
      const was = hunt.state.phase;
      hunt.update(0.1, ship, false);
      if (was !== 'drifting' && hunt.state.phase === 'drifting') {
        lays++;
        // Every shadow, on the frame it was laid, is on water the player
        // could actually sail to.
        for (const shadow of hunt.state.shadows) {
          expect(heightMap.sample(shadow.position)).toBeLessThan(terrain.seaLevel);
          expect(waterBodies.sample(shadow.position)).toBeLessThan(0.5);
        }
      }
    }
    expect(lays).toBeGreaterThan(0);
  });

  it('lays a forced shoal inside the spawn band, ahead of the bow', () => {
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    expect(h.hunt.force(ship)).toBe(true);
    expect(h.hunt.state.shadows).toHaveLength(SHOAL_COUNT);

    /*
     * The HEAD is what the spawn band places, and the body trails astern of
     * it. Phase 2's animal is `BODY_LENGTH` — about twenty-two units — from
     * nose to tail, so asserting that every segment sits inside a fifteen-unit
     * band is asserting something a chained body cannot do. The MVP's disc
     * could, which is why the case was written that way.
     */
    const head = h.hunt.state.shadows[0];
    expect(head.rank).toBe(0);
    const headRange = arc(ship.position, head.position);
    expect(headRange).toBeGreaterThan(SHOAL_SPAWN_MIN - 12);
    expect(headRange).toBeLessThan(SHOAL_SPAWN_MAX);

    for (const shadow of h.hunt.state.shadows) {
      const d = arc(ship.position, shadow.position);
      expect(d).toBeGreaterThan(SHOAL_SPAWN_MIN - 12);
      // No segment may be further out than the head plus the whole body, which
      // is the real bound and the one that would catch a chain laid wrong.
      expect(d).toBeLessThan(SHOAL_SPAWN_MAX + BODY_LENGTH);
    }
  });

  it('lays the body nose to tail, one spacing apart', () => {
    /*
     * Item 1. The MVP scattered fourteen shadows over a nine-unit disc; this
     * is one animal, and the spacing is what makes it one.
     */
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    expect(h.hunt.force(ship)).toBe(true);

    const shadows = h.hunt.state.shadows;
    for (let i = 0; i < shadows.length; i++) expect(shadows[i].rank).toBe(i);
    for (let i = 1; i < shadows.length; i++) {
      expect(arc(shadows[i - 1].position, shadows[i].position)).toBeCloseTo(BODY_SPACING, 4);
    }
  });

  it('holds its spacing at cruise and through a turn', () => {
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    h.hunt.force(ship);

    // Long enough to cover several telegraphed turns at every level, with the
    // hull SHADOWING the body: parked, it would be out of `DESPAWN_RANGE`
    // inside twenty seconds and the hunt would end before the case ran.
    for (let i = 0; i < 60 * 60; i++) {
      h.hunt.update(1 / 60, parkOnMark(h, SHADOW_RANGE), false);
      if (h.hunt.state.phase !== 'drifting') break;
    }
    expect(h.hunt.state.phase).toBe('drifting');

    const shadows = h.hunt.state.shadows;
    expect(shadows.length).toBe(SHOAL_COUNT);
    for (let i = 1; i < shadows.length; i++) {
      // Within one unit of the spacing, which is the plan's own tolerance and
      // is what a rigid chain on a sphere should comfortably hold.
      expect(Math.abs(arc(shadows[i - 1].position, shadows[i].position) - BODY_SPACING)).toBeLessThan(1);
    }
    // And every segment is still ON the sphere, with a tangent that is
    // actually tangent. A chain is the easiest way to lose both.
    for (const shadow of shadows) {
      expect(shadow.position.length()).toBeCloseTo(1, 6);
      expect(shadow.forward.length()).toBeCloseTo(1, 6);
      expect(Math.abs(shadow.forward.dot(shadow.position))).toBeLessThan(1e-6);
    }
  });

  it('telegraphs a turn before the heading moves', () => {
    /*
     * Item 7. A player who cannot see a turn coming cannot lead the body, and
     * leading it is the skill. The head banks for a full `TURN_TELEGRAPH`
     * before the heading changes at all.
     */
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    h.hunt.force(ship);

    let banked = -1;
    let moved = -1;
    let last = h.hunt.state.shadows[0].forward.clone();
    for (let i = 0; i < 60 * 40; i++) {
      h.hunt.update(1 / 60, parkOnMark(h, SHADOW_RANGE), false);
      if (h.hunt.state.phase !== 'drifting') break;
      const head = h.hunt.state.shadows[0];
      if (banked < 0 && Math.abs(head.bank) > 0.05) banked = i;
      /*
       * "Moved" means turned, not merely carried.
       *
       * Parallel transport rewrites `forward` every single frame, but by the
       * step over the radius — about 0.0003 rad at cruise — where a turn at
       * `HEAD_TURN_RATE` is 0.017 rad a frame. The threshold sits between the
       * two, so this cannot mistake the animal swimming for the animal
       * turning.
       */
      if (banked >= 0 && moved < 0 && head.forward.angleTo(last) > 0.008) moved = i;
      last = head.forward.clone();
    }

    expect(banked).toBeGreaterThanOrEqual(0);
    expect(moved).toBeGreaterThan(banked);
  });

  it('flees a hull that comes inside the minimum range', () => {
    /*
     * Item 2, and the visible reason `HARPOON_MIN_RANGE` exists. Ramming now
     * fails because the thing moves, not because a rule says so.
     */
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    h.hunt.force(ship);

    const onTop = parkOnMark(h, FLEE_RADIUS * 0.5);
    const before = h.hunt.state.shadows[0].forward.clone();
    for (let i = 0; i < 60; i++) h.hunt.update(1 / 60, onTop, false);

    const after = h.hunt.state.shadows[0].forward;
    expect(after.angleTo(before)).toBeGreaterThan(0.1);
    expect(h.hunt.state.bolt).toBeGreaterThan(0);
  });
});

describe('the armed dev hand', () => {
  it('lays a shoal whose dial is live on the next frame', () => {
    /*
     * `force(ship, true)` exists because the armed state cannot be reached by
     * waiting, only by steering, and the browser tier cannot steer reliably
     * enough to depend on: a probe that sails at a shoal drives into a
     * headland instead. This is the same affordance `?battle=1` is for a
     * fight. It is checked HERE, cheaply, so the expensive tier only has to
     * prove the keystroke reaches the sim.
     */
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    expect(h.hunt.force(ship, true)).toBe(true);

    h.hunt.update(1 / 240, ship, false);
    expect(h.hunt.state.armed).toBe(true);
    expect(h.hunt.state.shadows).toHaveLength(SHOAL_COUNT);
  });

  it('leaves the marked shadow a proper inhabitant of the sphere', () => {
    // It is the one place a shadow is teleported, so the invariant everything
    // downstream leans on has to be re-established by hand rather than
    // inherited from `transport`.
    const h = open();
    const ship = shipAt(latLonToDir(70, 20));
    h.hunt.force(ship, true);
    const mark = h.hunt.state.shadows.find((s) => s.marked)!;
    expect(mark.position.length()).toBeCloseTo(1, 9);
    expect(mark.forward.length()).toBeCloseTo(1, 9);
    expect(mark.position.dot(mark.forward)).toBeCloseTo(0, 9);

    // And it still walks the sphere correctly once it starts drifting.
    for (let i = 0; i < 120; i++) {
      h.hunt.update(1 / 60, ship, false);
      if (h.hunt.state.phase !== 'drifting') break;
      for (const shadow of h.hunt.state.shadows) {
        expect(shadow.position.dot(shadow.forward)).toBeCloseTo(0, 9);
      }
    }
  });

  it('drifts back out of the arc, so the gate is still a gate', () => {
    // Laid ACROSS the bow rather than down it: an armed dial that stayed
    // armed for ever would be testing nothing.
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    h.hunt.force(ship, true);
    h.hunt.update(1 / 240, ship, false);
    expect(h.hunt.state.armed).toBe(true);

    let wentDark = false;
    for (let i = 0; i < 60 * 30; i++) {
      h.hunt.update(1 / 60, ship, false);
      if (h.hunt.state.phase !== 'drifting') break;
      if (!h.hunt.state.armed) { wentDark = true; break; }
    }
    expect(wentDark).toBe(true);
  });

  it('lays an ordinary shoal when not asked to arm', () => {
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    h.hunt.force(ship);
    h.hunt.update(1 / 240, ship, false);
    expect(h.hunt.state.armed).toBe(false);
  });
});

describe('the shoal on the sphere', () => {
  it('keeps every shadow a unit direction with a tangent bow', () => {
    /*
     * The parallel-transport invariant, and the one thing in this module that
     * breaks silently: a bow with a radial component walks its shadow off the
     * sphere a rounding error at a time, and a shoal drifting past a pole is
     * where it shows.
     */
    const h = open();
    const ship = shipAt(latLonToDir(84, 0));
    h.hunt.force(ship);

    for (let i = 0; i < 60 * 60; i++) {
      h.hunt.update(1 / 60, ship, false);
      if (h.hunt.state.phase !== 'drifting') break;
      for (const shadow of h.hunt.state.shadows) {
        expect(shadow.position.length()).toBeCloseTo(1, 9);
        expect(shadow.forward.length()).toBeCloseTo(1, 9);
        expect(shadow.position.dot(shadow.forward)).toBeCloseTo(0, 9);
      }
    }
  });

  it('marks exactly one shadow at a time', () => {
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    h.hunt.force(ship);
    for (let i = 0; i < 600; i++) {
      h.hunt.update(1 / 60, ship, false);
      if (h.hunt.state.phase !== 'drifting') break;
      expect(h.hunt.state.shadows.filter((s) => s.marked)).toHaveLength(1);
    }
  });

  it('fades in, and its shadows travel', () => {
    const h = open();
    const ship = shipAt(latLonToDir(0, 0));
    h.hunt.force(ship);
    const before = h.hunt.state.shadows.map((s) => s.position.clone());

    expect(h.hunt.state.shadows[0].envelope).toBe(0);
    sail(h, ship, 1);
    expect(h.hunt.state.shadows[0].envelope).toBe(1);

    for (let i = 0; i < h.hunt.state.shadows.length; i++) {
      expect(arc(before[i], h.hunt.state.shadows[i].position)).toBeGreaterThan(0.5);
    }
  });
});

describe('the gate, which is the whole design', () => {
  it('stays dark outside harpoon range', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE + 4);
    h.hunt.update(1 / 60, ship, false);
    expect(h.hunt.state.armed).toBe(false);
  });

  it('stays dark inside range but outside the bow arc', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    // Well past the arc, so a degree of drift in the frame cannot rescue it.
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5, BOW_ARC * 2);
    h.hunt.update(1 / 60, ship, false);
    expect(h.hunt.state.armed).toBe(false);
  });

  it('stays dark on top of the mark, which is the case that is easy to miss', () => {
    /*
     * The gate has a floor as well as a ceiling, and without one it is
     * UNSATISFIABLE at point blank: the bearing to something the hull is
     * standing on swings past ninety degrees, so the arc can never be met.
     *
     * This is not a hypothetical. A browser probe sailed the ship onto the
     * marked shadow and read `markRange` 0.18 with `markOffBow` -88.4, having
     * never armed once on the way in. A player's whole instinct is to close,
     * so this is the path they take.
     */
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_MIN_RANGE * 0.4);
    h.hunt.update(1 / 60, ship, false);
    expect(h.hunt.state.armed).toBe(false);
  });

  it('arms in the band between the floor and the ceiling', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    // Both ends of the band, since one of them was missing entirely.
    for (const range of [HARPOON_MIN_RANGE + 0.5, HARPOON_RANGE - 0.5]) {
      const ship = parkOnMark(h, range);
      h.hunt.update(1 / 60, ship, false);
      expect(h.hunt.state.armed, `armed at ${range} units`).toBe(true);
    }
  });

  it('arms inside both', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);
    h.hunt.update(1 / 60, ship, false);
    expect(h.hunt.state.armed).toBe(true);
  });

  it('stays dark while suppressed, however well aimed', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);
    h.hunt.update(1 / 60, ship, true);
    expect(h.hunt.state.armed).toBe(false);
  });

  it('stays dark with an empty locker, and says so once', () => {
    const h = open(0);
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);
    sail(h, ship, 2);
    expect(h.hunt.state.armed).toBe(false);
    expect(h.events.filter((e) => e.kind === 'dry')).toHaveLength(1);
  });
});

describe('the dial', () => {
  it('starts at the RED EDGE and sweeps to the centre, not the other way', () => {
    /*
     * This case is the MVP's inverted, and the inversion is the point.
     *
     * It used to assert that the frame after arming was worth 100 damage,
     * which is exactly the exploit phase 2 exists to remove: `sin(0)` is the
     * middle of the bar, so tapping Space as the gate opened beat reading the
     * needle. `cos(0)` is the edge, worth nothing, and the first perfect
     * moment is a quarter period of held steering away.
     */
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);

    h.hunt.update(ARM_DT, ship, false);
    expect(h.hunt.state.armed).toBe(true);
    expect(Math.abs(h.hunt.state.dial)).toBeCloseTo(1, 2);
    expect(damageAt(h.hunt.state.dial)).toBe(0);

    // A quarter period of SWEPT time, which at `centring` 0 and level 0 runs
    // at `SWEEP_SLOW`: the needle is deliberately slowest when the mark is
    // held dead ahead, which is the whole of item 4.
    holdOnMark(h, HARPOON_RANGE * 0.5, DIAL_PERIOD / 4 / SWEEP_SLOW);
    expect(damageAt(h.hunt.state.dial)).toBeGreaterThan(98);
  });

  it('refuses a press during the arm-up, and costs nothing for it', () => {
    /*
     * The other half of item 5's fix. Starting at the edge makes the free shot
     * worthless; the arm-up makes it impossible, so a mash cannot even spend a
     * harpoon on the frame the gate opens.
     */
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);

    h.hunt.update(ARM_DT, ship, false);
    expect(h.hunt.state.armed).toBe(true);
    expect(h.hunt.state.ready).toBe(false);
    expect(h.hunt.fire()).toBe(-1);
    expect(h.spares.taken).toBe(0);
    expect(h.hunt.state.target).toBe(0);

    holdOnMark(h, HARPOON_RANGE * 0.5, ARM_UP * 1.5);
    expect(h.hunt.state.ready).toBe(true);
  });

  it('beats a mash: pressing the instant the gate opens is worth nothing', () => {
    /*
     * The exploit case, stated as the sim rather than as the sweep. Under the
     * MVP this press returned very nearly 100 and this test could not have
     * been written.
     */
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);

    h.hunt.update(ARM_DT, ship, false);
    expect(h.hunt.fire()).toBe(-1);

    // And the first press it WILL honour, still taken as early as possible,
    // is worth a contemptible amount rather than a perfect one.
    holdOnMark(h, HARPOON_RANGE * 0.5, ARM_UP * 1.05);
    const early = h.hunt.fire();
    expect(early).toBeGreaterThanOrEqual(0);
    expect(early).toBeLessThan(50);
  });

  it('restarts its sweep every time it arms', () => {
    /*
     * A player who loses the target and comes round again must get the dial
     * from a known start. Half a period out of the arc and back would
     * otherwise hand them the far end of the sweep on the frame they arrive.
     *
     * Unchanged in intent from the MVP; only the known start moved, from the
     * middle of the bar to the edge of it.
     */
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const off = parkOnMark(h, HARPOON_RANGE * 0.5, BOW_ARC * 2);

    holdOnMark(h, HARPOON_RANGE * 0.5, DIAL_PERIOD / 4 / SWEEP_SLOW);
    expect(damageAt(h.hunt.state.dial)).toBeGreaterThan(98);

    h.hunt.update(ARM_DT, off, false);
    expect(h.hunt.state.armed).toBe(false);

    const on = parkOnMark(h, HARPOON_RANGE * 0.5);
    h.hunt.update(ARM_DT, on, false);
    expect(h.hunt.state.armed).toBe(true);
    expect(Math.abs(h.hunt.state.dial)).toBeCloseTo(1, 2);
    expect(h.hunt.state.ready).toBe(false);
  });

  it('runs the needle faster when the mark is off the bow', () => {
    /*
     * Item 4, and the claim the whole activity rests on: steering and timing
     * are one skill. A mark held dead ahead slows the sweep and makes the
     * press easy; one taken at the edge of the arc runs it fast.
     */
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));

    const centred = parkOnMark(h, HARPOON_RANGE * 0.5);
    h.hunt.update(ARM_DT, centred, false);
    const slow = h.hunt.state.sweepRate;

    const edged = parkOnMark(h, HARPOON_RANGE * 0.5, BOW_ARC * 0.95);
    h.hunt.update(ARM_DT, edged, false);
    const fast = h.hunt.state.sweepRate;

    expect(h.hunt.state.armed).toBe(true);
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeCloseTo(SWEEP_SLOW, 2);
  });
});

describe('the gate, and why the bar is dark', () => {
  /*
   * `gate` is phase 2's single biggest onboarding fix: the MVP could only say
   * that the dial was dark, and this says which one of five things is making
   * it dark. The order below is the teaching progression — sail closer, then
   * point the bow, then back off if you have overshot — and `HuntGate` in
   * `types.ts` carries the argument for it.
   */
  it('names the one condition that is failing', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));

    h.hunt.update(ARM_DT, parkOnMark(h, HARPOON_RANGE + 6), false);
    expect(h.hunt.state.gate).toBe('far');

    h.hunt.update(ARM_DT, parkOnMark(h, HARPOON_RANGE * 0.5, BOW_ARC * 2), false);
    expect(h.hunt.state.gate).toBe('arc');

    h.hunt.update(ARM_DT, parkOnMark(h, HARPOON_MIN_RANGE * 0.5), false);
    expect(h.hunt.state.gate).toBe('close');

    h.hunt.update(ARM_DT, parkOnMark(h, HARPOON_RANGE * 0.5), false);
    expect(h.hunt.state.gate).toBe('ok');
  });

  it('says dry only when the locker is the last thing in the way', () => {
    const h = open(0);
    h.hunt.force(shipAt(latLonToDir(0, 0)));

    // Out of range with an empty locker still reports the RANGE: a player who
    // is nowhere near the shoal does not need to be told to buy harpoons.
    h.hunt.update(ARM_DT, parkOnMark(h, HARPOON_RANGE + 6), false);
    expect(h.hunt.state.gate).toBe('far');

    h.hunt.update(ARM_DT, parkOnMark(h, HARPOON_RANGE * 0.5), false);
    expect(h.hunt.state.gate).toBe('dry');
    expect(h.hunt.state.armed).toBe(false);
  });

  it('reports suppressed, and disarms, whatever the geometry says', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);

    h.hunt.update(ARM_DT, ship, false);
    expect(h.hunt.state.gate).toBe('ok');

    h.hunt.update(ARM_DT, ship, true);
    expect(h.hunt.state.armed).toBe(false);
  });
});

describe('the press', () => {
  it('refuses, and costs nothing, while the dial is dark', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE + 4);
    h.hunt.update(1 / 60, ship, false);

    expect(h.hunt.fire()).toBe(-1);
    expect(h.spares.taken).toBe(0);
    expect(h.hunt.state.target).toBe(0);
    expect(h.events).toHaveLength(0);
  });

  it('banks a perfect run, settles once, and takes one bundle', () => {
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));

    for (let i = 0; i < HUNT_TARGETS; i++) {
      // Held on the mark each time: the mark moves on every hit, which is the
      // whole reason the helm stays in play between targets, and the needle
      // now has to be WAITED for rather than caught on the arming frame.
      expect(strikeAtCentre(h, HARPOON_RANGE * 0.5)).toBe(100);
    }

    /*
     * 610, not 500. Each press is worth its face value of 100 and the BANK is
     * what escalates, so the bar the player reads never lies about what a
     * press was worth while the purse still rewards getting to the fifth
     * target. See `LEVEL_MULTIPLIER`.
     */
    expect(h.hunt.state.banked).toBe(Math.round(PERFECT_BANK));
    expect(h.spares.taken).toBe(HUNT_TARGETS);

    const settled = h.events.filter((e) => e.kind === 'settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].damage).toBe(Math.round(PERFECT_BANK));
    expect(settled[0].gold).toBe(huntGoldFor(PERFECT_BANK));
    expect(settled[0].ending).toBe('settled');
    expect(h.events.filter((e) => e.kind === 'hit')).toHaveLength(HUNT_TARGETS);
  });

  it('walks the mark from the tail to the head across the five targets', () => {
    /*
     * Item 6, which reverses the MVP's seeded pick. A player who has just
     * struck the hindmost segment knows where the next one will be, so the
     * fifth target is a shot they have been steering toward for the whole
     * hunt rather than a fresh search. The first target is the tail and the
     * last is the head, and the walk never goes backwards.
     */
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));

    const ranks: number[] = [h.hunt.state.mark];
    expect(ranks[0]).toBe(SHOAL_COUNT - 1);

    for (let i = 0; i < HUNT_TARGETS - 1; i++) {
      expect(strikeAtCentre(h, HARPOON_RANGE * 0.5)).toBe(100);
      expect(h.hunt.state.shadows.filter((s) => s.marked)).toHaveLength(1);
      ranks.push(h.hunt.state.mark);
    }

    expect(ranks[ranks.length - 1]).toBe(0);
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeLessThan(ranks[i - 1]);
  });

  it('scatters on a press under the sound threshold, paying what was banked', () => {
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));

    // One good target, then one bad one.
    expect(strikeAtCentre(h, HARPOON_RANGE * 0.5)).toBe(100);

    const damage = strikeBelowThreshold(h, HARPOON_RANGE * 0.5);
    expect(damage).toBeGreaterThan(0);
    expect(damage).toBeLessThan(SOUND_BELOW);

    expect(h.hunt.state.phase).toBe('settling');
    expect(h.hunt.state.target).toBe(2);

    /*
     * The first press banked at level 0 (factor 1.0) and the second at level 1
     * (factor 1.1), so the total is not the sum of the two face values. The
     * damage the EVENT carries is the bank, rounded, which is what the strip
     * prints and what the purse is taken from.
     */
    const banked = Math.round(100 * LEVEL_MULTIPLIER[0] + damage * LEVEL_MULTIPLIER[1]);
    const sounded = h.events.filter((e) => e.kind === 'sounded');
    expect(sounded).toHaveLength(1);
    expect(sounded[0].damage).toBe(banked);
    expect(sounded[0].gold).toBe(huntGoldFor(banked));
    expect(sounded[0].ending).toBe('sounded');
    // The WORD, not the rule: this ending is the player's own press and the
    // strip names the animal for it, where a coast or a maelstrom does not.
    expect(sounded[0].reason).toBe('pinprick');
    // Three targets were never offered, and their harpoons were never spent.
    expect(h.spares.taken).toBe(2);
  });

  it('exempts the last target from the threshold', () => {
    /*
     * A player who has banked four and puts a feeble fifth into the water has
     * finished the hunt whatever the rule says. Greeting a four-out-of-five run
     * with "the leviathan tired of you" would read as a failure rather than as
     * the end of a good one, so the count is checked before the threshold.
     */
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));

    let banked = 0;
    for (let i = 0; i < HUNT_TARGETS - 1; i++) {
      expect(strikeAtCentre(h, HARPOON_RANGE * 0.5)).toBe(100);
      banked += 100 * LEVEL_MULTIPLIER[i];
    }

    // A deliberately contemptible fifth.
    const damage = strikeBelowThreshold(h, HARPOON_RANGE * 0.5);
    expect(damage).toBeGreaterThan(0);
    expect(damage).toBeLessThan(SOUND_BELOW);
    banked += damage * LEVEL_MULTIPLIER[HUNT_TARGETS - 1];

    // Settled, not sounded, and paid for everything banked.
    const settled = h.events.filter((e) => e.kind === 'settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].damage).toBe(Math.round(banked));
    expect(settled[0].ending).toBe('settled');
    expect(h.events.filter((e) => e.kind === 'sounded')).toHaveLength(0);
  });

  it('pays once, whatever the fade does afterwards', () => {
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = strikeToEnding(h, HARPOON_RANGE * 0.5);

    const paid = h.events.filter((e) => e.gold > 0).length;
    // Long enough for the LONGEST of the three endings: they no longer share
    // one `FADE_OUT`, and a fade budget taken from the shortest would leave a
    // settled hunt still on the water when this asserted it had gone.
    sail(h, ship, Math.max(...Object.values(ENDING_FADE)) * 1.5);
    expect(h.hunt.state.phase).toBe('idle');
    expect(h.hunt.state.shadows).toHaveLength(0);
    expect(h.events.filter((e) => e.gold > 0)).toHaveLength(paid);
  });
});

describe('the three ways a hunt ends without a press', () => {
  it('ends when the player sails out of range, paying what was banked', () => {
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    expect(strikeAtCentre(h, HARPOON_RANGE * 0.5)).toBe(100);

    const far = parkOnMark(h, DESPAWN_RANGE + 10);
    h.hunt.update(1 / 60, far, false);

    expect(h.hunt.state.phase).toBe('settling');
    const ended = h.events.filter((e) => e.kind === 'sounded');
    expect(ended).toHaveLength(1);
    // One press at level 0, so the multiplier is 1.0 and the bank is its face
    // value. The ESCALATION is what the perfect-run case covers.
    expect(ended[0].gold).toBe(huntGoldFor(100));
    // Sailing away is the player's own choice, so it must NOT be reported as
    // the animal losing interest in them.
    expect(ended[0].reason).toBe('lost');
  });

  it('ends when the world is suppressed under it', () => {
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);
    h.hunt.update(ARM_DT, ship, false);
    h.hunt.fire();

    h.hunt.update(1 / 60, ship, true);
    expect(h.hunt.state.phase).toBe('settling');
    expect(h.events.filter((e) => e.kind === 'sounded')).toHaveLength(1);
  });

  it('ends on `scatter`, and is a no-op when nothing is live', () => {
    const h = open(20);
    h.hunt.scatter();
    expect(h.events).toHaveLength(0);

    h.hunt.force(shipAt(latLonToDir(0, 0)));
    h.hunt.scatter();
    expect(h.hunt.state.phase).toBe('settling');
    expect(h.events.filter((e) => e.kind === 'sounded')).toHaveLength(1);

    // And again, which must not pay a second time.
    h.hunt.scatter();
    expect(h.events.filter((e) => e.kind === 'sounded')).toHaveLength(1);
  });

  it('holds its grace, so the next shoal is not on the next roll', () => {
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    h.hunt.scatter();
    expect(h.hunt.state.grace).toBeGreaterThan(0);

    const ship = shipAt(latLonToDir(0, 0));
    sail(h, ship, FADE_OUT * 2);
    expect(h.hunt.state.phase).toBe('idle');

    // A run of rolls inside the grace lands nothing.
    for (let i = 0; i < 2; i++) h.hunt.update(0.1, ship, false);
    for (let i = 0; i < ROLL_PERIOD * 2 * 10; i++) {
      h.hunt.update(0.1, ship, false);
      if (h.hunt.state.grace <= 0) break;
      expect(h.hunt.state.phase).toBe('idle');
    }
  });
});

describe('the frame', () => {
  it('leaves the last true state standing on a frame that advanced no time', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);
    sail(h, ship, 0.5, 1 / 240);

    const dial = h.hunt.state.dial;
    const armed = h.hunt.state.armed;
    h.hunt.update(0, ship, false);
    expect(h.hunt.state.dial).toBe(dial);
    expect(h.hunt.state.armed).toBe(armed);
  });

  it('replays a run from one seed', () => {
    const a = open(20, 42);
    const b = open(20, 42);
    const ship = shipAt(latLonToDir(0, 0));
    for (let i = 0; i < 4000; i++) {
      a.hunt.update(0.1, ship, false);
      b.hunt.update(0.1, ship, false);
    }
    expect(a.hunt.state.phase).toBe(b.hunt.state.phase);
    expect(a.hunt.state.shadows.length).toBe(b.hunt.state.shadows.length);
    for (let i = 0; i < a.hunt.state.shadows.length; i++) {
      expect(a.hunt.state.shadows[i].position.x).toBeCloseTo(b.hunt.state.shadows[i].position.x, 12);
      expect(a.hunt.state.shadows[i].marked).toBe(b.hunt.state.shadows[i].marked);
    }
  });
});

describe('the cues the views are handed', () => {
  function openWithCues(): Harness & { cues: HuntCue[] } {
    const events: HuntEvent[] = [];
    const cues: HuntCue[] = [];
    const store = locker(20);
    const hunt = createLeviathan({
      ...OPEN_OCEAN,
      harpoons: store,
      seed: 7,
      onEvent: (event) => events.push(event),
      onCue: (cue) => cues.push(cue),
    });
    return { hunt, events, spares: store, cues };
  }

  it('says armed once per gate opening, not once per press', () => {
    // A strike restarts the sweep without closing the gate. Clearing `armed`
    // in `fire` made the next frame a false rising edge, and the reticle and
    // vignette pulsed "the gate just opened" after every strike.
    const h = openWithCues();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    expect(strikeAtCentre(h, HARPOON_RANGE * 0.5)).toBe(100);
    // The frames after the press are where the false edge used to appear.
    // Held on the walked mark, so the gate is still open throughout.
    for (let i = 0; i < 30; i++) h.hunt.update(ARM_DT, parkOnMark(h, HARPOON_RANGE * 0.5), false);
    expect(h.hunt.state.armed).toBe(true);

    const kinds = h.cues.map((c) => c.kind).filter((k) => k === 'armed' || k === 'disarmed');
    // Whatever the walk did to the gate afterwards, the two must alternate.
    for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
    expect(kinds[0]).toBe('armed');
  });

  it('puts the dive where the animal was', () => {
    // `huntfx.ts` centres the dive swell on the cue's position and draws
    // nothing without one.
    const h = openWithCues();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    strikeBelowThreshold(h, HARPOON_RANGE * 0.5);

    const dive = h.cues.find((c) => c.kind === 'dive');
    expect(dive).toBeDefined();
    expect(dive!.position).toBeDefined();
  });
});

describe('the coast', () => {
  /*
   * A hunt followed along a coast used to be lost to it nearly every time:
   * the head swam straight at land, and a turn swung the body, pivoting on
   * its head, across whatever lay beside it. These are the three things that
   * fixed it, each asked on its own.
   */

  it('keeps a followed hunt off a real coast', () => {
    /*
     * Water points with land inside thirty-five units, a shoal forced at
     * each, and a hull held forty units off the mark for two minutes: inside
     * `DESPAWN_RANGE` and outside `FLEE_RADIUS`, so the only way one of these
     * hunts can end is the mark going aground. On the committed code before
     * this case existed, every one of them did.
     */
    const spots: Vector3[] = [];
    for (let lat = -60; lat <= 60 && spots.length < 30; lat += 7) {
      for (let lon = -180; lon < 180 && spots.length < 30; lon += 11) {
        const d = latLonToDir(lat, lon);
        if (heightMap.sample(d) >= terrain.seaLevel || waterBodies.sample(d) >= 0.5) continue;
        const north = new Vector3();
        const east = new Vector3();
        tangentFrame(d, north, east);
        for (let b = 0; b < 8; b++) {
          const a = (b * Math.PI) / 4;
          const dir = north.clone().multiplyScalar(Math.cos(a)).addScaledVector(east, Math.sin(a));
          const probe = step(d, dir, 35);
          if (heightMap.sample(probe) >= terrain.seaLevel) {
            spots.push(d);
            break;
          }
        }
      }
    }

    let hunts = 0;
    const lost: string[] = [];
    spots.forEach((spot, i) => {
      const h: Harness = {
        hunt: createLeviathan({
          terrain,
          heightMap,
          waterBodies,
          towns,
          harpoons: locker(0),
          seed: 100 + i,
          onEvent: () => {},
        }),
        events: [],
        spares: locker(0),
      };
      if (!h.hunt.force(shipAt(spot.clone(), 0))) return;
      hunts++;
      for (let f = 0; f < 1200; f++) {
        h.hunt.update(0.1, parkOnMark(h, 40), false);
        if (h.hunt.state.phase !== 'drifting') {
          lost.push(`spot ${i} at ${(f * 0.1).toFixed(1)} s`);
          break;
        }
      }
    });

    expect(hunts).toBeGreaterThan(20);
    expect(lost, lost.join('\n')).toEqual([]);
  });

  it('lays every segment on the path the head swam', () => {
    /*
     * The body rides the head's recorded path. Astern along the head's
     * heading made it a rod that swung through every turn; drawn after the
     * segment in front, it cut inside tight ones. Either way a segment left
     * water the head had crossed.
     */
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const dt = 1 / 60;
    const path: Vector3[] = [];
    const startForward = h.hunt.state.shadows[0].forward.clone();
    let turned = 0;
    for (let f = 0; f < 60 * 30; f++) {
      h.hunt.update(dt, parkOnMark(h, 40), false);
      const head = h.hunt.state.shadows[0];
      path.push(head.position.clone());
      turned = Math.max(turned, Math.acos(Math.min(1, Math.abs(head.forward.dot(startForward)))));
    }
    // The head has to have actually turned, or a rod would pass too.
    expect(turned).toBeGreaterThan((20 * Math.PI) / 180);

    const recent = path.slice(-60 * 10);
    for (const shadow of h.hunt.state.shadows) {
      let nearest = Infinity;
      for (const point of recent) nearest = Math.min(nearest, arc(point, shadow.position));
      expect(nearest, `rank ${shadow.rank} off the head's path`).toBeLessThan(0.15);
    }
  });

  it('forgives a mark brushing land for under a second, and not a mark aground', () => {
    /*
     * The world's map carries sandbars a fraction of a unit wide. A hunt ends
     * once the mark has been over land for `AGROUND_SECONDS`, not on the
     * first frame it touches any.
     */
    const flood = { land: false };
    const hunt = createLeviathan({
      ...OPEN_OCEAN,
      heightMap: {
        ...OPEN_OCEAN.heightMap,
        sample: (d: Vector3) => (flood.land ? 1e6 : OPEN_OCEAN.heightMap.sample(d)),
      },
      harpoons: locker(20),
      seed: 7,
      onEvent: () => {},
    });
    const h: Harness = { hunt, events: [], spares: locker(20) };
    hunt.force(shipAt(latLonToDir(0, 0)));
    hunt.update(0.1, parkOnMark(h, 40), false);

    flood.land = true;
    for (let t = 0; t < (AGROUND_SECONDS * 0.8) / 0.1; t++) hunt.update(0.1, parkOnMark(h, 40), false);
    expect(hunt.state.phase).toBe('drifting');

    // Back on water resets the count, so the next brush starts from nothing.
    flood.land = false;
    hunt.update(0.1, parkOnMark(h, 40), false);
    flood.land = true;
    for (let t = 0; t < (AGROUND_SECONDS * 0.8) / 0.1; t++) hunt.update(0.1, parkOnMark(h, 40), false);
    expect(hunt.state.phase).toBe('drifting');

    for (let t = 0; t < (AGROUND_SECONDS * 0.5) / 0.1; t++) hunt.update(0.1, parkOnMark(h, 40), false);
    expect(hunt.state.phase).toBe('settling');
  });
});
