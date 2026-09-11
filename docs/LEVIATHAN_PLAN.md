# Leviathan hunt: implementation plan

Status: **built.** `src/` now holds `leviathan.ts`, `leviathanshadows.ts` and
`leviathandial.ts`, with five new types in `types.ts`, a `<!-- HUNT -->` block
in `index.html` and `style.css`, a shoal mark on the scope, the `?hunt=shoal`
dev query and a `window.__pirateWorld.hunt` hook. 32 unit cases in
`tests/unit/leviathan.test.ts`. **The leviathan hunt** in
`docs/ARCHITECTURE.md` is the authoritative description of what was actually
built; this file is kept as the brief it was, plus the list of departures at
the end.

This document is the complete brief for the MVP. An implementing agent should
not need the conversation it came from. Read `docs/ARCHITECTURE.md` first,
especially **Conventions**, **Units, pinned**, **World scale**, **Frame loop**,
**AI boats and the battle** and **The pause contract**; then
`docs/HAZARDS_PLAN.md` for the shape of a Step 0 plus parallel streams in this
repository, and `docs/FISHING_PLAN.md` for the harpoon locker's two budgets.

The roadmap items this addresses are **Player-facing work** item 7 (content
breadth) and the **content depth question** under **Commercialisation**: a
player sees everything built today in 60 to 90 minutes across four activities,
and the price bands in that section turn on whether there is a fifth.

## What this is

A third verb: **pursuit**. A shoal of shadows drifts across open water. One of
them at a time is targetable. Holding a drifting target inside the bow's arc,
at harpoon range, arms a timing dial; the press is worth between 0 and 100
damage. Five targets, then the purse.

The distinctive claim is narrow and worth stating precisely, because a wider
one would be false. **Wind and waves are already unfrozen in a fight**: since
the `battlescene.ts` rework, `weatherCells.update`, `wind.update`,
`weather.update`, `hazards.update` and `globe.update` all run on the battle
branch (`docs/ARCHITECTURE.md`, "The fight happens in the world"). What a fight
does **not** use is the helm (`README.md`: "There is no helm in a fight") and
it does not use curvature, because `battle.ts` computes in flat metres in a
tangent frame pinned at the ring's centre.

So: this is the first activity played **with the actual helm**, and the first
whose distance is a great-circle arc rather than flat metres. That is the whole
of the case for building it.

## Decisions taken

Settled with the owner on 2026-09-11. Do not re-litigate them; if one turns out
to be unworkable, say so and stop rather than substituting another.

1. **No pause, no overlay, no card.** The hunt runs on the **sailing branch** of
   the frame loop. The world does not freeze. This is not a preference, it is
   the feature: an overlay version of this is the fishing card with a different
   bar, and there is no reason to build it.
2. **No new mesh and no glTF.** The shadows are flat sprite planes placed on the
   water through the tangent frame, the same way `aihulls.ts` places a hull.
   The mesh layer is not touched.
3. **The dial is gated on the helm.** It arms only while the targetable shadow
   is inside `HARPOON_RANGE` **and** inside `BOW_ARC` of the bow. The shoal
   drifts and rerolls its heading, so holding a target long enough to read the
   dial is steering. Without this gate the hunt is fishing.
4. **Five targetable shadows, one at a time**, drawn from a larger drifting
   shoal. Five is a ceiling, not a promise: see decision 6.
5. **The harpoon locker is shared with fishing**, `harpoons.ts`. One press is
   one harpoon and there are `HUNT_TARGETS` presses, so a hunt's ceiling is 5,
   which is exactly one `HARPOON_BUNDLE`: one bundle buys one hunt. There is
   deliberately no second "max draw" constant to disagree with the first.
6. **A bad press ends the hunt.** A press worth less than `SOUND_BELOW` damage
   scatters the shoal. Damage banked so far is paid; the remaining targets are
   not offered. Note that `docs/ROADMAP.md` calls the absence of a failure state
   a *choice* rather than a gap, so this is not closing a listed item: it is one
   activity that can be lost, scoped to itself, and it leaves the global "no
   failure state" position exactly where the owner set it.
7. **Gold at `HUNT_GOLD_PER_DAMAGE` = 10, not 50.** See **The purse** for the
   arithmetic against `bounty.ts` and `questconstants.ts`.
8. **No reputation in the MVP.** See **The purse**.
9. **Maelstroms suppress a hunt; raiders do not.** The existing `suppressed()`
   verdict in `main.ts` is reused whole.

## Interpretations made by the planner

Open to correction, and each is flagged where it lands in the streams.

1. **The shoal holds one heading, with a fixed per-shadow jitter offset.** The
   brief said "groups of shadows" change direction. Genuine sub-groups that
   split and rejoin are unreadable at chase-camera distance and unchaseable at
   the helm. One heading plus a per-shadow offset drawn once at spawn reads as a
   loose shoal, costs one vector, and keeps the pursuit legible. Flagged.
2. **Damage is one ramp; the five bands are a colour readout of it, not a rule.**
   `damage = round(100 * (1 - |p|))` where `p` is the dial position in `[-1, 1]`.
   The band edges below are where the colour changes and nothing else reads
   them, so the palette can be retuned without touching the ruleset.
