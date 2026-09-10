# Contracts, reputation, and the notification strip: implementation plan

Status: **proposed, not built.** Nothing in this document exists in `src/`.
Verified on 2026-09-10 the way `docs/ROADMAP.md` verifies it: grepping `src/`
for `quest|contract|reputation|toast` returns only the word "contract" used in
module documentation to mean an API promise.

This document is the complete brief for **Phase 1**. An implementing agent
should not need the conversation it came from. Read `docs/ARCHITECTURE.md`
first, especially **Units, pinned**, **World scale**, **Day, night, and
travel**, **Harbours, the world loop, and the hull** and **Frame loop**; then
`docs/HARBOURS_PLAN.md` for the shape of a Step 0 plus four streams in this
repository, and for how `save.ts` grows a field without a version bump. The
roadmap items this closes are **Player-facing work** item 2 (a reason to sail
somewhere), item 4 (the notification layer) and **Strengthening what is
unique** item 5 (contracts that are spherical by construction).

Three things are planned here, and they meet at the berth:

- **Contracts.** A harbour issues work. Every contract is a question about
  the planet rather than a fetch quest: how far round the globe the target
  is, whether it will still be daylight there when you arrive, how much of
  this sea you have charted. Up to three are active at once. A contract is
  accepted at a berth, on a cover screen of its own, and completes or fails
  while you sail.
- **Reputation.** A single signed integer, starting at 0, floored at -100 with
  no ceiling. A finished contract earns at least 10 points and its purse; a
  failed one costs a flat 5 points and no gold. What reputation *buys* is a
  later plan. This one only earns and spends it, shows it, and saves it.
- **The notification strip.** A transient one-line message the game has never
  had. Phase 1 wires it to contracts alone; fish, storms, raiders and
  first visits join later without touching this plan.

## Decisions already made

These were settled with the owner on 2026-09-10 and are not open:

1. **"Driven by day/night" means all four of:** a deadline that is a daylight
   window at the *destination*; contracts that can only be completed in a
   given phase (night-only and day-only); a board that rerolls once per world
   day; and deadlines measured in world days rather than real seconds.
2. **"Map structure" means all four of:** great-circle arc between harbours;
   latitude bands and the two fixed pole harbours; chart completion of the
   current sea; and the known-versus-unknown harbour split
   `knownharbours.ts` already keeps.
3. **The notification strip is built here**, minimal, with contracts as its
   only consumer. It is not deferred to another branch.
4. **An active contract survives a page reload by harbour name.** The world is
   redrawn; the target is re-resolved through `Towns.byName`; the bearing and
   distance change; the clock keeps running.
5. **Contracts are accepted on a cover screen of their own**, opened by its
   own dock button while moored, parallel to `fishcover.ts` and
   `battlecover.ts`. Not a shop tab, not a menu page.
6. **Up to three contracts active at once, of any kind.** Each harbour offers
   three at a time.
7. **Failure costs reputation, not gold and never progress.** No stake is
   paid on acceptance. A deadline that passes costs 5 reputation points, flat.
   Completion earns 10 points or more by difficulty, and the purse.
8. **Phase 1 ships the framework and two kinds**: a harbour-to-harbour
   DELIVERY with a world-day deadline and an optional daylight window, and a
   CHART goal for the current sea. The remaining kinds are specified below so
   the framework carries them, and are built in Phase 2.

## Interpretations made by the planner

Open to correction, and each is flagged where it lands in the streams.

1. **A world day is `DAY_LENGTH` of `env.elapsed`**, 1200 s. A deadline of
   "one day" is 1200 world seconds regardless of where the ship sails. The
   *local* day stretches for a ship running west and compresses running east,
   and that is the mechanic, not a bug: a player who understands the planet
   reaches a daylight window that a player who does not would miss. The
   deadline clock itself does not stretch.
2. **The clock stops when the world stops.** `env.elapsed` is only advanced by
   `daynight.update`, which does not run under the fishing card, the battle or
   the menu. A contract's remaining time is therefore measured in world
   seconds and pauses with everything else. Nothing here introduces a
   wall-clock timer.
3. **"Daylight at the destination" is `solarPhase(town.dir, env.sunDirection).isDay`**,
   the same test the dial uses, so the strip and the dial never disagree. A
   harbour's remaining daylight is `(1 - progress) * DAY_LENGTH * dayShare`
   from the same `SolarPhase`, and the offer card prints it.
