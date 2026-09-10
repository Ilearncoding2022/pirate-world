import { describe, it, expect } from 'vitest';
import { Color, Vector3 } from 'three';
import { createEnergy } from '../../src/energy';
import { createBattery } from '../../src/battery';
import { MOONGLASS_NIGHT_FRACTION } from '../../src/moonglass';
import type { Dock, ShipState, Town, Towns } from '../../src/types';
import type { WorldEnv } from '../../src/env';

/**
 * The mode ladder in `energy.ts` — ten names for what the plant is doing.
 *
 * This is the part of the plant that can be wrong without anything failing:
 * the arithmetic goes on working perfectly while the panel names the wrong
 * cause, and the only witness is a player misreading it. Two of the rungs
 * exist because that happened — `restart` because a charging plant tagged
 * EMPTY reads as a dead one, and `moon` because a Moonglass Array claimed
 * SOLAR at midnight.
 *
 * The colour is deliberately NOT tested here. It is `hud.ts`'s severity, not
 * sim state, which is the whole point of the split.
 */

const NO_TOWNS: Towns = {
  all: [],
  docks: [],
  dockAt: (): Dock | null => null,
};

/** A world with one berth, and the ship always inside it. */
function berthedTowns(): Towns {
  const town: Town = { dir: new Vector3(0, 1, 0), height: 0, coast: 1, dock: null };
  const dock: Dock = { dir: new Vector3(0, 1, 0), radius: 8, town };
  return { all: [town], docks: [dock], dockAt: (): Dock | null => dock };
}

function ship(speed = 0): ShipState {
  const position = new Vector3(0, 1, 0);
  return {
    position,
    up: position.clone(),
    forward: new Vector3(1, 0, 0),
    heading: 0,
    headingDeg: 0,
    speed,
    groundSpeed: speed,
    velocity: new Vector3(),
    latDeg: 0,
    lonDeg: 0,
  };
}

/** Noon overhead (day) or straight down (night), by `up`. */
function envWithSun(elevationSign: 1 | -1, moonIllumination = 1): WorldEnv {
  return {
    sunDirection: new Vector3(0, elevationSign, 0),
    sunColor: new Color('#ffffff'),
    moonDirection: new Vector3(0, -elevationSign, 0),
    moonIllumination,
    elapsed: 0,
    timeOfDay: 0,
    dayFactor: elevationSign > 0 ? 1 : 0,
  };
}

const DAY = envWithSun(1, 0);
const NIGHT = envWithSun(-1, 1);

/**
 * Runs `seconds` of plant at the frame rate the sim actually sees.
 *
 * `update` caps dt at 0.1 s, so a single call asking for two seconds buys a
 * tenth of one. The dwell clock is the only thing here that cares, and it is
 * exactly the thing a berth test must not get wrong.
 */
function run(
  energy: ReturnType<typeof createEnergy>,
  seconds: number,
  hull: ShipState,
  env: WorldEnv,
): void {
  for (let i = 0; i < Math.round(seconds / 0.1); i++) energy.update(0.1, hull, env, false, 0);
}

/** Runs a plant dry in the dark, with no cell aboard: both tanks on the floor. */
function stranded(): ReturnType<typeof createEnergy> {
  const energy = createEnergy(NO_TOWNS, createBattery(0));
  for (let i = 0; i < 30_000 && energy.state.canThrust; i++) {
    energy.update(0.1, ship(), NIGHT, false, 0);
  }
  expect(energy.state.canThrust).toBe(false);
  return energy;
}

