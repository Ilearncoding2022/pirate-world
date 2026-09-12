# Leviathan hunt phase 2, feel and picture: implementation plan

Status: **Built, except stream F.** Eight of the nine streams have landed and
`npm test` is green at 693 unit cases across 60 files. **Audio is not in yet**
— `audio.ts`, `huntaudio.ts` and the mute row land in their own commit, since
the plan itself notes stream F has no dependency on the hunt at all and can run
at any time. What is still open is at the end of this block, under **What was
not done as briefed**.

This is the brief,
written to the convention at the top of `docs/HAZARDS_PLAN.md`: an implementing
agent should not need the conversation it came from.

What has landed, and what a stream can therefore rely on:

- **The whole type contract.** `Shadow`'s five new fields, `HuntState`'s
  fourteen, `HuntCue`, `HuntGate`, `HuntEnding`, `HuntBand`, and `ending` on
  `HuntEvent`. Nothing below writes these after Step 0.
- **`huntsweep.ts`, real rather than stubbed.** The needle starts at the red
  edge, `ARM_UP` refuses a press while it charges, `rateFor` ties the rate to
  `centring` and the level, and the purse and `LEVEL_MULTIPLIER` live beside
  each other. Items 3, 4 and the purse half of 5 are therefore DONE, because
  they are what the MVP's existing tests contradicted and the contradiction had
  to be resolved before any stream could be green.
- **`anchor.ts`, real rather than stubbed**, with its own tests. Stream D
  inherits a working projection rather than building one.
- **The sim's side of the reversals.** `gate`, `centring`, `ready`, `level`,
  `multiplier`, `streak`, `bolt`, `burst`, `bank`, `rank`, `wobble`, `mark`,
  the tail-to-head walk, per-ending fades and the `onCue` callback are all
  written and published. What stream A1 still owes is the MOTION: the chain,
  the telegraphed turn, the flee, and the three endings as movement.
- **`camera.kick`**, as a decaying field-of-view offset. **`quality.huntShadows`**,
  with `createShadowField` standing down on the shader tier.
- **Nine stubs with final signatures**, and `main.ts` wired to all of them:
  the cue fan-out, the plugin built beside `waterHazard` and bound after, and
  the update calls in their stated places.
- **The marked blocks**, `<!-- HUNT FX -->` and `<!-- AUDIO -->`, in
  `index.html` and `src/style.css`.
- **The debug hook**, carrying `gate`, `ready`, `level`, `multiplier`,
  `ending`, `mark`, `shadowPath` and `effects`.

Still open, and owned by the streams named in the work split: every picture and
every sound. Nothing in `huntfx.ts`, `huntreticle.ts`, `hunttells.ts`,
`huntpointer.ts`, `huntnumbers.ts`, `screenfx.ts`, `audio.ts`, `huntaudio.ts`
or `leviathanwater.ts` draws or sounds anything yet.

### What was not done as briefed

Four departures, and one thing this document got wrong. Recorded here so nobody
re-derives them from the code.

1. **The sprite tier is not an `InstancedMesh`.** It is still the MVP's pool of
   fourteen meshes with two shared materials. Items 14, 19 and 20 all landed —
   the teardrop, the taper, the swim, the bank, the arrival from depth — but
   the swim wiggle is a per-mesh lateral offset in `place` rather than a vertex
   sine in a custom shader. Fourteen draw calls is nothing, and instancing
   would have needed a `ShaderMaterial` on the tier whose whole justification
   is that it runs on a software rasteriser. The picture is the same; the
   machinery is smaller.

2. **`?hunt=armed` lays the body running AWAY from the hull, canted 40°**
   (`FORCE_CANT`), not broadside. Broadside was right for a nine-unit disc and
   wrong for a twenty-two-unit chain: laid across the bow, most of the animal
   was off the side of the screen and the browser tier photographed a shoal it
   could not see.

3. **`force` gained a `keepProgress` flag.** After item 6 the mark walks up the
   body away from the hull, so a tier that cannot steer loses it after the
   first handoff and can never reach a fifth target. The flag re-lays the
   animal without clearing the score. It makes no press easier — every one
   still has to arm, wait out `ARM_UP` and beat `SOUND_BELOW`.

4. **`huntNumbers.cue` takes the streak as a third argument** rather than
   reading it off the cue. `HuntCue` kept exactly the fields briefed; the
   streak is a running total on `HuntState` that five other consumers have no
   use for, and `main.ts` is the one place holding both.

**And the correction:** this document said `wallet.add` has three callers. It
has nine call sites. `main.ts`'s own comment says three ACTIVITIES, which is
the claim that matters and which `HuntCue` preserves.

### Still open

- **The five look-questions in step 5 have been answered four times out of
  five, from the browser tier's screenshots**: the body reads as one animal on
  both paths, the gate is a shape on the water, a strike looks like a throw,
  and the night rim has not been photographed at night at all. **Whether the
  three endings look like three different things is NOT answered** — the
  ending cases assert `ending` and screenshot after the fade has run, so they
  photograph open water. A human has to launch the game for that one.
- **The night rim is unverified.** `NIGHT_RIM` is held at 0.62 against
  `BLOOM_THRESHOLD`'s 0.9 by arithmetic, not by a screenshot at `clock=0`.
- **The browser tier costs 7.6 minutes**, over the five-minute line. See
  **Phase 2's four cases** in `docs/TESTING.md` for the breakdown and for which
  case to cut first.
- **Every figure here is still a first guess.** Not one has been playtested.

Read first, in this order: `docs/ARCHITECTURE.md`, especially **Conventions**,
**Units, pinned**, **World scale**, **Frame loop**, **The pause contract**,
**The water plugin contract**, **Post-processing** and **The leviathan hunt**;
then `docs/LEVIATHAN_PLAN.md`, which is the MVP's brief and whose decisions
this document reverses in four places; then `docs/TESTING.md` for the budget
every stream below is held to. `docs/HAZARDS_PLAN.md` is the structural
precedent: one sequential Step 0 that lands every shared contract, then
parallel streams that own disjoint files and develop against stubs, then one
integration pass by the orchestrator.

## Why this exists

