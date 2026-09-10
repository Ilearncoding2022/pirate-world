import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  createHazards,
  CREST_LIFE_MAX,
  CREST_LIFE_MIN,
  CREST_WIDTH_MAX,
  CREST_WIDTH_MIN,
  DISSIPATE,
  PUSH_PEAK,
  SPIRAL_SECONDS,
} from '../../src/hazards';
import {
  CREST_BOW_MAX,
  CREST_HALF_LENGTH_CAP,
  CREST_HALF_LENGTH_MAX,
  CREST_HALF_LENGTH_MIN,
  CREST_HEIGHT_MAX,
  CREST_HEIGHT_MAX_START,
  CREST_HEIGHT_MIN,
  MAELSTROM_RADIUS,
  MAX_HAZARDS,
} from '../../src/hazardfield';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from '../../src/terrain';
import { createHeightMap } from '../../src/heightmap';
import { createWaterBodies } from '../../src/waterbodies';
import { createTowns } from '../../src/towns';
import { LULL_SPEED, OCEAN_CAP } from '../../src/wind';
import { GLOBE_RADIUS, latLonToDir, headingToForward } from '../../src/geo';
import type { EnergyState, Hazard, HazardKind, ShipState, Towns, WindState } from '../../src/types';
import type { WaterBodies } from '../../src/waterbodies';
import { createStubTerrain } from './support/stub-terrain';

/**
 * `hazards.ts`'s rule set, against the real world it will run in: the roll's
 * one-of-each promise, the shape of the push, the spiral's invariants, the
 * berth's immunity, and the respawn's guarantees. The height map is small on
 * purpose — every reader here only needs the shape of the coastline, and the
 * whole tier has two seconds to spend.
 *
 * Nothing here asserts on how any of it looks; that is rule 1 in
 * docs/TESTING.md and it is what keeps this file cheap.
 */

/** Built once and shared: `createTowns` walks 20 000 candidates. */
const terrain = createTerrain(DEFAULT_SEED);
const heightMap = createHeightMap(terrain, 256, 128);
const spawnDir = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
const waterBodies = createWaterBodies(heightMap, terrain.seaLevel, spawnDir);
const towns = createTowns(heightMap, waterBodies, terrain.seaLevel);

function energyState(mode: EnergyState['mode']): EnergyState {
  return { level: 1, reserve: 0, rate: 0, mode, dock: null, canThrust: true };
}

/** A hull stopped in the open ocean at the world's spawn point, heading east. */
function stationaryShip(): ShipState {
  const position = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
  const up = position.clone();
  const forward = headingToForward(up, Math.PI / 2);
  return {
    position,
    up,
    forward,
    heading: Math.PI / 2,
    headingDeg: 90,
    speed: 0,
    groundSpeed: 0,
    velocity: new Vector3(),
    latDeg: SPAWN_LAT_DEG,
    lonDeg: SPAWN_LON_DEG,
  };
}

/**
 * A steady wind at the spawn point, blowing due east.
 *
 * Fixed rather than random because crests now take their heading from it: a
 * wind that wandered between runs would move every wave the roll produces,
 * and the one-of-each promise below would stop being the thing under test.
 * `speed` sits at the floor `wind.ts` guarantees — see LULL_SPEED — which is
 * also the case that used to be a dead calm.
 */
function windState(): WindState {
  const position = latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG);
  return {
    speed: LULL_SPEED,
    bearing: Math.PI / 2,
    direction: headingToForward(position, Math.PI / 2),
    cap: OCEAN_CAP,
    along: 0,
    across: 0,
  };
}

/**
 * Shared, because `hazards.ts` only ever READS a wind — it copies the
 * direction out and never writes it back — so one object cannot leak state
 * between these tests the way a shared ship or energy state would.
 */
const wind = windState();

/** The same great-circle step the module walks, for placing a forced hazard. */
function step(from: Vector3, dir: Vector3, worldUnits: number): Vector3 {
  const axis = new Vector3().crossVectors(from, dir).normalize();
  return from.clone().applyAxisAngle(axis, worldUnits / GLOBE_RADIUS).normalize();
}

function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

