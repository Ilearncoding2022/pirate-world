# Weather and the chart: implementation plan

Status: **proposed**, awaiting the owner's approval. No code has been written
against it.

This document is the complete brief. An implementing agent should not need the
conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**Units, pinned**, **World scale**, **The world environment**, **Frame loop**
and **Shader notes**; then `docs/WIND_PLAN.md` for the system this one hangs
off, and `docs/HAZARDS_PLAN.md` for the shape of a multi-agent split in this
repository. This plan follows the conventions recorded there and adds to them.

Two systems are planned here because they share one number: **visibility**.
The weather decides how far the player can see; the chart records what the
player has seen. They are otherwise independent and are built by different
agents.

## Decisions already made

These were settled with the project owner. Do not re-litigate them; if one turns
out to be unworkable, say so and stop rather than substituting another.

| Question | Decision |
|---|---|
| Scope | Weather effects **and** a fog-of-war chart, both in this branch. |
| Phenomena | Rain, storms with lightning, sea fog banks. Overcast is the build-up to a storm, not a phenomenon of its own. |
| Source | **Driven by the wind.** Storms escalate from wind events; fog rolls in during some lulls; clear in between. Weather is always at the ship, like the wind is. No regional cells. |
| Storm rate | Roughly **one event in four** becomes a storm. The top of those get lightning. |
| Fog timing | **During lulls, sometimes.** Never during an event. |
| Audio | **None.** Lightning is visual only. The game has no audio and this is not where it starts. |
| 3D visibility | **Haze only.** Fog density and colour change; nothing is hard-culled. Clear weather renders exactly as today. |
| Gameplay | **Harsh.** Solar near zero in a storm; the scope down to a third of its range in thick fog; hazard and raider odds roughly tripled in a storm. |
| Chart | Coast **and** towns hidden until sailed near. **Persisted** across page loads. Discovery radius is the scope's current visibility, so fog also slows exploration. |
| Overlays | The battle sea is `ROUGH` only when the fight starts in a storm, `CALM` otherwise. The fishing card is unaffected. |
| Plan shape | Independent parallel streams after one preparatory step, in the `HAZARDS_PLAN` manner. |

## Units

- `WeatherState.storm`, `.rain`, `.fog`, `.cover`, `.flash` are all **[0, 1]**,
  dimensionless envelopes. Zero means "exactly what the game does today".
- `WeatherState.visibility` is **world units**, in `[VIS_MIN, RADAR_RANGE]`.
  It is the one number both the scope and the chart read, and it is clamped to
  `RADAR_RANGE` (50) because nothing in the game can see further than the scope
  does; clear weather is `RADAR_RANGE` exactly.
- Every duration is **seconds** of `dt`, capped at 0.1 like `wind.ts`.
- Every probability is per **wind phase**, not per second. There is no roll
  timer in `weather.ts`; a roll happens when `WindState.phaseIndex` changes.

## Why this shape, and the two traps

The wind already runs a phase machine (lull, event, lull, ...) with a seeded
PRNG, a per-event ramp and a coast-dependent cap. The weather is that machine
read a second way: an event is a candidate storm, a lull is a candidate fog.
The weather therefore has **no clock of its own**, cannot drift from the wind,
and inherits the wind's reproducibility for free.

**Trap 1: do not draw weather from the wind's PRNG.** `wind.ts` draws a fixed
sequence of numbers per phase (duration, bearing, gust lane), and
`tests/unit/wind.test.ts` and `tests/unit/world-golden.test.ts` replay that
stream. One extra `rng()` call per phase in `wind.ts` shifts every draw after
it and changes the weather of every existing golden. `weather.ts` owns its
**own** `mulberry32` on its own seed and draws from it only when the phase
index steps. The wind's stream is untouched.

**Trap 2: zero must be bit-identical to today.** Every shader and light this
plan touches gains a term that is multiplied by a weather envelope. When that
envelope is 0 the term must vanish exactly, not approximately: the water depth
ramp, the sky at noon and the key light are tuned to a tenth, and
`fog.ts` records two separate occasions when a small additive change washed
the ocean pale. The rule for every stream: **at `storm = rain = fog = cover =
flash = 0` the frame is the frame `main` renders.** Verify it by eye with
`npm run shots` at the end of every stream; the shots are the regression test
this repository has for looks.

## Step 0: the contract (orchestrator, before any stream starts)

Three files, committed once, so that every stream compiles against the same
signatures and no stream waits on another.

### `src/types.ts`

`WindState` gains five read-only fields. `wind.ts` already has every one of
these as a local; they are exposed, not invented.

