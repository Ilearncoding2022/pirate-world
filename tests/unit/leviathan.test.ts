import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  BOW_ARC,
  DESPAWN_RANGE,
  DIAL_PERIOD,
  FADE_OUT,
  HARPOON_RANGE,
  HUNT_GOLD_PER_DAMAGE,
  HUNT_TARGETS,
  ROLL_PERIOD,
  SHOAL_COUNT,
  SHOAL_SPAWN_MAX,
  SHOAL_SPAWN_MIN,
  SOUND_BELOW,
  createLeviathan,
  damageAt,
  huntGold,
} from '../../src/leviathan';
import type { HuntEvent, HuntLocker, Leviathan } from '../../src/leviathan';
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

/** Runs `seconds` of frames at `dt`, holding the ship still. */
function sail(h: Harness, ship: ShipState, seconds: number, dt = 1 / 60): void {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) h.hunt.update(dt, ship, false);
}

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

  it('puts the sound threshold at three quarters out', () => {
    // SOUND_BELOW is 25 damage, which is |p| > 0.75. Both sides of the edge,
    // because this is the number that decides whether a hunt continues.
    expect(damageAt(0.74)).toBeGreaterThanOrEqual(SOUND_BELOW);
    expect(damageAt(0.76)).toBeLessThan(SOUND_BELOW);
  });

  it('refuses a number that is not one', () => {
    expect(damageAt(Number.NaN)).toBe(0);
    expect(damageAt(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('the purse', () => {
  it('pays ten a point, rounded to fifty', () => {
    expect(huntGold(500)).toBe(500 * HUNT_GOLD_PER_DAMAGE);
    expect(huntGold(0)).toBe(0);
    expect(huntGold(-5)).toBe(0);
  });

  it('never pays a figure that is not a quoted price', () => {
    for (const banked of [1, 37, 182, 425, 499]) {
      expect(huntGold(banked) % 50).toBe(0);
    }
  });

  it('sits under a won fight at its very best', () => {
    // `bounty.ts`'s top tier is 20 000. A perfect hunt must not beat it, or
    // the fight stops being the jackpot. See docs/LEVIATHAN_PLAN.md.
    expect(huntGold(100 * HUNT_TARGETS)).toBeLessThan(20000);
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

    for (const shadow of h.hunt.state.shadows) {
      const d = arc(ship.position, shadow.position);
      // The centre is laid at SHOAL_SPAWN_MIN and the shadows spread about it,
      // so the band is the centre's distance give or take the shoal's radius.
      expect(d).toBeGreaterThan(SHOAL_SPAWN_MIN - 12);
      expect(d).toBeLessThan(SHOAL_SPAWN_MAX);
    }
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
  it('starts at the centre and sweeps to an end in a quarter period', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);

    h.hunt.update(ARM_DT, ship, false);
    expect(h.hunt.state.armed).toBe(true);
    expect(damageAt(h.hunt.state.dial)).toBe(100);

    sail(h, ship, DIAL_PERIOD / 4 - ARM_DT, 1 / 240);
    expect(Math.abs(h.hunt.state.dial)).toBeCloseTo(1, 2);
    expect(damageAt(h.hunt.state.dial)).toBeLessThan(2);
  });

  it('restarts its sweep every time it arms', () => {
    /*
     * A player who loses the target and comes round again must get the dial
     * from a known start. Half a period out of the arc and back would
     * otherwise hand them the far end of the sweep on the frame they arrive.
     */
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const on = parkOnMark(h, HARPOON_RANGE * 0.5);
    const off = parkOnMark(h, HARPOON_RANGE * 0.5, BOW_ARC * 2);

    sail(h, on, DIAL_PERIOD / 4, 1 / 240);
    expect(Math.abs(h.hunt.state.dial)).toBeGreaterThan(0.9);

    h.hunt.update(ARM_DT, off, false);
    expect(h.hunt.state.armed).toBe(false);

    h.hunt.update(ARM_DT, on, false);
    expect(h.hunt.state.armed).toBe(true);
    expect(damageAt(h.hunt.state.dial)).toBe(100);
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
      // Re-aimed at the mark each time: the mark moves on every hit, which is
      // the whole reason the helm stays in play between targets.
      const ship = parkOnMark(h, HARPOON_RANGE * 0.5);
      h.hunt.update(ARM_DT, ship, false);
      expect(h.hunt.state.armed).toBe(true);
      expect(h.hunt.fire()).toBe(100);
    }

    expect(h.hunt.state.banked).toBe(100 * HUNT_TARGETS);
    expect(h.spares.taken).toBe(HUNT_TARGETS);

    const settled = h.events.filter((e) => e.kind === 'settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].damage).toBe(100 * HUNT_TARGETS);
    expect(settled[0].gold).toBe(huntGold(100 * HUNT_TARGETS));
    expect(h.events.filter((e) => e.kind === 'hit')).toHaveLength(HUNT_TARGETS);
  });

  it('moves the mark off the shadow it just hit', () => {
    const h = open();
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);
    h.hunt.update(ARM_DT, ship, false);

    const before = h.hunt.state.shadows.findIndex((s) => s.marked);
    h.hunt.fire();
    const after = h.hunt.state.shadows.findIndex((s) => s.marked);

    expect(after).not.toBe(before);
    expect(h.hunt.state.shadows.filter((s) => s.marked)).toHaveLength(1);
  });

  it('scatters on a press under the sound threshold, paying what was banked', () => {
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));

    // One good target, then one bad one.
    const first = parkOnMark(h, HARPOON_RANGE * 0.5);
    h.hunt.update(ARM_DT, first, false);
    expect(h.hunt.fire()).toBe(100);

    const second = parkOnMark(h, HARPOON_RANGE * 0.5);
    // A quarter period lands the needle at an end of the bar, which is inside
    // the red beyond the notch.
    sail(h, second, DIAL_PERIOD / 4, 1 / 240);
    const damage = h.hunt.fire();
    expect(damage).toBeLessThan(SOUND_BELOW);

    expect(h.hunt.state.phase).toBe('settling');
    expect(h.hunt.state.target).toBe(2);

    const sounded = h.events.filter((e) => e.kind === 'sounded');
    expect(sounded).toHaveLength(1);
    expect(sounded[0].damage).toBe(100 + damage);
    expect(sounded[0].gold).toBe(huntGold(100 + damage));
    // Three targets were never offered, and their harpoons were never spent.
    expect(h.spares.taken).toBe(2);
  });

  it('pays once, whatever the fade does afterwards', () => {
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const ship = parkOnMark(h, HARPOON_RANGE * 0.5);
    sail(h, ship, DIAL_PERIOD / 4, 1 / 240);
    h.hunt.fire();

    const paid = h.events.filter((e) => e.gold > 0).length;
    sail(h, ship, FADE_OUT * 3);
    expect(h.hunt.state.phase).toBe('idle');
    expect(h.hunt.state.shadows).toHaveLength(0);
    expect(h.events.filter((e) => e.gold > 0)).toHaveLength(paid);
  });
});

describe('the three ways a hunt ends without a press', () => {
  it('ends when the player sails out of range, paying what was banked', () => {
    const h = open(20);
    h.hunt.force(shipAt(latLonToDir(0, 0)));
    const near = parkOnMark(h, HARPOON_RANGE * 0.5);
    h.hunt.update(ARM_DT, near, false);
    h.hunt.fire();

    const far = parkOnMark(h, DESPAWN_RANGE + 10);
    h.hunt.update(1 / 60, far, false);

    expect(h.hunt.state.phase).toBe('settling');
    const ended = h.events.filter((e) => e.kind === 'sounded');
    expect(ended).toHaveLength(1);
    expect(ended[0].gold).toBe(huntGold(100));
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
