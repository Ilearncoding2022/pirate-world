/**
 * questconstants.ts — every tuning number the contract system has.
 *
 * Its own module, and deliberately free of imports. Two reasons, and they are
 * the same two `wakeconstants.ts` and `battleconstants.ts` were split out for:
 * a table of numbers that imports nothing can be read by a test without
 * standing up a world, and a number that exists in exactly one file cannot be
 * retuned in one place and left stale in another.
 *
 * **Every figure here is a first guess and should be treated as one.** They
 * were reasoned against the economy that already exists — `bounty.ts` pays 500
 * to 20 000 for a fight, `shop.ts` charges 1000 for a backup cell and 12 000
 * for Moonglass Mk III — and against the globe's measured scale, but none of
 * them has been played. `?quest=board` prints a whole day's postings for every
 * harbour, which is the cheapest way to look at the shape of the draw before
 * touching anything below.
 *
 * ## Two facts about this planet that every number here leans on
 *
 * **The antipode is 628 world units and about a minute away.** A full lap is
 * 2*PI*200 = 1257 units and the hull cruises near 10, so the farthest harbour
 * on the globe is roughly 60 seconds of sailing. That is why the deadlines
 * below are generous in absolute terms: a tier 3 run of one whole world day is
 * twenty times the passage time. The deadline is there to stop a contract
 * being forgotten, not to be the difficulty.
 *
 * **The terminator crawls at 1.05 units a second** (`daynight.ts`), a tenth of
 * the ship. So a DAYLIGHT or NIGHT window is the thing that actually has to be
 * solved: it cannot be waited out profitably, it has to be sailed to. That is
 * the whole reason `WINDOW_GOLD_BONUS` and `REPUTATION_WINDOW_BONUS` exist, and
 * why `WINDOW_SLACK` *tightens* the clock on a windowed run rather than
 * loosening it.
 */

/* ------------------------------------------------------------------ */
/* Slots                                                               */
/* ------------------------------------------------------------------ */

/**
 * Contracts in hand at once.
 *
 * Three, of any kind, which is the owner's call. The alternative considered was
 * one slot, and the reason it loses is that a `CHART` goal has no deadline and
 * would therefore sit in a single slot for as long as it took, blocking every
 * delivery behind it.
 */
export const MAX_ACTIVE = 3;

/** Postings on one harbour's board at one time. */
export const OFFERS_PER_HARBOUR = 3;

/* ------------------------------------------------------------------ */
/* Map structure: the arc bands                                        */
/* ------------------------------------------------------------------ */

/**
 * The two great-circle arcs that split a delivery into three tiers, radians.
 *
 * Below `ARC_NEAR` is tier 1, below `ARC_FAR` is tier 2, and at or beyond it is
 * tier 3. 60 and 120 degrees, which is 209 and 419 world units, and they split
 * the *sphere* into three bands of roughly equal area rather than the *arc*
 * into three equal lengths — the number of harbours in each band is what a
 * player feels, and that goes as the area.
 */
export const ARC_NEAR = Math.PI / 3;
export const ARC_FAR = (2 * Math.PI) / 3;

/**
 * The cruise speed every deadline and every window is reasoned against, world
 * units a second.
 *
 * Not imported from `ship.ts`, and that is deliberate rather than lazy. What
 * `MAX_FORWARD` states is the hull's flat-out speed in knots at full tank and
 * a sound hull; what this states is the speed a contract ASSUMES, which has to
 * be below it — a deadline computed off the maximum would be a deadline only a
 * player at full throttle on a fresh hull could ever meet. Ten against a
 * nominal fifteen leaves room for a worn hull, a headwind and a course that is
 * not a perfect great circle.
 */
export const CRUISE_SPEED = 10;

/* ------------------------------------------------------------------ */
/* Day and night: the deadlines and the windows                         */
/* ------------------------------------------------------------------ */

/**
 * Deadline per tier, in WORLD DAYS. Indexed by `tier - 1`.
 *
 * Days rather than seconds, because a day is the unit the dial shows and the
 * one a player can read off the sky. `quests.ts` multiplies by `DAY_LENGTH`.
 */
export const DELIVERY_DAYS: readonly number[] = [0.25, 0.5, 1.0];

/**
 * What a window does to the deadline: multiplies it by this.
 *
 * Less than one, so a windowed contract is tighter than an open one rather
 * than looser. The window is the hard part, and a contract that paid extra for
 * the hard part while also relaxing the easy part would be free money.
 */
export const WINDOW_SLACK = 0.75;

/**
 * Relative weights on the three windows at generation.
 *
 * `ANY` at half the draw, because a board of nothing but windowed runs would
 * make the commonest contract in the game the one that needs the most
 * planning, and a new player would meet it first.
 */
export const WINDOW_WEIGHT_ANY = 2;
export const WINDOW_WEIGHT_DAYLIGHT = 1;
export const WINDOW_WEIGHT_NIGHT = 1;

/**
 * The least useful window, world seconds.
 *
 * A window narrower than this is not offered at all. Thirty seconds is about
 * half the longest passage on the globe, so it is wide enough that arriving
 * inside it is a course rather than a coin toss.
 */