```ts
/** Which half of the cycle the wind is in. */
phase: 'lull' | 'event';
/** Seconds into the current phase. */
phaseTime: number;
/** Length of the current phase, seconds. */
phaseDuration: number;
/**
 * Steps by one at every phase change, starting at 0. The weather rolls on
 * the step, never on the phase name, so a lull that follows a lull (it
 * cannot, but nothing downstream should assume that) still rolls once.
 */
phaseIndex: number;
/**
 * The event's own ramp, 0..1: the rise-and-fall `wind.ts` already computes
 * as `ramp`. 0 through every lull. The storm rides this so the rain and the
 * wind peak together and stop together.
 */
envelope: number;
```

`WeatherState`, new:

```ts
export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'storm' | 'fog';

export interface WeatherState {
  /** The name the HUD prints. Derived from the four envelopes below. */
  readonly kind: WeatherKind;
  /** Cloud build-up, 0..1. Rises through a storm-class event, and a little through every event. */
  readonly cover: number;
  /** Rain density, 0..1. */
  readonly rain: number;
  /** Storm darkness, 0..1. Dims the key light, the sky and solar. */
  readonly storm: number;
  /** Sea fog, 0..1. */
  readonly fog: number;
  /** Lightning, 0..1. Non-zero for a few hundred milliseconds at a time. */
  readonly flash: number;
  /** How far the ship can see, world units, in [VIS_MIN, RADAR_RANGE]. */
  readonly visibility: number;
}
```

### `src/weather.ts` (stub)

```ts
export interface Weather {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: WeatherState;
  /**
   * Runs after `wind.update` and before `hazards.update`: after the wind so
   * it reads this frame's phase, before the hazards so the roll multiplier
   * is this frame's storm.
   */
  update(dt: number, wind: WindState): void;
}
export function createWeather(seed?: number): Weather;
```

The stub returns a state of all zeros and `visibility = RADAR_RANGE`, and its
`update` does nothing. Stream A fills it in.

### `src/chart.ts` (stub)

```ts
export interface Chart {
  /** True if the direction has ever been within visibility of the ship. */
  discovered(dir: Vector3): boolean;
  /** Stamp a disc of `radius` world units around `centre` as discovered. */
  reveal(centre: Vector3, radius: number): void;
  /** Encoded for storage. Called by the persistence layer, not the loop. */
  encode(): string;
  /** Fires at most once per CHART_SAVE_INTERVAL while the chart is dirty. */
  onChange(fn: () => void): void;
}
export function createChart(width?: number, height?: number, encoded?: string | null): Chart;
```

The stub's `discovered` returns `true` for everything, so the radar draws as
it does today until Stream D lands.

## Stream A: `src/weather.ts`, the sim

### Rolling

`weather.ts` watches `wind.phaseIndex`. On a step it draws from its own PRNG,
once per phase, in a **fixed order** regardless of outcome (the same
unconditional-draw discipline `hazards.ts` documents on `ROLL_ORDER`): the
stream must replay whether or not a storm happened last time.

| Phase | Draw | Outcome |
|---|---|---|
| event | `severity = rng()` | `severity < STORM_SHARE` (0.25): storm-class. Within that, `severity < LIGHTNING_SHARE` (0.10): lightning-class. Otherwise a plain event, which still builds a little cover. |
| lull | `fogDraw = rng()`, `fogDepth = rng()` | `fogDraw < FOG_SHARE` (0.35) **and** `wind.phaseDuration >= FOG_MIN_LULL` (8 s): a fog bank of depth `FOG_FLOOR + fogDepth * (1 - FOG_FLOOR)`. Both numbers are always drawn. |

Storm-class events keep their severity for the whole event. Two draws per
phase, always, so an event with a lull's second draw wasted is the price of a
replayable stream; it costs nothing.

### Envelopes

All four are driven, never integrated, so a capped `dt` cannot make them
overshoot. Where a target is stepped the step is the `1 - exp(-dt / tau)` form
`wind.ts` uses on its push.

- **`storm`** target is `wind.envelope` during a storm-class event, 0
  otherwise. Stepped with `STORM_TAU` (1.5 s). The wind's own ramp is 2 s, so
  the storm arrives a beat behind the wind and leaves a beat after it, which is
  what a squall does.
- **`rain`** is `storm` shaped: `rain = smoothstep(RAIN_ONSET, 1, storm)` with
  `RAIN_ONSET = 0.25`. Rain starts once the storm is a quarter in and is full
  at the peak.
- **`cover`** target is `max(storm, COVER_PLAIN * wind.envelope)` with
  `COVER_PLAIN = 0.35`, stepped with `COVER_TAU` (4 s). Every event greys the
  sky a little; only a storm blackens it. The slow tau is what makes the sky
  clear *after* the rain stops rather than with it.
