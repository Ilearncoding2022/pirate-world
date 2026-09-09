import { describe, it, expect } from 'vitest';
import {
  HULL_CAP_CRITICAL,
  HULL_CAP_FAILING,
  HULL_CAP_WORN,
  HULL_MIN,
  HULL_REPAIR_RATE,
  HULL_WEAR,
  createHull,
  createStubHull,
} from '../../src/hull';
import { DOCK_NET_RATE } from '../../src/energy';

/**
 * `hull.ts`'s arithmetic: the wear, the repair, the two floors and the
 * four-row derived table.
 *
 * The sim is pure — two booleans and a `dt` in, a percent out — so nothing
 * here needs a DOM, a globe or a frame. What it is NOT allowed to do is
 * assert on how any of it looks; the HUD's tags and bands are the owner's
 * eye, per docs/TESTING.md.
 *
 * One thing to know before reading the wear cases. The float inside is
 * deliberately private and `percent` is a ROUNDING of it, so "60 s of wear is
 * 0.25" cannot be read off `state.percent` directly — 99.75 publishes as 100.
 * It is measured two ways instead, both through the public surface: by how
 * much repair it takes to put the hull back on the top (`mode` reads `'full'`
 * only at 100), and by when the published percent actually crosses.
 */

const DT = 1 / 60;

/** Runs `seconds` of frames at 60 Hz under one pair of conditions. */
function run(
  hull: ReturnType<typeof createHull>,
  seconds: number,
  docked: boolean,
  weathered: boolean,
): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) hull.update(DT, docked, weathered);
}

describe('hull: the rates', () => {
  it('wears a quarter of a percent a minute, and exactly twice that in weather', () => {
    // 0.24 of repair is not enough to put a minute's wear back and 0.26 is,
    // which pins the minute to within a hundredth of a percent without this
    // test having to see the float.
    const dry = createHull(100);
    run(dry, 60, false, false);
    dry.repair(0.24);
    expect(dry.state.mode).toBe('wearing');
    dry.repair(0.02);
    expect(dry.state.mode).toBe('full');

    const wet = createHull(100);
    run(wet, 60, false, true);
    wet.repair(0.49);
    expect(wet.state.mode).toBe('weathering');
    wet.repair(0.02);
    expect(wet.state.mode).toBe('full');

    // And the doubling never stacks: `update` is handed ONE boolean, so
    // storm-and-rain-and-fog is the same 2x as any one of them by
    // construction. The constant is the only place a third factor could
    // appear.
    expect(HULL_WEAR).toBeCloseTo(0.25 / 60, 12);
  });

  it('publishes the crossing at half a percent, twice as soon in weather', () => {
    // 0.25 %/min means the printed figure leaves 100 when the float passes
    // 99.5, which is two minutes. This is the same arithmetic as the case
    // above, read in the unit the player actually sees.
    const dry = createHull(100);
    run(dry, 100, false, false);
    expect(dry.state.percent).toBe(100);
    run(dry, 21, false, false);
    expect(dry.state.percent).toBe(99);

    const wet = createHull(100);
    run(wet, 50, false, true);
    expect(wet.state.percent).toBe(100);
    run(wet, 11, false, true);
    expect(wet.state.percent).toBe(99);
  });

  it('repairs at the berth at exactly the rate shore power charges at', () => {
    // The claim the README makes as one figure: fifty seconds alongside takes
    // the tank and the hull from empty to full together. If `energy.ts`'s
    // gross DOCK_RATE were ever picked up here instead of the net one, this
    // would be 2% adrift.
    expect(HULL_REPAIR_RATE).toBeCloseTo(DOCK_NET_RATE * 100, 12);
    expect(HULL_REPAIR_RATE).toBeCloseTo(2, 12);

    const hull = createHull(HULL_MIN);
    run(hull, 25, true, false);
    // 1 + 25 * 2 = 51, and the tank would be half full on the same clock.
    expect(hull.state.percent).toBe(51);
    expect(hull.state.mode).toBe('repairing');
    expect(hull.state.rate).toBeCloseTo(2, 12);

    // Fifty seconds from the floor is the whole way, and it stops there.
    run(hull, 25, true, false);
    expect(hull.state.percent).toBe(100);
    run(hull, 10, true, false);
    expect(hull.state.percent).toBe(100);
  });

  it('lets docked beat weathered, whatever the weather is doing', () => {
    const hull = createHull(50);
    run(hull, 10, true, true);
    // Repairing at 2%/s, not wearing at 0.5%/min: 20 points up, not down.
    expect(hull.state.percent).toBe(70);
    expect(hull.state.mode).toBe('repairing');
    expect(hull.state.rate).toBeCloseTo(2, 12);
  });

  it('reads the rate off what the value is actually doing, not what it was told', () => {
    const fresh = createHull(100);
    // Nothing has been asked of it yet: a fresh hull at sea is wearing.
    expect(fresh.state.mode).toBe('full');
    expect(fresh.state.rate).toBeCloseTo(-HULL_WEAR, 12);

    fresh.update(0, true, false);
    // Full and alongside: there is nothing to repair, so the readout is 0
    // rather than a rate the value is not moving by.
    expect(fresh.state.mode).toBe('full');
    expect(fresh.state.rate).toBe(0);

    const floored = createHull(HULL_MIN);
    floored.update(0, false, true);
    // On the floor at sea: it cannot fall any further, so the same rule.
    expect(floored.state.mode).toBe('weathering');
    expect(floored.state.rate).toBe(0);

    const worn = createHull(60);
    worn.update(0, false, true);
    expect(worn.state.mode).toBe('weathering');
    expect(worn.state.rate).toBeCloseTo(-2 * HULL_WEAR, 12);
    worn.update(0, false, false);
    expect(worn.state.mode).toBe('wearing');
    expect(worn.state.rate).toBeCloseTo(-HULL_WEAR, 12);
  });

  it('ignores a dt that is not a length of time', () => {
    const hull = createHull(50);
    hull.update(Number.NaN, false, false);
    hull.update(-1, false, false);
    hull.update(Number.POSITIVE_INFINITY, false, false);
    expect(hull.state.percent).toBe(50);
  });
});

