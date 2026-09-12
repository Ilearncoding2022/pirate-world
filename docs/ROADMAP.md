# Roadmap and handoff

Status of the project as of **v0.25.0** (2026-09-11), and what is worth doing
next. This is a handoff document: it assumes you have read `README.md` for what
the game is and `docs/ARCHITECTURE.md` for how it is built, and it exists so
the next person does not have to re-derive which of the obvious improvements
have already been made and which have not.

Every claim below was checked against the code on the day it was written, not
recalled. Where something is absent, the check that proves it absent is named
so you can re-run it rather than trust this file. The two exceptions are
**Where this sits in its genre** and **Commercialisation**, which are readings
of a market rather than of a codebase and say so where they start.

## Where the project stands

| | |
|---|---|
| Version | 0.25.0 |
| Source | 117 TypeScript modules, ~51 300 lines, plus 5 700 lines of CSS |
| Tests | 58 unit files / 657 cases (~5 s), 9 browser cases (~3.4 min) |
| Bundle | 978 KB JS (289 KB gzipped), 52 KB CSS, one chunk |
| Assets | One 5.1 MB glTF hull, four WebP illustrations. Everything else procedural |
| Dependencies | 2 runtime (`three`, `simplex-noise`), 7 dev |

The codebase is unusually healthy in the ways that are easy to measure and
unusually exposed in the ways that are not. There is **not one TODO, FIXME,
HACK or XXX comment** in `src/` — search case-sensitively, or the `C.xxx`
swizzles in the GLSL modules will give you six false hits. The sim half is
densely tested and the architecture document is genuinely authoritative. What is missing is almost entirely
*category* rather than *quality*: no audio, no CI, no linter. **"No goal" came
off that list on 2026-09-10**, when harbour-issued contracts landed
(`docs/QUESTS_PLAN.md` Phase 1). The game still has no win condition and no
failure state, and both of those are choices rather than gaps.

~~Eight unit cases fail on this commit~~ **Fixed before v0.22.0.** This file
recorded eight failures — two in `aiboats.test.ts`, three in `energy-*.test.ts`
and three in `hull-hud.test.ts` — as of v0.19.0. They are gone: `npm test` on
v0.22.0 is green, and the leviathan-hunt branch measured it at 52 files and 581
cases before adding a line of its own. The standing rule the note existed to
carry is unchanged and worth keeping: a red suite is how a second red failure
goes unnoticed, so no branch may leave one behind.

## What v0.19.0 delivered

The harbours release (`docs/HARBOURS_PLAN.md`) closed or partly closed five
items that were on the improvement list before it:

- **A world worth re-entering.** The seed was a hard-coded constant, so every
  player sailed one planet forever. It is now drawn at random on every load,
  measured, and rejected if it is unusable. Gold, the fish book, the stock, the
  hull and **the harbours you have moored at** survive; the chart does not, and
  is keyed to its seed so it cannot be drawn over a coastline that no longer
  exists.
- **Places with identity.** 40 anonymous towns and 440 unmoorable outpost
  lights became **36 named harbours**, each one town + lights + beacon + berth
  under a single name, with two fixed at the poles. The name is the identity:
  it is what the save keys on, so a harbour survives the world it was in.
- **A recurring economy sink.** Hull durability wears with time and weather and
  is knocked down by fights and maelstroms. Repair is free at a berth and 100
  gold per 10% anywhere else.
- **Difficulty that answers back.** A worn hull loses a fight in two
  broadsides and a failing one in a single broadside, which closed
  `docs/SHOP_PLAN.md`'s long-standing per-combatant prerequisite.
- **A navigation aid.** An `Esc` → HARBOURS page listing all 36 by bearing and
  distance, because a remembered harbour beyond the scope's 50-unit range was
  otherwise unfindable.

It did **not** add audio, a goal, a settings menu, CI, or any performance work.
Those were never in its scope.

## What the contracts work delivered

Unreleased as of 2026-09-10, on `claude/game-quests-planning-dtbgoz`.
`docs/QUESTS_PLAN.md` Phase 1, and the authoritative description of it is
**Contracts** in `docs/ARCHITECTURE.md`.

- **A reason to sail somewhere.** Every harbour posts three contracts, redrawn
  once per world day. A delivery names a harbour and a deadline in world days;
  its tier is its great-circle arc from the issuer, in bands at 60 and 120
  degrees. A chart goal asks for a cosine-weighted fraction of the globe.
- **Day and night as a navigation problem.** About half the deliveries carry a
  window that has to be met AT THE DESTINATION — arrive while it is still
  daylight there, or after dark. The terminator crawls at a tenth of the hull's
  speed, so a window cannot be waited out; it has to be sailed to. This is the
  one mechanic here a flat-ocean game could not copy.
- **Reputation.** One signed integer, floored at -100 with no ceiling. A settled
  contract pays it and its purse; a missed or abandoned one costs five. It buys
  nothing yet, deliberately — so that when it does, the history is already
  there.
- **The notification layer.** A one-line transient strip, held for four WORLD
  seconds so a notice cannot run out behind an overlay. Contracts are its only
  consumer so far.
- **`chart.coverage()`.** The fraction of the globe's area discovered, weighted
  by the cosine of each row's latitude and kept as a running total.

It did **not** add audio, CI, a settings menu, a win condition or a failure
state, and it did **not** tune anything: every figure in `questconstants.ts` is
a first guess that has had no playtest.

## Where this sits in its genre

