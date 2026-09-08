# Weather and the chart: implementation plan

Status: **implemented**, and landed on `claude/weather-fog-of-war-uicz6r`.

This document is kept as the record of what was approved. It is deliberately
NOT updated to follow later tuning — `docs/ARCHITECTURE.md` is the current
truth, and its **Weather** section is where to start. Seven things below were
changed by the build itself, and they are worth knowing before trusting the
rest:

- **The storm's haze got its own colour and a much smaller ceiling.**
  `STORM_MAX_GAIN` is **0.08**, not 0.25, and a downpour fades toward a dark
  `uFogStormColor` rather than toward the fog bank's pale grey. As written,
  the plan put a full storm at a 0.40 blend toward a bright grey and painted
  the entire ocean the "flat pale sheet" `fogglsl.ts` warns about twice. It
  was caught in a `?weather=storm` shot, which is exactly the failure mode
  those warnings describe.
- **The fog bank came down too.** `FOG_DENSITY_GAIN` is **3.5**, not 6, and
  `FOG_MAX_BANK` is **0.75**, not 0.85. At the planned numbers the water
  under the hull was 60% fog and the ship appeared to be sailing on paper —
  which `FOG_MAX_BANK`'s own comment forbids in those words.
- **`STORM_ODDS_GAIN` does not triple the encounters.** It triples the
  probability, which is worth about **2.7x** the raiders and only about
  **1.5x** the hazards, whose 1 Hz roll already saturates their
  one-of-each-kind cap. Both measured; see **Weather** in ARCHITECTURE.
- **`WeatherState` gained a sixth field, `flashLocal`.** Without it a
  squall's lightning lights nothing (no cell claims it in the map) or a
  cell's lightning flashes the clear sky overhead. The plan had neither case.
- **`WEATHERMAP_GLSL` declares its own sampler.** The plan told each consumer
  to declare `uWeatherMap` itself; two of the three did not, and the water and
  land shaders failed to compile. Nothing in the Node tier compiles GLSL, so
  only the browser tier saw it.
- **`applyAerial` gained a `wx` ARGUMENT rather than reading uniforms.** The
  plan implied uniforms; that would have hazed the battle arena, which merges
  the same `fogUniforms` object and freezes it for the length of a fight.
- **The plan's claim that fog cells never touch land is only true at BIRTH.**
  A bank drifts for up to six minutes and may perfectly well reach a coast
  afterwards. Left as it is: a bank that dissolved at a shoreline would be
  stranger to watch than the thing it prevents.

Two things the plan promised and the build did not do: `waterrain.ts`, the
rain-ripple water plugin, was the stated stretch goal and was not built; and
the four streams were run sequentially by one agent rather than in parallel
worktrees, so the file-ownership table below is a record of intent rather
than of who touched what.

This document is the complete brief. An implementing agent should not need the
conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**Units, pinned**, **World scale**, **The world environment**, **Frame loop**,
**The shared height map** and **Shader notes**; then `docs/WIND_PLAN.md` for
the phase machine the squalls hang off, and `docs/HAZARDS_PLAN.md` for the
shape of a multi-agent split in this repository and for how a thing with a
centre is carried over the globe. This plan follows the conventions recorded
there and adds to them.

Three systems are planned here, and they meet at two numbers:

- **Squalls**: weather at the ship, rolled off the wind's own phases. A strong
  event may become a storm, a quiet lull may fill with fog.
- **Cells**: regions of weather with a centre and a radius, drifting over the
  globe on their own bearings. A cell is visible on the scope and in the sky
  before the ship reaches it, and can be sailed around.
- **The chart**: the scope remembers what the ship has seen.

The numbers they meet at are the five weather **envelopes** at the ship
(squalls and cells combine into one `WeatherState`, and everything downstream
reads only that) and **visibility** (the weather decides how far the player
can see; the chart records what the player has seen).

## Decisions already made

These were settled with the project owner. Do not re-litigate them; if one turns
out to be unworkable, say so and stop rather than substituting another.

| Question | Decision |
|---|---|
| Scope | Weather effects **and** a fog-of-war chart, both in this branch. |
| Phenomena | Rain, storms with lightning, sea fog banks. Overcast is the build-up to a storm, not a phenomenon of its own. |
| Sources | **Both, independently.** Squalls rolled off the wind's phases, **and** regional cells that drift across the globe. Neither knows about the other's rolls; they combine only at the ship. |
| Squall rate | Roughly **one event in four** becomes a storm; the top of those get lightning. Fog only **during lulls, sometimes**, never during an event. |
| Cells: seeing them | **On the scope and in the sky.** A cell within scope range draws as a region; the cloud deck darkens and the haze thickens over a cell so a storm is a black mass on the horizon. |
| Cells: motion | **Own bearing, slower than the ship.** A cell draws a bearing at birth, drifts at a fifth of the ship's speed, lives a few minutes and dissipates. It can be outrun or rounded. |
| Cells: density | **Frequent.** A ship under way in open water should meet a cell about every two to three minutes. |
| Cells and wind | A storm cell **lifts the wind** toward its cap while the ship is inside it, so a storm always blows. This is the one coupling between the systems and it runs one way only. |
| Audio | **None.** Lightning is visual only. |
| 3D visibility | **Haze only.** Fog density and colour change; nothing is hard-culled. Clear weather renders exactly as today. |
| Gameplay | **Harsh.** Solar near zero in a storm; the scope down to a third of its range in thick fog; hazard and raider odds roughly tripled in a storm. |
| Chart | Coast **and** towns hidden until sailed near. **Persisted** across page loads. Discovery radius is the scope's current visibility, so fog also slows exploration. |
| Overlays | The battle sea is `ROUGH` only when the fight starts in a storm, `CALM` otherwise. The fishing card is unaffected. |
| Plan shape | Independent parallel streams after one preparatory step, in the `HAZARDS_PLAN` manner. |

## Units

- `WeatherState.storm`, `.rain`, `.fog`, `.cover`, `.flash` are all **[0, 1]**,
  dimensionless envelopes. Zero means "exactly what the game does today".
- `WeatherState.visibility` is **world units**, in `[VIS_MIN, RADAR_RANGE]`.
  The one number both the scope and the chart read. Clamped to `RADAR_RANGE`
  (50) because nothing in the game sees further than the scope; clear weather
  is `RADAR_RANGE` exactly.
- A cell's `centre` is a **unit direction**; its `north` is the unit tangent
  it travels along, parallel-transported exactly as a hazard's is. Its
  `radius` is **world units** (ship-scale: a cell is sized against the scope
  and the hull, not the planet). Its `strength` is **[0, 1]**.
- `CELL_DRIFT` is **world units per second**, like `ShipState.speed`.
- The weather map (`weathermap.ts`) is **data, not colour**, in the
  `wakemap.ts` sense: R is storm, G is fog, B is the lightning flag, and its
  `colorSpace` is `THREE.NoColorSpace`.
