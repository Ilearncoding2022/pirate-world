import { describe, it, expect } from 'vitest';
import { rollSpecies } from '../../src/species';
import { CHUM_DRUM_MIN_TIER } from '../../src/chumdrum';

/**
 * `rollSpecies`'s `minTier` gate — the Chum Drum's whole effect. Every other
 * property of `ROW_ODDS` (each row totalling 100, the tier/species split) is
 * `tools/`'s own probe's job per `species.ts`'s file comment; this is the one
 * behaviour that offer adds on top of it.
 *
 * A simple incrementing generator rather than `Math.random`, so a run that
 * fails is reproducible without a seed library: `rollSpecies` only ever calls
 * `rng()` twice (tier, then species-within-tier), so cycling through enough
 * distinct values covers the odds table without needing true randomness.
 */
function cycleRng(): () => number {
  let i = 0;
  return () => {
    i = (i + 1) % 97;
    return i / 97;
  };
}

describe('rollSpecies — minTier (Chum Drum)', () => {
  it('never returns below the floor across every row, at every odds slot', () => {
    const rng = cycleRng();
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i < 200; i++) {
        const species = rollSpecies(row, rng, CHUM_DRUM_MIN_TIER);
        expect(species.tier).toBeGreaterThanOrEqual(CHUM_DRUM_MIN_TIER);
      }
    }
  });

  it('reaches every tier the row could produce below the floor, at minTier 1', () => {
    // Sanity check on the harness itself: with no floor, row 5 (index 4) —
    // which has a nonzero share in every tier — must actually produce more
    // than one tier over the same sweep the biased test above uses.
    const rng = cycleRng();
    const tiersSeen = new Set<number>();
    for (let i = 0; i < 200; i++) tiersSeen.add(rollSpecies(4, rng, 1).tier);
    expect(tiersSeen.size).toBeGreaterThan(1);
  });

  it('leaves every row untouched at the default minTier of 1', () => {
    const withDefault = cycleRng();
    const explicit = cycleRng();
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i < 50; i++) {
        expect(rollSpecies(row, withDefault).id).toBe(rollSpecies(row, explicit, 1).id);
      }
    }
  });
});
