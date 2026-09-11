# Salvage fields and the derelict tow — both built

Status: **built, 2026-09-11.** This is the design for the two activities the
owner chose out of the six put up on 2026-09-10 — items 5 and 6 of that list —
and it is now also the record of what shipped. Every number below is either the
owner's own (quoted as such) or argued from a constant read out of the source;
check a quoted constant before trusting it, because several are documented in
their own files as retunable.

**What it cost, and where it lives.** Six new modules and nine touched ones,
about a thousand lines against a repository of thirty thousand:

| New | What it is |
|---|---|
| `raftmesh.ts` | one pile of timber, drawn the same way in both seas (lifted out of `battlescene.ts`) |
| `salvagebounty.ts` | what a raft carries and what a tow pays — pure tables, `bounty.ts`'s shape |
| `salvage.ts` | the raft sim: the roll, the drift, the life, the take |
| `salvagerafts.ts` | the rafts as scene objects |
| `derelict.ts` | the dead hull, the hook ring and the tow |
| `derelicthull.ts` | the grey clone and the ring on the water |

| Touched | What changed |
|---|---|
| `main.ts` | both sims wired into the frame, the `Space` ladder, `[CAST OFF]`, the settle, the two losses, the dev queries |
| `ship.ts` | the tow's quarter, applied AFTER the worn-hull `min` |
| `energy.ts` | `TOW_BURN_MULTIPLIER`, threaded beside `overdriveActive` |
| `hud.ts` | `towLineText`, the strip's precedence, `[CAST OFF]`'s visibility |
| `radar.ts` | the brass raft diamond and the grey derelict blip |
| `types.ts` | `SalvageRaft`/`SalvageState`, `Derelict`/`DerelictState`, `PropulsionState.towFactor` |
| `battlescene.ts` | the raft's four boxes lifted out into `raftmesh.ts`, unchanged |
| `quality.ts` | the debug hook gains `salvage` and `derelict`, so a headless run waits on the state rather than on a clock |
| `index.html`, `style.css` | `[CAST OFF]` on the helm pad, hidden unless something is on the line, plus two rows on the controls page |

Tests: **48 new cases** — 7 in `salvagebounty`, 15 in `salvage`, 16 in
`derelict`, 10 in `tow` — all in the two-second unit tier, which went from 549
cases to 597 without moving off 4 seconds. The browser tier was run once at the
end, as docs/TESTING.md's budget requires, and a scratch harness drove the
`?salvage=take` and `?derelict=hook` paths in a real browser; between them they
found the two bugs recorded under **What the build changed** below, neither of
which any unit test could have caught.

Read `docs/ARCHITECTURE.md` first, and `docs/HAZARDS_PLAN.md` second: the
salvage roll is deliberately the same shape as the rough-water roll, and a
reader who knows one will recognise the other.

## What the two are, in one sentence each

- **Salvage fields.** A raft of debris drifts on the open sea, rolled for every
  ten seconds, far likelier in dirty weather. Sail into it and it pays gold, and
  once in a while a consumable out of the chandlery's own shelf.
- **The derelict tow.** A dead hull, grey and unlit, drifts where it was
  rolled. Press `Space` inside its ring, exactly as at a berth, and it comes
  onto a towline: a quarter off the top speed, double the burn, all the way to
  the one harbour it is bound for, which pays gold and reputation.

They are one document because they share the roll, the water test, the scope
mark and the notice, and because they are each other's balance: salvage is the
reward that costs nothing but a detour, and the tow is the reward that costs
the power economy for minutes at a stretch.

## Why these two fit

`docs/ROADMAP.md` §"Content breadth" records the gap in one sentence: *"there
is still nothing to find: no wrecks, no landmarks, no ruins, no NPCs."* Both
of these are things to find, and neither needs a single new world system —
the weather, the wind, the raiders' 10-second roll, the berth ring, the tiered
purse, reputation and the hull clone pool all exist and are tuned.