- Every duration is **seconds** of `dt`, capped at 0.1 like `wind.ts`.
- Squall probabilities are per **wind phase**. Cell spawn probabilities are
  per **roll**, at `CELL_ROLL_PERIOD`.

## Why this shape, and the three traps

The wind already runs a phase machine (lull, event, lull, ...) with a seeded
PRNG, a per-event ramp and a coast-dependent cap. A squall is that machine read
a second way: an event is a candidate storm, a lull is a candidate fog. Squalls
have **no clock of their own**.

A cell is a hazard's skeleton with a weather's skin: a centre and a travel
tangent carried by parallel transport, a radius, a lifecycle envelope, a
seeded roll that keeps a population alive around the ship. `hazards.ts` has
already solved the transport, the coast clip and the "spawn where the player
will meet it" problem; this plan copies its shapes and does not improve on
them.

Cells are drawn from a **map, not from uniform slots**. `waterhazard.ts` packs
three hazards into uniform arrays because a hazard is a height field the hull
must ride, and three is all there are. A cell is a shading field the whole sky
samples, there may be several, and the orbit shot wants every one on the lit
hemisphere. So `weathermap.ts` bakes the live cells into a small
equirectangular texture a few times a second, and the cloud and fog shaders
read it with the same `dirToEquirect` the height map and the water-body mask
already use. One texture read per pixel whatever the population, and no
`MAX_CELLS` in any shader.

**Trap 1: do not draw weather from the wind's PRNG.** `wind.ts` draws a fixed
sequence per phase and `tests/unit/wind.test.ts` and `world-golden.test.ts`
replay it. One extra `rng()` in `wind.ts` shifts every draw after it. Squalls
and cells each own a `mulberry32` on their own seed. The wind's stream is
untouched.

**Trap 2: zero must be bit-identical to today.** Every shader and light this
plan touches gains a term multiplied by a weather envelope or a map sample.
When those are 0 the term must vanish exactly. `fog.ts` records two separate
occasions when a small additive change washed the ocean pale. The rule for
every stream: **at all-zero envelopes and an empty map the frame is the frame
`main` renders.** Verify by eye with `npm run shots` at the end of every
stream.

**Trap 3: the map is not the truth.** The map is 2.45 world units per texel
and bilinear; it is what the *sky* reads. Everything that decides a number for
gameplay (the envelopes at the ship, visibility, the wind lift, the chart
stamp) samples the cells **analytically**, on the CPU, at the ship. The two
disagree by a texel at a cell's edge; the sky is soft there and nobody can
tell. A gameplay rule that reads the texture would be quantised to the map and
one frame stale.

## Step 0: the contract (orchestrator, before any stream starts)

Four files, committed once, so every stream compiles against the same
signatures and no stream waits on another.

### `src/types.ts`

`WindState` gains five read-only fields, all already locals in `wind.ts`:

```ts
phase: 'lull' | 'event';
phaseTime: number;        // seconds into the phase
phaseDuration: number;    // its length, seconds
phaseIndex: number;       // steps by one at every change, from 0
envelope: number;         // the event's own 0..1 ramp; 0 through every lull
```

`WeatherCell` and `CellsState`, new:

```ts
export type CellKind = 'storm' | 'fog';

export interface WeatherCell {
  readonly kind: CellKind;
  /** Unit direction. Live: moved by transport every frame. */
  readonly centre: Vector3;
  /** Unit tangent at `centre`, the way it drifts. */
  readonly north: Vector3;
  /** World units. Fixed for the cell's life. */
  readonly radius: number;
  /** 0..1 lifecycle: grows in, holds, fades out. */
  readonly strength: number;
  /** Storm cells only: true for the ones that carry lightning. */
  readonly lightning: boolean;
  readonly age: number;
  readonly life: number;
}

export interface CellsState {
  readonly live: readonly WeatherCell[];
  /** The field sampled analytically at the ship, this frame. */
  readonly stormAtShip: number;
  readonly fogAtShip: number;
  readonly lightningAtShip: boolean;
}
```

`WeatherState`, new:

```ts
export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'storm' | 'fog';

export interface WeatherState {
  readonly kind: WeatherKind;   // the HUD's label; nothing else may branch on it
  readonly cover: number;       // cloud build-up
  readonly rain: number;
  readonly storm: number;       // darkness: dims the key light, the sky, solar
  readonly fog: number;
  readonly flash: number;       // lightning, non-zero for a few hundred ms at a time
  readonly visibility: number;  // world units, [VIS_MIN, RADAR_RANGE]
}
```

### `src/weathercells.ts` (stub)

```ts
export interface WeatherCells {
  readonly state: CellsState;   // live, mutated in place
  /**
   * Runs BEFORE `wind.update`: the wind reads `stormAtShip` to lift itself.
   * Transport, ageing, the roll, then the at-ship sample, in that order, so
   * the sample is of the cells as they stand this frame.
   */
  update(dt: number, ship: ShipState, energy: EnergyState): void;
  /** Raises one cell now. Tests and `?cell=` only. */
  force(kind: CellKind, centre: Vector3, north: Vector3, radius?: number): void;
}
export function createWeatherCells(terrain: Terrain, heightMap: HeightMap, seed?: number): WeatherCells;
```

### `src/weather.ts` (stub)

```ts
export interface Weather {
  readonly state: WeatherState;
  /**
   * Runs after `wind.update` and before `hazards.update`: after the wind so
   * it reads this frame's phase, before the hazards so the roll multiplier
   * is this frame's storm.
   */
  update(dt: number, wind: WindState, cells: CellsState): void;
}
export function createWeather(seed?: number): Weather;
```

### `src/chart.ts` (stub)

```ts
export interface Chart {
  discovered(dir: Vector3): boolean;
  reveal(centre: Vector3, radius: number): void;
  encode(): string;
  onChange(fn: () => void): void;
}
export function createChart(width?: number, height?: number, encoded?: string | null): Chart;
```

Stubs return all-zero states, an empty `live`, `visibility = RADAR_RANGE`, and
`discovered` always true, so the game plays exactly as today until a stream
lands.

## Stream A: the two sims

### `src/weathercells.ts`

**The population.** Cells live in a **bubble** around the ship: they are
spawned no closer than `CELL_SPAWN_MIN` (90 world units: past the scope's 50
plus the largest radius, so a cell never appears already on the instrument)
and no further than `CELL_BUBBLE` (250 units), and a cell whose centre drifts
past `CELL_BUBBLE + 70` is retired and its slot freed. The bubble is a cap of
area `2πR²(1 − cos(250/200))` ≈ 172 000 u². The target population is
`CELL_TARGET = 3`.