describe('hull: the floors and the caps', () => {
  it('floors at 1 under any amount of damage, and never reaches 0', () => {
    const hull = createHull(100);
    hull.damage(200);
    expect(hull.state.percent).toBe(HULL_MIN);
    hull.damage(15);
    expect(hull.state.percent).toBe(HULL_MIN);
    // The floor is the whole of the no-sinking rule: still steering, still
    // able to reach a berth.
    expect(hull.state.speedCap).toBe(HULL_CAP_CRITICAL);
  });

  it('caps at 100 under any amount of repair', () => {
    const hull = createHull(40);
    hull.repair(200);
    expect(hull.state.percent).toBe(100);
    expect(hull.state.mode).toBe('full');
    hull.repair(10);
    expect(hull.state.percent).toBe(100);
  });

  it('wears no further than the floor and repairs no further than the top', () => {
    const low = createHull(HULL_MIN);
    run(low, 600, false, true);
    expect(low.state.percent).toBe(HULL_MIN);

    const high = createHull(100);
    run(high, 600, true, false);
    expect(high.state.percent).toBe(100);
  });

  it('takes nothing from a damage or a repair that is not a positive number', () => {
    const hull = createHull(50);
    hull.damage(0);
    hull.damage(-10);
    hull.damage(Number.NaN);
    hull.repair(0);
    hull.repair(-10);
    hull.repair(Number.NaN);
    expect(hull.state.percent).toBe(50);
  });

  it('reads a missing or broken initial percent as a full hull', () => {
    expect(createHull(Number.NaN).state.percent).toBe(100);
    expect(createHull().state.percent).toBe(100);
    // And clamps a file that holds something out of range, rather than
    // trusting it: `save.ts` repairs, and so does this.
    expect(createHull(0).state.percent).toBe(HULL_MIN);
    expect(createHull(1000).state.percent).toBe(100);
  });
});

describe('hull: the derived table', () => {
  /*
   * docs/HARBOURS_PLAN.md's four rows, at every edge of every one of them.
   * The bands are read off the float rather than off the published percent,
   * which is why 49.99 is a worn hull even though it prints as 50%.
   */
  it('speedCap, at each boundary', () => {
    expect(createHull(100).state.speedCap).toBe(Infinity);
    expect(createHull(50).state.speedCap).toBe(Infinity);
    expect(createHull(49.99).state.speedCap).toBe(HULL_CAP_WORN);
    expect(createHull(25).state.speedCap).toBe(HULL_CAP_WORN);
    expect(createHull(24.99).state.speedCap).toBe(HULL_CAP_FAILING);
    expect(createHull(2).state.speedCap).toBe(HULL_CAP_FAILING);
    expect(createHull(1.99).state.speedCap).toBe(HULL_CAP_CRITICAL);
    expect(createHull(HULL_MIN).state.speedCap).toBe(HULL_CAP_CRITICAL);
  });

  it('canFish, at each boundary', () => {
    expect(createHull(100).state.canFish).toBe(true);
    expect(createHull(25).state.canFish).toBe(true);
    expect(createHull(24.99).state.canFish).toBe(false);
    expect(createHull(HULL_MIN).state.canFish).toBe(false);
  });

  it('hitsToLose, at each boundary', () => {
    expect(createHull(100).state.hitsToLose).toBe(3);
    expect(createHull(50).state.hitsToLose).toBe(3);
    expect(createHull(49.99).state.hitsToLose).toBe(2);
    expect(createHull(25).state.hitsToLose).toBe(2);
    expect(createHull(24.99).state.hitsToLose).toBe(1);
    expect(createHull(HULL_MIN).state.hitsToLose).toBe(1);
  });

  it('re-derives after a damage rather than serving a cached band', () => {
    const hull = createHull(100);
    expect(hull.state.speedCap).toBe(Infinity);
    hull.damage(51);
    expect(hull.state.percent).toBe(49);
    expect(hull.state.speedCap).toBe(HULL_CAP_WORN);
    expect(hull.state.hitsToLose).toBe(2);
    expect(hull.state.canFish).toBe(true);
    hull.damage(25);
    expect(hull.state.speedCap).toBe(HULL_CAP_FAILING);
    expect(hull.state.hitsToLose).toBe(1);
    expect(hull.state.canFish).toBe(false);
    hull.repair(76);
    expect(hull.state.percent).toBe(100);
    expect(hull.state.speedCap).toBe(Infinity);
    expect(hull.state.canFish).toBe(true);
  });
});