The two sections above say what is built. This one says what is *distinctive*
about it, because the answer changes which of the gaps below are worth closing
first.

**A caution about evidence.** Every other section of this file is checked
against the code and names the check. This one cannot be. It is a reading of a
market, made in September 2026 from store pages and genre roundups, and it has
a shelf life. Treat it as a considered opinion, not as a verified claim.

### The ingredients are common

Every pillar of this game has established competition:

| Pillar | Who already holds it |
|---|---|
| Pirate ship, naval combat | Sea of Thieves, Skull and Bones, AC IV: Black Flag, Windrose |
| Procedural pirate world, upgrade ladders | King of Seas, Sail Forth, Salt, Windward |
| Fuel-limited harbour hopping, run-to-run legacy | Sunless Sea, the closest structural match to "a new sea every time, but your harbours persist" |
| Fishing inside a sailing game | Sea of Thieves, Sail Forth, Dredge |
| Sail and wind simulation | Sailwind, A Painted Ocean |
| Trade, upgrade, duel | Sid Meier's Pirates!, the ancestor of the whole loop |

Asked "is there a pirate game where you sail, fish, fight broadsides and buy
upgrades", the answer is yes, dozens.

### The combination is not

Five things here have few or no neighbours. Each is a consequence of a decision
already made rather than a feature waiting to be built, which is why they are
worth defending.

1. **A genuinely small sphere.** Most sailing games are a flat plane with a
   faked horizon. The handful that use a sphere (Ocean Exploration Simulator,
   A Painted Ocean) use Earth-scale ones, where the sphere is a map-wrapping
   detail. Here `GLOBE_RADIUS` is 200 (`geo.ts:21`) against a 3-unit hull, and
   the curvature is a gameplay fact rather than a rendering one: the visible
   horizon sits 25 degrees below horizontal (`horizon.ts:10`), the terminator
   is somewhere you can be on either side of, and sailing east genuinely
   shortens your day. No other game found does this.
2. **Solar power instead of wind.** Pirate games treat weather as propulsion or
   as scenery. Here it is a power problem: `STORM_SOLAR_CUT = 0.95` and
   `FOG_SOLAR_CUT = 0.5` (`energy.ts:385`). That inversion is unusual, and its
   nearest cousins are survival games rather than pirate ones.
3. **This fidelity in a browser.** Displaced water the hull actually rides,
   per-pixel coastal shading, fog as standing slices, camera-scaled rain.
   WebGL ocean *demos* are everywhere. Finished WebGL ocean *games* are not.
4. **A duel with no helm.** Throttle-only positioning on a closing ring against
   an opponent that reads you two seconds late and telegraphs every shot. That
   is a reading contest wearing naval combat's clothes, and no other pirate
   game found removes steering from a fight on purpose.
5. **A world that is thrown away and a set of harbours that is not.** Sunless
   Sea keeps a legacy across captains. This keeps one across *worlds*: 36 named
   harbours that survive a coastline which no longer exists.

### The risk this creates

The risk is positioning, not competition. Nothing above is a direct competitor;
each overlaps on one axis. But the *surface* of this game reads as another
pirate game, so anyone skimming a feature list files it beside King of Seas and
moves on. The rare parts are invisible in a screenshot.

Two consequences for the work below:

- Anything that makes the planet or the power economy more legible is worth
  more than its size suggests, because it is also the pitch.
- **The name is part of the problem.** "Pirate World" is generic, effectively
  unregistrable as a trademark, and impossible to search for. Renaming is
  cheap now and expensive after a store page exists.

## Strengthening what is unique

Six items, ordered by payoff against effort. Each names what it would cost the
rest of the game, because none of them is free. These interleave with the gap
lists above rather than replacing them; the combined order is in **Suggested
order**.

### 1. Fish that depend on where and when you are

Fishing is currently identical at the equator at noon and at the pole at
midnight. Twenty species across five tiers, and the globe contributes nothing
to which of them you see. Gate spawns on latitude, on water depth (the height
field already knows it) and on day or night.

- **Why it is worth it.** Turns the fish book from a slot machine into a reason
  to sail somewhere specific, which is most of what "no reason to sail
  somewhere" is asking for. Uses data that already exists. No new rendering.
  Makes 36 harbours feel geographically distinct without authoring anything.
- **What it costs.** Grind, if a legendary sits behind water no tank can reach.
  And it is invisible unless the fishing cover screen says what these waters
  hold, which is new UI on `fishcover.ts`.
- **Risk to what already works.** None. Purely additive to `fishsim.ts` and
  `species.ts`.

### 2. Latitude as a power gradient

The seasonal tilt is zeroed, so the sun permanently circles the equator, so
**the poles are already a solar desert and the game has never said so**. At high
latitude `sunElevation` stays near zero, and `charge` with it
(`energy.ts:552`).

Lean into it. Equator: cheap power, safe sailing. High latitude: a power
problem where the Moonglass Array and the backup cells stop being optional. The
two fixed pole harbours, Marine Stronghold and No Man's Land, become
expeditions rather than trivia.

- **Why it is worth it.** A difficulty gradient that falls out of physics
  already simulated, at close to zero implementation cost. It couples both
  unique properties: the shape of the planet decides the energy budget. It also
  gives the shop ladders a purpose beyond larger numbers.
- **What it costs.** Nothing, unless it stays undiscoverable. It needs the power
  panel to name it (`IDLE - LOW SUN` beside the existing ladder) and the day
  dial to make it readable.
- **Risk to what already works.** Low. Do not make the poles mandatory, or an
  expedition becomes a chore.