That number comes from the owner's encounter rate, not the other way round. A
point moving in a field of discs of radius `r` at number density `n` meets one
every `1 / (2 r n)` units of travel. With `r ≈ 32` (the mean of the two kinds
below) and 3 cells in 172 000 u², that is about 900 units, or 90 s straight
flat out. Players do not sail straight and cells drift across their track, so
the felt rate lands in the two-to-three-minute band asked for. One more cell
puts it near a minute. Set `CELL_TARGET`, measure with the debug counter
below, and stop.

**The roll.** Every `CELL_ROLL_PERIOD` (10 s), one draw from the cells' own
PRNG, unconditionally (the `hazards.ts` discipline): spawn if
`draw < CELL_P_SPAWN * (CELL_TARGET − live.length) / CELL_TARGET`, with
`CELL_P_SPAWN = 0.6`. A full population never spawns; an empty one fills in
about a minute. Then, whether or not a spawn happened, the same fixed draws
for the candidate: kind (`CELL_FOG_SHARE = 0.4`), a bearing, a range in
`[CELL_SPAWN_MIN, CELL_BUBBLE]`, a radius, a life, a travel bearing, and a
lightning flag (`CELL_LIGHTNING_SHARE = 0.4` of storms). Seven draws per roll,
always, so the stream replays whether or not the population was full.

**Placement.** The candidate centre is the ship stepped along the bearing by
the range (great-circle, the `stepAlong` in `hazards.ts`). A **fog** cell is
rejected if the centre is on land or within `CELL_COAST_MARGIN` (15 u) of it
(the coast probe pattern in `wind.ts`, eight bearings at one ring); a fog bank
over a continent is a cloud, and the clouds are someone else's. A **storm**
cell may sit over land. A cell is not placed within `CELL_SPACING` (60 u) of
another's centre. A rejected candidate is simply not spawned; the roll cost
its draws and the next one comes in ten seconds.

**Sizes and lives.** Storm radius uniform in `[STORM_R_MIN, STORM_R_MAX]` =
`[25, 40]`; fog in `[FOG_R_MIN, FOG_R_MAX]` = `[35, 60]`. Life uniform in
`[CELL_LIFE_MIN, CELL_LIFE_MAX]` = `[180, 360]` s. `strength` is a trapezoid:
up over `CELL_GROW` (30 s), down over `CELL_FADE` (45 s), clamped to a third
of the life each, the `wind.ts` fade rule.

**Transport.** `CELL_DRIFT = 2` u/s along `north`, `north` carried by the same
rotation that moved `centre` (`hazards.ts`'s `transport`, verbatim in shape).
A fifth of `MAX_FORWARD`; a ship can leave a cell at will and cannot be caught
by one.

**Docked.** Cells do not care that the ship is docked; they are weather, not a
hazard. `energy` is taken for signature symmetry with `hazards.update` and
for the coast probe's shelter rule if one is ever wanted. It is not read in
this plan.

**The at-ship sample.** For each live cell, `d` is the arc distance from the
ship to `centre` (through `acos(clamp(dot))`, as `hazards.ts`'s
`arcDistance`), and its contribution is
`strength * (1 − smoothstep(CELL_CORE, 1.0, d / radius))` with
`CELL_CORE = 0.55`: flat inside just over half the radius, soft out to the
edge. `stormAtShip` is the max over storm cells, `fogAtShip` the max over fog
cells, `lightningAtShip` true if the strongest storm contribution came from a
lightning cell. Max, not sum: two overlapping cells are one weather, not a
double one.

**Debug.** `?cell=storm|fog|lightning` forces one cell of that kind 60 u dead
ahead at spawn, radius 35, life 600 s, like `?hazard=`. Under `?debug`,
`window.__pirateWorld.cells` publishes `live` and the at-ship sample, and
`window.__pirateWorld.cellEncounters` counts the frames-to-first-contact
transitions, which is how `CELL_TARGET` is measured.

### `src/weather.ts`

**The squall roll.** Watches `wind.phaseIndex`. On a step, two draws from its
own PRNG in a fixed order, both always taken:

| Phase | Draws | Outcome |
|---|---|---|
| event | `severity`, (second draw discarded) | `severity < STORM_SHARE` (0.25): storm-class; within that `severity < LIGHTNING_SHARE` (0.10): lightning-class. Otherwise a plain event, which still builds a little cover. |
| lull | `fogDraw`, `fogDepth` | `fogDraw < FOG_SHARE` (0.35) **and** `wind.phaseDuration >= FOG_MIN_LULL` (8 s): a fog bank of depth `FOG_FLOOR + fogDepth * (1 − FOG_FLOOR)`. |

**Combining.** Squall targets and cell samples are combined by `max` **before**
smoothing, so a cell is subject to the same time constants as a squall and
the two cannot flicker against each other:

- `stormTarget = max(squallStorm, cells.stormAtShip)`, where `squallStorm` is
  `wind.envelope` during a storm-class event, else 0. Stepped with
  `STORM_TAU` (1.5 s). The wind's own ramp is 2 s, so a squall arrives a beat
  behind the wind, and a cell you sail into arrives over the same beat.
- `rain = smoothstep(RAIN_ONSET, 1, storm)`, `RAIN_ONSET = 0.25`.
- `coverTarget = max(storm, COVER_PLAIN * wind.envelope, cells.stormAtShip)`,
  `COVER_PLAIN = 0.35`, stepped with `COVER_TAU` (4 s). The slow tau is what
  makes the sky clear *after* the rain stops.
- `fogTarget = max(squallFog, cells.fogAtShip)`, where `squallFog` is the
  lull's depth on its own trapezoid (`FOG_FADE = 3` s, clamped to a quarter of
  the lull) and 0 during any event. Stepped with `FOG_TAU` (1 s).
- `flash`: gated on `storm > FLASH_GATE` (0.6) **and** (a lightning-class
  squall is live **or** `cells.lightningAtShip`). Strikes are Poisson with
  mean `FLASH_MEAN` (6 s), drawn per frame from the squall PRNG, only while
  the gate is open (the gate is a pure function of replayed state, so the
  stream stays replayable). Each strike is `FLASH_PULSES` (2 or 3) pulses at
  `FLASH_GAP` (80 ms), each decaying as `exp(−t / FLASH_DECAY)`,
  `FLASH_DECAY = 0.12` s. `flash` is the max over live pulses, clamped to 1.

**Visibility.**

```
visibility = RADAR_RANGE * (1 − FOG_VIS_CUT * fog) * (1 − STORM_VIS_CUT * rain)
visibility = max(VIS_MIN, visibility)
```

`FOG_VIS_CUT = 0.67` (thick fog: a third of the scope), `STORM_VIS_CUT = 0.4`,
`VIS_MIN = 12` (about four hull lengths; a berth ring must stay visible or a
docking in fog is a guess).