4. **A CHART goal is dropped without penalty on reload.** The chart is wiped
   with the world (`save.ts`, `CHART_KEY`), so the sea the contract named no
   longer exists. Decision 4 is about *harbour* contracts, which have a name
   to re-resolve; a chart goal has nothing to resolve. Flagged for the owner.
5. **Offers are deterministic, not saved.** A harbour's three offers are drawn
   from `(questSeed, harbourName, worldDay)` against the *current* world's
   geometry, so reopening the board within the same day shows the same three
   and the board rerolls at the day boundary (decision 1) with nothing
   written to disk. A reload mid-day redraws the world and therefore the
   offers; that is consistent with the sea being new.
6. **Completion is `energy.state.mode === 'docked'` at the target's berth**,
   the project's one definition of moored (`knownharbours.ts`). Sighting the
   harbour or crossing its zone does not deliver.
7. **Rewards sit beside the bounty table, below it.** `bounty.ts` pays 500 to
   20 000 for a fight. A near delivery pays in the low hundreds, a far one
   around a thousand, an antipodal one a few thousand. Contracts are the
   steady income; fights stay the jackpot.
8. **Reputation is shown on the cover screen and in the strip only.** The
   HUD gets one contract line, not a reputation readout, because the points
   have no influence yet (decision 7) and a number with no consequence on
   the HUD is noise.

## Units

- Arc between two harbours: `Math.acos(a.dir.dot(b.dir))`, radians; times
  `GLOBE_RADIUS` (200) for world units, times `180/PI` for degrees.
  The antipode is PI, 628 units, 180 degrees.
- Time: world seconds of `env.elapsed`. One world day is `DAY_LENGTH`, 1200.
  The HUD prints remaining time as `M:SS` of world time.
- Ship: ~10.5 units/s cruising (roadmap), 90 s of tank at 15 kn
  (`energy.ts`, `FULL_SPEED_ENDURANCE`), so one tank is about one lap.
- Chart coverage: fraction in [0, 1] of the globe's *area* that is
  discovered. The chart is an equirectangular texel grid, so each texel row is
  weighted by the cosine of its latitude. Unweighted, the poles would count
  ten times their area.
- Gold: integers. Reputation: integers, floor -100, no ceiling.

## Why this shape, and the four traps

**One sim, three views.** `quests.ts` owns every rule: generation, acceptance,
the per-frame check, completion, failure, the reward. The cover screen, the
HUD line, the menu page and the strip are views that read it or listen to it.
None of them decides anything. This is the `energy.ts` to `hud.ts` split the
codebase already has, and it is what keeps a contract testable under node
with no DOM.

**Four traps.**

1. *A real-seconds clock.* `setTimeout`, `performance.now()` or `Date` anywhere
   in `quests.ts` breaks the pause contract: a contract would expire under the
   fishing card. Every deadline is in `env.elapsed`. Tests pass `elapsed` in.
2. *Completing on a frame loop.* `check` runs every frame while docked, like
   `knownHarbours.add`. It must be idempotent: a contract completes once,
   pays once, writes the save once. The store transitions state *before* it
   fires listeners, so a listener that reads back sees the new state.
3. *A fail state by the back door.* A failed contract costs 5 reputation and
   nothing else. It does not dock gold, does not cancel the other two, does
   not lock the board. The roadmap's rule is "failure costs gold, never
   progress"; the owner tightened it to reputation, never gold. Hold it.
4. *Unreachable offers.* A harbour never offers itself, never offers a
   daylight window that is already closed at issue time, and never offers a
   night-only delivery to a harbour in permanent day (there is none at zero
   tilt, but the check stays for when the tilt returns). `generate` filters
   before it draws, and a harbour with fewer than three legal targets offers
   fewer than three.

## Step 0: the contract (orchestrator, before any stream starts)

Types, constants and stubs that every stream imports. Complete in Step 0 so
the streams never edit each other's files.

### `src/types.ts`