### 3. Let the player chase the daylight

`daynight.ts:45` states the terminator's ground speed itself,
`2*PI*GLOBE_RADIUS / DAY_LENGTH`, which at 1200 s is **1.05 world units per
second**.
A circumnavigation is about 1257 units and takes about two minutes at 10 knots,
so the ship makes roughly 10.5 units per second. Since v0.25.0 there is always
somewhere to do it: `terrain.ts` guarantees forty units of open ocean along the
equator in every world, and the ship spawns in the middle of it.

**The ship is about ten times faster than the sunset.** It can outrun night.
Almost no game can say that, and this one can only say it because the planet is
small.

Nothing rewards it today, because `charge` is gated on `ship.speed === 0`
(`energy.ts:538`). A small trickle charge under way below some speed threshold,
tuned so a slow westward cruise near dawn is roughly power-neutral, turns the
day dial from an ornament into a navigation instrument and invents a real
strategy: race the terminator west, or stop and let it pass over.

- **Why it is worth it.** The most distinctive mechanic available, and it exists
  purely because of the two properties above. It is a headline, and it gives
  "sailing east shortens your day" a consequence rather than leaving it a
  curiosity.
- **What it costs.** Tuning care. Too generous and the power economy collapses,
  because perpetual westward sailing becomes free travel. Cap it hard: trickle
  only below about half speed, and never more than a fraction of `SOLAR_PEAK`.
- **Risk to what already works.** Real, and the highest on this list.
  `energy.ts` is what every other cost in the game is balanced against. Build it
  behind a URL flag and measure a full session before committing.

### 4. The fight, in the live world — **step 1 and step 2 done**

**Built.** The cut is dropped: `battlescene.ts` owns a `Group` of props in flat
arena coordinates, `main.ts` adds it to the world scene and lays it on the
globe's tangent plane at the ring, and the camera is parented into that group.
The world's clock runs through a fight — cells, wind, weather, hazards and
`globe.update` all tick — so the sun moves and a squall can arrive mid-duel.
The ring is drawn on the sea and shrinks with the sim. `battlering.ts` keeps a
fight off the coast, sampling the disc rather than the rim -- and, since
2026-09-10, it searches the whole planet for water to do it in rather than the
four ring-radii it shipped with. The cap was the bug: measured over 600 water
points within twelve units of a coast on the shipped seed, **29% had no clear
disc within 80 units**, fell through to the fallback, and staged a duelling
circle across a headland with both hulls sailing over a beach. The median
coastal contact has to move 56 units and the worst 168. Nothing is dragged
anywhere -- the ship is returned to the contact point when the fight ends and
both cuts are behind a blackout -- so the distance costs only the backdrop, and
the cover card says so in a line of its own when the fight moves more than a
ring's diameter (`RING_DRIVEN_OFF`). Step 2 came almost
free with it: the sea under the ring IS the world's, so the wind sets the
crests and a storm darkens the water without anything being fed anywhere, and
the arena's own crests are switched off (`LIVE`) in favour of shoves from the
real ones. The quality floor is `main.ts`'s `battleWeather`, capping fog and
rain for the length of a fight.

Still open: **step 3**, replacing flotsam with real debris and only then
considering dropping the ring — and the deletion of `battlewave.ts` and
`battlescene.ts`'s crest meshes, which are switched off but still compiled.
And the frame-rate evidence the staging asks for: the browser tier's battle
case went from 50 s to 66 s under SwiftShader, which is the cost of drawing the
world instead of an empty room on a software rasteriser and says nothing about
a real GPU. Nobody has played it on one yet.


The reason to do this is not realism. It is **continuity**. The distinctive
thing about this game is a small, continuous, always-running planet, and every
modal cut to a separate screen throws that away for its duration. The battle is
the worst offender, because `battlescene.ts` is architecturally forbidden from
touching the real ocean:

> **This is not the globe water.** It must never import `water.ts` or
> `waterpatch.ts`

That is a good engineering decision and a bad product decision, and both are
true at once.

- **Why it is worth it.** Removes the largest continuity break in the game.
  Weather, time of day and sea state become fight inputs for nothing, so the
  weather system pays off twice. Eventually deletes most of `battlesea.ts`,
  `battlewave.ts` and `battlescene.ts` (2 503 lines that exist only to
  re-create a sea the game already has).
- **What it costs.** `battle.ts` is a pure sim in flat arena metres, DOM-free
  and Three-free, and the best-tested part of the codebase; putting it on the
  sphere entangles it with `geo.ts`. Performance, because globe water plus
  displacement patch plus reflection cube plus rain plus two hulls plus balls
  is a much heavier frame than an empty flat sea. Readability, because the
  reason fog is excluded from a fight (a white-out over a 20-unit ring hides
  the target) does not go away, it compounds with night and storm.
- **Risk to what already works.** High if taken in one step. Take it in three:

  1. **Keep the ring, drop the cut.** Render the fight in the world scene at the
     ship's real position, on the real water, under the real sky, with the clock
     still running. The ring becomes a visible constraint drawn on the sea
     rather than a separate place. `battle.ts` keeps its flat arena maths and
     only needs its `x`/`z` mapped onto the tangent plane at the contact point.
     Low risk, most of the payoff.
  2. **Feed the real weather in.** Wind bearing sets crest direction, wind speed
     sets crest height, storm darkens the water. `WeatherState` and `WindState`
     are already carried through the frame loop.
  3. **Replace flotsam with real debris**, and only then consider dropping the
     ring.

  Set a quality floor for step 1 (fog capped, minimum ambient light) so a fight
  is never unreadable. That is a design rule, not a compromise.

