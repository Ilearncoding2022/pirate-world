# Ship battle rework: implementation plan

Status: **draft, awaiting owner review. No code written.**

This document is the complete brief. An implementing agent should not need the
conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**AI boats and the battle**, **Frame loop** and **Units, pinned**, then
`docs/BATTLE_PLAN.md` for how the fight was built, and `docs/TESTING.md` for
the budget every agent below is held to. `docs/HAZARDS_PLAN.md` is the
precedent for a seeded event system that spawns things around a hull and
tests contact.

## Why

The fight as shipped has two problems the owner has named.

The AI is too smart. `battle.ts` reads the player's angular speed on the
current tick, solves the intercept exactly, and only a 0.2 to 0.6 s reaction,
a 0.35 s jitter and a wide solution tolerance stop it scoring. Its helm is a
bang-bang controller that picks the correct throttle every 1.5 s without
fail. It measures 46.5% against a player who does nothing.

And the arena is empty. The circle, the diameter shot and the shrinking
radius are the whole of the fight. Nothing random touches where a hull is or
where a ball goes, so every fight is the same fight.

## Decisions already made

Settled with the project owner. Do not re-litigate them; if one turns out to
be unworkable, say so and stop rather than substituting another.

| # | Question | Decision |
|---|---|---|
| 1 | What the AI knows about the player | It reads the player's signal **2 s late**. Position and throttle both. |
| 2 | The AI's helm | **25% of its helm decisions are a coin flip** between faster and slower, ignoring the solution. The other 75% are solved as now. |
| 3 | Ball speed | **Doubled, for both sides.** `BALL_SPEED` 22 to 44. |
| 4 | Telegraphing the AI's shot | The AI commits to a shot **1.5 s before it fires**, and both the scene and the strip show it. The committed shot goes regardless of what the player does after; that is what makes it dodgeable. |
| 5 | Rolling waves | Crests roll across the arena and **shove each hull 2 to 6 units** north, south, east or west when they pass. The hull recovers to its track on its own. |
| 6 | Shoals and wreckage | **Seeded per fight**, static, inside the ring. A ball that meets one is lost. |
| 7 | Drifting flotsam | A raft of debris **drifts across the arena** on a straight line. A hull that touches it is fouled: half speed and no guns for a spell. A ball sinks it. |

The seven items above are the whole scope. Nothing else about the fight
changes: ten rounds, three hits, the shrinking circle, the throttle-only helm,
the cover screen, the payouts and the fades all stay exactly as
`docs/BATTLE_PLAN.md` decided them.

## Units

Everything below is in **arena units**, the flat metres `battle.ts` already
uses: `+z` north, `+x` east, the ring centred on the origin, a hull about 3.1
units long and tested as a point at `HIT_RADIUS` (1.6). "Up, down, left,
right" in decision 5 are north, south, west and east on that frame; which
way they face on screen is `battlescene.ts`'s fixed camera's business.

## What changes in the fight, and what it does to the geometry

### The track and the sway are two different things

Today a hull's position IS its point on the circle. After this, a hull has a
**track** (its angle on the circle, as now) and a **sway** (a displacement
from that point, written by the sea). Its position is the sum. Nothing about
the track changes: the throttle still moves the angle, the ring still
shrinks, the heading is still the tangent.

The gun fires from the hull's actual position, but along the **track's**
inboard beam, `(-cos angle, -sin angle)`, not toward the arena centre. With
no sway those are the same line, which is what `battle.ts` fires down today.
With sway they are not: a hull shoved four units west fires a line parallel
to the diameter and four units off it, and hits only if the enemy has been
shoved the same way. That is the whole of how decision 5 affects aim, and it
falls out of the geometry rather than being a rule.

### What the AI sees

The AI keeps a **two-second-old snapshot** of the player: track angle,
angular speed, and sway. It solves for where the player will be when its ball
arrives by extrapolating that snapshot along the track at the OLD angular
speed for 2 s plus the telegraph plus the flight. It carries the old sway
forward unchanged, since it has no way to predict the sea.

Against a player who does nothing, the extrapolation is exact and the AI is
as good as it is today. Against a player who touches the throttle, everything
the AI does is aimed at the player of two seconds ago. That is the fix.