export const WINDOW_MIN = 30;

/* ------------------------------------------------------------------ */
/* Pay                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Purse band per tier, gold, inclusive. Indexed by `tier - 1`.
 *
 * Deliberately under `bounty.ts`'s fight table at every tier: a won fight pays
 * 500 to 20 000 and is a gamble that costs 15% of the hull to lose, and a
 * contract is the steady wage beside it. An antipodal run with a window tops
 * out near 5000, which is between a backup cell and Trim Mk II — one good
 * passage should move the player one rung, not four.
 */
export const DELIVERY_GOLD: readonly (readonly [number, number])[] = [
  [300, 600],
  [800, 1500],
  [2000, 3500],
];

/** Multiplier on the purse when a `DAYLIGHT` or `NIGHT` window is attached. */
export const WINDOW_GOLD_BONUS = 1.5;

/**
 * Every purse is rounded to a multiple of this.
 *
 * Fifty, so a figure on a card reads as a quoted price rather than as the
 * output of a random number generator. `shop.ts`'s prices are all round
 * hundreds or thousands and a contract that paid 1337 would look like a bug.
 */
export const GOLD_ROUNDING = 50;

/* ------------------------------------------------------------------ */
/* Map structure: the chart goals                                      */
/* ------------------------------------------------------------------ */

/**
 * Coverage fractions a `CHART` goal can ask for, by tier. Cosine-weighted
 * fractions of the globe's AREA, which is what `chart.coverage()` returns.
 *
 * Ten percent is about what an hour's unhurried sailing reveals, and 35% is a
 * deliberate expedition. There is no 100% target and there should not be: the
 * chart is wiped when the world is redrawn, so a goal that needed the whole
 * globe would have to be finished in one sitting.
 */
export const CHART_TARGETS: readonly number[] = [0.1, 0.2, 0.35];

/** Purse for each `CHART_TARGETS` entry, gold. */
export const CHART_GOLD: readonly number[] = [400, 1000, 2500];

/**
 * How far a `CHART` goal has to move before the strip says so, as a fraction
 * of the globe.
 *
 * Five percent. A goal with no deadline and no destination is the one kind
 * that can otherwise run for twenty minutes in total silence, and this is the
 * whole of its feedback.
 */
export const CHART_PROGRESS_STEP = 0.05;

/* ------------------------------------------------------------------ */
/* Reputation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Reputation earned per tier on completion. Indexed by `tier - 1`.
 *
 * The owner set the floor of the scale: a finished contract is worth 10 points
 * or more. Doubling per tier makes the three bands feel like three different
 * jobs rather than three sizes of the same one.
 */
export const REPUTATION_BY_TIER: readonly number[] = [10, 20, 40];

/** Added to the above when a `DAYLIGHT` or `NIGHT` window is attached. */
export const REPUTATION_WINDOW_BONUS = 5;

/**
 * What a failed or abandoned contract costs, flat.
 *
 * Flat, and not scaled by tier, on purpose: scaling it would make the tier 3
 * contract the one a cautious player never touches, and the whole point of the
 * three bands is that the far ones are worth attempting. Five against the ten
 * the easiest completion pays means two failures undo one success.
 *
 * It is the ONLY cost of failing. No gold is taken, nothing is taken back, and
 * no other contract is touched — `docs/ROADMAP.md`'s rule was "failure costs
 * gold, never progress" and the owner tightened it to reputation, never gold.
 */
export const REPUTATION_FAIL = 5;

/**
 * The floor. Reputation may not go below it; there is no ceiling.
 *
 * The asymmetry is the owner's and it is the right way round: a ceiling would
 * cap the one number the game currently has for "how far have I got", while a
 * floor stops an unlucky hour turning into a hole nothing can climb out of.
 */
export const REPUTATION_FLOOR = -100;

/* ------------------------------------------------------------------ */
/* The notification strip                                             */
/* ------------------------------------------------------------------ */

/**
 * World seconds one message holds the strip.
 *
 * World seconds, not wall-clock, and that is not pedantry: the strip is ticked
 * from the sailing branch of the frame loop only, so a message raised as the
 * fishing card opens is still there when it closes. A CSS animation on a real
 * clock would have run out behind the card.
 */
export const TOAST_HOLD = 4;

/**
 * Messages waiting behind the one on screen.
 *
 * Four, and the fifth is dropped rather than queued. At four seconds each, a
 * fuller queue would be describing something that happened twenty seconds ago.
 */
export const TOAST_QUEUE = 4;

/* ------------------------------------------------------------------ */
/* Flavour                                                             */
/* ------------------------------------------------------------------ */

/**
 * What a delivery is carrying.
 *
 * Flavour only: nothing reads the cargo, nothing weighs it, and no offer is
 * gated on it. It is here so that three postings on one board read as three
 * jobs rather than as one job three times, which is the whole difference
 * between a contract and a fetch quest at the only point where the player
 * actually looks.
 */
export const CARGOES: readonly string[] = [
  'mail',
  'salvage',
  'medicine',
  'cell cores',
  'charts',
  'spare plating',
  'seed stock',
  'lamp oil',
];