- **`fog`** target is the lull's fog depth during a fogged lull, 0 during any
  event, faded on its own trapezoid: `min(1, phaseTime / FOG_FADE, (phaseDuration - phaseTime) / FOG_FADE)`
  with `FOG_FADE = 3` s, clamped to a quarter of the lull like the wind's own
  fade. Stepped with `FOG_TAU` (1 s) so a fog that is cut off by an early event
  still leaves over a second rather than in a frame.
- **`flash`**: only during a lightning-class event with `storm > FLASH_GATE`
  (0.6). Strikes are Poisson with mean interval `FLASH_MEAN` (6 s), drawn from
  the weather PRNG (this is a per-frame draw, so it must come **after** the
  per-phase draws in the stream and must only happen while a lightning-class
  event is live; the stream remains replayable because the gate is a pure
  function of replayed state). Each strike is a burst of two or three pulses
  `FLASH_PULSES` at `FLASH_GAP` (80 ms), each decaying as `exp(-t / FLASH_DECAY)`
  with `FLASH_DECAY = 0.12` s. `flash` is the max over live pulses, clamped to 1.

### Visibility

```
visibility = RADAR_RANGE * (1 - FOG_VIS_CUT * fog) * (1 - STORM_VIS_CUT * rain)
visibility = max(VIS_MIN, visibility)
```