/**
 * `hazards.ts`'s length-growth curve, duplicated here on purpose.
 *
 * The module exports the two constants but not the law they combine into, and
 * a test that imported the law would only be asserting that a function equals
 * itself. Written out, a change to the growth rule has to be made twice --
 * which is the point: the second time is where somebody asks whether the coast
 * clip still holds under it.
 */
function growth(age: number): number {
  return Math.min(Math.pow(1.1, age), 3);
}

function makeHazards(onSunk: () => void = () => {}) {
  return createHazards({ terrain, heightMap, waterBodies, towns, onSunk });
}

describe('hazards — the roll', () => {
  it('raises both kinds over an hour of rolls, and keeps each inside its live budget', () => {
    const hazards = makeHazards();
    const ship = stationaryShip();
    const energy = energyState('burn');
    const dt = 0.1;
    const seen = new Set<HazardKind>();
    let sawTwoWaves = false;

    for (let i = 0; i < 3000 / dt; i++) {
      hazards.update(dt, ship, energy, wind);
      const live = hazards.state.live;
      expect(live.length).toBeLessThanOrEqual(MAX_HAZARDS);
      let wave = 0;
      let maelstrom = 0;
      for (const h of live) {
        seen.add(h.kind);
        if (h.kind === 'wave') wave++;
        else maelstrom++;
        // The one number every consumer reads. Out of [0, 1] it would either
        // flatten the sea or blow the displacement past the patch's skirt.
        expect(h.envelope).toBeGreaterThanOrEqual(0);
        expect(h.envelope).toBeLessThanOrEqual(1);
        expect(h.centre.length()).toBeCloseTo(1, 6);
      }
      // Two crests and one funnel, which is the budget in `hazards.ts` --
      // and it has to be the MAX_HAZARDS the shader's uniform arrays hold.
      expect(wave).toBeLessThanOrEqual(MAX_HAZARDS - 1);
      expect(maelstrom).toBeLessThanOrEqual(1);
      if (wave === MAX_HAZARDS - 1) sawTwoWaves = true;
    }

    expect([...seen].sort()).toEqual(['maelstrom', 'wave']);
    // The second wave slot is not decoration: collapsing the two crest kinds
    // into one was only allowed to happen because the freed slot went back
    // into the same pool, so a sea that never fills it is the regression.
    expect(sawTwoWaves).toBe(true);
  });
});