```ts
export type QuestKind = 'DELIVERY' | 'CHART' | 'EXPEDITION' | 'SURVEY';

/** When a DELIVERY may complete. 'ANY' is the default. */
export type QuestWindow = 'ANY' | 'DAYLIGHT' | 'NIGHT';

export type QuestTier = 1 | 2 | 3;

export interface QuestOffer {
  /** Stable within one world day at one harbour; see `quests.ts` on the draw. */
  readonly id: string;
  readonly kind: QuestKind;
  readonly tier: QuestTier;
  /** Harbour name that issued it. */
  readonly issuer: string;
  /** Harbour name to reach. Null for CHART. */
  readonly target: string | null;
  readonly window: QuestWindow;
  /** World seconds allowed from acceptance. Null for CHART, which has no deadline. */
  readonly duration: number | null;
  /** CHART: coverage fraction to reach. Null otherwise. */
  readonly coverage: number | null;
  readonly gold: number;
  readonly reputation: number;
  /** One line for the card and the menu page, already formatted. */
  readonly brief: string;
}

export interface ActiveQuest extends QuestOffer {
  /** World seconds remaining, or null for a goal with no deadline. Saved. */
  remaining: number | null;
}

export type QuestEvent =
  | { kind: 'accepted'; quest: ActiveQuest }
  | { kind: 'completed'; quest: ActiveQuest; gold: number; reputation: number }
  | { kind: 'failed'; quest: ActiveQuest; reputation: number }
  | { kind: 'progress'; quest: ActiveQuest; fraction: number };
```

`EXPEDITION` (reach a pole harbour and return to the issuer) and `SURVEY`
(moor at a harbour you have never moored at) are Phase 2. They are in the
union now so the save loader accepts them and the HUD formatter has a branch,
and `generate` simply never draws them until Phase 2 turns them on.

### `src/questconstants.ts` (complete in Step 0, never a stub)

```ts
export const MAX_ACTIVE = 3;
export const OFFERS_PER_HARBOUR = 3;

/** Arc thresholds in radians. Tier 1 below NEAR, tier 3 at or above FAR. */
export const ARC_NEAR = Math.PI / 3;   //  60 deg, 209 units
export const ARC_FAR = 2 * Math.PI / 3; // 120 deg, 419 units

/** World seconds allowed per tier, as fractions of DAY_LENGTH. */
export const DELIVERY_DAYS: readonly number[] = [0.25, 0.5, 1.0];
/** Multiplier on the deadline when a DAYLIGHT or NIGHT window is attached. */
export const WINDOW_SLACK = 0.75;

export const DELIVERY_GOLD: readonly [number, number][] = [[300, 600], [800, 1500], [2000, 3500]];
export const WINDOW_GOLD_BONUS = 1.5;

export const CHART_TARGETS: readonly number[] = [0.10, 0.20, 0.35];
export const CHART_GOLD: readonly number[] = [400, 1000, 2500];

export const REPUTATION_BY_TIER: readonly number[] = [10, 20, 40];
export const REPUTATION_WINDOW_BONUS = 5;
export const REPUTATION_FAIL = 5;
export const REPUTATION_FLOOR = -100;

/** Seconds the strip holds one message, and how many it queues. World seconds. */
export const TOAST_HOLD = 4;
export const TOAST_QUEUE = 4;
```

Every number above is a first guess and says so. Tuning happens with the
`?quest=` dev query below, not in this document.

### `src/reputation.ts` (complete in Step 0)

A store on the `wallet.ts` pattern: `points`, `award(n)`, `penalise(n)`,
`onChange(fn)`, floor applied in `penalise`. Forty lines including the
comment on why the floor is -100 and there is no ceiling (owner's decision;
the influence system comes later and may want headroom).

### `src/quests.ts` (stub)

Exports `createQuests(deps): Quests` with the interface below and a body that
returns empty offers, accepts nothing, and never fires. Stream A fills it.

```ts
export interface QuestsDeps {
  readonly towns: () => Towns | null;      // null before the world exists
  readonly known: KnownHarbours;
  readonly chart: () => Chart | null;
  readonly wallet: Wallet;
  readonly reputation: Reputation;
  readonly seed: number;                   // questSeed from the save
}

export interface Quests {
  readonly active: readonly ActiveQuest[];
  /** The board at `harbour` for world day `day`, filtered to what is legal now. */
  offers(harbour: string, day: number): readonly QuestOffer[];
  /** False if the slots are full or the offer is no longer legal. */
  accept(offer: QuestOffer): boolean;
  /** Once per frame. `berth` is the moored harbour's name or null. */
  update(dt: number, elapsed: number, sunDirection: Vector3, berth: string | null): void;
  on(fn: (event: QuestEvent) => void): void;
  /** For the save. */
  snapshot(): readonly ActiveQuest[];
}
```

### `src/toast.ts` (stub)

`createToast(root: HTMLElement): Toast` with `push(text, severity)` and
`update(dt)`. Stub renders nothing. Stream B fills it.