3. **The dial is a sine, and that is load-bearing.** `p = sin(2*PI*t/DIAL_PERIOD)`
   is the same function `fishsim.ts:684` swings the fishing harpoon on. A sine
   lingers near the extremes and crosses the middle fastest, so green is harder
   than its width suggests: a press at a uniformly random moment averages
   `100 * (1 - 2/PI)`, about **36 damage**, not 50. The skill gradient is steeper
   than a linear sweep would give, which is the point.
4. **The dial runs on frame `dt`, not on `env.elapsed`.** It is a test of the
   player's timing, so it must not stretch or compress with the world clock.
   The shoal's clocks use frame `dt` too, for consistency with `aiboats.ts` and
   `hazards.ts`, which are the systems it sits beside. Nothing here reads
   `performance.now()` or `Date`.
5. **A hunt has no energy price of its own.** The fuel cost is the sailing it
   takes to reach a shoal and hold station in it. A charge at the door would
   make it a second fishing session; the pitch's own line was "you've burned the
   fuel for nothing", and that is already true without a meter.
6. **The shoal appears on the scope.** `radar.ts` already draws hazards and
   raiders; one more mark is the whole of the tell, and without it a shoal is
   something a player only ever finds by accident.
7. **No new save field.** Gold already persists and covers the reward. A
   `huntBest` record is named under **Phase 2**.
8. **Shoals spawn in open water only**, away from berths, on `aiboats.ts`'s
   reachable-water logic. A shoal inside a berth ring would fight the moor key;
   see trap 2.

## Units

- Distance: world units. `GLOBE_RADIUS` is 200, the hull is 3 long,
  `RADAR_RANGE` is 50.
- Ship speed: about 10.5 units/s cruising, 16 under an Overdrive Coil
  (`overdrive.ts`, `OVERDRIVE_MAX_FORWARD`).
- Angles: radians in the code, degrees in this document and in comments.
- Time: seconds of frame `dt`, clamped at 0.1 by `main.ts`. Not world seconds.
- Dial position `p`: dimensionless, `[-1, 1]`, 0 at the centre.
- Damage: integers, `[0, 100]` per press, `[0, 500]` per hunt.
- Gold: integers, rounded to `GOLD_ROUNDING` (50) on payout.

## Why this shape, and the four traps

**One sim, two views.** `leviathan.ts` owns every rule: the roll, the drift, the
heading reroll, which shadow is targetable, whether the dial is armed, the
dial's position, the damage, the scatter and the purse.
`leviathanshadows.ts` places sprites from it and `leviathandial.ts` draws a bar
from it. Neither decides anything. This is the `aiboats.ts` to `aihulls.ts`
split the codebase already has, and it is what keeps the hunt testable under
node with no DOM and no `three` scene.

**Cut from `aiboats.ts`, not added to it.** `aiboats.ts:30` documents a hard
invariant of at most one live boat per colour, because `aihulls.ts` keeps
exactly one hull clone per colour. A third `AiBoatKind` breaks that pool. The
repository's own precedent is to cut a new module from the nearest one:
`aiboats.ts` was itself cut from `hazards.ts`. Do that again. What carries over
is the geometry discipline, and it carries over for the same reasons:

- **Nothing is kept as a compass bearing.** A shadow is a centre and a tangent,
  carried across its own travel by parallel transport, exactly as `ship.ts`
  carries the bow. `tangentFrame` is built fresh at the point of use and never
  held.
- **The seeded stream is drawn from unconditionally.** A roll takes its number
  whether or not it can act on it, so what happens to be on the water cannot
  reorder the draws behind it.

**Four traps.**

1. *Building it as a card.* Every instinct in this codebase says an activity is
   an overlay over a frozen world, because the other three are. This one is not,
   and an implementer who reaches for `fishcover.ts` as a template has already
   lost the feature. There is no `open()`, no `onOpen`/`onClose` pair, no entry
   in the pause contract's list, and no dimmed backdrop.
2. *The Space key.* Space is already the moor-and-cast-off key inside a berth
   ring, the fire key in a fishing session and the broadside key in a battle.
   The hunt may take it **only while the dial is armed**, and the dial cannot
   arm while `suppressed()` is true (which covers docked) or inside a berth
   ring. Give the key one owner per state and write the ownership down in
   `docs/ARCHITECTURE.md` beside **One owner for the Escape key**.
3. *Reserving harpoons.* `fishing.ts` debits the locker as shots are fired
   rather than reserving them at the start, precisely so a session abandoned
   mid-way cannot swallow harpoons that were never thrown. A hunt that reserved
   five up front would disagree with the card about what a spare is. Call
   `harpoons.spend(1)` on the frame the press fires, and never before.
4. *A wall clock.* `setTimeout`, `performance.now()` or `Date` anywhere in
   `leviathan.ts` puts the dial on a clock the frame loop does not own. Every
   clock here is frame `dt`. Tests pass `dt` in.

## The hunt, end to end