They also keep the two rules §"What not to build" sets. Neither is a trading
economy: salvage is found, not bought and sold, and a tow is paid once at one
harbour. Neither needs a larger world; both make the world that exists busier.

## Decisions taken (owner, 2026-09-11)

Quoted because the reasoning for each belongs with the person who made it, and
because three of the five were the open questions this design could not answer
for itself:

1. **The weather terms SUM.** Rain, storm and fog each add their own share to
   the chance, so being in more than one at once is worth more than being deep
   in any one of them, and the ceiling is reachable. (The share and the cadence
   were retuned by decisions 7 below; the summing is what this decision fixed.)
2. **A raft is taken by sailing into it**, on a contact radius, with no key
   press and no ring. The press is the tow's gesture, not salvage's.
3. **A derelict comes off its own roll on the open sea**, rare, one at a time —
   not off the contract board. A tow is something you come across.
4. **A tow pays gold and reputation at one named harbour**, with **no time
   limit**, and **may be released by hand** at any point.
5. **A tow is lost** — the derelict simply gone — if the tank reaches 0% or a
   maelstrom takes the ship.

Decision 5 is the whole tension of the activity and is why no deadline is
needed. A tow under a doubled burn is a power problem that lasts minutes; the
clock it runs against is the tank, which the player is already reading.

### Second pass, same day: the three numbers that moved

The first draft of this document put salvage at a uniform 100–3000 gold on a
1-second roll reaching 3%, and the tow at half speed. All three were retuned
before any code was written, and each came off arithmetic that is recorded
here rather than in a commit message:

6. **Salvage pays 100–1000, not 100–3000.** Expected value 550 instead of
   1550, which puts a raft under `DELIVERY_GOLD`'s tier 2 band (800–1500) — a
   found bonus, not a substitute for taking work.
7. **Salvage rolls every 10 seconds, not every second**, at 0.5% in clear air
   and +3% per active weather term, capped at 9.5%. The cadence is
   `aiboats.ts`'s `ROLL_PERIOD`, not `hazards.ts`'s, and that is the right
   borrowing: a raft is an ENCOUNTER, like a raider, rather than weather, like
   a wave. The owner's interim proposal of a flat 1% per 10 seconds was
   dropped for one reason — 0.1% a second is arithmetically the old
   clear-weather rate, so a flat rule does not reduce the storm case, it
   deletes it, and decision 1 is the part of this design worth keeping.
8. **A tow cuts the top speed by 25%, not by half.** The burn is quadratic in
   `speed / MAX_FORWARD`, so halving the speed refunds most of the doubling
   and the doubled burn never reaches the panel. See the arithmetic under
   **Towing** below: a quarter off costs 1.54x the fuel per unit distance
   where half off costs 1.11x, and it is the less tedious of the two to play.

## Part 1 — Salvage fields

### The roll

A **10-second** clock — `aiboats.ts`'s `ROLL_PERIOD` and not `hazards.ts`'s,
for the reason decision 7 gives — its own seeded PRNG, and the `ROLL_ORDER`
discipline `hazards.ts` documents: the draw is taken every roll whether it can
be acted on or not, so the stream replays.

    P = min(0.095, 0.005
                 + 0.03 * (weather.rain  > 0.1)
                 + 0.03 * (weather.storm > 0.1)
                 + 0.03 * (weather.fog   > 0.1))

`0.1` is not a new threshold: `main.ts` already calls a cell "met" at
`stormAtShip > 0.1 || fogAtShip > 0.1` for its encounter counter, and using a
second number for the same judgement is how two opinions of the weather start.

The `min` is not doing any work today and is kept deliberately: 0.005 plus
three terms of 0.03 is exactly 0.095, so the ceiling IS the sum. It is there
so that a fourth weather term added later cannot quietly raise the ceiling
without somebody rereading this line.

What that buys, in the only units that matter. The last column is at the
expected value of the gold table below, 550:

| Sky | P per roll | A raft every | Gold per minute |
|---|---|---|---|
| Clear | 0.5% | ~33 minutes | ~17 |
| One term — rain, or fog alone | 3.5% | ~4.8 minutes | ~115 |
| Two — a storm with rain in it | 6.5% | ~2.6 minutes | ~215 |
| Three at once (ceiling) | 9.5% | ~1.8 minutes | ~310 |

That is a **19:1 ratio** between the worst sky and the clearest, which is the
whole point of decision 1: salvage is what dirty weather is FOR. The ceiling
sits under a fishing session's rate and an order of magnitude under the
1900–2800 gold a minute the first draft would have printed — see the balance
note below, which is kept because the arithmetic that rejected those numbers
is the reason to trust these.

**Three live at most** (owner). Suppressed exactly as the hazards and the
raiders are, through `main.ts`'s existing `suppressed()`: no rafts rolled or
collected while moored, in a fight, or behind an overlay.

### Where one appears, and how long it lasts

- **20 to 50 units off**, on any bearing, over water the ship can reach — the
  same reachability test `hazards.pickRespawn` uses, and the same refusal to
  spawn on a lake. 50 is the scope's range (`RADAR_RANGE`), so a raft is never
  rolled outside the instrument that is supposed to find it; 20 keeps one from
  materialising under the bow.
- **Drifts with the wind**, at a fifth of the wind's speed, carried by
  parallel transport like everything else that moves on this globe. A raft is
  flotsam: it has no way of its own.
- **120 seconds of life**, with the 0.5 s fade in and 1 s fade out
  `aiboats.ts` already uses, so nothing pops. 120 s at 10 kn is about 1200
  units of sailing — far enough that a raft on the edge of the scope is always
  worth turning for, short enough that the sea does not silt up with debris.

### Taking one

Contact radius **3.0 units**, against the raiders' `CONTACT_RADIUS = 2.4`. A
little wider because a raft is wider than a hull is: the arena's rafts carry
their own radius around 1.2 (`RAFT_NOMINAL_R`), and 1.5 of hull plus 1.2 of
raft is 2.7 before any mercy is added.

No foul, no slow-down, no penalty. The owner chose contact over a ring, and a
contact pickup that also punishes contact would be asking the player to hit a
thing carefully.

### What one pays

The owner's table, as retuned by decision 6:

- **Gold: uniform over {100, 200, … 1000}**, in hundreds. Ten equally likely
  values, expected value **550**. Every figure is a round hundred, which is
  also `questconstants.ts`'s `GOLD_ROUNDING` argument: a payout of 1337 reads
  as a bug rather than as a sum of money.
- **5% of rafts also carry a consumable**, in addition to the gold. Inside that
  5%: **half are a backup cell** (`BATTERY_CELL`, 50% of a tank); the other
  half is an even draw across the five stocked consumables — five harpoons,
  a Sea Anchor, an Overdrive Coil, a Chum Drum, a Barbed Heads bundle.

Two rules the specification does not cover, proposed here:

- **A full locker does not waste the find.** The item is drawn from the
  lockers that have room; if every one of them is full, the raft pays that
  item's shop price in gold instead. Silently dropping a 1000-gold cell
  because the ship already has two is the kind of loss a player never sees the
  reason for.
- **Two draws, always**, whatever the 5% does, on `bounty.ts`'s own rule: a
  branch that consumes a different number of values from the stream than its
  neighbour is how a seeded run stops replaying.

### Balance note — why these numbers and not the first draft's

Kept as a record, because the arithmetic that rejected the first set is the
only reason to believe the second. Everything here is from constants in the
repo.

The first draft paid a uniform 100–3000 (EV 1550) on a 1-second roll reaching
3%, which is a raft every 33–48 seconds in dirty weather: **1900–2800 gold a
minute**. Set against what the game already pays —

- a won battle is EV ~2800 (`bounty.ts`: "a little under 2,800") and costs 5%
  of the hull, a 10%-of-purse risk, and one to two minutes;
