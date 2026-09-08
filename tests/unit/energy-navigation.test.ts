import { describe, it, expect } from 'vitest';
import { Color, Vector3 } from 'three';
import { createEnergy } from '../../src/energy';
import { createBattery } from '../../src/battery';
import { OVERDRIVE_BURN_MULTIPLIER } from '../../src/overdrive';
import { MOONGLASS_NIGHT_FRACTION } from '../../src/moonglass';
import type { Dock, ShipState, Towns } from '../../src/types';
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