```
sailing branch, suppressed() false
  └─ roll every ROLL_PERIOD: P_SHOAL, at most one shoal live
       └─ shoal spawns SHOAL_SPAWN_MIN..MAX out, in open water, fades in
            ├─ SHOAL_COUNT shadows drift on one heading at SHADOW_SPEED
            ├─ heading rerolls every HEADING_HOLD_MIN..MAX s, up to TURN_MAX
            ├─ one shadow is MARKED (targets 1..HUNT_TARGETS)
            │    └─ marked shadow within HARPOON_RANGE and BOW_ARC?
            │         ├─ no  → dial dark, nothing armed
            │         └─ yes → dial armed, p = sin(2*PI*t/DIAL_PERIOD)
            │              └─ Space → damage = round(100 * (1 - |p|))
            │                   harpoons.spend(1); arrow flies to the shadow
            │                   ├─ damage >= SOUND_BELOW → bank it, mark the next
            │                   │    └─ was that the 5th? → SETTLE
            │                   └─ damage <  SOUND_BELOW → SCATTER
            ├─ player leaves (> DESPAWN_RANGE) or suppressed() goes true → SCATTER
            └─ SCATTER | SETTLE:
                 gold = round50(banked * HUNT_GOLD_PER_DAMAGE)
                 wallet.add(gold); toast the figure; shoal fades out
```

There is no start button and no end screen. The hunt is a thing that happens on
the water while the world runs, and it settles into the notification strip.

## The shadows

### Spawning

One shoal at a time, on `aiboats.ts`'s roll pattern: every `ROLL_PERIOD`
seconds, draw unconditionally, spawn if the draw beats `P_SHOAL` and nothing is
live and `suppressed()` is false.

Spawn distance is `SHOAL_SPAWN_MIN..SHOAL_SPAWN_MAX`, which sits **inside**
`RADAR_RANGE` (50) deliberately: a shoal has to be visible on the scope before
it is visible on the water, so that finding one is navigation rather than luck.
Raiders spawn further out and partly outside the scope (`ORANGE_SPAWN_MIN` 30
to `RED_SPAWN_MAX` 60); a shoal is something you go to, so it is drawn where it
can be gone to.

The centre must be reachable open water off a coast, through the same
`waterBodies` check `aiboats.ts` uses, and no closer than `TOWN_CLEARANCE` to a
berth (trap 2).

### Drift

The shoal holds one unit tangent, carried by parallel transport across its own
travel. Every `HEADING_HOLD_MIN..HEADING_HOLD_MAX` seconds it turns by up to
`TURN_MAX` either side, drawn from the seeded stream.

Each shadow holds a fixed offset in the shoal's local frame, drawn once at
spawn, so the shoal has width and the marked one is not always in the middle.
Shadows do not collide, do not avoid each other, and do not avoid land: a shoal
that reaches a coast scatters, which is one distance check and is cheaper than
a steering behaviour nobody will look at closely.

`SHADOW_SPEED` is well under the hull's cruise, so a shoal can always be caught
on a straight run. The difficulty is the heading reroll, not the speed: a player
who commits to a lead and is wrong has to come round again, and the wide turning
circle `aiboats.ts:194` already relies on does the rest.

### The mark

Exactly one shadow is marked at a time, for `HUNT_TARGETS` targets in sequence.
The mark is drawn differently (brighter edge, and a ring the other shadows do
not have) and is the only one the dial will ever arm against. When a target is
banked, the mark moves to another shadow in the shoal, chosen from the seeded
stream, never the same one twice in a row.

### Drawing them

`leviathanshadows.ts`, a pool of `SHOAL_COUNT` flat planes in one `Group`, the
same arrangement `aihulls.ts` keeps for its two hulls: built lazily, placed
every frame from the sim's state, never recreated.

- Geometry: one shared `PlaneGeometry`, one instance per shadow.
- Placement: `centre * GLOBE_RADIUS + east * x + north * z`, lifted
  `SHADOW_LIFT` above the water so it does not z-fight, rotated flat to the
  local tangent frame and spun to the shoal's heading.
- Material: a procedurally generated radial-gradient texture, dark and
  translucent, built once into a small canvas at module load. No asset file,
  which is the project's ethos and also the whole reason this MVP is cheap.
- Layer: `LAYER_DEFAULT`. A shadow is not reflected; it is a darkening of the
  water, and a reflected one would appear in the sky.
- Envelope: fade in and out on `FADE_IN`/`FADE_OUT` through the material's
  opacity, so a shoal arrives and leaves rather than popping.

**The honest risk.** A translucent dark plane *above* the water is an
approximation of a shape *below* it, and at a grazing chase-camera angle it may
read as a texture artefact rather than as an animal. This cannot be settled by
argument; it has to be looked at. The real fix, if it does not read, is a
darkening term inside the water shader through the existing plugin contract
(`docs/ARCHITECTURE.md`, "The water plugin contract"), which is Phase 2 and is
priced there.

## The dial

### The rule

While armed, `t` advances on frame `dt` and

```
p = sin(2 * PI * t / DIAL_PERIOD)          // [-1, 1]
damage = Math.round(100 * (1 - Math.abs(p)))
```