- a delivery contract pays 300–3500 by tier (`DELIVERY_GOLD`) for a passage;
- a fishing session is 30 s and half a tank, and lands mostly tier 1–3 fish at
  4–40 gold each against ten shots — a few hundred gold, and a very good run
  with a legendary in it (250–320) still under a thousand

— one storm of sailing in circles would have out-earned every other activity
in the game put together, against a hull cost of 0.5% a minute for sitting in
that storm. That is a gold printer wearing a weather system's clothes.

As built: EV 550 at 9.5% per 10-second roll is **~310 gold a minute at the
absolute ceiling**, ~17 in clear air. A storm is now worth about a contract
tier's purse per ten minutes of working it, which is a side income rather than
a career, and the weather gradient that makes salvage thematic is intact at
19:1.

Both knobs stay in one exported const each in `salvagebounty.ts` and
`salvage.ts`, so either is a one-line retune in either direction. If the
ceiling ever needs pulling again, pull the per-term 3% rather than the gold:
the gold table is now the figure a player reads on the notice strip, and a
salvage haul that pays 370 would read as a bug.

## Part 2 — The derelict tow

### The roll

The same 10-second clock as salvage, the same discipline, its own odds — rare,
because it is an event that occupies the next minute or two of the player's
sailing:

    P = min(0.03, 0.002
                + 0.01 * (rain > 0.1)
                + 0.01 * (storm > 0.1)
                + 0.01 * (fog > 0.1))

One clock for both, because two sims rolling the same weather on two different
periods is how a tuning change to one silently retunes the other.

0.2% a roll in clear air is a derelict every **~83 minutes** of fair-weather
sailing; 3% at the ceiling is one every **~5.5 minutes** of the worst weather
the globe has. **One at a time, ever**, and none rolled while a tow is already
under way.

It spawns **30 to 60 units off**, matching the red raider's own band, over
reachable water, and drifts with the wind at a fifth of its speed like a raft.
It does **not** expire: a dead hull is a place on the chart until it is hooked
or the world is redrawn. That is the difference between a thing to find and a
thing to catch.

### What it looks like

`ship.cloneHull()` — the same call `aihulls.ts` makes for the two raiders —
with the neon swatches replaced by a dead grey and the planking darkened. Two
deliberate differences from a raider:

- **No wake, no sail fill, no lamp pulse.** `shipfx.ts` is already not run on
  a clone; here that is the point rather than an accepted artefact.
- **A cold, faint rim.** `rimglow.ts` at well under `RIM_STRENGTH`, in a grey
  rather than a colour. A hull with no rim at all is invisible against dark
  water at 40 units, which would make a once-an-hour find a once-an-hour find
  the player never notices; a rim as bright as a raider's would read as a
  third kind of raider.

On the scope: a grey mark, distinct from the raiders' red and orange and from
the magenta the hazards own.

### Hooking it

A ring on the water, and `Space` inside it — the berth's gesture exactly, which
is the owner's call and is also the only press the game has ever used for
"attach to the thing you are lying in". The ring is drawn like a berth's but
in the derelict's grey, and the notice strip carries the offer the way
`mooringText` does.

This needs one change to the `Space` handler in `main.ts` (~line 1710) and it
must be an ordered ladder, not a new listener:

1. the existing guards — no overlay, no menu, no fight, no maelstrom;
2. **a berth ring wins.** If `energy.state.berthReady`, `Space` moors, and
   mooring is also what settles a tow. A player standing in a harbour's ring
   with a derelict on the line means to finish the job;
3. otherwise, if a derelict's ring is offering and nothing is in tow, hook it;
4. otherwise, nothing — as now.

**Release is not on `Space`.** A press that detaches the thing you have towed
across a hemisphere cannot share a key with the most-pressed key on the helm.
It gets `[CAST OFF]` on the helm pad, beside `[ANCHOR]`, and `KeyT` beside it;
both are dead unless a tow is under way. (Flagged below as the one control
decision still open.)

### Towing