The MVP shipped the rule and not the experience. The pursuit is sound --
holding a drifting target inside the bow's arc is genuinely steering, and the
gate is the design -- but a player meets it as an awkward toy, and the reasons
are specific rather than a matter of taste:

1. **Nothing happens on the press.** `main.ts`'s `onHuntEvent` returns early on
   a `hit` by deliberate decision, and there is no harpoon, no splash, no
   reaction from the shadow and no sound. The whole of the feedback for the
   feature's one verb is a counter going from `5 LEFT` to `4 LEFT`.
2. **The gate is invisible.** `armed` turns on inside a band from
   `HARPOON_MIN_RANGE` to `HARPOON_RANGE` and inside `BOW_ARC` either side of
   the bow, and nothing on the water draws any of those three numbers. A dark
   bar reads as a broken bar.
3. **The shadows are unreadable.** Symmetric dark blobs, floating
   `DISPLACE_AMPLITUDE + 0.1` above the sea, with no heading cue and no motion
   but a slow bob. A player who cannot see where the shoal is going cannot lead
   it, and leading it is the skill.
4. **The chase is a series of surprises.** The heading rerolls by up to
   `TURN_MAX` with no telegraph, and the mark hops to a seeded random shadow
   after every bank.
5. **The dial rewards mashing.** `dialClock` resets to 0 when the gate opens and
   `sin(0)` is 0, so the first frame after arming is worth very nearly 100
   damage. Tapping Space while steering in beats reading the needle.
6. **All three endings look the same**: one fade of `FADE_OUT` and a line on the
   strip.

Items 1, 2 and 5 are the ones that make it feel broken. Item 5 is a live
exploit against the skill the whole feature is built to test.

## The twenty-one items, and where each lands

The numbering is the one the recommendations were given in and is kept
throughout, so a commit message or a review comment can name an item and be
unambiguous.

| # | Item | Stream |
|---|---|---|
| 1 | The shoal becomes a serpent: shadows chained nose to tail, head turns first | A1 |
| 2 | The animal reacts to the ship: flees the bow, bolts after a strike | A1 |
| 3 | The sweep starts at the red edge, with a short arm-up | A2 |
| 4 | Needle speed tied to how centred the mark is | A2 |
| 5 | Escalation across the five targets, in speed and in pay | A2 |
| 6 | The mark walks the body tail to head, with a visible handoff | A1, B1, B2 |
| 7 | Turns telegraph: the head banks a second before it turns | A1, B1, B2 |
| 8 | The strike zone drawn on the water, so the gate is seen not explained | C2 |
| 9 | Off-screen pointer for the mark | D |
| 10 | Floating damage numbers and a green streak | D |
| 11 | In-world spawn tells: circling birds, a spout | C2 |
| 12 | Sound, procedural, on a foundation that does not exist yet | F |
| 13 | Shadows as a darkening term inside the water shader | B1 |
| 14 | Teardrop sprite with a swim wiggle | B2 |
| 15 | The mark surfaces: foam ring, and a breach | B1 |
| 16 | The press becomes a throw: line, splash, spray, ink | C1 |
| 17 | Camera kick and screen pulses | D |
| 18 | The three endings drawn as three different pictures | A1, B2, C1 |
| 19 | Arrival from depth rather than a fade-in at full size | B2 |
| 20 | Bioluminescent night edge | B1, B2 |
| 21 | Dial polish: glow, band tint, level pips, gate-driven hint | D |

## Decisions taken

Settled with the owner on 2026-09-11. Do not re-litigate them; if one turns out
to be unworkable, say so and stop rather than substituting another.

1. **The four reversals are authorised.** Items 1, 2, 5 and 8 contradict
   `docs/LEVIATHAN_PLAN.md` as written. They are re-decided, and stream E
   records the reversal and its reason in that file rather than leaving the two
   documents disagreeing. See **What this reverses** below.
2. **Audio ships with its foundation.** There is no audio anywhere in this
   project -- `docs/ROADMAP.md` calls it the largest single gap -- so stream F
   builds a small procedural Web Audio module first and the hunt's cues on top
   of it. No other activity gains a sound in this work. A mute setting is part
   of the deliverable, not a follow-up.
3. **Both shadow paths ship, tiered by quality.** The water-shader darkening
   term (item 13) is the right answer and `docs/LEVIATHAN_PLAN.md` already named
   it as Phase 2. It runs on `medium` and `high`; the sprite pool stays as the
   `low` tier's path and gets items 14, 19 and 20 of its own. Nobody loses the
   shoal, and if the shader term disappoints under a screenshot there is a
   built fallback rather than a revert.
4. **Presentation is a second callback, not a widened event.** `HuntEvent` keeps
   carrying money and words to `main.ts`; a new `HuntCue` carries pictures and
   sounds. `wallet.add` keeps its three callers, so "where did that gold come
   from" stays answerable by grep.
5. **The plan lives in this file.** The owner works it from the desktop client,
   so the file-ownership tables below are the coordination mechanism and are
   authoritative over anything said in chat.

## What this reverses

Four entries in `docs/LEVIATHAN_PLAN.md`, each with what replaces it. Stream E
appends this table to that document under a **Re-decided in phase 2** heading,
so the MVP's brief does not go on asserting things the build has stopped doing.

| Was | Where | Now, and why |
|---|---|---|
| "The shoal holds one heading, with a fixed per-shadow jitter offset", because sub-groups are "unreadable at chase-camera distance" | Interpretation 1 | A single chained body. The original reasoning was right about sub-groups and wrong about the conclusion: the unreadable thing was fourteen independent blobs. One body with a head that leads is MORE legible at distance, not less, and it telegraphs its own turns for free |
| `HARPOON_MIN_RANGE` is "what makes the arc satisfiable at all" and nothing else | Departure 11 | The floor stays, at the same 5 units, and keeps its unit tests. It gains a reason the player can see: the animal flees the bow inside that radius. Ramming now fails because the thing moves, not because a rule says so |
| The mark moves to a seeded shadow, "never the same one twice in a row" | The mark | The mark walks the body from tail to head across the five targets, with a visible handoff. The seeded stream still draws unconditionally; it no longer decides the order |
| `HUNT_GOLD_PER_DAMAGE` is 10 flat, and a perfect hunt is 500 damage for 5 000 gold | The purse | 10 a point stands. Escalation multiplies banked damage per target, so a perfect hunt is 610 damage and 6 100 gold. Still under `bounty.ts`'s 20 000 jackpot and a little over the best contract's 5 250, which is the ordering that section argued for |