`FOG_VIS_CUT = 0.67` (thick fog: a third of the scope, the owner's number),
`STORM_VIS_CUT = 0.4` (heavy rain: a bit over half), `VIS_MIN = 12` (about four
hull lengths; the ring a berth is found from must stay visible or a docking in
fog is a guess).

### `kind`

Derived last, in priority: `fog > 0.5 → 'fog'`, `storm > FLASH_GATE → 'storm'`,
`rain > 0.1 → 'rain'`, `cover > 0.4 → 'overcast'`, else `'clear'`. A label, not
state; nothing may branch on it except the HUD.

### `wind.ts`

Exposes the five fields. `phaseIndex` increments in the existing
`if (phaseTime >= phaseDuration)` block; `envelope` is the existing `ramp`
(0 in a lull). No new draws, no reordered draws. `tests/unit/wind.test.ts`
must pass unchanged, and a new case asserts `phaseIndex` steps exactly once per
transition and `envelope` is 0 through every lull.

### Debug

`?weather=clear|overcast|rain|storm|lightning|fog` pins the envelopes at their
full values and disables rolling, for `npm run shots` and for the owner's eye.
Under `?debug`, `window.__pirateWorld.weather` publishes the live state, the
way `hazards` is published today.

### Tests (Tier 1, Vitest)

Drive a stub `WindState` whose `phaseIndex`, `phase`, `phaseTime`,
`phaseDuration` and `envelope` are scripted; no terrain, no height map.

- Over 400 scripted events, storm-class share is within ±5 points of
  `STORM_SHARE` and lightning-class within ±3 of `LIGHTNING_SHARE`.
- Over 400 scripted lulls of 12 s, fog share within ±5 of `FOG_SHARE`; over
  400 lulls of 5 s, fog share is exactly 0.
- `storm` never exceeds `wind.envelope + 0.05` and never exceeds 0 during a
  lull; `fog` is 0 during every event.
- `flash` is 0 outside lightning-class events and never exceeds 1.
- `visibility` is `RADAR_RANGE` at all-zero and `>= VIS_MIN` always.
- Same seed, same scripted wind: identical state trace (replayability).

## Stream B: the sky, the light, the haze and the rain

Everything in this stream is render-side and reads `WeatherState` through
`globe.update`, which grows one argument: `globe.update(dt, env, wind, weather, ship, camera)`.

### `clouds.ts`

Two uniforms, both written in `update(dt, env, weather)`:

- `uCover` lowers the threshold: `thrBase = uThreshold - uCover * COVER_GAIN + uBand * sin(...)` with `COVER_GAIN = 0.16`. At `cover = 1` this pushes the measured 25.9% sky coverage to roughly the 80s; measure it once by the method the `uThreshold` comment describes and record the figure beside the constant.
- `uGloom` mixes `uDayColor` and `uShadowColor` toward `STORM_CLOUD` (`#3a4250`) by `uGloom * GLOOM_MIX` (0.8), written from `storm`. Written into the lit colour before the shadow step so the underside darkens first.
- `uFlash` lifts the underside toward white by `uFlash * FLASH_CLOUD` (0.6): a lit cloud base is most of what a flash looks like from a deck.

`SHELL_COUNT` is untouched. This stream does not tier the cloud deck.

### `sky.ts`

The dome gains `uGloom` and `uFlash`. `uGloom` pulls both day colours toward
`STORM_SKY` (`#59626e`) by `uGloom * 0.75` before the day/night mix, so a storm
at night stays night. `uFlash` adds `uFlash * FLASH_SKY` (0.35) of white to the
whole dome, after the dither. The atmosphere shell is left alone: it is an
orbital effect and a storm is a deck one.

### `daynight.ts`

`update(dt, env, weather)`. It remains the sole writer of `env`; the weather
touches the **lights**, not the environment:

```
sun.intensity  = key * (1 - STORM_KEY_DIM * weather.storm) + FLASH_KEY * weather.flash
hemi.intensity = hemiBase * (1 - STORM_HEMI_DIM * weather.storm) + FLASH_HEMI * weather.flash
```

`STORM_KEY_DIM = 0.7`, `STORM_HEMI_DIM = 0.35`, `FLASH_KEY = 2.5`,
`FLASH_HEMI = 0.8`. The flash is additive so it reads at night. `env.sunColor`
is not touched: the fog and the sky mix by it and a grey sun would double the
gloom.

### `fog.ts` and `fogglsl.ts`

`FOG_MAX_AMOUNT` becomes a uniform `uFogMax` owned by `fogUniforms`, default
0.15 (so today's value is the resting value). `updateFog(env, weather)`:

```
uFogDensity = FOG_DENSITY * (1 + FOG_DENSITY_GAIN * fog + STORM_DENSITY_GAIN * rain)
uFogMax     = mix(0.15, FOG_MAX_BANK, fog) lifted by rain * STORM_MAX_GAIN
uFogColorDay = today's colour, then lerped toward FOG_BANK_COLOUR by max(fog, 0.6 * storm)
```

`FOG_DENSITY_GAIN = 6`, `STORM_DENSITY_GAIN = 2`, `FOG_MAX_BANK = 0.85`,
`STORM_MAX_GAIN = 0.25`, `FOG_BANK_COLOUR = #aeb4b8`. The night endpoint lerps
toward `FOG_BANK_COLOUR * FOG_NIGHT_DARKEN` by the same weight so a night fog
is not a bright wall.

The altitude fade in `applyAerial` (`FOG_ALTITUDE_FALLOFF = 20`) is deliberately
kept: a fog bank is a ground effect and the orbital shot should see the sea
through it. That is why nothing here needs to reach the atmosphere shell.

**The regression to watch**: at `fog = rain = storm = 0` the three uniforms
hold exactly today's values. This stream's `npm run shots` must be compared
against `main`'s at the same stations before it is merged.

### `rain.ts`, new

A single `THREE.LineSegments` of `quality.rainDrops` drops in a ship-scale box
(`RAIN_BOX = 14` units across, `RAIN_HEIGHT = 10` tall) parented to a group
that follows the ship and is oriented by `ship.up`. The vertex shader owns the
motion: each drop has a seed attribute; its position is
`fract(seed + uTime * RAIN_FALL / RAIN_HEIGHT)` down the box's local up, offset
along the wind by `uWindDrift` (`wind.direction * RAIN_DRIFT`, `RAIN_DRIFT = 0.35`
of the fall speed), and the drop is a segment of `RAIN_LENGTH = 0.5` units
along its own velocity. Nothing is updated on the CPU per drop; `update` writes
`uTime`, `uRain`, `uWindDrift` and moves the group.

- `material.opacity` is `uRain * RAIN_ALPHA` (0.35), `transparent`,
  `depthWrite: false`, `blending: AdditiveBlending`, colour `#c8d4e0`. Drawn
  only when `rain > 0.02` (`visible` toggled, not opacity, so the draw call is
  absent in fair weather).
- `LAYER_DEFAULT` only. Rain must not appear in the reflection cube.
- Not tied to `SKY_FADE_*`: rain is a deck effect and simply thins with
  `uRain`; from orbit the box is smaller than a pixel.

### `quality.ts`

One new field, `rainDrops`: low **0**, medium **1500**, high **3000**. Zero
means `rain.ts` is not constructed at all (absent, not idle), the same
convention `reflectionSize = 0` uses. On the low tier a storm is dark sky,
dim light and haze; that is enough for the tier's purpose.

### `waterrain.ts`, a `WaterPlugin` (stretch, do last)

`normal` hook: a high-frequency `snoise` ripple (`RAIN_RIPPLE_WAVELENGTH = 0.6`
units, through `freq()`) scaled by `uRainAmount * RAIN_RIPPLE`, faded with
`camDist` past 40 units. `foam` hook: `foam += uRainAmount * RAIN_SPECKLE`
(0.08) where the ripple is positive. Constructed in `main.ts` alongside the
other plugins **before** `createGlobe`. If this stream runs out of budget, ship
without it; the sky sells the storm and the sea's own `uWaveIntensity` is
already up because the wind is.

## Stream C: gameplay hooks

Each module gains one optional argument with a zero default so every existing
unit test runs unchanged.

### `energy.ts`

`update(dt, ship, env, overdriveActive?, moonNightFraction?, weather?)`. On the
solar line, and only there:

```
charge = SOLAR_PEAK * max(0, sunElevation) * solarKeep(weather)
solarKeep = (1 - STORM_SOLAR_CUT * storm) * (1 - FOG_SOLAR_CUT * fog)
```

`STORM_SOLAR_CUT = 0.95`, `FOG_SOLAR_CUT = 0.5`. Moonlight (`moonNightFraction`)
is cut by the same factor: a Moonglass under a storm sees no moon. The dock
branch is untouched; a berth charges in any weather, which is the whole reason
to run for one.

**Why this cannot strand a player**: a storm is a subset of a wind event, and
`wind.ts` caps events at `EVENT_MAX = 30` s. Thirty seconds of no solar costs
at most 15% of `SOLAR_FULL_SECONDS`, and the lull that follows is guaranteed.
Fog halves solar for at most `LULL_MAX = 15` s. No new floor is needed; the
guarantee comes from the wind's own bounds and this document's promise that
`weather.ts` never holds a storm past its event.

### `hazards.ts` and `aiboats.ts`

`update(...)` gains `stormOdds = 1`, a multiplier applied on the comparison and
nowhere else:

```
if (draw < ROLL_ODDS[kind] * stormOdds) trySpawn(kind, ship, wind);
```

`main.ts` computes `stormOdds = 1 + STORM_ODDS_GAIN * weather.state.storm`,
`STORM_ODDS_GAIN = 2` (tripled at a full storm). The draw stays unconditional,
so the PRNG stream is what it was. A test drives 3000 s of rolls at
`stormOdds = 3` against `stormOdds = 1` and asserts the spawn count ratio is
within 2.5x to 3.5x, using the existing `hazards.test.ts` roll harness.

### The battle

`main.ts:412` becomes:

```
const battleOptions = battleParams.get('calm') === '1' ? CALM
  : weather.state.storm > BATTLE_STORM_GATE ? ROUGH : CALM;
```

`BATTLE_STORM_GATE = 0.5`, evaluated once at the moment the cover card opens,
so the arena does not change mid-count. The plan changes the shipping default
from `ROUGH` to weather-dependent; the `?calm=1` override keeps working and a
new `?rough=1` forces the other way for the unit cases that pin the gunner.

### `hud.ts`

One row, `WX`, printing `weather.kind` in upper case, in the wind row's style.
`hud.update` gains `weather` as its fourth argument.

## Stream D: the chart and the scope

### `chart.ts`

An equirectangular `Uint8Array` bitmap, one byte per texel (bytes, not bits,
in memory: the radar samples it 37 000 times per raster and a byte read is
cheaper than a shift), `CHART_WIDTH = 1024` by `CHART_HEIGHT = 512`. A texel is
1.2 world units at the equator against the scope's 0.52-unit pixel, so a
discovery edge is two scope pixels wide; that is the blur of a pencil line,
which is the look wanted.

`reveal(centre, radius)` stamps a spherical cap: for each latitude row within
`±radius / GLOBE_RADIUS` of the centre, the longitude half-width is
`acos((cos θ − sin φ0 sin φ) / (cos φ0 cos φ))`, clamped at the poles to the
full row. About 6 500 texel writes for a 50-unit radius; run from `radar.ts` at
its own `RASTER_HZ` (10 Hz) and skipped when the ship has moved less than half
a texel since the last stamp and visibility has not grown.

`discovered(dir)` is the `sample(dir)` shape `heightmap.ts` and
`waterbodies.ts` use, nearest-texel, so the three lookups agree on projection.

**Persistence** is a **separate key**, `pirate-world.chart`, not a field of
`SaveData`. `save.ts` writes the whole file on every store change (each catch,
each purchase, each whole percent of battery), and a 64 KB bit-packed chart
riding along with every one of those is the wrong cadence. The chart has its
own: `onChange` fires at most once per `CHART_SAVE_INTERVAL` (5 s) while dirty,
plus once on `pagehide`. The encoding is version byte, then the bitmap
bit-packed and base64'd (about 87 KB in storage). The loader is in `save.ts`'s
style: missing key, wrong version, wrong length or unparsable base64 all yield a
blank chart and one console note, never a throw. `save.ts` records the key
beside `SAVE_KEY` so the two files know of each other.

### `radar.ts`

`update(dt, ship, wind, hazards, boats?, weather?, chart?)`.

- **Visibility ring.** In `raster()`, a pixel with `r > visibility / RADAR_RANGE`
  paints `SCOPE_FOG` (a flat grey-green at 40% of the scope's sea colour) and
  skips the height-map read. The precomputed projection tables are untouched;
  the scope's geometry is fixed and the weather masks it, which is what a real
  scope in fog looks like. The range rings still draw over the mask so the
  player can read how much has been lost.
- **Uncharted.** A pixel inside visibility is drawn as today. A pixel outside
  visibility but discovered draws the coast in `SCOPE_CHART` (the sea colour
  dimmed to 60%, land to 70%): remembered, not seen. A pixel outside visibility
  and undiscovered paints `SCOPE_FOG`. Inside visibility everything is by
  definition discovered after the stamp, so there is no fourth case.
- **Towns and docks** cull on `cos(visibility / GLOBE_RADIUS)` instead of
  `COS_RADAR_RANGE` unless `chart.discovered(town.dir)`, in which case they
  draw at `ICON_FADE` alpha out to the scope edge as today. A remembered
  harbour is the point of a chart.
- **Hazards and raiders** cull on visibility only. They are live things, seen
  or not seen; the chart does not remember them.
- **The stamp.** After `raster()`, `chart.reveal(ship.position, visibility)`.
  The scope is the one place that both knows the visibility and already runs
  at the right cadence.

### Tests (Tier 1)

- `reveal` then `discovered` on the centre, on a point at 0.9 radius, and on a
  point at 1.1 radius; then at a pole and across the antimeridian.
- `encode` → `createChart(..., encoded)` round-trips bit for bit.
- Garbage in (`'x'`, `''`, wrong length, wrong version) yields a blank chart
  and does not throw.
- The `onChange` throttle: 100 reveals in 1 s fire once.

## Changes to existing modules, by file

| File | Change | Stream |
|---|---|---|
| `types.ts` | `WindState` +5 fields, `WeatherState`, `WeatherKind` | Step 0 |
| `wind.ts` | expose phase, phaseTime, phaseDuration, phaseIndex, envelope | A |
| `weather.ts` | new: the sim | A |
| `clouds.ts` | `uCover`, `uGloom`, `uFlash`; `update(dt, env, weather)` | B |
| `sky.ts` | `uGloom`, `uFlash` on the dome; `update(dt, env, weather)` | B |
| `daynight.ts` | dim and flash the key and hemisphere lights | B |
| `fog.ts`, `fogglsl.ts` | `uFogMax` uniform; density, cap and colour driven by fog and rain | B |
| `rain.ts` | new: the drops | B |
| `quality.ts` | `rainDrops` | B |
| `waterrain.ts` | new plugin, stretch | B |
| `globe.ts` | thread `weather` to clouds, sky, daynight, fog | B |
| `energy.ts` | `solarKeep` on the solar line | C |
| `hazards.ts`, `aiboats.ts` | `stormOdds` on the roll comparison | C |
| `hud.ts` | `WX` row | C |
| `chart.ts` | new: the bitmap and its encoding | D |
| `radar.ts` | visibility mask, uncharted mask, town cull, the stamp | D |
| `save.ts` | `CHART_KEY`, the tolerant chart loader and writer | D |
| `main.ts` | construct `weather`, `chart`, `rain`; wire the loop; battle gate; `?weather=` | integration |
| `docs/ARCHITECTURE.md` | module table rows, frame loop, units | integration |

**File ownership is exclusive.** No two streams write the same file. `globe.ts`
is B's; `main.ts` is the orchestrator's at integration.

## `main.ts`: the frame loop after integration

```
energy.update(dt, ship.state, env, overdriveActive, moonNightFraction, weather.state)
wind.update(dt, ship.state, energy.state)
weather.update(dt, wind.state)                       // after wind: this frame's phase. Before hazards: this frame's odds
hazards.update(dt, ship.state, energy.state, wind.state, stormOdds)
aiBoats.update(dt, ship.state, energy.state, hazards.state, suppressed(), stormOdds)
ship.update(...)                                     // unchanged
view.update(...)
aiHulls.update(...)
globe.update(dt, env, wind.state, weather.state, ship.state, view.camera)  // daynight, fog, water, patch, land, citylights, clouds, sky, celestial: all read this frame's weather
rain.update(dt, ship.state, wind.state, weather.state)   // after globe: it follows the hull the camera just framed
reflection.update(...)
docks.update(...)
wake.update(...)
hud.update(ship.state, energy.state, wind.state, weather.state)
radar.update(dt, ship.state, wind.state, hazards.state, aiBoats.state, weather.state, chart)
```

Under the frozen-overlay branch and the battle branch `weather.update` is
**not** called, exactly as `wind.update` is not: the weather freezes with the
world. `energy.update` in those branches passes `weather.state` too, so a card
opened in a storm keeps not charging.

## Constants

All authored at the top of their file with the reasoning beside each, in the
house style. This table is the approved starting point; the owner's visual
pass may move any render-side number.

| Constant | Value | Where |
|---|---|---|
| `STORM_SHARE` | 0.25 | weather.ts |
| `LIGHTNING_SHARE` | 0.10 (of all events; 40% of storms) | weather.ts |
| `FOG_SHARE` | 0.35 | weather.ts |
| `FOG_MIN_LULL` | 8 s | weather.ts |
| `FOG_FLOOR` | 0.5 | weather.ts |
| `FOG_FADE` | 3 s, clamped to a quarter of the lull | weather.ts |
| `STORM_TAU` / `COVER_TAU` / `FOG_TAU` | 1.5 / 4 / 1 s | weather.ts |
| `RAIN_ONSET` | 0.25 | weather.ts |
| `COVER_PLAIN` | 0.35 | weather.ts |
| `FLASH_GATE` / `FLASH_MEAN` / `FLASH_PULSES` / `FLASH_GAP` / `FLASH_DECAY` | 0.6 / 6 s / 2..3 / 0.08 s / 0.12 s | weather.ts |
| `FOG_VIS_CUT` / `STORM_VIS_CUT` / `VIS_MIN` | 0.67 / 0.4 / 12 u | weather.ts |
| `COVER_GAIN` / `GLOOM_MIX` / `FLASH_CLOUD` | 0.16 / 0.8 / 0.6 | clouds.ts |
| `STORM_CLOUD` / `STORM_SKY` / `FOG_BANK_COLOUR` | `#3a4250` / `#59626e` / `#aeb4b8` | clouds, sky, fog |
| `FLASH_SKY` | 0.35 | sky.ts |
| `STORM_KEY_DIM` / `STORM_HEMI_DIM` / `FLASH_KEY` / `FLASH_HEMI` | 0.7 / 0.35 / 2.5 / 0.8 | daynight.ts |
| `FOG_DENSITY_GAIN` / `STORM_DENSITY_GAIN` / `FOG_MAX_BANK` / `STORM_MAX_GAIN` | 6 / 2 / 0.85 / 0.25 | fog.ts |
| `RAIN_BOX` / `RAIN_HEIGHT` / `RAIN_FALL` / `RAIN_DRIFT` / `RAIN_LENGTH` / `RAIN_ALPHA` | 14 u / 10 u / 18 u/s / 0.35 / 0.5 u / 0.35 | rain.ts |
| `rainDrops` | 0 / 1500 / 3000 | quality.ts |
| `STORM_SOLAR_CUT` / `FOG_SOLAR_CUT` | 0.95 / 0.5 | energy.ts |
| `STORM_ODDS_GAIN` | 2 | main.ts |
| `BATTLE_STORM_GATE` | 0.5 | main.ts |
| `CHART_WIDTH` / `CHART_HEIGHT` | 1024 / 512 | chart.ts |
| `CHART_SAVE_INTERVAL` | 5 s | chart.ts |
| `CHART_KEY` | `'pirate-world.chart'` | save.ts |
| `SCOPE_FOG` / `SCOPE_CHART` | 40% / 60-70% of the scope's own colours | radar.ts |

Every one of these is either dimensionless, a time, or ship-scale (the rain
box, `VIS_MIN`, the chart texel). Nothing here is world-scale except the chart's
resolution, which is angular by construction.

## Performance

- The weather sim is a few dozen float operations per frame and two PRNG
  draws per wind phase. Free.
- Rain is one draw call of `2 * rainDrops` vertices with all motion in the
  vertex shader, present only while raining. On the high tier that is 6 000
  vertices, under the wake ribbon's budget.
- The cloud and sky changes are three uniform reads per fragment. The fog
  change is one uniform where a constant was; no new texture reads.
- The chart stamp is ~6 500 byte writes at 10 Hz and the raster gains one byte
  read per pixel. Well inside the "tens of microseconds" the radar's comment
  budgets.
- Storage: 87 KB under its own key, written at most every 5 s while exploring.

## Known artefacts, accepted

- **No bolt.** Lightning is a flash on the cloud base, the sky and the lights.
  A bolt mesh is the first thing to add if the flash reads as a camera glitch;
  it is not in this plan.
- **Rain is a box.** At the box's edge a drop pops in. `RAIN_BOX` is sized so
  the edge is behind the chase camera at its near framing; at far zoom the
  whole box is a few pixels.
- **Fog does not reach orbit.** By design (the altitude fade); from far zoom a
  fogged ship sits on clear sea under an ordinary cloud deck.
- **Fog banks are not visible before you are in them.** Weather is at the
  ship. The player sees a fog coming only as the sky greying and the scope
  shrinking. This is the cost of the "tied to wind" decision and is accepted.
- **The chart's equirect texel** is smaller near the poles, so discovery there
  is finer than at the equator. Harmless.
- **A storm-class event near a coast** is a storm at `COAST_CAP`: dark, wet,
  and not very windy. Consistent with the wind, if a little odd to sail in.

## Work split

**Step 0** (orchestrator, one commit): `types.ts` fields and interfaces, the
`weather.ts` and `chart.ts` stubs, a `weather` argument threaded as an
**optional, defaulted** parameter through `globe.update`, `energy.update`,
`hazards.update`, `aiBoats.update`, `hud.update` and `radar.update` so every
stream's signature already exists and `npm test` is green before anyone
starts. Nothing in Step 0 changes behaviour.

Then four agents in parallel, each in its own worktree branched from Step 0,
files partitioned as the table above:

| Agent | Owns | Deliverable |
|---|---|---|
| A: sim | `weather.ts`, `wind.ts`, `tests/unit/weather.test.ts`, the `wind.test.ts` additions | A replayable weather that rolls storms and fogs off the wind's phases, with the `?weather=` pin |
| B: sky | `clouds.ts`, `sky.ts`, `daynight.ts`, `fog.ts`, `fogglsl.ts`, `rain.ts`, `quality.ts`, `globe.ts`, `waterrain.ts` (stretch) | Storm, fog and lightning you can see, and shots at `?weather=storm`, `fog`, `lightning`, `clear` against `main`'s |
| C: gameplay | `energy.ts`, `hazards.ts`, `aiboats.ts`, `hud.ts`, their tests | Solar, odds, the `WX` row |
| D: chart | `chart.ts`, `radar.ts`, `save.ts`, `tests/unit/chart.test.ts` | A scope that fogs, remembers, and survives a reload |

**Integration** (orchestrator): merge A through D, wire `main.ts` (construction,
the loop, the battle gate, `?weather=`), thread `weather.state` where Step 0
left a default, update `docs/ARCHITECTURE.md` (module table rows for
`weather.ts`, `rain.ts`, `chart.ts`; the frame loop block; **Units, pinned**
for the envelopes and `visibility`; a **Weather** section), run `npm run
test:all` once, and take the owner's shot set. Then one version bump.

## Verification, and the budget

`docs/TESTING.md`'s rule applies: under five minutes of testing across the
whole job.

- Tier 1 (`npm test`, ~2 s): every stream runs it on every change. New
  cases: `weather.test.ts`, `chart.test.ts`, the roll-multiplier case in
  `hazards.test.ts`, the phase-field case in `wind.test.ts`, the solar case in
  `energy-navigation.test.ts`.
- Tier 2 (`npm run test:smoke`, ~50 s): once at integration. The shader
  changes in B are the only thing that can fail to compile, and B's own
  `npm run shots` compiles them earlier.
- Tier 3 (`npm run shots`, ~30 s): B runs it at `?weather=clear` first and
  diffs by eye against `main` before anything else; then at each pinned kind.
  D runs it once to see the scope masks. The orchestrator runs it once at
  the end.

## Out of scope

- Audio of any kind.
- Regional weather cells, fronts, or anything that shows on the scope before
  the ship is in it.
- Hard-culling raiders, beacons or city lights beyond visibility.
- Bolt geometry, rain in the battle arena, wet-deck or hull effects.
- Weather on the fishing card, or any change to the fishing sim.
- A "clear the chart" control. If it is wanted it is one line in the menu and
  can come later.

## Trade-offs accepted

| Choice | For | Against |
|---|---|---|
| Weather rides the wind's phases | No second clock, no drift, replayable for free, storms and gales always coincide | Fog cannot precede or outlast a lull; a squall near a coast is dark but nearly windless |
| Own PRNG in `weather.ts` | The wind's stream and every existing golden are untouched | Two seeds to keep straight; a "world seed" later has to derive both |
| Haze only, no culling | No pop-in, no new draw-order rules, cheapest | A raider's neon and a beacon can glow through thick fog at range; the scope mask is what hides them from the player's *information* |
| Scope masked, not re-ranged | Precomputed projection tables stay; the ring geometry stays readable | The scope still costs its full raster every 100 ms even when two thirds of it is grey |
| Chart under its own storage key | Save cadence and file size unchanged; blank-on-garbage without touching `SaveData` | Two keys to clear when resetting a player; the chart is not inside the versioned file |
| Bytes in memory, bits in storage | Radar sampling stays a plain array read | 512 KB resident, and an encode step on save |
| Harsh numbers | Weather is a threat worth sheltering from, which is what the owner asked for | A new player's first storm is a dark screen with no charge; the `WX` row and the wind row are the only explanation |
