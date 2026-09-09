# AI boats and the cannon battle: implementation plan

Status: **draft, awaiting owner review. No code written.**

This document is the complete brief. An implementing agent should not need the
conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**Units, pinned**, **Ship dynamics**, **Frame loop**, **Fishing** (the pause
contract) and **Hazards**, and `docs/TESTING.md` for the budget every agent
below is held to. `docs/HAZARDS_PLAN.md` is the closest precedent: a seeded
event system that spawns things around the hull, tests contact, and hands the
ship over to a scripted sequence.

## Decisions already made

Settled with the project owner. Do not re-litigate them; if one turns out to be
unworkable, say so and stop rather than substituting another.

| Question | Decision |
|---|---|
| Two kinds of AI boat | The current hull model, recoloured. **Red** rim and neon: aggressive. **Orange** rim and neon: random encounter. |
| Red boat | Spawns **40 to 60 units** from the player on any bearing, runs at **20 kn**, pursues for **5 to 8 s**. |
| Orange boat | Spawns **30 to 50 units** away, runs at **15 kn** on a **fixed straight track** for **5 to 8 s**, then is gone. |
| Red boat that never connects | When its pursuit clock runs out it **becomes an orange boat**: picks a random heading and runs straight for a fresh 5 to 8 s. |
| Escapable pursuit | **Yes.** The red boat keeps its 20 kn but has a wide turning circle and a short clock, so a hard turn across or away from its bow can shake it. It is not meant to be a countdown to a fight the player cannot dodge. |
| Radar | Both kinds are plotted, in their own colour, only while inside `RADAR_RANGE`. |
| What starts a fight | **Any hull contact with either colour**, including the player ramming an orange boat on purpose. |
| Spawn cadence | Seeded roll **every 10 s**, independent draws for red and orange, **at most one live boat of each colour**. |
| Suppression | No spawn and no contact while the ship is **docked**, while any **overlay** is up, while a **blackout** is running, or while a **maelstrom** has the hull. A red boat that reaches a docked ship gives up and turns orange. |
| Where the fight happens | A **separate battle screen**: the world is frozen exactly as it is under the fishing card, and a dedicated arena scene with flat open ocean and its own camera is rendered instead. The player's world position is restored afterwards. |
| Choreography | Both boats **circle in slowly from opposite sides**. The player can **speed up or slow down** on the circle with W/S. No free steering. |
| Cannon | **Timed broadside.** Space fires a cannonball straight out of the ship's inboard side, at most **one per second**, **10 rounds** per side. It hits only if the enemy hull is in that line when the ball gets there, so the circling makes firing windows and the shot is a timing skill. |
| AI gunnery | The AI fires when it has a firing solution, after a reaction delay, with a timing jitter that turns into misses. |
| Losing | **Three hits** on a hull lose the fight. |
| Draw | Both sides out of rounds, every ball landed, and neither hull on three hits. Also: both third hits in the same tick. |
| On a loss | Main tank to **zero**. Backup cell to **10%** if it held more than **20%**, otherwise to **zero**. Lose **10% of gold**, clamped to **500 minimum, 10,000 maximum**; a purse under 500 is emptied. |
| On a win | Gain gold from a **tiered table** between **500 and 20,000**, small sums common and large sums rare. The tiers are proposed below for review. |
| On a draw | Lose **25 points** of the main tank. Gold moves by a uniform amount in **[-1000, +1000]**. |
| Aftermath | The AI boat **disappears in all three outcomes**. The player returns to the exact spot and heading of the contact, stopped. |
| Rim lighting | **Both**: the existing neon emissives recoloured, plus a Fresnel rim glow around the whole hull, in the boat's colour. |

Two smaller points the owner has not been asked and this plan decides, flagged
so they can be overturned cheaply:

- **"25% main battery" on a draw is 25 percentage points** of the bar the HUD
  shows, floored at zero, not a quarter of whatever was held. A wreck keeps a
  fraction; a bruise costs a fixed amount. If the owner meant the fraction, it
  is a one-line change in `energy.stalemate()`.
- **Backup percentages are in the HUD's unit**: percent of a main tank, the
  same unit `hud.ts` prints and `save.ts` stores. A cell holds 50 at most, so
  "above 20%" means above `0.20` in tank fractions and "10%" means `0.10`.

## Units

- "kn" is a **world unit per second** everywhere, the unit `hud.ts` prints as
  a knot. 20 kn is twice the player's `MAX_FORWARD`.
- All distances are **ship-scale**: absolute world units sized against the
  hull, converted to direction space (divided by `GLOBE_RADIUS`) at the point
  of use, as hazards are.
- The arena is a **flat plane in world units**. Nothing in it is on the globe.
  Its coordinates are plain `x`/`z` metres with `+y` up; the hull is drawn at
  `MODEL_SCALE`, mounted at `MODEL_MOUNT_Y`, exactly as in the world.
- Battle time is **seconds**, `dt` already clamped by `main.ts`.

## Proposed win tiers

Uniform within a tier, integer gold.

| Chance | Range |
|---|---|
| 60% | 500 to 1,500 |
| 25% | 1,500 to 4,000 |
| 10% | 4,000 to 10,000 |
| 5% | 10,000 to 20,000 |

Expected value a little under 2,800 gold per win. A loss costs 10% of the
purse, so a player holding 30,000 stakes 3,000 against roughly the same in
expectation, and a player holding 5,000 stakes the 500 floor. That keeps a
fight worth taking at every purse size without making it a gold printer.

## Design choices, with the trade-offs

The owner asked for the pros and cons of every solution. These are the ones
that were not already settled above.

