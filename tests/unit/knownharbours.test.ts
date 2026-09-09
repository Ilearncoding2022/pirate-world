import { describe, it, expect } from 'vitest';
import { createKnownHarbours } from '../../src/knownharbours';

/**
 * `knownharbours.ts` on its own.
 *
 * The idempotence is the case that earns its place: `main.ts` calls `add`
 * from the frame loop for as long as the ship sits alongside, so a store that
 * notified on every call would write the save file sixty times a second for
 * one mooring.
 */
describe('knownharbours', () => {
  it('starts from the saved list, in the order the file had it', () => {
    const known = createKnownHarbours(['Rustwharf', 'Neon Reach', 'Ionport']);
    expect([...known.names]).toEqual(['Rustwharf', 'Neon Reach', 'Ionport']);
  });

  it('starts empty for a player who has never moored', () => {
    expect([...createKnownHarbours().names]).toEqual([]);
  });

  it('fires once on a new name and never again for the same one', () => {
    const known = createKnownHarbours();
    let changes = 0;
    known.onChange(() => changes++);

    known.add('Rustwharf');
    expect(changes).toBe(1);

    // The frame loop's own case: sixty calls for one mooring.
    for (let i = 0; i < 60; i++) known.add('Rustwharf');
    expect(changes).toBe(1);
    expect([...known.names]).toEqual(['Rustwharf']);

    known.add('Ionport');
    expect(changes).toBe(2);
    expect([...known.names]).toEqual(['Rustwharf', 'Ionport']);
  });

  it('does not fire for a name that was already in the saved file', () => {
    const known = createKnownHarbours(['Rustwharf']);
    let changes = 0;
    known.onChange(() => changes++);
    known.add('Rustwharf');
    expect(changes).toBe(0);
  });

  it('tells every listener, so the save and the scope cannot unsubscribe each other', () => {
    const known = createKnownHarbours();
    let a = 0;
    let b = 0;
    known.onChange(() => a++);
    known.onChange(() => b++);
    known.add('Lumen Bay');
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('ignores an empty name rather than remembering a nameless place', () => {
    const known = createKnownHarbours();
    let changes = 0;
    known.onChange(() => changes++);
    known.add('');
    expect(changes).toBe(0);
    expect(known.names.size).toBe(0);
  });

  it('keeps a name this build does not recognise', () => {
    // The load half of the same promise the fish book keeps: a save from a
    // build with a longer name table survives a round trip through this one.
    const known = createKnownHarbours(['A Harbour From A Later Build']);
    expect(known.names.has('A Harbour From A Later Build')).toBe(true);
  });
});
