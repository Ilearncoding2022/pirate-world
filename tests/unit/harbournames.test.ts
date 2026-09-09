import { describe, it, expect } from 'vitest';
import {
  HARBOUR_COUNT,
  HARBOUR_NAMES,
  HARBOUR_NAME_MAX_LENGTH,
  NORTH_POLE_INDEX,
  SOUTH_POLE_INDEX,
} from '../../src/harbournames';

/**
 * The name table is the one part of the world that never moves.
 *
 * `save.ts` keys `knownHarbours` and `harbourStock` on the STRING, not on the
 * index, so a duplicate would silently merge two harbours into one saved
 * entry, a missing one would leave a town nameless, and a typo in either of
 * the owner's two would rename a place a player had already visited. None of
 * those throws; all of them are quiet. That is what this file is for.
 */
describe('harbournames', () => {
  it('holds exactly HARBOUR_COUNT names', () => {
    expect(HARBOUR_COUNT).toBe(36);
    expect(HARBOUR_NAMES.length).toBe(HARBOUR_COUNT);
  });

  it('has no duplicates', () => {
    expect(new Set(HARBOUR_NAMES).size).toBe(HARBOUR_NAMES.length);
  });

  it('has no blank or untrimmed entries', () => {
    for (const name of HARBOUR_NAMES) {
      expect(name.length).toBeGreaterThan(0);
      expect(name).toBe(name.trim());
    }
  });

  /*
   * Verbatim, apostrophe included. These are the owner's own two and they are
   * pinned to the two indices `towns.ts` places at the poles, so this asserts
   * the pairing as well as the spelling.
   */
  it('pins the two owner-named harbours to the polar indices', () => {
    expect(NORTH_POLE_INDEX).toBe(0);
    expect(SOUTH_POLE_INDEX).toBe(1);
    expect(HARBOUR_NAMES[NORTH_POLE_INDEX]).toBe('Marine Stronghold');
    expect(HARBOUR_NAMES[SOUTH_POLE_INDEX]).toBe("No Man's Land");
  });

  it('reports the longest name the HUD has to fit', () => {
    expect(HARBOUR_NAME_MAX_LENGTH).toBe(
      HARBOUR_NAMES.reduce((max, n) => Math.max(max, n.length), 0),
    );
  });
});