The gate's five conditions, the shared locker, one bundle to one hunt, the
sine, `SOUND_BELOW` at 10 damage with the last target exempt, no reputation, no
new save field, and "it is not an overlay" are all **unchanged**. So is the
five-target count, and so is the rule that a hunt pays exactly once on the
transition into `settling`.

## Units

Unchanged from the MVP, and restated because two streams add quantities.

- Distance: world units. `GLOBE_RADIUS` 200, hull 3 long, `RADAR_RANGE` 50,
  chase camera 52 back.
- Angles: radians in code, degrees in this document and in comments.
- Time: seconds of frame `dt`, clamped at 0.1 by `main.ts`. Never `env.elapsed`,
  never `performance.now()`, never `Date`.
- Sweep position `p`: dimensionless, `[-1, 1]`, 0 at the centre.
- Damage: integers per press `[0, 100]`, multiplied by a level factor on
  banking.
- Gold: integers, rounded to `GOLD_ROUNDING` (50) on payout.
- `surfacing`, `envelope`, `bolt`, `handoff`, `centring`: all `[0, 1]`.
- `bank`, `centring`'s source angle: signed, negative to port.

## Why this shape, and the six traps

**One sim, many views, one fan-out.** `leviathan.ts` and `huntsweep.ts` own
every rule. Six modules draw or sound what they say and decide nothing. This is
the `aiboats.ts` to `aihulls.ts` split the codebase already has, extended to
six consumers instead of one, and it is what keeps the hunt testable under node
with no DOM and no `three` scene. `main.ts` is the only fan-out point: the sim
emits a `HuntCue`, `main.ts` hands it to everyone who cares, and no view knows
another view exists.

**Cues are not events.** `HuntEvent` is money and the notification strip, and it
keeps its four kinds. `HuntCue` is pictures and sounds. They are separate types
because they have different lifetimes and different consumers, and because
folding them together would put `wallet.add` behind a switch that six modules
also read.

**The six traps.**

1. *Widening `HuntEvent` instead of adding `HuntCue`.* Every effect wants a
   position and a band; the wallet wants neither. One type carrying both is how
   a splash ring ends up able to pay gold.
2. *A second clock.* Every clock in this feature is frame `dt`. `setTimeout`,
   `performance.now()`, `Date` and CSS animation durations that gate game state
   are all out. CSS transitions on a HUD element that has no gameplay meaning
   are fine, and that distinction is the whole of the rule.
3. *A new light in the scene.* `battlescene.ts` records why: a light arriving
   under a hull of two dozen standard materials changes the lighting hash and
   recompiles every one of them, which is a stall in the middle of the thing
   the player is doing. Every effect in stream C is emissive geometry or
   nothing. The battle's pools idle at zero intensity instead of being added,
   and that pattern is the one to copy if a light is ever genuinely needed.
4. *Forgetting `postFx.adopt`.* Materials built after the composer's one-time
   walk of the scene carry no sRGB self-encode and render a stop dark.
   Every stream that builds a material calls `adopt` on its group, before the
   first frame, exactly as `aihulls.ts` and `leviathanshadows.ts` already do.
5. *Leaving `frustumCulled` on a bare mesh.* Three culls against a bounding
   sphere computed from the geometry at the origin, so a plane placed 200 units
   out by a fresh world matrix is culled or not by accident.
   `leviathanshadows.ts` records this; every new bare mesh needs the same line.
6. *Touching the frozen branch.* Exactly five things run in a frozen frame and
   the pause contract names them. Nothing in this work joins that list. An
   overlay freezes a hunt, which is correct and is the MVP's departure 1; the
   guard that keeps a Space aimed at the fishing card out of `leviathan.fire()`
   stays in `main.ts`'s `fireHarpoon` and is stream E's to preserve.

## The hunt, end to end, after this work

The rule changes are marked. Everything unmarked is the MVP's flow unchanged.

```
sailing branch, suppressed() false
  └─ roll every ROLL_PERIOD: P_SHOAL, at most one shoal live
       └─ shoal spawns SHOAL_SPAWN_MIN..MAX out, open water
            ├─ NEW: rises from depth; birds circle the head; spouts;
            │        `spawn` cue -> groan
            ├─ NEW: SHOAL_COUNT shadows chained nose to tail, head leads,
            │        body follows by BODY_SPACING
            ├─ NEW: turn telegraphs -- turnIn counts down, head banks over
            │        TURN_TELEGRAPH, `turn` cue, THEN the heading moves
            ├─ NEW: any segment inside FLEE_RADIUS turns the head away
            ├─ NEW: the strike zone is drawn on the water: the annulus from
            │        HARPOON_MIN_RANGE to HARPOON_RANGE, BOW_ARC either side,
            │        coloured by `gate`
            ├─ the mark is one segment, NEW: tail to head across the five
            │    └─ marked segment inside the zone, locker stocked?
            │         ├─ no  -> bar dark, `gate` says which condition failed,
            │         │          hint text says it in words
            │         └─ yes -> NEW: arm-up of ARM_UP, then the sweep runs
            │                   from the RED EDGE inward, at a rate set by
            │                   how centred the mark is and by the level
            │              └─ Space (refused during arm-up)
            │                   damage = round(100 * (1 - |p|))
            │                   NEW: banked += damage * LEVEL_MULTIPLIER[level]
            │                   harpoons.spend(1)
            │                   NEW: `strike` cue -> line, splash, spray,
            │                        ink on green, number, streak, camera
            │                        kick, thud and chime
            │                   NEW: the animal bolts for BOLT_SECONDS
            │                   ├─ 5th? -> SETTLE: rise, dive, purse counts up
            │                   ├─ >= SOUND_BELOW -> bank, NEW: level += 1,
            │                   │    `handoff` walks the mark up one segment
            │                   └─ <  SOUND_BELOW -> SOUNDED: the body
            │                        converges on the mark and dives under a
            │                        swell, `dive` cue -> bass drop
            ├─ player leaves (> DESPAWN_RANGE) or suppressed() -> SCATTER:
            │    NEW: segments fan outward
            └─ any ending: gold = round50(banked * HUNT_GOLD_PER_DAMAGE)
                 wallet.add(gold); toast the figure; NEW: the fade is per
                 ending, ENDING_FADE, and the picture differs
```