describe('hazards — a crest rolls its own width and its own life', () => {
  /**
   * Watches a long stretch of weather and records every crest it sees, once
   * each: the width it rose with, and the age it was still alive at on the
   * last frame it existed.
   *
   * The life has to be measured rather than read, because `Hazard` does not
   * expose it -- and measuring is the better test anyway, since what matters
   * is when the sea actually takes the wave away.
   */
  interface Survey {
    widths: number[];
    lives: number[];
    /** Half-length, height and bow as each wave ROSE, before any growth. */
    halfLengths: number[];
    heights: number[];
    bows: number[];
    /** Speed, which never changes over a wave's life. */
    speeds: number[];
    /** The largest half-length and height each wave reached before it went. */
    peakHalfLengths: number[];
    peakHeights: number[];
  }

  function survey(seconds: number): Survey {
    const hazards = makeHazards();
    const ship = stationaryShip();
    const energy = energyState('burn');
    const dt = 0.1;
    const widths: number[] = [];
    const lives: number[] = [];
    const halfLengths: number[] = [];
    const heights: number[] = [];
    const bows: number[] = [];
    const speeds: number[] = [];
    const peakHalfLengths: number[] = [];
    const peakHeights: number[] = [];
    const lastAge = new Map<Hazard, number>();
    const peakLength = new Map<Hazard, number>();
    const peakHeight = new Map<Hazard, number>();

    for (let i = 0; i < seconds / dt; i++) {
      const before = new Set(hazards.state.live);
      hazards.update(dt, ship, energy, wind);
      for (const h of hazards.state.live) {
        if (h.kind === 'maelstrom') continue;
        if (!lastAge.has(h)) {
          widths.push(h.halfWidth * 2);
          bows.push(h.bow);
          speeds.push(h.speed);
          // The first frame a wave is seen it is one tick old, so what is
          // recorded here is the rolled value plus a tenth of a second of
          // growth -- which the assertions below allow for rather than
          // pretending the sim can be sampled at age exactly zero.
          halfLengths.push(h.extent);
          heights.push(h.amplitude);
        }
        peakLength.set(h, Math.max(peakLength.get(h) ?? 0, h.extent));
        peakHeight.set(h, Math.max(peakHeight.get(h) ?? 0, h.amplitude));
        lastAge.set(h, h.age);
      }
      // A crest that was on the water and is not any more has lived out
      // whatever life it rolled -- unless the hull consumed it, which a
      // stationary ship at the spawn point mostly avoids and which only ever
      // shortens a life, so it cannot push one over the ceiling below.
      for (const h of before) {
        if (h.kind === 'maelstrom' || hazards.state.live.includes(h)) continue;
        const age = lastAge.get(h);
        if (age !== undefined) lives.push(age);
        const pl = peakLength.get(h);
        if (pl !== undefined) peakHalfLengths.push(pl);
        const ph = peakHeight.get(h);
        if (ph !== undefined) peakHeights.push(ph);
      }
    }
    return { widths, lives, halfLengths, heights, bows, speeds, peakHalfLengths, peakHeights };
  }

  it('rolls every width inside 1 to 12 units, and spreads across the range', () => {
    const { widths } = survey(1200);
    expect(widths.length).toBeGreaterThan(30);
    for (const w of widths) {
      expect(w).toBeGreaterThanOrEqual(CREST_WIDTH_MIN);
      expect(w).toBeLessThanOrEqual(CREST_WIDTH_MAX);
    }
    // Not a constant with jitter on it: the sea has to be able to raise a
    // wave near either end of the range, or the spread buys nothing.
    const span = CREST_WIDTH_MAX - CREST_WIDTH_MIN;
    expect(Math.min(...widths)).toBeLessThan(CREST_WIDTH_MIN + span * 0.2);
    expect(Math.max(...widths)).toBeGreaterThan(CREST_WIDTH_MAX - span * 0.2);
  });

  it('keeps every crest inside the rolled life band, and spreads across it', () => {
    const { lives } = survey(1200);
    expect(lives.length).toBeGreaterThan(20);
    for (const life of lives) {
      // One frame of slack at the top: the wave is removed on the first
      // update that finds it past its own life, so the age it was last seen
      // at can be up to a tick over what it rolled.
      expect(life).toBeLessThan(CREST_LIFE_MAX + 0.1);
    }
    // Every wave has to be able to cross the spawn band: see CREST_LIFE_MIN.
    const untouched = lives.filter((life) => life > CREST_LIFE_MIN - 0.5);
    expect(untouched.length).toBeGreaterThan(lives.length * 0.5);
    // And they differ from one another, which is the whole change.
    expect(Math.max(...lives) - Math.min(...lives)).toBeGreaterThan(1);
  });

  it('rolls every speed inside 2 to 12 knots, and spreads across the range', () => {
    const { speeds } = survey(1200);
    expect(speeds.length).toBeGreaterThan(30);
    for (const v of speeds) {
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(12);
    }
    // Both ends reached, or the sea is one speed with jitter on it -- which
    // is the thing the roll replaced.
    expect(Math.min(...speeds)).toBeLessThan(4);
    expect(Math.max(...speeds)).toBeGreaterThan(10);
  });

  it('rolls its own length and height at spawn, and grows both inside their caps', () => {
    const { halfLengths, heights, peakHalfLengths, peakHeights } = survey(1200);
    expect(halfLengths.length).toBeGreaterThan(30);

    // The rolled band, with one tick of growth allowed for: the earliest a
    // wave can be sampled is the frame after it rose. 10%/s over 0.1 s is a
    // factor of 1.01, so 2% of slack is comfortably more than enough.
    for (const l of halfLengths) {
      expect(l).toBeGreaterThanOrEqual(CREST_HALF_LENGTH_MIN);
      expect(l).toBeLessThanOrEqual(CREST_HALF_LENGTH_MAX * 1.02);
    }
    for (const a of heights) {
      expect(a).toBeGreaterThanOrEqual(CREST_HEIGHT_MIN);
      expect(a).toBeLessThanOrEqual(CREST_HEIGHT_MAX_START * 1.02);
    }
    const lengthSpan = CREST_HALF_LENGTH_MAX - CREST_HALF_LENGTH_MIN;
    expect(Math.min(...halfLengths)).toBeLessThan(CREST_HALF_LENGTH_MIN + lengthSpan * 0.2);
    expect(Math.max(...halfLengths)).toBeGreaterThan(CREST_HALF_LENGTH_MAX - lengthSpan * 0.2);

    // Growth: the caps hold, and something actually grew. Waves are dropped
    // the frame they run out of open water, so `peak` is over what each one
    // reached, not over what an uninterrupted one would have.
    for (const l of peakHalfLengths) expect(l).toBeLessThanOrEqual(CREST_HALF_LENGTH_CAP + 1e-9);
    for (const a of peakHeights) expect(a).toBeLessThanOrEqual(CREST_HEIGHT_MAX + 1e-9);
    let grew = 0;
    for (let i = 0; i < peakHeights.length; i++) {
      if (peakHalfLengths[i] > halfLengths[i] * 1.1 && peakHeights[i] > heights[i] * 1.05) grew++;
    }
    expect(grew).toBeGreaterThan(peakHeights.length * 0.5);
  });

  it('bows a long crest and leaves a short one nearly straight', () => {
    const { halfLengths, bows } = survey(1200);
    expect(bows.length).toBeGreaterThan(30);
    for (const b of bows) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(CREST_BOW_MAX);
    }
    // The tendency, measured as a tendency: the longest third of the waves
    // bow appreciably more on average than the shortest third. Not asserted
    // wave by wave, because the roll is deliberately allowed to hand a long
    // wave a nearly straight front and the other way about.
    const paired = halfLengths.map((l, i) => ({ l, b: bows[i] })).sort((x, y) => x.l - y.l);
    const third = Math.floor(paired.length / 3);
    const mean = (xs: { b: number }[]) => xs.reduce((t, x) => t + x.b, 0) / xs.length;
    const shortest = mean(paired.slice(0, third));
    const longest = mean(paired.slice(-third));
    expect(longest).toBeGreaterThan(shortest * 2);
    expect(shortest).toBeLessThan(CREST_BOW_MAX * 0.25);
  });

  it('raises the spawn rate under a full storm, by well under the tripled odds', () => {
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.1;

    // Count SPAWNS, not live hazards: the population is capped by CAPACITY,
    // so a live count would saturate long before the odds showed.
    function spawnsAt(stormOdds: number): number {
      const hazards = makeHazards();
      let spawns = 0;
      let before = new Set(hazards.state.live);
      for (let i = 0; i < 3000 / dt; i++) {
        hazards.update(dt, ship, energy, wind, stormOdds);
        for (const h of hazards.state.live) if (!before.has(h)) spawns++;
        before = new Set(hazards.state.live);
      }
      return spawns;
    }

    const calm = spawnsAt(1);
    const storm = spawnsAt(3);
    expect(calm).toBeGreaterThan(0);
    /*
     * Tripled ODDS, but only about 1.24x the spawns, and the gap is worth
     * recording rather than tuning away.
     *
     * `hazards.ts` rolls once a SECOND, five times for a wave at P_WAVE each
     * time, and holds at most CAPACITY of each kind. A free slot therefore
     * refills within a few seconds even in fair weather, so what limits the
     * population is how long a hazard LIVES, not how often one is rolled for.
     * Tripling a probability that is already saturating buys the difference
     * between "almost immediately" and "immediately".
     *
     * Measured over 50 minutes of sim: 1732 spawns at 1x against 2239 at 3x,
     * a ratio of 1.293, with the sea holding 3.45 crests of a possible five
     * in fair weather against 4.49 under the storm. **It was 1.46 when this
     * case was written**, against a sea that held one crest, and 1.24 when it
     * held two: a fuller sea saturates harder, so the same multiplier buys
     * less of it. That is the capacity rule and the storm multiplier doing
     * two different jobs -- the odds decide how fast a free slot refills and
     * the capacity decides how many there are -- and both were kept
     * deliberately when the weather branch was merged.
     *
     * This band is what caught the five-crest sea being pinned. At the odds
     * the capacity was first raised under, fair weather sat at 4.49 crests
     * and 61% full and the ratio fell to 1.04 -- the storm had nothing left
     * to fill. The odds came down until this assertion passed again, which
     * is the assertion doing exactly the job it was written for.
     *
     * The raiders, whose roll is once per TEN seconds and nowhere near
     * saturation, get 2.72x from the same multiplier -- and only on the
     * orange sort now; see `aiboats.test.ts`. All of these are checked
     * because they are what the storm multiplier actually buys, and a reader
     * who believed "tripled" of any of them would be wrong.
     */
    const ratio = storm / calm;
    expect(ratio).toBeGreaterThan(1.12);
    expect(ratio).toBeLessThan(1.45);
  });

  it('defaults stormOdds to 1, so a caller that knows no weather is unchanged', () => {
    const ship = stationaryShip();
    const energy = energyState('drain');
    const dt = 0.1;

    function trace(pass: (h: ReturnType<typeof makeHazards>) => void): string[] {
      const hazards = makeHazards();
      const out: string[] = [];
      for (let i = 0; i < 600 / dt; i++) {
        pass(hazards);
        if (i % 50 === 0) out.push(hazards.state.live.map((h) => h.kind).join('|'));
      }
      return out;
    }

    expect(trace((h) => h.update(dt, ship, energy, wind))).toEqual(
      trace((h) => h.update(dt, ship, energy, wind, 1)),
    );
  });
});