### The prediction horizon, and the risk in it

The three AI decisions stack. From the moment the AI commits, its ball lands
at

```
2 s (stale)  +  1.5 s (telegraph)  +  2R / 44 (flight: 0.9 s at R0, 0.36 s at R_MIN)
```

ahead of the reading it solved on: about **4.4 s at the opening radius**. A
player only has to change throttle once in that window to step out from
under a solved shot. **The AI may turn out nearly harmless against anyone who
works the helm**, and the sea then fouls and shoves it as well. This plan
implements the decisions as given; the owner should play the result and be
ready to shorten the stale delay or the telegraph. The constants are
authored to be moved.

A consequence to expect: more fights reach `BATTLE_TIMEOUT` (120 s) and end
STAND-OFF. That is fine for this pass and is noted in **Constants** rather
than tuned away blind.

### Doubling the ball

`BALL_SPEED` 44 halves the flight and halves the lead: about fifteen degrees
at the opening radius and six at the closing one, where it was thirty and
twelve. The segment hit test already copes with 4.4 units of travel per
capped tick. `BALL_LIFE` drops from 4 to 2, since it is only a backstop and
a ball now clears the ring in under a second. `SPLASH_MARGIN` and
`HIT_RADIUS` do not move. The scene's pool of twelve balls is untouched: a
side still fires at most once a second and a ball lives less time, so fewer
are ever in the air.

### The telegraph

When the AI finds a solution inside `AI_SOLUTION_TOLERANCE` it **commits**:
it emits an `aim` event, `state.fuse` becomes 1.5 and counts down, and it
fires when the fuse reaches zero whether or not the solution still holds.
There is no reaction and no jitter any more; the fixed fuse replaces both.
The solution it commits to is solved for arrival at `elapsed + 1.5 + flight`.

The scene shows the fuse as a warm light on the enemy hull, dim at commit and
bright at the shot. The strip shows it on the foe side of the header. Both
read `state.fuse`; neither invents its own clock.

### The sea: three seeded systems in one module

All three live in `battlesea.ts`, take the sim's `rng`, and are switched by
`BattleOptions` so the gunner can be measured on a calm sea and a dev query
can turn them off for tuning.

**Crests.** One crest at a time, a line perpendicular to its travel axis. It
is launched at `-(ARENA_R0 + CREST_MARGIN)` on that axis, travels at
`CREST_SPEED`, and is dropped past `+(ARENA_R0 + CREST_MARGIN)`. Its axis is
one of the four cardinals, uniform. The first launches 6 to 10 s into the
fight and each next one 9 to 15 s after the last is dropped. When the crest's
coordinate along its axis passes a hull's TRACK coordinate, that hull is
shoved: a pulse in the crest's travel direction,

```
sway(t) = A * (t / SWAY_TAU) * exp(1 - t / SWAY_TAU)
```

which peaks at `A` (rolled 2 to 6 per hull, independently) at `t = SWAY_TAU`
and is under 5% of `A` by `4 * SWAY_TAU`. A closed form, so there is no spring
to integrate and nothing to go unstable at a capped `dt`. A second shove
before the first has died replaces it. Sway is written as a vector so a
north shove and a later east shove do not interfere in the arithmetic.

**Keel clearance.** Sway is clamped so a hull's distance from the arena
centre never drops below `KEEL_CLEARANCE`. That is what keeps a hull off the
shoals without a grounding rule: every obstacle sits inside
`OBSTACLE_ZONE + OBSTACLE_R_MAX` and the clearance is that plus
`HIT_RADIUS`. At `ARENA_R_MIN` the clamp limits an inward shove to under a
unit, which is the price of not adding a fourth way to lose.

**Shoals and wreckage.** Rolled once, at the sim's construction, from the
same `rng`: 1 to 3 obstacles, each a shoal or a wreck, each a circle of
radius `OBSTACLE_R_MIN` to `OBSTACLE_R_MAX` centred between
`OBSTACLE_R_INNER` and `OBSTACLE_ZONE` from the arena centre, never
overlapping another. They sit inside the ring at every radius the ring ever
has, so no hull ever meets one on its track. What they do is block
diameters: a ball whose sweep this tick passes within an obstacle's radius
is lost with a `strike` event at the point it met it. At those sizes each
obstacle blocks roughly a tenth to a quarter of the ring's diameters, so a
fight has firing lines that are open at some angles and shut at others, and
the throttle becomes a positioning tool as well as a timing one.

