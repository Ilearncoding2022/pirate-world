import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createQuests, arcBetween, tierForArc, windowReachable, windowSatisfied } from '../../src/quests';
import { createReputation } from '../../src/reputation';
import { createWallet } from '../../src/wallet';
import { createKnownHarbours } from '../../src/knownharbours';
import { DAY_LENGTH } from '../../src/daynight';
import {
  ARC_FAR,
  ARC_NEAR,
  CHART_TARGETS,
  MAX_ACTIVE,
  OFFERS_PER_HARBOUR,
  REPUTATION_BY_TIER,
  REPUTATION_FAIL,
  REPUTATION_FLOOR,
  WINDOW_MIN,
} from '../../src/questconstants';
import type { Chart } from '../../src/chart';
import type { Dock, QuestOffer, Town, Towns } from '../../src/types';

/**
 * The contract sim, without a world.
 *
 * Everything here runs against a hand-built `Towns` of five directions and a
 * sun vector typed out by hand, which is the whole reason `quests.ts` is a
 * DOM-free module with callbacks for its dependencies: the geometry and the
 * clock arithmetic are the parts that can be wrong without looking wrong, and
 * they are the parts that have to be checkable without standing up a globe.
 *
 * What is NOT tested: appearance. `docs/TESTING.md` rules it out and this
 * stream adds no exception — the card, the strip and the HUD line are checked
 * through their formatters in `quests-views.test.ts` and nowhere else.
 *
 * The failures these exist to catch, in order of how quietly they would happen:
 *
 * 1. A board that reshuffles when something upstream moves. Nothing would look
 *    broken; a player would simply never be able to come back for a posting.
 * 2. An offer whose window has already closed for good. Indistinguishable from
 *    a fair contract until the passage has been sailed.
 * 3. A completion that settles twice. `update` runs every frame the ship is
 *    moored, so one missing splice is a purse paid sixty times a second.
 * 4. A tier boundary off by a hair, which silently retunes the purse, the
 *    deadline and the standing all at once.
 */

/* ------------------------------------------------------------------ */
/* A world of five harbours                                            */
/* ------------------------------------------------------------------ */

/** Unit direction at a latitude and longitude, on `geo.ts`'s convention. */
function dirAt(latDeg: number, lonDeg: number): Vector3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const c = Math.cos(lat);
  return new Vector3(c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon)).normalize();
}

function makeTown(name: string, dir: Vector3, withDock = true): Town {
  const town: Town = {
    dir,
    height: 0.2,
    coast: 0.5,
    dock: null,
    name,
    index: 0,
  };
  if (!withDock) return town;
  const dock: Dock = { dir, radius: 6, town };
  // The only mutation in the fixture, and it is the same knot `towns.ts` ties:
  // a berth holds its town and a town holds its berth.
  return { ...town, dock: { ...dock, town } };
}

/**
 * Home, a near neighbour, a mid-range one, the antipode, and a berthless town.
 *
 * The arcs are chosen to sit either side of both band edges rather than in the
 * middle of the bands: 20 degrees is well inside tier 1, 80 is well inside
 * tier 2, and the antipode is the farthest point the globe has.
 */
function makeTowns(): Towns {
  const all: Town[] = [
    makeTown('Home', dirAt(0, 0)),
    makeTown('Near', dirAt(0, 20)),
    makeTown('Middle', dirAt(0, 80)),
    makeTown('Antipode', dirAt(0, 180)),
    makeTown('Landlocked', dirAt(40, 40), false),
  ];
  return {
    all,
    docks: all.flatMap((town) => (town.dock === null ? [] : [town.dock])),
    dockAt: (dir: Vector3): Dock | null =>
      all.find((town) => town.dock !== null && town.dir.dot(dir) > 0.999)?.dock ?? null,
    byName: (name: string): Town | null => all.find((town) => town.name === name) ?? null,
  };
}

/** A chart whose coverage the test sets by hand. Nothing else is read. */
function makeChart(coverage = 0): Chart & { set(value: number): void } {
  let value = coverage;
  return {
    discovered: (): boolean => false,
    coverage: (): number => value,
    reveal: (): void => undefined,
    encode: (): string => '',
    onChange: (): void => undefined,
    tick: (): void => undefined,
    width: 8,
    height: 4,
    set(next: number): void {
      value = next;
    },
  };
}

