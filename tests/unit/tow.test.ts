import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createShip, MAX_FORWARD } from '../../src/ship';
import { createEnergy, TOW_BURN_MULTIPLIER } from '../../src/energy';
import { createBattery } from '../../src/battery';
import { TOW_SPEED_SHARE } from '../../src/derelict';
import { TOW_GOLD_MAX, TOW_GOLD_MIN, TOW_REPUTATION, towGold } from '../../src/salvagebounty';
import { TRIM_MAX_FORWARD } from '../../src/trim';
import { createStubTerrain } from './support/stub-terrain';
import { latLonToDir } from '../../src/geo';
import type { EnergyState, InputState, PropulsionState, Towns, WindState } from '../../src/types';
import type { WorldEnv } from '../../src/env';

/**
 * What a tow COSTS, which is the half of this feature that lives in two files
 * neither of which is `derelict.ts`: `ship.ts` takes a quarter off the top speed
 * and `energy.ts` doubles the burn.
 *
 * The one rule worth stating before the cases: **the cut is applied after
 * `min(maxForward, speedCap)`, not inside it.** A tow is a load and not a
 * purchase, so docs/HARBOURS_PLAN.md's decision 14 — a worn hull overrides the
 * Navigation shelf — must not swallow it. Folded into the min, a hull worn below
 * 25% (capped at 5 kn) would tow at 5 and feel no penalty in the exact state it
 * should hurt most, and that is what the third case here pins.
 */

const NO_TOWNS = { all: [], docks: [], dockAt: () => null, byName: () => null } as unknown as Towns;

const CALM: WindState = {
  speed: 0,
  bearing: 0,
  direction: new Vector3(0, 0, 1),
  cap: 16,
  along: 0,
  across: 0,
  phase: 'lull',
  phaseTime: 0,
  phaseDuration: 10,
  phaseIndex: 0,
  envelope: 0,
} as WindState;

function input(overrides: Partial<InputState> = {}): InputState {
  return { forward: false, backward: false, left: false, right: false, zoomDelta: 0, ...overrides };
}

function energyState(overrides: Partial<EnergyState> = {}): EnergyState {
  return {
    level: 1,
    reserve: 0,
    rate: 0,
    mode: 'burn',
    dock: null,
    berthReady: false,
    canThrust: true,
    ...overrides,
  } as EnergyState;
}

/** A world with no land and no harbours: this file is about numbers, not places. */
function openSea() {
  return createStubTerrain();
}

/**
 * Run the hull flat out for `seconds` and return the speed it settles at.
 *
 * Long enough to reach terminal speed: `ship.ts` integrates `ds/dt = thrust -
 * drag * s` in closed form with a 2.9 s time constant, so twenty seconds is
 * five of them and the last digit has stopped moving.
 */
function terminalSpeed(propulsion: PropulsionState, speedCap = 100): number {
  // The hull is a CONSTRUCTION dependency of the ship rather than a per-frame
  // argument (`createShip`'s fifth parameter), so the cap is fixed here and the
  // propulsion is what varies per case.
  const hull = {
    state: { percent: 100, speedCap, mode: 'sound' },
    update: () => {},
    damage: () => {},
    repair: () => {},
    onChange: () => {},
    override: () => {},
  } as unknown as Parameters<typeof createShip>[4];
  const ship = createShip(openSea(), undefined, 1, undefined, hull);
  for (let i = 0; i < 20 / 0.05; i++) {
    ship.update(0.05, input({ forward: true }), energyState(), CALM, undefined, undefined, propulsion);
  }
  return ship.state.speed;
}