- **Position.** The derelict is held at a fixed 6 units dead astern of the
  hull, on the track the ship came along. A spring would be prettier and is
  not worth a new integrator: at 6 units behind a 3-unit hull it reads as a
  towline whatever the sea does, and nothing in the game is allowed to collide
  with it.
- **Speed: a quarter off** (decision 8), so an unmodified hull tows at 7.5 kn.
  The wind is untouched, exactly as the owner specified — a gale can still
  carry a towing ship faster than its own engine could, which is the mercy
  `ship.ts` already grants a worn hull.

  **Where the factor is applied is a real decision, not plumbing.** `ship.ts`
  computes `effMaxForward = min(propulsion.maxForward, hull.speedCap)`, and the
  tow multiplies that RESULT rather than joining the `min`. A tow is a load,
  not a purchase, so `docs/HARBOURS_PLAN.md`'s decision 14 — a worn hull
  overrides the Navigation shelf — does not apply to it: the 25% is a cut a
  player always feels, and a ladder place that let a worn hull absorb it would
  make the tow free in exactly the state it should hurt most. That means a
  `towing` flag (or a `towFactor`) on `PropulsionState`, read by `ship.ts`
  after its own `min`, rather than a smaller number from `main.ts`.

  | Hull | Top speed | Towing |
  |---|---|---|
  | Unmodified | 10 | **7.5** |
  | Trim III | 13 | **9.75** |
  | Below 50%, any Trim | 10 | **7.5** |
  | Below 25%, any Trim | 5 | **3.75** |

- **Burn: doubled**, in `energy.ts`, threaded as a per-frame flag beside
  `overdriveActive`, and normalised against `MAX_FORWARD` as every other
  consumer of that curve is.

**What that actually costs**, from `FULL_SPEED_ENDURANCE = 90`,
`IDLE_ENDURANCE = 42 * 60` and `MAX_FORWARD = 10`. Speed here is world units
per second, which is what makes the README's two-minute circumnavigation of a
1257-unit great circle true:

| | Top speed | Tank per 100 u | vs. flat out | Range, full tank |
|---|---|---|---|---|
| Not towing, flat out | 10.0 | 0.111 | 1.00x | 900 u |
| **Towing (as built)** | 7.5 | 0.171 | **1.54x** | **584 u** |
| Towing at half speed (rejected) | 5.0 | 0.123 | 1.11x | 813 u |

The middle row is the whole argument for decision 8, and it is worth keeping
in front of anyone who later wonders why a tow is not simply slower. **Halving
the speed would have refunded the doubled burn**: the propulsion term goes as
`(speed / MAX_FORWARD)^2`, so half the speed is a quarter of the draw, and
doubling a quarter is a half. A tow at half speed costs 1.11x the fuel per
unit distance — a 25% premium on the trip, which is not a cost a player would
ever notice on the panel, while being twice as long to sit through. A quarter
off costs 1.54x and arrives sooner. It is the better trade on both axes.

The honest limit of it: at 1.54x, the longest tow in the band below costs about
**60% of a full tank**, so decision 5 — an empty tank parts the line — is a
risk a player runs by hooking a derelict while already low, rather than one the
tow creates from full. If that turns out to be too soft, the lever is one line:
normalise the burn's `speedFrac` against the TOWING top speed instead of
`MAX_FORWARD`, so half throttle under tow reads as full throttle to the plant.
That is 2.67x the fuel per unit distance and a 338-unit range, which makes the
tank the thing the whole voyage is planned around. Not built; recorded so the
choice is one number away.

### Where it is bound, and what it pays

The derelict names **one harbour**, drawn at spawn from the 36 at a
great-circle distance of **120 to 350 units** — never the nearest, because a
tow to a berth already on screen is not a voyage, and never the far side of
the planet.

