import { describe, it, expect } from 'vitest';
import { createReputation } from '../../src/reputation';
import { REPUTATION_FLOOR } from '../../src/questconstants';

/**
 * The standing store, which is the one number in this project that is allowed
 * to be negative.
 *
 * Everything here is about that asymmetry, because it is the whole difference
 * between this and `wallet.ts` and it is where a copy of the wallet would have
 * gone wrong: the wallet floors at zero and refuses what it cannot pay, and a
 * captain who has missed three deadlines is at -15 and that is a reading rather
 * than an error.
 */

describe('createReputation', () => {
  it('starts a new captain at zero', () => {
    expect(createReputation().points).toBe(0);
  });

  it('earns and loses in whole points', () => {
    const rep = createReputation();
    rep.award(20);
    expect(rep.points).toBe(20);
    rep.penalise(5);
    expect(rep.points).toBe(15);
  });

  it('goes negative, which no other store here may', () => {
    const rep = createReputation();
    rep.penalise(5);
    rep.penalise(5);
    expect(rep.points).toBe(-10);
  });

  it('never refuses a penalty, however empty the account', () => {
    // A deadline that has passed has passed whether the player can afford it or
    // not, which is why there is no `spend` here and no boolean to check.
    const rep = createReputation(0);
    rep.penalise(40);
    expect(rep.points).toBe(-40);
  });

  it('stops at the floor and has no ceiling', () => {
    const rep = createReputation();
    rep.penalise(1_000_000);
    expect(rep.points).toBe(REPUTATION_FLOOR);
    rep.award(1_000_000);
    expect(rep.points).toBe(1_000_000 + REPUTATION_FLOOR);
  });

  it('brings a figure from disk up to the floor rather than trusting it', () => {
    expect(createReputation(-999_999).points).toBe(REPUTATION_FLOOR);
  });

  it('refuses a NaN from either direction, rather than becoming NaN forever', () => {
    /*
     * The failure `wallet.ts` states on its own guard, and it is permanent: one
     * `points += NaN` makes every later total NaN, the page prints NaN, and the
     * next write puts it in the save file where the loader will correctly throw
     * the player's whole standing away.
     */
    const rep = createReputation(20);
    rep.award(Number.NaN);
    rep.penalise(Number.NaN);
    rep.award(Number.POSITIVE_INFINITY);
    expect(rep.points).toBe(20);
    expect(createReputation(Number.NaN).points).toBe(0);
  });

  it('ignores a negative magnitude on either method', () => {
    // `penalise` takes a positive magnitude like `wallet.lose` does, so a caller
    // with a sign error cannot gain standing by failing a contract.
    const rep = createReputation(10);
    rep.penalise(-50);
    rep.award(-50);
    expect(rep.points).toBe(10);
  });

  it('floors a fractional amount rather than carrying it', () => {
    const rep = createReputation();
    rep.award(10.9);
    expect(rep.points).toBe(10);
  });

  it('fires immediately with the current total, then on every change', () => {
    // Immediately, for `wallet.ts`'s reason: a subscriber that waited for the
    // first change would show 0 for the whole session on a loaded save.
    const rep = createReputation(7);
    const seen: number[] = [];
    rep.onChange((points) => seen.push(points));
    expect(seen).toEqual([7]);
    rep.award(3);
    rep.penalise(1);
    expect(seen).toEqual([7, 10, 9]);
  });

  it('notifies nobody for a change that changed nothing', () => {
    /*
     * Subscribers redraw AND rewrite the save file on this, so a no-op that
     * notified would do both for free -- and on the floor, where a failure
     * costs nothing more, it would do both on every expiry.
     */
    const rep = createReputation(REPUTATION_FLOOR);
    const seen: number[] = [];
    rep.onChange((points) => seen.push(points));
    rep.penalise(5);
    rep.award(0);
    expect(seen).toEqual([REPUTATION_FLOOR]);
  });

  it('unsubscribes', () => {
    const rep = createReputation();
    let count = 0;
    const off = rep.onChange(() => count++);
    rep.award(5);
    expect(count).toBe(2);
    off();
    rep.award(5);
    expect(count).toBe(2);
  });

  it('survives a subscriber that unsubscribes itself mid-callback', () => {
    /*
     * What a disposing panel does, and the case the `Array.from` in `notify`
     * exists for.
     *
     * `off` is a `let` assigned afterwards rather than the obvious `const off =
     * rep.onChange(...)`, and that is a fact about the store rather than about
     * the test: `onChange` fires the callback synchronously before it returns,
     * so a `const` is still in its temporal dead zone on that first call and the
     * obvious spelling throws rather than testing anything.
     */
    const rep = createReputation();
    const seen: number[] = [];
    let off: (() => void) | null = null;
    off = rep.onChange((points) => {
      seen.push(points);
      // From the SECOND fire onward, never the first. A subscriber cannot
      // unsubscribe itself from inside the immediate fire, because that call
      // happens before `onChange` has returned the function to call -- which is
      // inherent to any store that notifies on subscribe, `wallet.ts` included,
      // and is the reason this is a `let` rather than the obvious `const`.
      if (seen.length > 1) off?.();
    });
    rep.onChange(() => undefined);
    rep.award(4);
    // The one that unsubscribed, and then nothing however much is earned after.
    rep.award(4);
    rep.penalise(2);
    expect(seen).toEqual([0, 4]);
  });
});
