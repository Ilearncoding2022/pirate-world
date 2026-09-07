# Strong waves and maelstroms — implementation plan

Status: **approved, not started.**

This document is the complete brief. An implementing agent should not need the
conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**Units, pinned**, **World scale**, **Ship dynamics**, **The wave field**,
**Frame loop** and **The water plugin contract**, and `docs/TESTING.md` for the
budget every agent below is held to. This plan follows the conventions recorded
there and adds to them. `docs/WIND_PLAN.md` is the closest precedent: a seeded
event system that writes one state object the hull spends.

## Decisions already made

Settled with the project owner. Do not re-litigate them; if one turns out to be
unworkable, say so and stop rather than substituting another.

| Question | Decision |
|---|---|
| Roll cadence | One roll **every 10 s**, three **independent** draws: 10% strong wave, 5% great wave, 1% maelstrom. A draw for a kind that already has a live instance is skipped, so at most one of each kind exists at once (three hazards total). |
| Where they rise | **18 to 30 world units** from the ship, in reachable open ocean, **ahead-biased**: three draws in four put the bearing within ±60° of the bow, the fourth anywhere. Never within a berth's clearance. |
| Wave shape | A **travelling crest line**: 20 units long across the direction of travel, 5 units wide along it, moving at **6 units/s** for a **10 s** life. |
| Wave push | **Contact consumes the wave.** On contact the crest starts dissipating over **3 s** (strong) or **5 s** (great), and over those same seconds the hull is pushed in the crest's direction of travel by a hump of ground velocity peaking at **5 units/s** (strong) or **10 units/s** (great). A crest that never touches the hull lives its 10 s and fades on its own. |
| Helm during a push | **Kept.** The push is added exactly the way the wind is: a velocity, so the bow holds its heading and the hull is carried off its course. Engine and steering keep working. |
| Berths | **Immune.** A docked ship (`energy.mode === 'docked'`, the project's one definition) is neither pushed nor captured, and no hazard is ever spawned with any part of it inside a berth ring plus margin. |
| Maelstrom | **20 units across** at full size. Grows from nothing over **3 s**, holds **30 s**, shrinks over 3 s. Touching any part of it captures the ship. |
| Capture | The player loses the helm. The hull spirals inward on its own for **6 s**, sinks and vanishes, the screen fades to black, and the ship reappears **stopped**, on a random heading, at a random point of reachable open ocean clear of land and berths, then the screen fades back in. A maelstrom that has caught a ship stays until it has eaten it, even past its 30 s. |
| Power on disintegration | The **main tank keeps 25%** of whatever it held at the moment the hull vanishes: 80% becomes 20%. The **backup cell is untouched.** Gold, the fish book and the harpoon locker are untouched. |
| Visuals | **Displace the real sea.** Hazards are a second height term in the same three places the wind-driven sea already lives — the patch's vertex shader, the fragment shader's normal, and the CPU port the hull rides — plus foam and colour through a `WaterPlugin`, and marks on the radar. |
| Randomness | **Seeded**, like the wind (`mulberry32`, its own seed), so a run replays the same draws and a tuning session can get the same maelstrom back. Injectable for tests. |

## Units

- "kn" in the owner's brief is a **world unit per second** everywhere, which
  is what `hud.ts` prints as a knot. A push of 5 kn is a ground-velocity
  addition of 5 units/s; "2 kn wide" was resolved to **20 world units** (about
  six hull lengths, two fifths of the scope's range).
- Hazard **sizes** are ship-scale: absolute world units, sized against the hull
  and the patch, and do not grow with `GLOBE_RADIUS`. They are converted to
  direction space (divided by the radius) at the point of use, exactly as
  `wavefield.ts` converts `NORMAL_STEP`.
- Hazard **heights** are world units and are **not** scaled by
  `uWaveIntensity`. The wind raises the ordinary sea; a hazard is its own
  weather.

## Why this shape, and the one trap

The sea's displacement is one function, `waveField`, pasted into three
consumers that must agree to the pixel: the sphere's fragment shader, the
patch's vertex shader, and `wavefield.ts`, guarded by
`tests/smoke/wave-parity.spec.ts`. Hazards must not go into that function.
They go **beside** it, as a second function with the same three consumers and
the same parity guard, and that function is built so parity is free:

**Everything in the hazard height field is polynomial, plus one `sqrt`.**
No `sin`, `cos`, `exp`, `pow` or noise anywhere in the *height*. Those are the
transcendentals whose last bits differ between a GPU and `Math`, which is
exactly what the existing probe had to design around (see the comment in
`dev/probe.ts` on why it normalises with `sqrt` instead of using `sin`/`cos`).
The spin of a maelstrom and the froth on a crest are fragment-side art, in the
plugin's `foam` and `colour` hooks, where `sin` and `snoise` are welcome
because nothing on the CPU has to match them.

Local coordinates are dot products, not angles. Each hazard carries a tangent
frame at its own centre `c`: `north` (the direction of travel for a crest) and
`east = normalize(cross(north, c))`. For a surface direction `p`:

```
u = dot(p, east)     // direction units across the travel line
v = dot(p, north)    // direction units along it
```

Multiply by `GLOBE_RADIUS` for world units. That is the small-angle
approximation; at 30 units on a radius of 200 the error is under 0.2%, and
both sides make the same error.

## The height field

Authored in world units at the top of `hazardfield.ts` and converted once.
`bump(x) = (1 - x²)²` for `|x| < 1`, else 0. `plateau(x) = 1 - smoothstep(0.55, 1, |x|)`.
Both are polynomial. `env` is the hazard's envelope, 0..1, computed on the CPU.

**Crest** (kinds `wave` and `greatwave`), half-length `L = 10`, half-width `W = 2.5`:

```
h(u, v) = A · env · plateau(u / L) · bump(v / W)
```

`A` is `CREST_HEIGHT` = **1.6** for a strong wave, `GREAT_CREST_HEIGHT` =
**2.4** for a great one. The ordinary sea peaks at `DISPLACE_AMPLITUDE` (0.3)
in a full gale, so a strong wave is five times the worst weather and a great
one eight. The hull's freeboard is about a unit; the great wave is meant to
tower over it.

**Maelstrom**, radius `R = 10` at full size (the radius itself scales with the
growth envelope, see below), with `r = sqrt(u² + v²) / R`:

```
h(r) = -D · (1 - r)³        for r < 1        // the funnel, D = FUNNEL_DEPTH = 3.0
     + RIM · bump((r - 0.9) / 0.12)          // a raised lip, RIM = 0.35
```

`(1 - r)³` is written as three multiplications, never `pow`. The height is
radially symmetric on purpose: the swirl is not in the geometry.

**Distance fade.** The patch is 80 units square and fades its displacement to
zero over its outer 15% (`SKIRT_START` 0.85, so from 34 units out). A hazard
that leaves the patch would keep tilting the normal and foaming on the
undisplaced sphere behind it. So every hazard's envelope is multiplied on the
CPU by a fade that is 1 within **32** units of the ship and 0 beyond **38**,
and all three consumers read that one product. A crest that outruns the patch
therefore dissolves rather than turning into a painted stripe.

## Uniforms and the GLSL contract

`MAX_HAZARDS = 3` (one per kind). Prefix `uHaz`, per the plugin rule.

| Uniform | Type | Meaning |
|---|---|---|
| `uHazCount` | `int` | Live hazards; slots at or past it are ignored. |
| `uHazCentre[3]` | `vec3` | Unit direction of the centre. |
| `uHazEast[3]` | `vec3` | Unit tangent across the travel line. |
| `uHazNorth[3]` | `vec3` | Unit tangent along it (a crest's direction of travel). |
| `uHazShape[3]` | `vec4` | `x` kind (0 crest, 1 maelstrom); `y` half-length or radius, direction units; `z` half-width, direction units (unused for a maelstrom); `w` amplitude × envelope × distance fade, world units. |

`hazardfield.ts` exports one GLSL string, `HAZARD_GLSL`, declaring those
uniforms and `float hazardHeight(vec3 p)` — the loop over the slots summing
the two profiles above. It is pasted:

1. into the **patch vertex shader** (`waterpatch.ts`), where the displacement
   becomes `uPatchUp * (h * amp + hazardHeight(dir) * skirt)`. The skirt
   multiplies the hazard too, so the patch still meets the sphere.
2. into the **fragment shader** through the plugin's `declarations`, so both
   the sphere and the patch's byte-for-byte clone carry it.
3. into the **`?probe=hazard`** harness.

The plugin's `normal` hook tilts `N` by the hazard's own gradient, with its own
step so it is not coupled to `water.ts`'s private `NORMAL_STEP`:

```glsl
const float HAZ_EPS = <HAZ_STEP_WORLD / GLOBE_RADIUS>;   // HAZ_STEP_WORLD = 0.5
float hz0 = hazardHeight(n);
float hzu = hazardHeight(n + tanU * HAZ_EPS);
float hzv = hazardHeight(n + tanV * HAZ_EPS);
// Height differences are world units over a step of HAZ_STEP_WORLD world
// units, so dividing gives a true slope, and the normal of a height field is
// the up vector leaned back by that slope. No art factor here: this is geometry.
N = normalize(N - (tanU * (hzu - hz0) + tanV * (hzv - hz0)) / HAZ_STEP_WORLD);
```

The hook runs inside `main()` after `waterDepth`, so `n`, `tanU`, `tanV` and
`N` are in scope, per the table in **The water plugin contract**.

`foam` hook, art only: a crest foams along its top —
`max(foam, env · plateau(u/L) · sqrt(bump(v/W)) · breakup)` with `breakup` a
`snoise` of `n` drifting with `uTime`; a maelstrom foams in spiral bands —
`band = 0.5 + 0.5 · sin(r · 14 − uTime · 2.5 + θ · 3)` with `θ = atan(v, u)`,
raised to the fourth and scaled by `(1 − r) · env`, plus a bright lip at
`r ≈ 0.9`. `colour` hook: darken the funnel toward `uAbyss` by
`0.6 · (1 − r)² · env`. The `foam` slot is the one that fires on every pixel,
so open-ocean foam works there; see the contract.

CPU side, `hazardfield.ts` also exports `hazardHeight(dir: Vector3, hazards:
readonly Hazard[]): number`, the same arithmetic with every step through
`Math.fround`, exactly as `wavefield.ts` does and for the same reason.

## `hazards.ts` — the sim

Owns one `HazardState`, **mutated in place for the life of the run**, as
`wind.ts` owns `WindState`. DOM-free and scene-free: it moves numbers and
vectors, and it is the module the unit tests exercise.

```ts
export type HazardKind = 'wave' | 'greatwave' | 'maelstrom';

export interface Hazard {
  readonly kind: HazardKind;
  /** Unit direction of the centre. Mutated in place as a crest travels. */
  readonly centre: Vector3;
  readonly east: Vector3;
  readonly north: Vector3;
  /** Half-length (crest) or radius (maelstrom), world units, at full size. */
  readonly extent: number;
  /** Half-width of a crest, world units. 0 for a maelstrom. */
  readonly halfWidth: number;
  /** Signed peak height, world units: positive for a crest, the funnel depth for a maelstrom. */
  readonly amplitude: number;
  /** Rise/hold/fade × distance fade, 0..1. The one number the shader gets. */
  readonly envelope: number;
  /** Size envelope: a maelstrom's radius is `extent * size`. 1 for a crest. */
  readonly size: number;
  readonly age: number;
  /** True once the hull has taken this crest's push; it is dissipating. */
  readonly consumed: boolean;
}

export interface HazardDrive {
  /** Where the hull is this frame. Unit direction. */
  readonly position: Vector3;
  /** Where the bow points. Unit tangent. */
  readonly forward: Vector3;
  /** How far the hull is drawn below its waterline, world units. */
  readonly sink: number;
}

export interface HazardState {
  readonly live: readonly Hazard[];              // length ≤ MAX_HAZARDS
  /** Eased push in the ship's frame, world units/s; the pair `ship.ts` spends. */
  readonly along: number;
  readonly across: number;
  readonly phase: 'free' | 'spiral' | 'sunk';
  /** Non-null exactly while `phase !== 'free'`. `ship.ts` obeys it and skips its own physics. */
  readonly drive: HazardDrive | null;
}

export interface HazardsDeps {
  terrain: Terrain;
  heightMap: HeightMap;
  waterBodies: WaterBodies;
  towns: Towns;
  seed?: number;
  /** Fired once, the frame the hull vanishes. `main.ts` runs the wreck from here. */
  onSunk: () => void;
}

export function createHazards(deps: HazardsDeps): {
  readonly state: HazardState;
  /** After `wind.update`, before `ship.update`. Needs this frame's docked verdict. */
  update(dt: number, ship: ShipState, energy: EnergyState): void;
  /** Clears every hazard and returns to `free`. Called by `main.ts` while the screen is black. */
  reset(): void;
  /** Spawns one hazard now, at `centre` travelling `north`. Tests and the dev query only. */
  force(kind: HazardKind, centre: Vector3, north: Vector3): void;
  /** `pickRespawn` exposed for `main.ts`; see below. */
  pickRespawn(): Vector3;
};
```

### The roll

A timer fires every `ROLL_PERIOD = 10` s. For each kind in a fixed order
(`wave`, `greatwave`, `maelstrom`): if no live hazard of that kind exists and
`rng() < P[kind]`, spawn one. Always draw the number, even when the kind is
live, so the seeded stream stays in step regardless of what is on the water.

### Spawning

Up to 24 attempts, then give up until the next roll:

1. Distance `d` uniform in `[SPAWN_MIN, SPAWN_MAX] = [18, 30]` units.
2. Bearing: with probability 0.75, `ship.heading + uniform(-60°, +60°)`;
   otherwise uniform over the compass. Resolve the bearing at the ship with
   `tangentFrame` and walk `d / GLOBE_RADIUS` along it with the same
   great-circle step `ship.ts`'s `stepAlong` uses.
3. Accept only if every test point is **water** (`heightMap.sample <
   terrain.seaLevel`), **reachable** (`waterBodies.sample < 0.5`), and **no
   berth** has its centre within `DOCK_RADIUS + extent + 4` units. Test points:
   the centre, and for a crest its two ends (`±extent` along `east`), for a
   maelstrom four points at `extent` on the compass.
4. A crest's `north` points from the centre toward the ship's position
   advanced by `ship.velocity × 4 s`, offset `uniform(-8, 8)` units along the
   ship's starboard, projected onto the tangent plane at the centre. Half the
   crests therefore miss a ship that holds its course and all of them can be
   dodged or met on purpose. A maelstrom's frame is any tangent frame.

### Envelopes

Crest: rises over `CREST_RISE = 1` s (smoothstep), holds, and either fades
over the last `CREST_FADE = 1.5` s of `CREST_LIFE = 10` s, or — once
`consumed` at age `tc` — over `DISSIPATE[kind]` = 3 s / 5 s from `tc`, after
which it is removed. If a travelling crest's centre lands on land it is marked
consumed with no push, so it dies against the coast in a second rather than
climbing the beach.

Maelstrom: `size` grows 0 → 1 over `MAELSTROM_GROW = 3` s, `envelope` with it;
holds until age ≥ `MAELSTROM_LIFE = 30` s; then both shrink over
`MAELSTROM_GROW` and it is removed. While `phase !== 'free'` the hold is
extended indefinitely; `reset()` is what removes it.

The distance fade above multiplies `envelope` last.

### Transport

A crest's `centre` is advanced along `north` by `CREST_SPEED = 6` units/s each
frame (great-circle step). `north` is carried by parallel transport across
that step, `wind.ts`'s way, and `east` is rebuilt from it. A maelstrom does not
move.

### Contact and push

Each frame, for each live, unconsumed crest: with the ship's position in the
crest's frame (`u`, `v` in world units), contact is `|u| < extent + HULL_REACH`
and `|v| < halfWidth + HULL_REACH`, `HULL_REACH = 1.0` — half a hull. On
contact, and not docked, mark it consumed and start its push.

The push is a hump: `p(t) = PEAK[kind] · sin(π · t / DISSIPATE[kind])` for
`t` since contact (`sin` is fine here; nothing on the GPU reads it). Its
direction is the crest's `north` projected onto the ship's tangent plane, and
it is resolved onto the hull exactly as the wind is:

```
along  = p · dot(dir, ship.forward)
across = p · dot(dir, starboard)          // starboard = normalize(cross(forward, up))
```

No eight-sector table, and no easing: the hump is already smooth and it is
meant to shove the hull the way the water went, not on a point of sail. Docked
→ both zero. Over 3 s at a 5 units/s peak the hull is carried about 9.5 units;
the great wave's 5 s at 10 carries it about 32 — a third of the scope.

### Capture

Each frame, for a live maelstrom with `size > 0`: great-circle distance from
the ship to the centre `< extent · size + HULL_REACH`, and not docked, and
`phase === 'free'` → `phase = 'spiral'`. Record `r0` (that distance, world
units) and `θ0 = atan2(v, u)` in the maelstrom's frame.

Spiral, `SPIRAL_SECONDS = 6`, `s = t / SPIRAL_SECONDS`:

```
r(s) = r0 · (1 − s)^1.5                       // hits the centre exactly at s = 1
θ(s) = θ0 + 2π · SPIRAL_TURNS · (s + s²) / 2  // SPIRAL_TURNS = 2.5, speeding up inward
sink(s) = 0 for s < 0.6, then smoothstep to SINK_DEPTH = 2.5 at s = 1
```

`drive.position` is the centre stepped `r / GLOBE_RADIUS` along
`cos θ · east + sin θ · north`; `drive.forward` is the direction of motion,
taken as the tangent-plane difference between this frame's position and the
last (falling back to the previous forward when the step is degenerate). At
`s = 1`: `phase = 'sunk'`, `drive` holds the centre at full sink, and
`onSunk()` fires exactly once. The state stays `sunk` until `reset()`.

### Respawn

`pickRespawn()` draws uniform random unit vectors from the seeded stream and
returns the first that is water, reachable, at least `RESPAWN_CLEARANCE = 6`
units from land on eight bearings (the same ring probe `wind.ts` walks, one
ring), and at least `2 · DOCK_RADIUS` from every berth. After 500 attempts it
returns the world's spawn point, which `terrain.ts` guarantees is open ocean.
Pure and testable.

## Changes to existing modules

### `ship.ts`

- `update(dt, input, energy, wind, waveOffsets?, hazard?: HazardState)`. The
  sixth argument defaults to a module-level `NO_HAZARD` (empty `live`, zero
  push, `free`, null drive), so `tests/unit/ship-physics.test.ts` is untouched.
- Ground velocity becomes `forward · (speed + wind.along + hazard.along) +
  starboard · (wind.across + hazard.across)`. Nothing else about the step
  changes; land still refuses it.
- **While `hazard.drive` is non-null**: ignore the helm and the throttle, set
  `speed`, `groundSpeed` and `velocity` to zero, copy `drive.position` and
  `drive.forward` into state, `syncStateGeo()`, and subtract `drive.sink` from
  the radius in `applyTransform`. The wave sampling below still runs so the
  hull keeps heaving until it goes under.
- **Ride the hazard.** Each of the five `sampleWave` heights gains
  `hazardHeight(dir, hazard.live)` **after** the `DISPLACE_AMPLITUDE ·
  waveGain` scaling, since hazard heights are already world units and are not
  wind-scaled. The hull therefore climbs a crest and tips into a funnel.
- `place(dir: Vector3, headingRad: number): void` — sets the position, rebuilds
  `forward` from the heading (`forwardFromHeading`, the one other place a
  heading is an input), and halts. The respawn, and nothing else, calls it.

### `energy.ts`

`wreck(): void` — `state.level *= WRECK_KEEP` with `WRECK_KEEP = 0.25` beside
it in the house style. Reserve untouched; `rate` and `mode` untouched for the
same reason `spend` leaves them. A tank already at zero stays at zero and the
`RESTART_LEVEL` hysteresis is unaffected.

### `camera.ts`

`snap(ship: ShipState): void` — sets the camera position and target to their
damped destinations immediately. Without it the chase camera flies across the
planet for a second after the teleport; the blackout hides most of that but
the water it renders under the fade would still be streaking past.

### `waterpatch.ts`

One edit: paste `HAZARD_GLSL` into the vertex shader after the `waveWavefield`
chunk and add the hazard term to `displaced`, as written above. The plugin's
uniforms are already shared by reference through `...sphereMaterial.uniforms`,
so nothing else changes. Keep the `WATER_DISPLACED` define where it is.

### `waterhazard.ts` — the plugin

`createWaterHazardPlugin(): WaterHazardPlugin`, a `WaterPlugin` with one
extra method, `bind(state: HazardState)`. It has to be **constructed before
`createGlobe`** (the plugin rule in **The wave field**) but `hazards.ts` needs
`globe.heightMap` and `globe.towns`, which exist only after. So the plugin is
built first with an empty source, and `main.ts` binds it once `createHazards`
has run. Its `update` copies `live` into the uniform arrays every frame; unbound
or empty it writes `uHazCount = 0`.

### `radar.ts`

`update(dt, ship, wind, hazards: HazardState)`. Hazards are drawn from the
**live** frame, as the wind arrow is and for the same reason — they are moving
things attached to nothing on the picture — clipped to the bezel, in
`--magenta` (the HUD's warning accent; `ART-DIRECTION.md` §2.4 keeps it off
in-world objects, and the scope is UI). A crest is a line between its two ends
(`centre ± extent · east`, projected through the same inverse table the town
icons use) at `envelope` alpha. A maelstrom is a ring of radius
`extent · size` in scope units, with three short arcs on it turned by the
elapsed time so it visibly spins.

### `blackout.ts` — the fade

`createBlackout(): { run(onBlack: () => void): void; readonly active: boolean }`.
A full-viewport `<div>` in its own marked block of `index.html` / `style.css`,
above the HUD and below the loading splash. `run` fades it in over
`FADE_IN = 0.7` s, calls `onBlack` once fully opaque, holds `HOLD = 0.4` s,
fades out over `FADE_OUT = 1.0` s. Driven by CSS transitions and
`transitionend`, with a timer fallback so a tab that suspends transitions
cannot leave the screen black. Re-entrant calls while active are ignored.

### `main.ts`

Build order and the frame loop:

```ts
const waterHazard = createWaterHazardPlugin();          // before createGlobe
const waterPlugins = [createWaterWakePlugin(wake), waterHazard, ...];
// ...
const hazards = createHazards({ terrain, heightMap: globe.heightMap, waterBodies: globe.waterBodies,
                                towns: globe.towns, onSunk });
waterHazard.bind(hazards.state);
const blackout = createBlackout();

function onSunk(): void {
  energy.wreck();
  blackout.run(() => {
    ship.place(hazards.pickRespawn(), rng() * 2π);       // the sim's own stream, or Math.random — the heading is cosmetic
    view.snap(ship.state);
    hazards.reset();
  });
}
```

```
energy.update(dt, shipState, env)
wind.update(dt, shipState, energyState)
hazards.update(dt, shipState, energyState)        // rolls, transport, contact, push, spiral; writes HazardState
ship.update(dt, input, energyState, windState, globe.waveOffsets, hazards.state)
camera.update(...)
globe.update(...)                                 // the plugin's update copies hazards.state into uHaz…
...
radar.update(dt, shipState, windState, hazards.state)
```

Hazards run after the wind (they need this frame's docked verdict, same as the
wind does) and before the ship (the ship spends the push and obeys the drive).
The plugin reads the state in `globe.update`, after the ship has moved on it,
so the GPU sea and the CPU sea the hull just rode are the same frame's numbers.

**Under an overlay** the loop takes its five-call branch and hazards are simply
not updated: frozen with the rest of the world, uniforms and all. The overlay
buttons gain one more guard — `hazards.state.phase !== 'free'` — so a player
cannot open the fishing cover mid-spiral and halt a hull that is not theirs to
halt.

**Wind after a teleport** needs no change: `wind.ts` transports its direction
by the rotation between the last and current ship positions, and a large
rotation is still a rotation. Note it in `ARCHITECTURE.md`, do not "fix" it.

**Dev query.** `?hazard=wave|greatwave|maelstrom` calls `hazards.force` once,
three seconds after the first frame, 25 units dead ahead with `north` pointing
back at the ship. Guarded exactly like `?quality=` (a `URLSearchParams` read,
never `import.meta.env.MODE`), because the owner will use it against a
`vite preview` build. It is the only way to see a 1%-per-10-s event inside
the testing budget.

### Docs

`docs/ARCHITECTURE.md`: rows for `hazards.ts`, `hazardfield.ts`,
`waterhazard.ts`, `blackout.ts` in the module ownership table; the new frame
loop; a **Hazards** section carrying the polynomial-parity argument and the
distance fade; the `ship.ts`/`energy.ts`/`camera.ts`/`radar.ts` signature
changes. `README.md`: a **Rough water** bullet in the owner's voice. This
plan is left as written, per the convention at the top of `WIND_PLAN.md`.

## Constants

Author them at the top of their file with the reasoning beside each, in the
house style of `energy.ts`.

| Constant | Value | File |
|---|---|---|
| `ROLL_PERIOD` | 10 s | hazards |
| `P_WAVE` / `P_GREATWAVE` / `P_MAELSTROM` | 0.10 / 0.05 / 0.01 | hazards |
| `SPAWN_MIN` / `SPAWN_MAX` | 18 / 30 units | hazards |
| `AHEAD_SHARE` / `AHEAD_HALF_ARC` | 0.75 / 60° | hazards |
| `BERTH_MARGIN` | 4 units (added to `DOCK_RADIUS + extent`) | hazards |
| `CREST_HALF_LENGTH` / `CREST_HALF_WIDTH` | 10 / 2.5 units | hazardfield |
| `CREST_HEIGHT` / `GREAT_CREST_HEIGHT` | 1.6 / 2.4 units | hazardfield |
| `CREST_SPEED` | 6 units/s | hazards |
| `CREST_LIFE` / `CREST_RISE` / `CREST_FADE` | 10 / 1 / 1.5 s | hazards |
| `DISSIPATE` | 3 s (wave) / 5 s (greatwave) | hazards |
| `PUSH_PEAK` | 5 / 10 units/s | hazards |
| `HULL_REACH` | 1.0 unit | hazards |
| `MAELSTROM_RADIUS` | 10 units | hazardfield |
| `FUNNEL_DEPTH` / `RIM_HEIGHT` | 3.0 / 0.35 units | hazardfield |
| `MAELSTROM_GROW` / `MAELSTROM_LIFE` | 3 / 30 s | hazards |
| `SPIRAL_SECONDS` / `SPIRAL_TURNS` / `SINK_DEPTH` | 6 s / 2.5 / 2.5 units | hazards |
| `FADE_NEAR` / `FADE_FAR` | 32 / 38 units | hazards |
| `HAZ_STEP_WORLD` | 0.5 units | hazardfield |
| `MAX_HAZARDS` | 3 | hazardfield |
| `RESPAWN_CLEARANCE` | 6 units | hazards |
| `WRECK_KEEP` | 0.25 | energy |
| `FADE_IN` / `HOLD` / `FADE_OUT` | 0.7 / 0.4 / 1.0 s | blackout |
| `HAZARD_SEED` | any fixed hex | hazards |

## Performance

Per pixel the plugin adds three taps of `hazardHeight` (a loop of three
polynomial profiles) against the sphere's existing six `snoise` calls; per
patch vertex, one tap. Both are well under a tenth of the water's current
cost and need no quality-tier row. The GPU timer (Backquote) is the check; if
the `normal` hook shows up in it, drop its two extra taps to one by reusing
the vertex-side height as a varying — but measure first.

## Known artefacts, accepted

- The wake ribbon and the bow spray are lifted 0.4 above the flat sea, sized
  against a 0.3 gale. A 2.4-unit crest swallows both for the second it passes.
  The wake *foam* rides fine, because it is in the water shader.
- A crest's ends can pass under a coastline: the water is hidden by the land
  mesh there, and a raised crest can poke through a beach for a moment before
  the centre-on-land test kills it. Spawning refuses crests whose ends start
  on land, which is most of the cases.

## Work split

Three agents in parallel, in the same working tree, after one preparatory step
by the orchestrator. Files are partitioned so no two agents write the same
file; the two shared files (`index.html`, `style.css`) get a marked block for
the blackout in step 0 and only agent C edits inside it, **with Edit, never
Write**.

**Step 0 — orchestrator, before the agents start.** Land `HazardKind`,
`Hazard`, `HazardDrive`, `HazardState` in `types.ts`; stub `hazards.ts`
(empty state, no-op `update`/`reset`/`force`, `pickRespawn` returning the
spawn point), `hazardfield.ts` (constants, a `HAZARD_GLSL` that declares the
uniforms and a `hazardHeight` returning 0, a CPU `hazardHeight` returning 0),
`waterhazard.ts` (a plugin with the uniforms, empty hooks, no-op `bind`),
`blackout.ts` (no-op `run`); add the sixth argument to `ship.update` with its
default; insert `<!-- BLACKOUT -->` / `/* BLACKOUT */` blocks. `npm run build`
and `npm test` must be green before step 1, and stay green for every agent.

The stub signatures are the contract:

```ts
createHazards(deps): { state; update(dt, ship, energy); reset(); force(kind, centre, north); pickRespawn() }   // A
hazardHeight(dir, hazards): number;  HAZARD_GLSL: string;  MAX_HAZARDS                                          // B
createWaterHazardPlugin(): WaterPlugin & { bind(state) }                                                        // B
createBlackout(): { run(onBlack); active }                                                                      // C
ship.update(dt, input, energy, wind, waveOffsets?, hazard?);  ship.place(dir, heading)                          // C
energy.wreck();  camera.snap(ship)                                                                              // C
```

| Agent | Owns | Deliverable |
|---|---|---|
| **A — sim** | `hazards.ts`, `tests/unit/hazards.test.ts` | The roll, spawning, transport, contact and push, capture and spiral, `pickRespawn`. No DOM, no Three scene objects. Tier-1 tests: over 3000 s of rolls with a stationary ship in open ocean every kind appears and never twice at once; a crest forced onto the ship pushes with `along`/`across` peaking within 10% of `PUSH_PEAK` and back to zero by `DISSIPATE`; a maelstrom forced onto the ship captures it, every `drive.position` is unit length and within the radius, `onSunk` fires once at `SPIRAL_SECONDS`; docked → no push, no capture; `pickRespawn` returns reachable water off every berth. |
| **B — field** | `hazardfield.ts`, `waterhazard.ts`, `waterpatch.ts` (the one edit), `dev/probe.ts` (`?probe=hazard`), `tests/smoke/wave-parity.spec.ts` (a second test in the same file, same browser), `tests/unit/hazardfield.test.ts` | The height field in GLSL and float32 CPU, the three plugin hooks, the patch displacement, and the parity proof: a fixed crest, great crest and maelstrom over the probe's patch, encoded as `h / 8 + 0.5`, within 3/255 at every pixel. Tier-1: crest height at the centre equals amplitude × envelope, zero outside the footprint; funnel depth at the centre equals `-FUNNEL_DEPTH`; the field is symmetric in `u`. |
| **C — hull, loop, UI** | `ship.ts`, `energy.ts`, `camera.ts`, `blackout.ts` and its blocks, `radar.ts`, `main.ts`, `docs/ARCHITECTURE.md`, `README.md` | The push and the drive in the hull, the wreck, the fade, the scope marks, the wiring, the dev query, the docs. Develops against the step-0 stubs; A's and B's real modules drop in without a signature change. Tier-1: `ship-physics.test.ts` gains one case — a drive positions the hull and zeroes its speed, and `place` lands it stopped on the heading asked for. |

**Step 4 — orchestrator, integration.** `npm run build`, `npm test`, then
`npm run test:all` **once**. Then launch a preview and look, per the memory
note on headless screenshots and the budget in `docs/TESTING.md`:

- `?hazard=greatwave`: the crest rises ahead, displaces the sea, the hull
  climbs it, the SPEED readout jumps as the push lands, the crest dissolves
  behind, the scope shows a magenta bar approaching.
- `?hazard=maelstrom`: the funnel grows on the scope and the sea, the hull is
  taken, spirals, sinks, the screen goes black and comes back on a stopped
  ship somewhere else with POWER at a quarter of what it was and the reserve
  bar unchanged.
- The Vite log and the browser console show no shader errors. A green build
  is not a pass.

## Out of scope

Sound. A HUD warning line. Hazards in the save file (a reload starts clear).
Hazards on inland water. Difficulty scaling with distance from shore. A wake
ribbon that clears a crest. Any change to `waveField` itself or to the
existing parity probe's numbers.