`t` resets to 0 each time the dial arms, so a player who loses the target and
recovers it gets the sweep from a known start rather than from wherever a
free-running clock happened to be. This is the same reasoning `fishsim.ts` gives
for stopping `swingClock` while the rope is out.

### The readout

The five bands are where the colour changes. Nothing reads them but the painter.

| `abs(p)` | Colour | Damage |
|---|---|---|
| 0.00 to 0.20 | green | 80 to 100 |
| 0.20 to 0.55 | yellow | 45 to 80 |
| 0.55 to 1.00 | red | 0 to 45 |

`SOUND_BELOW` is **25 damage**, which is `abs(p) > 0.75`: the outer quarter of
each red band. A press there scatters the shoal (decision 6). The bar draws that
threshold as a hard notch inside the red, so the consequence is visible before
it is suffered rather than explained afterwards.

### Where it sits

A **fixed HUD position**, bottom centre above the helm pad. Not anchored under
the shadow.

Nothing in `src/` projects world space to screen space today, so an anchored bar
means building a projection and anchor system from scratch. It would also be the
sort of thing every future overlay wants, so it should be its own module rather
than arriving inside a hunt. A fixed bar is arguably better anyway: the player
can read the dial without taking their eye off the water they are steering
through. The anchored version is named under **Phase 2**.

Implementation is DOM, not canvas: a `<div>` with a CSS gradient for the bands
and an absolutely positioned needle moved by `transform: translateX()`. That is
a compositor-only property, it matches `hud.ts`'s write-only style, and it
avoids a second per-frame 2D context beside `radar.ts` and `fishrender.ts`.

## The purse

### Gold

```
gold = round50(banked * HUNT_GOLD_PER_DAMAGE)     // HUNT_GOLD_PER_DAMAGE = 10
```

500 damage is 5,000 gold. Rounded to `GOLD_ROUNDING` for `questconstants.ts`'s
own reason: a figure that reads as a quoted price rather than the output of a
random number generator.

The multiplier is 10 and not 50, and the arithmetic is why:

| Source | Typical | Max | Downside |
|---|---|---|---|
| Fishing session | a few hundred | ~1,500 | half a tank |
| `DELIVERY_GOLD` + window bonus | 450 to 5,250 | 5,250 | 5 reputation |
| `CHART_GOLD` | 400 to 2,500 | 2,500 | none |
| `bounty.ts` `WIN_TIERS` | EV ~2,800 | 20,000 | 10% of the purse on a loss |
| **Hunt at x10** | **1,820 to 4,250** | **5,000** | **the hunt ends on a bad press** |
| Hunt at x50, rejected | 9,100 to 21,250 | 25,000 | none |

At x50 a hunt pays more than a won fight and carries no stake, which makes
every other activity in the game irrelevant the day it ships. At x10 it lands
just above the fight's expected value and level with the best contract, with the
fight keeping the jackpot. `questconstants.ts:130` already holds exactly this
line for contracts and the same argument applies here.

The typical band is computed, not guessed: a press at a uniformly random moment
of a sine averages `100 * (1 - 2/PI)` = 36.3 damage, so a player pressing
blind banks about 182 over five and takes 1,820 gold. A player who has learned
the sweep averages about 85, banks 425, and takes 4,250.

Break-even against a 500-gold `HARPOON_BUNDLE` is 50 total damage, which is
cleared by almost any hunt. That is deliberate. The shop ladders are where gold
is meant to drain (`docs/SHOP_PLAN.md` prices about 48,700 of sink that is not
built yet); a hunt that could leave a player poorer than they started would
just be a reason never to hunt. The real cost is the fuel and the minutes.

### Reputation: none

The proposal was `damage / 10`, topping out at 50 points. `REPUTATION_BY_TIER`
is `[10, 20, 40]` and the best contract in the game, an antipodal delivery with
a window, pays 45. One hunt would beat it.

That is worse than an imbalance. Contracts are currently the only reputation
source, and `reputation.ts:24-30` records that the points are earned before they
buy anything *specifically* so that Phase 2 has a history to gate on. Flooding
the scale before it has a meaning sets the baseline wrong for a system nobody
has designed yet. **The MVP pays gold only.** Reputation joins when there is
something it buys, and the figure is chosen then against whatever that is.

## Step 0: the contract

Types, constants and stubs that every stream imports. Complete in Step 0 so no
two streams edit the same file. `npm run build` and `npm test` must be green
before any stream starts, and stay green for every one of them.

**The baseline is green, and keep it that way.** `npm test` on v0.22.0 is 51
files and 549 cases, all passing, verified on 2026-09-11. `docs/ROADMAP.md`
still records eight failures including two in `aiboats.test.ts`; that note is
stale and was written at v0.19.0. Correct it there while you are in the file.
A red suite is how a ninth red failure goes unnoticed, so every stream keeps
this one green on every commit.

### `src/types.ts`

