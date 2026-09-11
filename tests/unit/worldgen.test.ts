import { describe, it, expect } from 'vitest';
import { world1337 } from './support/world-1337';
import { createQuality } from '../../src/quality';
import { DEFAULT_SEED } from '../../src/terrain';
import { HARBOUR_COUNT } from '../../src/harbournames';
import {
  LAND_MAX,
  LAND_MIN,
  checkWorld,
  generateWorld,
  worldPasses,
} from '../../src/worldgen';
import type { WorldChecks } from '../../src/worldgen';
import type { WorldData } from '../../src/globe';
import type { Town, Towns } from '../../src/types';

/**
 * The rejection loop.
 *
 * Nearly all of this is a truth table over four numbers, which is why
 * `checkWorld` and `worldPasses` are two functions rather than one: measuring
 * a world costs a world, and judging one costs nothing. Only the two cases
 * that genuinely need a world build one, and they share it.
 */

const quality = createQuality('');

/** A passing set of measurements, to mutate one field of per case. */
const GOOD: WorldChecks = {
  spawnIsSea: true,
  landFraction: (LAND_MIN + LAND_MAX) / 2,
  polesReachable: true,
  harbourCount: HARBOUR_COUNT,
  equatorOpen: true,
  bandBridges: 0,
  // Reported, never gated on -- so a value here can be anything a passing
  // world would plausibly show. 25 units is the measured mean across the 50
  // worlds `npm run world:measure` surveys.
  mainlandApproach: 25,
};

/**
 * A `WorldData` with `n` towns and nothing else real.
 *
 * `checkWorld` reads four things off a world -- the height map's data, one
 * height sample, the town list and the islet cull's counts -- so a fake
 * carrying those is a complete input, and building a real world to assert "35
 * harbours is a rejection" would cost 1.3 s to learn something arithmetic
 * already knows.
 *
 * The map is 8x32 rather than the four texels it used to be, and the shape is
 * load-bearing now: `equatorIsOpen` scans the rows the guaranteed strip covers,
 * which is under 8% of them, so a map fewer than about thirteen rows tall has
 * NO row inside the band and the scan reports a blocked equator by default.
 * Every case below would then fail for two reasons at once and stop pinning the
 * one it names. At 32 rows the band is rows 15-16, the land sits in rows 0-7
 * well clear of it, and the fraction is still the 0.25 that lands mid-band.
 */
function fakeWorld(n: number, poles = true): WorldData {
  const towns: Town[] = Array.from({ length: n }, (_, i) => ({
    dir: { x: 0, y: 1, z: 0 },
    height: 0.2,
    coast: 0.5,
    dock: null,
    name: `Town ${i}`,
    index: i,
  })) as unknown as Town[];
  const named = new Map<string, Town>();
  if (poles) {
    named.set('Marine Stronghold', towns[0]);
    named.set("No Man's Land", towns[0]);
  }
  const fakeTowns = {
    all: towns,
    docks: [],
    dockAt: () => null,
    byName: (name: string) => named.get(name) ?? null,
  } as unknown as Towns;

  // One texel of land in four, so the land fraction lands mid-band -- all of it
  // in the northern rows, so the equatorial strip reads as open.
  const width = 8;
  const height = 32;
  const data = new Float32Array(width * height);
  for (let i = 0; i < width * 8; i++) data[i] = 1;
  return {
    seed: 1,
    heightMap: {
      data,
      width,
      height,
      sample: () => -0.5,
    },
    isletCull: {
      bandBridges: 0,
      mainlandMinAbsLat: 0.2,
    },
    waterBodies: {},
    towns: fakeTowns,
  } as unknown as WorldData;
}

const seaLevelOnly = { seaLevel: 0.08 } as unknown as Parameters<typeof checkWorld>[1];