### 5. Contracts that are spherical by construction — **partly closed**

**Built, and shaped this way rather than as fetch quests.** A delivery's tier is
its great-circle arc from the issuer, in three bands at 60 and 120 degrees; a
window is satisfied by `solarPhase` at the TARGET, so it cannot be waited out
and has to be sailed to; a chart goal reads a cosine-weighted fraction of the
globe's area, which is what stops it being finishable by circling a pole.

Still unbuilt: "reach a pole and return", which is the `EXPEDITION` kind. It
waits on the latitude power gradient below being legible, or a player will not
know why the tank died.

- **Why it is worth it.** Closes the largest design gap using only systems that
  exist, and does it in a way a flat-ocean game could not copy. Great-circle
  navigation becomes a skill rather than a rendering detail.
- **What it costs.** It needs the notification layer (**Player-facing work**
  item 4) first, or a contract is a silent number change.
- **Risk to what already works.** Low, with one rule: failure costs gold, never
  progress. A timed contract must not import a fail state into a game that has
  deliberately never had one.

### 6. Shareable seeds, and a circumnavigation record

The seed is drawn at random on every load and is unreferenceable afterwards.
`?seed=` already exists as a dev flag, and the chart is already seed-keyed.
Promote it: a shareable world, a daily seed, a best circumnavigation time.

- **Why it is worth it.** The browser is a distribution advantage the premium
  pirate games structurally cannot have, and it is currently spent on nothing.
  "Here is my planet, beat my time" is a link, and a link is a growth loop. The
  two-minute circumnavigation is already the pitch; this makes it a scored
  thing.
- **What it costs.** Nearly nothing to build. It invites cheating, because it is
  all client-side. Accept that: this is a sharing feature, not a ladder.
- **Risk to what already works.** None.

### What not to build

Named here because each is a plausible-sounding idea that would damage the
distinctiveness above:

- **Multiplayer.** Sea of Thieves owns it, it would consume the whole project,
  and it is orthogonal to both unique properties.
- **A trading economy.** The most-copied pirate mechanic there is. It would make
  this look *more* like the crowded shelf, not less.
- **A larger world.** The smallness is the product.


## Player-facing work not yet done

Ordered by how much each would change the experience per unit of effort.

### 1. Audio — the largest single gap

There is none. Not a sound, not a tone, not a music bed. Verified by grepping
`src/`, `index.html` and `public/` for `AudioContext`, `new Audio`, `<audio>`,
`.mp3`, `.ogg`, `.wav`, `GainNode` and `createOscillator`: the only hits are
the substring `audio` inside unrelated words. Every plan document in `docs/`
lists sound as out of scope, which is how it has stayed absent through
nineteen releases.

Wind that rises with the gale, a hull working in a swell, the thruster, the
harpoon, a broadside, thunder tied to the existing `flash` envelope, and a
harbour hum would do more for how the game feels than any remaining visual
item. It fits the project's ethos too: procedural Web Audio needs no asset
pipeline, no files, and no change to the build.

**Where it goes:** a new `audio.ts` owning one `AudioContext`, driven from the
frame loop beside `hud.update`, reading the same `WeatherState`, `WindState`
and `ShipState` everything else does. The pause contract already exists — the
frozen branch is where the bed should duck.

### 2. A reason to sail somewhere — **partly closed**

**Closed by `docs/QUESTS_PLAN.md` Phase 1.** Harbours now post contracts. A
delivery names a harbour, a deadline in world days and, on about half the
postings, a window that has to be met at the DESTINATION — arrive while it is
still daylight there. A chart goal asks for a fraction of the current sea.
Three can be in hand at once, a settled one pays gold and reputation, and a
missed one costs five reputation and nothing else. See **Contracts** in
`docs/ARCHITECTURE.md`.

What is still open: there is no WIN condition and no failure state, which was
deliberate and remains the right call for this game. Two contract kinds are
specified and unbuilt — `EXPEDITION` (reach a pole and return) and `SURVEY`
(moor somewhere you never have) — and reputation is earned and shown but buys
nothing yet. All three are Phase 2 of the same plan.

### 3. Onboarding

A first-time player still gets a loading bar and then the sea. The `Esc` menu
now has two pages (Controls, Harbours), but the Controls page still documents
only the six keys and says nothing about `[FISH]`, `[SHOP]`, `[ANCHOR]` or
`[COIL]`, and nothing anywhere says the scope is the fuel map or that a hull
below 50% is why the ship went slow.

Contextual first-run prompts, shown once and dismissible, are the whole of the
work. There is no tutorial framework to build — `main.ts` already knows every
state a prompt would key on.

### 4. Feedback and notifications — **partly closed**

**The layer exists.** `toast.ts` is a one-line transient strip under the
contract line, held for four WORLD seconds — so a notice raised as the fishing
card opens is still there when it closes — and coloured by severity the way the
hull block is. It was built inside the contracts branch because a notification
layer with no consumer is a design with no feedback.

What is still open is every OTHER consumer. Gold changes outside a contract are
still a silent number swap in the telemetry panel; a caught fish, an arriving
storm, a raider sighting and a harbour first-visit still pass without comment.
Each is now one `toast.push` at an event `main.ts` already sees.

Battle feedback is untouched: still pooled point lights and pips, no hull damage
states, no smoke, no listing.