**`kind`**, derived last, in priority: `fog > 0.5 → 'fog'`,
`storm > FLASH_GATE → 'storm'`, `rain > 0.1 → 'rain'`, `cover > 0.4 →
'overcast'`, else `'clear'`.

**Debug.** `?weather=clear|overcast|rain|storm|lightning|fog` pins the
envelopes and disables the squall roll (cells still run; combine `?cell=` and
`?weather=` to see both). `window.__pirateWorld.weather` under `?debug`.

### `src/wind.ts`

Exposes the five fields; `phaseIndex` increments in the existing transition
block, `envelope` is the existing `ramp`. No new draws, no reordered draws.

The lift. `update(dt, ship, energy, stormLift = 0)`, applied after the speed
is computed and before the transport:

```
state.speed = max(state.speed, stormLift * CELL_WIND_LIFT * state.cap)
```

`CELL_WIND_LIFT = 0.8`. Inside a full storm cell the wind is at least 80% of
its cap whatever the phase; the bearing is the phase's own, so a storm cell
does not choose which way it blows. A floor, not an offset, for the same
reason `LULL_SPEED` is one. `main.ts` passes `cells.state.stormAtShip`.
`tests/unit/wind.test.ts` passes unchanged with the default, and gains a case
for the floor and one asserting `phaseIndex` steps once per transition and
`envelope` is 0 through every lull.

### Tests (Tier 1, Vitest)

`weathercells.test.ts`, on the real terrain and a 256×128 height map like
`hazards.test.ts`, a stationary ship in open water:

- Over 1200 s the population reaches `CELL_TARGET` and never exceeds it.
- No cell is ever spawned within `CELL_SPAWN_MIN` of the ship; every cell is
  retired within one roll of crossing `CELL_BUBBLE + 70`.
- No fog cell's centre is on land or within `CELL_COAST_MARGIN` of it.
- `strength` is in [0, 1], reaches 1 for every cell whose life exceeds
  `CELL_GROW + CELL_FADE`, and is 0 at `age >= life`.
- `centre` stays unit and `north` stays tangent (dot under 1e-6) over 600 s
  of transport.
- The at-ship sample of a forced cell at the ship is its `strength`; at
  `1.1 × radius` it is 0.
- Same seed, same ship: identical `live` trace after 600 s.

`weather.test.ts`, on a scripted stub `WindState` and a scripted `CellsState`:

- Storm-class share within ±5 points of `STORM_SHARE` over 400 events;
  lightning within ±3 of `LIGHTNING_SHARE`.
- Fog share within ±5 of `FOG_SHARE` over 400 lulls of 12 s; exactly 0 over
  400 lulls of 5 s.
- Squall `storm` never exceeds `wind.envelope + 0.05` when cells are zero;
  with `cells.stormAtShip = 1` and the wind in a lull, `storm` rises to 1.
- `fog` is 0 during every event when cells are zero.
- `flash` is 0 outside the gate and never exceeds 1.
- `visibility` is `RADAR_RANGE` at all-zero and `>= VIS_MIN` always.
- Replayability: same seed, same scripts, identical trace.

## Stream B: the map, the sky, the light, the haze and the rain

Everything here is render-side. `globe.update` grows two arguments:
`globe.update(dt, env, wind, weather, cells, ship, camera)`.

### `src/weathermap.ts`, new

A `THREE.DataTexture`, RGBA8, `MAP_WIDTH = 512` by `MAP_HEIGHT = 256`,
`NoColorSpace`, linear filtering, `RepeatWrapping` in U so the antimeridian
blends. R is the storm field, G the fog field, B is 255 where the strongest
storm contribution is a lightning cell (the cloud shader flickers only there).

`bake(cells: CellsState)` runs at `MAP_HZ = 4` from `update`, and only when a
cell has moved more than half a texel or any `strength` has changed by more
than 1/255 since the last bake, which in practice is every call while any
cell is alive and never while none is. It clears the array and stamps each
cell's bounding box of rows and columns (the row band is `±radius / R`
radians; the column band per row is the same `acos` the chart's stamp uses),
writing `max(existing, profile)` with the **same** profile formula as the
at-ship sample. About 1 500 texels per cell; three cells at 4 Hz is nothing.
Then `needsUpdate = true`: a 512 KB upload four times a second, well under the
wake map's per-frame fill.

The bake is a pure function over a `Uint8Array` (`bakeWeatherMap(cells,
data, width, height)`), exported so a Node test can run it with no GPU.

`WEATHERMAP_GLSL` exports `weatherAt(sampler2D, vec3 dir) → vec3` (storm, fog,
lightning), built on `HEIGHTMAP_GLSL`'s `dirToEquirect`, which the consumer
pastes exactly as it pastes the height map snippet. Each consumer declares
its own `uniform sampler2D uWeatherMap` and merges `weatherMapUniforms` into
its map, the `fogUniforms` pattern.

### `clouds.ts`

`update(dt, env, weather)`. Per pixel, after `nWorld` is known and **after**
the two-octave early-out (a clear pixel must not pay for the weather):

```
vec3 wx    = weatherAt(uWeatherMap, nWorld);
float cover = max(uCover, wx.r);
float gloom = max(uGloom, wx.r);
```

- `cover` lowers the threshold: `thrBase = uThreshold − cover * COVER_GAIN + uBand * sin(...)`, `COVER_GAIN = 0.16`. At `cover = 1` this pushes the measured 25.9% sky coverage to roughly the 80s; measure once by the method the `uThreshold` comment describes and record the figure beside the constant.
- `gloom` mixes `uDayColor` and `uShadowColor` toward `STORM_CLOUD` (`#3a4250`) by `gloom * GLOOM_MIX` (0.8), before the shadow step so the underside darkens first.
- `uFlash` lifts the underside toward white by `uFlash * FLASH_CLOUD` (0.6), scaled by `max(uFlashLocal, wx.b)` so the flash lights the storm's own cloud and not the whole sky. `uFlashLocal` is 1 when the flash came from a squall (which has no place) and 0 when it came from a cell.

Since the early-out runs first, a pixel that was open sky at the base
threshold stays open sky even under a cell. `COVER_GAIN` is therefore chosen
so that a full cell moves the threshold by less than the early-out margin;
the measurement above confirms it. `SHELL_COUNT` is untouched; this stream
does not tier the deck.

### `sky.ts`

The dome gains `uGloom` and `uFlash` from the **at-ship** envelopes only. It
does not read the map: the dome is what shows between clouds, and under a
distant cell the clouds carry the darkness while the sky between them stays
the day's. `uGloom` pulls both day colours toward `STORM_SKY` (`#59626e`) by
`uGloom * 0.75` before the day/night mix, so a storm at night stays night.
`uFlash` adds `uFlash * FLASH_SKY` (0.35) of white after the dither. The
atmosphere shell is left alone.