### Threading, all optional and defaulted

`main.ts` wires nothing in Step 0. `createRecords` in `save.ts` returns two
new stores, `reputation` and `quests` data, seeded from the file with
`questSeed` drawn on first run. Every consumer takes them optionally so the
build is green before any stream lands, on the HARBOURS_PLAN convention.

## Stream A: the sim (`quests.ts`)

### Generation

`offers(harbour, day)` seeds `mulberry32` from `hash(seed, harbour, day)`
(`towns.ts` exports `mulberry32`; the hash is a 32-bit FNV of the string plus
the two integers) and draws `OFFERS_PER_HARBOUR` times from the legal pool:

- Targets are every harbour in `towns().all` except the issuer. Tier is by
  arc from the issuer: `< ARC_NEAR` is 1, `< ARC_FAR` is 2, else 3.
- One of the three slots is always a CHART goal if the chart is below the
  lowest `CHART_TARGETS` entry not yet reached, so a new player always sees
  one contract that needs no navigation.
- Each DELIVERY draws a window: `ANY` with weight 2, `DAYLIGHT` with weight 1,
  `NIGHT` with weight 1. A `DAYLIGHT` window is legal only if the target is
  in daylight *now* or will be before the deadline; the check is
  `solarPhase(target.dir, sunDirection)` plus the terminator's ground speed.
  `NIGHT` symmetric. Trap 4.
- `duration` is `DELIVERY_DAYS[tier-1] * DAY_LENGTH`, times `WINDOW_SLACK`
  when a window is attached. `gold` is uniform in `DELIVERY_GOLD[tier-1]`,
  times `WINDOW_GOLD_BONUS` when a window is attached, rounded to 50.
  `reputation` is `REPUTATION_BY_TIER[tier-1]` plus `REPUTATION_WINDOW_BONUS`
  when a window is attached.
- `brief` is built here and nowhere else, with `formatBearing` and
  `formatDistance` from `menu.ts` for the target's current fix from the
  *issuer*: "Carry mail to IONPORT, 1 day, arrive in daylight".

The same `(seed, harbour, day)` yields the same draw in the same world, so a
test pins a seed and asserts the board (TESTING.md, **The world is random now,
so every test pins it**).

### Acceptance

`accept` refuses when `active.length >= MAX_ACTIVE`, when the same `id` is
already active, or when the offer is no longer legal. On success it pushes
`{...offer, remaining: duration}` and fires `accepted`.

### The per-frame check

`update(dt, elapsed, sunDirection, berth)`:

1. Decrement `remaining` on every timed quest by `dt`. Any that reaches 0
   fails: remove, `reputation.penalise(REPUTATION_FAIL)`, fire `failed`.
   The sim does not know the fishing card exists; it is simply not called
   while the world is frozen (interpretation 2).
2. If `berth !== null`, every DELIVERY whose `target === berth` and whose
   window is satisfied at `berth`'s own direction completes: remove,
   `wallet.add(gold)`, `reputation.award(reputation)`, fire `completed`.
   A DELIVERY at its target with its window *not* satisfied stays active and
   fires nothing; the HUD line says `WAIT FOR DAYLIGHT` (Stream B).
3. Every CHART quest reads `chart().coverage()`. Fire `progress` when the
   fraction crosses a whole 5 percent since the last check; complete when it
   reaches `coverage`.

State is mutated before listeners fire (trap 2). `snapshot()` returns a
frozen copy for `save.ts`.

### The `?quest=` dev query

`?quest=board` logs every harbour's board for today to the console at boot.
`?quest=accept:<harbour>:<n>` accepts offer `n` at `harbour` on boot, so a
Tier 2 test can drive a completion without a second mooring. Read through
`URLSearchParams` on the same terms as `?hull=` and `?battle=`.

### Tests (Tier 1), `tests/quests.test.ts`

A fake `Towns` of four directions (issuer, a near target, a far one, the
antipode) and a fixed sun direction. Assert: tier by arc; determinism of
`offers` across two calls and difference across two days; no self-target; a
closed daylight window is never offered; `accept` refuses a fourth; a timed
quest fails at exactly 0 remaining and penalises 5 once; a delivery at its
target with an unsatisfied window does not complete; a delivery completes
once across 100 frames docked; reputation floors at -100; CHART progress
fires on 5 percent steps.

## Stream B: the strip, the HUD line and the menu page

### `toast.ts`