describe('tow: what it takes off the top speed', () => {
  it('is a quarter, not a half, and not a purchase', () => {
    expect(TOW_SPEED_SHARE).toBe(0.75);
    // The rejected alternative, kept as a number so a retune to 0.5 has to come
    // past this line and the arithmetic in docs/SALVAGE_PLAN.md with it.
    expect(TOW_SPEED_SHARE).not.toBe(0.5);
  });

  it('cuts an unmodified hull from 10 to 7.5', () => {
    const free = terminalSpeed({ maxForward: MAX_FORWARD, anchored: false });
    const towed = terminalSpeed({ maxForward: MAX_FORWARD, anchored: false, towFactor: TOW_SPEED_SHARE });
    expect(free).toBeCloseTo(MAX_FORWARD, 1);
    expect(towed).toBeCloseTo(MAX_FORWARD * TOW_SPEED_SHARE, 1);
  });

  it('cuts a Trim III hull from 13 to 9.75, so the shelf is still worth owning', () => {
    const trim = TRIM_MAX_FORWARD[TRIM_MAX_FORWARD.length - 1];
    const towed = terminalSpeed({ maxForward: trim, anchored: false, towFactor: TOW_SPEED_SHARE });
    expect(towed).toBeCloseTo(trim * TOW_SPEED_SHARE, 1);
    // And a towed Trim III still beats an untowed bare hull, which is the whole
    // reason a tier stays worth its gold to a player who tows.
    expect(towed).toBeLessThan(MAX_FORWARD);
    expect(towed).toBeGreaterThan(MAX_FORWARD * TOW_SPEED_SHARE);
  });

  it('is applied AFTER the worn hull cap, so a broken ship is not towing for free', () => {
    // A hull below 25% is capped at 5 kn by `hull.ts`. The tow has to take a
    // quarter off THAT, not disappear into a `min` against it.
    const worn = terminalSpeed({ maxForward: MAX_FORWARD, anchored: false, towFactor: TOW_SPEED_SHARE }, 5);
    expect(worn).toBeCloseTo(5 * TOW_SPEED_SHARE, 1);
    expect(worn).toBeLessThan(5);

    // The bug this case exists for: `min(0.75 * 10, 5)` is 5, so a tow folded
    // into `maxForward` would leave this hull at its cap, unpenalised.
    expect(worn).not.toBeCloseTo(5, 1);
  });

  it('leaves the hull alone when nothing is on the line', () => {
    const withField = terminalSpeed({ maxForward: MAX_FORWARD, anchored: false, towFactor: 1 });
    const withoutField = terminalSpeed({ maxForward: MAX_FORWARD, anchored: false });
    expect(withField).toBeCloseTo(withoutField, 6);
  });
});