There is still no start button, no end screen, and no pause. The hunt is a thing
that happens on the water while the world runs, and it settles into the
notification strip.

## Step 0: the contract

Done by the orchestrator **alone**, before any stream starts. `npm run build`
and `npm test` green at the end of it, and green for every stream afterwards.
The baseline to hold is the current one: 58 unit files, and `npm test` is the
routine loop at about four seconds.

Step 0 is the expensive half of this plan's correctness. Nine streams that never
negotiate with each other is worth a careful half day; a field renamed on day
three costs every one of them.

### Types, in `types.ts`

Every stream reads these and none writes them after Step 0.

**`Shadow` gains five fields.** All of them are written by `leviathan.ts` and
read by the renderers.

| Field | Meaning |
|---|---|
| `rank` | Position in the body. 0 is the head. Stable for the shoal's life |
| `surfacing` | 0 deep, 1 breaching. Drives the shader's darkening strength, the sprite's scale and sharpness, and the foam ring |
| `bank` | Signed roll, ramping over `TURN_TELEGRAPH` before a turn and decaying after it. This is item 7's whole visible content |
| `burst` | 0..1, spikes on a strike and decays. Drives the bolt's visible urgency |
| `wobble` | A fixed per-shadow phase, drawn once at spawn. The swim wiggle's offset, so no two segments beat in step |

**`HuntState` gains twelve fields.** `phase`, `shadows`, `target`, `banked`,
`armed`, `dial` and `grace` keep their current meanings.

| Field | Meaning |
|---|---|
| `gate` | `'ok' \| 'far' \| 'close' \| 'arc' \| 'dry' \| 'suppressed'`. WHICH condition is failing, in that priority order. The reticle's colour and the dial's hint both read it, and it is the single biggest onboarding fix in this plan |
| `ready` | False during arm-up. `armed && ready` is what a press needs |
| `centring` | 0 with the mark dead ahead, 1 at the arc's edge. Item 4's input |
| `sweepRate` | The rate actually in use this frame, published so the HUD can show it |
| `level` | 0..4. Targets banked so far, and the index into the escalation tables |
| `streak` | Consecutive presses in the green band. Item 10's counter |
| `multiplier` | `LEVEL_MULTIPLIER[level]`, published so the dial can print it |
| `turnIn` | Seconds until the next heading change; negative while turning |
| `handoff`, `handoffFrom`, `handoffTo` | 0..1 progress and the two ranks, for the pulse that travels up the body |
| `bolt` | 0..1, the shoal-wide flee response |
| `ending` | `'sounded' \| 'scattered' \| 'settled' \| null`. Set on the transition into `settling` and read by everything that draws an ending |
| `mark` | The marked segment's `rank`. A convenience, so six consumers do not each scan the array |

**`HuntCue` is new.** Emitted by the sim through a second callback and consumed
by five modules. It is a value object with no methods and no identity: a
consumer that wants to remember one copies what it needs.

| Field | Meaning |
|---|---|
| `kind` | `'spawn' \| 'armed' \| 'disarmed' \| 'turn' \| 'handoff' \| 'strike' \| 'spout' \| 'dive' \| 'settled'` |
| `position` | Optional unit direction. Present on `strike`, `spout` and `dive` |
| `damage` | Optional. Present on `strike` |
| `band` | Optional `'green' \| 'yellow' \| 'red'`. Present on `strike`, and it is the sim's reading of its own ramp so five consumers cannot each get the thresholds wrong |
| `sign` | Optional, present on `turn`: which way |

**`HuntEvent` gains one field**, `ending`, mirroring the state's. **`HuntPhase`
is unchanged**: the three endings are `ending` on the existing `settling` phase,
with a per-ending fade length, because a fourth phase would be a fourth branch
in every consumer for something that is already a word.

### Stubs, with final signatures

One per new module, each returning current behaviour or doing nothing, so
stream E can wire the entire loop on day one and every other stream can be
landed in any order.

```ts
// huntsweep.ts -- A2
createSweep(): Sweep;  arm(s: Sweep): void;
step(s: Sweep, dt: number, centring: number, level: number): void;
position(s: Sweep): number;  canPress(s: Sweep): boolean;
rateFor(centring: number, level: number): number;
multiplierFor(level: number): number;
damageAt(p: number): number;  huntGoldFor(banked: number): number;  SOUND_BELOW

// leviathanwater.ts -- B1
createLeviathanWaterPlugin(): WaterPlugin & { bind(state: HuntState, night: () => number): void }

// huntfx.ts -- C1
createHuntFx(scene, postFx?): { cue(c, ship); update(dt, state, ship); live; dispose() }

// huntreticle.ts / hunttells.ts -- C2
createHuntReticle(scene, postFx?): { update(dt, state, ship); dispose() }
createHuntTells(scene, postFx?): { cue(c); update(dt, state, night); dispose() }

// anchor.ts / huntpointer.ts / huntnumbers.ts / screenfx.ts -- D
project(position: Vector3, camera, out): { x: number; y: number; behind: boolean }
createHuntPointer(): { update(state, camera, ship); dispose() }
createHuntNumbers(): { cue(c, camera); update(dt); dispose() }
createScreenFx(): { cue(c); update(dt, state); dispose() }

// audio.ts / huntaudio.ts -- F
createAudio(): { muted: boolean; unlock(); tone(spec); noise(spec); now; dispose() }
createHuntAudio(audio): { cue(c); update(dt, state); dispose() }

// camera.ts -- D, one method added to FollowCamera
kick(amount: number): void

// quality.ts -- E, one row added to QualitySettings
huntShadows: 'sprites' | 'shader'
```

`anchor.ts` is the one stub that is **real in Step 0 rather than empty**, because
two of stream D's three modules are meaningless without it and because it is the
world-to-screen projection `docs/LEVIATHAN_PLAN.md` stages as Phase 2 item 3 for
every future overlay. Step 0 lands the working projection; D finishes and tests
it.

### Constants