describe('hazards — the push', () => {
  it('shoves the hull the way the crest went, peaking at PUSH_PEAK and gone by DISSIPATE', () => {
    const hazards = makeHazards();
    const ship = stationaryShip();
    const energy = energyState('burn');
    const dt = 0.05;

    // Dead astern of the bow: a crest travelling the way the ship points is
    // pure `along`, which is the pair's whole convention.
    hazards.force('wave', ship.position, ship.forward);
    const forced = hazards.state.live.find((h) => h.kind === 'wave');
    expect(forced).toBeDefined();
    if (forced === undefined) return;
    // The peak is PUSH_PEAK scaled by the speed this wave happened to roll:
    // that proportionality IS the rule, so the expectation is derived from
    // the same speed rather than from a constant that no longer says it.
    const expected = (PUSH_PEAK * forced.speed) / 6;
    let peakAlong = 0;
    let peakAcross = 0;
    for (let t = 0; t < DISSIPATE - dt; t += dt) {
      hazards.update(dt, ship, energy, wind);
      peakAlong = Math.max(peakAlong, hazards.state.along);
      peakAcross = Math.max(peakAcross, Math.abs(hazards.state.across));
    }
    expect(peakAlong).toBeGreaterThan(expected * 0.9);
    expect(peakAlong).toBeLessThan(expected * 1.1);
    expect(peakAcross).toBeLessThan(expected * 0.02);

    // One dissipation later the hump is over and the crest is gone with it.
    // The forced wave specifically, not the whole list: the rolls raise
    // weather of their own, and a stationary ship at the spawn point is not
    // reached by all of it.
    for (let t = 0; t < 1; t += dt) hazards.update(dt, ship, energy, wind);
    expect(hazards.state.live).not.toContain(forced);
    // And with nothing left on the water still dissipating, the pair is
    // EXACTLY zero rather than a residue easing out. Guarded, because the sea
    // now runs two crest slots and four seconds of rolls can put a second
    // wave over a stationary hull -- in which case what `along` carries is
    // that wave's hump and not this one's leftovers.
    if (!hazards.state.live.some((h) => h.kind !== 'maelstrom' && h.consumed)) {
      expect(hazards.state.along).toBe(0);
      expect(hazards.state.across).toBe(0);
    }

    // And a crest crossing the bow is pure `across`, on the starboard sign.
    hazards.reset();
    const starboard = new Vector3().crossVectors(ship.forward, ship.up).normalize();
    hazards.force('wave', ship.position, starboard);
    const abeam = hazards.state.live.find((h) => h.kind === 'wave');
    expect(abeam).toBeDefined();
    if (abeam === undefined) return;
    const expectedAbeam = (PUSH_PEAK * abeam.speed) / 6;
    peakAlong = 0;
    peakAcross = 0;
    for (let t = 0; t < DISSIPATE - dt; t += dt) {
      hazards.update(dt, ship, energy, wind);
      peakAcross = Math.max(peakAcross, hazards.state.across);
      peakAlong = Math.max(peakAlong, Math.abs(hazards.state.along));
    }
    expect(peakAcross).toBeGreaterThan(expectedAbeam * 0.9);
    expect(peakAcross).toBeLessThan(expectedAbeam * 1.1);
    expect(peakAlong).toBeLessThan(expectedAbeam * 0.02);
  });
});