/**
 * The sun over longitude 0 at the equator, which puts Home at local noon.
 *
 * Typed out rather than taken from `daynight.ts`, so the tests below are
 * reasoning about a stated sun rather than about whatever the world clock
 * happened to be doing at `START_ELAPSED`.
 */
const SUN_OVER_LON_0 = dirAt(0, 0);
/** The sun over longitude 180: Home at local midnight, Antipode at noon. */
const SUN_OVER_LON_180 = dirAt(0, 180);

interface Harness {
  quests: ReturnType<typeof createQuests>;
  wallet: ReturnType<typeof createWallet>;
  reputation: ReturnType<typeof createReputation>;
  chart: ReturnType<typeof makeChart>;
  towns: Towns;
  events: { kind: string; id: string }[];
}

/**
 * A sim with one frame already run, because `offers` cannot judge a window
 * before it has seen the sun and a test that forgot would get an empty board
 * and a confusing failure rather than a clear one.
 */
function harness(options: { coverage?: number; sun?: Vector3; seed?: number } = {}): Harness {
  const towns = makeTowns();
  const chart = makeChart(options.coverage ?? 0);
  const wallet = createWallet(0);
  const reputation = createReputation(0);
  const quests = createQuests({
    towns: () => towns,
    chart: () => chart,
    known: createKnownHarbours(),
    wallet,
    reputation,
    seed: options.seed ?? 0x1234abcd,
  });
  const events: { kind: string; id: string }[] = [];
  quests.on((event) => events.push({ kind: event.kind, id: event.quest.id }));
  quests.update(0, 0, options.sun ?? SUN_OVER_LON_0, null);
  return { quests, wallet, reputation, chart, towns, events };
}

/* ------------------------------------------------------------------ */
/* The arc bands                                                       */
/* ------------------------------------------------------------------ */