New exports with first-guess values, so a stream tunes numbers rather than
inventing names. Every one of these is a first guess with no playtest behind it,
which is the caveat `docs/ROADMAP.md` already carries twice for
`questconstants.ts` and the hunt, and now carries three times.

On `leviathan.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `BODY_SPACING` | 1.6 | Units between segment centres. Just over half a hull length |
| `HEAD_TURN_RATE` | 60 deg/s | How fast the head comes round once a turn starts |
| `TURN_TELEGRAPH` | 1.0 s | The bank before the turn. Item 7 entirely |
| `FLEE_RADIUS` | 5 | Equal to `HARPOON_MIN_RANGE`, and that equality is load-bearing |
| `FLEE_TURN` | 90 deg/s | How hard the head turns away from a hull inside the radius |
| `BOLT_SECONDS` | 2 | How long a struck animal runs |
| `BOLT_SPEED` | 9 | Units/s while bolting. Under the hull's 10.5 cruise, deliberately |
| `HANDOFF_SECONDS` | 0.6 | The mark's walk up one segment |
| `SPOUT_MIN`, `SPOUT_MAX` | 6, 10 s | Between spouts |
| `ENDING_FADE` | 2.5 / 1.5 / 3 s | Sounded, scattered, settled |

On `huntsweep.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `ARM_UP` | 0.25 s | Presses refused, needle visibly charging |
| `SWEEP_SLOW`, `SWEEP_FAST` | 0.7, 1.6 | Rate multipliers at `centring` 0 and 1 |
| `LEVEL_SPEED` | 4, 4.5, 5, 5.5, 6 | `SHADOW_SPEED` per level |
| `LEVEL_HOLD` | 5-10 down to 3-6 s | `HEADING_HOLD` range per level |
| `LEVEL_MULTIPLIER` | 1.0, 1.1, 1.2, 1.3, 1.5 | Banked damage factor per level |

The multipliers sum to 6.1, so a perfect hunt banks 610 and pays 6 100 gold
against `bounty.ts`'s 20 000 jackpot, the best contract's 5 250 and a fishing
session's 1 500. A blind player still averages about 36 a press, banks about 222
and takes 2 200. The MVP's ordering argument therefore survives: the hunt sits
level with the best contract and the fight keeps the jackpot.

### Marked blocks in shared files

`index.html` and `style.css` get a `<!-- HUNT FX -->` / `/* HUNT FX */` block for
stream D and an `<!-- AUDIO -->` / `/* AUDIO */` block for stream F, the latter
being a mute row inside the menu's controls pane. The existing `<!-- HUNT -->`
block stays stream D's, since it owns `leviathandial.ts`. Edits inside a block
use **Edit, never Write**. `docs/ARCHITECTURE.md` gets one placeholder
subsection per stream under **The leviathan hunt**, so stream E merges nine
paragraphs at the end instead of nine agents queueing on one file.

### The wiring, in `main.ts`

Step 0 constructs every stub and puts every call in its place, against stubs
that do nothing. Stream E inherits the file and finishes it. Nothing is added to
the frozen branch or the battle branch.

- `leviathan.update(dt, ship.state, suppressed())` stays where it is, after
  `aiBoats.update` and before `ship.update`, for the reason the MVP gives: the
  frame a press lands must be the frame the hull was pointing where the player
  saw it pointing.
- The sim's new `onCue` fans out to `huntFx`, `huntTells`, `screenFx`,
  `huntNumbers`, `huntAudio` and `huntPointer`. One function, six calls, no
  registry: a registry would be the sixth thing to keep in step for no gain at
  this size.
- `leviathanWater` is built beside `waterHazard` before `createGlobe`, and bound
  after it, which is the awkwardness the plugin contract imposes and which
  `waterhazard.ts`'s header already explains.
- `huntReticle.update` and `huntFx.update` go beside `shadowField.update`, after
  `view.update` and before `globe.update`, for `aihulls.ts`'s reason: they only
  place things, and the camera has already moved.
- `huntPointer`, `huntNumbers` and `screenFx` update after `huntDial.update`,
  since they read the camera stream D's projection needs.
- The quality row is passed into `createShadowField` so the sprite pool hides
  itself entirely on the shader tier.
- `onContact` keeps its `leviathan.scatter()`. A fight still ends a hunt.

## Work split

Nine streams in parallel in one working tree, after Step 0. Files are
partitioned so no two streams write the same file.

| Stream | Owns | Items |
|---|---|---|
| **A1 Body** | `leviathan.ts`, `tests/unit/leviathan.test.ts` | 1, 2, 6, 7, the sim half of 18, the cues behind 10 and 16 |
| **A2 Sweep** | `huntsweep.ts`, `tests/unit/huntsweep.test.ts` | 3, 4, 5, the purse |
| **B1 Water term** | `leviathanwater.ts`, `tests/unit/leviathanwater.test.ts` | 13, 15, 20 on the shader tier |
| **B2 Sprites** | `leviathanshadows.ts`, `tests/unit/leviathanshadows.test.ts` | 14, 19, 20 and the picture half of 18 on the sprite tier |
| **C1 Effects** | `huntfx.ts`, `tests/unit/huntfx.test.ts` | 16, the effect half of 18 |
| **C2 Reticle and tells** | `huntreticle.ts`, `hunttells.ts`, their tests | 8, 11 |
| **D HUD and screen** | `anchor.ts`, `huntpointer.ts`, `huntnumbers.ts`, `screenfx.ts`, `leviathandial.ts`, `camera.ts`, the HUNT and HUNT FX blocks, their tests | 9, 10, 17, 21 |
| **E Loop and docs** | `main.ts`, `radar.ts`, `quality.ts`, `dev/probe.ts`, `docs/*`, `README.md`, `tests/smoke/game.spec.ts` | Wiring, tiering, dev queries, the scope, docs, browser tier |
| **F Audio** | `audio.ts`, `huntaudio.ts`, `menu.ts`, the AUDIO blocks, their tests | 12 |

If fewer than nine agents are available, pair in this order: A1 with A2, B1 with
B2, C1 with C2. D, E and F do not pair well with anything -- D because it owns
six files and the HUD's two blocks, E because it is the integration surface, F
because it is the only stream with no dependency on the hunt at all and can run
at any time.