describe('hazards — capture', () => {
  it('spirals the hull to the centre and sinks it once, at SPIRAL_SECONDS', () => {
    let sunk = 0;
    const hazards = makeHazards(() => sunk++);
    const ship = stationaryShip();
    const energy = energyState('burn');
    const dt = 0.05;

    // Five units off the bow: outside the funnel while it is small, inside it
    // well before the growth envelope is done.
    const centre = step(ship.position, ship.forward, 5);
    hazards.force('maelstrom', centre, ship.forward);

    let captureAt = -1;
    let sunkAt = -1;
    for (let i = 0; i < 20 / dt; i++) {
      hazards.update(dt, ship, energy, wind);
      const t = (i + 1) * dt;
      if (captureAt < 0 && hazards.state.phase !== 'free') captureAt = t;
      if (sunkAt < 0 && hazards.state.phase === 'sunk') sunkAt = t;

      const drive = hazards.state.drive;
      expect(drive === null).toBe(hazards.state.phase === 'free');
      if (drive !== null) {
        // `ship.ts` copies this straight into its own position without
        // checking it, so a drifting length would silently lift or sink the
        // whole hull off the sphere.
        expect(drive.position.length()).toBeCloseTo(1, 6);
        expect(drive.forward.length()).toBeCloseTo(1, 6);
        expect(arcDistance(drive.position, centre)).toBeLessThanOrEqual(MAELSTROM_RADIUS + 1e-6);
        expect(drive.sink).toBeGreaterThanOrEqual(0);
      }
    }

    expect(captureAt).toBeGreaterThan(0);
    // The capture frame places the drive and starts the clock at zero, so the
    // spiral runs SPIRAL_SECONDS from the frame after it: one frame of slack,
    // and no more.
    expect(sunkAt - captureAt).toBeGreaterThanOrEqual(SPIRAL_SECONDS);
    expect(sunkAt - captureAt).toBeLessThanOrEqual(SPIRAL_SECONDS + 2 * dt);
    expect(sunk).toBe(1);
    // The funnel holds the wreck past its own life, and the state stays sunk
    // until `main.ts` has finished the blackout and reset it.
    expect(hazards.state.phase).toBe('sunk');
    expect(hazards.state.drive?.position.distanceTo(centre)).toBeLessThan(1e-6);

    hazards.reset();
    expect(hazards.state.phase).toBe('free');
    expect(hazards.state.drive).toBe(null);
    expect(hazards.state.live.length).toBe(0);
  });
});