**The arena is a second `THREE.Scene`, rendered through the same `postFx`.**
The world scene stays exactly where the fishing card leaves it: frozen, not
touched. `postFx.render(dt, scene, camera)` already takes both arguments, so
switching scenes is a matter of which pair the loop passes.
Pros: an empty ocean is guaranteed; no land, berths, hazards or wind can
intrude; the camera is trivial; the world needs no teleport and no restore
beyond `ship.halt()`. Cons: a second sea shader, a simple one; the player's
hull has to be reparented into the arena and back; the sail and flag do not
animate in the arena unless `ship.ts` grows a way to tick its fx without
moving the hull, which this plan leaves out.

**The player's real hull is reparented into the arena, not cloned.**
`ship.ts`'s `applyTransform` rebuilds `object.position` and `object.quaternion`
from scratch every frame, so the arena can drive `ship.object` directly for the
length of the fight and the first world frame afterwards puts it back where the
state says. Pros: the exact neon, textures and charge dimming the player has,
with no second copy of a 5 MB model's materials. Cons: `main.ts` has to move a
child between scenes in both fades, and any future code that assumes
`ship.object` never leaves the world scene will be surprised. Documented in
`ARCHITECTURE.md`.

**The AI hull is a deep clone of the loaded glTF, geometry shared, materials
cloned.** `ship.ts` exposes `cloneHull()` after `ready`. Pros: no second
download, no second `GLTFLoader`, and the recolour cannot bleed into the
player's materials because every material is cloned. Cons: the sail and flag
geometry are shared, so the AI's cloth deforms in step with the player's,
and `shipfx.ts` is not run on the clone at all, so its neon does not pulse.
Both are invisible at radar distances and acceptable in the arena.

**Rim glow is an `onBeforeCompile` patch on the cloned materials.** The
Fresnel term is added to the emissive: `rim = pow(1 - saturate(dot(N, V)), 3)`
times the boat colour times `RIM_STRENGTH`. Pros: the whole silhouette lights
up in the boat's colour, which is what separates an AI boat from the player at
sixty units, and the bloom already catches emissive. Cons: it is a shader
patch on stock materials, so it must be installed **before** `postFx.adopt`
chains its own hook, per **Post-processing** in `ARCHITECTURE.md`. Install
it in `cloneHull`'s caller before adopting.

**AI boats do not ride the wave field.** They sit at the flat sea radius with
a small authored bob. Pros: no `sampleWave` taps per boat per frame, no
hazard height taps. Cons: a red boat crossing a great wave sails through it.
Accepted; a crest is a two-second event and the boat is a moving target.

**The red boat uses pure pursuit with a capped turn rate.** Each frame it
turns toward the player's **current** position at no more than
`RED_TURN_RATE = 50°/s`. At 20 kn that is a turning circle of about 23 units
radius, roughly seven hull lengths; the player at 10 kn and `TURN_RATE` 1.2
rad/s turns inside 9 units. Pros: a player who turns hard can get inside the
chaser's circle and it will overshoot, and a 5 to 8 s clock does not leave it
time for a second pass. Cons: the numbers are a first guess and will need a
tuning session with `?boat=red`. Lead pursuit (aiming ahead of the player)
was rejected: it makes the chaser markedly harder to shake and the owner
chose escapable.

**Orange headings are biased toward the player's path.** Half of orange
spawns aim their straight track at the player's position advanced by four
seconds of velocity, offset by up to 12 units across; the other half take a
uniform heading. Pros: a fixed-track boat with a uniform heading essentially
never crosses the player, and the owner wants contact with orange boats to be
possible; the bias is the same trick the crests use. Cons: an orange boat is a
little less "random" than the name says. A player who does not want the fight
can steer clear; the track never changes.

**Contact is a circle test.** Two hulls are in contact when their centres are
closer than `CONTACT_RADIUS = 2.4` units, about three quarters of a hull
length. Pros: one great-circle distance per boat per frame. Cons: a bow-on
touch and a beam-on touch count the same, and two hulls passing close abeam
may register slightly early. Good enough for a 3-unit hull.

**Broadside geometry in the arena.** Both boats travel counter-clockwise on
the same circle about the arena's centre, so each boat's inboard beam points
at the centre and a broadside is a chord through it. The ball meets the enemy
only if the enemy is at, or leads onto, the far end of that diameter when the
ball arrives. Pros: the firing window is a real thing the player can see and
learn: fire as the enemy comes onto the line, a little early to lead it.
Cons: with both boats at the same angular speed they sit opposite forever and
the window is always open. That is why W/S exist: the player pulls ahead or
drops back, the enemy follows at its own pace, and both boats' windows open
and close.

**AI aim is a reaction plus a jitter, not a hit-chance roll.** When a lead
solution exists the AI commits to fire after `AI_REACTION` (uniform 0.2 to
0.6 s) and its fire time is offset by `AI_JITTER` (uniform -0.35 to +0.35 s).
Pros: misses come from the same geometry the player's do, so a player who
speeds up mid-flight dodges the AI's ball, and the AI can be made harder or
easier with two numbers. Cons: the effective hit rate is emergent and must be
measured (target: 40 to 50% of AI shots hit a player who does nothing).

**One extra branch in the frame loop, not a mode enum.** The loop already
asks the overlays `isOpen` each frame; the battle is one more live getter,
tested first. Pros: the pause contract stays derived, not latched. Cons: the
loop gains its third branch; the battle branch renders a different scene, so
it cannot share the frozen-frame branch's `postFx.render(0, ...)`.

## Modules

Seven new files. Sim and rendering are split the way `hazards.ts` and
`waterhazard.ts` are, and the battle rules are DOM-free the way `fishsim.ts`
is, so both can be unit tested in Node.