**Rules binding every stream.** Frame `dt` only. Nothing added to the frozen
branch. No new scene lights. No glTF and no asset files; everything is generated
at runtime, which is the project's ethos and the reason this work is cheap. Space
stays bound only in `leviathandial.ts` and guarded in `main.ts`'s `fireHarpoon`.
`npm test` green on every commit. Only stream E edits `main.ts`.

### A1 -- Body

The shoal becomes one animal. The head carries the heading and transports
exactly as today. Segment `i` steers toward the point `BODY_SPACING` behind
segment `i - 1` along the great circle, through the existing `transport` and
`pointAt`, so the parallel-transport invariant holds per segment and nothing is
ever kept as a compass bearing.

A heading reroll becomes a progressive turn. `turnIn` counts down; at
`TURN_TELEGRAPH` the head's `bank` ramps with the turn's sign and the `turn` cue
fires; then the head turns at `HEAD_TURN_RATE` toward the new heading and the
body follows by construction. `TURN_MAX` still bounds the size of the turn.

Flee: any segment inside `FLEE_RADIUS` of the hull turns the head away at
`FLEE_TURN` and raises `bolt`. A strike raises `bolt` for `BOLT_SECONDS` at
`BOLT_SPEED` and spikes that segment's `burst`. `HARPOON_MIN_RANGE` stays equal
to `FLEE_RADIUS` and stays the hard gate floor, so the gate keeps its existing
unit cases and the flee is a visible reason on top rather than a replacement.

The mark walks tail to head: target 1 is the highest rank, target 5 is rank 0,
evenly spaced between, with `handoff` running over `HANDOFF_SECONDS`. The seeded
stream is still drawn from unconditionally, so what happens to be on the water
cannot reorder the draws behind it.

`gate` is set every frame from the five conditions in priority order, and
`centring` from the signed off-bow angle the debug hook already computes. The
inline sine is replaced by calls into A2's sweep.

Endings are motion the sim owns, since they are positions: sounded converges the
body on the mark and drops `surfacing`; scattered fans segments outward on their
own tangents; settled rises, holds, then dives. `ending` is set once, on the
transition into `settling`, beside the purse that already settles there.

Spouts are seeded draws every `SPOUT_MIN` to `SPOUT_MAX` seconds, firing the
`spout` cue at the head's position.

**Acceptance.** Every existing case in `leviathan.test.ts` still passes.
Unit-length position and tangency within 1e-6 for every rank over 3 000 s,
including across a pole. Body spacing stays within one unit of `BODY_SPACING` at
cruise and through a turn. A `turn` cue always precedes the heading change by
`TURN_TELEGRAPH` within one frame. A hull placed inside `FLEE_RADIUS` sees the
head's heading move away within one second. The mark visits ranks in tail-to-head
order across five targets. Each ending sets `ending` exactly once and pays
exactly once. Two sims on one seed driven by the same `dt` sequence produce
identical states, cues included.

### A2 -- Sweep

Pure functions over a small struct, no module state, no DOM, no `three`.

`arm` starts the phase at the **red edge** so the sweep runs inward and the first
perfect moment is a quarter period away; `canPress` is false for `ARM_UP` after
it. `rateFor` interpolates `SWEEP_SLOW` to `SWEEP_FAST` across `centring` and
multiplies by the level's factor, so holding the mark dead ahead slows the needle
and the arc's edge runs it fast. That is the fusion of steering and timing the
whole feature is a claim about, and it is four lines.

`damageAt` is unchanged. `multiplierFor` returns `LEVEL_MULTIPLIER`.
`huntGoldFor` moves here from `leviathan.ts` so the purse and the multiplier live
in one file and `main.ts` keeps one caller.

**Acceptance.** Position at `arm` has magnitude 1 and damage 0. Damage reaches
100 a quarter period in at rate 1. `centring` 0 is measurably slower than
`centring` 1 at the same level. A press inside `ARM_UP` is refused and spends
nothing. The exploit case: a simulated 10 Hz mash from the arming frame averages
under 50 damage over 1 000 trials, where the MVP's sweep averages very nearly
100.

### B1 -- Water term

A `WaterPlugin` on `waterhazard.ts`'s skeleton. `MAX_SHOAL` equals `SHOAL_COUNT`;
uniforms are position, forward, shape and `surfacing` per segment, a count, and a
night factor. The loop runs to the constant and breaks on the count, which is the
legacy-style bound `hazardfield.ts` documents and which a quiet sea pays one
comparison for.

- **colour**: a tapered teardrop falloff in each segment's local frame, lighter
  toward the head, darkening `col` by an amount rising with `surfacing`.
- **foam**: a ring on the marked segment scaled by `surfacing`, and a short foam
  trail behind the head that kinks with `bank`, so a turn is legible from the
  wake as well as from the body.
- **night**: an additive neon rim on the falloff's edge scaled by the night
  factor, held under `BLOOM_THRESHOLD` (0.9). That ceiling is the one number in
  this stream that must be confirmed in a screenshot rather than argued.

This is the answer `docs/LEVIATHAN_PLAN.md` staged as Phase 2 and the reason is
unchanged: a term inside the surface cannot be above or below it and has no
height to tune, so the MVP's accepted artefact goes away rather than being
tuned.

**Acceptance.** The shader compiles with the plugin spliced, in
`water-shader.test.ts`'s existing harness. The falloff has a TypeScript twin
evaluated at the centre, at the rim and outside, agreeing with the GLSL
constants, on `hazardfield.ts`'s parity precedent. A bound plugin with an idle
sim writes count 0. The `wave-parity` browser case renders the plugin without a
compile error on all three tiers.

### B2 -- Sprites

The `low` tier's path, and the fallback if B1 disappoints. A teardrop texture
with a lighter head, sized by rank with the head largest. One `InstancedMesh`
with a per-instance phase attribute replaces the fourteen meshes and the stock
material, and a vertex sine along the length makes each segment swim. Scale and
edge sharpness follow `surfacing` and the envelope, so a shoal grows out of the
sea instead of fading in at full size. `bank` tilts the head's quad. A second
ring texture in neon carries the night rim. Endings read `ending` and follow the
sim's motion, adding only a sink on sounded.