**Flotsam.** One raft at a time. It is launched at `ARENA_R0 + FLOTSAM_MARGIN`
on a random bearing, aimed at a random point within `FLOTSAM_AIM` of the
centre, and drifts in a straight line at `FLOTSAM_SPEED` until it is
`FLOTSAM_MARGIN` past the ring on the far side. The first launches 4 to 8 s in
and each next 14 to 22 s after the last is gone. A hull whose position comes
within `FLOTSAM_RADIUS + HIT_RADIUS` of it is **fouled**: the raft is removed
with a `foul` event, the hull's angular speed is halved and its cooldown is
set to `FOUL_SECONDS` for that long. A ball whose sweep meets the raft sinks
it: `strike` event, raft removed, ball removed. So a raft on your side of the
ring is either dodged with the throttle or spent a round on.

The AI does not see the sea. It is shoved, fouled and blocked exactly as the
player is, and does nothing about any of it. That is deliberate for this
pass: the owner asked for a dumber AI, and a helm that dodged rafts would be
a smarter one.

## Modules

The sim is split so four agents can work it without touching one another's
files. `battle.ts` becomes the orchestrator of two new modules and is owned
by the integrating agent alone after step 0.

### `battleconstants.ts`, new

Every tuning constant `battle.ts` exports today, moved here unchanged except
`BALL_SPEED` (44) and `BALL_LIFE` (2). `battle.ts` re-exports all of them so
`battleui.ts`, `main.ts` and the tests keep their imports. The split exists
so `battleai.ts` and `battlesea.ts` can read the ring's numbers without
importing `battle.ts`, which imports them: no cycle.

### `battle.ts`, the fight, orchestrator-owned

Keeps the ring, the throttle, the locker, the cooldowns, the balls, the hit
test, the outcome rules and the events list. Loses the AI (to `battleai.ts`)
and gains the sea (from `battlesea.ts`). Its `update` after step 0:

1. Clear events. Guard `dt`. Advance `elapsed`, shrink `radius`.
2. Player omega from the throttle keys; halved while `player.fouled > 0`.
3. `ai.observe(elapsed, player, omegaPlayer)`: the AI records this tick's
   truth into its delay line.
4. `aiThrottle = ai.throttle(dt, state)`; AI omega from it, halved while
   `ai.fouled > 0`.
5. Advance both angles.
6. `sea.update(dt, elapsed, radius, player, ai, events)`: writes each hull's
   `swayX`/`swayZ` (clamped to keel clearance), counts down `fouled`, moves
   the crest and the raft, launches new ones, and pushes `foul` events.