Battle feedback is still pooled point lights and pips. There are no hull damage
states, no smoke, no listing.

### 5. Settings, pause, and accessibility

- **No settings menu.** Quality is URL-only (`?quality=`), so a player on a
  slow machine has no way to reach it. This is the single most user-hostile
  gap left, and the `Esc` menu now has a working multi-pane pattern to hang it
  on.
- **No real pause.** The world freezes under an overlay, but there is no
  `visibilitychange` handler, so alt-tabbing leaves the game running. Only
  `blur` is handled, and only to release stuck keys.
- **Colour is load-bearing and unaided.** Red versus orange raiders is the most
  important read in the game and is invisible to a deuteranope. A shape or
  glyph difference in `aihulls.ts` and on the scope would fix it.
- **`prefers-reduced-motion` is honoured in exactly one place**, the loading
  bar. Rain, lightning, the flashing power and hull alarms, and the maelstrom
  spin all ignore it.
- All strings are hard-coded English. There is no string table.

### 6. Camera and touch

The chase camera is wheel-zoom only: no orbit, no pan, no look-astern.
Verified: no `requestPointerLock`, no `getGamepads`, and **no pinch gesture**,
which means the nine-times zoom range the game is designed around is
unreachable on a phone.

### 7. Content breadth — **partly closed**

One hull. Two raiders that are the same mesh recoloured. Twenty fish. The
36 harbours now have names and their own upgrade stock, which is the first
identity any location in this game has had.

**There is now something to find.** `docs/SALVAGE_PLAN.md` shipped two
activities on 2026-09-11: rafts of salvage that dirty weather leaves floating
and pay gold and the chandlery's own consumables, and derelict hulls that are
hooked with `Space` and towed to a named harbour at three quarters speed and
double the burn. Both are found on the open sea rather than posted on a board,
both scale with the sky, and neither needed a new world system — they read the
weather, the wind and the berths that were already there.

**The leviathan hunt is the first thing on the water worth going to.** See
`docs/LEVIATHAN_PLAN.md` and **The leviathan hunt** in `docs/ARCHITECTURE.md`.
A shoal of shadows drifts across open water; a timing dial arms only while the
marked one is inside harpoon range and inside the bow's arc, so it is the first
activity in the project played with the actual helm and the first that spends
distance as a great-circle arc rather than as flat metres. It costs no asset:
the shadows are procedurally textured quads, and the animal the feature is named
for is still Phase 2. What it shipped is the rule rather than the experience: a
press produces no harpoon and no splash, the range-and-arc gate is drawn
nowhere, and the sweep resets to `sin(0)` so a tap the frame it arms beats
reading the needle. `docs/LEVIATHAN_PHASE2_PLAN.md` is the brief for fixing
that, and it is planned rather than built.

What is still missing is everything that is not *floating*: no landmarks, no
ruins, no NPCs, nothing on the land at all. The sea now has three reasons to be
sailed through; the coast still has none. And the hunt’s own figures are first
guesses with no playtest behind them — the same caveat this file already
carries for `questconstants.ts`, and now carried twice.

### 8. Shadows

Nothing casts one. The sun crosses the sky for twenty minutes and the world is
lit but unshadowed. `docs/RENDER_PLAN.md` Phase 3 specifies a single
directional shadow map for the hull and near land; it is deferred pending the
owner's sign-off on Phase 2, not blocked.

### 9. The rest of the deferred design

Two documents hold real, costed designs that were never built:

- **`docs/SHOP_PLAN.md` — the Battle tab.** Four items, ~48 700 gold of sink:
  Chain Shot (900), Signal Smoke (1 200), Hull Plating Mk I–III
  (3 000/8 000/18 000), Long Nines Mk I–III (2 500/5 000/10 000). **Its stated
  blocker is now gone** — the per-combatant `hitsToLose` split it was waiting
  on shipped in v0.19.0 — so Hull Plating in particular is close to
  buildable. Signal Smoke is called out in that document as the best-shaped of
  the twelve because it scales with wealth and needs no tuning table.
- **`docs/RENDER_PLAN.md` Phase 3.** Gerstner mid layer, FFT ocean, spray
  sprites, shadow map, ship-local land patch, depth-buffer shoreline.

### 10. The storm no longer brings a fleet — **open question**

A storm is supposed to treble the wandering raiders: `roll` multiplies
`P_ORANGE` by `stormOdds`, which reaches 3 at full weather. It does not do
that any more, and has not since `c3c0093` tripled `P_ORANGE` from 0.24 to
0.72 at the owner's request.

The threshold is not clamped, so full weather tests `rng() < 2.16` and every
roll with no orange alive spawns one. Certainty is the ceiling, so the most a
storm can do is close the gap between 0.72 and 1: measured over 100 minutes of
sim it raises the raider count by **39%, where it used to raise it by 190%**.
Every multiplier above 1.39 is inert, and the weather system cannot tell.

`tests/unit/aiboats.test.ts` pins the 1.39 so this cannot drift further
unnoticed, but pinning it is not deciding it. Three ways out, none costed:

- **Accept it.** 39% is a real difference and the sea is already busy at 0.72.
  The multiplier then wants deleting rather than leaving as decoration.
- **Cut `P_ORANGE` back** and let the multiplier work again, which undoes the
  change that made the empty sea feel populated.
- **Move the storm's effect off the odds.** Raise the population cap or
  shorten `ROLL_PERIOD` under weather instead of multiplying a probability
  that is already near 1 — the only one of the three that gets both a busy
  calm sea and a storm that visibly changes it.