One `<div class="toasts" id="hud-toasts" role="status" aria-live="polite">`
in `index.html` beside `#hud-moor`, which is the element this copies: a
status line, hidden when empty, coloured by a BEM modifier. `push` queues up
to `TOAST_QUEUE`; `update(dt)` shows the head for `TOAST_HOLD` world seconds
then pops it. World seconds, not a CSS animation on a wall clock, so a toast
raised as the fishing card opens is still there when it closes (trap 1
applied to the view). Severity is `info | good | bad`, three classes in
`style.css` drawn from the hull block's palette so the colour language
matches.

Phase 1 consumers, all from `main.ts`'s `quests.on` listener:
`accepted` → info, `completed` → good with the purse, `failed` → bad,
`progress` → info at each 5 percent.

### The HUD line

One line, `#hud-quest`, under the mooring status: the most urgent active
contract, where urgency is least `remaining` with timed quests before goals.
`hud.ts` gains `questLineText(quest, bearing, distance, phaseOk): string`,
pure and tested like `mooringText`:

```
IONPORT  042°  310 u  0:47
IONPORT  WAIT FOR DAYLIGHT
CHART 20%  14% of 20%
```

Hidden when nothing is active. `main.ts` computes bearing and distance with
the same two lines the HARBOURS page uses (`main.ts:630`).

### The CONTRACTS menu page

A third `Esc` page after Controls and Harbours, on `menu.ts`'s existing
pane pattern and its `HarbourEntry` callback convention: `MenuDeps` gains
`contracts?: () => readonly ContractEntry[]`, where `ContractEntry` is the
brief, the target fix and the remaining time, pre-formatted by the caller.
The page also prints `REPUTATION  12`. It lists active contracts only;
offers live at the berth.

### Tests (Tier 1)

`questLineText` for all three shapes and a hidden case; the toast queue
drops the fifth push and advances on world time only.

## Stream C: the cover screen and the dock button

### `questcover.ts`

On the `fishcover.ts` pattern: one piece of art (reuse a harbour
illustration; no new asset in Phase 1), a heading with the harbour's name and
`REPUTATION n`, three offer cards, and the active list with an ABANDON
button per entry. ABANDON fails the contract on the owner's terms: -5
reputation, no gold, so a player is never stuck with a slot they cannot
clear. Each card shows the brief, the purse, the reputation, the deadline in
world days and, for a window, the target's remaining daylight or night from
interpretation 3. ACCEPT is dimmed with a reason when slots are full,
following `reasonGateWriter` in `hud.ts`.

Deps: `quests`, `reputation`, `currentBerth: () => string | null`,
`worldDay: () => number`. It knows nothing about towns or the sun; every
fact on a card arrives already inside the `QuestOffer`.

### The dock button

`<button id="btn-quests">` labelled `[CONTRACTS]` beside `[SHOP]`, gated
exactly as `[SHOP]` is at `main.ts:1066`: affordance while moored, the
re-test of `energy.state.mode === 'docked'` in the handler. It is added to
the `isOpen` guard list at `main.ts:1037` and its siblings, and to the pause
contract at `main.ts:1363`. The owner chose the separate key knowing the pad
is crowded; the CSS stream keeps it inside the helm columns the v0.20.0 pad
work established.

### Tests

Tier 1: the card's formatter for days (`0.25 day` → `6:00`), a daylight
remainder string. Tier 2: one browser case with `?quest=accept:...` that
moors at the target and asserts the strip shows `COMPLETED`.

## Stream D: the file, the chart and the records

### `save.ts`

Three fields added to version 1, each absent-means-empty, no version bump on
the file's own rules:

```ts
reputation: number;            // integer, clamped to [-100, +inf) on load
questSeed: number;             // uint32, drawn on first run, never changes
quests: readonly ActiveQuest[]; // sanitised entry by entry, bad ones dropped
```

`sanitize` keeps a quest whose `target` names a harbour this build cannot
place (decision 4 and the `knownHarbours` precedent); `quests.ts` re-resolves
by name on every `update` and a quest with no town this world simply cannot
complete until the player reloads into one where it exists. CHART quests are
dropped by the loader (interpretation 4), with a note.

`quests` is written on every `QuestEvent` and on every whole world minute of
`remaining`, the chart's throttle pattern rather than the wallet's every
event one, because `remaining` changes every frame.

### `chart.ts`

`coverage(): number`, cosine-weighted over rows, cached and invalidated by
`reveal`. About twenty lines. The precomputed row weights sum to the
normaliser once at construction.