### `daynight.ts`

`update(dt, env, weather)`. It remains the sole writer of `env`; the weather
touches the **lights**:

```
sun.intensity  = key * (1 − STORM_KEY_DIM * weather.storm) + FLASH_KEY * weather.flash
hemi.intensity = hemiBase * (1 − STORM_HEMI_DIM * weather.storm) + FLASH_HEMI * weather.flash
```

`STORM_KEY_DIM = 0.7`, `STORM_HEMI_DIM = 0.35`, `FLASH_KEY = 2.5`,
`FLASH_HEMI = 0.8`. Additive flash so it reads at night. `env.sunColor` is not
touched.

### `fog.ts` and `fogglsl.ts`

`FOG_MAX_AMOUNT` becomes a uniform `uFogMax` in `fogUniforms`, default 0.15.
`applyAerial` gains a sample of the map at the **fragment's** direction:

```
vec3 wx = weatherAt(uWeatherMap, normalize(worldPos));
float fogHere  = max(uFogHere, wx.g);
float rainHere = max(uRainHere, wx.r * RAIN_OF_STORM);
density = uFogDensity * (1.0 + FOG_DENSITY_GAIN * fogHere + STORM_DENSITY_GAIN * rainHere) * grazing * altFalloff;
fogMax  = mix(uFogMax, FOG_MAX_BANK, fogHere) + rainHere * STORM_MAX_GAIN;
colour  = mix(dayNightColour, uFogBankColour, max(fogHere, 0.6 * wx.r));
```

`FOG_DENSITY_GAIN = 6`, `STORM_DENSITY_GAIN = 2`, `FOG_MAX_BANK = 0.85`,
`STORM_MAX_GAIN = 0.25`, `RAIN_OF_STORM = 0.75`, `FOG_BANK_COLOUR = #aeb4b8`.
`uFogHere`/`uRainHere` are the at-ship `fog` and `rain`, written by
`updateFog(env, weather)`; the night endpoint of the bank colour is
`FOG_BANK_COLOUR * FOG_NIGHT_DARKEN` so a night fog is not a bright wall.

Sampling at the fragment rather than at the camera is what makes a fog cell
visible from outside: sea and land *inside* the cell go grey and flat while
the water at the ship stays sharp, which reads as a bank sitting on the
horizon. It is not a ray march; a cell between the camera and a clear
fragment is not seen through. Accepted (see artefacts).

The altitude fade (`FOG_ALTITUDE_FALLOFF = 20`) is kept: a fog bank is a
ground effect, and the orbital shot sees the sea through it while the cloud
deck above it shows the cell instead.

**The regression to watch**: with `uFogHere = uRainHere = 0` and an empty map
the three uniforms and the sample all hold today's values exactly. This
stream's `npm run shots` at `?weather=clear` is compared against `main`'s at
the same stations before anything else.

### `rain.ts`, new

A single `THREE.LineSegments` of `quality.rainDrops` drops in a ship-scale box
(`RAIN_BOX = 14` units across, `RAIN_HEIGHT = 10` tall) parented to a group
that follows the ship and is oriented by `ship.up`. Motion is the vertex
shader's: each drop has a seed attribute; its position is
`fract(seed + uTime * RAIN_FALL / RAIN_HEIGHT)` down the box's local up,
offset along the wind by `uWindDrift` (`wind.direction * RAIN_DRIFT`,
`RAIN_DRIFT = 0.35` of the fall speed), and the drop is a segment of
`RAIN_LENGTH = 0.5` units along its own velocity. Nothing is updated per drop
on the CPU.

- `opacity = uRain * RAIN_ALPHA` (0.35), `transparent`, `depthWrite: false`,
  additive, colour `#c8d4e0`. `visible` only while `rain > 0.02`, so the draw
  call is absent in fair weather.
- `LAYER_DEFAULT` only. Rain must not appear in the reflection cube.
- Rain is at the ship; it reads `weather.rain`, never the map.

### `quality.ts`

`rainDrops`: low **0**, medium **1500**, high **3000**. Zero means `rain.ts` is
not constructed (absent, not idle), the `reflectionSize = 0` convention. On
the low tier a storm is dark sky, dim light and haze.

### `waterrain.ts`, a `WaterPlugin` (stretch, do last)

`normal` hook: a high-frequency `snoise` ripple (`RAIN_RIPPLE_WAVELENGTH = 0.6`
units, through `freq()`) scaled by `uRainAmount * RAIN_RIPPLE`, faded with
`camDist` past 40 units. `foam` hook: `foam += uRainAmount * RAIN_SPECKLE`
(0.08) where the ripple is positive. Constructed in `main.ts` alongside the
other plugins **before** `createGlobe`. Ship without it if the stream runs out
of budget.

## Stream C: gameplay hooks

Each module gains one optional argument with a zero default so every existing
unit test runs unchanged. Stream C reads only `WeatherState`; it does not know
whether a storm is a squall or a cell.

### `energy.ts`

`update(dt, ship, env, overdriveActive?, moonNightFraction?, weather?)`. On
the solar line, and only there:

```
solarKeep = (1 − STORM_SOLAR_CUT * storm) * (1 − FOG_SOLAR_CUT * fog)
charge = SOLAR_PEAK * max(0, sunElevation) * solarKeep
```

`STORM_SOLAR_CUT = 0.95`, `FOG_SOLAR_CUT = 0.5`. Moonlight is cut by the same
factor. The dock branch is untouched; a berth charges in any weather, which is
the reason to run for one.

**Stranding.** With cells this needs a real argument, because a cell has a
radius and a ship can sit inside one. A squall ends with its event (30 s at
most). A storm cell's `strength` fades to 0 at the end of its life
(`CELL_LIFE_MAX = 360` s) and it drifts at 2 u/s, so a ship that cannot move
is out from under the worst of it within `radius / CELL_DRIFT` ≈ 20 s of the
centre passing and clear of it in at most 40 s. The longest a stationary ship
can be at `storm = 1` is therefore bounded by the cell's life, and a dead
ship in a storm cell sees the sun again within six minutes. `IDLE_ENDURANCE`
is 42 minutes. Nothing strands; a floor is not needed.

### `hazards.ts` and `aiboats.ts`

`update(...)` gains `stormOdds = 1`, a multiplier on the comparison and
nowhere else:

```
if (draw < ROLL_ODDS[kind] * stormOdds) trySpawn(kind, ship, wind);
```

`main.ts` computes `stormOdds = 1 + STORM_ODDS_GAIN * weather.state.storm`,
`STORM_ODDS_GAIN = 2`. The draw stays unconditional. A test drives 3000 s of
rolls at `stormOdds = 3` against 1 and asserts the spawn count ratio is in
2.5x..3.5x, on the existing `hazards.test.ts` harness.