The band is argued from the globe's own scale rather than picked, and an
earlier draft of this document got it wrong twice over. Speed is world units
per second: the hull's 10 kn is 10 u/s, which is what makes the README's
two-minute circumnavigation of a 1257-unit great circle true. Thirty-six
harbours over a sphere of 502 000 square units sit about 118 units apart, so
one harbour spacing is twelve seconds of sailing. A 60-unit tow is therefore
not a voyage at all, and 350 units is under a minute even under tow — the
ceiling is set by the tank rather than by patience. At a 25% speed cut and
double burn (below), 350 units costs about 60% of a full tank, which is the
figure that makes losing a tow to an empty tank a real risk instead of an
impossible one.

Settling is `Space` at that harbour, through the mooring that already exists:

- **Gold**, `WIN_TIERS`-style but narrower — proposed 1200–2500 on the
  distance actually towed, so a 200-unit haul pays about double a 60-unit one;
- **Reputation**, proposed **8**, against a contract's own awards. A rescue
  should be worth more standing than a cargo run and less than a pole survey.
- The notice strip says both, and the derelict fades out alongside.

Moor at the **wrong** harbour and nothing happens: the tow stays on the line,
the notice says where it is bound. No penalty — being in the wrong place is
not a mistake the game needs to punish, it is just the voyage not being over.

### Losing it

The two conditions the owner set, and nothing else:

- **`energy.state.level` reaches 0.** The towline parts, the derelict is gone,
  the notice says so. Note what this composes with: a lost battle zeroes the
  tank (`energy.defeat`), so losing a fight while towing loses the tow too.
  That is the right answer and it is worth a line in the notice.
- **A maelstrom takes the ship.** `onSunk` in `main.ts` already runs the whole
  sequence — 15% of the hull, `energy.wreck()`, the blackout, the respawn — and
  the tow is dropped inside it, before the fade lifts. A hull being carried to
  the far side of the world on the end of a line is not a thing to draw.

Not lost to: a wave, a fight, a raider's ram, fishing, the shop, a squall. The
fight is the interesting one — the world stops where it stands and the player
comes back to the exact spot they were rammed at, so the derelict is still
there when they return, parked where it was.

### The HUD

The tow takes the job strip while it is under way, and contracts resume when
it settles. Justified by the same argument `questLineText` makes for itself —
one line, and what belongs on it is the thing being steered to right now:

    ASHPOINT REACH  042°  136 u  TOW

No clock, because there is no deadline; `questSeverity`'s `goal` colour, for
the same reason. What a tow can actually be lost to is the tank, and the power
panel is already saying that louder than a strip could.

## Open questions

Four, all of them small, none blocking. Defaults are what will be built if
nobody says otherwise.

1. **Does a tow survive a reload?** *Default: no.* The world is redrawn from a
   fresh seed on every load, so a derelict's position is meaningless on the
   other side — the same argument `docs/QUESTS_PLAN.md` interpretation 4 makes
   for dropping a `CHART` goal. The destination is a name and would survive;
   the hull is a place and would not. Dropping it needs no save field at all,
   which is also why it is the default.
2. **`[CAST OFF]` and `KeyT`, or something else?** The helm pad is a T of four
   keys with `[ANCHOR]` and `[COIL]` already hung off it, and a fifth button
   that is dead 99% of the time is clutter. The alternative is a long-press of
   `Space`, which no other control in the game uses and which would have to be
   taught.
3. **Should salvage be suppressed inside a fight's ring?** *Default: yes*, via
   the existing `suppressed()`. A raft collected mid-broadside would be a
   reward for something the player is not doing.
4. **Does towing wear the hull?** *Default: no.* The hull already falls on a
   clock and at double rate in the weather a derelict is likeliest to be found
   in; a third rate would make the panel's `x2` a lie.

## What the build changed

Two numbers moved while this was being built, and both were found by looking at
the game rather than by reading the code — which is the argument docs/TESTING.md
makes for the browser tier existing at all.

1. **A raft floats ABOVE the mean sea radius, not below it.** The plan said
   timber floats in the water rather than on it and put the pile a tenth of a
   unit under the surface. It was invisible: the sea near the ship is genuinely
   displaced rather than shaded to look that way, so anything at or under the
   mean radius spends its life inside the water mesh. It rides a quarter of a
   unit proud now — `ship.ts` clears the same problem with `HULL_OFFSET = 0.6` —
   and reads as awash, which is what was wanted in the first place.