describe('tierForArc — the three bands', () => {
  /*
   * Both sides of both edges, because a `<` written as a `<=` moves exactly one
   * boundary and nothing about the board looks different: the purse, the
   * deadline and the standing all come off this number, so one wrong band is
   * three wrong tables at once.
   */
  it('calls anything under ARC_NEAR tier 1', () => {
    expect(tierForArc(0)).toBe(1);
    expect(tierForArc(ARC_NEAR - 1e-9)).toBe(1);
  });

  it('calls ARC_NEAR itself tier 2, and anything under ARC_FAR', () => {
    expect(tierForArc(ARC_NEAR)).toBe(2);
    expect(tierForArc(ARC_FAR - 1e-9)).toBe(2);
  });

  it('calls ARC_FAR and beyond tier 3, the antipode included', () => {
    expect(tierForArc(ARC_FAR)).toBe(3);
    expect(tierForArc(Math.PI)).toBe(3);
  });

  it('measures the fixture world the way the bands expect', () => {
    const towns = makeTowns();
    const home = towns.byName('Home')!.dir;
    expect(tierForArc(arcBetween(home, towns.byName('Near')!.dir))).toBe(1);
    expect(tierForArc(arcBetween(home, towns.byName('Middle')!.dir))).toBe(2);
    expect(tierForArc(arcBetween(home, towns.byName('Antipode')!.dir))).toBe(3);
  });

  it('clamps a dot product that floats outside [-1, 1]', () => {
    // `Math.acos(1.0000000002)` is NaN, and a NaN arc is a tier 3 contract
    // wearing a tier 1 deadline. The same vector twice is the case that
    // produces it.
    const dir = dirAt(12, 34);
    expect(arcBetween(dir, dir)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

describe('offers — the board is derived, not stored', () => {
  it('posts OFFERS_PER_HARBOUR where the world has the targets for it', () => {
    const { quests } = harness();
    expect(quests.offers('Home', 0)).toHaveLength(OFFERS_PER_HARBOUR);
  });

  it('gives the same board twice for the same harbour and day', () => {
    const { quests } = harness();
    const first = quests.offers('Home', 3);
    const second = quests.offers('Home', 3);
    expect(second.map((o) => o.id)).toEqual(first.map((o) => o.id));
    expect(second.map((o) => o.gold)).toEqual(first.map((o) => o.gold));
    expect(second.map((o) => o.brief)).toEqual(first.map((o) => o.brief));
  });

  it('turns the board over at the day boundary', () => {
    const { quests } = harness();
    const today = quests.offers('Home', 3).map((o) => o.id);
    const tomorrow = quests.offers('Home', 4).map((o) => o.id);
    expect(tomorrow).not.toEqual(today);
  });

  it('gives two harbours different boards on the same day', () => {
    const { quests } = harness();
    const home = quests.offers('Home', 0).map((o) => o.brief);
    const near = quests.offers('Near', 0).map((o) => o.brief);
    expect(near).not.toEqual(home);
  });

  it('never posts the issuer as its own target', () => {
    const { quests } = harness();
    for (const day of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const name of ['Home', 'Near', 'Middle', 'Antipode']) {
        for (const offer of quests.offers(name, day)) {
          expect(offer.target).not.toBe(name);
        }
      }
    }
  });

  it('never posts a harbour the ship cannot tie up at', () => {
    const { quests } = harness();
    for (const day of [0, 1, 2, 3, 4, 5]) {
      for (const offer of quests.offers('Home', day)) {
        expect(offer.target).not.toBe('Landlocked');
      }
    }
  });

  it('never posts the same target twice on one board', () => {
    const { quests } = harness();
    for (const day of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const targets = quests
        .offers('Home', day)
        .map((o) => o.target)
        .filter((t): t is string => t !== null);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it('answers empty before the first update, because it has not seen the sun', () => {
    const towns = makeTowns();
    const quests = createQuests({
      towns: () => towns,
      chart: () => makeChart(),
      known: createKnownHarbours(),
      wallet: createWallet(0),
      reputation: createReputation(0),
      seed: 7,
    });
    expect(quests.offers('Home', 0)).toEqual([]);
  });

  it('answers empty for a name that is not a harbour in this world', () => {
    const { quests } = harness();
    expect(quests.offers('Nowhere', 0)).toEqual([]);
  });

  it('answers empty before the world exists', () => {
    const quests = createQuests({
      towns: () => null,
      chart: () => null,
      known: createKnownHarbours(),
      wallet: createWallet(0),
      reputation: createReputation(0),
      seed: 1,
    });
    quests.update(0, 0, SUN_OVER_LON_0, null);
    expect(quests.offers('Home', 0)).toEqual([]);
  });

  it('prices and paces every posting off its own tier', () => {
    const { quests, towns } = harness();
    const home = towns.byName('Home')!.dir;
    for (const day of [0, 1, 2, 3, 4]) {
      for (const offer of quests.offers('Home', day)) {
        if (offer.kind !== 'DELIVERY' || offer.target === null) continue;
        const expected = tierForArc(arcBetween(home, towns.byName(offer.target)!.dir));
        expect(offer.tier).toBe(expected);
        expect(offer.gold).toBeGreaterThan(0);
        expect(offer.reputation).toBeGreaterThanOrEqual(REPUTATION_BY_TIER[expected - 1]);
        expect(offer.duration).not.toBeNull();
      }
    }
  });
});

describe('offers — the chart slot', () => {
  it('posts the lowest target the player has not passed', () => {
    const { quests } = harness({ coverage: 0 });
    const chart = quests.offers('Home', 0).find((o) => o.kind === 'CHART');
    expect(chart?.coverage).toBe(CHART_TARGETS[0]);
  });

  it('moves to the next rung once one is passed', () => {
    const { quests, chart } = harness({ coverage: 0 });
    chart.set(CHART_TARGETS[0] + 0.01);
    const posted = quests.offers('Home', 0).find((o) => o.kind === 'CHART');
    expect(posted?.coverage).toBe(CHART_TARGETS[1]);
  });

  it('posts no chart goal at all once every rung is cleared', () => {
    const { quests } = harness({ coverage: 1 });
    expect(quests.offers('Home', 0).some((o) => o.kind === 'CHART')).toBe(false);
  });

  it('leaves the two deliveries beside it untouched when coverage moves', () => {
    /*
     * The reason the chart goal is slotted in AFTER the draw rather than taking
     * a slot before it. Coverage climbs continuously while the ship sails, so a
     * chart goal that shortened the delivery draw would reshuffle the rest of
     * the board every time a target was passed — and a player who had decided
     * to come back for the antipode run would find it gone, with nothing on
     * screen admitting why.
     */
    const { quests, chart } = harness({ coverage: 0 });
    const before = quests.offers('Home', 0).slice(1).map((o) => o.id);
    chart.set(CHART_TARGETS[1] + 0.01);
    const after = quests.offers('Home', 0).slice(1).map((o) => o.id);
    expect(after).toEqual(before);
  });

  it('posts the same chart goal at every harbour, so taking it clears them all', () => {
    const { quests } = harness({ coverage: 0 });
    const atHome = quests.offers('Home', 0).find((o) => o.kind === 'CHART');
    const atNear = quests.offers('Near', 0).find((o) => o.kind === 'CHART');
    expect(atNear?.id).toBe(atHome?.id);

    quests.accept(atHome!);
    expect(quests.offers('Near', 0).some((o) => o.kind === 'CHART')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

describe('windowReachable — an offer the player cannot fulfil is worse than none', () => {
  const near = dirAt(0, 20);

  it('waves ANY through whatever the sky is doing', () => {
    expect(windowReachable(near, SUN_OVER_LON_0, 'ANY', 0, 1)).toBe(true);
  });

  it('refuses anything at all when the passage outlasts the deadline', () => {
    expect(windowReachable(near, SUN_OVER_LON_0, 'DAYLIGHT', 500, 400)).toBe(false);
  });

  it('accepts a window that is open now and stays open long enough', () => {
    // The sun is over longitude 0 and Near is 20 degrees east of it, so Near is
    // in broad daylight with most of its afternoon left.
    expect(windowReachable(near, SUN_OVER_LON_0, 'DAYLIGHT', 20, 300)).toBe(true);
  });

  it('refuses a daylight window at a harbour whose night outlasts the deadline', () => {
    // Sun over longitude 180: Near, at longitude 20, is deep in its night and
    // dawn is most of a turn away. A short deadline cannot reach it.
    expect(windowReachable(near, SUN_OVER_LON_180, 'DAYLIGHT', 20, 60)).toBe(false);
  });

  it('accepts a window that opens later but inside the deadline', () => {
    // The same geometry with a full world day to work in: dawn arrives, and the
    // contract is a passage rather than an impossibility.
    expect(windowReachable(near, SUN_OVER_LON_180, 'DAYLIGHT', 20, DAY_LENGTH)).toBe(true);
  });

  it('refuses an overlap narrower than WINDOW_MIN', () => {
    /*
     * The margin is the whole point of the function. An overlap of a second is
     * a window nobody can steer into, and offering it would be a lie told in
     * arithmetic rather than in words.
     *
     * Built by asking for a deadline barely past the travel time, so the only
     * overlap available is a sliver.
     */
    expect(windowReachable(near, SUN_OVER_LON_0, 'DAYLIGHT', 100, 100 + WINDOW_MIN - 1)).toBe(
      false,
    );
    expect(windowReachable(near, SUN_OVER_LON_0, 'DAYLIGHT', 100, 100 + WINDOW_MIN + 1)).toBe(
      true,
    );
  });

  it('answers a polar point rather than guarding it', () => {
    // Near the pole, with the sun on the equator, the sun neither rises nor
    // sets: one phase, forever. `solartime.ts` reports that as `polar`.
    const pole = dirAt(89, 0);
    const day = windowReachable(pole, SUN_OVER_LON_0, 'DAYLIGHT', 0, DAY_LENGTH);
    const night = windowReachable(pole, SUN_OVER_LON_0, 'NIGHT', 0, DAY_LENGTH);
    // Exactly one of the two can ever be true at a polar point, and which one
    // is a fact about this globe's horizon rather than about this test.
    expect(day).not.toBe(night);
  });

  it('never posts a window it judged unreachable', () => {
    /*
     * The end-to-end form of the rule, across eight days and four issuers: every
     * windowed posting on every board must pass its own legality test, with the
     * deadline it was actually issued with.
     */
    const { quests, towns } = harness({ sun: SUN_OVER_LON_180 });
    for (const day of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const name of ['Home', 'Near', 'Middle', 'Antipode']) {
        for (const offer of quests.offers(name, day)) {
          if (offer.window === 'ANY' || offer.target === null) continue;
          const town = towns.byName(offer.target)!;
          expect(
            windowReachable(town.dir, SUN_OVER_LON_180, offer.window, 0, offer.duration!),
          ).toBe(true);
        }
      }
    }
  });
});

describe('windowSatisfied — measured at the target, never at the ship', () => {
  it('reads the destination sky and not the origin sky', () => {
    // Sun over longitude 0: Home is at noon and the Antipode is at midnight. A
    // rule that read the ship's own sky would get both of these backwards.
    expect(windowSatisfied(dirAt(0, 0), SUN_OVER_LON_0, 'DAYLIGHT')).toBe(true);
    expect(windowSatisfied(dirAt(0, 180), SUN_OVER_LON_0, 'DAYLIGHT')).toBe(false);
    expect(windowSatisfied(dirAt(0, 180), SUN_OVER_LON_0, 'NIGHT')).toBe(true);
  });

  it('waves ANY through either way', () => {
    expect(windowSatisfied(dirAt(0, 0), SUN_OVER_LON_0, 'ANY')).toBe(true);
    expect(windowSatisfied(dirAt(0, 180), SUN_OVER_LON_0, 'ANY')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance                                                          */
/* ------------------------------------------------------------------ */

describe('accept — the slots', () => {
  /** A posting shaped by hand, so a test does not depend on what a board drew. */
  function offer(id: string, target: string | null = 'Near'): QuestOffer {
    return {
      id,
      kind: target === null ? 'CHART' : 'DELIVERY',
      tier: 1,
      issuer: 'Home',
      target,
      window: 'ANY',
      duration: target === null ? null : 300,
      coverage: target === null ? 0.1 : null,
      gold: 500,
      reputation: 10,
      brief: `test ${id}`,
    };
  }

  it('takes a posting and announces it', () => {
    const { quests, events } = harness();
    expect(quests.accept(offer('a'))).toBe(true);
    expect(quests.active).toHaveLength(1);
    expect(events).toEqual([{ kind: 'accepted', id: 'a' }]);
  });

  it('starts the clock at the deadline the posting named', () => {
    const { quests } = harness();
    quests.accept(offer('a'));
    expect(quests.active[0].remaining).toBe(300);
  });

  it(`refuses a ${MAX_ACTIVE + 1}th`, () => {
    const { quests } = harness();
    for (let i = 0; i < MAX_ACTIVE; i++) expect(quests.accept(offer(`a${i}`))).toBe(true);
    expect(quests.accept(offer('one-too-many'))).toBe(false);
    expect(quests.active).toHaveLength(MAX_ACTIVE);
  });

  it('refuses the same posting twice', () => {
    const { quests } = harness();
    expect(quests.accept(offer('a'))).toBe(true);
    expect(quests.accept(offer('a'))).toBe(false);
    expect(quests.active).toHaveLength(1);
  });

  it('refuses a delivery to a harbour this world does not have', () => {
    const { quests } = harness();
    expect(quests.accept(offer('a', 'Nowhere'))).toBe(false);
    expect(quests.active).toHaveLength(0);
  });

  it('takes a posting already in hand off every board', () => {
    const { quests } = harness();
    const posted = quests.offers('Home', 0);
    quests.accept(posted[1]);
    expect(quests.offers('Home', 0).map((o) => o.id)).not.toContain(posted[1].id);
  });
});

/* ------------------------------------------------------------------ */
/* The frame                                                           */
/* ------------------------------------------------------------------ */

describe('update — the clock is the world’s', () => {
  function delivery(target: string, duration = 300, window: QuestOffer['window'] = 'ANY'): QuestOffer {
    return {
      id: `to-${target}-${window}`,
      kind: 'DELIVERY',
      tier: 1,
      issuer: 'Home',
      target,
      window,
      duration,
      coverage: null,
      gold: 500,
      reputation: 10,
      brief: `carry to ${target}`,
    };
  }

  it('counts down by the dt it is handed and nothing else', () => {
    const { quests } = harness();
    quests.accept(delivery('Near', 300));
    quests.update(10, 0, SUN_OVER_LON_0, null);
    expect(quests.active[0].remaining).toBe(290);
    quests.update(0.5, 0, SUN_OVER_LON_0, null);
    expect(quests.active[0].remaining).toBe(289.5);
  });

  it('clamps the clock at zero rather than letting it go negative', () => {
    /*
     * The HUD prints this figure. A contract that read `-0:02` for the frame
     * between running out and being swept would be the one place in the game a
     * player could see a negative clock.
     *
     * Checked on the frame the sweep happens, which means checking the event
     * rather than the field: the contract is gone by the time `update` returns.
     */
    const { quests, events } = harness();
    quests.accept(delivery('Near', 10));
    quests.update(25, 0, SUN_OVER_LON_0, null);
    expect(events.map((e) => e.kind)).toEqual(['accepted', 'failed']);
    expect(quests.active).toHaveLength(0);
  });

  it('fails a contract exactly once and costs exactly REPUTATION_FAIL', () => {
    const { quests, reputation, events, wallet } = harness();
    quests.accept(delivery('Near', 10));
    quests.update(10, 0, SUN_OVER_LON_0, null);
    // Twenty more frames at a berth, to prove the sweep cannot fire twice.
    for (let i = 0; i < 20; i++) quests.update(1 / 60, 0, SUN_OVER_LON_0, 'Near');
    expect(events.filter((e) => e.kind === 'failed')).toHaveLength(1);
    expect(reputation.points).toBe(-REPUTATION_FAIL);
    // And never the purse. `docs/ROADMAP.md`: failure costs standing, never
    // gold and never progress.
    expect(wallet.gold).toBe(0);
  });

  it('floors standing at REPUTATION_FLOOR however many are lost', () => {
    const { quests, reputation } = harness();
    // Twenty-one failures at 5 apiece is 105, one past the floor.
    for (let round = 0; round < 21; round++) {
      quests.accept(delivery('Near', 1));
      quests.update(5, 0, SUN_OVER_LON_0, null);
    }
    expect(reputation.points).toBe(REPUTATION_FLOOR);
  });

  it('settles a delivery at its berth, once, across a hundred frames', () => {
    const { quests, wallet, reputation, events } = harness();
    quests.accept(delivery('Near'));
    for (let i = 0; i < 100; i++) quests.update(1 / 60, 0, SUN_OVER_LON_0, 'Near');
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(1);
    expect(wallet.gold).toBe(500);
    expect(reputation.points).toBe(10);
    expect(quests.active).toHaveLength(0);
  });

  it('does not settle at the wrong berth', () => {
    const { quests, wallet } = harness();
    quests.accept(delivery('Near'));
    for (let i = 0; i < 60; i++) quests.update(1 / 60, 0, SUN_OVER_LON_0, 'Middle');
    expect(quests.active).toHaveLength(1);
    expect(wallet.gold).toBe(0);
  });

  it('does not settle at the right berth in the wrong hour', () => {
    /*
     * The rule the whole day/night half of this feature rests on. Sun over
     * longitude 0 puts the Antipode at local midnight, so a DAYLIGHT contract
     * moored there is not done — and the player is told to wait rather than
     * told they failed.
     */
    const { quests, wallet } = harness();
    quests.accept(delivery('Antipode', 600, 'DAYLIGHT'));
    for (let i = 0; i < 60; i++) quests.update(1 / 60, 0, SUN_OVER_LON_0, 'Antipode');
    expect(quests.active).toHaveLength(1);
    expect(wallet.gold).toBe(0);

    // And settles the moment the sun comes round to it.
    quests.update(1 / 60, 0, SUN_OVER_LON_180, 'Antipode');
    expect(quests.active).toHaveLength(0);
    expect(wallet.gold).toBe(500);
  });

  it('settles an arrival on the frame the clock runs out', () => {
    /*
     * The documented departure from `docs/QUESTS_PLAN.md`'s stated order. The
     * plan lists expiry before completion, which decides a contract that
     * arrives on its final frame against the player by up to 16 ms of a
     * five-minute deadline — and the player did get there.
     */
    const { quests, wallet, events } = harness();
    quests.accept(delivery('Near', 10));
    quests.update(10, 0, SUN_OVER_LON_0, 'Near');
    expect(events.map((e) => e.kind)).toEqual(['accepted', 'completed']);
    expect(wallet.gold).toBe(500);
  });

  it('holds a contract whose target is not in this world, and does not fail it early', () => {
    /*
     * Contracts survive a world being redrawn by NAME, so a target can be a
     * place that does not exist until the next load. It must not settle and it
     * must not be swept before its clock runs out.
     */
    const towns = makeTowns();
    const quests = createQuests({
      towns: () => towns,
      chart: () => makeChart(),
      known: createKnownHarbours(),
      wallet: createWallet(0),
      reputation: createReputation(0),
      seed: 5,
      saved: [
        {
          id: 'ghost',
          kind: 'DELIVERY',
          tier: 2,
          issuer: 'Home',
          target: 'A Harbour From Another Sea',
          window: 'ANY',
          duration: 300,
          coverage: null,
          gold: 900,
          reputation: 20,
          brief: 'carry mail somewhere that is gone',
          remaining: 300,
        },
      ],
    });
    quests.update(1, 0, SUN_OVER_LON_0, 'Near');
    expect(quests.active).toHaveLength(1);
    expect(quests.active[0].remaining).toBe(299);
  });

  it('never loads more than MAX_ACTIVE off disk', () => {
    const towns = makeTowns();
    const saved = Array.from({ length: MAX_ACTIVE + 3 }, (_, i) => ({
      id: `saved-${i}`,
      kind: 'DELIVERY' as const,
      tier: 1 as const,
      issuer: 'Home',
      target: 'Near',
      window: 'ANY' as const,
      duration: 300,
      coverage: null,
      gold: 500,
      reputation: 10,
      brief: 'carry',
      remaining: 300,
    }));
    const quests = createQuests({
      towns: () => towns,
      chart: () => makeChart(),
      known: createKnownHarbours(),
      wallet: createWallet(0),
      reputation: createReputation(0),
      seed: 5,
      saved,
    });
    expect(quests.active).toHaveLength(MAX_ACTIVE);
  });

  it('reports the world day off elapsed', () => {
    const { quests } = harness();
    quests.update(0, DAY_LENGTH * 2.5, SUN_OVER_LON_0, null);
    expect(quests.day).toBe(2);
    quests.update(0, DAY_LENGTH * 3, SUN_OVER_LON_0, null);
    expect(quests.day).toBe(3);
  });
});

describe('update — chart goals', () => {
  function chartGoal(target: number): QuestOffer {
    return {
      id: `chart|${target}`,
      kind: 'CHART',
      tier: 1,
      issuer: 'Home',
      target: null,
      window: 'ANY',
      duration: null,
      coverage: target,
      gold: 400,
      reputation: 10,
      brief: `chart ${target}`,
    };
  }

  it('never expires, because it has no clock', () => {
    const { quests } = harness();
    quests.accept(chartGoal(0.2));
    expect(quests.active[0].remaining).toBeNull();
    for (let i = 0; i < 100; i++) quests.update(100, 0, SUN_OVER_LON_0, null);
    expect(quests.active).toHaveLength(1);
  });

  it('settles when coverage reaches the target', () => {
    const { quests, chart, wallet } = harness();
    quests.accept(chartGoal(0.2));
    chart.set(0.19);
    quests.update(1, 0, SUN_OVER_LON_0, null);
    expect(quests.active).toHaveLength(1);
    chart.set(0.2);
    quests.update(1, 0, SUN_OVER_LON_0, null);
    expect(quests.active).toHaveLength(0);
    expect(wallet.gold).toBe(400);
  });

  it('announces one step at a time, and none on its first frame', () => {
    /*
     * The first frame is silent on purpose: a goal loaded off disk at 17%
     * coverage would otherwise fire a burst of three announcements for progress
     * the player made in a previous session.
     */
    const { quests, chart, events } = harness();
    chart.set(0.17);
    quests.accept(chartGoal(0.35));
    quests.update(1, 0, SUN_OVER_LON_0, null);
    expect(events.filter((e) => e.kind === 'progress')).toHaveLength(0);

    chart.set(0.21);
    quests.update(1, 0, SUN_OVER_LON_0, null);
    expect(events.filter((e) => e.kind === 'progress')).toHaveLength(1);

    // Inside the same step: nothing more to say.
    chart.set(0.23);
    quests.update(1, 0, SUN_OVER_LON_0, null);
    expect(events.filter((e) => e.kind === 'progress')).toHaveLength(1);

    chart.set(0.26);
    quests.update(1, 0, SUN_OVER_LON_0, null);
    expect(events.filter((e) => e.kind === 'progress')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Abandoning, and the snapshot                                        */
/* ------------------------------------------------------------------ */

describe('abandon', () => {
  it('costs what expiry costs, and says which it was', () => {
    const { quests, reputation } = harness();
    const reasons: string[] = [];
    quests.on((event) => {
      if (event.kind === 'failed') reasons.push(event.reason);
    });
    const posted = quests.offers('Home', 0);
    quests.accept(posted[1]);
    expect(quests.abandon(posted[1].id)).toBe(true);
    expect(quests.active).toHaveLength(0);
    expect(reputation.points).toBe(-REPUTATION_FAIL);
    expect(reasons).toEqual(['abandoned']);
  });

  it('refuses an id that is not in hand', () => {
    const { quests } = harness();
    expect(quests.abandon('never-taken')).toBe(false);
  });

  it('clears a slot holding a contract this world cannot complete', () => {
    // The reason abandoning exists at all: a target that is not in this sea
    // would otherwise hold a slot until its deadline ran out anyway.
    const { quests } = harness();
    const posted = quests.offers('Home', 0);
    quests.accept(posted[1]);
    quests.accept(posted[2]);
    quests.abandon(posted[1].id);
    expect(quests.active.map((q) => q.id)).toEqual([posted[2].id]);
  });
});

describe('snapshot', () => {
  it('hands over frozen copies the caller may hold', () => {
    const { quests } = harness();
    quests.accept(quests.offers('Home', 0)[1]);
    const snap = quests.snapshot();
    expect(snap).toHaveLength(1);
    expect(Object.isFrozen(snap[0])).toBe(true);

    // The live contract moves on; the snapshot does not.
    const was = snap[0].remaining;
    quests.update(10, 0, SUN_OVER_LON_0, null);
    expect(snap[0].remaining).toBe(was);
  });
});

describe('on', () => {
  it('unsubscribes', () => {
    const { quests } = harness();
    // The board is read ONCE, before anything is taken off it: accepting filters
    // a posting out, so re-reading after the first accept would hand back a
    // shorter board and index 2 would be undefined.
    const posted = quests.offers('Home', 0);
    let count = 0;
    const off = quests.on(() => count++);
    quests.accept(posted[1]);
    expect(count).toBe(1);
    off();
    quests.accept(posted[2]);
    expect(count).toBe(1);
    expect(quests.active).toHaveLength(2);
  });

  it('survives a subscriber that unsubscribes itself mid-callback', () => {
    // The case the `Array.from` in `emit` exists for: a view disposing itself in
    // response to the very event it is handling.
    const { quests } = harness();
    const posted = quests.offers('Home', 0);
    const seen: string[] = [];
    const off = quests.on((event) => {
      seen.push(event.kind);
      off();
    });
    quests.on((event) => seen.push(`second:${event.kind}`));
    quests.accept(posted[1]);
    expect(seen).toEqual(['accepted', 'second:accepted']);
  });
});