The pool hides itself entirely when the quality row says `shader`, and `visible`
publishes which path drew, extending the reason that counter exists: "illegible"
and "absent" look identical in a screenshot and only one of them is a design
trade.

**Acceptance.** The instanced path places every rank on the surface basis and
`visible` matches the sim's count on the sprite tier and is 0 on the shader
tier. A frame with `dt` 0 writes nothing. `SHADOW_LIFT` still imports
`DISPLACE_AMPLITUDE` rather than restating it.

### C1 -- Effects

One module, fixed pools, no lights, no allocation after construction.

- **Harpoon line** from a bow offset on `ship.state` to the strike position,
  taut for 0.3 s then fading.
- **Splash rings**, six deep, generalised from `battlescene.ts`'s pool, which is
  already the right shape and the right radii.
- **Spray burst**: a vertical billboard quad with a procedural texture, scaled by
  band.
- **Ink cloud**: a flat dark plane on green strikes only, growing over 3 s.
- **Dive swell** on the `dive` cue: a wide dark ring growing over 2 s with a foam
  edge, which is the picture that makes sounding feel like a loss.

Everything sits above the water by the same clearance the shadows use, with
`depthWrite` off and `depthTest` on so land still occludes it, and the group is
adopted by the composer. The `low` tier drops the ink cloud and halves the ring
pool.

**Acceptance.** A `strike` cue leaves exactly one line, one ring and one burst
live. Pools wrap without allocating. Every effect ages out by its stated life.
`live` is 0 on an idle sea.

### C2 -- Reticle and tells

The reticle is the gate, drawn. An annulus sector on the water ahead of the bow,
from `HARPOON_MIN_RANGE` to `HARPOON_RANGE`, spanning `BOW_ARC` either side,
placed on the ship's surface basis every frame and shown whenever a shoal is live
and not suppressed. Its colour reads `gate`: dim while `far`, cyan on `ok`, red
on `dry`, and it pulses once on the `armed` cue. It shows on every quality tier,
because it is the onboarding rather than an effect: three numbers that were only
ever stated in a hint line become a shape the player steers into.

Tells: four to six bird billboards circling the head three to five units up, and
a spout column on the `spout` cue rising over a second and fading. Both fade with
the envelope and leave on any ending. They are what makes finding a shoal
navigation by eye rather than a dot on the scope.

**Acceptance.** The reticle's inner and outer radii equal the two constants and
its half-angle equals `BOW_ARC`, read back from the geometry rather than
asserted. It is hidden while the phase is idle. Birds stay within their orbit
radius of the head. One `spout` cue spawns exactly one column.

### D -- HUD and screen

`anchor.ts` first, since two of the three new HUD modules and every future
overlay need it: one `Vector3.project` into CSS pixels with a `behind` flag, in
its own module, which is Phase 2 item 3 of the MVP's plan delivered.

- **Pointer**: an edge arrow with the range, shown only when the mark is behind
  the camera or off screen, hidden while armed. The chase camera looks forward,
  so a shoal astern is currently invisible except on the scope.
- **Numbers**: on `strike`, the damage pops at the mark's screen position in its
  band colour and floats up over 0.8 s, with the streak count beside it from the
  second green onward.
- **Screen effects**: a viewport vignette, cyan on `armed` and red while the live
  damage is under `SOUND_BELOW`, and a camera kick on green strikes through
  `FollowCamera.kick`, which adds a decaying field-of-view offset rather than
  moving the rig. All of it obeys `prefers-reduced-motion`.
- **Dial polish**: a needle glow building through green, the bar tinted by the
  current band, a charging state during `ARM_UP`, five level pips with the
  multiplier, the live number scaled by damage, and the hint driven by `gate` so
  the bar says WHY it is dark in the order `far`, `arc`, `close`, `dry`.

**Acceptance.** `project` puts the ship's own position inside the viewport and a
point behind the camera as `behind`. The pointer is hidden while armed. A
`strike` cue adds one number element and removes it after its life. Reduced
motion disables the kick and both pulses. The charging class is on during arm-up
and off after. The dial's existing missing-element contract still holds: a
document without the block must not take the frame loop down, and must leave
Space unbound.

### E -- Loop and docs

Inherits Step 0's wiring and finishes it.

- **Scope**: the body as a chain of dots in rank order, and a faint wedge at the
  ship's dot for `BOW_ARC`, so the arc exists on the instrument as well as on the
  water.
- **Quality**: the `huntShadows` row and passing it through.
- **Dev queries**: `?hunt=sound`, `?hunt=settle`, `?hunt=scatter` force each
  ending two seconds after `?hunt=armed` lays the shoal, and `?hunt=turn` forces
  a telegraphed turn. The browser tier cannot steer, so without these it cannot
  photograph any of the four new pictures. This is the same affordance
  `?hunt=armed` already is, and the same reasoning.
- **Debug hook**: `gate`, `level`, `ending`, the effect `live` count and which
  shadow path drew.
- **Docs**: rewrite **The leviathan hunt** in `docs/ARCHITECTURE.md` from the
  nine placeholders; append **Re-decided in phase 2** to
  `docs/LEVIATHAN_PLAN.md` from the table in this file; add `audio.ts` to the
  module table; one controls row in `README.md` for mute; update
  `docs/ROADMAP.md`'s audio gap, which stops being "there is none".
- **Browser tier**: extend the armed case to assert a splash ring and a number
  after the press, and add one case per forced ending with a screenshot each,
  inside the budget rules -- no gating every step on this tier, and no fixed
  `waitForTimeout` where a condition will do.

**Acceptance.** `npm run test:all` green once, at the end. The ownership tables
in the docs match the files as built. The browser tier's added cost is stated in
`docs/TESTING.md`, since that file tracks the budget and already flags the
hunt's case rather than hiding it. Four new cases must not undo the reduction
that got `hunt=armed` back under the outlier: wait on a condition, never on a
fixed timeout.

### F -- Audio

`audio.ts` is the foundation and knows nothing about hunts: a lazily created
`AudioContext` unlocked on the first keydown or pointerdown, a master gain, a
mute flag persisted under `pirate-world/mute` on `quality.ts`'s storage
precedent, suspend on a hidden tab, and two primitives -- a tone with an envelope
and a filtered noise burst. It must be silent and inert where there is no
context, which is the headless browser tier and every unit test.

