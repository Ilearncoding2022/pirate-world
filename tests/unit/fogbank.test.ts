import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  createFogBank,
  fogInRange,
  sliceOpacity,
  FOG_SLICE_MAX,
  FOG_WAKE_RANGE,
  STACK_OPACITY,
} from '../../src/fogbank';
import { FOG_GLSL } from '../../src/fogglsl';
import { GLOBE_RADIUS } from '../../src/geo';
import type { CellsState, ShipState, WeatherCell, WeatherState } from '../../src/types';

/**
 * `fogbank.ts` on the CPU, which is most of what can go wrong with it.
 *
 * Nothing in the Node tier compiles GLSL, so what a test can reach here is the
 * arithmetic that decides the stack (how many slices, how opaque each one is)
 * and the predicate that decides whether the stack is drawn at all. Those are
 * exactly the parts that fail SILENTLY: a wrong per-slice alpha is fog that
 * happens to be thinner on one quality tier than another, and a wrong range
 * check is either a bank that pops in at the edge of the frame or a dozen
 * draw calls in permanently clear weather. Both are things nobody notices
 * until they are looking for something else.
 *
 * The look itself is a screenshot job -- `npm run shots -- --query weather=fog`
 * -- and always was, the same as the cloud deck's.
 */
function ship(position = new Vector3(0, 0, 1)): ShipState {
  const up = position.clone().normalize();
  return {
    position: up.clone(),
    up,
    forward: new Vector3(1, 0, 0),
    heading: 0,
    headingDeg: 0,
  } as unknown as ShipState;
}

function fogCell(centre: Vector3, radius = 80, strength = 1): WeatherCell {
  return {
    kind: 'fog',
    centre: centre.clone().normalize(),
    north: new Vector3(0, 1, 0),
    radius,
    strength,
    lightning: false,
    age: 10,
    life: 200,
  };
}

function cells(live: WeatherCell[]): CellsState {
  return {
    live,
    stormAtShip: 0,
    fogAtShip: 0,
    lightningAtShip: false,
    stormCellAtShip: null,
  };
}

function weather(fog: number): WeatherState {
  return { kind: 'fog', cover: 0.4, rain: 0, storm: 0, fog, flash: 0 } as unknown as WeatherState;
}

/** A unit direction `arc` world units away from `from`, along +Y. */
function away(from: Vector3, arc: number): Vector3 {
  const angle = arc / GLOBE_RADIUS;
  const tangent = new Vector3(0, 1, 0);
  return from
    .clone()
    .multiplyScalar(Math.cos(angle))
    .addScaledVector(tangent, Math.sin(angle))
    .normalize();
}

describe('fog bank stack', () => {
  it('composites to the same total opacity at every slice count', () => {
    // The invariant the whole tier table rests on: nine slices are as THICK as
    // fourteen, and what the lower count loses is smoothness, not density.
    for (const n of [2, 4, 9, FOG_SLICE_MAX]) {
      const left = Math.pow(1 - sliceOpacity(n), n);
      expect(1 - left).toBeCloseTo(STACK_OPACITY, 6);
    }
  });

  it('leaves the ship a silhouette rather than deleting it', () => {
    // "Partially blocking objects" is the note this module answers, so the
    // thickest core of the thickest bank has to stop short of opaque.
    expect(STACK_OPACITY).toBeLessThan(1);
    expect(STACK_OPACITY).toBeGreaterThan(0.9);
  });

  it('has no stack at all for a zero or negative count', () => {
    expect(sliceOpacity(0)).toBe(0);
    expect(sliceOpacity(-3)).toBe(0);
  });

  it('builds the requested slices and caps them at the derived maximum', () => {
    expect(createFogBank(9).object.children).toHaveLength(9);
    expect(createFogBank(FOG_SLICE_MAX + 40).object.children).toHaveLength(FOG_SLICE_MAX);
    // Two is the floor: one slice is not a stack, it is the painted decal
    // this module exists to replace.
    expect(createFogBank(1).object.children).toHaveLength(2);
  });

  it('starts invisible, so a caller that never updates costs nothing', () => {
    expect(createFogBank(9).object.visible).toBe(false);
  });
});

describe('fog bank presence', () => {
  const here = new Vector3(0, 0, 1);

  it('is off in clear weather with no cells at all', () => {
    expect(fogInRange(ship(here))).toBe(false);
    expect(fogInRange(ship(here), weather(0), cells([]))).toBe(false);
  });

  it('is on for a squall at the ship, which has no place on the map', () => {
    expect(fogInRange(ship(here), weather(0.5), cells([]))).toBe(true);
  });

  it('is off for a squall too thin to be worth a draw call', () => {
    expect(fogInRange(ship(here), weather(0.001), cells([]))).toBe(false);
  });

  it('is on for a fog cell within reach and off for one beyond it', () => {
    const near = fogCell(away(here, FOG_WAKE_RANGE * 0.5));
    const far = fogCell(away(here, FOG_WAKE_RANGE + 500), 80);
    expect(fogInRange(ship(here), weather(0), cells([near]))).toBe(true);
    expect(fogInRange(ship(here), weather(0), cells([far]))).toBe(false);
  });

  it('counts a cell by its skirt, not by its centre', () => {
    // Just outside the range on centre distance, well inside it once the
    // cell's own radius is allowed for. A bank must not pop in at the rim.
    const radius = 300;
    const grazing = fogCell(away(here, FOG_WAKE_RANGE + radius * 0.5), radius);
    expect(fogInRange(ship(here), weather(0), cells([grazing]))).toBe(true);
  });

  it('ignores storm cells and dead cells', () => {
    const storm = { ...fogCell(here), kind: 'storm' as const };
    const dead = fogCell(here, 80, 0);
    expect(fogInRange(ship(here), weather(0), cells([storm]))).toBe(false);
    expect(fogInRange(ship(here), weather(0), cells([dead]))).toBe(false);
  });
});

describe('the seam between the bank and the aerial haze', () => {
  it('keeps the aerial bank term out of the near field', () => {
    // `fogbank.ts` owns the first tens of units and `fogglsl.ts` the rest.
    // The ramp is what stops the flat tint painting the near sea grey, which
    // is the whole complaint this change answers, so it is worth pinning that
    // the aerial term applies it to every use of the bank rather than to some.
    expect(FOG_GLSL).toContain('float bank = wx.y * smoothstep(0.0, FOG_BANK_ONSET, dist);');
    expect(FOG_GLSL).not.toMatch(/FOG_DENSITY_GAIN \* wx\.y/);
    expect(FOG_GLSL).not.toMatch(/mix\(uFogMax, FOG_MAX_BANK, wx\.y\)/);
    expect(FOG_GLSL).not.toMatch(/uFogBankColor, clamp\(wx\.y/);
  });

  it('still multiplies every weather term by the weather, so zero is zero', () => {
    // docs/WEATHER_PLAN.md Trap 2, and the reason `battlescene.ts` can pass
    // vec2(0.0) and get the arena it always had: the ramp is a factor ON the
    // bank, so at wx.y = 0 it is still exactly 0 whatever the distance.
    expect(FOG_GLSL).toContain('FOG_DENSITY_GAIN * bank');
    expect(FOG_GLSL).toContain('mix(uFogMax, FOG_MAX_BANK, bank)');
  });
});