## Technical work not yet done

### 1. No device detection, no frame governor

`quality.ts` resolves to `'high'` for everyone unless a URL parameter or a
stored choice says otherwise, so a phone gets the high row: 24 000 raindrops,
14 fog slices, a 256² reflection cube refreshed two faces a frame, and a 2×
pixel-ratio cap. There is no GPU sniff, no `hardwareConcurrency` check, no
device-pixel-ratio heuristic, and **no dynamic resolution scaling** — the
settings object is `Object.freeze`d, so runtime downgrade is impossible by
construction.

This is the highest-value technical item. It is also entangled with the
settings menu above: detection without a way to override it is worse than
neither.

**Related:** the Backquote timing overlay wraps only `composer.render`, so its
`gpuMs` and draw-call figures **exclude the reflection cube faces and the wake
map** — the two passes most likely to be the problem on a weak machine.

### 2. The 5.1 MB ship

`assets/pirateship_beginner.glb` is 78% of the first-load payload and contains
18 uncompressed PNG textures. There is no Draco, no meshopt, no KTX2, and no
`DRACOLoader`/`KTX2Loader` in `src/`. Running the file through
`gltf-transform` with meshopt and KTX2 and wiring it into an npm script after
`tools/build_ship.py` is a day's work for the largest single win available.

### 3. Startup is synchronous and on the main thread

There is no `Worker` and no `OffscreenCanvas` anywhere in `src/`. The height
map (2048×1024, ~29 M noise evaluations), two flood fills, the town search and
a 2.2-million-vertex land mesh all run on the main thread behind the loading
bar. v0.19.0 made this worse in the tail case, because a rejected world pays
for the data half again — though it never pays for the mesh, and 0 of 270
measured seeds were rejected.

Moving `buildWorldData` into a Worker is now much easier than it was: the split
between data and meshes already exists, was made for the rejection loop, and is
exactly the boundary a Worker needs.

### 4. No CI, no linter, no strict mode

- **No CI of any kind.** No `.github/`, no workflow, no pipeline. Every check
  is manual on one Windows machine.
- **No ESLint, Prettier, Biome, EditorConfig, husky or lint-staged.**
- **`tsconfig.json` has no `strict`**, and no `strictNullChecks` or
  `noImplicitAny` either, so 41 000 lines compile in non-strict mode. It does
  enable `noUnusedLocals`, `noUnusedParameters` and
  `noFallthroughCasesInSwitch`.
- **`tsconfig.test.json` is referenced by no script**, so `tests/` is never
  type-checked. This has already bitten: a test fixture missing three required
  `SaveData` fields compiled happily and only failed at runtime.

A workflow running `tsc`, `vitest`, Playwright and the build would have caught
every mechanical problem in the last release without a human.

### 5. Nowhere to play it

No deploy configuration of any kind: no Pages workflow, no `netlify.toml`, no
`vercel.json`, no Dockerfile, no `manifest.json`, no service worker. **There is
no `vite.config.*` at all**, so the build is entirely Vite defaults — no
`base` path (the emitted `/assets/…` are absolute and would break on a project
page), no manual chunks, no source maps.

There is also **no error reporting and no analytics**, so a crash on someone
else's machine is invisible.

### 6. The bundle is one chunk and three.js is imported whole

23 of 102 modules do `import * as THREE from 'three'`, which defeats
tree-shaking in practice. Everything ships as a single 929 KB chunk (263 KB
gzipped); the only split is the accidental one for the `?probe=` dev harness.
Named imports plus a vendor chunk are a day's work.

### 7. Storage

`chart.ts` base64-encodes ~87 KB into `localStorage` every five seconds on the
main thread while the ship is moving — a guaranteed hitch. IndexedDB is used
nowhere.

The save file is better than it was: v0.19.0 added three fields under the
existing per-field repair convention. But an unknown version still discards
everything, there is still **one slot, no export and no import**, and the ship's
position and the world seed are deliberately not saved.

### 8. Overdraw

`water.ts` sets `renderOrder = -1`, so the most expensive fragment shader in
the scene (up to nine simplex evaluations per pixel for the finite-difference
normal) draws **first** and is then painted over by land wherever land covers
it. Drawing land first, or adding a depth prepass, is a contained change.

The radar's vector layer redraws every frame while the raster beneath it
refreshes at 10 Hz.

### 9. Failure has no handler

`postfx.ts` tests for WebGL2 to decide whether to issue a timer query, but
nothing tests for it at boot. A machine without WebGL2 throws inside the
un-awaited `startGame()` promise and **sits on the splash screen forever** with
no message. There is no `webglcontextlost` handler either.

## Commercialisation

Everything above is about the game. This section is about selling it, and it is
kept separate because almost nothing in it is an engineering problem.

The engineering half of this project is in better shape than most commercial
indie work: 405 unit tests, no TODO comments, an authoritative architecture
document, two runtime dependencies. That is not what blocks a release. What
blocks it is the surrounding layer, which has had no attention at all.

### The open question, before anything else

**The provenance of the art is unknown and unrecorded**, and it is the highest
commercial risk in the repository. The files are
`assets/Illustrations/*.webp` (four cover illustrations) and
`assets/pirateship_beginner.png`, the concept art `tools/build_ship.py` derives
the hull from. Nothing in the repository records where any of them came from;
verified by searching for a licence, credits or attribution file at the root
and in `assets/`, and there is none.

The answer decides whether the rest of this section is worth reading:

