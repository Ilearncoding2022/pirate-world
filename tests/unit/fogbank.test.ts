import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import type { Mesh, ShaderMaterial } from 'three';
import { NEAR_DISTANCE } from '../../src/camera';
import {
  createFogBank,
  fogInRange,
  sliceOpacity,
  FOG_CLEAR_CORE,
  FOG_CLEAR_EDGE,
  CHASE_SIGHT_LENGTH,
  FOG_CAP_ARC,
  FOG_NEAR_FULL,
  FOG_NEAR_MIN,
  FOG_PILE_REACH,
  FOG_SLICE_MAX,
  FOG_WAKE_RANGE,
  HULL_LENGTH,
  HULL_WIDTH,
  STACK_OPACITY,
  FOG_THICKNESS,
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

/** GLSL `smoothstep`, so the test walks the ray the shader actually shades. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Fog along the chase camera's line of sight to the hull.
 *
 * The camera sits `NEAR_HEIGHT` up and `NEAR_DISTANCE` back and is INSIDE the
 * layer, so this ray is 23 units of fog travelled almost horizontally. Both
 * of the shader's distance fades are evaluated per sample: the near-camera
 * one on distance along the ray, the clearing on the horizontal distance from
 * the ship's axis, which is what the shader's `vAxisDist` carries.
 *
 * Returns the peak density reached and the integral, in world units of
 * full-strength fog. It is the measurement that condemned the first version
 * of the clearing -- sized against the boat, it removed 39% of this and still
 * left the ray at 100% somewhere along it -- so it is the thing to pin.
 */
function sightLine(core: number, edge: number): { peak: number; units: number } {
  const samples = 4000;
  let peak = 0;
  let units = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) / samples; // 0 at the camera, 1 at the hull
    const alongRay = CHASE_SIGHT_LENGTH * t;
    const fromAxis = FOG_CLEAR_EDGE_SETBACK * (1 - t);
    const density =
      smoothstep(FOG_NEAR_MIN, FOG_NEAR_FULL, alongRay) * smoothstep(core, edge, fromAxis);
    peak = Math.max(peak, density);
    units += density * (CHASE_SIGHT_LENGTH / samples);
  }
  return { peak, units };
}

/**
 * The camera's horizontal setback, which is also what `FOG_CLEAR_EDGE` is.
 * Named separately here so the ray keeps its own geometry if the clearing is
 * ever decoupled from the camera again.
 */
const FOG_CLEAR_EDGE_SETBACK = FOG_CLEAR_EDGE;

describe('the clear air the ship keeps around itself', () => {
  it('reaches the chase camera, or it cannot clear the sight line at all', () => {
    // The structural fact this whole constant rests on: a clearing of radius r
    // only touches the last r units of the camera's 21-unit horizontal run, so
    // anything narrower leaves the middle of the ray -- the full-density part
    // -- untouched. Sizing it against the hull is the intuitive mistake.
    expect(FOG_CLEAR_EDGE).toBeGreaterThanOrEqual(NEAR_DISTANCE);
  });

  it('leaves the hull readable from the chase camera', () => {
    const { peak, units } = sightLine(FOG_CLEAR_CORE, FOG_CLEAR_EDGE);
    // Never a stretch of full fog in front of the boat...
    expect(peak).toBeLessThan(0.3);
    // ...and little enough of it in total to see a hull through.
    expect(units).toBeLessThan(3);
  });

  it('is measurably better than sizing the clearing against the boat', () => {
    // The version this replaced, kept as the comparison that justifies the
    // change rather than as a number in a comment: a hull half-length plus a
    // beam, feathered over two and a half more.
    const boatSized = sightLine(HULL_LENGTH * 0.5 + HULL_WIDTH, HULL_LENGTH * 0.5 + HULL_WIDTH * 3.5);
    const bare = sightLine(0, 1e-6);
    expect(boatSized.peak).toBeCloseTo(1, 2); // it left the ray at full density
    expect(boatSized.units).toBeGreaterThan(bare.units * 0.5); // and removed under half
    expect(sightLine(FOG_CLEAR_CORE, FOG_CLEAR_EDGE).units).toBeLessThan(boatSized.units * 0.25);
  });

  it('keeps a core the eye reads as clear water around the ship', () => {
    expect(FOG_CLEAR_CORE).toBeGreaterThanOrEqual(HULL_LENGTH);
    expect(FOG_CLEAR_CORE).toBeLessThan(FOG_CLEAR_EDGE);
  });

  it('feathers rather than stamping a circle out of the bank', () => {
    // Most of the clearing has to be ramp, or its own rim becomes the artefact.
    expect(FOG_CLEAR_EDGE - FOG_CLEAR_CORE).toBeGreaterThan(FOG_CLEAR_CORE);
  });

  it('is small against the bank it is cut out of', () => {
    // A clearing is a hole in weather, not the weather.
    expect(FOG_CLEAR_EDGE).toBeLessThan(FOG_CAP_ARC * 0.2);
  });

  it('measures from the ship axis and fades before any noise is sampled', () => {
    const slice = createFogBank(9).object.children[0] as Mesh;
    const material = slice.material as ShaderMaterial;
    // A COLUMN, not a bubble: the varying is built from the radial part of
    // the object-space direction, which is the distance from the ship's own
    // vertical axis. See FOG_CLEAR_CORE for why a bubble would not work.
    expect(material.vertexShader).toContain('vAxisDist = length(wp.xyz) * length(dir.xz);');
    const frag = material.fragmentShader;
    const clearAt = frag.indexOf('vAxisDist');
    const noiseAt = frag.indexOf('float a0 = snoise');
    expect(clearAt).toBeGreaterThan(-1);
    expect(noiseAt).toBeGreaterThan(clearAt);
  });
});

