/**
 * huntsweep.ts — the harpoon dial's sweep, the damage ramp and the purse.
 *
 * Pure functions over a small struct. No module state, no DOM, no `three`, no
 * clock of its own: every call is handed the frame `dt` that `main.ts` already
 * clamped. That is what lets the whole of the hunt's timing be tested under
 * node in microseconds, and it is `fishsim.ts`'s split between the rule and
 * the card repeated for the second activity that has one.
 *
 * Cut out of `leviathan.ts` in phase 2 rather than written fresh. The sim owns
 * the animal; this owns the needle. They were one file while the needle was
 * four lines of `Math.sin`, and item 5 is the reason that stopped being true.
 *
 * **The sweep starts at the RED EDGE.** The MVP reset a clock to zero and read
 * `sin(0)`, which is 0, which is the CENTRE of the bar and worth very nearly
 * 100 damage. Tapping Space on the frame the gate opened therefore beat
 * reading the needle, which is an exploit against the one skill the feature
 * exists to test. Starting at `cos(0)` — the edge, worth nothing — and
 * refusing presses for `ARM_UP` while the needle visibly charges removes it
 * without hiding it behind a cooldown and without randomising the phase, which
 * would make the skill unlearnable. See docs/LEVIATHAN_PHASE2_PLAN.md item 3.
 */

/**
 * Seconds for one full sweep, edge to edge and back.
 *
 * Moved here from `leviathan.ts`, which re-exports it: two seconds is the
 * owner's figure and the reason is unchanged. Long enough to read, short
 * enough that a held target is not a free hit.
 */
export const DIAL_PERIOD = 2.0;

/**
 * Seconds after arming during which a press is refused.
 *
 * Short enough not to feel like a lockout and long enough that a mash landing
 * on the arming frame buys nothing. The needle charges visibly through it, so
 * the refusal is a thing the player sees rather than a press that vanished.
 */
export const ARM_UP = 0.25;

/**
 * Sweep rate multipliers at `centring` 0 and 1.
 *
 * The fusion of steering and timing that the whole feature is a claim about.
 * Holding the mark dead ahead SLOWS the needle and makes the shot easy; taking
 * it at the arc's edge runs the needle fast. A player who wants an easy press
 * has to earn it with the helm, and that is four lines of code.
 */
export const SWEEP_SLOW = 0.7;
export const SWEEP_FAST = 1.6;

/**
 * `SHADOW_SPEED` per target banked. Read by `leviathan.ts`, not by this file.
 *
 * Escalation in speed: the animal is quicker every time it is hit, so the
 * fifth target is a chase and the first is a lesson.
 */
export const LEVEL_SPEED: readonly number[] = [4, 4.5, 5, 5.5, 6];

/**
 * `HEADING_HOLD_MIN`/`MAX` per level, seconds. Read by `leviathan.ts`.
 *
 * Five to ten seconds at the first target down to three to six at the last:
 * the heading commits for less and less time, so the lead the player has just
 * learned to take stops being enough.
 */
export const LEVEL_HOLD: readonly (readonly [number, number])[] = [
  [5, 10],
  [4.5, 9],
  [4, 8],
  [3.5, 7],
  [3, 6],
];

/**
 * Banked damage multiplier per level.
 *
 * Escalation in pay. The multipliers sum to 6.1, so a perfect hunt banks 610
 * and pays 6 100 gold: over the best contract's 5 250 and well under
 * `bounty.ts`'s 20 000 jackpot, which is the ordering docs/LEVIATHAN_PLAN.md
 * argued for and this preserves. A blind player still averages about 36 a
 * press and takes home about 2 200.
 *
 * Multiplying the BANK rather than widening the green band is deliberate: a
 * band that moved every target would make the drawn bar lie about where
 * `SOUND_BELOW` is, and the MVP's warning about that applies doubly here.
 */
export const LEVEL_MULTIPLIER: readonly number[] = [1.0, 1.1, 1.2, 1.3, 1.5];

/**
 * Damage below which the animal sounds and the hunt ends, the last target
 * exempt. Moved here with the ramp it is a threshold on; `leviathan.ts`
 * re-exports it, and the dial reads it from there.
 */
export const SOUND_BELOW = 10;

/** Gold per point of banked damage. */
export const HUNT_GOLD_PER_DAMAGE = 10;