```ts
export type HuntPhase = 'idle' | 'drifting' | 'settling';

export interface Shadow {
  /** Unit direction of the shadow's centre. */
  readonly position: Vector3;
  /** Unit tangent: the direction it is travelling. */
  readonly forward: Vector3;
  /** Whether this is the one the dial will arm against. */
  readonly marked: boolean;
  /** Fade in and out, 0..1. Drives the material's opacity. */
  readonly envelope: number;
}

export interface HuntState {
  readonly phase: HuntPhase;
  readonly shadows: readonly Shadow[];
  /** Targets banked so far, 0..HUNT_TARGETS. */
  readonly target: number;
  /** Damage banked so far, 0..500. */
  readonly banked: number;
  /** Whether the dial is armed THIS frame: in range, in arc, not suppressed. */
  readonly armed: boolean;
  /** Dial position in [-1, 1]. Meaningless while `armed` is false. */
  readonly dial: number;
  /** Seconds of spawn suppression left after a hunt settles. */
  readonly grace: number;
}

export type HuntEventKind = 'hit' | 'sounded' | 'settled';

export interface HuntEvent {
  readonly kind: HuntEventKind;
  /** Damage on a 'hit'; the hunt's total on 'sounded' and 'settled'. */
  readonly damage: number;
  /** Gold paid. Zero on a 'hit': the purse settles once, at the end. */
  readonly gold: number;
}
```

### Stub signatures, which are the contract

```ts
createLeviathan(deps): { state; update(dt, ship, suppressed); fire(); reset(); force() }   // A
createShadowField(scene): { update(dt, state); dispose() }                                 // B
createHuntDial(): { update(state); readonly visible: boolean }                             // C
```

`deps` for A is `{ terrain, heightMap, waterBodies, towns, seed?, onEvent }`,
the same shape `AiBoatsDeps` takes, minus `onContact` and plus `onEvent`.

### Tuning constants

All in `leviathan.ts`, on `aiboats.ts`'s precedent: the sim owns its numbers and
`leviathanshadows.ts` imports the handful it needs. No `leviathanconstants.ts`.
`questconstants.ts` exists only because three unrelated modules needed the same
figures, which is not the case here.

Every figure is a first-pass balance number and is expected to move. Each one
carries what the player feels when it changes, the standard `energy.ts` and
`fishsim.ts` hold themselves to. A retune is an edit in this block and nowhere
else.

| Constant | Value | What it is |
|---|---|---|
| `ROLL_PERIOD` | 10 | Seconds between spawn rolls. `aiboats.ts`'s figure, unchanged |
| `P_SHOAL` | 0.06 | Chance per roll. About one shoal every three minutes of open-water sailing |
| `SHOAL_SPAWN_MIN` | 30 | Units. Inside `RADAR_RANGE`, so the scope sees it first |
| `SHOAL_SPAWN_MAX` | 45 | Units |
| `DESPAWN_RANGE` | 70 | Units. Sail past it and it is gone |
| `TOWN_CLEARANCE` | 25 | Units from a berth. Keeps the dial off the moor key |
| `SHOAL_COUNT` | 14 | Shadows drawn. One is marked; the rest are the shoal |
| `SHOAL_RADIUS` | 9 | Units. How wide the shoal sits about its centre |
| `SHADOW_SPEED` | 4 | Units/s. Well under the hull's 10.5, so a shoal is catchable |
| `HEADING_HOLD_MIN` | 5 | Seconds before the shoal may turn. The brief's figure |
| `HEADING_HOLD_MAX` | 10 | Seconds. The brief's figure |
| `TURN_MAX` | 60 | Degrees either side on a reroll |
| `HARPOON_RANGE` | 12 | Units. Four hull lengths: close enough to demand steering |
| `HARPOON_MIN_RANGE` | 5 | Units. Under two hull lengths. Not in the plan; see departure 11 |
| `BOW_ARC` | 30 | Degrees either side of the bow |
| `DIAL_PERIOD` | 2.0 | Seconds for a full sweep. `fishsim.ts`'s swing is 2.4; this is tighter |
| `HUNT_TARGETS` | 5 | Targetable shadows per hunt, and so the harpoons one hunt may take: exactly one `HARPOON_BUNDLE` |
| `SOUND_BELOW` | 25 | Damage under which the shoal scatters |
| `HUNT_GOLD_PER_DAMAGE` | 10 | Gold per point. See **The purse** |
| `FADE_IN` | 0.5 | Seconds. `aiboats.ts`'s figure |
| `FADE_OUT` | 1 | Seconds. `aiboats.ts`'s figure |
| `SPAWN_GRACE` | 30 | Seconds of no rolls after a hunt settles |
| `SHADOW_LIFT` | 0.05 | Units above the water. Z-fighting only |

## Work split

Three agents in parallel in the same working tree, after Step 0. Files are
partitioned so no two agents write the same file. `index.html` and `style.css`
get a marked `<!-- HUNT -->` / `/* HUNT */` block in Step 0 and only agent C
edits inside it, **with Edit, never Write**.

