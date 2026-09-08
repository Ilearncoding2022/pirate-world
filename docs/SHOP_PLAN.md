# Chandlery stock — twelve items, eight built

Status: **eight of twelve built (2026-09-08); Navigation and Fishing complete,
Battle still proposed.** This document started as a record of a design
conversation (2026-09-07) kept so the reasoning would not have to be
reconstructed. It is kept now as the reasoning for what actually shipped, and
as the reason the four Battle items still have not.

The shop as it actually stands is ten offers across two tabs — Navigation and
Fishing — plus a dev-only gold button behind `?dev`. See `src/shop.ts` for the
panel and the tab split; each item's own file (named throughout this document)
owns its stock cap or tier ladder and the reasoning specific to it. Nothing
under **Battle** below exists in the game; nothing else in this document is
still aspirational.

## What shipped, and the two simplifications made building it

All eight Navigation and Fishing items below are built as specified, with two
deliberate departures from a literal reading of the original design — both
made to avoid touching tuned systems this pass did not need to open, and both
recorded here so they read as decisions rather than as bugs found later.

**Trim & Sheathing raises the hull's own top speed and acceleration
(`ship.ts`'s `PropulsionState.maxForward`, threaded through as an optional
per-frame parameter), but `energy.ts`'s burn curve and `wake.ts`/`wakemap.ts`'s
speed-driven visuals still normalise against the base `MAX_FORWARD` of 10.**
A Trim III hull running flat out at 13 kn therefore burns somewhat more than a
curve rescaled to 13 kn would charge, and its wake saturates a little under
full throttle rather than exactly at it. The extra burn is a strengthening of
the plan's own point about the item — faster is hungrier, not strictly
better — and the wake saturation is cosmetic. Rescaling either curve to a
live top speed would mean threading it through `energy.ts`, `wake.ts` and
`wakemap.ts` as well, which is a larger, separable change if it turns out to
matter.

**Moonglass Array is a pure power-plant mechanic — `energy.ts` adds a tier
fraction of `SOLAR_PEAK` scaled by `env.moonIllumination` whenever the sun's
contribution is zero — with no change to the chase camera.** The plan's own
"standing constraint" below (the camera cannot look up) is therefore still
true and still unaddressed: the item changes what charging at night is worth,
but it does not yet give a player any new way to actually find the moon in
frame. That remains true future work if the array is meant to reward looking
for it rather than merely owning it.

Sea Anchor, Overdrive Coil, Chum Drum, Barbed Heads, Arc-Lamp Rig and the
Efficiency Governor are built as the sections below describe, with no
simplification worth recording beyond what each item's own file already
comments on.

Read `docs/ARCHITECTURE.md` first. The constants quoted below were read out of
the source on the day this was written; check them before trusting a number, as
several are documented as retunable.

## The grammar the shop already follows

Any new offer should fit the shape the original two offers have, because that
shape is load-bearing rather than incidental — and it is the shape all eight
items below were built to:

- **a consumable, with a stock cap and a dim-reason.** `offerWriter` in
  `shop.ts` exists so a dead button always says why it is dead — short of gold,
  cell full, locker full — and every new offer owes the player the same;
- **priced in sessions of fishing.** Both current prices are argued that way in
  their own doc comments, not picked;
- **a decision, not a number going up.** `battery.ts` calls the cell "a
  consumable dressed as a battery… the reason a player thinks twice before
  leaning on it". That sentence is the design.

### The rule that lets durables in without breaking it

The owner asked for durable, upgradeable goods alongside consumables. A durable
that removes the thinking is a dead purchase — bought once, never considered
again — so the organising rule proposed here is:

> **Durables raise ceilings. Consumables remain the thing you spend.**

The second backup cell is the worked example already in the tree: `BATTERY_CELL`
is what a purchase buys and `BATTERY_CAPACITY` is what the ship can hold, and
raising the second does not make the first free. A durable that followed the
same pattern — a cell bay holding three or four — would make every cell purchase
*more* attractive rather than replacing it.

## Navigation — built

| | Item | Effect | Price | Built in |
|---|---|---|---|---|
| C | **SEA ANCHOR** · stows 5 | Kills the ship's way in ~1 s and holds ~3 s | 400 | `seaanchor.ts`, `ship.ts` |
| C | **OVERDRIVE COIL** · stows 3 | 20 s at 16 kn, burning ~4× `FULL_BURN` (≈9% of a tank) | 800 | `overdrive.ts`, `ship.ts`, `energy.ts` |
| D | **TRIM & SHEATHING** Mk I–III | `MAX_FORWARD` 10 → 11 → 12 → 13 | 2 000 / 4 000 / 8 000 | `trim.ts`, `ship.ts` |
| D | **MOONGLASS ARRAY** Mk I–III | Night solar at 8/14/22% of `SOLAR_PEAK`, × `env.moonIllumination` | 3 000 / 6 000 / 12 000 | `moonglass.ts`, `energy.ts` |