| File | Exports | Notes |
|---|---|---|
| `aiboats.ts` | `createAiBoats(deps)`, `AiBoatsDeps`, `AiBoats`, `ROLL_PERIOD`, the spawn and pursuit constants | the world sim: roll, spawn, transport, pursuit, conversion, contact. Owns `AiBoatState`, mutated in place. DOM-free, scene-free, seeded. |
| `aihulls.ts` | `createAiHulls(scene, cloneHull)`, `AiHulls` | the scene objects: one hull clone per live boat, placed on the globe from `AiBoatState` each frame; recoloured neon; the rim patch; fade-out. |
| `rimglow.ts` | `installRimGlow(root, color, strength)`, `RIM_STRENGTH` | the Fresnel `onBeforeCompile` patch on every `MeshStandardMaterial` under `root`; sets a `uRimColor` and `uRimStrength` uniform pair. Used only by AI hulls. |
| `battle.ts` | `createBattleSim(rng?)`, `BattleSim`, `BattleState`, `BattleInput`, the arena constants | the whole fight in flat world units: the circle, W/S, the rounds, the balls, hits, the AI gunner, the outcome. No DOM, no Three. |
| `bounty.ts` | `WIN_TIERS`, `rollWinGold(rng)`, `lossGold(purse)`, `rollDrawGold(rng, purse)` | data and pure functions for the three gold outcomes. |
| `battlescene.ts` | `createBattleScene(quality)`, `BattleScene` | the arena `Scene`, its sea plane, lights, camera, the cannonballs and splashes; `enter(playerHull, aiHull, sunElevation)`, `update(dt, state)`, `exit()`. |
| `battleui.ts` | `createBattleUi(deps)`, `BattleUi` | the overlay: the rounds and hits strip, the FIRE button, Space capture, the result card, `isOpen` as a live getter. |

### `aiboats.ts`, the sim

```ts
export type AiBoatKind = 'red' | 'orange';
export type AiBoatPhase = 'pursue' | 'wander';

export interface AiBoat {
  readonly kind: AiBoatKind;             // red turns orange on conversion
  readonly phase: AiBoatPhase;           // 'pursue' only while red
  /** Unit direction of the centre. Mutated in place as the boat moves. */
  readonly position: Vector3;
  /** Unit tangent, direction of travel. */
  readonly forward: Vector3;
  readonly speed: number;                // world units/s: RED_SPEED or ORANGE_SPEED
  /** Seconds left in the current phase. */
  readonly clock: number;
  /** 0..1 fade-in and fade-out, for the neon and the rim. */
  readonly envelope: number;
}

export interface AiBoatState {
  readonly live: readonly AiBoat[];      // length <= 2, at most one per kind
  /** Seconds of spawn suppression left after a fight. */
  readonly grace: number;
}

export interface AiBoatsDeps {
  terrain: Terrain;
  heightMap: HeightMap;
  waterBodies: WaterBodies;
  towns: Towns;
  seed?: number;
  /** Fired once, the frame a hull touches the player. `main.ts` opens the battle. */
  onContact: (boat: AiBoat) => void;
}

export function createAiBoats(deps: AiBoatsDeps): {
  readonly state: AiBoatState;
  /** After `hazards.update`, before `ship.update`. Needs this frame's docked verdict and the hazard phase. */
  update(dt: number, ship: ShipState, energy: EnergyState, hazards: HazardState, suppressed: boolean): void;
  /** Removes `boat` (the one that started a fight) and starts the grace period. */
  remove(boat: AiBoat): void;
  /** Spawns one boat now, at `position` heading `forward`. Tests and the dev query only. */
  force(kind: AiBoatKind, position: Vector3, forward: Vector3): void;
};
```

**The roll.** A timer fires every `ROLL_PERIOD = 10` s. For each kind in a
fixed order (`red`, `orange`): if no live boat of that kind exists, `grace`
is zero, the ship is not suppressed, and `rng() < P[kind]`, spawn one.
Always draw the number, even when the spawn is skipped, so the seeded stream
stays in step. `P_RED = 0.08`, `P_ORANGE = 0.12` as first written — both have
moved a long way since, and in opposite directions; see the tuning table at the
foot of this file and **An orange boat is weather** in `ARCHITECTURE.md`. On
the original figures, over a ten-minute sail
that is about five red and seven orange, before suppression.