| Agent | Owns | Deliverable |
|---|---|---|
| **A (sim)** | `leviathan.ts`, `tests/unit/leviathan.test.ts` | The roll, spawning, drift, heading reroll, the mark, the range and arc gate, the dial, damage, scatter, settle, the purse figure. No DOM, no `three` scene objects |
| **B (shadows)** | `leviathanshadows.ts`, `radar.ts` (the one mark), `dev/probe.ts` (`?hunt=`), `tests/unit/leviathanshadows.test.ts` | The sprite pool, the procedural texture, the tangent placement, the envelope, the scope mark |
| **C (dial, HUD, wiring)** | `leviathandial.ts`, `index.html` and `style.css` blocks, `main.ts`, `controls.ts`, `docs/ARCHITECTURE.md`, `README.md` | The bar and needle, the Space ownership, the frame-loop call, the wallet and toast wiring, the docs |

C develops against the Step 0 stubs; A's and B's real modules drop in without a
signature change.

**Integration, by the orchestrator.** `npm run build`, `npm test`, then
`npm run test:all` **once**. Then launch a preview and look, per the budget in
`docs/TESTING.md`:

- `?hunt=shoal` puts a shoal ahead of the bow. The shadows drift, the scope
  shows the mark, the dial arms as the bow comes round and goes dark as the
  shoal drifts out of the arc.
- A green press pays, a red press below the notch scatters the shoal and the
  strip prints the purse.
- The shadows read as animals under the water at chase-camera distance and in
  a storm. If they do not, say so plainly rather than tuning the opacity until
  the screenshot passes: this is the MVP's one unhedgeable risk and the answer
  changes the plan.
- A green build is not a pass.

## Changes to existing modules, by file

| File | Change |
|---|---|
| `types.ts` | The five types above |
| `main.ts` | Construct `leviathan`, `shadowField`, `huntDial`. One `leviathan.update` in the sailing branch, one `shadowField.update` beside `aiHulls.update`, one `huntDial.update`. The `onEvent` handler pays the wallet and pushes a toast. `?hunt=` dev query |
| `controls.ts` | Nothing, if the dial takes Space through its own `window` listener the way `fishing.ts` does. Preferred: it keeps the key's ownership in one place |
| `radar.ts` | One mark for a live shoal |
| `wallet.ts` | Nothing. `main.ts` calls `add`, beside the battle bounty it already pays at `main.ts:1296`, which keeps "where did that gold come from" answerable in one grep |
| `fishing.ts` | One comment. Its header claims "This is the ONLY place gold is earned", which the battle bounty already contradicts and this makes a third case. Correct it to say what it means: the only place a *catch* pays |
| `harpoons.ts` | Nothing. `spend(1)` already does what is needed |
| `save.ts` | Nothing. See interpretation 7 |
| `docs/ARCHITECTURE.md` | A **The leviathan hunt** section, three module-ownership rows, and a note beside **One owner for the Escape key** on who owns Space in which state |
| `README.md` | One controls row, one paragraph under the world |

## `main.ts`: the frame loop after integration

The sailing branch runs, in order: `energy.update`, the hull, `quests.update`,
`weatherCells.update`, `wind.update`, `weather.update`, `hazards.update`,
`aiBoats.update`, `ship.update`, `aiHulls.update`, `globe.update`,
`wake.update`, `radar.update`.

Two insertions, and one non-insertion:

- **`leviathan.update(dt, ship.state, suppressed())`** goes immediately after
  `aiBoats.update` and before `ship.update`. It reads last frame's `ship.state`
  for the range and arc gate, exactly as `aiBoats.update` does, and it must run
  before `ship.update` so that the frame a press lands is the frame the hull was
  actually pointing where the player saw it pointing.
- **`shadowField.update(dt, leviathan.state)`** goes beside `aiHulls.update`,
  after `ship.update` and before `globe.update`, for `aihulls.ts`'s reason: it
  only places and lights things, and the camera has already been moved.
- **Nothing goes in the frozen branch, and nothing goes in the battle branch**,
  and the two are not the same case.

  An **overlay** simply freezes a hunt with everything else: the frozen branch
  never calls `leviathan.update`, so the shoal is exactly where it was when the
  card closes. That is the pause contract doing its job, and it is the right
  answer: a player who opened the menu should not lose a hunt for it.

  A **fight** must END one, and cannot be left to the same mechanism. The battle
  branch runs the world (`weatherCells`, `wind`, `weather`, `hazards`, `globe`)
  but halts the hull, so a frozen shoal would be the one object on the water not
  living through the fight, and there would be no helm to hunt with in any case.
  `main.ts`'s `onContact` calls `leviathan.scatter()` explicitly.

## Tests

Tier 1, `tests/unit/leviathan.test.ts`, DOM-free and driven by explicit `dt`:

- Over 3,000 seconds of rolls with a stationary ship in open ocean, a shoal
  appears, never two at once, and `grace` suppresses rolls after one settles.
- Every `shadow.position` is unit length every frame, and every
  `shadow.forward` is unit length and tangent (`dot(position, forward)` within
  1e-6 of zero). This is the parallel-transport invariant and it is the one
  thing that silently breaks near a pole.
- A shoal forced at a known bearing: the dial is dark outside `HARPOON_RANGE`,
  dark inside the range but outside `BOW_ARC`, and armed inside both.
- `dial` at `t = 0` is 0 and damage is 100; at `t = DIAL_PERIOD / 4` the
  magnitude is 1 and damage is 0.
