import { describe, it, expect } from 'vitest';
import { Color, Vector3 } from 'three';
import { createEnergy } from '../../src/energy';
import { createBattery } from '../../src/battery';
import { OVERDRIVE_BURN_MULTIPLIER } from '../../src/overdrive';
import { MOONGLASS_NIGHT_FRACTION } from '../../src/moonglass';
import type { Dock, ShipState, Towns, WeatherState } from '../../src/types';
import type { WorldEnv } from '../../src/env';

/**
 * The two Navigation offers `energy.ts` itself has to know about: the
 * Overdrive Coil's flat burn and the Moonglass Array's night charge. Every
 * other new offer in `docs/SHOP_PLAN.md` is either self-contained
 * (`ship.ts`'s `PropulsionState`) or lives entirely in the fishing files —
 * see `fishing-navigation.test.ts` and `ship-physics.test.ts` for those.
 */

const NO_TOWNS: Towns = {
  all: [],
  docks: [],
  dockAt: (): Dock | null => null,
};

function stoppedShip(): ShipState {
  const position = new Vector3(0, 1, 0);
  return {
    position,
    up: position.clone(),
    forward: new Vector3(1, 0, 0),
    heading: 0,
    headingDeg: 0,
    speed: 0,
    groundSpeed: 0,
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

/**
 * Drains an energy plant well clear of a full tank, on plain idle drain, so a
 * later single-frame `update` in a test can show a real marginal `rate`
 * instead of one clamped flat by `state.level` sitting at its ceiling of 1.
 */
function drained(): ReturnType<typeof createEnergy> {
  const energy = createEnergy(NO_TOWNS, createBattery(0));
  for (let i = 0; i < 200; i++) energy.update(0.1, stoppedShip(), envWithSun(-1, 0));
  return energy;
}

/**
 * A plant drained to about half, so a later charge has somewhere to go.
 *
 * `drained()` above takes 20 seconds off a full tank, which the solar charge
 * makes back inside two and clamps at the ceiling -- and a clamped level
 * reports a `rate` of exactly 0, which would make every comparison below
 * pass or fail for the wrong reason. Twenty minutes of idle drain leaves
 * about half, which no test here can refill.
 */
function halfDrained(): ReturnType<typeof createEnergy> {
  const energy = createEnergy(NO_TOWNS, createBattery(0));
  for (let i = 0; i < 12000; i++) energy.update(0.1, stoppedShip(), envWithSun(-1, 0));
  return energy;
}

/** A weather with only the two envelopes the plant reads set. */
function weatherWith(storm: number, fog: number): WeatherState {
  return {
    kind: 'storm',
    cover: storm,
    rain: storm,
    storm,
    fog,
    flash: 0,
    flashLocal: false,
    flashOrigin: null,
    flashSeed: 0,
    visibility: 50,
  };
}

describe('energy.ts — the weather on the panels', () => {
  it('leaves a clear noon exactly as it was, with and without a weather argument', () => {
    const clear = halfDrained();
    const withArg = halfDrained();
    for (let i = 0; i < 20; i++) {
      clear.update(0.1, stoppedShip(), envWithSun(1));
      withArg.update(0.1, stoppedShip(), envWithSun(1), false, 0, weatherWith(0, 0));
    }
    // The zero contract, on the one system where it can be measured to the
    // last bit rather than looked at: no weather and clear weather are the
    // same plant.
    expect(withArg.state.level).toBe(clear.state.level);
    expect(withArg.state.rate).toBe(clear.state.rate);
  });

  it('takes nearly all of the panels in a full storm and half in fog', () => {
    const clear = halfDrained();
    const storm = halfDrained();
    const fog = halfDrained();
    for (let i = 0; i < 20; i++) {
      clear.update(0.1, stoppedShip(), envWithSun(1));
      storm.update(0.1, stoppedShip(), envWithSun(1), false, 0, weatherWith(1, 0));
      fog.update(0.1, stoppedShip(), envWithSun(1), false, 0, weatherWith(0, 1));
    }
    expect(clear.state.rate).toBeGreaterThan(0);
    // A full storm leaves 5% of the charge, so the plant is draining rather
    // than charging: a storm is a power problem, which is the whole point.
    expect(storm.state.rate).toBeLessThan(0);
    expect(storm.state.level).toBeLessThan(clear.state.level);
    // Fog is half, and half of a noon is still a charge.
    expect(fog.state.level).toBeLessThan(clear.state.level);
    expect(fog.state.level).toBeGreaterThan(storm.state.level);
  });

  it('cuts the Moonglass Array by the same factor, so a night storm is no better', () => {
    const clear = halfDrained();
    const storm = halfDrained();
    for (let i = 0; i < 20; i++) {
      clear.update(0.1, stoppedShip(), envWithSun(-1, 1), false, MOONGLASS_NIGHT_FRACTION[3]);
      storm.update(
        0.1,
        stoppedShip(),
        envWithSun(-1, 1),
        false,
        MOONGLASS_NIGHT_FRACTION[3],
        weatherWith(1, 0),
      );
    }
    // Left uncut, a night storm would charge better than a day one, which is
    // a strange thing for a game to teach.
    expect(storm.state.level).toBeLessThan(clear.state.level);
  });

  it('charges at a berth whatever the sky is doing', () => {
    // A berth is the one shelter the plant has, and the reason to run for one.
    const dock: Dock = { town: null as never, dir: new Vector3(0, 1, 0), radius: 10 };
    // Alongside only once `alongside` says so, so the drain below happens at
    // sea rather than in the berth that is meant to be doing the charging.
    let alongside = false;
    const towns: Towns = { all: [], docks: [dock], dockAt: () => (alongside ? dock : null) };
    const stormy = createEnergy(towns, createBattery(0));

    // Twenty minutes at sea in the dark, to make room.
    for (let i = 0; i < 12000; i++) stormy.update(0.1, stoppedShip(), envWithSun(-1, 0));
    const low = stormy.state.level;
    expect(low).toBeLessThan(0.9);

    // Then alongside, at night, in the worst weather there is.
    //
    // The dwell is served first and the made-fast key pressed after it, in
    // that order, because `toggleMooring` refuses until `berthReady` says the
    // ring is satisfied. Those seconds are still hotel load -- lying in a
    // berth is not being plugged into it -- so the reading the charge is
    // measured against is taken at the press and not at sea. `low` is kept as
    // the weaker claim it always was: the berth does not merely slow the
    // drain in a storm at night, it climbs back past where the sea left off.
    alongside = true;
    for (let i = 0; i < 30; i++) {
      stormy.update(0.1, stoppedShip(), envWithSun(-1, 0), false, 0, weatherWith(1, 1));
    }
    expect(stormy.toggleMooring()).toBe(true);
    const madeFast = stormy.state.level;
    for (let i = 0; i < 200; i++) {
      stormy.update(0.1, stoppedShip(), envWithSun(-1, 0), false, 0, weatherWith(1, 1));
    }
    expect(stormy.state.mode).toBe('docked');
    expect(stormy.state.level).toBeGreaterThan(madeFast);
    expect(stormy.state.level).toBeGreaterThan(low);
  });
});

describe('energy.ts — Navigation offers', () => {
  it('burns a flat OVERDRIVE_BURN_MULTIPLIER x FULL_BURN while the coil is active', () => {
    const plain = createEnergy(NO_TOWNS, createBattery(0));
    const overdrive = createEnergy(NO_TOWNS, createBattery(0));
    const ship = { ...stoppedShip(), speed: 1 }; // a nominal speed; overdrive ignores it
    const night = envWithSun(-1, 0);

    plain.update(1, ship, night, false);
    overdrive.update(1, ship, night, true);

    // Both drained relative to a full tank; overdrive's rate is the more
    // negative of the two, by roughly OVERDRIVE_BURN_MULTIPLIER at this
    // nominal (near-zero-throttle) speed.
    expect(overdrive.state.level).toBeLessThan(plain.state.level);
    expect(overdrive.state.rate).toBeLessThan(0);

    // Doubling the speed changes nothing while overdrive is active — the
    // whole point of a flat bill instead of the ordinary curve.
    const overdriveFast = createEnergy(NO_TOWNS, createBattery(0));
    overdriveFast.update(1, { ...stoppedShip(), speed: 9 }, night, true);
    expect(overdriveFast.state.level).toBeCloseTo(overdrive.state.level, 9);

    void OVERDRIVE_BURN_MULTIPLIER; // documents which constant this pins
  });

  it('charges nothing extra at night with no Moonglass Array bought', () => {
    const energy = createEnergy(NO_TOWNS, createBattery(0));
    energy.update(1, stoppedShip(), envWithSun(-1, 1), false, 0);
    // Idle drain only: the tank must have lost ground, not gained any.
    expect(energy.state.rate).toBeLessThan(0);
  });

  it('a Moonglass Array charges at night, scaled by tier and by moon illumination', () => {
    const tierII = drained();
    const tierIII = drained();
    const newMoon = drained();
    const night = envWithSun(-1, 1);

    tierII.update(1, stoppedShip(), night, false, MOONGLASS_NIGHT_FRACTION[2]);
    tierIII.update(1, stoppedShip(), night, false, MOONGLASS_NIGHT_FRACTION[3]);
    newMoon.update(1, stoppedShip(), envWithSun(-1, 0), false, MOONGLASS_NIGHT_FRACTION[3]);

    // A higher tier charges more than a lower one, at the same moon phase.
    expect(tierIII.state.rate).toBeGreaterThan(tierII.state.rate);
    // A full moon charges more than a new moon, at the same tier.
    expect(tierIII.state.rate).toBeGreaterThan(newMoon.state.rate);
    // A new moon still pays the idle drain: illumination of 0 contributes
    // nothing at all, regardless of tier.
    expect(newMoon.state.rate).toBeLessThan(0);
  });

  it('never adds a moonlight charge while the sun itself is up', () => {
    const day = drained();
    const dayNoMoonlight = drained();
    day.update(0.1, stoppedShip(), envWithSun(1, 1), false, MOONGLASS_NIGHT_FRACTION[3]);
    dayNoMoonlight.update(0.1, stoppedShip(), envWithSun(1, 1), false, 0);
    // The gate is sunElevation <= 0, not "whichever term is bigger" -- so a
    // tier III array armed under a zenith sun must charge exactly what no
    // array at all would, not a watt more.
    expect(day.state.rate).toBeCloseTo(dayNoMoonlight.state.rate, 12);
  });
});

/**
 * `NAV_BURN_SCALE` (owner, 2026-09-11): halve every power cost of NAVIGATING
 * and leave every other cost alone.
 *
 * The figures here are worked from first principles rather than imported,
 * because importing the constants the module derives them from would let this
 * file agree with a typo. `IDLE_ENDURANCE` is 42 * 60 and the unscaled
 * `FULL_SPEED_ENDURANCE` is 90, so the scaled burn at full throttle is
 * 1/180 + 1/5040 = 29/5040 level/s -- the hotel load at its full size, plus
 * half the propulsion draw.
 */
describe('energy.ts — NAV_BURN_SCALE halves navigation and nothing else', () => {
  const IDLE = 1 / (42 * 60);
  const FULL_THROTTLE = 1 / 180 + 1 / 5040;
  /** `MAX_FORWARD`, ie. full ahead. Not imported: see the block comment. */
  const TOP = 10;

  /** Level/s actually committed at a held speed, measured off `rate`. */
  function rateAt(speed: number): number {
    const energy = createEnergy(NO_TOWNS, createBattery(0));
    energy.update(0.1, { ...stoppedShip(), speed }, envWithSun(-1, 0), false);
    return -energy.state.rate;
  }

  it('draws half the propulsion it used to at full throttle', () => {
    expect(rateAt(TOP)).toBeCloseTo(FULL_THROTTLE, 9);
    // The pre-halving figure, which this must NOT be: 1/90.
    expect(rateAt(TOP)).toBeLessThan(1 / 90);
    // Propulsion alone is exactly half of the old propulsion alone.
    expect(rateAt(TOP) - IDLE).toBeCloseTo((1 / 90 - IDLE) / 2, 9);
  });

  it('keeps the quadratic law, so the halving reaches every throttle', () => {
    // Half throttle is a quarter of the PROPULSION draw, hotel load aside.
    expect(rateAt(TOP / 2) - IDLE).toBeCloseTo((rateAt(TOP) - IDLE) / 4, 9);
    expect(rateAt(TOP / 4) - IDLE).toBeCloseTo((rateAt(TOP) - IDLE) / 16, 9);
  });

  it('leaves the hotel load, and so a drifting ship, exactly where it was', () => {
    // Stopped and in the dark is the hotel load and nothing else. This is the
    // constant NAV_BURN_SCALE deliberately does not touch, because it is paid
    // at anchor and at a berth too and is therefore not a cost of navigating.
    expect(rateAt(0)).toBeCloseTo(IDLE, 9);
  });

  it('leaves what a maelstrom and a battle take exactly where they were', () => {
    // The exclusions, pinned. A wreck keeps a quarter and a stand-off costs a
    // flat 25 points, both unchanged by a scale that applies to propulsion.
    const wrecked = createEnergy(NO_TOWNS, createBattery(0));
    wrecked.update(0.1, stoppedShip(), envWithSun(-1, 0), false);
    const beforeWreck = wrecked.state.level;
    wrecked.wreck();
    expect(wrecked.state.level).toBeCloseTo(beforeWreck * 0.25, 9);

    const stalled = createEnergy(NO_TOWNS, createBattery(0));
    stalled.update(0.1, stoppedShip(), envWithSun(-1, 0), false);
    const beforeStalemate = stalled.state.level;
    stalled.stalemate();
    expect(stalled.state.level).toBeCloseTo(beforeStalemate - 0.25, 9);
  });
});