**Sea Anchor** is the one to build first: it needs no new plumbing and it is a
*reading* of the AI rather than a stat. Red boats use pure pursuit and never
lead pursuit — see the closing paragraph of `RED_TURN_RATE` in `aiboats.ts` —
so they steer at where the ship **is**. Stopping dead makes the chaser overshoot,
and `PHASE_MIN` of 5 s does not leave it time to come round for a second pass.
The item only works for a player who has understood the chaser, which is why it
is the cheapest thing on the list.

**Trim & Sheathing** tops out at 13 kn deliberately, against the raiders' 15.
Both hulls are faster than the player on purpose — "neither can be outrun in a
straight line, so a player who wants to avoid a fight has to out-TURN one" — and
the whole upgrade path is built to leave that intact. Note `ACCEL = MAX_FORWARD
* DRAG`, so each tier buys acceleration as well, at no extra cost.

**Overdrive Coil** is the one item here that argues with an existing decision
rather than extending it. A sprint that outruns a raider deletes the escape the
turn rate was tuned around. Kept in the list because the owner may want it
anyway; if it is built, the burn is what has to stop it being the default answer
— an escape that costs the fuel to get home is still a decision.

**Moonglass Array** is the item that gives the sky a job. The moon is currently
decoration: `MOON_MONTH_DAYS` of 8 makes the phase cycle legible inside a single
session, and this turns a full moon into a slow trickle home and a new moon into
a crossing the player had better carry a cell for. It also gives a reason to
*look* for the moon, which is worth weighing against the note in
**The chase camera cannot look up** below.

## Fishing — built

Power, not skill, is what limits fishing: `SESSION_COST` is half the main tank
for 30 s. These four are deliberately on four different levers — what appears,
what is landed, how long the window is, and how often it can be opened. Chum
Drum and Barbed Heads are armed on the fishing cover screen (`fishcover.ts`),
never in the chandlery itself — the chandlery only ever sells the stock.

| | Item | Effect | Price | Built in |
|---|---|---|---|---|
| C | **CHUM DRUM** · stows 5 | One session's spawn roll biased toward tier 3+ | 600 | `chumdrum.ts`, `species.ts`, `fishsim.ts`, `fishcover.ts` |
| C | **BARBED HEADS** · stows 5 | One session at ~70% `TENSION_DRAIN` | 700 | `barbedheads.ts`, `fishsim.ts`, `fishcover.ts` |
| D | **ARC-LAMP RIG** Mk I–III | `SESSION_SECONDS` 30 → 36 → 42 → 48 | 2 000 / 4 000 / 8 000 | `arclamp.ts`, `fishsim.ts` |
| D | **EFFICIENCY GOVERNOR** Mk I–III | `SESSION_COST` 0.5 → 0.42 → 0.34 → 0.26 | 2 500 / 5 000 / 9 000 | `governor.ts`, `fishing.ts` |

**Barbed Heads** targets the exact failure mode of the best fish. Tiers 4 and 5
struggle, draining tension at 0.45 and 0.60 a second against a `TENSION_GAIN` of
0.12 a press — 3.8 and 5.0 taps a second to hold — and a fish whose tension
reaches zero is lost outright. Those are the 250–320 gold fish, so this is the
only offer that makes a hard fight winnable rather than skippable.

**Arc-Lamp Rig** is subtler than the number suggests. More time with the same
ten shots does not hand the player more fish; it lets them *decline* the sardine
and wait for the epic. It changes behaviour rather than yield, and it makes the
Chum Drum better rather than redundant.

**Efficiency Governor** is the compounding one, and the reason to price it high:
at Mk III it nearly doubles the sessions in a tank, which is worth more over a
run than any per-session item and would trivialise the backup cell if it were
cheap.

## Battle — still proposed, not built