describe('energy.ts — the mode ladder', () => {
  it('splits a dead plant from one already climbing back', () => {
    // The pair this whole change exists for. Both refuse thrust; only one of
    // them is a predicament, and the old single `empty` told the player they
    // were the same thing while the rate line beside it said otherwise.
    const dark = stranded();
    dark.update(0.1, ship(), NIGHT, false, 0);
    expect(dark.state.mode).toBe('dead');
    expect(dark.state.rate).toBeLessThanOrEqual(0);

    const sunlit = stranded();
    sunlit.update(0.1, ship(), DAY, false, 0);
    expect(sunlit.state.mode).toBe('restart');
    expect(sunlit.state.rate).toBeGreaterThan(0);
    // Still no thrust: `restart` names the wait, it does not end it.
    expect(sunlit.state.canThrust).toBe(false);
  });

  it('names what is on the panels: sun, moon, or nothing at all', () => {
    const solar = createEnergy(NO_TOWNS, createBattery(0));
    solar.update(0.1, ship(), DAY, false, 0);
    expect(solar.state.mode).toBe('solar');

    const moon = createEnergy(NO_TOWNS, createBattery(0));
    moon.update(0.1, ship(), NIGHT, false, MOONGLASS_NIGHT_FRACTION[3]);
    expect(moon.state.mode).toBe('moon');

    // The same night without the array bought: the hotel load, and only that.
    const hotel = createEnergy(NO_TOWNS, createBattery(0));
    hotel.update(0.1, ship(), NIGHT, false, 0);
    expect(hotel.state.mode).toBe('hotel');
    expect(hotel.state.rate).toBeLessThan(0);
  });

  it('tells an engine burning from a coil burning', () => {
    const burn = createEnergy(NO_TOWNS, createBattery(0));
    burn.update(0.1, ship(5), DAY, false, 0);
    expect(burn.state.mode).toBe('burn');

    // Above `burn`, because the coil's bill is flat and four times the
    // full-speed draw: read as an ordinary burn it would leave the player to
    // explain a rate the speed does not account for.
    const coil = createEnergy(NO_TOWNS, createBattery(0));
    coil.update(0.1, ship(5), DAY, true, 0);
    expect(coil.state.mode).toBe('overdrive');
  });

  it('counts the dwell out loud, then connects', () => {
    const energy = createEnergy(berthedTowns(), createBattery(0));

    // Inside the ring, dwell running. The panel used to say SOLAR here and
    // leave the two seconds entirely unaccounted for.
    run(energy, 1, ship(), DAY);
    expect(energy.state.mode).toBe('mooring');
    expect(energy.state.dock).toBeNull();

    // Dwell served. The ring's verdict is in -- `berthReady` -- but the mode
    // is still `mooring`, because since 2026-09-09 eligibility is not arrival:
    // the helm has to make the ship fast before `docked` is true of it.
    run(energy, 1.5, ship(), DAY);
    expect(energy.state.berthReady).toBe(true);
    expect(energy.state.mode).toBe('mooring');

    // The key press. `toggleMooring` is the one door into `docked`, and the
    // mode is written by `update`, so the rung appears on the next frame
    // rather than on the press itself.
    expect(energy.toggleMooring()).toBe(true);
    run(energy, 0.1, ship(), DAY);
    expect(energy.state.mode).toBe('docked');
    expect(energy.state.dock).not.toBeNull();
  });

  it('reports a hull motoring through a ring as a burn, not as an arrival', () => {
    // `mooring` sits below `burn` on purpose: the dwell clock counts whatever
    // the hull is doing, but calling a hull under power CONNECTING would be
    // the same class of lie the old EMPTY tag told.
    // One second in, with the dwell still short of its two: at 12 kn a real
    // hull is most of the way across a 16-unit ring by now, which is the case
    // DOCK_DWELL_SECONDS exists to refuse.
    const energy = createEnergy(berthedTowns(), createBattery(0));
    run(energy, 1, ship(12), DAY);
    expect(energy.state.mode).toBe('burn');
  });

  it('holds `docked` while the tank is full, because five modules test it', () => {
    // The regression this guards is not cosmetic: `mode === 'docked'` is the
    // project's single definition of being at a berth, and the shop gate, the
    // wind's shelter, the hazard suppression and the dock glow all read it. A
    // tank filling up must not close the chandlery. TANK FULL is the HUD's
    // word, derived from `level`, and it is deliberately not a mode.
    const energy = createEnergy(berthedTowns(), createBattery(0));
    run(energy, 3, ship(), DAY);
    expect(energy.toggleMooring()).toBe(true);
    run(energy, 0.1, ship(), DAY);
    expect(energy.state.level).toBe(1);
    expect(energy.state.mode).toBe('docked');
  });

  it('says which tank is going down once the cell is paying', () => {
    const energy = createEnergy(NO_TOWNS, createBattery(50));
    // The main tank spent outright, exactly as the fishing card spends it.
    expect(energy.spend(1)).toBe(true);
    energy.update(0.1, ship(5), DAY, false, 0);
    expect(energy.state.mode).toBe('reserve');
    // Outranks both burns: this is the charge no berth and no sunrise puts back.
    expect(energy.state.reserve).toBeLessThan(0.5);
  });
});