> **Retuned after shipping (2026-09-07, owner's call): both doubled, to 0.16
> and 0.24.** The figures above are what was designed and are left as written,
> on this document's terms; `aiboats.ts` is the authority on what the game
> actually rolls. The nominal ten-minute counts double with them, to about ten
> and fourteen, but the sea delivers fewer than that and by a wider margin than
> it used to: only one boat per colour is ever live, and at these odds a colour
> is far more often already out when its draw comes up.

`suppressed` is computed by `main.ts` as `energy.mode === 'docked' ||
blackout.active || hazards.state.phase !== 'free'`. Overlays never reach
this function: the loop does not call it under one.

**Spawning.** Up to 24 attempts, then give up until the next roll:

1. Distance `d` uniform in `[RED_SPAWN_MIN, RED_SPAWN_MAX] = [40, 60]` for
   red, `[ORANGE_SPAWN_MIN, ORANGE_SPAWN_MAX] = [30, 50]` for orange.
2. Bearing uniform over the compass. Resolve at the ship with `tangentFrame`
   and walk `d / GLOBE_RADIUS` along it with the great-circle step
   `ship.ts`'s `stepAlong` uses.
3. Accept only if the point is **water**, **reachable**, and no berth's
   centre is within `DOCK_RADIUS + BERTH_MARGIN` (4 units) of it.
4. Red: `forward` points at the player. `clock` uniform in `[5, 8]`,
   `phase = 'pursue'`.
5. Orange: with probability `ORANGE_AIM_SHARE = 0.5`, `forward` points at the
   player's position advanced by `ship.velocity × 4 s` and offset uniform
   `[-12, 12]` units along the ship's starboard, projected onto the tangent
   plane at the spawn; otherwise uniform. `clock` uniform in `[5, 8]`,
   `phase = 'wander'`.

A spawn far outside `RADAR_RANGE` (red at 50 to 60) is invisible until it
closes; that is the owner's intent, so no bearing bias is applied to red.

**Transport.** Each frame the boat's `position` is advanced along `forward`
by `speed × dt` (great-circle step), and `forward` is parallel-transported
across the step, `wind.ts`'s way. A boat whose centre lands on land
(`heightMap.sample >= terrain.seaLevel`) or on unreachable water is removed
that frame: the cheapest rule and the one the crests use.

**Pursuit.** While `phase === 'pursue'`: the bearing to the player's current
position is resolved in the boat's tangent frame; `forward` is rotated
toward it about `position` by at most `RED_TURN_RATE = 50°/s × dt`. Pure
pursuit, no lead. `clock -= dt`; at zero the boat **converts**: `kind =
'orange'`, `phase = 'wander'`, `speed = ORANGE_SPEED`, `forward` set to a
uniform random tangent, `clock` uniform in `[5, 8]`. A red boat that reaches
a docked ship converts the same way (the `suppressed` flag).

**Wander.** `clock -= dt`; the last `FADE_OUT = 1` s runs `envelope` 1 to 0;
at zero the boat is removed. The first `FADE_IN = 0.5` s after any spawn runs
`envelope` 0 to 1. Conversion does not fade.

**Contact.** Each frame, for each live boat, if not suppressed and `grace`
is zero: great-circle distance from the ship to the boat's centre
`< CONTACT_RADIUS = 2.4` units fires `onContact(boat)` **once**; the boat is
marked so it cannot fire again until `remove` takes it. `main.ts` halts the
ship and opens the battle; `remove` runs after the fight.

**Grace.** `remove` sets `grace = SPAWN_GRACE = 30` s, decremented each
frame. No roll spawns and no contact fires while it is positive, so a player
back from a fight is not rammed by the other colour on the first frame.

### `aihulls.ts`, the scene objects

Holds up to two hull clones in a pool, built lazily from `cloneHull()` the
first time a boat of each kind is needed and reused after. Each frame it
walks `state.live`, places the matching hull at `position × (GLOBE_RADIUS +
HULL_OFFSET + bob)`, orients it from `forward` and `position` with the same
basis `ship.ts`'s `applyTransform` builds, and writes `envelope` into the
neon `emissiveIntensity` and the rim strength. A hull with no boat is
`visible = false`.

Recolouring: every material `isNeon` matches (the test `shipfx.ts` uses,
exported for this) has its `emissive` set to `RED_NEON` or `ORANGE_NEON`,
linear-space colours to be added to `ART-DIRECTION.md` §2.2 beside the
existing swatches, with `emissiveIntensity` at the authored strength. The
sail's circuitry and the flag carry their glow in a texture and are left
alone. The thruster flames are hidden; an AI boat is not driven.

`bob` is `0.08 × sin(elapsed × 1.7 + phase)` per boat, phase from its index.

The `object` this module owns is added to the world scene once, on
`LAYER_DEFAULT` only, so the reflection cube never sees an AI hull, the same
way it never sees the player's.

### `rimglow.ts`

```ts
export function installRimGlow(root: Object3D, color: Color, strength: number): { setStrength(s: number): void };
```

For every `MeshStandardMaterial` under `root`, sets `onBeforeCompile` to
declare `uniform vec3 uRimColor; uniform float uRimStrength;` and, after
`#include <emissivemap_fragment>`, add
`totalEmissiveRadiance += uRimColor * uRimStrength * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);`.
The uniforms are shared across the hull's materials by reference, so
`setStrength` is one write. `RIM_STRENGTH = 1.6`, the authored neon's order
of magnitude, so the bloom treats the rim as neon. It must be installed before
`postFx.adopt(root)`; `aihulls.ts` does exactly that and nothing else may
adopt the clone.

### `battle.ts`, the fight

Flat arena, `x`/`z` in world units, centre at the origin. Both boats travel
counter-clockwise on a circle whose radius shrinks over the fight.

```ts
export interface Combatant {
  readonly angle: number;         // radians about the centre, CCW positive
  readonly x: number; readonly z: number;
  readonly heading: number;       // radians, direction of travel
  readonly rounds: number;        // 10 down to 0
  readonly hits: number;          // 0 up to 3
  readonly cooldown: number;      // seconds until it may fire again
}

export interface Cannonball {
  readonly owner: 'player' | 'ai';
  readonly x: number; readonly z: number;
  readonly vx: number; readonly vz: number;
  readonly age: number;
}

export type BattleOutcome = 'win' | 'loss' | 'draw';

export interface BattleState {
  readonly radius: number;                 // current circle radius
  readonly player: Combatant;
  readonly ai: Combatant;
  readonly balls: readonly Cannonball[];
  readonly elapsed: number;
  readonly outcome: BattleOutcome | null;  // set once, ends the fight
  readonly events: readonly BattleEvent[]; // this tick's: 'fire' | 'hit' | 'splash', with owner and position
}

export interface BattleInput {
  readonly fire: boolean;      // Space or FIRE, edge-triggered by the UI
  readonly faster: boolean;    // W held
  readonly slower: boolean;    // S held
}

export function createBattleSim(rng: () => number = Math.random): {
  readonly state: BattleState;
  update(dt: number, input: BattleInput): void;
};
```

**The circle.** `radius` starts at `ARENA_R0 = 20` and shrinks at
`ARENA_SHRINK = 0.4` units/s to `ARENA_R_MIN = 8`, then holds. The player
starts at angle `π` (the near side, bottom of the frame), the AI at `0`.
Base angular speed `ARENA_OMEGA` is chosen so the tangential speed at `R0`
is `ARENA_SPEED = 6` units/s (`ω = 6 / 20 = 0.3` rad/s) and is held
constant as the radius shrinks, so the boats slow as they close. Each boat's
`x = radius × cos(angle)`, `z = radius × sin(angle)`, `heading` tangent to the
circle.

**W/S.** The player's angular speed is `ARENA_OMEGA × (1 + THROTTLE_GAIN)`
with W, `× (1 - THROTTLE_GAIN)` with S, `THROTTLE_GAIN = 0.5`. The AI holds
`ARENA_OMEGA`. So the separation drifts by up to `0.15` rad/s, and the
player can pull off the diameter in about two seconds and back onto it in
two more.

**Firing.** `fire` with `cooldown <= 0` and `rounds > 0` spends a round, sets
`cooldown = FIRE_COOLDOWN = 1`, and adds a ball at the boat's position with
velocity `BALL_SPEED = 22` units/s toward the arena centre. A ball flies
straight; each tick it advances, and it is removed with a `splash` event when
its distance from the centre exceeds `radius + SPLASH_MARGIN` (3 units)
**after** having crossed the centre, or after `BALL_LIFE = 4` s. A ball
within `HIT_RADIUS = 1.6` units of the **other** boat's centre scores: a
`hit` event, `hits += 1`, ball removed. A ball never hits its owner.

**The AI gunner.** Each tick, if the AI has rounds and `cooldown <= 0` and
no shot is pending: compute the flight time `t = 2 × radius / BALL_SPEED`
and the player's predicted angle `angle + ω_player × t`. If the predicted
position is within `AI_SOLUTION_TOLERANCE = 1.2` units of the AI's
broadside line, a shot is scheduled at `elapsed + reaction + jitter`,
`reaction` uniform in `[0.2, 0.6]`, `jitter` uniform in `[-0.35, 0.35]`. When
`elapsed` reaches it the AI fires. `ω_player` is the player's angular speed
this tick, so a player who changes speed after the AI commits can dodge.

**Outcome.** Checked at the end of each tick, first match wins:

1. Both `hits >= 3` in this tick: `draw`.
2. `ai.hits >= 3`: `win`.
3. `player.hits >= 3`: `loss`.
4. Both `rounds === 0`, no balls live: `draw`.
5. `elapsed >= BATTLE_TIMEOUT = 120` s: `draw`. A player who never fires
   cannot hold the world frozen forever.

After `outcome` is set, `update` still moves the boats and balls (the result
card sits over a live scene) but scores nothing and fires nothing.

### `bounty.ts`

```ts
export const WIN_TIERS: readonly { chance: number; min: number; max: number }[];  // the table above; chances sum to 1
export function rollWinGold(rng: () => number): number;
export function lossGold(purse: number): number;      // clamp(round(purse * 0.10), 500, 10000), then min(purse)
export function rollDrawGold(rng: () => number, purse: number): number;  // uniform integer in [-1000, 1000], never below -purse
```

### `battlescene.ts`

- A `Scene` with `background` set to the world's current fog colour
  (`fogUniforms`), a `HemisphereLight` and a `DirectionalLight` whose
  elevation is the world's solar elevation at the ship at the moment of
  contact (`dot(ship.up, env.sunDirection)`), so a fight at dusk is a dusk
  fight and a night fight is two neon hulls on black water.
- The sea: one `PlaneGeometry` 300 units square with a small
  `ShaderMaterial` built from `NOISE_GLSL`: two scrolling simplex octaves
  perturb the normal, a Lambert term against the sun, a specular glint, the
  deep colour from `waterglsl.ts`'s palette, and `applyAerial` from
  `fogglsl.ts` toward the background at the horizon. It is **not** the globe
  water and must not import `water.ts`. Documented as such.
- The camera: a `PerspectiveCamera`, FOV 50, at `(0, 26, 34)` looking at the
  origin, fixed. At `R0 = 20` both hulls are inside the frame with the
  player nearest; at `R_MIN = 8` they fill its middle. It does not orbit:
  a camera turning with the player at 17°/s for a minute is the kind of
  motion that makes people put the game down.
- `enter(playerHull, aiHull, sunElevation)` reparents both hulls in and
  resets the pool of cannonball meshes. `update(dt, state)` places the hulls
  from `Combatant` (`x`, `z`, `heading`, plus the same authored bob as
  `aihulls.ts`), syncs one `Mesh` per live ball (a `SphereGeometry` of
  radius 0.22 with a dim warm emissive), pops a muzzle flash `PointLight`
  for 0.12 s on a `fire` event, a splash ring sprite on `splash`, and a
  brief red flash of the hit hull's rim (AI) or a screen-edge vignette in
  the UI (player) on `hit`. `exit()` reparents nothing: `main.ts` moves the
  hulls back itself, inside the fade, so the scene never has to know where
  they came from.
- `postFx.adopt(arenaRoot)` once at construction, so every arena material
  carries the sRGB self-encode.

### `battleui.ts`

A marked `<!-- BATTLE -->` block in `index.html` and `/* BATTLE */` block in
`style.css`, above the HUD and below `#blackout`.

- A top strip: `YOU  ROUNDS 10  HITS ○○○` on the left in `--cyan`, `FOE
  ROUNDS 10  HITS ○○○` on the right in the boat's colour, filling pips as
  hits land. A one-line prompt under it: `SPACE to fire · W/S to change
  speed`, hidden after the first shot.
- A `FIRE` on-screen button, bottom centre, for touch, 64px tall like the
  D-pad's keys. The D-pad's up and down keys keep working as W/S.
- Space: a `window` keydown, `preventDefault`, ignored on repeat, exactly the
  guard `fishing.ts` uses. Escape does nothing during a fight; a player
  cannot leave a battle by dismissing it.
- The result card, over the live arena: `VICTORY`, `DEFEATED` or `STAND-OFF`
  in the HUD's display face, the gold line (`+2,340 gold`, `-1,200 gold`),
  and, on a loss or draw, the power line (`Main tank drained · backup cell
  10%` or `Main tank -25%`). One `CONTINUE` button and Enter/Space close it.
- `isOpen` is a **live getter**, true from `open()` until `CONTINUE`.

## Changes to existing modules

### `ship.ts`

- `cloneHull(): Object3D | null`. Null before `ready` resolves or if the load
  failed. Deep clones the glTF root with `object.clone(true)`, then walks it
  and replaces every material with `material.clone()` so the AI's recolour
  and rim patch cannot reach the player's hull. Geometry is shared. Applies
  `MODEL_SCALE` and `MODEL_MOUNT_Y` exactly as `loadHull` does.
- Export `HULL_OFFSET` (the radius the hull is drawn at, currently private) so
  `aihulls.ts` sits its clones on the same sea.
- No change to `update`. During the fight `update` is not called; the arena
  drives `object` directly, and `applyTransform` on the first world frame
  after restores it.

### `shipfx.ts`

Export `isNeon`. Nothing else.

### `energy.ts`

- `defeat(): void`. `state.level = 0`. Then, on the battery it was given:
  `battery.level > DEFEAT_KEEP_ABOVE (0.20)` draws it down to
  `DEFEAT_KEEP (0.10)`, otherwise draws it to zero. Through
  `battery.draw(want)`, never a new setter, so the save subscription fires.
  `rate` and `mode` untouched, as `wreck` leaves them.
- `stalemate(): void`. `state.level = max(0, state.level - STALEMATE_COST)`,
  `STALEMATE_COST = 0.25`. Backup untouched.
- `createEnergy` already receives the battery; no signature change.

### `wallet.ts`

`lose(amount: number): number`. Takes `min(amount, gold)` and returns what it
took, notifying subscribers. `spend` stays all-or-nothing for the shop; a
defeat is not a purchase and must not be refused for an empty purse.

### `radar.ts`

`update(dt, ship, wind, hazards, boats: AiBoatState)`. Boats are drawn from
the **live** frame like hazards, clipped to the bezel: a filled arrowhead the
size of own ship's blip, turned to the boat's heading relative to the bow,
in `--red` (new, `#ff4a3c`) or `--orange` (new, `#ff9a3c`), at `envelope`
alpha. Both are UI colours and stay off in-world objects, per §2.4; the
in-world neon swatches are separate linear values in `aihulls.ts`.

### `hud.ts`

Nothing. Gold and the two power bars already subscribe or read live state.

### `blackout.ts`

Nothing. `run(onBlack)` is used twice per fight, into and out of the arena.

### `main.ts`

Build order additions:

```ts
const aiBoats = createAiBoats({ terrain, heightMap: globe.heightMap, waterBodies: globe.waterBodies,
                                towns: globe.towns, onContact });
const aiHulls = createAiHulls(scene, () => ship.cloneHull());   // after ship.ready
const battleScene = createBattleScene(quality);
const battleSim = createBattleSim();                             // fresh per fight; see onContact
const battleUi = createBattleUi({ onContinue });
```

`onContact(boat)`:

```ts
ship.halt();
contactBoat = boat;
sim = createBattleSim(rng);            // the AI boats' own seeded stream
battleUi.open(boat.kind);              // isOpen flips now; the next frame takes the battle branch
blackout.run(() => {
  battleScene.enter(ship.object, aiHulls.hullOf(boat), solarElevation());
  inArena = true;
});
```

`onContinue()` applies the outcome, then leaves:

```ts
switch (sim.state.outcome) {
  case 'win':  wallet.add(rollWinGold(rng)); break;
  case 'loss': energy.defeat(); wallet.lose(lossGold(wallet.gold)); break;
  case 'draw': energy.stalemate(); { const g = rollDrawGold(rng, wallet.gold); g >= 0 ? wallet.add(g) : wallet.lose(-g); } break;
}
blackout.run(() => {
  scene.add(ship.object);                // back where it was; applyTransform restores the transform next frame
  aiBoats.remove(contactBoat);           // aihulls hides the clone on the next update
  battleUi.close();
  inArena = false;
});
```

The gold and power lines on the result card need the amounts **before**
`CONTINUE`, so `onContinue` is really two steps: the outcome is rolled and
applied the frame `outcome` is first set (the card reads the applied numbers),
and `CONTINUE` only runs the fade. Roll once; never on every frame the card is
up.

The frame loop gains its third branch, tested **before** the overlay branch:

```ts
if (battleUi.isOpen) {
  energy.update(dt, restingSnapshot(), env);       // the plant keeps running, on a resting hull
  if (inArena) sim.update(dt, battleUi.input(controls.input));   // fire edge + W/S
  battleScene.update(dt, sim.state);
  battleUi.update(sim.state);
  hud.update(ship.state, energy.state, wind.state);
  postFx.render(dt, inArena ? battleScene.scene : scene, inArena ? battleScene.camera : view.camera);
  controls.endFrame();
  requestAnimationFrame(frame);
  return;
}
```

During the two fades `inArena` is false on the way in (the world renders
frozen under the fade) and true on the way out until `onBlack` flips it, so
the swap always happens under an opaque screen.

In the ordinary branch:

```
hazards.update(dt, ship.state, energy.state, wind.state)
aiBoats.update(dt, ship.state, energy.state, hazards.state, suppressed())   // after hazards: needs the phase; before the ship: contact halts it this frame
ship.update(...)
...
aiHulls.update(dt, aiBoats.state)          // after the ship, before globe.update: placing meshes, nothing reads them until render
...
radar.update(dt, ship.state, wind.state, hazards.state, aiBoats.state)
```

The `[FISH]` and `[SHOP]` buttons gain no guard: a fight opens from
`onContact`, which halts the ship and flips `isOpen` synchronously, so no
overlay can open over it, and no contact can happen under an overlay because
the sim does not run there.

**Dev queries**, guarded exactly like `?quality=` and `?hazard=`:

- `?boat=red|orange` calls `aiBoats.force` once, three seconds in, 45 units
  dead ahead pointing at the ship. The only way to see an 8%-per-10-s event
  inside the budget.
- `?battle=1` opens the arena three seconds in against a forced orange boat
  placed on the hull, so the fight itself can be tuned without a chase.

### Docs

`docs/ARCHITECTURE.md`: rows for the seven modules in the ownership table;
the third loop branch and the new ordinary-loop lines; an **AI boats and the
battle** section carrying the reparenting rule, the "not the globe water"
rule for the arena sea, and the rim patch's ordering against `postFx.adopt`;
the `ship.ts`, `energy.ts`, `wallet.ts` and `radar.ts` signature changes.
`README.md`: a **Raiders** bullet and two rows in the controls table (Space
fires in a battle, W/S change speed on the circle). `ART-DIRECTION.md` §2.2:
the two AI neon swatches; §2.3: `--red` and `--orange`. This plan is left as
written, per the convention at the top of `WIND_PLAN.md`.

## Constants

Author them at the top of their file with the reasoning beside each, in the
house style of `energy.ts`.

| Constant | Value | File |
|---|---|---|
| `ROLL_PERIOD` | 10 s | aiboats |
| `P_RED` / `P_ORANGE` | 0.08 / 0.12 — **now 0.032 / 0.72, see The roll** | aiboats |
| `RED_SPAWN_MIN` / `RED_SPAWN_MAX` | 40 / 60 units | aiboats |
| `ORANGE_SPAWN_MIN` / `ORANGE_SPAWN_MAX` | 30 / 50 units | aiboats |
| `RED_SPEED` / `ORANGE_SPEED` | 20 / 15 units/s | aiboats |
| `PHASE_MIN` / `PHASE_MAX` | 5 / 8 s | aiboats |
| `RED_TURN_RATE` | 50°/s | aiboats |
| `ORANGE_AIM_SHARE` / `ORANGE_AIM_LEAD` / `ORANGE_AIM_SPREAD` | 0.5 / 4 s / 12 units | aiboats |
| `CONTACT_RADIUS` | 2.4 units | aiboats |
| `BERTH_MARGIN` | 4 units | aiboats |
| `FADE_IN` / `FADE_OUT` | 0.5 / 1 s | aiboats |
| `SPAWN_GRACE` | 30 s | aiboats |
| `AIBOAT_SEED` | any fixed hex | aiboats |
| `RED_NEON` / `ORANGE_NEON` | linear swatches, to be added to ART-DIRECTION §2.2 | aihulls |
| `RIM_STRENGTH` | 1.6 | rimglow |
| `ARENA_R0` / `ARENA_R_MIN` / `ARENA_SHRINK` | 20 / 8 units / 0.4 units/s | battle |
| `ARENA_SPEED` | 6 units/s at `R0` (so `ARENA_OMEGA` = 0.3 rad/s) | battle |
| `THROTTLE_GAIN` | 0.5 | battle |
| `ROUNDS` / `HITS_TO_LOSE` | 10 / 3 | battle |
| `FIRE_COOLDOWN` | 1 s | battle |
| `BALL_SPEED` / `BALL_LIFE` / `SPLASH_MARGIN` | 22 units/s / 4 s / 3 units | battle |
| `HIT_RADIUS` | 1.6 units | battle |
| `AI_SOLUTION_TOLERANCE` | 1.2 units | battle |
| `AI_REACTION_MIN` / `AI_REACTION_MAX` | 0.2 / 0.6 s | battle |
| `AI_JITTER` | ±0.35 s | battle |
| `BATTLE_TIMEOUT` | 120 s | battle |
| `WIN_TIERS` | the table above | bounty |
| `LOSS_SHARE` / `LOSS_MIN` / `LOSS_MAX` | 0.10 / 500 / 10,000 | bounty |
| `DRAW_SWING` | 1,000 | bounty |
| `DEFEAT_KEEP_ABOVE` / `DEFEAT_KEEP` | 0.20 / 0.10 (tank fractions) | energy |
| `STALEMATE_COST` | 0.25 (tank fraction, subtracted) | energy |
| `--red` / `--orange` | `#ff4a3c` / `#ff9a3c` | style.css |

## Performance

Two extra hulls in the world scene at 26 draw calls each, only while a boat
is live, is the whole cost in the ordinary loop; at 40 to 60 units they are
a few hundred pixels. The rim patch is one `pow` per fragment on those
pixels. The sim is two great-circle steps and two distance tests per frame.
The arena is cheaper than the world: one plane, two hulls, a handful of
spheres, no reflection, no wake, no patch. No quality-tier row is needed;
the GPU timer (Backquote) is the check.

## Known artefacts, accepted

- The player's sail and flag hang still in the arena, and the AI's cloth
  moves in step with the player's in the world. Both need `shipfx.ts` to
  learn to tick without a hull update; out of scope.
- An AI boat sails through a crest and over a maelstrom's rim without
  reacting.
- A boat removed at the end of its clock fades its light over a second and
  then vanishes; in daylight at close range the hull itself disappears.
- Two hulls in contact overlap for the one frame before the fade starts.
- A player docked while a red boat closes watches it turn orange and sail
  past. That is the rule, not a bug.

## Work split

Three agents in parallel, in the same working tree, after one preparatory
step by the orchestrator. Files are partitioned so no two agents write the
same file; the two shared files (`index.html`, `style.css`) get a marked
block in step 0 and only agent C edits inside it, **with Edit, never Write**.

**Step 0, orchestrator, before the agents start.** Land `AiBoatKind`,
`AiBoatPhase`, `AiBoat`, `AiBoatState`, `Combatant`, `Cannonball`,
`BattleOutcome`, `BattleState`, `BattleInput`, `BattleEvent` in `types.ts`;
stub `aiboats.ts` (empty state, no-op `update`/`remove`/`force`),
`battle.ts` (a state that never ends, no-op `update`), `bounty.ts` (the
table and the three functions, which are small enough to land complete),
`aihulls.ts` (no-op), `rimglow.ts` (no-op returning a no-op `setStrength`),
`battlescene.ts` (an empty scene and a camera), `battleui.ts` (`isOpen`
false, no-op `open`/`close`); add `cloneHull` returning null and export
`HULL_OFFSET`; export `isNeon`; add `defeat` and `stalemate` as no-ops; add
`wallet.lose`; add the fifth argument to `radar.update` with an empty
default; insert `<!-- BATTLE -->` / `/* BATTLE */` blocks. `npm run build`
and `npm test` must be green before step 1, and stay green for every agent.

The stub signatures are the contract:

```ts
createAiBoats(deps): { state; update(dt, ship, energy, hazards, suppressed); remove(boat); force(kind, position, forward) }   // A
createBattleSim(rng?): { state; update(dt, input) }                                                                         // A
rollWinGold(rng); lossGold(purse); rollDrawGold(rng, purse); WIN_TIERS                                                      // A
createAiHulls(scene, cloneHull): { update(dt, state); hullOf(boat): Object3D }                                              // B
installRimGlow(root, color, strength): { setStrength(s) }                                                                   // B
createBattleScene(quality): { scene; camera; enter(player, ai, sunElevation); update(dt, state); exit() }                   // B
ship.cloneHull(); HULL_OFFSET; isNeon                                                                                        // B
createBattleUi(deps): { isOpen; open(kind); close(); input(raw): BattleInput; update(state) }                               // C
energy.defeat(); energy.stalemate(); wallet.lose(amount); radar.update(dt, ship, wind, hazards, boats)                      // C
```

| Agent | Owns | Deliverable |
|---|---|---|
| **A, sim** | `aiboats.ts`, `battle.ts`, `bounty.ts`, `tests/unit/aiboats.test.ts`, `tests/unit/battle.test.ts`, `tests/unit/bounty.test.ts` | The roll, spawning, transport, pursuit, conversion, contact and grace; the whole fight; the gold table. No DOM, no Three scene objects. Tier-1 tests: over 3000 s of rolls with a stationary ship in open ocean both kinds appear and never two of one kind; a red boat forced 45 units ahead of a stationary ship reaches it within its clock and `onContact` fires exactly once; a red boat forced abeam of a ship that turns hard away at 10 kn converts to orange without contact (this is the escapability proof, and the number to tune if it fails); a converted boat is removed after its clock; `suppressed` blocks spawn and contact; a boat stepped onto land is removed; a ball fired at the exact lead solution hits and one fired 0.6 s late splashes; the cooldown refuses a second shot inside a second; rounds never go below zero; three hits end the fight with the right outcome; both empty is a draw; the timeout is a draw; the AI hit rate against an idle player over 200 seeded fights is between 35% and 55%; `WIN_TIERS` sums to 1 and 10,000 rolls stay in [500, 20000]; `lossGold` clamps at both ends and never exceeds the purse; `rollDrawGold` stays in [-1000, 1000] and never below `-purse`. |
| **B, render** | `aihulls.ts`, `rimglow.ts`, `battlescene.ts`, `ship.ts` (`cloneHull`, `HULL_OFFSET`), `shipfx.ts` (the export), `tests/unit/ship-physics.test.ts` (one case) | The clones and their recolour, the rim patch and its ordering against `adopt`, the arena scene, sea, lights, camera, balls, flashes and splashes. Tier-1: `cloneHull` returns null before `ready`; after a mocked load the clone shares no material object with the original. |
| **C, UI, loop, rules** | `battleui.ts` and its blocks, `energy.ts`, `wallet.ts`, `radar.ts`, `main.ts`, `docs/ARCHITECTURE.md`, `README.md`, `ART-DIRECTION.md`, `tests/unit/energy-battle.test.ts`, `tests/smoke/game.spec.ts` (one added test) | The overlay, the third loop branch, both fades, the outcome application, the scope marks, the dev queries, the docs. Develops against the step-0 stubs; A's and B's real modules drop in without a signature change. Tier-1: `defeat` with backup 0.30 leaves 0 / 0.10, with backup 0.15 leaves 0 / 0, with backup 0 leaves 0 / 0; `stalemate` from 0.6 leaves 0.35 and from 0.1 leaves 0; `wallet.lose(700)` on 500 takes 500 and returns 500. Tier-2: `?battle=1` boots, the arena renders under the two liveness checks, the console shows no shader errors. Keep `test:all` under two minutes. |

**Step 4, orchestrator, integration.** `npm run build`, `npm test`, then
`npm run test:all` **once**. Then launch a preview and look, per the budget in
`docs/TESTING.md`:

- `?boat=red`: a red-rimmed hull appears 45 units ahead, the scope shows a
  red arrowhead closing, the hull turns toward the ship as it steers, a hard
  turn makes it overshoot, its light turns orange as the clock runs out, and
  it fades away on a straight line. Then do nothing and let it hit: the
  screen fades, the arena comes up with both hulls circling, the strip reads
  10 rounds each.
- `?battle=1`: Space fires a ball across the circle; a ball that meets the
  enemy fills a pip and flashes its rim; W pulls the player off the diameter
  and the AI's balls start splashing behind; three hits either way brings up
  the card with the right gold and power lines; `CONTINUE` fades back to the
  world with the ship stopped where it was and the enemy gone; the gold on
  the HUD matches the card.
- Lose one on purpose: POWER reads zero, the backup bar reads 10% or is
  hidden, and the ship cannot thrust until the panels have put 3% back.
- The Vite log and the browser console show no shader errors. A green build
  is not a pass.

## Out of scope

Sound. Boat wakes and spray for AI hulls. AI hulls riding the wave field or
reacting to hazards. A fight record in the save file. Difficulty scaling
with gold held or distance from shore. Multiple enemies in one arena. A
boarding or ramming mechanic. Any change to `water.ts`, `waveField` or the
parity probes. Animated sails on a hull that is not being updated by
`ship.ts`.
