/**
 * knownharbours.ts — the harbours the ship has actually moored at.
 *
 * The world is redrawn on every page load, so the only thing a player can
 * carry from one sea to the next is a NAME. This is the list of them, in
 * first-visit order, and it is the whole of what "I have been there before"
 * means in this project: `radar.ts` draws a known harbour out to the scope's
 * full range whether or not the chart reaches it, and `menu.ts`'s HARBOURS
 * page gives it a bearing and a distance instead of `UNCHARTED`.
 *
 * `main.ts` calls `add` on the frame `energy.state.mode` becomes `'docked'`,
 * which is this project's one definition of moored — the same instant the
 * berth starts charging the tank. Nothing else may write here; sighting a
 * harbour from six units off is not visiting it.
 *
 * A `Set` rather than an array because the caller is a frame loop: `add` runs
 * every frame for as long as the ship sits alongside, so the idempotence
 * below is not a nicety, it is the contract that keeps one mooring from
 * writing the save file sixty times a second.
 */

export interface KnownHarbours {
  /**
   * The names, in first-visit order.
   *
   * `Set` iterates in insertion order, which is why the order the file was
   * written in survives a round trip through `save.ts` without either side
   * keeping a second array to remember it by.
   */
  readonly names: ReadonlySet<string>;
  /** Remember a mooring. Idempotent: a name already known costs nothing. */
  add(name: string): void;
  /** Fires only when a genuinely new name was added, for the save. */
  onChange(fn: () => void): void;
}

/**
 * The store, seeded with whatever `save.ts` repaired out of the file.
 *
 * Unknown names are kept, exactly as the loader kept them: a save from a
 * build with a longer name table must survive a round trip through this one,
 * and a harbour this build cannot place is still a harbour the player
 * remembers visiting.
 */
export function createKnownHarbours(saved: readonly string[] = []): KnownHarbours {
  const names = new Set<string>();
  for (const name of saved) {
    if (typeof name === 'string' && name.length > 0) names.add(name);
  }

  /*
   * A LIST of listeners rather than the single slot `chart.ts` keeps.
   *
   * Two things want to hear about a new harbour — the save file and, once
   * Stream C lands, whatever redraws the scope's harbour labels — and a
   * single slot means the second subscriber silently unsubscribes the first.
   * That failure is invisible until a player reloads and finds a mooring
   * gone, which is the exact bug `save.ts`'s "one entry point rather than
   * four" comment exists to prevent.
   *
   * `onChange` still returns void, because the signature is fixed by
   * docs/HARBOURS_PLAN.md and nothing in this project ever stops listening
   * for a mooring.
   */
  const listeners: Array<() => void> = [];

  function add(name: string): void {
    if (name.length === 0 || names.has(name)) return;
    names.add(name);
    for (const fn of listeners) fn();
  }

  function onChange(fn: () => void): void {
    listeners.push(fn);
  }

  return { names, add, onChange };
}