### The battle

`main.ts:412` becomes

```
const battleOptions = battleParams.get('calm') === '1' ? CALM
  : battleParams.get('rough') === '1' ? ROUGH
  : weather.state.storm > BATTLE_STORM_GATE ? ROUGH : CALM;
```

`BATTLE_STORM_GATE = 0.5`, evaluated once when the cover card opens. The
shipping default moves from `ROUGH` to weather-dependent; `?rough=1` is new,
for the unit cases that pin the gunner.

### `hud.ts`

One row, `WX`, printing `weather.kind` in upper case, in the wind row's style.
`hud.update` gains `weather` as its fourth argument.

## Stream D: the chart and the scope

### `chart.ts`

An equirectangular `Uint8Array` bitmap, one byte per texel in memory (the
radar samples it 37 000 times per raster and a byte read beats a shift),
`CHART_WIDTH = 1024` by `CHART_HEIGHT = 512`. A texel is 1.2 world units at the
equator against the scope's 0.52-unit pixel: a discovery edge two scope
pixels wide, the blur of a pencil line.

`reveal(centre, radius)` stamps a spherical cap: for each latitude row within
`±radius / GLOBE_RADIUS` of the centre, the longitude half-width is
`acos((cos θ − sin φ0 sin φ) / (cos φ0 cos φ))`, clamped at the poles to the
full row. About 6 500 texel writes for a 50-unit radius; run from `radar.ts`
at its `RASTER_HZ` (10 Hz), skipped when the ship has moved less than half a
texel since the last stamp and visibility has not grown. `weathermap.ts`'s
bake uses the identical row/column arithmetic; Step 0 puts it in `geo.ts` as
`capColumns(lat, lat0, angRadius)` so the two cannot disagree.

`discovered(dir)` is the `sample(dir)` shape `heightmap.ts` uses, nearest
texel.

**Persistence** is a **separate key**, `pirate-world.chart`, not a field of
`SaveData`: `save.ts` rewrites the whole file on every catch, purchase and
battery percent, and a 64 KB chart riding along with each is the wrong
cadence. `onChange` fires at most once per `CHART_SAVE_INTERVAL` (5 s) while
dirty, plus once on `pagehide`. Encoding: version byte, then the bitmap
bit-packed and base64'd (about 87 KB). The loader is in `save.ts`'s style:
missing key, wrong version, wrong length or bad base64 all yield a blank chart
and one console note. `save.ts` records `CHART_KEY` beside `SAVE_KEY`.

### `radar.ts`

`update(dt, ship, wind, hazards, boats?, weather?, cells?, chart?)`.