describe('hull: the save throttle', () => {
  it('fires once per whole percent and not once per frame', () => {
    let calls = 0;
    const hull = createHull(100);
    hull.onChange(() => {
      calls++;
    });

    // Subscribing does not fire: `save.ts`'s wallet already writes the file
    // once at boot and a second identical write would be a round trip for
    // nothing.
    expect(calls).toBe(0);

    // Two minutes of wear is one crossing, out of 7200 frames.
    run(hull, 121, false, false);
    expect(hull.state.percent).toBe(99);
    expect(calls).toBe(1);

    // Another two minutes is another crossing and no more than that: the
    // printed figure steps once per four minutes of wear after the first,
    // because 100 is only half a percent from the first edge and every edge
    // after it is a whole one.
    run(hull, 120, false, false);
    expect(hull.state.percent).toBe(99);
    expect(calls).toBe(1);

    run(hull, 120, false, false);
    expect(hull.state.percent).toBe(98);
    expect(calls).toBe(2);
  });

  it('fires on a damage and a repair, once each, and not on one that changes nothing', () => {
    let calls = 0;
    const hull = createHull(100);
    hull.onChange(() => {
      calls++;
    });

    hull.damage(15);
    expect(calls).toBe(1);
    hull.repair(15);
    expect(calls).toBe(2);
    // Already at the top: the value cannot move, so neither can the file.
    hull.repair(15);
    expect(calls).toBe(2);
  });

  it('lets a subscriber drop itself from inside its own callback', () => {
    // The contract `battery.ts` and `wallet.ts` both keep, pinned here
    // because it is only true while the notify loop runs over a copy.
    const hull = createHull(100);
    let calls = 0;
    hull.onChange(() => {
      calls++;
    });
    expect(() => hull.damage(1)).not.toThrow();
    expect(calls).toBe(1);
  });
});

describe('hull: the ?hull= override', () => {
  it('sets the value without writing the save', () => {
    let calls = 0;
    const hull = createHull(100);
    hull.onChange(() => {
      calls++;
    });

    hull.override(24);
    expect(hull.state.percent).toBe(24);
    expect(hull.state.speedCap).toBe(HULL_CAP_FAILING);
    expect(hull.state.canFish).toBe(false);
    // The whole reason the method exists: a dev query must not leave itself
    // in the file for the next ordinary load to find.
    expect(calls).toBe(0);
  });

  it('measures the next crossing from where the query put the hull', () => {
    let calls = 0;
    const hull = createHull(100);
    hull.onChange(() => {
      calls++;
    });
    hull.override(49);
    // Not from 100: an override that left `lastPercent` at the old figure
    // would fire on the very next frame of wear.
    run(hull, 60, false, false);
    expect(calls).toBe(0);
    run(hull, 61, false, false);
    expect(hull.state.percent).toBe(48);
    expect(calls).toBe(1);
  });

  it('clamps an out-of-range query the same way the file is clamped', () => {
    const hull = createHull(100);
    hull.override(0);
    expect(hull.state.percent).toBe(HULL_MIN);
    hull.override(1e6);
    expect(hull.state.percent).toBe(100);
    hull.override(Number.NaN);
    expect(hull.state.percent).toBe(100);
  });
});

describe('hull: the stub', () => {
  it('is a sound hull that nothing can move', () => {
    // Kept after Stream B rather than deleted: it is what every optional hull
    // parameter in the project falls back to, so "no hull wired yet" has to
    // stay indistinguishable from the game before durability existed.
    const stub = createStubHull();
    expect(stub.state.percent).toBe(100);
    expect(stub.state.speedCap).toBe(Infinity);
    expect(stub.state.canFish).toBe(true);
    expect(stub.state.hitsToLose).toBe(3);
    expect(stub.state.mode).toBe('full');
    expect(stub.state.rate).toBe(0);

    stub.update(10, false, true);
    stub.damage(50);
    stub.override(1);
    expect(stub.state.percent).toBe(100);
    expect(stub.state.speedCap).toBe(Infinity);
  });
});