7. `place()` both hulls: position is track plus sway.
8. Count down cooldowns.
9. Guns, only while `outcome` is null: the player's `fire` if not fouled;
   `ai.gun(dt, state)` returns `'aim'` (push an `aim` event, `state.fuse` is
   now live), `'fire'` (fire the AI's gun) or `null`. A fouled AI does not
   aim.
10. `advanceBalls`: move, hull hit test as now (against the hull's actual
    position), then `sea.strike(from, to)`: a strike point means a `strike`
    event at that point and the ball is gone. Then the splash rule as now.
11. `settle()` as now.

`fire()` changes in one place: direction is the track's inboard beam,
`(-cos angle, -sin angle)`, from the hull's actual `x`/`z`.

### `battleai.ts`, new: the gunner and the helm (decisions 1, 2, 4)

```ts
createBattleAi(rng): {
  /** Record the truth this tick. What `throttle` and `gun` see is this, AI_LAG seconds later. */
  observe(elapsed: number, player: Combatant, omegaPlayer: number): void;
  /** This tick's throttle, +1 or -1. Re-rolled every AI_HELM_PERIOD; one roll in four is a coin. */
  throttle(dt: number, state: BattleState): 1 | -1;
  /** 'aim' the tick a shot is committed, 'fire' the tick it goes, null otherwise. */
  gun(dt: number, state: BattleState): 'aim' | 'fire' | null;
  /** Seconds until the committed shot goes, or null. `battle.ts` copies it onto `state.fuse`. */
  readonly fuse: number | null;
  /** The delayed reading, for tests: what the AI currently believes. */
  readonly view: { readonly angle: number; readonly omega: number; readonly swayX: number; readonly swayZ: number } | null;
}
```

The delay line is a ring of snapshots `{ t, angle, omega, swayX, swayZ }`
pushed every `observe` and read at the newest entry with `t <= elapsed -
AI_LAG`. It is seeded at construction with the player's starting state at
`t = 0`, so the AI has a (correct) reading for the first two seconds rather
than nothing. Bounded: at 60 Hz two seconds is 120 entries; keep 200 and
drop the oldest.

The solution error is today's `solutionError` moved here and solved on the
view: predicted angle is `view.angle + view.omega * (elapsed - view.t +
AI_FUSE + flight)`, where `flight = 2 * radius / BALL_SPEED`, and the target
point is that angle on the ring plus the view's sway. The error is the
lateral offset of that point from the AI's own broadside line, the same
`radius * sin(error)` test with the same `AI_SOLUTION_TOLERANCE` (4) and the
same down-range check.

`throttle`: every `AI_HELM_PERIOD` (1.5 s, as now), roll `rng()`. Below
`AI_HELM_COIN` (0.25) the throttle is `rng() < 0.5 ? 1 : -1`; otherwise it is
the sign of the solution error, as now.

`gun`: with no fuse live, a full locker slot and a cold gun, test the
solution; inside tolerance, set the fuse to `AI_FUSE` (1.5) and return
`'aim'`. With a fuse live, count it down; at zero return `'fire'` and clear
it. A fouled AI (`state.ai.fouled > 0`) neither aims nor fires, and a fuse
already lit when it is fouled is snuffed. There is no reaction and no
jitter; `AI_REACTION_MIN`, `AI_REACTION_MAX` and `AI_JITTER` are deleted.

### `battlesea.ts`, new: crests, obstacles, flotsam (decisions 5, 6, 7)

```ts
interface SwayTarget { readonly angle: number; swayX: number; swayZ: number; fouled: number; cooldown: number; }

createBattleSea(rng, options: BattleOptions): {
  readonly state: { readonly crest: ArenaCrest | null; readonly obstacles: readonly ArenaObstacle[]; readonly flotsam: ArenaFlotsam | null };
  update(dt: number, elapsed: number, radius: number, player: SwayTarget, ai: SwayTarget, events: BattleEvent[]): void;
  /** The point where the sweep (ax,az)-(bx,bz) first meets an obstacle or the raft, or null. Meeting the raft sinks it. */
  strike(ax: number, az: number, bx: number, bz: number): { x: number; z: number } | null;
}
```

`battle.ts`'s private `MutableCombatant` satisfies `SwayTarget` structurally;
nothing is exported for it. The three `state` fields are exposed on
`BattleState` by `battle.ts` as the same objects, read-only.

Everything in here rolls from the `rng` it is handed and nothing else, so a
seeded fight is a repeatable fight. The obstacles are rolled in the
constructor, before the first `update`, so the scene can place them on its
first frame. Options that are off produce nothing: no crest, an empty
obstacle list, no raft, and `strike` always null.

### `battlescene.ts`: the fuse, the crest, the props, the raft (all four visible decisions)

Nothing about the sea shader, the lights' grading, the camera or the hulls'
placement changes. Everything added is built at construction and adopted by
the existing `postFx.adopt(root)` walk, on the rule already in the file: a
mesh added later misses that walk and a light added later recompiles every
material under it.

- **Fuse.** A fourth `PointLight`, warm, at the AI hull's gun deck, intensity
  ramping from `FUSE_LOW` to `FUSE_HIGH` as `state.fuse` runs from 1.5 to 0,
  and off while `fuse` is null. `MAX_FLASHES` stays 3; this is its own light,
  allocated with them.
- **Crest.** One long, thin, translucent quad (`CREST_LENGTH` by
  `CREST_WIDTH`) flat on the water a hair above it, in the splash rings'
  colour, oriented across the crest's axis and moved along it from
  `state.crest`. Hidden when null. When it is within `CREST_WIDTH` of a
  hull, that hull's bob gets an extra heave and a roll about its bow, so the
  shove reads as the wave and not as a glitch. Sway itself needs no drawing:
  the hull is placed from `x`/`z`, which already include it.
- **Obstacles.** A pool of three, each carrying one shoal (a flattened dark
  sphere, mostly under the water, with a ring of foam) and one wreck (a dark
  box hull heeled over with a stub of mast), only one of the two visible per
  slot. Placed from `state.obstacles` on every `update`, which is three
  position writes and free.
- **Raft.** One cluster of small dark boxes at a slight tilt, placed from
  `state.flotsam`, hidden when null.
- **Events.** `strike` pops a splash ring at the strike point, exactly as
  `splash` does, plus a brief spray-coloured flash from the flash pool.
  `foul` does nothing in the scene beyond what the raft vanishing already
  shows; `aim` does nothing, the fuse light carries it.
- **Fouled hull.** While `fouled > 0`, the hull is listed a few degrees to
  the side, so a fouled ship reads as fouled.

### `battleui.ts` and its `index.html` / `style.css` blocks

- A fuse element on the foe side of the strip: hidden while `state.fuse` is
  null, a short bar draining over the fuse's length while it is live, in the
  foe's own colour. Read off `state.fuse` only; no timer of its own.
- A FOULED word over the player's side while `player.fouled > 0`, and the
  prompt updated to mention it once.
- The `aim` event, if the strip wants a one-frame pulse on the fuse bar the
  tick it lights.

Nothing else. The strip still prints only figures it was handed.

### `battlecover.ts`

The blurb sentence is built from `ROUNDS` and `HITS_TO_LOSE` and says
nothing about the sea. Add one clause, from constants where a constant
exists, that the sea will shove you and the wreckage will eat your shot.
Keep it one sentence; the count is three seconds.

### `main.ts`

`createBattleSim(undefined, battleOptions)`, where `battleOptions` is all
three sea features on unless the dev query `?calm=1` is present, in which
case all three are off. The query joins `?boat` and `?battle` in the dev
block and is documented beside them. `state.fuse` needs no plumbing: the
scene and the strip read the state they are already handed.

### Docs

`docs/ARCHITECTURE.md`, **AI boats and the battle**: a subsection on the
track and the sway (and why the gun fires along the track's beam), one on
what the AI sees and the prediction horizon, one on the sea being switched
by options and the gunner being pinned on a calm sea. `README.md`'s feature
line. This plan is a record and is not updated to follow later tuning, on the
rule `docs/WIND_PLAN.md` states.

## The contract: types and stubs

Landed by the orchestrator in step 0. The signatures are the contract; agents
develop against them and drop their real modules in without changing them.

`types.ts`:

```ts
export interface Combatant {
  // as now, plus:
  /** Displacement from the track, arena units, written by the sea. Position is track plus this. */
  readonly swayX: number;
  readonly swayZ: number;
  /** Seconds of fouling left, 0 when clear. Half speed and no guns while positive. */
  readonly fouled: number;
}

export interface ArenaCrest { readonly axis: 'north' | 'south' | 'east' | 'west'; /** Position along the axis, arena units. */ readonly at: number; }
export interface ArenaObstacle { readonly kind: 'shoal' | 'wreck'; readonly x: number; readonly z: number; readonly radius: number; /** Radians, for the wreck's heel. */ readonly yaw: number; }
export interface ArenaFlotsam { readonly x: number; readonly z: number; readonly vx: number; readonly vz: number; readonly radius: number; }

export interface BattleOptions { readonly waves: boolean; readonly shoals: boolean; readonly flotsam: boolean; }

export interface BattleEvent {
  /** `aim`: the AI has committed, at its hull. `strike`: a ball met an obstacle or the raft, at that point. `foul`: a hull met the raft; `owner` is the hull fouled. */
  readonly kind: 'fire' | 'hit' | 'splash' | 'aim' | 'strike' | 'foul';
  readonly owner: 'player' | 'ai';
  readonly x: number;
  readonly z: number;
}

export interface BattleState {
  // as now, plus:
  /** Seconds until the AI's committed shot goes, or null while nothing is lit. */
  readonly fuse: number | null;
  readonly crest: ArenaCrest | null;
  readonly obstacles: readonly ArenaObstacle[];
  readonly flotsam: ArenaFlotsam | null;
}
```

Stubs:

```ts
createBattleSim(rng?, options?): { state; update(dt, input) }          // orchestrator: real, calling the two stubs below
createBattleAi(rng): { observe; throttle; gun; fuse; view }              // A: stub throttles +1, never aims, fuse null
createBattleSea(rng, options): { state; update; strike }                 // B: stub holds an empty state, writes sway 0, strike null
createBattleScene(quality, postFx?): unchanged signature                 // C
createBattleUi(deps): unchanged signature                                // D
```

`npm run build` and `npm test` must be green at the end of step 0 and stay
green for every agent. With both stubs in place the fight plays exactly as it
does today except that the ball is twice as fast and the AI never fires; the
existing gunner test is marked `.skip` by the orchestrator with a note and
un-skipped by agent A.

## Constants

All authored, all in the module that uses them. Move any of them, but move
them knowing what they are.

| Constant | Value | Where | What it is |
|---|---|---|---|
| `BALL_SPEED` | 44 | `battleconstants.ts` | Decision 3. Was 22. |
| `BALL_LIFE` | 2 | `battleconstants.ts` | Backstop only. Was 4; a ball now clears the ring in under a second. |
| `AI_LAG` | 2 | `battleai.ts` | Decision 1. Seconds the AI's reading of the player runs behind. |
| `AI_HELM_PERIOD` | 1.5 | `battleai.ts` | As now. |
| `AI_HELM_COIN` | 0.25 | `battleai.ts` | Decision 2. Fraction of helm decisions that are a coin flip. |
| `AI_FUSE` | 1.5 | `battleai.ts` | Decision 4. Seconds from commit to shot. Replaces the reaction and the jitter. |
| `AI_SOLUTION_TOLERANCE` | 4 | `battleai.ts` | As now. The dial that moves the hit rate. |
| `CREST_SPEED` | 7 | `battlesea.ts` | Units/s. Crosses the ring's diameter in about six seconds. |
| `CREST_MARGIN` | 8 | `battlesea.ts` | How far outside `ARENA_R0` a crest is born and dies. |
| `CREST_FIRST` | 6 to 10 | `battlesea.ts` | Seconds before the first crest. |
| `CREST_GAP` | 9 to 15 | `battlesea.ts` | Seconds from one crest's end to the next's start. |
| `SWAY_MIN`, `SWAY_MAX` | 2, 6 | `battlesea.ts` | Decision 5. Peak shove, per hull, per crest. |
| `SWAY_TAU` | 0.8 | `battlesea.ts` | Seconds to the peak of the pulse; back under 5% by four of these. |
| `KEEL_CLEARANCE` | 7.1 | `battlesea.ts` | `OBSTACLE_ZONE + OBSTACLE_R_MAX + HIT_RADIUS`. No hull's centre is ever nearer the middle than this. |
| `OBSTACLE_COUNT` | 1 to 3 | `battlesea.ts` | Decision 6. Rolled once per fight. |
| `OBSTACLE_R_INNER`, `OBSTACLE_ZONE` | 2, 4 | `battlesea.ts` | Where an obstacle's centre may sit, from the arena centre. |
| `OBSTACLE_R_MIN`, `OBSTACLE_R_MAX` | 1.0, 1.5 | `battlesea.ts` | Its radius. |
| `FLOTSAM_SPEED` | 2.5 | `battlesea.ts` | Units/s. About twenty seconds to cross the ring; a lap at the base rate is twenty-one. |
| `FLOTSAM_RADIUS` | 1.2 | `battlesea.ts` | Contact is this plus `HIT_RADIUS`, so 2.8 centre to centre. |
| `FLOTSAM_MARGIN` | 6 | `battlesea.ts` | Born and dies this far outside `ARENA_R0`. |
| `FLOTSAM_AIM` | 0.9 × `ARENA_R0` | `battlesea.ts` | Its track passes within this of the centre, so it always crosses the ring. |
| `FLOTSAM_FIRST` | 4 to 8 | `battlesea.ts` | Seconds before the first raft. |
| `FLOTSAM_GAP` | 14 to 22 | `battlesea.ts` | Seconds from one raft's end to the next's start. |
| `FOUL_SECONDS` | 2 | `battlesea.ts` | Decision 7. Half speed, no guns. |
| `BATTLE_TIMEOUT` | 120 | `battleconstants.ts` | Unchanged. Expect it to be reached more often; retune only after the owner has played it. |

## Tests

Tier 1 only, all deterministic through the sim's `rng`, all against the
`BattleOptions` that isolate what they measure. Keep the whole unit tier near
its two seconds; the 200-fight gunner case is the expensive one and there
should be exactly one of it per sea state.

**A, `tests/unit/battleai.test.ts` and the gunner case in `battle.test.ts`:**

- A player who holds S from `t = 5` is still read at the base rate by
  `ai.view` until `t = 7`, and at the slowed rate from `t = 7` (one tick of
  slop).
- Over 4000 helm decisions against a fixed positive error, between 10% and
  15% of throttles are `-1` (a coin lands wrong half the time it is flipped).
- Every AI `fire` event is preceded by exactly one `aim` event `AI_FUSE`
  earlier, to a tick; `state.fuse` is null outside that window and never
  negative.
- A fouled AI never aims, and a fuse lit before a foul is null the tick after.
- The gunner on a calm sea (all options off) against an idle player over 200
  seeded fights: **measure, then pin ±10 points around the measurement**, and
  say in the test what was measured. The band as written (35% to 55%) is a
  measurement of the old gunner and must not be kept out of habit.

**B, `tests/unit/battlesea.test.ts`:**

- Same seed, same obstacles; count in 1 to 3; every centre between
  `OBSTACLE_R_INNER` and `OBSTACLE_ZONE`; no two overlap.
- A crest launched east shoves an idle hull between 2 and 6 units east at the
  peak and back under 0.1 within 4 s; the track angle does not move.
- Over 60 s of crests, no hull's distance from the centre is ever under
  `KEEL_CLEARANCE`.
- A ball whose sweep crosses a shoal produces a `strike` and no `splash`;
  one that passes it by produces a `splash`.
- A raft launched at a hull's position fouls it for `FOUL_SECONDS`, halves its
  angular speed for exactly that long, and is gone; a ball sweep through a
  raft sinks it with a `strike`.
- Two sims built from the same seed and driven by the same input agree on
  every position to the last bit after 60 s.

**Orchestrator, in `battle.test.ts`, after integration:** with every option
on, 200 seeded fights against an idle player all reach an outcome, and the
AI lands more than a floor the orchestrator measures. One case; it is the
only thing that pins the whole system.

No test asserts on how anything looks. C has no tests; C's `npm run build`
and the existing smoke `?battle=1` case are its gate.

## Work split

Four agents in parallel, in the same working tree, after one preparatory
step by the orchestrator. Files are partitioned so no two agents write the
same file; the two shared files (`index.html`, `style.css`) already carry
marked BATTLE blocks and only agent D edits inside them, **with Edit, never
Write**.

**Step 0, orchestrator.** Land the `types.ts` changes above. Create
`battleconstants.ts` and move the constants (with `BALL_SPEED` 44 and
`BALL_LIFE` 2), re-exported from `battle.ts`. Create the two stubs. Rewrite
`battle.ts`'s `update` to the eleven steps above, calling the stubs; add
`swayX`, `swayZ`, `fouled` to its combatant and `fuse`, `crest`,
`obstacles`, `flotsam` to its state; fire along the track's beam. Delete the
old AI from `battle.ts`. Mark the gunner test `.skip` with a note naming
agent A. `npm run build`, `npm test` green. Commit.

| Agent | Owns | Deliverable |
|---|---|---|
| **A, gunner** | `battleai.ts`, `tests/unit/battleai.test.ts`, the gunner `describe` in `tests/unit/battle.test.ts` | Decisions 1, 2, 4 on the sim side: the delay line, the coin, the fuse, the solution solved on the view. Un-skips and re-pins the gunner case. Touches nothing else. |
| **B, sea** | `battlesea.ts`, `tests/unit/battlesea.test.ts` | Decisions 5, 6, 7 on the sim side: crests and sway, keel clearance, seeded obstacles, the raft, `strike`, and the `foul` events. Touches nothing else. |
| **C, render** | `battlescene.ts` | The fuse light, the crest quad and the hull heave under it, the three obstacle slots, the raft, the `strike` splash, the fouled list. Everything built at construction, adopted once. Looks at `?battle=1` and `?battle=1&calm=1` through `npm run shots` and leaves the pictures. |
| **D, UI, loop, docs** | `battleui.ts` and its blocks in `index.html` / `style.css`, `battlecover.ts`, `main.ts`, `docs/ARCHITECTURE.md`, `README.md` | The fuse bar and FOULED word, the cover clause, `BattleOptions` from `?calm=1`, the docs. Develops against the stubs; A's and B's modules drop in without a signature change. |

`battle.ts` is edited by nobody during steps 1 to 4. An agent that finds the
contract wanting says so and stops, per **Decisions already made**.

**Step 5, orchestrator, integration.** `npm run build`, `npm test`, add the
all-options-on case, then `npm run test:all` **once**. Then launch a preview
and look, per the budget in `docs/TESTING.md`:

- `?battle=1&calm=1`: the fight plays as before except the ball is quick and
  the enemy hull glows for a second and a half before every one of its shots.
  Hold W the moment it glows: the ball splashes behind you. Do nothing: it
  lands about as often as the pinned band says. Watch the enemy's speed for a
  minute: it visibly picks the wrong way now and then.
- `?battle=1`: within ten seconds a crest sweeps the arena and both hulls
  lurch sideways and settle back; one to three shoals or wrecks sit inside
  the ring; a shot across one throws spray and no pip fills; a raft drifts
  through, and a hull that meets it lists, slows and stops firing for two
  seconds; a round put into the raft sinks it.
- Play three fights each way and note how many end STAND-OFF and how the
  active-player hit rate feels; that is the number the owner will tune from.
- The Vite log and the browser console show no shader errors. A green build
  is not a pass.

## What it measured, once it was built

Added after the work landed, as the record of what the seven decisions
actually produced. Measured 2026-09-08 over 200 seeded fights per row, on
`ROUGH` unless the row says otherwise, against simulated players. Not
playtesting: no human has held the keys yet, and every figure below is a
robot's approximation of one. Read them as bounds, not as verdicts.

**The gunner, against a player who does nothing.** 46.5% before the rework,
**30.1% after**, on the sea the game is played on. On `CALM` the same gunner
scores 68.6%, which is why the calm figure is a laboratory isolate and is
pinned separately: two thirds of the fight's fairness is the sea, not the
gunner.

**The telegraph is the whole fight.** One simulated captain, timing shots
well, played twice against the same 200 seeds:

| The captain | Foe's hit rate | Won | Lost | Drawn |
|---|---|---|---|---|
| Ignores the lit fuse | 30% | 49 | 104 | 47 |
| Breaks off when the fuse lights | 4% | 150 | 3 | 47 |

Reading the fuse takes the enemy from 30% to 4%. Decision 4 is doing what it
was for, and it is doing nearly all of the work: a player who learns one
thing about this fight should learn that one.

**The floor and the ceiling are far apart.** A captain who fires blind and
steers at random hits about 5% and draws three fights in four, because ten
rounds at that accuracy cannot find three hits. A captain who times the shot
and reads the fuse hits 36% and loses three fights in two hundred. Fights run
23 to 42 seconds and essentially never reach the two-minute timeout once
anybody is firing, so the STAND-OFF the plan feared is a draw on two empty
lockers rather than a clock running out.

**What to watch when playing it.** The ceiling may be too kind: 150 wins to 3
losses is a fight that stops being one once the trick is known. If it plays
that way, the lever is `AI_FUSE` — a shorter fuse leaves less room to step
out from under the shot — and NOT `AI_LAG`, which is what keeps the enemy
beatable by steering at all. Neither should move before the owner has played
it, per the decisions above.

## Out of scope

The AI seeing or avoiding anything the sea does. Wind in the arena. Balls
that curve, drift or are moved by a crest in flight. A grounding or ramming
outcome. More than one crest, raft or enemy at a time. Sound. Any change to
the payouts, the cover's count, the fades, the world's raiders, or the
world's own hazards. Retuning `BATTLE_TIMEOUT`, `AI_LAG` or `AI_FUSE` before
the owner has played the result.