- **Visibility ring.** In `raster()`, a pixel with `r > visibility / RADAR_RANGE`
  paints `SCOPE_FOG` (the scope's sea colour at 40%) and skips the height-map
  read. The precomputed tables are untouched; the geometry is fixed and the
  weather masks it. The range rings still draw over the mask.
- **Uncharted.** Inside visibility: drawn as today. Outside visibility but
  discovered: coast in `SCOPE_CHART` (sea at 60%, land at 70%), remembered
  not seen. Outside and undiscovered: `SCOPE_FOG`.
- **Towns and docks** cull on `cos(visibility / GLOBE_RADIUS)` unless
  `chart.discovered(town.dir)`, in which case they draw at `ICON_FADE` alpha
  to the scope edge as today.
- **Hazards and raiders** cull on visibility only. Live things; the chart does
  not remember them.
- **Cells.** Drawn from the live frame like hazards, between the raster and
  the hazards so a hazard inside a storm draws over it: `projectLive(centre)`,
  a disc of `radius * strength / RADAR_RANGE` (it grows on the scope as the
  cell grows), filled at `CELL_ALPHA` (0.28) in `SCOPE_STORM` (a desaturated
  slate) or `SCOPE_FOGCELL` (a pale grey), clipped by the scope circle and,
  like everything else, by visibility. A lightning cell gets a small zigzag at
  its centre in the storm colour. A disc whose centre is off the scope but
  whose edge is on it still draws: the arc-distance test uses
  `RADAR_RANGE + radius`, not `RADAR_RANGE`.
- **The stamp.** After `raster()`, `chart.reveal(ship.position, visibility)`.

### Tests (Tier 1)

- `reveal` then `discovered`: centre, 0.9 radius, 1.1 radius; at a pole and
  across the antimeridian.
- `encode` → `createChart(..., encoded)` round-trips bit for bit.
- Garbage in yields a blank chart and does not throw.
- The `onChange` throttle: 100 reveals in 1 s fire once.
- `capColumns` (in `geo.test.ts`): the half-width at the centre row equals the
  angular radius over `cos φ0`; it is the full row when the cap covers a pole.

## Changes to existing modules, by file

| File | Change | Stream |
|---|---|---|
| `types.ts` | `WindState` +5, `WeatherCell`, `CellsState`, `WeatherState`, `WeatherKind`, `CellKind` | Step 0 |
| `geo.ts` | `capColumns` | Step 0 |
| `wind.ts` | expose the phase fields; the `stormLift` floor | A |
| `weathercells.ts` | new: the cells | A |
| `weather.ts` | new: the squalls and the combine | A |
| `weathermap.ts` | new: the bake and `WEATHERMAP_GLSL` | B |
| `clouds.ts` | map sample; `uCover`, `uGloom`, `uFlash`, `uFlashLocal` | B |
| `sky.ts` | `uGloom`, `uFlash` on the dome | B |
| `daynight.ts` | dim and flash the key and hemisphere lights | B |
| `fog.ts`, `fogglsl.ts` | `uFogMax`; map sample at the fragment; bank colour | B |
| `rain.ts` | new: the drops | B |
| `quality.ts` | `rainDrops` | B |
| `waterrain.ts` | new plugin, stretch | B |
| `globe.ts` | thread `weather` and `cells`; own `weatherMap.update` | B |
| `energy.ts` | `solarKeep` on the solar line | C |
| `hazards.ts`, `aiboats.ts` | `stormOdds` on the roll comparison | C |
| `hud.ts` | `WX` row | C |
| `chart.ts` | new: the bitmap and its encoding | D |
| `radar.ts` | visibility mask, uncharted mask, town cull, cells, the stamp | D |
| `save.ts` | `CHART_KEY`, the tolerant chart loader and writer | D |
| `main.ts` | construct `cells`, `weather`, `chart`, `rain`; the loop; the battle gate; `?weather=`, `?cell=`, `?rough=` | integration |
| `docs/ARCHITECTURE.md` | module rows, frame loop, units, a **Weather** section | integration |

**File ownership is exclusive.** No two streams write the same file.

## `main.ts`: the frame loop after integration

```
energy.update(dt, ship.state, env, overdriveActive, moonNightFraction, weather.state)
cells.update(dt, ship.state, energy.state)             // BEFORE wind: the wind reads stormAtShip
wind.update(dt, ship.state, energy.state, cells.state.stormAtShip)
weather.update(dt, wind.state, cells.state)            // after wind: this frame's phase; before hazards: this frame's odds
hazards.update(dt, ship.state, energy.state, wind.state, stormOdds)
aiBoats.update(dt, ship.state, energy.state, hazards.state, suppressed(), stormOdds)
ship.update(...)                                       // unchanged
view.update(...)
aiHulls.update(...)
globe.update(dt, env, wind.state, weather.state, cells.state, ship.state, view.camera)
                                                       // daynight, fog, weatherMap (bakes, at MAP_HZ), water, patch, land, citylights, clouds, sky, celestial
rain.update(dt, ship.state, wind.state, weather.state) // after globe: follows the hull the camera just framed
reflection.update(...)
docks.update(...)
wake.update(...)
hud.update(ship.state, energy.state, wind.state, weather.state)
radar.update(dt, ship.state, wind.state, hazards.state, aiBoats.state, weather.state, cells.state, chart)
```

`energy.update` reads last frame's `weather.state`, one frame stale, the same
16 ms it already accepts on the sun. Under the frozen-overlay branch and the
battle branch neither `cells.update` nor `weather.update` runs, exactly as
`wind.update` does not: the weather freezes with the world, and the map is
not re-baked. `energy.update` in those branches passes `weather.state` too, so
a card opened in a storm keeps not charging.

## Constants

All authored at the top of their file with the reasoning beside each, in the
house style. The owner's visual pass may move any render-side number.

| Constant | Value | Where |
|---|---|---|
| `CELL_TARGET` | 3 | weathercells.ts |
| `CELL_ROLL_PERIOD` / `CELL_P_SPAWN` | 10 s / 0.6 | weathercells.ts |
| `CELL_SPAWN_MIN` / `CELL_BUBBLE` / retire margin | 90 / 250 / +70 u | weathercells.ts |
| `CELL_FOG_SHARE` / `CELL_LIGHTNING_SHARE` | 0.4 / 0.4 | weathercells.ts |
| `STORM_R_MIN..MAX` / `FOG_R_MIN..MAX` | 25..40 / 35..60 u | weathercells.ts |
| `CELL_LIFE_MIN..MAX` / `CELL_GROW` / `CELL_FADE` | 180..360 / 30 / 45 s | weathercells.ts |
| `CELL_DRIFT` | 2 u/s | weathercells.ts |
| `CELL_COAST_MARGIN` / `CELL_SPACING` | 15 / 60 u | weathercells.ts |
| `CELL_CORE` | 0.55 | weathercells.ts (and the bake) |
| `CELL_WIND_LIFT` | 0.8 | wind.ts |
| `STORM_SHARE` / `LIGHTNING_SHARE` | 0.25 / 0.10 | weather.ts |
| `FOG_SHARE` / `FOG_MIN_LULL` / `FOG_FLOOR` / `FOG_FADE` | 0.35 / 8 s / 0.5 / 3 s | weather.ts |
| `STORM_TAU` / `COVER_TAU` / `FOG_TAU` | 1.5 / 4 / 1 s | weather.ts |
| `RAIN_ONSET` / `COVER_PLAIN` | 0.25 / 0.35 | weather.ts |
| `FLASH_GATE` / `FLASH_MEAN` / `FLASH_PULSES` / `FLASH_GAP` / `FLASH_DECAY` | 0.6 / 6 s / 2..3 / 0.08 s / 0.12 s | weather.ts |
| `FOG_VIS_CUT` / `STORM_VIS_CUT` / `VIS_MIN` | 0.67 / 0.4 / 12 u | weather.ts |
| `MAP_WIDTH` / `MAP_HEIGHT` / `MAP_HZ` | 512 / 256 / 4 | weathermap.ts |
| `COVER_GAIN` / `GLOOM_MIX` / `FLASH_CLOUD` | 0.16 / 0.8 / 0.6 | clouds.ts |
| `STORM_CLOUD` / `STORM_SKY` / `FOG_BANK_COLOUR` | `#3a4250` / `#59626e` / `#aeb4b8` | clouds, sky, fog |
| `FLASH_SKY` | 0.35 | sky.ts |
| `STORM_KEY_DIM` / `STORM_HEMI_DIM` / `FLASH_KEY` / `FLASH_HEMI` | 0.7 / 0.35 / 2.5 / 0.8 | daynight.ts |
| `FOG_DENSITY_GAIN` / `STORM_DENSITY_GAIN` / `FOG_MAX_BANK` / `STORM_MAX_GAIN` / `RAIN_OF_STORM` | 6 / 2 / 0.85 / 0.25 / 0.75 | fog.ts |
| `RAIN_BOX` / `RAIN_HEIGHT` / `RAIN_FALL` / `RAIN_DRIFT` / `RAIN_LENGTH` / `RAIN_ALPHA` | 14 / 10 u / 18 u/s / 0.35 / 0.5 u / 0.35 | rain.ts |
| `rainDrops` | 0 / 1500 / 3000 | quality.ts |
| `STORM_SOLAR_CUT` / `FOG_SOLAR_CUT` | 0.95 / 0.5 | energy.ts |
| `STORM_ODDS_GAIN` / `BATTLE_STORM_GATE` | 2 / 0.5 | main.ts |
| `CHART_WIDTH` / `CHART_HEIGHT` / `CHART_SAVE_INTERVAL` | 1024 / 512 / 5 s | chart.ts |
| `CHART_KEY` | `'pirate-world.chart'` | save.ts |
| `SCOPE_FOG` / `SCOPE_CHART` / `CELL_ALPHA` | 40% / 60..70% / 0.28 | radar.ts |

Every one of these is dimensionless, a time, or ship-scale. The cell bubble
and spawn distances are ship-scale on purpose: they are sized against the
scope and the hull's speed, and should not grow with the globe. The map's
and chart's resolutions are angular by construction.

## Performance

- The two sims are a few dozen float operations per frame plus one coast
  probe per spawn attempt (every 10 s at most). Free.
- The map bake is ~1 500 texel writes per cell at 4 Hz and one 512 KB upload;
  under the wake map's per-frame fill.
- The cloud shader gains one texture read per pixel per slice, after the
  early-out, so open sky pays nothing. The fog gains one read per water and
  land fragment. Neither adds a noise sample.
- Rain is one draw call of `2 × rainDrops` vertices, present only while
  raining.
- The chart stamp is ~6 500 byte writes at 10 Hz; the raster gains one byte
  read per pixel. Inside the radar's own budget.
- Storage: 87 KB under its own key, at most every 5 s while exploring.

## Known artefacts, accepted

- **No bolt.** Lightning is a flash on the cloud base, the sky and the lights.
  A bolt mesh is the first thing to add if the flash reads as a glitch.
- **Rain is a box.** A drop pops in at the box's edge; `RAIN_BOX` puts the
  edge behind the chase camera at its near framing.
- **The haze is not a ray march.** A fog cell between the camera and a clear
  fragment is not seen through; what is seen is the fragments inside the
  cell going grey. From the deck this reads as a bank on the horizon, which
  is the effect wanted; from a high oblique angle a cell's near edge is a
  line on the sea rather than a wall of air.
- **Fog does not reach orbit.** The altitude fade is kept; from far zoom a
  fog cell shows in the cloud deck (via the map) and not in the sea.
- **Squalls are invisible before they hit.** A squall has no place; the
  player learns of one as the sky greys and the scope shrinks. Cells are what
  can be seen coming.
- **The map is coarse.** 2.45 u per texel, bilinear: a cell's edge in the
  cloud deck is a soft ring two texels wide. That is a feature in a cloud.
- **A storm cell over land** darkens the land's sky and haze and lifts no
  wind (the ship is not there). Fine.
- **A squall near a coast** is a storm at `COAST_CAP`: dark, wet, not very
  windy. Consistent with the wind.
- **The population is small.** Three cells in a 250-unit bubble means the
  scope has a cell on it perhaps a third of the time and the sky shows one
  more often. That is the encounter rate asked for; if the sky wants to be
  busier without more encounters, the answer is larger fog cells, not more of
  them.

## Work split

**Step 0** (orchestrator, one commit): `types.ts`, `geo.ts`'s `capColumns`,
the three stubs, and `weather`/`cells` threaded as **optional, defaulted**
parameters through `wind.update`, `globe.update`, `energy.update`,
`hazards.update`, `aiBoats.update`, `hud.update` and `radar.update`, so every
stream's signature exists and `npm test` is green before anyone starts.
Nothing in Step 0 changes behaviour.

Then four agents in parallel, each in its own worktree branched from Step 0,
files partitioned as the table above:

| Agent | Owns | Deliverable |
|---|---|---|
| A: sims | `weathercells.ts`, `weather.ts`, `wind.ts`, their tests | Cells that spawn, drift, fade and are sampled at the ship; squalls off the wind; one combined `WeatherState`; the wind floor; `?weather=`, `?cell=` |
| B: sky | `weathermap.ts`, `clouds.ts`, `sky.ts`, `daynight.ts`, `fog.ts`, `fogglsl.ts`, `rain.ts`, `quality.ts`, `globe.ts`, `waterrain.ts` (stretch), `weathermap.test.ts` | A cell you can see on the horizon; a storm, a fog and a flash you can see at the ship; shots at each `?weather=` and `?cell=` against `main`'s |
| C: gameplay | `energy.ts`, `hazards.ts`, `aiboats.ts`, `hud.ts`, their tests | Solar, odds, the `WX` row |
| D: chart | `chart.ts`, `radar.ts`, `save.ts`, `chart.test.ts` | A scope that fogs, shows cells, remembers, and survives a reload |

B can build and shoot against `?cell=` only after A's `force` exists; until
then B drives its shaders with a hand-filled `CellsState` in the debug hook.
This is the one cross-stream dependency and it is at the *end* of B's work.

**Integration** (orchestrator): merge A through D, wire `main.ts`, update
`docs/ARCHITECTURE.md` (module rows for `weathercells.ts`, `weather.ts`,
`weathermap.ts`, `rain.ts`, `chart.ts`; the frame loop block; **Units,
pinned**; a **Weather** section covering the three traps), run `npm run
test:all` once, take the owner's shot set, measure `CELL_TARGET` against the
encounter counter over one full day (20 min at `?dev`), and bump the version.

## Verification, and the budget

`docs/TESTING.md`'s rule applies: under five minutes of testing across the
whole job.

- Tier 1 (`npm test`, ~2 s): every stream on every change. New files:
  `weathercells.test.ts`, `weather.test.ts`, `weathermap.test.ts` (the bake
  on a `Uint8Array`: one forced cell peaks at its centre texel and is 0 past
  its radius; two overlapping cells take the max; the antimeridian wraps),
  `chart.test.ts`; new cases in `wind.test.ts`, `hazards.test.ts`,
  `energy-navigation.test.ts`, `geo.test.ts`.
- Tier 2 (`npm run test:smoke`, ~50 s): once at integration.
- Tier 3 (`npm run shots`, ~30 s): B at `?weather=clear` first, diffed by eye
  against `main`; then at each pinned kind and at `?cell=storm` and
  `?cell=fog`. D once for the scope. The orchestrator once at the end.

## Out of scope

- Audio of any kind.
- Weather fronts, prevailing winds, seasons, or any coupling from the weather
  back into the wind beyond the storm floor.
- Hard-culling raiders, beacons or city lights beyond visibility.
- Bolt geometry, rain in the battle arena, wet-deck or hull effects.
- Weather on the fishing card, or any change to the fishing sim.
- A ray-marched fog, or fog you can see *through* from outside.
- A "clear the chart" control; one line in the menu if wanted later.

## Trade-offs accepted

| Choice | For | Against |
|---|---|---|
| Two independent sources, combined by `max` at the ship | Squalls keep the wind and the weather coinciding; cells give the player something to see and route around; neither roll knows the other, so each is testable alone | Two PRNGs and two rolls to tune; a squall inside a cell is invisible (max hides it); the sky can be grey for two different reasons the HUD cannot distinguish |
| Cells drawn from a baked map, not uniform slots | Whole-globe coverage from orbit; constant shader cost whatever the population; no `MAX_CELLS` in any shader; the same `dirToEquirect` the height map uses | A CPU bake and a 512 KB upload at 4 Hz; a soft two-texel edge; the map is a frame stale against the analytic sample (Trap 3) |
| Cells live in a bubble around the ship | The whole population is where the player is; encounter rate is a closed-form function of `CELL_TARGET` | Weather does not exist where the ship is not; a cell the player saw and sailed away from is retired, not remembered |
| A storm cell floors the wind | A storm always blows; no second wind system | One coupling between "independent" systems, and it runs before `wind.update`, which puts `cells.update` first in the loop |
| Haze sampled at the fragment, not marched | A fog cell is visible from outside as grey sea and land; one texture read | Not seen through; a cell between the camera and a clear fragment is missed |
| Scope masked, not re-ranged | Precomputed projection tables stay; range rings stay readable | Full raster paid every 100 ms even when two thirds of it is grey |
| Chart under its own storage key | Save cadence and size unchanged; blank-on-garbage without touching `SaveData` | Two keys to clear on a reset; the chart is outside the versioned file |
| Harsh numbers | Weather is a threat worth sheltering from | A first storm is a dark screen and a draining tank; the `WX` row and the scope's disc are the explanation |