describe('hazards — a berth is shelter', () => {
  it('neither pushes nor captures a docked hull', () => {
    const ship = stationaryShip();
    const docked = energyState('docked');
    const dt = 0.05;

    let sunk = 0;
    const hazards = makeHazards(() => sunk++);
    hazards.force('wave', ship.position, ship.forward);
    hazards.force('maelstrom', ship.position, ship.forward);

    for (let i = 0; i < 12 / dt; i++) {
      hazards.update(dt, ship, docked, wind);
      expect(hazards.state.along).toBe(0);
      expect(hazards.state.across).toBe(0);
      expect(hazards.state.phase).toBe('free');
      expect(hazards.state.drive).toBe(null);
    }
    expect(sunk).toBe(0);
  });
});

describe('hazards — pickRespawn', () => {
  it('lands on reachable ocean, clear of land and of every berth', () => {
    const hazards = makeHazards();
    const berths = towns.all.map((t) => t.dock).filter((d) => d !== null);
    expect(berths.length).toBeGreaterThan(0);
    const widest = Math.max(...berths.map((d) => d.radius));

    for (let i = 0; i < 20; i++) {
      const p = hazards.pickRespawn();
      expect(p.length()).toBeCloseTo(1, 6);
      expect(heightMap.sample(p)).toBeLessThan(terrain.seaLevel);
      expect(waterBodies.sample(p)).toBeLessThan(0.5);
      for (const dock of berths) {
        expect(arcDistance(p, dock.dir)).toBeGreaterThanOrEqual(2 * widest);
      }
    }
  });
});