- Arming resets `t`: lose the target, recover it, and the sweep starts at 0.
- Five hits at `t = 0` bank 500 and settle once, paying 5,000 gold, with exactly
  five `harpoons.spend(1)` calls.
- A press below `SOUND_BELOW` on target 2 scatters, pays the banked damage only,
  and offers no further targets.
- `suppressed()` true mid-hunt scatters and pays, and no roll fires while it
  holds.
- The seeded stream replays: two sims on the same seed driven by the same `dt`
  sequence produce identical states.

## Alternatives considered

| Choice | Taken | Rejected, and why |
|---|---|---|
| Where it runs | Sailing branch, no pause | An overlay card: far cheaper and reuses `fishrender.ts` properly, but the timing check is then mechanically identical to `fishsim.ts:684` and the third verb is not delivered. Paying for a third activity and receiving a second one |
| What arms the dial | Range plus bow arc | Proximity alone: the helm does nothing and it is fishing again. A free-aim reticle: no projection system exists, and it would fight the on-screen touch controls |
| Rendering the shadows | Sprite planes above the water | A real mesh: the expensive half of the original pitch, and the MVP exists to avoid it. A water-shader darkening term: reads correctly as *under* the surface and is the right answer eventually, but it touches the plugin contract and is Phase 2 |
| Where the dial sits | Fixed HUD position | Anchored under the shadow: better spatially, but needs a world-to-screen projection module that does not exist and should not arrive inside a hunt |
| A bad press | Scatters the shoal, hunt over | Only that target lost: no failure state, and the pitch's own best line was "it sounds and you've burned the fuel for nothing". Nothing at all: the red band becomes decoration |
| Damage curve | One ramp, five bands as readout | Five banded values: a step function the player cannot feel their way along, and five numbers to retune instead of one |
| Gold multiplier | x10 | x50: pays more than a won fight with no stake, and makes the other four activities irrelevant. See **The purse** |
| Reputation | None in the MVP | `damage / 10`: one hunt beats the best contract in the game and sets the scale wrong for a system that has not been designed |
| Harpoon budget | Shared locker, 5 per hunt | A separate hunt locker: a second thing to stock, a second shop row, and it removes the only interesting decision (spend the bundle on fishing or on the hunt) |
| Module shape | New `leviathan.ts` cut from `aiboats.ts` | A third `AiBoatKind`: breaks the one-hull-per-colour invariant `aihulls.ts` depends on |

## What this buys, and what it costs

**Buys**

- The third verb, and the only activity that uses the sphere as a sphere. It is
  the one mechanic in the game a flat-ocean competitor could not copy, which is
  the distinctiveness `docs/ROADMAP.md` says the project should spend on.
- Real movement on the content-depth axis, which is the gate on every price
  band above "free".
- A local failure state, cheaply, in a game that has none. Scoped to the hunt,
  so it does not disturb the owner's standing choice about the game as a whole.
- A use for the locker outside the fishing card, and a genuine decision at the
  chandlery about what a bundle is for.
- No new currency, no new save key, no new shop row, no asset pipeline.

**Costs**

- It is the largest new system since harbours and it moves none of the hard
  blockers: audio, the missing licence and third-party notices, settings and
  accessibility, save export, CI, or somewhere to deploy it. Every one of those
  individually sinks a paid release and this fixes none of them.
- Two untuned economies instead of one. Not a figure in `questconstants.ts` has
  ever been played, and this adds a second table beside it.
- The shadows may not read as animals. That risk cannot be retired by
  argument and is the first thing integration must look at.
- It is the first system to own Space conditionally, which makes an input
  surface that was simple slightly less so.

## Phase 2, specified but not built

Named here so the MVP's shape carries them, and so nobody re-derives them.

1. **The leviathan itself.** The MVP has a shoal and no animal. The ironwhale
   that surfaces, takes three strikes and sounds is the original pitch, and it
   needs the mesh work the MVP exists to defer.
2. **Shadows in the water shader.** A darkening term through the existing plugin
   contract, which reads as under the surface instead of on it.
3. **A world-anchored HUD element.** One `Vector3.project` plus a CSS transform,
   in its own module, so the dial can sit under its target and so every future
   overlay has it.
4. **Reputation**, at a figure chosen against whatever reputation buys by then.
5. **`huntBest` in the save**, one number, no version bump, on `save.ts`'s
   existing grow-a-field path.
6. **A shop row.** Nothing in the MVP is bought. A heavier harpoon head that
   widens the green band is the obvious first item, and `barbedheads.ts` is the
   shape to copy.

## Departures from this plan, as built

Eleven, each with the reason. Nothing else in the document was contradicted.

1. **An overlay freezes a hunt; it does not end one.** The plan said both an
   overlay and a fight end a hunt "through the `suppressed()` path", and that is
   simply not how the loop works: `suppressed()` is never evaluated on the
   frozen branch because `leviathan.update` is not called there at all. Freezing
   is also the better behaviour and the consistent one. A fight is the genuine
   exception and gets an explicit `leviathan.scatter()` in `onContact`. See the
   corrected text under **`main.ts`: the frame loop after integration**.