describe('tow: what it does to the burn', () => {
  /**
   * Level burnt per second at `speed`, with and without a tow.
   *
   * A RATE rather than a total, and the window is short on purpose: at these
   * draws a full tank is gone in 78 to 90 seconds, so a hundred-second sample
   * measures the tank's own floor in both cases and reports that the two burns
   * are identical. The first draft of this file did exactly that and read 1.33
   * where the truth is 1.54.
   *
   * The sun is put straight DOWN through the planet so the panels contribute
   * nothing: this is a measurement of the draw, and a charge on top of it would
   * be a different number every latitude.
   */
  function burnRate(speed: number, towing: boolean): number {
    const energy = createEnergy(NO_TOWNS, createBattery(0));
    const position = latLonToDir(0, 0);
    const env = {
      sunDirection: position.clone().negate(),
      elapsed: 0,
    } as unknown as WorldEnv;
    const ship = {
      position,
      up: position.clone(),
      speed,
      groundSpeed: speed,
    } as unknown as Parameters<typeof energy.update>[1];
    const seconds = 10;
    const before = energy.state.level;
    for (let i = 0; i < seconds / 0.05; i++) {
      energy.update(0.05, ship, env, false, 0, undefined, towing);
    }
    return (before - energy.state.level) / seconds;
  }

  /** Tank spent per 100 world units covered at `speed`. */
  function perHundred(speed: number, towing: boolean): number {
    return (burnRate(speed, towing) / speed) * 100;
  }

  it('doubles the whole draw, hotel load included', () => {
    // At rest: the hotel load alone, doubled.
    expect(burnRate(0, true)).toBeCloseTo(burnRate(0, false) * TOW_BURN_MULTIPLIER, 9);
    // Under way: the sum, doubled.
    expect(burnRate(7.5, true)).toBeCloseTo(burnRate(7.5, false) * TOW_BURN_MULTIPLIER, 9);
    expect(TOW_BURN_MULTIPLIER).toBe(2);
  });

  it('costs 1.58x the fuel per unit distance, which is the whole argument for a quarter', () => {
    // The two rules compose, and this is the number docs/SALVAGE_PLAN.md's
    // table is built on. Fuel per 100 units: flat out untowed against the tow's
    // own top speed, doubled.
    //
    // Both ratios rose when `NAV_BURN_SCALE` halved the propulsion draw on
    // 2026-09-11 -- 1.54x and 1.11x before it -- because the scale cuts
    // propulsion and leaves `IDLE_DRAIN` alone, so the hotel load a tow doubles
    // along with everything else is a larger share of a smaller burn. Pinned to
    // two decimals rather than one: at the old tolerance 1.58 still read as
    // 1.54, which is exactly the drift these figures exist to catch.
    const free = perHundred(MAX_FORWARD, false);
    const towed = perHundred(MAX_FORWARD * TOW_SPEED_SHARE, true);
    expect(towed / free).toBeCloseTo(1.58, 2);

    // And the rejected half-speed version would have cost 1.21x -- still
    // little enough to be worth rejecting over. Pinned so the argument
    // survives.
    const half = perHundred(MAX_FORWARD * 0.5, true);
    expect(half / free).toBeCloseTo(1.21, 2);
    expect(towed).toBeGreaterThan(half);
  });

  it('never touches the charge: a tow at a berth still fills at the berth rate', () => {
    const towed = createEnergy(NO_TOWNS, createBattery(0));
    const free = createEnergy(NO_TOWNS, createBattery(0));
    const env = { sunDirection: latLonToDir(0, 0).clone(), elapsed: 0 } as unknown as WorldEnv;
    const position = latLonToDir(0, 0);
    const ship = {
      position,
      up: position.clone(),
      speed: 0,
      groundSpeed: 0,
    } as unknown as Parameters<typeof towed.update>[1];

    towed.spend(0.5);
    free.spend(0.5);
    for (let i = 0; i < 20 / 0.05; i++) {
      towed.update(0.05, ship, env, false, 0, undefined, true);
      free.update(0.05, ship, env, false, 0, undefined, false);
    }
    // Both are charging under the same noon sun; the tow pays a doubled hotel
    // load out of it and nothing else, so it is behind but still climbing.
    expect(towed.state.level).toBeGreaterThan(0.5);
    expect(free.state.level).toBeGreaterThan(towed.state.level);
  });
});

describe('tow: what it pays', () => {
  it('scales with the voyage and stays inside its band', () => {
    expect(towGold(120)).toBe(TOW_GOLD_MIN);
    expect(towGold(350)).toBe(TOW_GOLD_MAX);
    // A 350-unit haul pays about double a 120-unit one, which is the promise
    // made in docs/SALVAGE_PLAN.md.
    expect(towGold(350) / towGold(120)).toBeGreaterThan(1.9);
    expect(towGold(350) / towGold(120)).toBeLessThan(2.2);

    // Monotone, round, and clamped outside the band -- a dev-forced hull in a
    // world with no harbour inside the band may not print a five-figure purse.
    let last = -1;
    for (let v = 100; v <= 400; v += 5) {
      const gold = towGold(v);
      expect(gold).toBeGreaterThanOrEqual(TOW_GOLD_MIN);
      expect(gold).toBeLessThanOrEqual(TOW_GOLD_MAX);
      expect(gold % 100).toBe(0);
      expect(gold).toBeGreaterThanOrEqual(last);
      last = gold;
    }
    expect(towGold(-5)).toBe(TOW_GOLD_MIN);
    expect(towGold(10000)).toBe(TOW_GOLD_MAX);
    expect(towGold(Number.NaN)).toBe(TOW_GOLD_MIN);
  });

  it('pays reputation on the contract board’s own scale', () => {
    // More than a cargo run, less than a survey of a third of the world. It is
    // also the only reputation in the game that cannot be lost: no deadline.
    expect(TOW_REPUTATION).toBe(8);
    expect(TOW_REPUTATION).toBeGreaterThan(0);
  });
});