/**
 * The coast clip, against a world made for it: one straight north-south
 * shoreline, so what a crest should keep is arithmetic rather than a reading
 * off the real generator's coastline.
 *
 * Land east of `COAST_LON_DEG`, ocean everywhere west of it. The height map
 * is finer than the shared 256x128 one above because these tests measure
 * WHERE the wave was cut, and a coarse map's bilinear ramp is several world
 * units wide.
 */
const COAST_LON_DEG = 1;
/** World units per degree of longitude at the equator, this globe. */
const DEG = (GLOBE_RADIUS * Math.PI) / 180;

const coastTerrain = createStubTerrain((dir) => {
  const lonDeg = (Math.atan2(dir.x, dir.z) * 180) / Math.PI;
  return lonDeg > COAST_LON_DEG && lonDeg < 90 ? 1 : -1;
});
const coastMap = createHeightMap(coastTerrain, 1024, 512);
const openSea = { sample: () => 0 } as unknown as WaterBodies;
const noTowns: Towns = { all: [], docks: [], dockAt: () => null };

function coastHazards() {
  return createHazards({
    terrain: coastTerrain,
    heightMap: coastMap,
    waterBodies: openSea,
    towns: noTowns,
    onSunk: () => {},
  });
}

/** The hull at the equator on the prime meridian, well clear of the shore. */
function coastShip(): ShipState {
  const position = latLonToDir(0, 0);
  const up = position.clone();
  const forward = headingToForward(up, 0);
  return {
    position,
    up,
    forward,
    heading: 0,
    headingDeg: 0,
    speed: 0,
    groundSpeed: 0,
    velocity: new Vector3(),
    latDeg: 0,
    lonDeg: 0,
  };
}

/** A crest's end, `extent` world units along `east` from its centre. */
function crestEnd(h: Hazard, sign: number): Vector3 {
  return step(h.centre, h.east.clone().multiplyScalar(sign), h.extent);
}