2. **An empty locker is a fourth arming condition, and a fifth event kind.** The
   plan said one press is one harpoon and did not say what happens with nothing
   in the locker. Deciding it in `fire` would have made the press silently do
   nothing, so the locker is checked in the GATE instead: the bar stays dark and
   a `dry` event puts one line on the strip, once per shoal, naming the
   chandlery. There is no soft-lock, because a fishing session has ten harpoons
   of its own and can always earn the bundle.

3. **`markOffBow` on the debug hook is signed.** Written unsigned first, which
   makes "steer onto the mark" a coin toss for anything driving the game from
   outside. It is signed off the starboard vector rather than off a bearing
   subtraction, so it means the same thing at a pole.

4. **`?hunt=shoal` is a standing mode, and falls back to the compass search.**
   The plan had it lay one shoal at `SHOAL_SPAWN_MIN` off the bow, full stop.
   Two things were wrong with that, and both were found by running it rather
   than by reading it. The point dead ahead is a coin toss near a coast, so it
   now falls back to the ordinary placement instead of laying one on a beach.
   And a forced shoal closes, passes a stationary hull and is past
   `DESPAWN_RANGE` about twenty-five simulated seconds later, which on the
   software rasteriser is most of two minutes: a one-shot laid its shoal during
   the boot and had taken it away before the smoke case looked. It re-lays two
   seconds after every hunt ends while the query is set.

5. **`BERTH_MARGIN` is 25, not `aiboats.ts`'s 4.** The plan listed a
   `TOWN_CLEARANCE` of 25 as its own constant; it is the same idea and it is
   named for what `aiboats.ts` already calls it, so there is one word for one
   thing. The value is the plan's.

6. **No `leviathanconstants.ts`.** The plan already argued for this and the
   build confirmed it: `leviathan.ts` owns its numbers and the two views import
   the handful they need, exactly as `aihulls.ts` imports from `aiboats.ts`.
   `SHADOW_LENGTH`, `SHADOW_WIDTH` and `SHADOW_LIFT` turned out to be purely the
   renderer's and live in `leviathanshadows.ts` instead.

7. **The shadow planes are `frustumCulled = false`.** Not in the plan and not
   optional: Three culls a bare `Mesh` against a bounding sphere computed from
   the geometry at the ORIGIN, and every slot is written a fresh world matrix
   200 units out each frame. `aihulls.ts` never needed this because a `Group`
   carries its children's bounds.

8. **`main.ts` guards the press, not the dial.** Trap 2 assumed the dial's own
   `armed` flag was enough. It is not: `huntDial.update` runs on the sailing
   branch only, so an overlay freezes the bar without clearing the flag and a
   Space aimed at the fishing card reaches `leviathan.fire()` too. The guard is
   `main.ts`'s `fireHarpoon`, carrying the moor key's list verbatim. Found by
   reading the wiring, and **still not covered by a test**: it lives in
   `main.ts`, which has no unit tier, and the smoke case presses Space while
   sailing rather than under a card. Worth a smoke case of its own.

9. **A shoal's whole footprint is cleared at spawn, not just its centre.** Four
   cardinal samples at `SHOAL_RADIUS`. A shadow sits up to nine units off the
   centre and `update` ends a hunt the moment the MARKED one is aground, so a
   centre-only test laid shoals that scattered on the next frame and reached
   the player as a notice about a shoal they never saw. Pinned by a test
   against the real coastline.

10. **A hunt that banked nothing says nothing.** The plan had every ending
    reach the strip. A shoal drifting onto a coast or out of range without ever
    being fired at is one the player either never engaged or deliberately
    sailed past, and the strip is for what they would otherwise miss.

11. **The gate has a floor, `HARPOON_MIN_RANGE`, and needed one to work at
    all.** The plan specified a maximum range and an arc, and that pair is
    UNSATISFIABLE at point blank: the bearing to something the hull is standing
    on swings past ninety degrees, so the arc can never be met. A player's whole
    instinct is to close, so this is the path they take, not an edge case. A
    browser probe steered the ship onto the marked shadow and read `markRange`
    0.18 with `markOffBow` -88.4, having never armed once on the way in. Five
    units. It is the same geometry `aiboats.ts` leans on from the other side,
    and it says something true besides: a harpoon is thrown at water ahead of
    the ship, not at water under it, so overshooting costs a pass. Found only by
    playing it in a browser, which is the argument for the smoke case that found
    it.

One thing the plan flagged as needing the owner's word was built as flagged and
is still open to it: **a press under `SOUND_BELOW` ends the whole hunt** rather
than costing only that target (decision 6). It is the failure state and it is
the sharpest thing in the feature; it is also the single figure most likely to
want softening after a playtest.

## Out of scope

Sound. Any change to the fishing card's behaviour: `fishsim.ts` and
`fishrender.ts` are untouched, and `fishing.ts` gets one comment correction and
nothing else.
Any change to `battle.ts` or the arena. A second shoal. Shoals on inland water.
Difficulty scaling. A hunt in the save file. Multiplayer anything. The mesh.