The one section of this document nothing has been built from. It is blocked on
its own prerequisite below (#1) in a way Navigation and Fishing were not, and
that prerequisite was not taken on in the pass that built the other eight.

Bounty economics, from `bounty.ts`: a win pays about 2 800 in expectation; a
loss costs 10% of the purse with a floor of 500 and a ceiling of 10 000.

| | Item | Effect | Price |
|---|---|---|---|
| C | **CHAIN SHOT** · one battle | `FIRE_COOLDOWN` 1.0 → 0.65 | 900 |
| C | **SIGNAL SMOKE** · stows 3 | Break off mid-fight: no purse share, no `STALEMATE_COST` | 1 200 |
| D | **HULL PLATING** Mk I–III | Player-only `HITS_TO_LOSE` 3 → 4 → 5 → 6 | 3 000 / 8 000 / 18 000 |
| D | **LONG NINES** Mk I–III | Player-only `BALL_SPEED` 22 → 26 → 30 → 34 | 2 500 / 5 000 / 10 000 |

**Signal Smoke** is the best-shaped item of the twelve, because it scales itself
with wealth and needs no table to do it. A player holding 5 000 is risking the
500 floor and will not spend 1 200 to protect it; a player holding 60 000 is
risking 6 000 and obviously will. One price, opposite answers, no tuning.

**Long Nines** is a skill assist rather than damage: a faster ball needs less
lead, so it rewards aim instead of substituting for it. It is also the item most
likely to be built wrongly — see below.

## Three things to settle before building any of this

Two of these three are now settled, in the pass that built Navigation and
Fishing; #1 is the one still standing, and it is the reason Battle is still
just this document.

### 1. Battle durables need per-combatant constants, and one is a trap — STILL OPEN

All four battle constants are shared by both hulls today. `battle.ts` tests
`state.player.hits >= HITS_TO_LOSE` and `state.ai.hits >= HITS_TO_LOSE` against
the same number, sets `c.cooldown = FIRE_COOLDOWN` for either combatant, and
fires both sides' shot at `BALL_SPEED`. Splitting `HITS_TO_LOSE` and
`FIRE_COOLDOWN` into a player value and an AI value is mechanical.

`BALL_SPEED` is not. The AI's own firing solution is derived from it — it
predicts where the player will be after `flight = 2 * state.radius / BALL_SPEED`
— so raising it globally would silently make the **AI better at hitting the
player**. Part of the upgrade would be bought for the opponent. The AI's
prediction has to keep using the AI's own shot speed, and that is the
prerequisite for both Hull Plating and Long Nines.

### 2. A save-version bump would wipe every player — RESOLVED

`save.ts` returns `EMPTY_SAVE` on any `version` mismatch, and `SAVE_VERSION` is
1. Bumping it to carry twelve new stock counts and tier levels would discard
every existing player's gold, fish book, cells and harpoons.

It turned out to be exactly as avoidable as predicted: the eight fields for the
built items (`seaAnchors`, `overdriveCoils`, `chumDrums`, `barbedHeads`,
`trimTier`, `moonglassTier`, `arcLampTier`, `governorTier`) were added to
`SaveData` as absent-means-zero fields, the same way `reserve` and `harpoons`
joined a save format that predated the shop. `SAVE_VERSION` is still 1; an old
save loads with all eight at zero, which is exactly what a player who had
never bought any of them held. See `save.ts`'s own comment on the constant for
the up-to-date list.

### 3. Fourteen offers do not fit the panel — RESOLVED

`.shop__body` was a flat flex column of full-width `.offer` cards, sized for
two. Built as two tabs — NAVIGATION and FISHING, matching the two headings
above — rather than three, since Battle was not built alongside them; a third
tab is the mechanical part of adding one later. `.shop__panel` also gained a
capped height with `.shop__body` scrolling inside it (the Fish Book's own
pattern — see `.fishbook__panel`/`.fishbook__body`), since five offers to a
tab is already taller than the panel was authored for.

## A standing constraint any of this has to live with

### The chase camera cannot look up

Not a shop problem, but it bears on the Moonglass Array as built — see the
simplification recorded near the top of this document — and on anything else
that asks the player to read the sky. The chase camera aims down at the hull:
at the default
zoom the view centre is 22° below local horizontal and, with a 55° vertical FOV,
the top of frame is only **+5.5°** elevation. Zooming out makes it worse — at
full zoom the top of frame is **−2.8°**.

So the sky is only ever visible in a band between the visible limb and that
ceiling. The moon is above the horizon half the time but lands inside the frame
— elevation band, ±42.8° azimuth window, and night — only about **4–6%** of it.
`daynight.ts`'s `START_LOCAL_TIME` comment records the same trap being paid for
once already: the world was moved from a noon opening to a dawn one precisely
because a high sun is off the top of the frame.

Any feature that wants the player to find something in the sky needs the camera
changed first, or it is building on a view that will not show it.
