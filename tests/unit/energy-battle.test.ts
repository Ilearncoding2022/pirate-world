import { describe, it, expect } from 'vitest';
import { createEnergy, DEFEAT_KEEP, STALEMATE_COST } from '../../src/energy';
import { createBattery } from '../../src/battery';
import { createWallet } from '../../src/wallet';
import type { Dock, Towns } from '../../src/types';

/**
 * What losing and drawing a cannon fight cost, and nothing else.
 *
 * `energy.defeat` and `energy.stalemate` are two of the three withdrawals in
 * the project that are not purchases -- `wreck` is the third -- and all three
 * share one property worth pinning: they may only ever move a level DOWN, and
 * they may only reach the backup cell through `battery.draw`, which is what
 * notifies the save file. A defeat written straight into the cell would leave
 * a run playing on charge the reload puts back.
 *
 * `wallet.lose` is here rather than in a wallet file of its own because it is
 * the other half of the same event: it is best-effort where `spend` is
 * all-or-nothing, and a defeat is the only thing in the game that uses it.
 *
 * Nothing here asserts on how any of it looks; that is rule 1 in
 * docs/TESTING.md.
 */

/**
 * A world with no berths at all.
 *
 * `createEnergy` only ever asks its towns one question -- which berth is under
 * this point -- and none of the three functions under test asks it even that.
 * The real `createTowns` walks 20 000 candidates over a rasterised height map,
 * which is a second and a half of this tier's two-second budget spent to
 * answer "none".
 */
const NO_TOWNS: Towns = {
  all: [],
  docks: [],
  dockAt: (): Dock | null => null,
};

/** A plant on a full main tank with `cellPercent` in the backup cell. */
function plant(cellPercent: number): ReturnType<typeof createEnergy> {
  return createEnergy(NO_TOWNS, createBattery(cellPercent));
}

describe('energy.defeat', () => {
  it('empties the main tank and leaves DEFEAT_KEEP in a cell that held more than the threshold', () => {
    // 30% of a main tank, comfortably over DEFEAT_KEEP_ABOVE's 20%.
    const energy = plant(30);
    energy.defeat();
    expect(energy.state.level).toBe(0);
    expect(energy.state.reserve).toBeCloseTo(DEFEAT_KEEP, 10);
  });

  it('empties a cell that held less than the threshold outright', () => {
    // 15%: a real charge, and not enough of one to be worth leaving a tenth of.
    const energy = plant(15);
    energy.defeat();
    expect(energy.state.level).toBe(0);
    expect(energy.state.reserve).toBe(0);
  });

  it('leaves a ship with no cell at zero on both tanks', () => {
    const energy = plant(0);
    energy.defeat();
    expect(energy.state.level).toBe(0);
    expect(energy.state.reserve).toBe(0);
  });

  it('draws the cell through the battery, so the save file is told', () => {
    // The whole reason `defeat` goes through `battery.draw` rather than
    // through a setter this file would have had to add. `battery.ts` notifies
    // on the PERSISTED figure -- whole percent -- and 30 to 10 crosses twenty
    // of them, so a silent write would be caught here and nowhere else.
    const battery = createBattery(30);
    const seen: number[] = [];
    battery.onChange((level) => seen.push(level));
    createEnergy(NO_TOWNS, battery).defeat();
    // The immediate call every subscriber gets, plus the draw.
    expect(seen.length).toBe(2);
    expect(seen[seen.length - 1]).toBeCloseTo(DEFEAT_KEEP, 10);
  });
});

describe('energy.stalemate', () => {
  it('takes STALEMATE_COST in percentage points off the main tank', () => {
    const energy = plant(0);
    // Down to 0.6 through the public surface, because `EnergyState` is
    // read-only to everything outside `energy.ts` and a cast here would be a
    // test reaching past the contract it exists to hold.
    expect(energy.spend(0.4)).toBe(true);
    // Points, not a share: 0.6 becomes 0.35, never 0.45.
    energy.stalemate();
    expect(energy.state.level).toBeCloseTo(0.6 - STALEMATE_COST, 10);
  });

  it('floors at zero rather than going negative', () => {
    const energy = plant(0);
    expect(energy.spend(0.9)).toBe(true);
    energy.stalemate();
    expect(energy.state.level).toBe(0);
  });

  it('leaves the backup cell alone', () => {
    const energy = plant(40);
    // Main-first, so this comes entirely out of the tank and the cell is
    // untouched going in as well as coming out.
    expect(energy.spend(0.4)).toBe(true);
    energy.stalemate();
    expect(energy.state.reserve).toBeCloseTo(0.4, 10);
  });
});

describe('wallet.lose', () => {
  it('takes what is there and reports it, where spend would have refused', () => {
    const wallet = createWallet(500);
    // The difference between the two, in one assertion: a defeat is not a
    // purchase, and an empty hold does not save a player from having lost.
    expect(wallet.spend(700)).toBe(false);
    expect(wallet.lose(700)).toBe(500);
    expect(wallet.gold).toBe(0);
  });
});

