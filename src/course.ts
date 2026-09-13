/**
 * course.ts — the one harbour the player has chosen to sail for.
 *
 * A NAME, for `knownharbours.ts`'s reason: the world is redrawn on every load
 * and the name is the only durable fact about a harbour, so a course set last
 * session points at the same harbour on whatever island it landed this time.
 * `courseline.ts` draws the line to it and `main.ts` resolves the name through
 * `Towns.byName`; a name this world cannot place simply draws nothing.
 *
 * Only a KNOWN harbour can be a destination (owner's call, 2026-09-13). That
 * rule lives in `pickCourse` below rather than in the store, so a course
 * loaded off disk is never second-guessed against a list that is still being
 * read in.
 */

export interface Course {
  /** The destination's name, or null for no course. */
  readonly destination: string | null;
  /** Set or clear. Idempotent: the same value costs nothing and fires nothing. */
  set(name: string | null): void;
  /** Fires on every real change, for the save and the line. */
  onChange(fn: () => void): void;
}

export function createCourse(saved: string | null = null): Course {
  let destination = typeof saved === 'string' && saved.length > 0 ? saved : null;
  const listeners: Array<() => void> = [];

  return {
    get destination(): string | null {
      return destination;
    },
    set(name: string | null): void {
      const next = typeof name === 'string' && name.length > 0 ? name : null;
      if (next === destination) return;
      destination = next;
      for (const fn of listeners) fn();
    },
    onChange(fn: () => void): void {
      listeners.push(fn);
    },
  };
}

/** What a pick on a harbour should do, decided without touching anything. */
export type CoursePick =
  | { readonly kind: 'set'; readonly name: string }
  | { readonly kind: 'clear'; readonly name: string }
  | { readonly kind: 'uncharted'; readonly name: string };

/**
 * The rule for a double-click (or a SET COURSE press) on `name`:
 *
 * - never moored there: refuse, and say so;
 * - it is already the course: clear it;
 * - otherwise: make it the course, replacing any other.
 */
export function pickCourse(
  current: string | null,
  name: string,
  known: ReadonlySet<string>,
): CoursePick {
  if (!known.has(name)) return { kind: 'uncharted', name };
  if (current === name) return { kind: 'clear', name };
  return { kind: 'set', name };
}