describe('hazards — a crest breaks on the shore', () => {
  it('keeps the stretch still over water and loses the part that met land', () => {
    const hazards = coastHazards();
    const ship = coastShip();
    const energy = energyState('burn');
    const dt = 0.05;

    // Fifteen units due north of the hull, running north: far enough that the
    // contact test never fires, so nothing here is the push rule in disguise.
    // `north` due north makes `east` due east, so the 20-unit front lies along
    // the equator and runs COAST_HALF_LENGTH past the shoreline at 1 degree.
    const north = headingToForward(latLonToDir(0, 0), 0);
    const centre = step(latLonToDir(0, 0), north, 15);
    hazards.force('wave', centre, north);
    const crest = hazards.state.live.find((h) => h.kind === 'wave');
    expect(crest).toBeDefined();
    if (crest === undefined) return;
    const full = crest.extent;

    hazards.update(dt, ship, energy, wind);

    // Still on the water: the wave lost an end, not itself.
    expect(hazards.state.live).toContain(crest);

    /*
     * The broken end RETREATS to the waterline rather than jumping to it, so
     * this is asserted as a convergence rather than as one frame's arithmetic.
     *
     * The wave is not there yet after one frame and must not be -- that is
     * the whole change -- but it is already shorter, and it is heading the
     * right way at a bounded speed. CREST_RETRACT_RATE is 15 world units a
     * second per end, so one 0.05 s frame can take at most 0.75 units off
     * either end and the extent can fall by at most that.
     */
    expect(crest.extent).toBeLessThan(full);
    expect(full - crest.extent).toBeLessThanOrEqual(0.75 + 1e-6);

    // The shore is COAST_LON_DEG east of the centre, so about that much of
    // the eastern arm is gone and the whole western arm is untouched. Given
    // long enough for the retreat to finish, that is where it settles.
    const survived = (full + COAST_LON_DEG * DEG) / 2;
    for (let i = 0; i < 40 && crest.extent > survived + 0.5; i++) {
      hazards.update(dt, ship, energy, wind);
    }
    expect(crest.extent).toBeCloseTo(survived, 0);
    expect(crest.extent).toBeLessThan(full - 1);
    expect(crest.extent).toBeGreaterThan(1);

    // And the end that was eaten is sagging while it is being eaten, which is
    // the other half of what the coast now does to a wave. The east end is
    // the one that met land: `east` is due east and the shore is east of the
    // centre, so it is `breakPos` that has to have come up.
    expect(crest.breakPos).toBeGreaterThan(0);
    expect(crest.breakNeg).toBe(0);

    // Both ends of what is left are over open water, and the frame is still a
    // frame: `centre` slid west onto the middle of the surviving stretch
    // rather than staying put with an offset nothing downstream can read.
    for (const sign of [1, -1]) {
      expect(coastMap.sample(crestEnd(crest, sign))).toBeLessThan(coastTerrain.seaLevel);
    }
    expect(crest.centre.length()).toBeCloseTo(1, 6);
    expect(crest.east.dot(crest.centre)).toBeCloseTo(0, 6);
    expect(crest.north.dot(crest.centre)).toBeCloseTo(0, 6);
    expect(crest.east.dot(crest.north)).toBeCloseTo(0, 6);

    /*
     * And what the coast has taken only ever grows: the wave runs north up a
     * shore that never moves, so the clip has to hold rather than breathe
     * frame to frame.
     *
     * `extent` itself is no longer the thing to watch, because a crest grows
     * 10% of its length a second and can therefore be longer this frame than
     * last while still having lost more of itself to the rock. What has to be
     * monotonic is the SHARE of its ideal length the wave still has -- which
     * is `hazards.ts`'s `clipRatio`, reconstructed here from the two numbers
     * a consumer can actually see, so the test measures the guarantee rather
     * than the bookkeeping.
     */
    const base = crest.extent / growth(crest.age);
    let lastShare = 1;
    for (let i = 0; i < 40; i++) {
      hazards.update(dt, ship, energy, wind);
      if (!hazards.state.live.includes(crest)) break;
      const share = crest.extent / (base * growth(crest.age));
      expect(share).toBeLessThanOrEqual(lastShare + 1e-9);
      expect(crest.extent).toBeGreaterThan(0);
      lastShare = share;
    }
  });

  it('retracts a crest with no open water left under it out of existence', () => {
    const hazards = coastHazards();
    const ship = coastShip();
    const energy = energyState('burn');
    const dt = 0.05;

    // Well inland: every probe along the front is dry.
    const inland = latLonToDir(0, 45);
    hazards.force('wave', inland, headingToForward(inland, 0));
    const crest = hazards.state.live.find((h) => h.kind === 'wave');
    expect(crest).toBeDefined();
    if (crest === undefined) return;
    const full = crest.extent;

    /*
     * It used to go on the first frame. It now retracts out of existence
     * instead, by the same rule that eats any other broken end, because a
     * front that vanishes between two frames is the thing this branch was
     * asked to stop doing -- and a wave entirely aground is the most visible
     * case of it, not an exception to it.
     *
     * What still has to be true is that it goes, and goes promptly. Both ends
     * run at CREST_RETRACT_RATE toward the centre, so a full-length front is
     * gone inside `full / 15` seconds plus a frame; a second is generous at
     * every length this can roll and is well under the shortest life.
     */
    hazards.update(dt, ship, energy, wind);
    expect(hazards.state.live).toContain(crest);
    expect(crest.extent).toBeLessThan(full);

    let elapsed = dt;
    for (let i = 0; i < 200 && hazards.state.live.includes(crest); i++) {
      hazards.update(dt, ship, energy, wind);
      elapsed += dt;
    }
    expect(hazards.state.live).not.toContain(crest);
    expect(elapsed).toBeLessThan(1);
  });
});