describe('worldPasses', () => {
  it('accepts a world that measures well', () => {
    expect(worldPasses(GOOD)).toBe(true);
  });

  it('rejects a spawn on land', () => {
    expect(worldPasses({ ...GOOD, spawnIsSea: false })).toBe(false);
  });

  it('rejects a world outside the land band, at either end', () => {
    expect(worldPasses({ ...GOOD, landFraction: LAND_MIN - 1e-6 })).toBe(false);
    expect(worldPasses({ ...GOOD, landFraction: LAND_MAX + 1e-6 })).toBe(false);
    // Inclusive at both ends: the band is a range, not an open interval.
    expect(worldPasses({ ...GOOD, landFraction: LAND_MIN })).toBe(true);
    expect(worldPasses({ ...GOOD, landFraction: LAND_MAX })).toBe(true);
  });

  it('rejects a sealed polar moat', () => {
    expect(worldPasses({ ...GOOD, polesReachable: false })).toBe(false);
  });

  it('rejects any harbour count that is not exactly HARBOUR_COUNT', () => {
    expect(worldPasses({ ...GOOD, harbourCount: HARBOUR_COUNT - 1 })).toBe(false);
    expect(worldPasses({ ...GOOD, harbourCount: HARBOUR_COUNT + 1 })).toBe(false);
  });

  /*
   * The equatorial strip's two gates, and they are two on purpose -- see
   * `WorldChecks`. `equatorOpen` is "the way round the world is shut
   * somewhere"; `bandBridges` is "the coast walked into water that was
   * promised clear" without necessarily closing it. A world can fail either
   * without failing the other, so neither can stand in for the other.
   */
  it('rejects a blocked equator', () => {
    expect(worldPasses({ ...GOOD, equatorOpen: false })).toBe(false);
  });

  it('rejects any landmass reaching into the strip, however few', () => {
    expect(worldPasses({ ...GOOD, bandBridges: 1 })).toBe(false);
  });

  /*
   * `mainlandApproach` is REPORTED and never gated on -- `bandBridges` is the
   * same property expressed as a verdict, and two gates on one fact is one too
   * many. Pinned so that stays deliberate: a future edit that starts rejecting
   * on the distance has to delete this case to do it.
   */
  it('does not judge a world on the reported approach distance', () => {
    expect(worldPasses({ ...GOOD, mainlandApproach: 0 })).toBe(true);
  });
});

describe('checkWorld', () => {
  it('reads a short town list as a rejection', () => {
    const checks = checkWorld(fakeWorld(HARBOUR_COUNT - 1), seaLevelOnly);
    expect(checks.harbourCount).toBe(HARBOUR_COUNT - 1);
    expect(worldPasses(checks)).toBe(false);
  });

  it('reads a missing polar name as a rejection even at the full count', () => {
    const checks = checkWorld(fakeWorld(HARBOUR_COUNT, false), seaLevelOnly);
    expect(checks.harbourCount).toBe(HARBOUR_COUNT);
    expect(checks.polesReachable).toBe(false);
    expect(worldPasses(checks)).toBe(false);
  });
});

describe('the pinned seed', () => {
  /*
   * DEFAULT_SEED is the world every random draw falls back to after twelve
   * failures, the world `world-golden.json` pins, and the world the smoke
   * suite loads. If it stops passing its own checks the fallback stops being a
   * fallback, so this is the single most load-bearing assertion in the file.
   */
  it('passes every check', () => {
    const { data, terrain } = world1337();
    const checks = checkWorld(data, terrain);
    expect(checks.spawnIsSea).toBe(true);
    expect(checks.polesReachable).toBe(true);
    expect(checks.harbourCount).toBe(HARBOUR_COUNT);
    expect(checks.landFraction).toBeGreaterThanOrEqual(LAND_MIN);
    expect(checks.landFraction).toBeLessThanOrEqual(LAND_MAX);
    expect(worldPasses(checks)).toBe(true);
  }, 30_000);
});

describe('generateWorld', () => {
  it('makes exactly one attempt on a seed hint and returns that seed', async () => {
    const seen: number[] = [];
    const world = await generateWorld(DEFAULT_SEED, quality, async (n, seed) => {
      seen.push(n);
      expect(seed).toBe(DEFAULT_SEED);
    });
    expect(seen).toEqual([1]);
    expect(world.seed).toBe(DEFAULT_SEED);
    expect(world.data.towns.all.length).toBe(HARBOUR_COUNT);
  }, 30_000);

  /*
   * A hinted seed that fails is LOUD. A pinned seed is pinned because
   * something is being compared against it, and quietly substituting a
   * different world would turn that comparison into a lie -- so the failure
   * has to be an exception rather than a shrug. The rejection is forced here
   * (`?reject=`'s parameter) because no seed is known that fails on its own:
   * over 270 checked, none did.
   */
  it('throws rather than substituting a world when a hinted seed is rejected', async () => {
    await expect(generateWorld(DEFAULT_SEED, quality, undefined, 1)).rejects.toThrow(
      /does not make a usable world/,
    );
  }, 30_000);
});