2. **The hook ring went from 3.5 units to 5.** At 3.5 a headless pass at the
   wreck came within 3.65 units and never got an offer. Both hulls are about
   three units long, so centres 3.5 apart are two boats nearly touching: "come
   alongside" had quietly become "ram it". Five leaves a hull length and a half
   of clear water and still sits well inside a berth's 8.

Everything else shipped as specified, including both balance decisions and both
their rejected alternatives, which are pinned in `tests/unit/tow.test.ts` so the
arithmetic that rejected them cannot be lost in a retune.

## Build order

Five phases, each one green and playable before the next. The testing budget
is `docs/TESTING.md`'s: **under five minutes of testing across the whole
job**, which means the unit tier throughout and the browser tier once, at the
end. Nothing here asserts on appearance.

**Phase 0 — the shared raft.** Lift `RAFT_PIECES`, `RAFT_NOMINAL_R` and
`HAZARD_COLOR` out of `battlescene.ts` into a new `raftmesh.ts` with one
`buildRaft()` both callers use. Pure move, no behaviour, no shader text
touched — so the golden tests are the check. *Unit tier only.*

**Phase 1 — `salvagebounty.ts`.** The gold table, the 5% item draw, the
full-locker fallback, the two-draws rule. Pure functions over an injected
`rng`, which is the whole reason it is its own file, mirroring `bounty.ts`.
*New unit file: the EV of the gold table, the 5% rate over a long seeded run,
every item reachable, a full-locker draw paying gold instead.*

**Phase 2 — salvage on the water.** `salvage.ts` (roll, spawn, drift,
contact, life) and `salvagerafts.ts` (the scene side), wired in `main.ts`
between the hazards and the raiders, plus the scope mark and the notice.
*Unit tier: the weather sum and its 9.5% ceiling, the 10-second cadence, the
three-live cap, the stream replaying under a fixed seed, contact at 3.0 and not
at 3.2, suppression.*

**Phase 3 — the derelict, adrift.** `derelict.ts` (roll, spawn, drift, the
ring, the bound harbour) and `derelicthull.ts` (the grey clone), plus the
`Space` ladder and the scope mark. No towing yet: hooking it does nothing but
say it is hooked. *Unit tier: the odds and the one-at-a-time cap, the bound
harbour's distance band, the ring's offer, the ladder's priority with a berth
ring and a derelict ring both live.*

**Phase 4 — the tow.** The 25% speed cut, the doubled burn, the 6-unit follow,
`[CAST OFF]`, the loss rules, the settle at the bound harbour with gold and
reputation, and the job strip. *Unit tier: the cut applied AFTER the
`min(maxForward, speedCap)` and not inside it — the four rows of the table
above are the cases — the burn doubling, settle only at the bound harbour, both
loss conditions, release.*

**Phase 5 — the documents, and one look at it.** `README.md` "The world" gains
a bullet for each; `docs/ARCHITECTURE.md`'s module table gains four rows;
`docs/ROADMAP.md` §"Content breadth" gets its correction. Then `npm run
test:all` once, and the game opened by eye with `?salvage=1` and
`?derelict=1` forcing one of each 3 seconds in — the same dev-query shape
`?hazard=` and `?boat=` already use, and the only affordable way to see a
once-an-hour event. *Browser tier once, here, and nowhere else.*

## What this plan will not do

- **No new weather, water or terrain.** Both activities read the sky and the
  wind; neither writes to them.
- **No save-version bump.** Phase 4's default drops a tow on load precisely so
  that `SaveData` is untouched. If open question 1 flips, it is one optional
  field and `loadSave`'s existing absent-means-zero handling.
- **No contract-board entry for either.** The owner chose the sea roll over
  the board, and a board posting would need the quest kinds, the card, the
  menu page and the deadline the tow does not have.
- **No second gesture for salvage.** Contact, and nothing else.