- **Authored in-house, or commissioned with a rights assignment.** Fine. Record
  it in `assets/CREDITS.md` so it stays recorded.
- **AI-generated.** Sellable in most jurisdictions, but Steam requires the store
  page to disclose AI-generated content, and the output cannot be claimed as
  copyright in the US. Workable, needs disclosure.
- **Stock library.** Check the licence permits redistribution inside a
  commercial product. Many stock licences do not permit it for art that is
  *primary* to a paid product, which cover illustrations are.
- **Found online.** Stop and replace before doing anything else in this section.

Until this is answered, treat every plan below as conditional.

### Hard blockers

These are not preferences. Each will individually sink a paid release.

| Blocker | Verified state | Why it is fatal |
|---|---|---|
| **No licence, no third-party notices** | No `LICENSE`, `COPYING` or `NOTICE` at the root; `ls` proves it | `three` and `simplex-noise` are MIT, and MIT *requires* shipping the copyright notice. The build currently does not. Trivial to fix, real exposure until it is. |
| **No audio** | **Player-facing work** item 1 | A paid game with no sound reads as an unfinished tech demo. Every review will lead with it. |
| ~~**No goal**~~ **Untuned goal** | **Player-facing work** item 2 | Was the largest gap in the project. Contracts closed it on 2026-09-10: a harbour posts work, a delivery is priced by arc and half of them carry a window that has to be met at the destination. What is not closed is the TUNING — not one of the figures in `questconstants.ts` has been played, and an economy that pays wrong is as commercially fatal as one that pays nothing. `?quest=board` is the cheapest way to look at it. Still no win state and no failure state, which remain choices. |
| **No settings, no pause, no accessibility** | **Player-facing work** item 5 | Storefronts surface accessibility fields now. No remappable keys, no colourblind aid and no volume control is a refund driver, and the red-versus-orange raider read is already documented as invisible to a deuteranope. |
| **Save is one `localStorage` slot, no export, no import** | **Technical work** item 7 | Tolerable when the game is free. For a paid copy, one cache clear destroys a customer's progress and earns a refund and a review. |
| **No CI, no crash reporting, no analytics** | **Technical work** items 4 and 5; `grep -riE 'analytics\|gtag\|plausible\|posthog\|sentry' src/ index.html` returns nothing | Patches to paying customers cannot rest on a manual test run on one machine, and a crash on hardware nobody owns is currently invisible. |
| **Nowhere to play it** | **Technical work** item 5 | There is no deploy configuration and no `vite.config.*`, so the emitted absolute `/assets/…` paths would break on a project page. Nothing can be sold that cannot be served. |

The **name** belongs on this list too, for the reason given under **Where this
sits in its genre**: generic, unregistrable, unsearchable.

### The content depth question

Be honest about session length before pricing anything. A player plausibly sees
everything built today inside 60 to 90 minutes: sail, fish, fight, shop, moor,
repeat. The shop ladders and the twenty-species book stretch that, but they
stretch it by repeating the same four activities.

Rough thresholds:

| Price | Distinct play needed | Standing today |
|---|---|---|
| Free, ad revenue share | No more than exists | Met |
| 3 to 5 | 2 to 4 hours | Close, once there is a goal |
| 10 to 15 | 8 hours or more, plus audio and polish | Not close |

Which of these is the target decides everything downstream, including whether
half the items in this file are worth doing at all.

### Distribution paths

**A. Free on web portals** (CrazyGames, Poki, Newgrounds, itch.io)

- *For.* No porting work: the game is already a browser game with a
  phone-width layout and on-screen touch controls. These portals pay revenue
  share and, more valuably, send traffic. Their audience wants short sessions,
  which the two-minute circumnavigation matches unusually well. Fastest route
  to real feedback, which is needed before pricing anything.
- *Against.* Revenue per player is very low. Portal SDK integration touches
  `save.ts`. Some portals want exclusivity windows. And the 929 KB bundle plus
  the 5.1 MB hull is a bounce problem on traffic measured in seconds, which
  makes **Technical work** items 2 and 6 prerequisites rather than nice to have.

**B. Premium on Steam**, wrapped in Tauri or Electron

- *For.* Where the pirate and sailing audience actually spends money: Sunless
  Sea, Sail Forth and King of Seas all live there. Wishlists give a launch
  signal before the work is committed. Cloud saves, achievements and controller
  support come largely from the platform.
- *Against.* 100 USD Direct fee, 30% cut, and a store page needing a trailer and
  capsule art that do not exist. Requires every hard blocker fixed, plus
  controller support, plus the content depth above. And it discards the browser
  advantage: on Steam this competes on the crowded shelf without the "click a
  link and you are sailing" edge. Wrapping adds a build pipeline, code signing
  and Apple notarisation (99 USD/year), which is a class of problem this project
  does not currently have.

**C. Free web build as the demo, premium desktop build.** The recommended path.

- *For.* Uses the browser build as what it already is: the best demo an indie
  sailing game could have, with no install and no download. The free version
  drives wishlists, which is the metric that decides whether a launch works.
  Portal revenue and premium sales both. And the free version can ship long
  before the paid one is ready.
- *Against.* Two builds to maintain and a decision about what the free one
  withholds. Content-gating a procedural game is awkward: the obvious cut, ten
  harbours free and 36 paid, is unsatisfying. Doubles the QA surface. Risks
  cannibalising sales if the free build is too complete.