`huntaudio.ts` maps cues to voices: a low groan with slow vibrato on `spawn`; a
band-edge tick while armed that quickens as the needle nears green; a thud plus a
splash on `strike`, with a short chime on green; a bass drop on `dive` when the
ending is sounded; a rising figure on `settled`. Procedural Web Audio needs no
asset, which is why this fits the project's ethos and why it is cheap.

`menu.ts` gains a mute row in the controls pane.

**Acceptance.** Constructed under node, the audio object is silent, inert and
never throws. Mute survives a reload. Every cue kind maps to at most one voice
and the armed tick stops on `disarmed`. The menu row reflects the flag both ways.

## Integration, by the orchestrator

1. Land **A1** and **A2**. Every other stream reads the state they write. Unit
   tier.
2. Land **B1**, **B2**, **C1**, **C2**. Unit tier, then the browser tier once.
3. Land **D** and **F**. Unit tier.
4. Land **E** last, with the docs and the smoke cases. Then `npm run test:all`
   **once**.
5. **Look.** Per the budget in `docs/TESTING.md`, launch a preview and answer
   five questions from the screen and not from a green build:
   - Does the body read as one animal, on both shadow paths?
   - Does a turn telegraph a full second ahead, legibly, at chase distance?
   - Does a strike look like a throw?
   - Do the three endings look like three different things?
   - Is the night rim under the bloom threshold, or is it glowing into the sky?

   Any "no" is reported plainly rather than tuned until a screenshot passes. That
   is the rule the MVP set for its shadows and it was the right one: a green
   build is not a pass.
6. Version bump and the standing table in `docs/ROADMAP.md`.

## Alternatives considered

| Choice | Taken | Rejected, and why |
|---|---|---|
| Feedback plumbing | A second `HuntCue` callback | Widening `HuntEvent`: six consumers behind the type that pays gold. Letting views poll state: a strike is an instant and polling would miss or double it |
| The animal's shape | One chained body | Keeping the loose shoal and only improving the sprite: leaves items 6 and 7 unbuildable, since there is no head to bank and no body to walk the mark up. Genuine sub-groups: the MVP already rejected these and was right |
| Why ramming fails | The animal flees | Keeping only the range floor: correct mechanically, unexplained visually, and the MVP's own browser probe is the evidence that players close to zero range and never learn why the bar stayed dark |
| The mash fix | Start at the red edge plus an arm-up | A press cooldown: hides the exploit rather than removing it. Randomising the start phase: makes the skill unlearnable, which is the exact thing `fishsim.ts`'s clock discipline exists to prevent |
| Shadow rendering | Shader term on medium and high, sprites on low | Shader only: the low tier is the software rasteriser the browser tier runs on, and a fragment loop over fourteen segments there is a real cost. Sprites only: leaves the MVP's accepted artefact in place and wastes the plugin contract |
| Where the gate is shown | A reticle on the water | A projected ring around the shadow: needs the anchor module to be load-bearing for gameplay rather than for HUD polish, and reads worse at a grazing angle. Text only: that is what exists, and it is the problem |
| Audio | Foundation plus hunt cues | Cues with no foundation: nowhere to put a mute. Foundation alone: the largest single feel gain in this plan sits unused behind it |
| Escalation | Multiply banked damage | Widening the green band per level: the bar would have to redraw its stops every target and the MVP's warning that a moved `SOUND_BELOW` makes the bar lie applies doubly. Raising gold per point: makes the last press worth more than the first four together |
| Plan delivery | This file | Chat only: nine streams with no written ownership table is how two agents write `main.ts` |

## What this buys, and what it costs

**Buys**

- The feature stops being awkward. Items 1, 2, 8 and 16 address the six named
  reasons directly, and item 5's exploit goes away.
- The world-to-screen projection every future overlay wants, built once, in its
  own module, which is where the MVP said it belonged.
- Audio exists in this project for the first time, with a mute setting, on the
  ethos that needs no asset. `docs/ROADMAP.md`'s largest single gap stops being
  total.
- The shader-shadow term the MVP deferred, with the sprite path kept as a tier
  rather than deleted.
- No new currency, no new save key, no new shop row, no asset pipeline, no glTF.
  The animal the feature is named for is still deferred, and after this it is
  deferred from a much better starting point.

**Costs**

- Nine streams on one tree is three times this repository's precedent. The
  pairings above are the fallback and Step 0 is the reason it can work at all.
- Two shadow renderers to keep in step on every future change to what a shadow
  is.
- A third untuned economy layer on top of two untuned economies. Not a figure in
  `questconstants.ts` has ever been played, the hunt's own figures are first
  guesses, and `LEVEL_MULTIPLIER` is a third table beside them.
- Audio is cross-cutting: a setting, a storage key, an unlock gesture, and a
  headless tier that must tolerate having no context.
- It moves none of the hard blockers except audio: no licence, no third-party
  notices, no accessibility pass, no save export, no CI, nowhere to deploy.
  Every one of those individually sinks a paid release.
- `main.ts` gains roughly a dozen calls and one fan-out. It is the file this
  project has to keep readable, and stream E is the only one allowed near it for
  exactly that reason.

## Out of scope, and named so nobody re-derives it

1. **The ironwhale itself.** A single large animal that surfaces, takes three
   strikes and sounds is still the original pitch and still needs the mesh work
   both this plan and the MVP exist to defer. After this work the shape it would
   slot into exists: a head with a heading, a bank, a surfacing term and a strike
   response.
2. **Reputation.** Unchanged from the MVP: it joins when there is something it
   buys, at a figure chosen against whatever that is.
3. **`huntBest` in the save.** One number on `save.ts`'s grow-a-field path, no
   version bump. Left out because this work changes what a good hunt scores, and
   a record set under the old multipliers would be a record of a different game.
4. **A shop row.** A heavier harpoon head that widens the green band is still the
   obvious first item and `barbedheads.ts` is still the shape to copy.
5. **Audio for anything else.** Wind, the hull, the fishing card, the battle. The
   foundation is built to carry them and this plan deliberately does not.
6. **Shadows cast by anything.** `docs/RENDER_PLAN.md` Phase 3 owns the
   directional shadow map, and the darkening term here is not one.