/**
 * Every purse is a multiple of this.
 *
 * Retyped from `questconstants.ts` rather than imported, which is the note
 * `leviathan.ts` carried when the purse lived there and is kept verbatim: the
 * two are the same number because prices are quoted in fifties, not because
 * one is derived from the other.
 */
const GOLD_ROUNDING = 50;

const TWO_PI = Math.PI * 2;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** An index into the escalation tables, clamped to the last row. */
function levelRow(level: number): number {
  if (!Number.isFinite(level)) return 0;
  const i = Math.floor(level);
  if (i < 0) return 0;
  return i >= LEVEL_MULTIPLIER.length ? LEVEL_MULTIPLIER.length - 1 : i;
}

/**
 * The needle's state. Two numbers, mutated in place by `step`.
 *
 * `phase` is seconds of SWEPT time rather than of wall time: `step` advances
 * it by `dt` times the rate, which is how one clock produces a needle that
 * runs at five different speeds without a second clock existing.
 */
export interface Sweep {
  phase: number;
  /** Seconds since `arm`. Compared against `ARM_UP` and nothing else. */
  armClock: number;
}

export function createSweep(): Sweep {
  return { phase: 0, armClock: 0 };
}

/**
 * Start a sweep at the red edge.
 *
 * Called on the transition into armed, and on nothing else. A player who loses
 * the target and comes round again gets the needle from a KNOWN start rather
 * than from wherever a free-running clock happened to be — the MVP's reasoning
 * and `fishsim.ts`'s, unchanged — except that the known start is now the edge
 * rather than the middle.
 */
export function arm(s: Sweep): void {
  s.phase = 0;
  s.armClock = 0;
}

/** The rate in use, given how centred the mark is and which target this is. */
export function rateFor(centring: number, level: number): number {
  const c = clamp01(centring);
  const base = SWEEP_SLOW + (SWEEP_FAST - SWEEP_SLOW) * c;
  /*
   * The level's factor is the animal's own speed-up, normalised: the needle
   * quickens in exactly the proportion the shoal does. Derived from
   * `LEVEL_SPEED` rather than given a sixth table of its own, because a second
   * set of five numbers would be two things to keep in step for one idea.
   */
  const row = levelRow(level);
  return base * (LEVEL_SPEED[row] / LEVEL_SPEED[0]);
}

/** One frame of needle. */
export function step(s: Sweep, dt: number, centring: number, level: number): void {
  if (!(dt > 0)) return;
  s.armClock += dt;
  s.phase += dt * rateFor(centring, level);
}

/**
 * Where the needle is, in [-1, 1], 0 at the centre.
 *
 * `cos`, not `sin`, and that one letter is item 5's fix: at `phase` 0 this is
 * 1, the red edge, worth no damage at all. The first perfect moment is a
 * quarter period away and has to be waited for.
 */
export function position(s: Sweep): number {
  return Math.cos((TWO_PI * s.phase) / DIAL_PERIOD);
}

/** Whether the arm-up has finished and a press would be honoured. */
export function canPress(s: Sweep): boolean {
  return s.armClock >= ARM_UP;
}

/** The banked-damage multiplier for a level. */
export function multiplierFor(level: number): number {
  return LEVEL_MULTIPLIER[levelRow(level)];
}

/**
 * Damage for a needle position. Unchanged from the MVP, deliberately.
 *
 * A linear ramp from 100 at the centre to 0 at either edge. The bar the player
 * reads is this function drawn, so anything cleverer here would have to be
 * drawable, and this is already the thing the drawn bar shows.
 */
export function damageAt(p: number): number {
  if (!Number.isFinite(p)) return 0;
  const mag = Math.abs(p);
  if (mag >= 1) return 0;
  return Math.round(100 * (1 - mag));
}

/**
 * Which band a press landed in.
 *
 * The sim publishes this on the cue so five consumers cannot each get the
 * thresholds wrong, which is the same reason `SOUND_BELOW` is exported rather
 * than restated in the dial. Green is the top third of the ramp; red is
 * anything that would sound the animal.
 */
export function bandFor(damage: number): 'green' | 'yellow' | 'red' {
  if (damage >= 70) return 'green';
  return damage >= SOUND_BELOW ? 'yellow' : 'red';
}

/** A hunt's purse, gold, from the damage it banked. */
export function huntGoldFor(banked: number): number {
  if (!(banked > 0)) return 0;
  const raw = banked * HUNT_GOLD_PER_DAMAGE;
  return Math.round(raw / GOLD_ROUNDING) * GOLD_ROUNDING;
}