**D. Mobile app stores.** Not recommended. The touch controls and phone-width
layout are already there, but store fees, review cycles and discovery are
brutal, and WebView-wrapped WebGL performs poorly on mid-range Android, which
**Technical work** item 1 makes worse.

### The unglamorous layer

All mandatory, all easy to forget:

- A business entity, or at minimum a sole-trader registration, before taking
  money.
- Tax forms. Steam and Apple both require them.
- An age rating. IARC self-assessment covers most storefronts and is free.
- A privacy policy the moment analytics exist, and GDPR consent for EU players.
- Payment and refund handling. Storefronts do this; selling direct from a
  website does not, which is on its own a sufficient argument against it.

### Phasing

**Phase 1, ship it free.** Licence file and third-party notices, rename,
audio, notification layer, a minimum goal (a chart-completion milestone plus
port contracts, both cheap on substrate v0.19.0 already shipped), settings menu
with volume and remapping, save export and import, asset compression, CI, a
deploy target, a portal release.

**Phase 2, measure.** Add analytics. Learn the real session length, where
players quit, and whether anyone completes a circumnavigation. Do not price
anything before this is known.

**Phase 3, decide.** If the free build retains players, build the premium
desktop version against real data. If it does not, nothing has been lost and
the thing that mattered has been learned.

- *For this sequencing.* It front-loads the cheap legal and polish work, buys
  feedback before months are spent on content depth, and defers the expensive
  Steam decision until there is evidence for it.
- *Against.* It delays revenue by months, and a free portal release spends some
  of the novelty a paid launch would otherwise have.


## Suggested order

If the next stretch is one person working alone, this is the sequence with the
best ratio of felt improvement to risk. Each is independently shippable.

It is also, deliberately, **Commercialisation** Phase 1 in build order. The
first eight items are the free portal release; nothing below is included
because it looks good on a store page rather than because it improves the game.

1. **The licence file and third-party notices.** An hour, and the only item
   here that is a legal exposure rather than a gap. `three` and `simplex-noise`
   are MIT and their notices are not currently shipped.
2. **CI, linter and strict mode.** Do this early, not because it is exciting
   but because everything after it is safer and the release ritual currently
   rests on one machine. Half a day.
3. **Audio.** The largest felt change available, no asset pipeline, no
   architectural risk.
4. ~~**The notification layer.**~~ **Done**, inside the contracts work: the
   strip exists and contracts use it. What is left is the other consumers — a
   caught fish, an arriving storm, a raider sighting, a harbour first-visit —
   each one `toast.push` at an event `main.ts` already sees. An hour, and worth
   taking before item 3, because audio and a notice are the same beat.
5. **Settings menu with quality auto-detection.** These are one job: detection
   is only safe once the player can override it. Fixes the worst
   user-hostility left and the worst performance exposure at once. Save export
   and import belongs here too, as the same menu.
6. **Compress the ship and add a deploy target.** Cuts first load by roughly
   four fifths and finally puts the game somewhere other than localhost. A
   prerequisite for any portal release, where bounce is measured in seconds.
7. ~~**Contracts between named harbours**~~ **Phase 1 done.** Deliveries with
   arc tiers and destination daylight windows, chart goals, reputation, the
   board at a berth, a HUD line and a menu page. What is left is Phase 2 of
   `docs/QUESTS_PLAN.md`: the `EXPEDITION` and `SURVEY` kinds, and deciding what
   reputation buys. Neither is a prerequisite for a release — the tuning
   numbers, which have had no playtest, are the real outstanding work, and
   `?quest=board` is how to look at them.
8. **Shareable seeds and a circumnavigation record.** Nearly free, and the
   thing that turns a browser build into a link worth sending.
9. **Fish by latitude, depth and time**, then **latitude as a power
   gradient**. Two cheap changes that make the globe matter, in that order
   because the second needs a power-panel string the first does not.
10. ~~**The fight in the live world, step 1 only**~~ **Steps 1 and 2 done.**
    The ring is kept and drawn, the cut is dropped, and the world's clock runs
    through a fight. Step 3 — real debris, and then whether the ring survives
    at all — still waits, and now so does the one piece of evidence the
    staging actually asked for: a frame-rate reading from real hardware.
11. **The Battle tab** from `SHOP_PLAN.md`, now that its blocker is gone.
12. **World generation in a Worker**, using the split that already exists.
13. **Trickle charge under way**, behind a URL flag and measured over a full
    session before it is allowed near `energy.ts` for real. The highest-payoff
    and highest-risk item in the file, which is why it is last rather than
    first.
14. Everything else, by taste.

**The rename is not on this list because it is not sequenced.** It should
happen before a store page, a portal submission or a trailer exists, and it
gets cheaper the sooner it is done.

## A standing warning

`docs/TESTING.md`'s rule is that **no test asserts on how anything looks**, and
that rule is load-bearing for the suite's speed. The price is that a whole
class of bug reaches `main` with every check green.

v0.19.0 shipped 36 harbour name labels that were built, added to the scene,
marked visible, at full opacity, with a valid texture — and 0.034 **world**
units tall, far below one pixel, because `sizeAttenuation` was described in two
comments and never set. `tsc` passed, 405 unit tests passed, 8 browser tests
passed, and no one had ever seen a label.

**Budget for looking at the game.** `npm run shots` exists for this, and
`?seed=`, `?spawn=`, `?hull=`, `?weather=`, `?hazard=` and `?clock=` exist to
put the thing you changed in front of the camera. A green build proves the game
still runs. It does not prove anyone can see what you built.