### `createRecords`

Returns `reputation` and `questsSaved` beside `known` and `stock`; `main.ts`
builds `quests` itself because it needs `globe.towns`, which does not exist
when the records are created.

### Tests (Tier 1)

Round trip of all three fields; a negative reputation below -100 clamps;
`quests` that is not an array is dropped with a note; one bad entry among
three drops one; a CHART entry is dropped; `coverage` of an empty chart is 0,
of a full one is 1, and of one equatorial row is less than one polar row's
naive count would claim.

## Changes to existing modules, by file

| File | Change |
|---|---|
| `types.ts` | Quest types above |
| `save.ts` | Three fields, sanitiser branches, `createRecords` return |
| `chart.ts` | `coverage()` |
| `menu.ts` | CONTRACTS pane, `contracts` dep |
| `hud.ts` | `questLineText`, one writer |
| `index.html` | `#hud-toasts`, `#hud-quest`, `#btn-quests`, CONTRACTS pane markup |
| `style.css` | `.toasts`, `.quest`, the cover screen, the button |
| `main.ts` | Wire everything; see below |
| `docs/ARCHITECTURE.md` | A **Contracts** section and the three new save fields |
| `docs/ROADMAP.md` | Items 2, 4 and USP 5 marked delivered in part |

No module already in `src/` changes behaviour for a player who never presses
`[CONTRACTS]`, except that the strip exists and is empty.

## `main.ts`: the frame loop after integration

In the unfrozen branch, after `energy.update` and `knownHarbours.add`:

```ts
const berth = energy.state.mode === 'docked' ? currentBerthName() : null;
quests.update(dt, env.elapsed, env.sunDirection, berth);
toast.update(dt);
hud.writeQuestLine(...)  // urgent quest, bearing, distance, phaseOk
```

`quests.on` feeds the strip and `persist`. `currentBerthName` is the same
resolution the HUD's berth line already performs. The frozen branch calls
neither `quests.update` nor `toast.update`, which is interpretations 1 and 2
made concrete.

## Constants, collected

All in `questconstants.ts`, listed above. Two derived facts worth pinning in
a comment there: the antipode is 628 units and about 60 s at cruise, so a
tier 3 deadline of one world day is generous by design and the *window* is
what makes it hard; and the terminator moves at 1.05 units/s, so a
`DAYLIGHT` window closes at a rate the ship can outrun westbound by a factor
of ten (roadmap, USP item 3).

## Phase 2, specified but not built

- **EXPEDITION.** Reach `HARBOUR_NAMES[NORTH_POLE_INDEX]` or the south pole
  and moor back at the issuer. Two-stage `ActiveQuest` with a `stage` field;
  tier 3 always; the power-desert at high latitude is the difficulty.
  Depends on the latitude power gradient being *legible* (roadmap USP 2), or
  the player will not know why the tank died.
- **SURVEY.** Moor at a harbour not in `known.names`. The card gives a
  bearing from the issuer so it is a navigation task and not a blind search.
- **Reputation influence.** Owner's call, later. Candidates the framework
  leaves room for: tier 3 offers gated behind positive reputation, shop
  prices scaled, a harbour that refuses a player below -50.
- **Other strip consumers.** Caught fish, storm arriving, raider sighted,
  first visit. Each is one `toast.push` at an event `main.ts` already sees.

## Alternatives considered

| Choice | Taken | Rejected, and why |
|---|---|---|
| Where offers live | Cover screen, own button | Shop tab: cheaper, but a player who never shops never sees a quest. Menu page: breaks the harbour fiction and loses the planning beat at the berth. |
| Offer persistence | Deterministic from seed, name, day | Saved offers: a second array in the file for data that is recomputable, and a stale board after the world is redrawn. |
| Deadline clock | World seconds, frozen with the world | Wall clock: fails under the fishing card and across a closed tab. Real-day stretch per local day: unreadable and unsaveable. |
| Failure cost | 5 reputation, flat | Gold stake: gates early quests behind having gold. Purse penalty: a silent gold drop mid-sail. Nothing: the deadline becomes decoration. |
| Chart goal on reload | Dropped, no penalty | Kept at 0 percent: a goal that quietly restarts reads as a bug. Kept with a new target: invents a rule nobody asked for. |
| Active slots | Three, any kind | One: a passive chart goal blocks a delivery. Typed slots: two HUD lines and a taxonomy to get right on day one. |