describe('the bow wave the bubble pushes ahead of it', () => {
  /** The shader's crest shape, at a distance from the ship's axis. */
  function crest(fromAxis: number): number {
    const t = Math.min(
      1,
      Math.max(0, (fromAxis - FOG_CLEAR_CORE) / (FOG_PILE_REACH - FOG_CLEAR_CORE)),
    );
    return t * (1 - t) * 4;
  }

  it('never thickens the fog inside the clear bowl', () => {
    // The whole risk of a pile-up term: a wall that closes back over the boat
    // would undo the clearing it is supposed to explain.
    expect(crest(0)).toBe(0);
    expect(crest(FOG_CLEAR_CORE)).toBe(0);
  });

  it('crests outside the bowl and dies away beyond its reach', () => {
    expect(crest(FOG_CLEAR_EDGE)).toBeGreaterThan(0.9);
    expect(crest(FOG_PILE_REACH)).toBe(0);
    expect(crest(FOG_PILE_REACH * 2)).toBe(0);
    // Far enough out that the wall is never between the camera and the hull.
    expect(FOG_PILE_REACH).toBeGreaterThan(FOG_CLEAR_EDGE);
  });

  it('lowers the threshold rather than raising the density, so the early-out stays sound', () => {
    // `best` is an upper bound on the density, used to discard open water at
    // two noise samples. A pile-up ADDED to the density after that bound is
    // computed would discard pixels that should have become fog and punch
    // holes in the wall -- a bug no unit test could see, since nothing in the
    // Node tier compiles GLSL. Subtracting from the threshold first is the
    // same effect with the bound intact, and this pins the ordering.
    const slice = createFogBank(9).object.children[0] as Mesh;
    const frag = (slice.material as ShaderMaterial).fragmentShader;
    const pileAt = frag.indexOf('float pileUp =');
    const thrAt = frag.indexOf('float thr =');
    const bestAt = frag.indexOf('float best =');
    expect(pileAt).toBeGreaterThan(-1);
    expect(thrAt).toBeGreaterThan(pileAt);
    expect(bestAt).toBeGreaterThan(thrAt);
    expect(frag).toContain('- bank * 0.42 - pileUp;');
    // And it must never be added to `density`, which is computed after `best`.
    expect(frag).not.toMatch(/density \+= pileUp/);
  });

  it('vanishes with the bank, so thin fog grows no ring', () => {
    const slice = createFogBank(9).object.children[0] as Mesh;
    const frag = (slice.material as ShaderMaterial).fragmentShader;
    expect(frag).toContain('uPile * bank *');
  });

  it('draws a bank at FOG_THICKNESS times its own strength, clamped', () => {
    // Fog three times as thick, answered here on the STRENGTH rather than on
    // any of the densities: the threshold, the bow wave, the alpha ramp and
    // the discard all read `bank`, so one gain on the sample is one gain on
    // all four. The clamp is what keeps a bank that was already full drawing
    // the whiteout every constant in the file was tuned against.
    const slice = createFogBank(9).object.children[0] as Mesh;
    const frag = (slice.material as ShaderMaterial).fragmentShader;
    expect(FOG_THICKNESS).toBe(3);
    expect(frag).toContain(
      `float bank = min(1.0, max(uFogHere, weatherAt(uWeatherMap, nWorld).g) * ${FOG_THICKNESS.toFixed(1)});`,
    );
    // Substituted in, like the fade distances beside it: a placeholder left
    // standing is a shader that fails to compile, and nothing in the Node
    // tier compiles GLSL, so the whole substitution list is checked here.
    for (const token of [
      'FOG_THICKNESS_C',
      'FOG_ALT_GONE_C',
      'FOG_ALT_FULL_C',
      'FOG_NEAR_MIN_C',
      'FOG_NEAR_FULL_C',
      'FOG_CLEAR_CORE_C',
      'FOG_CLEAR_EDGE_C',
      'FOG_PILE_SPAN_C',
    ]) {
      expect(frag).not.toContain(token);
    }
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

  it('triples the haze RATE for thicker fog and leaves every ceiling alone', () => {
    // The other half of "three times as thick". The rate is the only term
    // with room in it -- a ceiling of 0.92 has no 2.76 to go to -- so what
    // triples is how fast the haze arrives, not how far it goes. A future
    // edit that reaches for the ceilings instead fails here.
    expect(FOG_GLSL).toContain('const float FOG_DENSITY_GAIN = 10.5;');
    expect(FOG_GLSL).toContain('const float FOG_MAX_AMOUNT = 0.15;');
    expect(FOG_GLSL).toContain('const float FOG_MAX_BANK = 0.92;');
    expect(FOG_GLSL).toContain('const float STORM_MAX_GAIN = 0.08;');
    // And rain was not asked to get thicker with it.
    expect(FOG_GLSL).toContain('const float STORM_DENSITY_GAIN = 1.0;');
  });
});
