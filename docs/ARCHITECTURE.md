# Pirate World — architecture

Vite + Three.js + TypeScript. No external art assets; everything is procedural.

## Testing, and the budget on it
`docs/TESTING.md` is the rule set: three tiers, what belongs in each, and a
hard budget of **under five minutes of testing for a routine feature build,
in total across the job, not per run**. The short version: `npm test` is two
seconds and should be run constantly; the browser tier is slow because it
software-renders, so run it at the boundaries of a piece of work rather than
gating every step on it; and `npm run shots` gets you a picture without a
build or a test runner. No test in this project asserts on how anything looks.

## Conventions (see `src/geo.ts`)
- `GLOBE_RADIUS = 200`. The water surface sits at exactly this radius. See
  **World scale** below before changing it — half the constants in the project
  are written relative to it and half are deliberately not.
- +Y is the north pole. lon 0 = +Z, lon +90 = +X. Use `latLonToDir` / `dirToLatLon`.
- Heading: radians, 0 = north, clockwise positive (east = PI/2). It is a
  **reading, never state** — see **Frames, and where they stop working**.
- `tangentFrame(up)` gives the local `north` and `east` tangents. It is
  degenerate at the poles and near-degenerate around them; do not store
  anything as an angle in it.
- Ship length is about 3.1 world units after `MODEL_SCALE`, so the ship is
  ~1/64 of the planet radius.

## Units, pinned
These have bitten us once. Do not reinterpret them in a consumer.
- `InputState.zoomDelta` is in **wheel notches** (1.0 ≈ one detent ≈ 100px of `deltaY`).
  Consume as-is. `controls.endFrame()` resets it.
- `dt` is **seconds**, already clamped to ≤ 0.1 by `main.ts`.
- `Terrain.heightAt` returns roughly **[-1, 1]**. Land is `> terrain.seaLevel` (0.08).
- `WorldEnv.elapsed` is **seconds** since start. `timeOfDay` is **[0, 1)**.
- `ShipState.speed` is **world units per second**, which `hud.ts` prints as
  knots. So is `RADAR_RANGE`, and so is the cloud deck's `DRIFT_SPEED`.
- `ShipState.speed` is the **engine only**. `ShipState.groundSpeed` is engine
  plus wind. They are different numbers and picking the wrong one is the
  easiest mistake in the codebase — see **Wind** below for which rule uses
  which.
- `WindState.speed` is **world units per second**; `WindState.bearing` is the
  direction the wind travels **toward**, in radians on the same 0 = north,
  clockwise-positive convention as `ShipState.heading`, so the two subtract
  directly. `along` / `across` are already in the ship's frame.
- `WindState.direction` is that bearing as a **world-space unit vector**, and
  it is the one the wind is actually kept as; `bearing` is derived from it.
  Prefer the vector for anything geometric. Same rule as `ShipState.forward`
  against `ShipState.heading`.
- `WeatherState.storm`, `.rain`, `.fog`, `.cover` and `.flash` are **dimensionless [0, 1] envelopes**, and **zero means the game as it shipped**: at all-zero the sky, the sea, the lights and the scope are what they were before any of it existed. That is a hard contract — see **Weather**.
- `WeatherState.visibility` is **world units**, in `[VIS_MIN, RADAR_RANGE]`, and is the one number the weather and the chart meet at: the scope masks itself beyond it and the chart is stamped with exactly the disc the scope could see. Clear weather is `RADAR_RANGE` exactly.
- `HullState.percent` is a **whole number in [1, 100]**, produced with `Math.floor` — the same downward rounding `battery.ts` uses on its own persisted percent, and for a stricter version of the same reason. Every band (`speedCap`, `canFish`, `hitsToLose`, `mode`) is derived from this PUBLISHED number and never from the float behind it, so the instrument and the behaviour cannot disagree: "under 50%" is true of exactly the readings that print 49 and below. Deriving from the float instead was tried, and it left a hull reading 50% while already capped at 10 knots.
- `HullState.speedCap` is **world units per second** — ship-scale, the family `MAX_FORWARD` belongs to — and is `Infinity` at 50% and above. That is what lets `ship.ts` write a plain `Math.min(propulsion.maxForward, speedCap)` and have a sound hull change nothing; a finite value up there would silently cap Trim and Overdrive.
- The world **seed** is a **uint32**, as `mulberry32` takes one. `WorldData.seed` carries it because `Terrain` does not report its own, and `citylights.ts` needs it.
- `WeatherCell.radius` is **ship-scale world units**; its `centre` and `north` are **unit vectors**, transported, never held as a bearing — the same rule as `WindState.direction` and for the same reason.
- `weathermap.ts`'s texture is **data, not colour**, in exactly the sense `wakemap.ts`'s is: R is storm, G is fog, B is a lightning flag, and its `colorSpace` is `NoColorSpace`.
- `Water.offsets` (and the `WaveOffsets` that `wavefield.ts` and `ship.ts`
  read) are in **direction space** — already divided by `GLOBE_RADIUS` —
  never world units. `water.ts` integrates them that way so its shader can add
  them straight to a unit direction; summing one with a world-unit quantity
  means one of the two was not converted.
- The wake map's texture (`wakemap.ts`) is **data, not colour**: R is foam
  density, G is a signed height packed as `0.5 + h * WAKE_HEIGHT_SCALE`, B is
  foam age, and the target's `colorSpace` is `THREE.NoColorSpace`. Never let
  it pick up an sRGB encode going in or a decode coming out.
- `reflection.ts`'s cube holds **sRGB-encoded** colour, because everything
  rendered into it — stock materials via `postfx.ts`'s self-encode patch, the
  beacons' and lights' own hand-written shaders — already encodes on the way
  out. `waterreflect.ts` decodes with `pow(c, 2.2)` before mixing it into the
  water's linear colour: the one sample in that shader that is not already
  linear.

## World scale
`GLOBE_RADIUS` in `geo.ts` is the one number that sets how big the world feels,
and every other constant in the project falls into one of two families with
respect to it:

- **World-scale.** Written as a fraction of the radius, or angular. Terrain
  noise is a function of the unit direction; settlements are placed in radians;
  the cloud deck, the atmosphere shell and the land relief are all fractions.
  These grow with the radius, so continents, lakes, towns and weather keep
  their shape and get bigger.
- **Ship-scale.** Absolute world units. The hull, its speed and lookahead, the
  chase camera's near framing, the wake, the wave chop alongside it, the
  radar's range. These stay put.

The world only ever feels big *relative to the ship*, so that split is the
whole mechanism: raise the radius and you get a flatter horizon, longer
crossings and larger landmasses against the same hull.

Two traps when changing it, both of which have bitten:

- **Shader constants are the easy thing to get wrong.** `water.ts` samples
  noise over the unit direction, so its frequencies are in 1/radian and its
  drifts in direction-units per second. Written literally they would double
  every wavelength along with the globe and leave the ship in swell twice its
  own length. They are authored in world units at the top of the file and
  converted, and new ones must be too.
- **A fixed fraction of a range is not a fixed framing.** `camera.ts`'s far end
  tracks the radius so the orbital shot survives; its opening `zoomTarget` is
  therefore chosen to reproduce a fixed *distance*, not a fixed fraction.

The wake, the sea's own displacement and the reflected sky add a dozen more
files, and every constant in them still sorts into one of the two families
above — with one addition: a few describe the pipeline rather than the world,
and the split does not apply to them at all.

- **World-scale, in the newer modules.** `waveconstants.ts`'s three
  wavelengths (`SWELL_WAVELENGTH`, `WAVE_WAVELENGTH`, `CHOP_WAVELENGTH`) are
  the numbers `water.ts` used to hold directly, converted through the same
  `freq()` → 1/radian pattern, now shared with `wavefield.ts`'s CPU port so
  the two can never numerically drift apart — the whole reason that module
  exists. `terrainbake.ts`'s `BAKE_RELIEF_SCALE` (`GLOBE_RADIUS * 0.05`,
  matching `land.ts`'s own `MAX_LAND_RELIEF`) and its two ray-march radii
  (`AO_RADIUS_RADIANS`, `HORIZON_RADIUS_RADIANS`) are angular, exactly like
  terrain noise. `reflection.ts`'s far plane (`GLOBE_RADIUS * 3`) tracks the
  atmosphere shell it has to contain. `land.ts`'s mottling/striation
  wavelengths go through that identical `freq()` conversion.
- **Ship-scale, in the newer modules.** Everything the wake and the
  displacement patch are built from: `wakeconstants.ts`'s whole shared
  geometry, `wakemap.ts`'s map extent, camera height, near/far, and its
  Kelvin-pattern and hump/churn constants, `waterpatch.ts`'s `PATCH_EXTENT`,
  `waveconstants.ts`'s `DISPLACE_AMPLITUDE`, `wavefield.ts`'s
  finite-difference step (mirroring `water.ts`'s own private `NORMAL_STEP`),
  `ship.ts`'s hull-sample half-length and half-beam, and `waterreflect.ts`'s
  neon-streak width and length. All absolute, all sized against the hull or a
  fixed patch of sea, none of them growing if `GLOBE_RADIUS` does.
- **Neither.** `quality.ts`'s whole table — a pixel-ratio cap, a bloom working
  width, three render-target/vertex counts, a face count — and `layers.ts`'s
  two layer indices are pipeline and wiring numbers: texel counts, a vertex
  count, a bit index passed to `Object3D.layers`. None of them is a distance
  or a frequency over the globe, so the two-family split above simply does
  not apply to them; do not go looking for which family a `QualitySettings`
  field belongs to.

## Ship dynamics
Top speed is **not** the `MAX_FORWARD` clamp. Thrust and drag balance at
`ACCEL / DRAG`, so that ratio is the real limit and the clamp only catches the
last fraction of a knot. They were set independently once and disagreed
silently — the ship topped out at 17.1 while the constant claimed 18 — so
`ACCEL` is now derived from `MAX_FORWARD * DRAG`. Keep it that way.

That derivation is also why **acceleration is retuned through `DRAG`, not
`ACCEL`**. Halving `ACCEL` halves the top speed with it, because the top speed
*is* the ratio; halving `DRAG` (0.7 → 0.35) carries the derived `ACCEL` down
and leaves the ratio alone, so the ship picks up half as hard and still makes
its top speed. The price cannot be avoided: the time constant is `1 / DRAG`, so it
went 1.4 s to 2.9 s in **both** directions and the hull now carries its way
twice as far. Against constant thrust and linear drag there is no third number
to spend.

Drag is integrated in **closed form**, not stepped:

```ts
const terminal = thrust / DRAG;
state.speed = terminal + (state.speed - terminal) * Math.exp(-DRAG * dt);
```

Stepping thrust and then drag lands on `(ACCEL / DRAG) * (1 - DRAG * dt)`,
which makes the top speed depend on the frame rate: at the 15 kn this was
measured under, 14.8 kn at 60fps and 14.0 at 10. The closed form is exactly `thrust / DRAG` at any rate, and still decays
cleanly to zero with no throttle, so the ship coasts as before.

**A dry tank is a crawl, not a stop.** `LIMP_SPEED` (1, exported from
`ship.ts`) is the steerage way left to a ship with no power, and it is spent
through the same ratio as everything else on this page: with `canThrust` false
the throttle pushes `LIMP_SPEED * DRAG` instead of `ACCEL`, which terminates at
one knot ahead or astern. Because it is a thrust and not a floor under `speed`,
a ship that loses power at full ahead decays *down* to the crawl on exactly the
curve it used to decay to zero on, and one starting from rest works *up* to it
over the same 2.9 s time constant — nothing snaps, and the closed form above is
untouched. It goes under the same `Math.min` as the hull cap and the tow share,
so it is a ceiling and never buys back a cap already below it: a critical hull
under tow still crawls at 0.75 kn, not 1.

Two things it deliberately does not do. It only exists while a throttle key is
held, so releasing the key still coasts the hull to the exact dead stop the
panels need (see **Energy** below) — a dead ship left alone charges exactly as
it always did, and the cost of crawling is that you are not charging while you
do it. And it is engine speed, so the wind and a hazard's pull are added on top
of it afterwards like any other: one knot is what the plant gives, not what the
ship makes good over the ground.

The hull is drawn at `MODEL_SCALE` (0.65), exported from `ship.ts` because the
wake is authored against the hull's own dimensions and has to shrink with it —
`STERN_BACK`, `BOW_FORWARD` and `HALF_WIDTH_0` in `wakeconstants.ts` all carry
the factor. `MODEL_WATERLINE_Y` is a model-space number, so `MODEL_MOUNT_Y`
scales it before subtracting; skip that and the ship floats at the wrong depth.
Scale is deliberately kept out of the motion constants: `BOB_AMPLITUDE`, the
sway and the bank are absolute, so a smaller hull moves the same distance in
the swell and therefore looks livelier in it.

`BOB_AMPLITUDE` is no longer what heaves the hull. It is a residual, run at
30% of this amplitude, kept only so a dead calm — where `sampleWave`'s real
signal is nearly flat — still breathes instead of freezing the hull dead
still. The heave, pitch and roll a player actually sees under way are read
off `wavefield.ts`'s `sampleWave` at the hull's centre and at bow/stern/
port/starboard points scaled by `MODEL_SCALE`, low-pass filtered at
`HULL_RESPONSE` so the hull settles onto a new reading rather than snapping
to it — see **The wave field**.

## The wave field
`wavefield.ts` is a hand port of the GLSL `waveField` in `waterglsl.ts` — the
swell and wave layers only, never chop, which stays fragment-side. `ship.ts`
samples it (through `sampleWave`) to heave, pitch and roll the hull;
`waterpatch.ts` pastes the identical GLSL chunk, rather than reimplementing
it, to displace the visible sea near the ship. These have to read as one
surface, because the whole point of the split is that the hull rides the sea
the player actually sees.

Every arithmetic step of the CPU port is rounded to float32 with
`Math.fround`, deliberately, to match the shader's own `highp float`
precision instead of running the smoother float64 arithmetic JS would
otherwise use. This is not paranoia: `snoise`'s corner-rejection test
(`h <= 0`) is a difference of near-cancelling terms that legitimately lands
within double-precision epsilon of zero on a meaningful fraction of real
inputs, and float64 and float32 arithmetic then round that near-zero tie to
opposite signs — which flips which lattice corner's gradient contributes at
all and swings the return value by a unit or more. Rounding every
intermediate to float32, the same way the GPU already does, puts both sides
on the same side of every such tie by construction.

`tests/smoke/wave-parity.spec.ts` is what enforces this. It loads
`?probe=wave` (`dev/probe.ts`), which renders the same GLSL chunk to a
128×128 canvas and publishes the matching CPU grid on
`window.__pirateWorld.probe`, and asserts every pixel agrees to within 3/255
— measured, today, to within 1/255. **Changing one side of the port without
the other is a silent desync**: nothing fails to compile and nothing throws,
the hull just quietly stops riding the sea it looks like it is riding.

`waterpatch.ts` raises the sea's actual geometry near the ship by up to
`DISPLACE_AMPLITUDE` (0.3 world units) at a full gale, scaled by
`uWaveIntensity` and faded to zero over the patch's outer skirt so it meets
the undisplaced sphere without a seam. **Anything that used to sit at a fixed
height above a flat sea has to clear that crest instead**, or heavy weather
swallows it: the wake ribbon's lift went from 0.1 to 0.4, the bow spray's
spawn lift from 0.12 to 0.42, and the berth ring's lift from 0.12 to 0.42 —
each is `DISPLACE_AMPLITUDE` plus whatever the old flat-sea lift was already
clearing. A new object authored at the old flat-sea height will clear the
water in a calm-weather screenshot and vanish inside crests the first time
someone tests it in a gale.

A `WaterPlugin` (see **Shader notes**) can only be woven into the water
shader while it is being assembled — `createWater`'s fragment shader is built
once, from its `plugins` argument, at construction, and never touched again.
`main.ts` therefore builds `wake` and `reflection`, and the plugins that read
them (`waterwake.ts`, `waterreflect.ts`), *before* calling `createGlobe`,
which is the only place `createWater` runs; registering a plugin afterwards
would mean recompiling a shader that already exists. `waterpatch.ts`'s
displacement patch is built the other way around from that same rule: inside
`createGlobe`, *after* the plugins are woven in, because it clones the
sphere's already-finished `fragmentShader` byte for byte — build it first and
the clone is missing every plugin's hooks.

## The world environment
`src/env.ts` defines `WorldEnv`: `sunDirection`, `sunColor`, `elapsed`, `timeOfDay`, `dayFactor`.

`daynight.ts` is the **sole writer**. Every other world module takes it as a
read-only input. Mutate the Vector3/Color fields in place; never reassign them,
because consumers hold references. `globe.update` calls `dayNight.update` first,
so within one frame every shader agrees on the sun.

## The shared height map
`src/heightmap.ts` rasterises `terrain.heightAt` once at startup into an
equirectangular R16F texture (2048×1024), plus a `Float32Array` and a matching
CPU `sample(dir)`.

Read terrain in a shader from this texture, not from mesh vertices. It is far
higher resolution than the geometry and costs one texture fetch. `HEIGHTMAP_GLSL`
exports `dirToEquirect(vec3)` and `terrainHeight(sampler2D, vec3)`; declare your
own `uniform sampler2D uHeightMap` and paste the snippet into your fragment
shader.

## Module ownership

| File | Exports | Notes |
|---|---|---|
| `geo.ts` | `GLOBE_RADIUS`, `latLonToDir`, `dirToLatLon`, `tangentFrame`, `headingToForward`, `normalizeHeadingDeg` | conventions |
| `types.ts` | `InputState`, `Terrain`, `ShipState`, `Town`, `Dock`, `Towns`, `EnergyState`, `EnergyMode`, `WindState`, `HullState`, `HullMode`, `UpgradeLine` | interfaces only |
| `quality.ts` | `QualityTier`, `QualitySettings`, `Quality`, `createQuality(search?)`, `QUALITY_STORAGE_KEY` | resolved once at startup (`?quality=` beats `localStorage` beats `'high'`); frozen, read-only table everything built after it treats as fixed; `reflectionSize`/`reflectionFacesPerFrame` of 0 means the reflection pass is absent, not idle, and `rainDrops` of 0 means the same for `rain.ts` |
| `layers.ts` | `LAYER_DEFAULT`, `LAYER_REFLECTED` | the two `Object3D.layers` bit indices every rendering stream shares; wiring constants, not world- or ship-scale |
| `env.ts` | `WorldEnv`, `createEnv()` | shared frame state |
| `heightmap.ts` | `HeightMap`, `createHeightMap(terrain, w?, h?)`, `HEIGHTMAP_GLSL` | built once; `aux`/`horizon` start `null` and are filled in later by `land.ts`'s startup bake (`terrainbake.ts`) |
| `terrain.ts` | `createTerrain(seed?)`, `SEA_LEVEL`, `DEFAULT_SEED`, `SPAWN_LAT_DEG`, `SPAWN_LON_DEG`, `BAND_GUARANTEE_RAD`, `BAND_WANDER_RAD`, `HEIGHT_GAIN`, `HEIGHT_BIAS` | seeded fBm; owns where the player starts, the land/water ratio and the equatorial strip's veto; `useLandMask` re-points collision at the culled raster. The two `HEIGHT_*` are exported for `tests/fixtures/measure.ts` alone |
| `islets.ts` | `cullIslets(heightMap, seaLevel)`, `MIN_ISLAND_AREA`, `IsletCull` | sinks landmasses too small to see, and the equatorial strip's too big; runs once, before anything reads the map. The only pass that knows which texels belong to the same landmass, which is why `bandBridges` is computed here and carried on `WorldData` rather than recomputed |
| `waterbodies.ts` | `WaterBodies`, `createWaterBodies(heightMap, seaLevel, spawnDir)` | built once; ocean vs. inland mask, texture + CPU `sample` |
| `land.ts` | `createLand(terrain, heightMap, quality)`, `landRadius`, `MAX_LAND_RELIEF`, `COAST_LIFT` | land-only mesh, sub-sea vertices sink under the water; `MeshStandardMaterial` extended with a chained `onBeforeCompile` (see **Post-processing**) that modulates the vertex-coloured base with per-pixel slope, curvature, wetness, a detail-normal octave, noise, per-mask roughness, baked AO and a sun-tracking horizon shadow from `terrainbake.ts`. Every noise term is distance-faded (`landLod`), and the detail normal's two taps are branched away entirely past its fade, so the orbit framing costs what it did before any of it existed |
| `terrainbake.ts` | `bakeTerrain(heightMap, seaLevel)`, `bakeAmbientOcclusion`, `bakeHorizon`, `TerrainBake`, `BAKE_WIDTH`, `BAKE_HEIGHT` | startup-only ambient-occlusion and 8-azimuth horizon bake over a half-resolution copy of the shared height map; called from inside `createLand`, after `globe.ts`'s islet cull, so it never occludes for an island that is about to be sunk |
| `noiseglsl.ts` | `NOISE_GLSL` | inlined Ashima/Gustavson simplex noise; `water.ts` and `land.ts` share this one copy |
| `waveconstants.ts` | `SWELL_WAVELENGTH`, `WAVE_WAVELENGTH`, `CHOP_WAVELENGTH`, `AXIS_WAVE`, `AXIS_CHOP`, `DISPLACE_AMPLITUDE`, `freq`, `freqNumber`, `vec3Literal` | the one source both `waterglsl.ts` (GPU) and `wavefield.ts` (CPU) read, so the two wave fields can never numerically drift apart — see **The wave field** |
| `waterglsl.ts` | `WATER_UNIFORMS`, `waterWavefield`, `waterDepth`, `WATER_LIGHTING_HEAD`/`_TAIL`, `waterFoam`, `WATER_FOAM_TAIL`, `WATER_OUTPUT` | the water fragment shader, as named chunks `water.ts` assembles; see **Shader notes** for the plugin hook seams between them |
| `fogglsl.ts` | `FOG_GLSL` (`applyAerial` contract) | aerial-perspective blend toward the atmosphere colour, thickened at grazing angles and weakened with camera altitude, capped at `FOG_MAX_AMOUNT`; called from water and land. The BANK's share of it ramps in over `FOG_BANK_ONSET` (70 units) so the near field belongs to `fogbank.ts`'s geometry and this term keeps the far — see **The fog bank** |
| `fog.ts` | `fogUniforms`, `updateFog(env, weather?)` | owns the seven uniforms `applyAerial` reads; called from `globe.update` before water and land. `uFogMax` is a uniform whose resting value is the constant `FOG_MAX_AMOUNT` used to be; `uFogBankColor` and `uFogStormColor` are the two endpoints weather fades the distance toward, and they pull opposite ways — a bank whitens, a downpour darkens. Deliberately does NOT rewrite the day/night colours. That restraint was originally about the arena freezing them for the length of a fight; `globe.update` runs during a fight now, so the freezing argument is gone, but the constant-uniform arrangement is kept because the greying belongs per fragment inside `applyAerial` rather than baked into a shared colour |
| `weathermap.ts` | `createWeatherMap()`, `bakeWeatherMap(cells, data, w, h)`, `WEATHERMAP_GLSL`, `weatherMapUniforms`, `MAP_WIDTH/HEIGHT/HZ` | the live cells baked into a 512×256 RGBA8 equirect texture at 4 Hz: R storm, G fog, B a lightning flag, `NoColorSpace`. Data, not colour, in `wakemap.ts`'s sense. `WEATHERMAP_GLSL` declares `uWeatherMap` itself and is pasted after `HEIGHTMAP_GLSL`, whose `dirToEquirect` it reuses. Read by the water, the land and the cloud deck; read by nothing that decides a number — see **Weather** |
| `fogbank.ts` | `createFogBank(slices)`, `fogInRange(ship, weather?, cells?)`, `sliceOpacity(n)` | the fog you sail INTO: a stack of concentric spherical caps at sea level, following the ship, carrying a four-octave simplex field. `update(dt, env, ship, weather?, cells?)`. Built by `globe.ts` and gated on `quality.fogSlices`, which is 0 on the low tier where the module is ABSENT rather than idle. See **The fog bank** |
| `simplexglsl.ts` | `SIMPLEX_GLSL` | Ashima's 3D simplex noise, once. Lived inside `clouds.ts` until `fogbank.ts` needed the same field at sea level; declares no uniforms, and defines `mod289`/`permute`/`taylorInvSqrt`, so a shader must not paste it twice |
| `water.ts` | `createWater(terrain, heightMap, waterBodies, plugins?: WaterPlugin[])`, `WaterPlugin`, `WaterHook` | full sphere at `GLOBE_RADIUS`; `update(dt, env, wind, ship, camera)` — the only module that reads the weather; exposes `offsets`, the three wave layers' integrated drift (direction-space, read-only), for `wavefield.ts`'s CPU port; see **Shader notes** for the plugin contract |
| `wavefield.ts` | `snoise`, `sampleWave`, `waveHeight`, `waveNormalBasis`, `WaveOffsets`, `WaveSample` | float32-rounded CPU port of `waterglsl.ts`'s swell+wave `waveField`; `ship.ts` rides this, the player sees the GPU copy — see **The wave field** |
| `hazardfield.ts` | `HAZARD_GLSL`, `HAZARD_PROFILE_GLSL`, `HAZ_CREST_RATIO_GLSL`, `hazardHeight(dir, hazards)`, `MAX_HAZARDS`, the crest/funnel sizes | the SECOND height field, beside `waveField` and never inside it: GLSL for three consumers and a float32 CPU port for the hull. Polynomial plus one `sqrt`, which is what makes its parity free — see **Hazards** |
| `waterpatch.ts` | `createWaterPatch(water, quality)`, `WaterPatch` | ship-following grid that actually displaces in the vertex shader, reusing the sphere's already-assembled fragment shader byte for byte; built after the water plugins are woven in |
| `grid.ts` | `createGrid()` | lat/long lines |
| `sky.ts` | `createSky()`, `skyHorizonColor(env, out)`, `ATMOSPHERE_COLOR` | `update(dt, env, weather?)`. The DOME carries the storm (`uGloom` greys the day pair before the day/night mix, so a stormy midnight is still midnight) and the flash; the SHELL carries neither, because a limb is an orbital effect and a storm is a deck one and the two already cross-fade. The dome reads the AT-SHIP envelope and never the weather map: it is what shows between the clouds, and under a distant cell the clouds carry the weather while the gaps stay the day's own colour. graded sky dome + atmosphere shell + starfield. The dome and the shell are a CROSS-FADE, not two effects: the dome fades out over `SKY_FADE_LO`..`SKY_FADE_HI` of camera altitude and the shell fades in over the same two, because a limb is something you see from outside an atmosphere and additively over a lit sky it bleaches the horizon. `skyHorizonColor` is what `fog.ts` fades the sea toward |
| `daynight.ts` | `createDayNight()`, `DAY_LENGTH`, `MOON_MONTH_DAYS`, `START_ELAPSED` | lights, writes `WorldEnv`; places BOTH bodies from elapsed time. `update(dt, env, weather?)`: a storm dims the key light by 0.7 and the hemisphere bounce by only 0.35 — that split is the look, since killing both equally is just night — and a flash is ADDED to each so it reads after dark. It stays the sole writer of `WorldEnv`; the weather reaches the lights and never `env`, because the fog, the sky and the water all mix by `sunColor` and `dayFactor` and a grey sun would double the gloom in every one of them |
| `celestial.ts` | `createCelestial()` | the sun disc, the moon, the moon's halo and its rim aurora as things you can see; draws only what `daynight.ts` already decided and writes nothing |
| `clouds.ts` | `createClouds()` | cloud deck, `SHELL_COUNT` stacked slices. `update(dt, env, weather?)`: `uCover`/`uGloom` are the at-ship envelopes and `weatherAt(uWeatherMap, nWorld)` is the map, maxed together per pixel, so a cell forty units away fills in and blackens its own patch of sky. `COVER_GAIN` lowers `uThreshold`, and it is applied to `thrBase` — i.e. BEFORE the two-octave early-out — so a storm genuinely makes cloud rather than merely darkening what was there. `uFlashLocal` decides whether a strike lights the whole deck (a squall, which has no place) or only the cell that threw it (`wx.b`) |
| `towns.ts` | `createTowns(heightMap, waterBodies, seaLevel, seed?)`, `BERTH_MAX_ARC`, `POLE_OFFSET_RAD` | settlement placement; a town without a berth is never founded, so every `Town.dock` is non-null; built once. Exactly `HARBOUR_COUNT` (36) of them or the world is REJECTED — the count is no longer a target. The two polar harbours are placed first and outside the random stream, so the other 34 draw the same numbers whether or not a pole was founded. The berth sits at the town's own shoreline, within `BERTH_MAX_ARC`, and the `berthXyz` overlap test is the sole authority for zones not touching — the arc between centres no longer implies it. See **Harbours** |
| `citylights.ts` | `createCityLights(terrain, heightMap, towns, seed?)` | night-side settlements, lit from the shared list. The lone-outpost scatter is GONE: every cluster of lights on the globe is one of the 36 harbours, which is what makes a light on the night side something you can always tie up at. Per-town lamp counts went up by half to fill the space the 440 outposts left |
| `docks.ts` | `createDocks(towns, known?)`, `UNCHARTED_HEIGHT`, `UNCHARTED_LAMP`, `LABEL_FADE_NEAR/FAR` | charging zones on the water + daylight beacons + one name sprite per harbour. `update(dt, env, ship, energy, camera?)` — the camera is what the labels fade against, and WITHOUT it none is ever drawn, because they ship `visible = false`. The sprites set `sizeAttenuation: false` so `LABEL_SCREEN_HEIGHT` is a fraction of the viewport; leave it at its `true` default and all 36 render correctly at a sixth of a millimetre, which is exactly what happened once A berth not in `known` draws its beacon at a quarter height and a tenth lamp, and rises over 1.2 s when first moored at; `markers()` hands the beacons to `harbourpick.ts` |
| `shipbeam.ts` | `createShipBeam()`, `beamFade`, `beamBlink` | the magenta pillar on the hull, faded in on `FollowCamera.zoom` from 0.45 to 0.85 and breathing on 2.6 s. One camera-facing quad with a 7 px half-width floor, drawn after the cloud deck and hidden in a fight |
| `courseline.ts` | `createCourseLine()`, `sampleArc` | the dim dotted great-circle line from the hull to the course's berth, at every zoom. A ribbon held in screen pixels; dots are measured from the berth so they stay put on the sea |
| `harbourpick.ts` | `pickHarbour`, `behindGlobe`, `createDoubleTap` | which beacon a double-click meant: each beacon projected as a foot-to-label segment, nearest within 28 px, never through the planet. Presses are paired by time and distance so mouse and touch share one gesture |
| `energy.ts` | `createEnergy(towns, battery)`, `DEFEAT_KEEP`, `STALEMATE_COST` | `update`'s optional sixth argument is the weather: a full storm leaves 5% of the panels and a full fog bank half, moonlight cut by the same factor, and a berth untouched — which is what makes a berth worth running for. burn / solar / dock charge, and the bought cell behind them; owns `EnergyState` and the eleven-rung `EnergyMode` ladder that names what the plant is doing (`overcast` is the weather's own rung); `toggleMooring()` is the one door into `docked` and refuses unless `berthReady` says the hull is inside a ring; `spend(level)` is the overlays' withdrawal, `wreck()` the shipwreck's — the main tank keeps `WRECK_KEEP` (25%), the reserve, `rate` and `mode` untouched. `defeat()` / `stalemate()` are the lost and drawn battle's, the only two that reach the backup cell without a purchase; see **AI boats and the battle** |
| `wind.ts` | `createWind(terrain, heightMap, seed?)`, `COAST_CAP`, `OCEAN_CAP`, `OPEN_SEA_DISTANCE`, `LULL_SPEED`, `CELL_WIND_LIFT` | lull/event weather, floored at `LULL_SPEED` so it never stops and there is no calm state anywhere downstream; owns `WindState`; probes the shared height map for the coast. Also publishes the phase reading `weather.ts` rolls on — `phase`, `phaseTime`, `phaseDuration`, `phaseIndex`, `envelope` — all of which were already locals. `update`'s optional fourth argument is `CellsState.stormAtShip`, a FLOOR on the speed (never the bearing) so a storm always blows: the one coupling from the weather back into the wind, and the reason `weatherCells.update` runs first in the loop |
| `weathercells.ts` | `createWeatherCells(terrain, heightMap, seed?)`, `cellProfile`, `CELL_CORE` | the drifting weather: a population of `CELL_TARGET` storm and fog cells in a bubble around the ship, each a centre and a travel tangent carried by parallel transport exactly as a hazard's is. Owns `CellsState`, mutated in place; DOM-free, scene-free and seeded, like `wind.ts` and `hazards.ts`. Publishes the winning cell itself as `stormCellAtShip`, not just its numbers, so `weather.ts` can hang a bolt on a centre this sample already agreed on rather than re-deriving one and breaking the tie the other way. Its own PRNG, never the wind's — see **Weather** |
| `weather.ts` | `createWeather(seed?, pin?)`, `WeatherPin`, `VIS_MIN`, the share constants | the weather AT THE SHIP: squalls rolled off `WindState`'s phases, combined with the cells by `max` BEFORE smoothing. Owns `WeatherState`, including the three the flash carries — `flashLocal`, `flashSeed` and `flashOrigin`, all fixed at the INSTANT of the strike and cleared when it retires, so a cell that drifts or dies mid-flash cannot displace, reshape or unplace a bolt that is already lit. `?weather=` pins the envelopes and switches the squall roll off; cells keep running under a pin |
| `rain.ts` | `createRain(drops)` | `quality.rainDrops` drops in a box stretched to the CAMERA every frame, all motion in the vertex shader, hidden below `rain > 0.02` or once the far fade has run out. `update`'s optional fifth argument is the camera, and it is not a courtesy: width comes off the frustum (so the curtain reaches the frame at every zoom and on every window shape), depth off the camera's own distance (so it reaches the lens), and the ceiling off its altitude (so the plane the drops start at never crosses the frame). The drops dissolve toward three of the four walls (`RAIN_FADE`); the fourth is astern, behind the lens. `LAYER_DEFAULT` only: rain in the reflection cube is rain reflected in rain, directly under the hull |
| `lightning.ts` | `createLightning()`, `buildBolt(positions, seed)` | the BOLT, for the flash `weather.ts` has always had. Owns no timing, no gate and no randomness of its own: `weather.flash` is the envelope, `flashSeed` the shape, `flashOrigin` the place. Geometry is rewritten once per STRIKE rather than per frame, and the object hides itself between them; built on every tier including the one with no rain, because a bolt is under two hundred vertices for a third of a second. `LAYER_DEFAULT` only, for `rain.ts`'s reason |
| `chart.ts` | `createChart(w?, h?, encoded?)`, `CHART_WIDTH/HEIGHT`, `CHART_SAVE_INTERVAL`, `CHART_VERSION` | the fog-of-war bitmap: 1024×512 bytes in memory (the scope samples it 37 000 times a raster and a byte read beats a shift), bit-packed and base64'd in storage. `reveal` stamps a spherical cap through `geo.ts`'s `capColumns`, the same function `weathermap.ts` stamps a cell with. `coverage()` is the fraction of the globe's AREA discovered, kept as a running total and cosine-weighted by row — equirectangular texels are not equal areas, and counted naively a player could finish a chart contract by circling the pole |
| `hazards.ts` | `createHazards(deps)`, `HazardsDeps`, `Hazards` | the rough-water sim: the roll, spawning, transport, contact and push, capture and the spiral, `pickRespawn`. Owns `HazardState`, mutated in place; DOM-free and scene-free, like `wind.ts` — see **Hazards**. `update`'s optional fifth argument is `stormOdds`, a multiplier on the roll's COMPARISON only (the draw stays unconditional, so the stream still replays) |
| `aiboats.ts` | `createAiBoats(deps)`, `AiBoatsDeps`, `AiBoats`, `ROLL_PERIOD`, the spawn and pursuit constants | the raider sim: the roll, spawning, transport, pursuit, conversion, contact and the post-fight grace. Owns `AiBoatState`, mutated in place; DOM-free, scene-free and seeded, exactly as `hazards.ts` is; see **AI boats and the battle** |
| `aihulls.ts` | `createAiHulls(scene, cloneHull)`, `AiHulls` | the raiders as things you can see: at most two hull clones from `ship.cloneHull()`, placed on the globe from `AiBoatState` each frame, neon recoloured, `rimglow.ts` installed. `hullOf(boat)` is what the arena borrows |
| `salvage.ts` | `createSalvage(deps)`, `SalvageDeps`, `Salvage`, `oddsFor(weather)`, `ROLL_PERIOD`, the odds and the band constants | the salvage sim: a ten-second roll whose odds SUM the weather (0.5% clear, +3% per band of rain/storm/fog, 9.5% ceiling), up to three rafts adrift at once, each drifting downwind at a fifth of the wind, 120 s of life, taken by touching it inside `TAKE_RADIUS`. Owns `SalvageState`, mutated in place; DOM-free, scene-free and seeded, exactly as `aiboats.ts` is — whose ten-second cadence it borrows on purpose, because a raft is an ENCOUNTER and not weather. See **Salvage and the tow** |
| `salvagebounty.ts` | `rollSalvage(rng, hasRoom?)`, `SalvageHaul`, `SalvageItem`, `GOLD_MIN`/`GOLD_MAX`/`GOLD_STEP`, `ITEM_CHANCE`, `CELL_SHARE`, `ITEM_PRICE`, `ITEM_LABEL`, `towGold(voyage)`, `TOW_GOLD_MIN`/`TOW_GOLD_MAX`, `TOW_REPUTATION` | what a raft is carrying and what a tow pays, as pure functions over an injected `rng` — `bounty.ts`'s shape, and the same rule: **exactly three draws per haul whatever it turns out to be**, so a seeded world replays. Gold is uniform over ten round hundreds (EV 550); one raft in twenty also carries a consumable, half of those a backup cell; an item with no room left in its locker is paid as its own `shop.ts` price in gold instead of being dropped |
| `salvagerafts.ts` | `createSalvageRafts(scene, postFx?)`, `SalvageRafts` | the salvage as something you can see: a fixed pool of `LIVE_MAX` rafts from `raftmesh.ts`, placed on the globe from `SalvageState` each frame. The fade is spent on the SCALE rather than on a light, because a raft has none; no `rimglow.ts`, deliberately — the scope is what finds one |
| `raftmesh.ts` | `buildRaft(name, yaw, radius?)`, `RAFT_PIECES`, `RAFT_NOMINAL_R`, `RAFT_COLOR` | one pile of lost timber, drawn the same way in both seas. Lifted unchanged out of `battlescene.ts` so the arena's flotsam and the ocean's salvage are one object rather than two tables that would drift apart on the first retune. Geometry and material are shared across every raft in the game |
| `derelict.ts` | `createDerelicts(deps)`, `DerelictDeps`, `Derelicts`, `oddsFor(weather)`, `TOW_SPEED_SHARE`, `HOOK_RADIUS`, `TOW_DISTANCE`, the odds and band constants | the dead hull adrift and the tow: the same ten-second clock and weather sum as the salvage at a tenth of the odds (0.2% clear, 3% ceiling), **one at a time ever**, bound for a harbour drawn 120-350 units off, hooked by `Space` inside `HOOK_RADIUS` and then held rigidly `TOW_DISTANCE` astern. Owns `DerelictState`; publishes `hookReady` the way `energy.ts` publishes `berthReady`. It does not pay, does not slow the ship and does not decide when a tow is lost — `main.ts`, `ship.ts` and `energy.ts` do, off `towed` |
| `derelicthull.ts` | `createDerelictHull(scene, cloneHull, postFx?)`, `DerelictHull` | the dead hull as something you can see, and the ring you hook it from: one clone from `ship.cloneHull()` with its neon zeroed, its planking darkened to a third and `rimglow.ts` installed at a tenth of a raider's strength — without which an unlit hull on dark water is unfindable. `aihulls.ts`'s opposite number in every visible respect |
| `leviathan.ts` | `createLeviathan(deps)`, `LeviathanDeps`, `Leviathan`, `HuntLocker`, `damageAt`, `huntGoldFor`, the roll, shoal, gate and purse constants | the hunt sim: the roll, the shoal's drift and heading reroll, the body riding the head's recorded path, the coast steering, the mark, the range-and-arc gate, the dial, the damage, the scatter and the purse figure. Owns `HuntState`, mutated in place; DOM-free, scene-free and seeded, cut from `aiboats.ts`; see **The leviathan hunt** |
| `leviathanshadows.ts` | `createShadowField(scene, postFx?, path?)`, `ShadowField` | the body as things you can see, on the `low` tier: a pool of `SHOAL_COUNT` tapered teardrop planes with two procedurally drawn textures, placed on the globe from `HuntState` each frame. Stands down entirely when `path` is `'shader'`. No asset file, no mesh |
| `huntsweep.ts` | `createSweep`, `arm`, `step`, `position`, `canPress`, `rateFor`, `multiplierFor`, `damageAt`, `bandFor`, `huntGoldFor`, `Sweep`, the dial and escalation constants | the needle and the money: the sweep that starts at the RED EDGE, the arm-up, the rate tied to how centred the mark is, `LEVEL_MULTIPLIER` and the purse. Pure functions over a two-field struct — no module state, no DOM, no `three` |
| `leviathanwater.ts` | `createLeviathanWaterPlugin()`, `LeviathanWaterPlugin` | the body as a darkening term INSIDE the water shader, on `medium` and `high`: a tapered teardrop per segment in its own tangent frame, plus the mark's foam ring and a night rim held under `BLOOM_THRESHOLD`. A `WaterPlugin`, built before `createGlobe` and `bind`-ed after |
| `huntreticle.ts` | `createHuntReticle(scene, postFx?)`, `HuntReticle` | the gate, drawn: an annulus sector on the water from `HARPOON_MIN_RANGE` to `HARPOON_RANGE` across `BOW_ARC`, coloured by `HuntState.gate`. Shown on every tier, because it is the onboarding rather than an effect |
| `hunttells.ts` | `createHuntTells(scene, postFx?)`, `HuntTells` | the in-world tells: birds circling the head and a spout on the sim's own seeded timer. What makes finding a shoal navigation by eye rather than a dot on the scope |
| `huntfx.ts` | `createHuntFx(scene, postFx?)`, `HuntFx` | the throw: harpoon line, splash rings, a procedural spray plume, ink on a green strike, and the dive swell. Fixed pools, no lights, no allocation after construction |
| `anchor.ts` | `project(position, camera, width, height, out)`, `createScreenPoint`, `ScreenPoint` | world position to CSS pixels, with an honest `behind` flag that un-mirrors the direction. Its own module because every HUD overlay wants it and every ad-hoc copy gets the behind-the-camera case wrong |
| `huntnumbers.ts` | `createHuntNumbers()`, `HuntNumbers` | floating damage numbers in the cue's band colour, and the green streak from the second onward. Pooled elements, `dt` lifetimes, CSS transitions for the float |
| `huntpointer.ts` | `createHuntPointer()`, `HuntPointer` | an edge arrow toward a mark the camera cannot see, hidden while armed. The chase camera looks forward, so a shoal astern is otherwise invisible |
| `screenfx.ts` | `createScreenFx(camera?)`, `ScreenFx` | the viewport vignette and the camera kick. Obeys `prefers-reduced-motion` by disabling both outright |
| `audio.ts` | `createAudio()`, `Audio`, `ToneSpec`, `NoiseSpec`, `MUTE_STORAGE_KEY` | the sound foundation, and the first audio in this project: a lazily unlocked `AudioContext`, a master gain, a persisted mute, suspend on a hidden tab, and two primitives — an enveloped tone and a filtered noise burst. Silent and inert where there is no context |
| `huntaudio.ts` | `createHuntAudio(audio)`, `HuntAudio` | the hunt's voices: a groan on spawn, a band-edge tick that quickens toward green, thud-splash-chime on a strike, a bass drop on a dive, a rising figure on a settle |
| `leviathandial.ts` | `createHuntDial(deps)`, `HuntDial`, `HuntDialDeps` | the hunt's bar: the bands, the needle, the targets-left and damage strip, and the Space binding — which is LIVE, acting only while `HuntState.armed` is true |
| `rimglow.ts` | `installRimGlow(root, color, strength?)`, `RimGlow`, `RIM_STRENGTH` | the Fresnel `onBeforeCompile` patch that lights a whole silhouette in one colour. Installed BEFORE `postFx.adopt` chains its own hook; see **Post-processing** |
| `battle.ts` | `createBattleSim(rng?)`, `BattleSim`, `HITS_TO_LOSE`, the arena constants | the whole cannon fight in flat arena units: the shrinking circle, W/S, the gun's cadence, the balls, the hits, the AI gunner and the outcome. No DOM and no Three, exactly as `fishsim.ts` is; one sim is built per fight and thrown away with it |
| `battleconstants.ts` | `ARENA_R`, `ARENA_R_MIN`, `ARENA_SHRINK`, `ARENA_OMEGA`, `THROTTLE_GAIN`, `HITS_TO_LOSE`, `FIRE_COOLDOWN`, `BALL_SPEED`, `HIT_RADIUS`, `BATTLE_TIMEOUT` | the numbers the cannon fight is built out of, split out of `battle.ts` by the rework so that `battleai.ts` and `battlesea.ts` can read the ring's dimensions without importing the module that imports them. No logic, only tuning decisions with the reasoning attached; `battle.ts` re-exports the lot so every existing importer keeps working. The AI's own constants deliberately do NOT live here — they describe a gunner rather than an arena, and sit in `battleai.ts` |
| `battleai.ts` | `createBattleAi(rng)`, `BattleAi`, `AiView`, `AI_LAG`, `AI_HELM_PERIOD`, `AI_HELM_COIN`, `AI_FUSE`, `AI_SOLUTION_TOLERANCE` | the enemy gunner and the enemy helm, and nothing else: it knows nothing of the sea, the ring's shrink or the locker's bookkeeping. A two-second delay line (`observe` records every tick, `throttle`/`gun` read it `AI_LAG` later, so every decision is aimed at the player of two seconds ago), a coin flip in one helm decision in four, and a fuse that commits a shot `AI_FUSE` before it fires — which is what makes it dodgeable. Decisions 1, 2 and 4 of `docs/BATTLE_REWORK_PLAN.md` |
| `battlesea.ts` | `createBattleSea(rng, options)`, `BattleSea`, `BattleSeaState`, `SwayTarget`, `CALM`, `ROUGH`, the crest/sway/flotsam constants, `FOUL_SECONDS` | the two seeded systems that put something in the arena, each switched independently by `BattleOptions`: up to `CREST_MAX` crests at once, each a finite length of a line perpendicular to one of the four cardinal directions, rolling across the ring at its own speed and shoving the hulls it actually passes over as a closed-form pulse (nothing to integrate, so nothing that can go unstable at a capped `dt`); and a fleet of three to six flotsam rafts, each its own size and speed, that swallow a ball crossing them and foul a hull they touch for `FOUL_SECONDS`. `CALM` turns both off and is what every unit case measuring the gunner is pinned against; `ROUGH` is the arena's old default; `LIVE` — rafts but no crests — is what a fight in the world is built with, because the sea under the ring is the globe's own and the shoves come from its crests through `shove`. Decisions 5 and 7 |
| `bounty.ts` | `WIN_TIERS`, `rollWinGold(rng)`, `lossGold(purse)`, `rollDrawGold(rng, purse)`, `LOSS_SHARE`/`LOSS_MIN`/`LOSS_MAX`, `DRAW_SWING` | data and pure functions for the three gold outcomes; every roll takes the caller's `rng` |
| `battlescene.ts` | `createBattleScene(quality)`, `BattleScene` | the fight's props: a `Group` in FLAT ARENA COORDINATES holding the cannonballs, the splashes, the flashes and the rafts. No longer a second `Scene`, and no longer owns a sea, lights or a sky: `main.ts` adds the group to the WORLD scene and gives it the one transform that lays the arena's plane on the globe's tangent plane at the ring. The camera is NOT in the group — `placeCamera` puts it on the ring in world space, and the reason is written there. The ring itself is not drawn. See **The fight happens in the world** |
| `battlering.ts` | `findRingCentre(heightMap, seaLevel, contact)`, `ringFits`, `RING_CLEARANCE`, `RING_DRIVEN_OFF` | where a fight may be staged. A raider can catch the player a cable off a headland, and `battle.ts` puts both hulls on a circle it assumes is water; on the globe that has to be earned. Samples the DISC — not the rim — on a three-unit polar grid, and slides the ring to the nearest clear water when the contact point will not do. The slide is uncapped — it searches to the antipode — because a cap of 80 units left 29% of coastal contacts with nowhere to go and staged them on land anyway. Reports how far it moved, which is what puts the line on the cover card |
| `battlewave.ts` | `SEA_VERTEX`, `seaFragment(fine)`, `CREST_VERTEX`, `crestFragment(fine)`, `ARENA_CREST_HEIGHT`, `CREST_GRID` | the arena's water as GLSL, split out of `battlescene.ts` the way `hazardcrest.ts` was split out of `waterhazard.ts`. Compiles `waterglsl.ts`'s ridged field on a plane, `hazardfield.ts`'s crest profile as shared characters and `hazardcrest.ts`'s art constants, so the fight is fought on the same wave the world raises — see **The arena sea is not the globe water, but it is the same wave** |
| `battlecover.ts` | `createBattleCover(deps)`, `BattleCover`, `COUNTDOWN` | the card a fight is DECLARED on: the plate, the rules in one sentence off `FIRE_COOLDOWN`/`HITS_TO_LOSE`, and the three-second count into the arena. A card over a FROZEN world, unlike `battleui.ts` — see **The beat before a fight**. Counts on the wall clock, not on `dt` |
| `battleui.ts` | `createBattleUi(deps)`, `BattleUi`, `BattleResult` | the fight's overlay: the rounds-and-hits strip, the FIRE key, the Space capture and the result card; `isOpen` is a LIVE GETTER, on the pause contract's terms |
| `wakeconstants.ts` | `SURFACE_LIFT`, `WAKE_RADIUS`, `HALF_WIDTH_0`, `SPREAD_RATE`, `WAKE_LIFE`, `STERN_BACK`, `BOW_FORWARD` | the wake's shared geometry, split out because `wake.ts` and `wakemap.ts` would otherwise import each other |
| `wake.ts` | `createWake(wakeMapSize?)`, `Wake`, `WakeDebug` | ship wake and spray; `update(dt, ship, env, renderer?)` fills `wakemap.ts`'s render target last, after every rib/spray value for the frame is final, and before `postFx.render` draws the water that samples it |
| `wakemap.ts` | `createWakeMap(size, ribbonGeometry)`, `WakeMap`, `computeWakeFrame`, `createWakeFrame`, `projectToMapUV`, `WAKE_MAP_EXTENT`, `WAKE_HEIGHT_SCALE`, `WAKE_BREAKUP_GLSL` | renders the wake's foam/height/age into a small top-down render target every frame; see **Shader notes** for the channel layout |
| `waterwake.ts` | `createWaterWakePlugin(wake)` | the `WaterPlugin` that samples `wakemap.ts`'s texture back into the water shader's `normal`/`foam`/`colour` hooks |
| `waterhazard.ts` | `createWaterHazardPlugin()` | the `WaterPlugin` that displaces, foams and darkens the sea for a hazard; a `WaterPlugin` plus one `bind(state)`, because it must be CONSTRUCTED before `createGlobe` and can only be HANDED its state after — see **Hazards**. Owns the uniforms, the slot loop and the shared per-slot locals; the art itself lives in the two files below |
| `hazardcrest.ts` | `CREST_SLOPE_GLSL`, `CREST_FOAM_GLSL`, `CREST_COLOUR_GLSL`, and its tuning constants | fragment-side art for a wave's crest, spliced into `waterhazard.ts`'s branch for `kind < 0.5`. Free to use `sin`/`snoise`: no CPU code compares against it. The constants are exported because `battlewave.ts` shades the arena's crest off the same numbers |
| `hazardfunnel.ts` | `FUNNEL_SLOPE_GLSL`, `FUNNEL_FOAM_GLSL`, `FUNNEL_COLOUR_GLSL` | the same for a maelstrom. The height is radially symmetric so the hull can ride it; the spiral is entirely this file's, and must stay that way |
| `reflection.ts` | `createReflection(quality)`, `Reflection`, `scheduleFaces` | low-res cube camera parked at the ship's waterline, round-robins `quality.reflectionFacesPerFrame` faces per frame; `texture` is `null` and the whole system absent, not idle, when `reflectionSize` is 0 |
| `waterreflect.ts` | `createWaterReflectPlugin(cubeTexture)` | the `WaterPlugin` that mixes the decoded cube into `skyCol` and paints a fake hull-neon streak, since the hull itself cannot appear in its own reflection camera |
| `postfx.ts` | `createPostFx(renderer, quality)`, `GpuFrameStats` | composer / bloom; `adopt(root)` for late materials; chains its sRGB self-encode `onBeforeCompile` after a material's own hook (see **Post-processing**); owns the optional GPU/CPU/draw-call timer toggled with Backquote |
| `globe.ts` | `createGlobe(terrain, quality, waterPlugins?): { group, heightMap, waterBodies, towns, waveOffsets, update(dt, env, wind, ship, camera) }` | orchestrator only; culls islets and installs the land mask before anything reads the map; builds the displacement patch after the water plugins are woven into the shader |
| `ship.ts` | `createShip(terrain, start?, maxAnisotropy?, onHullProgress?)`, `MAX_FORWARD`, `MODEL_SCALE`, `HULL_OFFSET` | glTF hull + physics + collision; `ready` settles on load; `update`'s optional fifth argument is `globe.waveOffsets`, the CPU wave field the hull heaves, pitches and rolls on — see **The wave field** — and its optional sixth is `hazards.state`, a push spent like the wind's plus a drive that takes the helm away entirely; `place(dir, heading)` is the respawn's teleport, `halt()` the overlays' stop; `cloneHull()` is the AI boats' copy, geometry shared and every material cloned, null until `ready` settles |
| `shipfx.ts` | `createShipFx(model, maxAnisotropy)`, `shipGlow`, `isNeon` | animates the model's separate nodes: sail, flag, neon; `shipGlow` is a module-level singleton (colour + dimming level) `waterreflect.ts` reads to paint the hull's fake reflection streak, since the hull cannot appear in its own reflection camera; `isNeon` is exported so `aihulls.ts` recolours exactly the materials this file animates |
| `camera.ts` | `createFollowCamera(aspect)`, `NEAR_DISTANCE`, `NEAR_HEIGHT` | the two chase-framing constants are exported for `fogbank.ts`, which derives its clearing from the fact that this camera sits inside the fog layer — see **The fog bank**. follow camera, tracks ship up; `snap(ship)` puts it at this frame's damped destination immediately, for the one event that moves the hull without sailing it there |
| `controls.ts` | `createControls()` | keyboard + on-screen D-pad + wheel |
| `hud.ts` | `createHud(wallet)`, `questLineText`, `questSeverity`, `QuestLineInput`, `QUEST_URGENT_BELOW` | speed, gold, power, the backup cell, the hull, the mooring notice, and the one contract line; wind, sky, heading and the fix live on the radar panel, and the ship's keys on the helm pad. Owns the power panel's two derived readings — `powerTag` (the ten `EnergyMode` causes plus its own `full`) and `powerSeverity` (the five colours), which are deliberately two axes rather than one enum; see **The tag names a cause; the colour names a severity**. Also owns the three level bars' `flow--*` state and their `is-crest` / `is-sweep` markers (see **What a bar is doing**), and publishes `--telemetry-h`, the panel's rendered height, which the dock is positioned off |
| `menu.ts` | `createMenu(deps)`, `Menu`, `HarbourEntry`, `ContractEntry`, `formatBearing`, `formatDistance` | the Escape menu and its three pages: the controls guide, the 36 harbours, and the contracts in hand. Owns the Escape key OUTRIGHT — opening as well as closing — and asks `main.ts`'s `canOpen` whether it may; a card over a frozen world, on the pause contract's terms. Both list pages are handed finished rows by `main.ts` and neither knows what a `Towns`, a `ShipState` or an `ActiveQuest` is |
| `radar.ts` | `createRadar(heightMap, waterBodies, seaLevel, towns)`, `RADAR_RANGE` | 2D canvas scope, no draw calls; `update(dt, ship, wind, hazards, boats?, weather?, cells?, chart?)`. The scope's GEOMETRY never changes with the weather — `RADAR_RANGE`, the projection tables and the range rings are fixed — what changes is how much of it has anything in it: beyond `WeatherState.visibility` a pixel is `SCOPE_FOG` if uncharted and the coast dimmed toward it if charted. Cells draw as discs of `radius * strength`, culled on `visibility + radius` so a bank whose centre is off the scope still shows. It is also where the chart is STAMPED, because this is the one place that knows both the visibility and when it last looked; hazards and raiders alike are drawn from the LIVE frame, like the wind arrow and for the same reason: hazards in `--magenta`, raiders as own ship's own arrowhead turned to their relative heading, in `--red` or `--orange` at `envelope` alpha |
| `horizon.ts` | `limbSin(cameraRadius)`, `sunAppearsSin(cameraRadius)`, `SUN_APPEARS_SIN` | where the DRAWN horizon is, and the elevation the sun's disc clears it at; derived from `GLOBE_RADIUS`, the chase camera's opening framing and `SUN_DISC_RADIANS`, so nothing downstream writes the number down |
| `solartime.ts` | `solarPhase(up, sunDirection)`, `phaseName`, `SolarPhase` | where the ship stands in its own day or night, and how far through it; DOM-free, so the geometry is testable without a canvas |
| `timedial.ts` | `createTimeDial(canvas)` | draws that phase beside the scope, under the fix; 2D canvas, no draw calls |
| `species.ts` | `SPECIES`, `TIERS`, `ROW_ODDS`, `speciesById(id)`, `rollSpecies(row, rng)` | data only; twenty species in five tiers, and the per-row tier odds |
| `fishsim.ts` | `createFishingSim(rng?, extraShots?)` | the whole ruleset in card units; no DOM, no canvas, no pixels |
| `fishrender.ts` | `createFishRenderer(canvas)` | 2D canvas, like `radar.ts`; the only reader of `SpeciesArt` |
| `fishing.ts` | `createFishing(deps)`, `SESSION_COST` | the overlay: card DOM, input capture, gold and book bookkeeping |
| `fishcover.ts` | `createFishCover(deps)` | the activity screen [FISH] opens; holds the power gate, and picks the harbour or open-water plate off `energy.mode` at the moment it opens |
| `fishbook.ts` | `createFishBookStore(record)`, `createFishBook(store, wallet)` | the catch record, and the panel that shows it |
| `wallet.ts` | `createWallet(initialGold)` | the only writer of gold; subscribers rather than pollers; `spend` is all-or-nothing for the shop and `lose` is best-effort for a defeat, which is not a purchase and must not be refused for an empty purse |
| `battery.ts` | `createBattery(initialPercent)`, `BATTERY_CELL`, `BATTERY_CELLS_MAX`, `BATTERY_CAPACITY` | the bought backup cells; the only charge in the world nothing recharges |
| `harpoons.ts` | `createHarpoonStore(initial)`, `HARPOON_BUNDLE`, `HARPOON_STORE_MAX`, `HARPOON_PER_SESSION_MAX` | the spare-harpoon locker, and its two different ceilings |
| `shop.ts` | `createShop(deps, search)`, `BATTERY_PRICE`, `HARPOONS_PRICE`, `DEV_GOLD_GRANT`, `isDevMode`, and one price constant per Navigation/Fishing item | the chandlery panel, split into a Navigation and a Fishing tab; the only place gold leaves the purse, and behind `?dev` the only place it is minted |
| `seaanchor.ts`, `overdrive.ts` | `createSeaAnchorStore`/`createOverdriveStore` | the two Navigation consumables with a deploy timer, read by `ship.ts`/`energy.ts` through `main.ts`'s per-frame `PropulsionState` and `overdriveActive` |
| `trim.ts`, `moonglass.ts` | `createTrimStore`/`createMoonglassStore` | the two Navigation durables; `trim.maxForward` feeds `ship.ts`, `moonglass.nightFraction` feeds `energy.ts` |
| `chumdrum.ts`, `barbedheads.ts` | `createChumDrumStore`/`createBarbedHeadsStore` | the two Fishing consumables, armed on `fishcover.ts` and spent by `fishing.ts` into `createFishingSim`'s `minSpawnTier`/`tensionDrainScale` |
| `arclamp.ts`, `governor.ts` | `createArcLampStore`/`createGovernorStore` | the two Fishing durables; `arcLamp.sessionSeconds` and `governor.sessionCost` feed `fishing.ts`/`fishsim.ts` directly |
| `tierstore.ts`, `stockstore.ts` | `createTierStore`, `createStockStore` | the shared shape behind all eight items above — a tier ladder and a one-at-a-time stock cap, respectively; see `docs/SHOP_PLAN.md` for why the eight do not each reimplement one |
| `save.ts` | `createRecords()`, `loadSave()`, `writeSave(data)`, `SAVE_KEY`, `loadChart()`, `writeChart(encoded)`, `CHART_KEY`, `QuestSource` | localStorage, versioned, tolerant of garbage. `attachQuests` is the one asymmetry: every other record is built from a number in the file, but contracts need `globe.towns` and the chart, so `main.ts` builds the sim and hands it back. TWO keys: the save file, rewritten in full on every catch, purchase and whole percent of battery, and the chart, 87 KB written at most every five seconds while it changes. Opposite cadences, so they are not one file — the price being that clearing a player's progress means clearing both |
| `dev/probe.ts` | `runProbe()` | `?probe=wave`'s only entry point; renders the GPU `waveField` chunk to a canvas and publishes the matching CPU samples for `tests/smoke/wave-parity.spec.ts`; tree-shaken out of a normal load |
| `blackout.ts` | `createBlackout()` | the fade a wreck happens behind, and both of a battle's; owns `#blackout` and the promise that `onBlack` runs when the screen is ACTUALLY opaque, on `transitionend` with a timer fallback |
| `loading.ts` | `createLoading()` | drives the splash `index.html` ships visible; the only UI a module does not build |
| `main.ts` | — | staged bootstrap and frame loop; owns `HULL_WEATHER_THRESHOLD`, the battle/maelstrom hull costs, and the world-generation loop |
| `harbournames.ts` | `HARBOUR_NAMES`, `HARBOUR_COUNT`, `NORTH_POLE_INDEX`, `SOUTH_POLE_INDEX`, `HARBOUR_NAME_MAX_LENGTH` | the 36 names, and the only part of the world that never moves. A harbour's IDENTITY is its name, not its position — the world is redrawn every load — so `save.ts` keys on the string. Indices 0 and 1 are the poles and are read from here rather than counted from the front of the list |
| `worldgen.ts` | `generateWorld(seedHint, quality, onAttempt?, forcedRejections?)`, `checkWorld`, `worldPasses`, `WORLD_ATTEMPTS`, `LAND_MIN`, `LAND_MAX` | draws a seed, builds a world's DATA, measures it, and throws a bad one away. `?seed=` makes exactly one attempt and THROWS; without a hint it draws from the CSPRNG up to `WORLD_ATTEMPTS` and then falls back to `DEFAULT_SEED`, which passes by construction. `?reject=<n>` forces the first n attempts to fail, and exists because no failing seed is known — see **Harbours** |
| `hull.ts` | `Hull`, `createHull(percent?)`, `createStubHull()`, `HULL_MIN/MAX`, `HULL_WEAR`, `HULL_WEATHER_GAIN`, `HULL_REPAIR_RATE`, `HULL_WORN_BELOW`, `HULL_FAILING_BELOW`, `HULL_CAP_WORN/FAILING/CRITICAL` | durability: a float in [1, 100] published as a whole percent, with `speedCap`, `canFish`, `hitsToLose` and `mode` all DERIVED from that published number. `update(dt, docked, weathered)` is called only from the sailing branch, which is what keeps the clock off during fishing, a fight, the shop and the menu. `hud.ts` and `shop.ts` import the band edges rather than copying them |
| `questconstants.ts` | `MAX_ACTIVE`, `OFFERS_PER_HARBOUR`, `ARC_NEAR`, `ARC_FAR`, `CRUISE_SPEED`, `DELIVERY_DAYS`, `WINDOW_SLACK`, `WINDOW_MIN`, `DELIVERY_GOLD`, `CHART_TARGETS`, `CHART_GOLD`, `CHART_PROGRESS_STEP`, `REPUTATION_BY_TIER`, `REPUTATION_FAIL`, `REPUTATION_FLOOR`, `TOAST_HOLD`, `TOAST_QUEUE`, `CARGOES` | every tuning number the contract system has, and deliberately zero imports — so a test can read the table without standing up a world. `CRUISE_SPEED` is not imported from `ship.ts` on purpose: `MAX_FORWARD` states the hull's flat-out speed and this states the speed a contract ASSUMES, which has to be below it |
| `reputation.ts` | `Reputation`, `createReputation(initial?)` | standing with the harbours: one signed integer, floored at `REPUTATION_FLOOR` and with no ceiling. Built on `wallet.ts`'s shape and deliberately NOT a second wallet — there is no `spend` and no refusal, because a deadline that has passed has passed whether the player can afford it or not. It buys nothing yet; Phase 2 of `docs/QUESTS_PLAN.md` owns what it will buy |
| `quests.ts` | `createQuests(deps)`, `Quests`, `QuestsDeps`, `arcBetween`, `tierForArc`, `windowReachable`, `windowSatisfied`, `daylightLeft`, `formatSpan`, `formatDeadline` | the contract sim: generation, acceptance, the per-frame check, completion, failure and the reward. DOM-free and world-free, with callbacks for `Towns` and `Chart`. No `Date`, no `performance.now()` and no `setTimeout` — see **Contracts** |
| `toast.ts` | `createToast()`, `createToastQueue()`, `Toast`, `ToastSeverity` | the transient notice the game had none of. One message at a time, held for `TOAST_HOLD` of WORLD seconds, ticked from the sailing branch only. `createToastQueue` is the same rules without a DOM, for the tests |
| `questcover.ts` | `createQuestCover(deps)`, `QuestCover` | the harbour's board, what [WORK] opens. `fishcover.ts`'s shell; knows nothing of `Towns`, the sun or the chart — every fact on a card is inside the offer, except the one line about the target's sky, which `main.ts` supplies as a callback |
| `knownharbours.ts` | `KnownHarbours`, `createKnownHarbours(saved?)` | the names the ship has moored at, in first-visit order. `add` is idempotent because the caller is a frame loop |
| `course.ts` | `Course`, `createCourse(saved?)`, `pickCourse` | the one harbour the player is sailing for, by name, saved as `destination`. `pickCourse` is the whole rule: uncharted is refused, the current course toggles off, anything else replaces it. Cleared on the frame the ship moors there |
| `harbourstock.ts` | `HarbourStock`, `createHarbourStock(saved?, names?, random?)`, `LINE_MIN_HARBOURS` | which of the four durable ladders each harbour sells. Rolled for ALL 36 at once and saved, because the coverage guarantee — every ladder carried by at least six harbours — cannot be made one harbour at a time, and because a remembered harbour must keep the stock it had |

## Land / water split
The average world is **26.7% land, 73.3% water**, and that is one constant:
`HEIGHT_BIAS` in `terrain.ts`, tuned against the figure *after* the islet cull
below.

**Tuned against the population, not against the pinned seed.** `HEIGHT_BIAS`
moved from -0.0964 to -0.0657 when the equatorial strip went in: the veto
drowns whatever the noise had put across the equator, and this puts that land
back everywhere else. The target was the 50-seed MEAN, measured at 0.267151
before the strip and landed on 0.267166 with it. Restoring seed 1337's own
figure instead would have over-restored every other world — the strip takes
more equatorial land off 1337 than off an average draw — pushing the mean up
and the top of the distribution past `LAND_MAX`, turning a negligible rejection
rate into roughly one world in six. Seed 1337 is 0.2409 as a result, down from
0.2449.

**It is a function of the strip's width.** Re-solve it whenever that moves: it
was -0.0590 while the strip was fifty units wide and is -0.0657 at forty.

`npm run world:measure` is what produces every number in this section — see
**Measuring the world** below. Do not retune `HEIGHT_BIAS` by eye.

`HEIGHT_GAIN` and `HEIGHT_BIAS` are **not two knobs**. Land is
`raw * GAIN + BIAS > SEA_LEVEL`, i.e. `raw > (SEA_LEVEL - BIAS) / GAIN`, so the
pair only ever expresses one number — a threshold on the raw noise — and every
(GAIN, BIAS) yielding the same land fraction yields a bit-identical coastline.
Reach for `BIAS`; moving `SEA_LEVEL` instead would work identically on the
shape of the world while silently retuning every constant written as a height
*above* sea level (`SHORE_MARGIN`, `CENTRE_CEILING`, `BEACH_BAND`,
`CULL_MARGIN`, the water shader's depth ramp).

The split between open ocean and enclosed water is **not tunable here at all**.
It follows from that same threshold: lower the sea and deeper flooding joins
more basins to it. At 33% land the world's lakes were 1.3% of its water; at 25%
they were 0.66%, and no choice of `GAIN` recovers the difference. Only a
different noise field would. (The equatorial strip moved this too, and in the
direction the rule predicts: a ring of ocean round the whole planet joins
basins that used to be separate, so seed 1337's water bodies fell from 103 to
86.)

`land.ts` builds an icosphere, drops every face lying entirely below
`seaLevel - CULL_MARGIN`, and displaces the rest. Kept vertices below sea level
are pushed *under* the water sphere so shores run into the sea instead of
forming floating plates.

`water.ts` is one smooth full sphere at `GLOBE_RADIUS`. Dry parts are simply
hidden by the land above. All coastal detail (shallows, foam) is computed per
pixel from the height map, so the water mesh stays cheap.

## Islands small enough to be invisible
`islets.ts` flood-fills land components over the height map grid and sinks
every one under `MIN_ISLAND_AREA` — 24.6 u², a disc 5.6 units across, a little
under two ship lengths. 174 of seed 1337's 269 islands go, and they take about
0.6% of its land with them.

The same pass enforces the equatorial strip's own two caps, which are the
mirror of that rule — see **The equatorial strip**.

It has to be a **raster** pass. Whether a point belongs to a speck or to a
continent is a fact about its neighbours, and no closed form over
`terrain.heightAt` can answer it. Editing the map rather than the noise also
means the land mesh, the water shader, the berth search and the scope inherit
the answer without being told, which is why the cull runs in `globe.ts` before
`waterbodies.ts` — the flood fill then sees the sunk islets as plain ocean and
never strands a lagoon inside one that no longer exists.

**The trap, and it is the whole reason the fix works.** Collision does not read
the map. `ship.ts` asks `terrain.isLand`, which reads the noise field directly,
so culling the raster alone would have left the hull snagging on islets nothing
draws any more — the original bug wearing a hat. `globe.ts` therefore hands the
culled map back via `terrain.useLandMask`, which makes collision, the land mesh
and the water shader three readings of one field instead of two.

Sink depth is pinned by two consumers at once: past `land.ts`'s `CULL_MARGIN`
(0.10) so the mesh drops the face, and past the water shader's 0.11 shallow
band so the patch reads as ordinary shelf rather than ringing every former
islet in a bright shoal. 0.12 is the first depth that satisfies both.

## Reachable water
`waterbodies.ts` flood-fills the height map grid from the spawn point and marks
everything it cannot reach — lakes, tarns, landlocked seas. Because the ship
refuses to enter land, that component *is* the water the player can ever sail
on, so the mask is the authority on "ocean" versus "inland", not a hand-drawn
guess. It is an R8 equirect texture in the same projection as the height map,
so a shader reuses `dirToEquirect` for both lookups, plus a CPU `sample(dir)`
for `radar.ts`. `water.ts` crossfades palette, wave drift, ripple height and
surf against it.

The inland flag is bled a few texels *into the surrounding land* so bilinear
filtering cannot drag a lake's own shoreline back toward sea colour. It is
never bled into reachable water.

## Weather

Three modules, and they meet at two numbers. `weathercells.ts` is a drifting
population of storms and fog banks with a place, a radius and a bearing;
`weather.ts` rolls placeless SQUALLS off the wind's own phases and combines
both into one `WeatherState`; `chart.ts` records what the ship has seen. The
two numbers are the five envelopes at the ship and `visibility`.

Two sources rather than one is the design and not an accident. A cell can be
seen coming, sailed around and outrun; a squall cannot, and arrives with the
gale. A world with only the first kind never surprises anybody, and one with
only the second never rewards looking out of the window. They are combined by
`max` **before** any smoothing, so nothing downstream can tell them apart or
has to — and combining after would let a squall ending inside a cell pull the
total down for a moment, because the max of two eased numbers is not the ease
of their max.

### The three traps

**1. The wind's PRNG is not touched.** `wind.ts` draws a fixed sequence per
phase and `tests/unit/wind.test.ts`, `terrain-golden` and `world-golden`
replay it. One extra `rng()` there shifts every draw after it. Squalls and
cells each own a `mulberry32` on their own seed, and both draw a FIXED number
of numbers per roll whatever the outcome — the same unconditional-draw
discipline `hazards.ts` records on its `ROLL_ORDER`.

**2. Zero is the game as it shipped.** Every shader and light the weather
touches gains a term multiplied by an envelope or a map sample, and at zero
each must vanish *exactly*. `applyAerial`'s ceiling is a uniform whose resting
value is the constant it replaced; the cloud, dome and light terms are all
multiplied by an envelope; an empty map is zero everywhere. `?weather=clear`
exists to check it, and the check is a `npm run shots` comparison against
`main` rather than a test, because what it protects — the ocean's
`uShallow`..`uAbyss` depth ramp — has been washed out by a careless additive
term three times now and every one was found by eye.

**3. The map is not the truth.** `weathermap.ts` is 2.45 world units per
texel, bilinear and up to a quarter-second stale. It is what the SKY reads.
Everything that decides a number — the envelopes at the ship, the visibility,
the wind's floor, the chart's stamp, the battle's sea — samples the cells
analytically on the CPU through `CellsState`. The two disagree by a texel at
a cell's edge, where the sky is soft and nobody can tell.

### Why the map is a texture and not uniform slots

`waterhazard.ts` packs three hazards into uniform arrays, and that is right
for a hazard: there are exactly three, each is a height the hull must ride,
and the loop is three iterations of polynomial arithmetic. A cell is none of
those. It shades rather than displaces, the population is not fixed, and the
orbital shot wants every cell on the lit hemisphere rather than the three
nearest the ship. So the cells are rasterised into a small equirect texture at
4 Hz and read with the same `dirToEquirect` the height map and the water-body
mask already use: one fetch per pixel whatever the population, and no
`MAX_CELLS` in any shader.

### What the storm multiplier actually buys

`main.ts` computes `stormOdds` once and hands it to both spawn sims, where it
multiplies the roll's comparison and nothing else. It triples the
PROBABILITY. It does not triple the encounters, and the two sims differ by a
factor of two:

- **Raiders: about 2.7x.** `aiboats.ts` rolls once every ten seconds, nowhere
  near saturating its one-of-each-kind cap, so tripled odds are worth very
  nearly tripled spawns.
- **Hazards: about 1.24x.** `hazards.ts` rolls every SECOND at 0.2, and a free
  wave slot refills almost at once even in fair weather. What limits the
  hazard population is how long one LIVES, not how often one is rolled for,
  and tripling a probability that already saturates buys the difference
  between "almost immediately" and "immediately".

**The storm multiplier and `CAPACITY` are two different limits and both
stand.** The odds decide how fast a free slot refills; the capacity decides
how many slots there are. A storm therefore fills the sea faster without ever
raising its ceiling — which is why the hazard figure fell from 1.46 to 1.24
when the weather was merged into a main that had meanwhile raised the wave
odds and let two crests run at once. A fuller sea saturates harder, so the
same multiplier buys less of it.

**Red raiders are exempt** (2026-09-08, owner's call, the same day `P_RED` was
cut to a fifth). The weather may make the sea busier without making it more
hostile: an orange boat is a hull that happens to be out there, and more of
them in dirty weather is the world being fuller, while a red one ends in a
fight unless it is out-turned. Tripling THAT in a storm would interrupt the
player at the exact moment the sea is already the thing being fought, and
would hand most of the 80% cut straight back. The multiplier is applied
inside `roll`, per colour; the draw is still taken for both, so the seeded
stream replays whatever the sky is doing. Nearly all of the 2.7x above is
orange for the same reason — 0.24 against red's 0.032.

All three figures are measured, in `aiboats.test.ts` and `hazards.test.ts`,
over 100 minutes of sim. Anyone reading "tripled" and expecting it of any of
them would be wrong.

### The strike is three numbers, and the bolt is the only reader of two

The flash existed long before anything was drawn for it: `sky.ts` brightens
the dome on `weather.flash` and `clouds.ts` lifts the cloud undersides toward
white, and both are enough to light a storm. What neither gives you is
anything to LOOK at, and a flash with no bolt reads as the exposure changing
rather than as lightning — the player never finds out which way the storm is.

`lightning.ts` draws that bolt and nothing else. It owns no timing, no gate
and no randomness: everything it needs is fixed by `weather.ts` at the instant
of the strike and published on `WeatherState`.

- `flash` is the ENVELOPE — the same double pulse the sky rides, so the
  channel dims and re-lights with the hemisphere instead of on a clock of its
  own.
- `flashSeed` is the SHAPE. A draw off `weather.ts`'s own stream, which is why
  a replay that agrees about the weather agrees about the fork, and why
  `?weather=lightning` photographs the same bolt twice. `buildBolt` is pure
  given it.
- `flashOrigin` is the PLACE: a copy of the striking cell centre, or null for
  a squall, which has none and hangs its bolt on the ship.

All three are latched at the strike and cleared when it retires. That is the
whole reason they are state rather than a per-frame read: a cell drifts, and
one read per frame would slide a lit bolt across the sky, reshape it, or turn
a placed flash into a placeless one halfway through its own decay.

The consequence for the module is that geometry is rewritten once per STRIKE
and not once per frame — a lit frame costs one uniform write and one draw
call, an unlit one costs nothing, because the object hides itself. That is the
same bargain `rain.ts` makes, and the reason both sit in the frame loop
unguarded. It is also why the bolt is built on every quality tier, including
the one with no rain at all: under two hundred vertices for a third of a
second buys nothing back by being cut, and a low-tier storm that flashes with
nothing to see in it is the weakest storm the game has.

### Rain comes in episodes

Rain used to be one number: the storm's envelope with `RAIN_ONSET` cut off the
front and the rest eased, so a squall rained at exactly one strength for its
whole length. Since 2026-09-10 (owner) a live rain is cut into EPISODES —
waves of harder and lighter rain inside the one storm.

- **How long.** Between `RAIN_EPISODE_MIN` (1 s) and half the rain that
  carries it (`RAIN_EPISODE_SHARE`), so a phase always holds two or more. One
  allowed to fill the whole event would be the old single-strength rain
  wearing a new name.
- **Of what.** `wind.phaseDuration`, which is known in full the moment the
  phase begins, so the episodes inside it can be sized against the whole
  before any of them has run. Rain from a CELL has no such number — how long a
  cell sits on the ship is a fact about a course nobody has steered yet — so
  those are cut against a nominal `RAIN_EPISODE_SPAN` (30 s) instead.
- **How hard.** One of nine levels, 20% to 100% of the rain the storm would
  otherwise have produced, a tenth at a time. Never zero: rain that stops dead
  and restarts is two rains, and the gap between them belongs to the storm
  envelope. Each roll excludes the level it replaces, so every boundary is a
  real change of strength.
- **How it arrives.** Eased over `RAIN_EPISODE_TAU` (1.2 s), never stepped.

The multiplier is applied to `state.rain` — the ENVELOPE — and not to the
drops, so one wave eases everything rain drives at once: the curtain in
`rain.ts`, the wet darkening of the distance through `uRainHere`, the scope's
own range through `STORM_VIS_CUT`, and the HUD's label. A drizzle you can see
further through is the point; a drizzle that is only thinner drops would have
belonged in `rain.ts`.

Two disciplines carry over from the rest of the weather. The episodes own a
THIRD `mulberry32` stream, so the sequence of squalls cannot depend on how
many waves of rain fell inside the last one — and it is warmed with eight
discards, because `mulberry32` advances by a fixed addend and two seeds a few
bits apart produce correlated first outputs (seeds 7, 11 and 23 all opened
their first storm at the 20% floor). And a `?weather=` pin switches the
episode clock off with the squall roll: a pinned shot has to be the same shot
every time, and 20%-of-a-downpour and 100%-of-one are two different pictures
with nothing in the URL to tell them apart.

### The rain box is not a size, it is a framing

Rain is drawn as a box of drops around the hull, and for a long time that box
was a fixed 14 units across. It cannot be. `camera.ts` frames the hull from
≈23 units at its closest and ≈211 at its furthest — a **nine-fold** range on a
wheel the player turns freely, opening at ≈38. A box of any fixed size is
correct at exactly one framing and wrong at the other eight, and what "wrong"
looks like is a discrete column of rain standing on the boat with dry sea
around it. Making it bigger only moves which single zoom is right.

So the box is sized from the camera every frame, and the three axes are three
different questions:

- **Width** answers to the FRUSTUM, not to a distance. At the same zoom a 21:9
  monitor sees half again the width a 16:9 one does, so a box tuned against
  either shows its walls on the other. `fov` and `aspect` are the whole of
  what that takes and the camera already carries both. `RAIN_COVER` holds it
  under the full half-width, because coverage is paid for in density.
- **Depth** answers to the CAMERA'S DISTANCE. The one stretch of rain the
  player is guaranteed to be looking through is the stretch between the lens
  and the hull, so `RAIN_BEHIND` pushes the astern wall just past the camera
  and the box carries its own centre, which is no longer the hull. Size depth
  off the frame instead and the wall lands short of the lens at every zoom —
  15 units against a camera 21 back — and the whole foreground of every frame
  is dry water while it rains on the middle distance.
- **Height** answers to the camera's ALTITUDE, which is a different question
  again. A ceiling is a plane, and a plane in shot is a line the rain begins
  at -- drops arriving out of clear air partway up the frame. Whether that line
  is in shot depends on how much sky the frame holds, and on a globe this small
  that is a strong function of altitude: the horizon sits `acos(R / (R + A))`
  below level, nearly 23 degrees from 17 units up, so at the framings the game
  is played at roughly half the frame is sky. From far up the camera pitches
  down hard enough that the ceiling never crosses the frame at all, which is
  why the tall view looked right when the low one did not. So the ceiling
  climbs past the lens as the lens climbs (`RAIN_TOP_LIFT`), stopping at
  `RAIN_TOP_MAX` where the pitch has taken the line out of frame on its own.
  `RAIN_BELOW` hangs three units under the water so a drop falls THROUGH the
  sea rather than winking out on it -- three, not half the box, because every
  unit below the waterline is drops nobody can see.
- **The top has no wall to hide behind.** `RAIN_FADE` dissolves the sides and
  the far edge and the near one is behind the lens, but the ceiling is simply
  where drops stop, and lifting a hard edge only moves it. `RAIN_TOP_FADE`
  dissolves the last third as well, which turns the ceiling into rain thinning
  out overhead. The fall speed, the wind drift and the streak length stay in
  world units throughout.

That split is load-bearing and was learned the hard way: written first as a
uniform `object.scale`, it stretched the height too — ten units became fifty,
the drops spanned twenty-five above the masthead to twenty-five under the
keel, and all that showed above the water was a thin band with dry sea
beneath it. The scaling belongs on the lane spread in the shader, where it
touches the footprint and nothing else.

Two things follow. Coverage costs density — the box holds a FIXED drop count,
so roughly three and a half times the width is roughly twelve times the
footprint, and `quality.rainDrops` had to move with `RAIN_COVER` and must
keep moving with it. And rain has to STOP: past `RAIN_FAR_IN` the camera is
beyond the ship's own visibility and looking down at the weather rather than
standing in it, where a storm is the darkened deck and thickened haze
`clouds.ts` and `fog.ts` already draw. Left running to 130 units, the widened
box threw streaks out past the planet's own limb, and rain falling through
empty space is worse than no rain at all.

### Two bugs a big box finds that a small one hides

Both showed up as the same picture -- a raft of rain adrift from the ship, or
a bright bank of it standing past the horizon -- in frames whose box numbers
are correct in every particular. Both had been latent for as long as the
module existed, and neither is reachable while the box is small.

**The basis was a reflection.** `makeBasis(x, y, z)` is a rotation only when
x cross y is z, and the starboard vector was built as `_fwd` cross `_up`,
which is minus that: determinant -1. `setFromRotationMatrix` is defined for
rotations only, and handed a reflection it returns an unnormalised quaternion
-- for an axis-aligned case literally `(0, 0, 0, 0.707)`, a box at half scale
and no rotation at all. A box centred on the hull and symmetric across its own
x looks identical reflected, so nothing could see it; offsetting the box
astern and stretching it differently across than along made the orientation
observable for the first time. `lightning.ts` records the same trap at its own
`tangentAt`, and got it right there.

**The phase must be integrated, not derived.** `uTime` is the fall in box
heights, and both the ceiling and `RAIN_HEIGHT` move now, so
`elapsed * RAIN_FALL / height` jumps the instant the height does and every drop
in the curtain teleports at once. Integrating the rate keeps it continuous. The
rate itself is world-constant: 18 u/s under any ceiling and at any zoom, so a
taller box simply takes longer to fall through.

**The rain fell upward.** `fract(aLane.y + uTime)` climbs with time, and
`pos.y` is that number times the box height, so every drop walked steadily out
of the sea -- while the streak was hung off the velocity vector and therefore
pointed the way a *falling* drop's would. Rain rising with the tails of falling
rain is exactly what it looks like, and it shipped that way. The fix is the
sign; the wind drift moved to `1.0 - fall` with it, so the curtain bends
downwind on the way down instead of unbending.

**The box is flat and the sea is not.** A point `d` units from the box centre
sits `d^2 / 2R` above the water. At 14 units across that is 0.12 and
invisible; at the 50 the camera asks for it is **6.2**, against a box only 10
tall, so the far half lifts clean off the sea and the drops that were hidden
under the water stop being hidden all at once. `RAIN_CURVE` bends the box back
onto the globe with one paraboloid term in the vertex shader -- the
second-order expansion of the sphere, right to a few centimetres over a box
this size, for the cost of a dot product.

The pattern worth keeping: **making a thing bigger is a way of testing it.**
Neither bug was introduced by the camera scaling. The scaling only raised the
box past the size at which each stopped being invisible.

### The box has four walls and only three of them are visible

`RAIN_FADE` dissolves the drops toward a wall so the footprint has no edge to
see — toward three walls. The box is heading-aligned, so `-z` is the wall
astern, which `RAIN_BEHIND` now puts behind the lens: the camera looks
THROUGH it rather than at it, and perspective makes those drops the nearest
thing to the lens and the largest part of the curtain on screen. Fade it and
the storm goes with it — a symmetric fade was tried at two settings and both
took the rain back to roughly what it had been before `RAIN_ALPHA` was ever
raised.

The general lesson under all of this is the one **Testing** states in other
words: a change whose whole purpose is visible only in a frame has to be
judged in a frame. Every wrong version above typechecked, and every one of
them passed the suite.
### The panel has a word for it: `overcast`

`EnergyMode`'s eleventh rung, added with the weather. Without it the panel
would read `IDLE - SOLAR CHARGING` beside a rate near zero under a storm,
which is the same class of lie `restart` and `moon` were added to remove — the
tag would name a cause that was not doing the work.

It is a threshold on `OVERCAST_KEEP` (two thirds), the share of a clear sky
the weather LEAVES, and deliberately not on the rate. A low sun in clear air
makes a small rate too, and that one is honestly solar; the question this asks
is about the sky, not about the number. At the cuts below, a storm passes it
at a third of full strength and a fog bank at two thirds, so the tag turns
over while the weather is arriving rather than once it has settled.

It sits INSIDE the sunlit branch of the ladder rather than beside it: a
Moonglass Array under a storm is cut by the same factor but is still charging
off the moon, and `MOONGLASS` is the honest cause there.

### Why a harsh solar cut cannot strand anybody

`STORM_SOLAR_CUT` is 0.95: a full storm leaves 5% of the panels. The question
that number has to answer is whether a ship can be caught under permanent
cloud with an empty tank, and it cannot, because both sources are bounded:

- A squall is a subset of a wind event, and `wind.ts` caps an event at
  `EVENT_MAX` = 30 s. That costs 15% of `SOLAR_FULL_SECONDS`, and the lull
  after it is guaranteed.
- A cell fades to nothing at the end of a life of at most six minutes, and
  drifts at 2 u/s while a dead hull does not — so even a stationary ship is
  clear of a 40-unit storm within about 40 s of its centre passing.

Against `IDLE_ENDURANCE` of 42 minutes neither is close to dangerous, and a
floor here would only hide those two bounds from whoever next changes them.

### The chart, and why it has its own storage key

`chart.ts` is bytes in memory and bits in storage, and both choices are the
scope's: it samples the bitmap ~37 000 times per raster at 10 Hz, where a byte
read beats a shift, and the same map packed is 64 KB, where 512 KB would not
belong in localStorage.

It lives under `CHART_KEY`, beside `SaveData` rather than inside it, because
the two have opposite cadences. The save file is two numbers and twenty counts
rewritten in full on every catch, purchase and whole percent of battery; the
chart is 87 KB that changes continuously while a player explores. Together
they would have dragged one onto the other's schedule. Apart, each writes at
the rate it should — and the price, recorded here so it is not forgotten, is
that clearing a player's progress means clearing two keys.

Discovery is stamped with `WeatherState.visibility`, not with `RADAR_RANGE`,
which is what makes fog cost something lasting: a coast passed in thick
weather is not charted and has to be passed again.

### The fight happens in the world

A fight used to be a second `Scene` with its own flat sea nowhere on the globe,
its own sun rigged to imitate the elevation at contact, and its own sky. All of
it existed to reproduce, for ninety seconds, a sea and a sky the game already
had running, and this section used to be a list of the compromises that forced:
no map sample, because a position that is not a place cannot be looked up; an
at-ship fog envelope frozen at the moment of the ram; a storm let in and a bank
kept out.

**None of that applies now.** `battlescene.ts` owns a `Group` of props in flat
arena coordinates and nothing else; `main.ts` adds it to the world scene and
gives it the basis `(east, up, north)` at the ring's centre, so a combatant at
arena `(x, z)` lands at `centre * R + east * x + north * z` and a prop at
`y = 0` lands at sea level. `battle.ts` still does every calculation in flat
metres and has not changed a line for any of it. See docs/ROADMAP.md, "The
fight, in the live world", whose step 1 this is.

**The camera is not in that group, and that is load-bearing.** Parenting it
there is the obvious move — the props already carry the transform — and it was
written that way first. The world renders WRONG through a camera parented like
that: no sky at all, a black starfield over a lit afternoon sea, and water so
transparent the sea floor shows through it. It was isolated by elimination
against the chase camera on a live frame (pose, FOV, aspect, near/far, layer
masks, frustum test, and the sky dome's own visibility and day factor all
identical; the same pose through an unparented camera drew correctly). So
`placeCamera` positions it in world space from the ring's basis instead.

Its depth range is the world camera's 0.1–6000, not the arena's old 0.1–2000:
the sky dome sits about 3800 units out and a 2000 far plane cuts it off, which
looks like the sky ending in a hard band above the horizon. And its pose is 19
up and 52 back rather than 26 and 34 — 20 degrees below horizontal instead of
37, so the horizon is inside the frame and the sea is seen at a grazing angle
that reflects the sky instead of showing the bottom through it.

**The ring is not drawn.** It briefly was; a hard annulus laid flat on the sea
read as interface dropped onto the world. `battle.ts` still holds both boats to
it and still closes it, so the constraint is unchanged — only the annulus is
gone.

What that buys is the thing the roadmap wanted and not a graphical upgrade: the
clock runs. `weatherCells.update`, `wind.update`, `weather.update`,
`hazards.update` and `globe.update` all run on the battle branch now, so the
sun moves, a squall can arrive mid-duel, and the sea under the ring is the sea
that was running outside it.

Four things deliberately do not run, and each is the pause contract rather than
an oversight: `ship.update`, because the hull is halted and `battle.ts` is
steering it; `records.hull.update` and `quests.update`, which stay in the
sailing branch so a deadline cannot expire and a hull cannot wear while the
player is fighting rather than sailing; and `aiBoats.update`, because the other
raiders would otherwise close on a ship that cannot steer, and `aiHulls.update`
would reclaim the very hull the fight has borrowed.

**The two seas.** `battlesea.ts` still owns the sway, the rafts and the fouling,
but a live-world fight is built with `LIVE` — rafts, no crests of its own. A
second set of flat crest meshes drawn across the globe's water would be two seas
disagreeing inside the same twenty metres. The shoves come from the REAL crests
instead: `main.ts` watches `hazards.ts`'s waves and calls `battleSim.shove` when
one crosses a hull, through the identical pulse channel the arena's own crests
used. Amplitude is mapped onto `SWAY_MIN..SWAY_MAX` off the crest's speed rather
than passed through as a world height, because `clampKeel`'s argument is that
one pulse peaks at 6 inside a ring that floors at 8, and a raw amplitude would
invalidate it silently.

**Maelstroms are barred from the ring and crests are not.** `hazards.barMaelstroms`
keeps a funnel from opening inside a circle the player is not allowed to leave —
a duel should be decided by the duel, not by the hull being captured mid-broadside.
A crest is the opposite case and is let through: it shoves, the shove is
survivable, and a front crossing the ring is weather that can be seen coming.

**The quality floor.** The reason fog was excluded from a fight has not gone
away; it has become `main.ts`'s `battleWeather`, which caps `fog` and `rain` at
the readable half of their ranges for the length of a fight. A storm still
darkens the water and rain still falls — it simply may not close the visibility
past the point where the other hull stops being a target. The roadmap states
this as a design rule rather than a nicety.

`battlewave.ts` and `battlescene.ts`'s crest meshes are left standing but
dormant. docs/ROADMAP.md stages their deletion at step 3.

### What the weather does NOT reach

The fishing card and the frozen-overlay branch of the frame loop, where
neither `weatherCells.update` nor `weather.update` is called — the weather
freezes with the rest of the world, exactly as the wind does, so a storm cannot
quietly pass while the player reads a menu.

The battle branch used to be in that list and no longer is: see **The fight
happens in the world** above. A fight is a place in the world now rather than a
place instead of it, so the weather runs through one.

### Dev queries

`?weather=clear|overcast|rain|storm|lightning|fog` pins the envelopes and
switches the squall roll off. `?cell=storm|fog|lightning` forces one cell 60
units dead ahead — further than `?hazard=`'s 25, because the half of a cell
worth photographing is the half seen from outside it. The two combine.
`?debug` publishes the live envelopes — `flash` among them, so a shot of
lightning can wait for a STRIKE instead of for a clock, which it would
otherwise miss almost every time — every cell, and `encounters`, which is the
measurement `CELL_TARGET` was chosen against.

Four more arrived with the harbours, all read through `URLSearchParams` and
never through `import.meta.env.MODE`, for the reason the rest of them are:
`vite preview` serves a genuine production build and these are meant to be
pointed at one.

`?seed=<uint32>` pins the world. It makes exactly ONE attempt and throws if
that seed fails, which is what makes it a pin rather than a suggestion —
`main.ts` catches the throw and falls back to a random world so a player
pasting someone else's bad seed is not left at the splash. Every test and
every screenshot station passes it; two shots of two different planets are
not a comparison.

`?reject=<n>` forces the first n world attempts to fail. It exists because
**no failing seed is known** — 0 rejections in 270 seeds measured — so the
whole recovery path (the retry, the bar's attempt counter, the fall back to
`DEFAULT_SEED`) is otherwise code nothing ever runs.

`?hull=<1..100>` starts with a worn hull. It goes through `Hull.override`,
which is the only reason that method exists: `damage` and `repair` both
notify, and a notify writes the save, so a dev query taking the ordinary road
would permanently scuttle a real player's file.

`?spawn=<lat>,<lon>` starts the ship somewhere else. Two of the 36 harbours
are AT THE POLES and there is otherwise no way to look at either without
sailing 312 units; the name labels fade at 140 units and the nearest harbour
to the spawn is 95. It is also the first thing that ever made the chandlery
reachable in a browser.

## Harbours, the world loop, and the hull

Three systems that arrived together (`docs/HARBOURS_PLAN.md`) and meet at the
save file. Read this before touching `worldgen.ts`, `towns.ts`'s count, or
anything that reads `HullState`.

### One entity, thirty-six of them, and the name is the identity

A settlement, its lights and its berth are one thing now. There is no berth
without a town and no town without a berth, and the lone-outpost scatter that
used to put 440 unmoorable lights on the night side is gone — so a cluster of
lights is always somewhere you can tie up. `HARBOUR_COUNT` is 36 and it is a
**count, not a target**: `createTowns` returning fewer is what `worldgen.ts`
reads as a bad world.

The world is redrawn from a fresh seed on every page load, so a harbour's
POSITION is not durable and cannot be its identity. Its NAME is.
`knownHarbours` and `harbourStock` key on the string, which means renaming an
entry in `HARBOUR_NAMES` reads as a new place — the right failure, since a
rename is a new place. Indices are only how names are dealt out, and nothing
persists one: index 7 is a different island in every world.

Two harbours are placed rather than found. `terrain.ts` raises an islet inside
`POLE_LAND_RAD` of each pole with a moat around it, and `towns.ts` puts
**Marine Stronghold** at the north and **No Man's Land** at the south before
the random search runs — outside the PRNG stream, so the other 34 draw the
same numbers whether or not a pole was founded. Whether a moat actually opens
to the sea is not guaranteed by the terrain; that is what the rejection loop
is for.

### The three traps

**Trap 1 — the expensive half must stay outside the loop.** `globe.ts` is
split into `buildWorldData` (height map, islet cull, flood fill, towns — no
THREE objects) and `buildWorldMeshes` (the land mesh, two million vertices on
the high tier). `worldgen.ts` calls only the first. A rejection loop around
the whole of `createGlobe` would build and throw away a land mesh per bad
seed. Keep it that way.

**Trap 2 — `HITS_TO_LOSE` is the AI's number now.** It used to be one
constant both sides were settled against. The player's threshold varies with
the hull (3, 2 or 1) and lives on `Combatant`; `battle.ts` compares each side
to its own. `main.ts` reads it ONCE at the ram and carries that one reading
through the cover card and into the sim, because the card promises a number in
words and the strip draws that many pips — three separate lookups would be
three chances to disagree with the sim that is actually counting. The hull
cannot move inside a fight, which is what makes freezing it honest.

**Trap 3 — the poles are where `tangentFrame` breaks.** A centre exactly on a
pole has no north. Both polar towns sit `POLE_OFFSET_RAD` off theirs and their
berths further down the same meridian. Nothing here stores a bearing at either
harbour; every direction is a unit vector, as **Frames, and where they stop
working** requires.

### Calibration, measured

All of this comes from `npm run world:measure` over its fixed 50-seed list —
see **Measuring the world** below. Re-run it after any change to the noise
field, and update these numbers in the same commit.

| | |
|---|---|
| Land fraction, 50 seeds | min **0.2221**, mean **0.2672**, max **0.3304** |
| Seed 1337 | **0.2409** |
| `LAND_MIN` / `LAND_MAX` | 0.147 / 0.343 — unchanged, and the max sits 0.013 clear of the observed top |
| Rejected | **2 of 50** (one sealed polar moat, one equatorial bridge) |
| Closest mainland to the equator, accepted worlds | **21.2 u** against a 20 u floor; mean 25.5 u |
| Islands kept inside the strip | **12 across 50 worlds**, largest 64 u² against a 150 u² cap |

That islet figure is the one to watch. At the strip's original fifty units it
was 45 across 50 worlds; at forty it is 12, so roughly three worlds in four now
have an empty strip and seed 1337 is one of them. The islands did not go
anywhere — the corridor they have to fit *entirely* inside got narrower, so
more of them now count as ordinary coast rather than as the strip's. The
feature is still alive, just rarer. If it ever reads as zero across a survey,
`BAND_CEILING` has been tuned into "no land at the equator", which is a
different feature that passes every test in the suite.

`LAND_MIN`/`LAND_MAX` were ±40% of seed 1337's old 0.2449 and are deliberately
**left where they are**: the retune held the population, so the distribution
did not move and the bounds still bracket it. They are no longer ±40% of the
pinned seed, which is fine — they were only ever calibrated *from* it, and what
they have to do is bracket the population.

**The rejection rate is no longer zero, and that is the design working.** Two
failure modes remain that no local edit can prevent, and both are caught rather
than prevented:

- A **sealed polar moat** — whether the moat joins the ocean is a fact about
  the whole world (a continent may simply be sitting on the pole). The polar
  fade bias makes it rare; `polesReachable` catches the rest.
- An **equatorial bridge** — a chain of band specks 4-connected out to a
  coast, putting mainland-connected land inside the strip without any continent
  having crossed the veto. `bandBridges` catches it. Tightening `BAND_CEILING`
  does **not** fix this: at -0.085 the same seed still bridged, and 40% of the
  strip's islands disappeared. Rejection is the cheaper answer.

At 2 in 50 the expected number of attempts is 1.04, and the chance of
exhausting all twelve is nil. If a future terrain change pushes the rate past
about one in three, widen the fade band before raising `WORLD_ATTEMPTS`.

### The equatorial strip

**The mainland coast never comes within 20 units of the equator, in any world,
at any longitude** — 40 units of open ocean the whole way round. The ship spawns
at lat 0 and `waterbodies.ts` floods from exactly there, so the strip is
reachable water by construction and circumnavigation stops being luck.

**Why forty.** The width is set by what has to fit down the corridor. A
maelstrom is 20 units across (`MAELSTROM_RADIUS` = 10), so one sitting on the
equator has to leave room to steer round it without leaving the strip: at 30
units there are 5 units either side, which is three hull beams and not a
passage; at 40 there are 10, which is the tightest that still reads as sailing
round something; at 50 there are 15. It was built at 50 and narrowed to 40
(owner, 2026-09-11), because the strip's cost is not land — `HEIGHT_BIAS` puts
every acre of that back — but a band of the planet with no mainland and
therefore no harbours on it: 50 units is ±7.2° and about 12.5% of the sphere,
40 is ±5.7° and about 10%.

It is built in three places, and the split is the point:

- **`terrain.ts` makes it true.** A veto on the **continental** noise term
  alone, before the three fields are summed, holding it under `BAND_CEILING`
  (-0.07) inside a half-width that wanders on its own noise field between
  `BAND_GUARANTEE_RAD` (0.1 rad = 20 u) and that plus `BAND_WANDER_RAD`
  (0.06 rad = 12 u more). `fbm` is bounded by ±1, so the continental
  contribution inside the guarantee is at most 0.21 *below* `SEA_LEVEL`: a
  bound, not a tendency. Only the speck-scale `shape` and `detail` terms can
  reach the surface there, which is where the strip's islands come from — see
  `BAND_GUARANTEE_RAD`'s own comment for why it vetoes a noise term rather than
  flooring `h` like the spawn clearing does, and why the clamp is monotone
  (`BAND_SQUASH`) rather than flat.
- **`islets.ts` keeps the islands small.** `MAX_BAND_ISLET_AREA` (150 u²) and
  `MAX_BAND_ISLET_SPAN` (0.05 rad = 10 u) are the mirror of `MIN_ISLAND_AREA`.
  Only the span moved when the strip narrowed: area asks "landmark or
  landmass", which is a judgement against the ship and is absolute; span asks
  "can this bridge the strip", which scales with the corridor.
  The span cap is not redundant: area alone does not bound a ribbon, and a
  150 u² ribbon three units wide would cross the whole strip. A landmass counts
  as the strip's only if it lies **entirely** inside the veto's reach — never
  "has a texel inside", which would delete a continent for straying one pixel.
- **`worldgen.ts` throws away what slips through.** `equatorOpen` (water at
  every longitude inside the guarantee) and `bandBridges === 0`. Two gates
  because they are two different failures: a strip can be intruded on without
  being closed.

### Measuring the world

`npm run world:measure` (`tests/fixtures/measure.ts`, its own vitest config, the
same invisibility argument as `golden:update`). Three modes by env var:

| | |
|---|---|
| `WORLD_MODE=baseline` | land fraction per seed, using only the oldest API — so it runs against a `git stash`ed tree and a before/after is a real comparison rather than a number somebody wrote down once |
| `WORLD_MODE=solve TARGET=<mean>` | sweeps a grid of candidate `HEIGHT_BIAS` values and interpolates the one that lands the mean on the target |
| `WORLD_MODE=survey` | whole worlds through `checkWorld`, plus the strip's own numbers |

`SEEDS=<n>` sets the count; the list is drawn from a fixed meta-seed so two runs
are comparable, with `DEFAULT_SEED` always first. About a second a world.

The `solve` mode is fast because heights are **linear in `HEIGHT_BIAS`**:
changing it to `B'` shifts every height uniformly, so `h > SEA_LEVEL` becomes
`h > SEA_LEVEL + BIAS - B'` on a map already built. `cullIslets` takes the sea
level as an argument, so the real cull runs at a displaced waterline and one
build serves every candidate. Exact except for the spawn floor, the polar floor
and islet and the final clamp — none of which is near the waterline.

This tool exists because the figures it replaces were produced by a throwaway
run whose only artefact was the prose quoting it, which left the next person to
touch `HEIGHT_BIAS` with no way to check whether those sentences were still
true. **`WORLD_MODE=baseline` is the mode that must keep working against a
stashed tree** — it imports nothing the strip added, and that is deliberate.

### The hull's clock is a property of where it is called

`hull.update` sits in the **sailing branch** of the frame loop and nowhere
else. The frozen branch (menu, shop, fishing cover, fishing session, battle
card) and the battle branch both return before reaching it, so fishing, a
fight, the shop and the menu cannot wear the hull. That is the whole of the
rule, enforced by position rather than by a flag — there is no mode `hull.ts`
can be left stuck in, and no caller has to remember to switch one off.

`HULL_WEATHER_THRESHOLD` lives in `main.ts` beside the `WeatherState` it
tests, not in `hull.ts`, which is handed a boolean. Half of any ONE envelope
doubles the wear and it never stacks: three multiplying envelopes would put a
ship at 8x in the one condition it already cannot see out of.

Repair is derived, not typed. `HULL_REPAIR_RATE` is `DOCK_NET_RATE * 100`,
because the claim is that the hull and the tank fill at the same speed —
twenty seconds alongside for both — and two independent numbers would let that
stop being true the first time either was retuned. That derivation is why
raising shore power from 2%/s to 5%/s moved the repair rate with it, without
`hull.ts` being edited. Note that `energy.ts`'s `DOCK_RATE` is GROSS (it
carries the hotel load); `DOCK_NET_RATE` is the 5%/s the README actually
claims.

### What running it caught that neither test tier did

`docks.ts` described `sizeAttenuation` as off in two comments and never passed
it. All 36 labels were built, in the scene, visible, at full opacity, with a
texture — and 0.034 **world** units tall, far below a pixel. Nothing threw,
nothing failed to compile, both tiers were green, and the labels had never
once been seen. `docs/TESTING.md`'s rule that no test asserts on appearance is
what makes the owner's eye the only thing that can catch this class of bug;
budget for it.

## Contracts

The first goal the game has had. `docs/QUESTS_PLAN.md` is the brief; this is
what it became. Read it before touching `quests.ts`, `chart.coverage`, or
anything that reads `SaveData.quests`.

One sim, four views. `quests.ts` owns every rule — generation, acceptance, the
per-frame check, completion, failure, the reward — and `questcover.ts`,
`hud.ts`, `menu.ts` and `toast.ts` read it or subscribe to it and decide
nothing. That is the `energy.ts`-to-`hud.ts` split the project already runs on,
and the reason for it here is that a contract's rules are spherical geometry and
clock arithmetic, which are the things that can be wrong without looking wrong.

### The clock is the world's, never the wall's

There is no `Date`, no `performance.now()` and no `setTimeout` in `quests.ts`,
and there must never be one. `main.ts` calls `quests.update` from the SAILING
branch of the frame loop and nowhere else, so a deadline cannot run out while
the menu, the shop, the board, the fishing cover, a session or a fight owns the
screen — and cannot run out with the tab in the background either. That is a
property of where the call sits, exactly as `records.hull.update` is, rather
than a flag the sim could be left stuck in.

The flip side is the mechanic rather than a flaw. A deadline is in ABSOLUTE
world seconds, while the *local* day stretches for a ship running west and
compresses for one running east (**Day, night, and travel**). The clock does not
bend; the daylight does. A player who understands that reaches a daylight window
a player who does not would miss.

### A window is measured at the target, never at the ship

A `DELIVERY` may carry a `DAYLIGHT` or a `NIGHT` window, and it is satisfied by
`solarPhase(target.dir, env.sunDirection).isDay` — the same function the day
dial draws from and the same geometry the water shader crossfades on, so the
card, the dial and the sea cannot develop three opinions about whether it is
night at Ionport.

This is the one thing in the project that could not be copied by a flat-ocean
game, and it works because of a ratio recorded in `daynight.ts`: the terminator
sweeps the ground at 1.05 units a second and the hull makes about ten. A window
cannot be waited out profitably; it has to be sailed to.

`windowReachable` is the delicate part. A window is a repeating interval on the
time axis with period `DAY_LENGTH`, and the function walks those intervals
asking whether any overlaps `[travel, deadline]` by at least `WINDOW_MIN`. The
margin is not decoration — an overlap of one second is a window nobody can steer
into, and offering it would be a lie told in arithmetic. A polar point is
answered rather than guarded: above about 63 degrees the phase is a constant.

### The board is derived, not stored

A harbour's postings are a pure function of `(questSeed, harbour name, world
day)`. Nothing about a posting is written to disk, so reopening the board inside
one world day cannot reshuffle it and the day boundary is what turns it over.
Two consequences worth knowing:

- **Only the seed is saved.** A seed re-drawn per load would reshuffle every
  board on every reload and make the day boundary meaningless.
- **The chart slot is overlaid AFTER the draw**, over slot 0, rather than taking
  a slot before it. Coverage climbs continuously while the ship sails, so a
  chart goal that consumed a slot would shorten the delivery draw the moment a
  target was passed and reshuffle the postings beside it — and a player who had
  decided to come back for the antipode run would find it gone.

### Three traps

**Trap 1 — settlement runs on a frame loop.** `update` is called every frame the
ship is moored, exactly as `knownHarbours.add` is. So a contract is spliced out
of `active` BEFORE its listeners fire, and the listeners are what pay the purse
and write the save. One missing splice is a purse paid sixty times a second.

**Trap 2 — failure must not import a fail state.** Failing or abandoning costs
`REPUTATION_FAIL` and nothing else. No gold is taken, no upgrade is lost, no
other contract is touched, nothing is locked. `docs/ROADMAP.md` asked for
"failure costs gold, never progress" and the owner tightened it to standing,
never gold.

**Trap 3 — coverage is area, not texels.** The chart is an equirectangular grid,
so a row beside a pole covers a thin strip of sphere and a row at the equator a
wide one. `chart.coverage()` weights every row by the cosine of its latitude and
keeps the result as a running total. Counted naively, a 35% contract could be
finished by circling the top of the world, and nothing on screen would look
wrong while it happened.

### What survives a reload, and what does not

The world is redrawn on every load, so the same rule the harbours follow applies
here: a contract's target is a NAME, re-resolved through `Towns.byName` in
whatever world comes up. The bearing and the distance change; the deadline does
not; the HUD line reads `UNCHARTED` for a target this world has not got, and
keeps its clock.

A `CHART` goal is the one kind dropped on load, and `save.ts` drops it rather
than `quests.ts`. The chart lives under its own key and is checked against the
world seed, so the sea a chart goal measured does not exist after a reload — and
a goal that silently restarted from zero reads as a bug rather than as a rule.

### One documented departure from the plan

`docs/QUESTS_PLAN.md` lists the per-frame order as deadlines, then completion.
The code settles COMPLETIONS FIRST. The plan's order decides a contract that
arrives on the same frame its clock runs out against the player, by up to 16 ms
of a several-minute deadline, and the player did get there. The clock is
decremented and clamped at zero before anything else, so the HUD never shows a
negative; the expiry sweep runs last.

### The displacement patch has to be told about a teleport

The patch is the only water that actually displaces, and since the sphere began
cutting its shell away underneath it (commit e829a02, so the funnel could be
seen at all) `uPatchCentre` is two facts at once: where the displaced water is
drawn, and where the hole in the shell is.

`waterpatch.ts` follows the ship by snapping that centre along the tangent
plane in whole grid steps, which keeps the vertices on a fixed world grid so
the displacement does not swim under a moving hull. It is exactly right for a
hull that SAILS -- at most 1.3 units a frame -- and meaningless for one that is
MOVED: the tangent plane is a flat approximation of the sphere, and a chord
walked across a quarter of the planet lands nowhere near the arc.

The maelstrom moves one. `main.ts`'s `onSunk` teleports the hull to
`hazards.pickRespawn()` inside the blackout, and measured, the patch centre
came to rest **628 units** from the ship -- the far side of the world -- and
stayed there. What the player saw on the other side of the fade was a dead flat
sea with no crest in it anywhere, and a hole in the ocean nobody was near.

So a move the patch could not possibly cover re-seeds the centre outright, on
the same branch the first frame takes. The threshold is the patch's own
half-extent, which is the honest definition of "could not cover", and nothing
that sails can reach it: 40 units is four seconds at the hull's top speed and
thirty frames of the loop's own `dt` clamp.

`wake.ts` already had its own answer to the same event (`BREAK_GAP` splits the
ribbon rather than drawing a streak across the planet), and `view.snap` is the
camera's. This was the third thing that needed one and did not have it.

## Salvage and the tow

Two activities off one idea: the sky decides what the sea leaves lying about.
`docs/SALVAGE_PLAN.md` is the brief and the record of what shipped; this is how
the pieces fit.

**Six modules, and the split is the same one every other system here keeps.**
`salvage.ts` and `derelict.ts` are sims — numbers, vectors, one callback between
them, no DOM and no Three — and `salvagerafts.ts` and `derelicthull.ts` are the
scene objects that read them. `salvagebounty.ts` is the pure payout table, on
`bounty.ts`'s terms. `raftmesh.ts` is one pile of timber both seas draw.

### A raft is an encounter, not weather

The roll is `aiboats.ts`'s ten-second cadence rather than `hazards.ts`'s
one-second one, and that is a decision rather than a convenience. A wave is
weather — it is happening to you, five chances a second, and you steer around
it. A raft is a thing you MEET: it sits still, it is found on the scope, and it
has to be gone to. The raiders already model that shape, so salvage borrows
their clock, their spawn band and their fade.

The derelict shares the same clock at a tenth of the odds. Sharing it is
load-bearing: two sims reading the same sky on two different periods is how a
retune of one silently retunes the other.

### The weather terms SUM

    P = min(ceiling, clear + term * (rain > 0.1) + term * (storm > 0.1) + term * (fog > 0.1))

0.5% / +3% / 9.5% for salvage and 0.2% / +1% / 3% for a derelict. The threshold
is not a new number — `main.ts` already calls a cell MET at `> 0.1` for its
encounter counter, and a second opinion about what counts as weather is how two
opinions of the sky begin.

One difference between the two tables is worth knowing before retuning either:
**the salvage ceiling is exactly its own sum and the derelict's is not.**
0.005 + 3 × 0.03 is 0.095, so that `min` never binds and is kept only as a guard
against a fourth term; 0.002 + 3 × 0.01 is 0.032, and the derelict's cap really
does take it back to a round 3%, because 3% is the figure the rate was argued
in.

### What the tow touches, and why it is three files

A tow is one flag on one object, and three modules read it:

- `ship.ts` multiplies `min(propulsion.maxForward, hull.speedCap)` by
  `propulsion.towFactor` — **after** the min, never inside it. Inside, a hull
  worn below 25% (capped at 5 kn) would tow at 5 and feel nothing, which is the
  one state the load should hurt most. `docs/HARBOURS_PLAN.md`'s decision 14 is
  about a worn hull overriding what the player BOUGHT; a dead ship on a rope is
  not a purchase.
- `energy.ts` doubles the whole burn, hotel load included, and never the charge.
- `main.ts` pays for it, takes it away, and puts it on the job strip.

The two rules compose into **1.54x the fuel per unit distance**, and that
figure is the entire reason the speed cut is a quarter rather than a half: the
propulsion draw goes as the square of the speed, so halving the speed quarters
it and the doubling is handed straight back — 1.11x, twice as long at the helm
for a cost the panel never shows. Both numbers are pinned in
`tests/unit/tow.test.ts` against the real `energy.ts`, so the argument survives
a retune that forgets it.

### `Space` is a ladder, and a berth is the top rung

`main.ts`'s keydown handler tests the existing guards, then a berth, then a
derelict's ring. A player standing in both means to moor — and mooring is also
what settles a tow, through `settleTow`, which is called every frame from the
sailing branch rather than off the key press because `Space` is not the only way
to end up made fast to a harbour.

Casting off is deliberately NOT on `Space`: a press that drops the hull you
towed across a hemisphere may not share a key with the most-pressed key on the
helm. It is `T` and `[CAST OFF]`, and the button is hidden outright unless
something is on the line.

### Both sims publish, and neither decides

`salvage.ts` raises `onTake` and knows nothing about gold. `derelict.ts` raises
nothing at all: it exposes `hook`, `release`, `lose` and `settle`, and the
events that drive them — a key press, an empty tank, a maelstrom, a mooring —
all belong to modules that already own them. `lose` and `settle` differ only in
who calls them and what happens next, which is why both are one `detach`.

## The cloud deck
`clouds.ts` is not one sphere but `SHELL_COUNT` concentric ones spanning
`SHELL_DEPTH`, all sampling the same fractal field. The coverage threshold
climbs with altitude (`uDome`) and the noise domain shears (`uShear`), so a
slice is a horizontal cross-section of a 3D cloud rather than a copy of the one
below: flat wide bases, domed tops, real thickness at the limb. Slices draw
inner to outer (`renderOrder`), because concentric meshes all have the same
centroid distance and Three cannot sort them.

`SHELL_COUNT` is derived, not typed. The constant that matters is
`SLICE_SPACING` — the radial gap between slices is what decides whether the
stack reads as cloud or as a stack of plates — so deepening the deck buys more
slices automatically. It is also the layer's price: fragment work over the sky
runs about 8x a single flat shell at the current settings, and halving the
spacing roughly doubles that.

Cloud *height* varies by place, not just coverage: a low-frequency tower field
divides the altitude, so each slice asks how far up its own bank it is rather
than how far up the deck. That sample is taken **after** the two-octave
early-out, against the lowest threshold the tower can produce, which keeps open
sky at two noise samples per slice instead of three.

Two more things follow from the stack and are easy to undo by accident:

- **Per-slice opacity is derived, not chosen.** `SLICE_OPACITY` solves
  `1 - (1 - a)^n = STACK_OPACITY`. Setting it to 1 leaves four invisible slices
  under one opaque one.
- **Everything that could alias fades on `lod`.** A thin translucent shell seen
  edge on breaks into a dotted mesh along its own tessellation, and five shells
  are five times as many chances to see it. The erosion octaves, the coverage
  ramp width and the slice's own silhouette all fade out as `facing` drops.
  This is the same cure `water.ts` uses on the ocean.

## The fog bank
Fog is two effects with a seam between them, and knowing which one is which is
most of what there is to know about it.

`fogglsl.ts`'s `applyAerial` is the FAR half. It blends the surface being
shaded toward a flat grey, which is exactly right for aerial perspective and
exactly wrong for a bank sitting on the water: a surface tint cannot pass in
front of the hull, cannot be denser in one place than the next at the same
distance, and cannot part as you sail through it. For as long as it was the
only fog there was, a bank read as a grey layer laid over the sea rather than
as anything in the air — which is the note `fogbank.ts` was written to answer.

`fogbank.ts` is the NEAR half, and it is real geometry: `quality.fogSlices`
concentric spherical CAPS (not full spheres, the way the cloud deck does it)
spanning `FOG_LAYER_DEPTH` = 11 world units above the water, centred on the
ship's own local up and reaching `FOG_CAP_ARC` = 150 units out. Eleven units
puts the whole hull and its 4.15-unit masthead inside the layer while the
chase camera at ~21 units up stays above the top of it, looking down into a
hole in the fog with a ship in it. At 25 the camera is inside the bank, every
frame is a grey wall, and there is no game left to play.

The seam is `FOG_BANK_ONSET` (70 units). Under about 20 units the aerial term
contributes almost nothing to a bank and the geometry is the whole effect; by
70 it is at full weight and the geometry has faded out at its own cap rim. The
two overlap over the middle third and neither module reads the other. Because
the near field is no longer the aerial term's to protect, `FOG_MAX_BANK` is
**0.92**, not the 0.75 it held while that term was the whole of fog: at
distance a bank is supposed to take the horizon away completely.

### Three times as thick, in each half's own unit

Fog was asked (2026-09-10, owner) to be three times as thick at every
intensity, and the two halves answer that in the only unit each of them has
room in. They are not the same edit and the difference is the whole of it.

The FAR half triples its RATE: `FOG_DENSITY_GAIN` is **10.5**, not 3.5. Not a
ceiling — `FOG_MAX_AMOUNT` (0.15), `FOG_MAX_BANK` (0.92) and `STORM_MAX_GAIN`
(0.08) are untouched, and 0.92 has no 2.76 to go to in any case. What triples
is how fast the haze reaches them, so the sea crosses any given blend at about
a third of the distance it used to and a thin bank that read as a smudge on
the horizon now closes to inside the chase frame. `FOG_BANK_ONSET` is what
makes this survivable: it keeps the bank's share of that term near zero inside
about 20 units, so the near water still belongs to the geometry and its clear
bowl. **Clear-weather haze is not part of this.** `uFogDensity` is the same
`2.0 / GLOBE_RADIUS` it was, and every warning in `fog.ts` and `fogglsl.ts`
about the `uShallow`..`uAbyss` depth ramp is about THAT constant.

The NEAR half has no rate to triple — its density is a coverage threshold and
a stack of alphas already solved against `STACK_OPACITY`, which is the three
per cent of hull a player steers by and the last number that may move. So
`FOG_THICKNESS` = 3 multiplies the STRENGTH the field is evaluated at,
`min(1.0, bank * 3)`, before the threshold, the bow wave, the alpha ramp or
the `PRESENCE_FLOOR` discard reads it. A quarter-strength bank draws what a
three-quarter one used to. The clamp means a bank already at full draws the
whiteout every constant in `fogbank.ts` was tuned against — full fog takes its
extra thickness from the far half instead, which owns the distance and has the
room. Most fog a player meets is under the clamp: a squall's own bank is 0.5
to 1.0 (`FOG_FLOOR`) and a cell ramps from nothing at its skirt.

The cost, and it is the only one: `PRESENCE_FLOOR` now rejects at a third of
the strength it did, so the faintest skirt of a distant cell costs a fractal
where it used to cost one texture fetch. That is what being visible at all
costs.

Four things about it are easy to undo by accident:

- **The group follows the ship; the field does not.** Noise is sampled from
  `normalize(vWorldPos)` — a direction on the globe, not a position in the cap
  — so the density is painted on the world and the ship sails through it. Get
  it backwards and the bank follows the boat, which reads as a bug in the
  camera rather than as weather. `update` therefore only ever writes the
  group's QUATERNION; the caps are concentric with the globe, so following the
  ship is a rotation and nothing else.
- **Fog is bottom-heavy, and that is the one thing separating it from a low
  cloud.** The coverage threshold climbs with altitude (`uTopTaper`), which is
  the same term `clouds.ts` has with the opposite sense. The threshold is also
  DROPPED by the bank's strength, so a strengthening bank fills in its gaps and
  closes over the ship instead of merely thickening where it already was.
- **The ship keeps a bowl of clear air around itself, and its EDGE is the
  chase camera's setback, not a hull measurement.** This is the one number
  here whose obvious value is wrong. Sized against the boat first
  (half-length plus a beam, feathered to ~6.8 units) it looked almost the
  same as no clearing at all, because the chase camera sits `NEAR_HEIGHT`
  (9.5) up and `NEAR_DISTANCE` (21) BACK, which puts it *inside* an 11-unit
  layer: its line of sight to the hull is 23 units of fog travelled almost
  horizontally, and a clearing of radius r only ever touches the last r units
  of that 21-unit horizontal run. Walking the ray, the boat-sized version
  removed 39% of the fog in front of the hull and still left a stretch at
  100% density. `FOG_CLEAR_EDGE` is therefore `NEAR_DISTANCE`, imported from
  `camera.ts` so moving the chase framing moves the clearing; the same
  integral then falls to 1.4 units of full-strength-equivalent fog out of 23,
  peaking at 20%. `tests/unit/fogbank.test.ts` walks that ray and pins both
  numbers against the old version, so shrinking this back toward the boat
  fails rather than merely looking worse. `FOG_CLEAR_CORE` stays a boat
  measurement (two hull lengths) because that is the part the eye reads as
  clear water around the ship; the long feather over the remaining fourteen
  units is what makes it a bowl rather than a circle stamped out of the bank.
  The cost, accepted deliberately: fog no longer rolls across the hull at
  chase framing. A bank that passes over the boat and a boat you can see are
  not both available from a camera sitting inside the fog 21 units away.
  It is a COLUMN about the ship's vertical axis, costs no uniform and cannot
  drift out of sync with the ship: in the cap's object space that axis IS +Y,
  so the vertex shader reads the distance straight off `length(dir.xz)`.
- **The bowl pushes a bow wave ahead of it.** The clearing on its own
  SUBTRACTS — fog inside it simply stops being drawn, which reads, if you look
  for it, as fog deleted rather than fog moved. `FOG_PILE_REACH` (half again
  the clearing's own edge) adds a band of raised density outside the bowl,
  cresting near its rim, so the hole reads as the hull shouldering the bank
  aside. It is not a conservation law and does not pretend to be: the field is
  procedural and there is no quantity of fog to conserve, only the visual
  consequence of one, at the cost of a clamp and a multiply. Two things about
  it are load-bearing. It is applied to the coverage THRESHOLD, not added to
  the density further down, because `best` is an upper bound used for the
  two-octave early-out and a term added after it would discard pixels that
  should have become fog and punch holes in the wall — a bug nothing in the
  Node tier could see, since none of it compiles GLSL. And it is scaled by the
  bank, so thin fog grows no ring: the wave is a consequence of there being
  fog to push.
- **Per-slice opacity is derived, not chosen**, exactly as the deck's is:
  `sliceOpacity(n)` solves `1 - (1 - a)^n = STACK_OPACITY`, so nine slices are
  as DENSE as fourteen and what a lower tier loses is smoothness in the
  gradient. `STACK_OPACITY` is **0.97** rather than 1.0 on purpose — a bank has
  to block the ship partially, not delete it, and the three per cent that
  survives the thickest core is the silhouette you steer by.
- **Two early-outs pay for the whole thing, and both are load-bearing.**
  `fogInRange` turns the group off on the CPU when no fog cell is within
  `FOG_WAKE_RANGE` of the ship and there is no squall, so clear weather is zero
  draw calls rather than a dozen cheap ones; it reads `cells.live`
  analytically, never the map, for the reason in **The three traps**. And the
  fragment shader samples the weather map FIRST and discards where there is no
  bank, before it touches a single octave, so open sea inside the cap costs one
  texture fetch.

Unlike the cloud deck it can be faded off neither near the camera (the player
is INSIDE it) nor at the limb in the way the aerial term is, so it is the one
weather effect a machine feels immediately. It is also deliberately NOT on
`LAYER_REFLECTED`: the reflection cube gathers things far enough away to be a
constant over the patch of water reflecting them, and a bank is metres away.

## Frame loop
```
energy.update(dt, shipState, env, ..., weather.state)   // burn / solar / dock, on last frame's speed and last frame's sky
hull.update(dt, energy.mode === 'docked', weathered)    // straight after the plant: a second reserve, on this frame's docked verdict. THIS BRANCH ONLY -- that is the whole of "the hull does not wear in a fight, a session, the shop or the menu"
known.add(towns.dockAt(ship.position).town.name)        // while docked. Idempotent; the frame loop is the caller
course.set(null)                                        // on the frame the ship comes alongside its own destination, not every frame it sits there
weatherCells.update(dt, shipState, energyState)         // BEFORE the wind: a storm cell floors the wind, so the wind needs this frame's sample
wind.update(dt, shipState, energyState, cells.stormAtShip)  // needs this frame's docked verdict
weather.update(dt, wind.state, cells.state)             // after the wind (this frame's phase), before the hazards (this frame's odds)
hazards.update(dt, shipState, energyState, wind.state, stormOdds) // rolls, transport, contact, push, spiral; writes HazardState
aiBoats.update(dt, shipState, energyState, hazards.state, suppressed(), stormOdds)  // after hazards: needs this frame's phase. Before the ship: a contact halts the hull this frame
ship.update(dt, input, energyState, windState, globe.waveOffsets, hazards.state)  // thrust cut to LIMP_SPEED (1 kn) when energy.canThrust is false; waveOffsets is the CPU twin of the sea the patch draws; hazards.state is the push it spends and the drive it obeys
camera.update(dt, shipState, input)
shipBeam.update(dt, shipState, view.zoom, view.camera, innerHeight)  // after the camera: it fades on this frame's zoom
courseLine.update(shipState, courseTarget(), view.camera, innerHeight)  // re-lays the arc only once the hull has moved a unit
aiHulls.update(dt, aiBoats.state)          // places and lights the clones; nothing reads them until the render
shadowField.update(dt, leviathan.state)    // the hunt's body, sprite tier; hides itself entirely when quality.huntShadows is 'shader'
huntReticle.update(dt, leviathan.state, shipState)  // beside the shadows: both only PLACE things, and the camera has already moved
huntFx.update(dt, leviathan.state, shipState)       // the throw's pools, aged on dt
huntTells.update(dt, leviathan.state, 1 - env.dayFactor)  // birds and spouts
huntDial.update(leviathan.state)           // a HUD element, kept here so the hunt reads as one block
huntPointer.update(leviathan.state, view.camera, shipState)  // after the dial: these three project through the camera view.update settled
huntNumbers.update(dt)
screenFx.update(dt, leviathan.state)
huntAudio.update(dt, leviathan.state)      // the armed tick, driven by STATE so a missed cue cannot leave it running
globe.update(dt, env, wind.state, weather.state, cells.state, shipState, camera)  // daynight (places sun AND moon, writes env; the weather reaches the LIGHTS here and never env), fog, the weather map's own bake, then water (reads wind + its plugins), the displacement patch, land, citylights, clouds, the fog bank (needs `ship` for the cap it follows and `cells` for whether it is drawn at all), sky (dome + shell + stars), celestial (the two discs, last: it only draws what env already says)
rain.update(dt, shipState, wind.state, weather.state, view.camera)  // after globe: the box hangs on the hull the camera has just been framed against, and is SIZED off that camera
lightning.update(dt, shipState, weather.state)  // alongside the rain, for the same reason; rebuilds its geometry only when flashSeed changes
reflection.update(dt, shipState.position, renderer, scene)  // this frame's share of reflection-cube faces; must land before postFx.render
docks.update(dt, env, shipState, energyState, view.camera)  // the camera is what the harbour labels fade against; omit it and NONE is ever drawn, because they ship `visible = false`. Also eases each berth's charted level toward `known`
wake.update(dt, shipState, env, renderer)  // fills the wake map render target last, after every rib/spray value this frame is final
hud.update(shipState, energyState, windState, weather.state)
radar.update(dt, shipState, windState, hazards.state, aiBoats.state, weather.state, cells.state, chart)
postFx.render(dt, scene, camera)
controls.endFrame()
```

`hull.update`'s position in that list is load-bearing and not a matter of
taste. It is in the sailing branch and in neither of the two below, so the
frozen branch (menu, shop, fishing cover, fishing session, battle card) and
the battle branch simply never reach it. Decision 12 of
`docs/HARBOURS_PLAN.md` is therefore enforced by WHERE the call sits, not by
a flag inside `hull.ts` — which means there is no mode the sim can be left
stuck in and no caller that has to remember to switch one off. Moving this
line into a shared helper would quietly undo that.

`suppressed()` is `main.ts`'s own one-line verdict, `energy.mode === 'docked'
|| blackout.active || hazards.state.phase !== 'free'`, and it is computed
there rather than inside `aiboats.ts` because all three of its terms are owned
by other modules. Overlays are not in it and do not need to be: the loop does
not reach `aiBoats.update` under one at all.

While a battle is up the loop takes a THIRD branch, tested **before** the
overlay branch below:

```
energy.update(dt, restingShip, env)        // the plant keeps running, on a resting hull
weatherCells.update(dt, shipState, energyState)   // THE CLOCK. Same four calls, same order, as the sailing
wind.update(dt, shipState, energyState, cells.stormAtShip)   //   branch: cells before wind, wind before weather,
weather.update(dt, wind.state, cells.state)                  //   weather before hazards. A squall can arrive mid-duel
hazards.update(dt, shipState, energyState, wind.state, stormOdds)  // maelstroms barred near the ring; crests are not
shipBeam.object.visible = courseLine.object.visible = false   // the arena camera is close on the hull; the sailing branch stands both back up
battleSim.update(dt, battleUi.input(controls.input))   // only while inArena: the fire edge plus W/S
crestShoves(playerHull) / crestShoves(aiHull)      // a real crest crossing a hull shoves it, through battlesea's own pulse
settleOutcome(...)                         // once, the frame `outcome` first becomes non-null
battleScene.update(dt, battleSim.state)
battleUi.update(battleSim.state)
hud.update(shipState, energyState, windState)
globe.update(dt, env, wind.state, battleWeather(weather.state), cells.state, shipState, battleScene.camera)  // advances env: the sun moves. Weather is FOG/RAIN-CAPPED here -- the fight's quality floor
rain.update(...) / lightning.update(...) / reflection.update(...) / docks.update(...)
wake.update(dt, shipState, env, renderer)  // not optional: the water SAMPLES the wake map, and a branch that skips this freezes a foam streak onto the sea
timeDial.update(shipState, env)
postFx.render(dt, scene, inArena ? battleScene.camera : view.camera)   // ONE scene. The fight is in the world
controls.endFrame()
```

It is tested first because it is the more specific state. It no longer renders
a different scene — that is the whole of docs/ROADMAP.md's step 1, and see
**The fight happens in the world**. What it renders is the world, through the
fight's own camera, LIVE rather than at dt 0.

Four things deliberately do NOT appear above, and each is the pause contract
rather than an oversight: `ship.update` (the hull is halted and `battle.ts` is
steering it), `hull.update` and `quests.update` (sailing branch only, so a
deadline cannot expire and a hull cannot wear while the player is fighting),
and `aiBoats.update`/`aiHulls.update` (the other raiders would close on a ship
that cannot steer, and `aiHulls` would reclaim the hull this fight borrowed).

A fight and a card can never be up together anyway: a contact halts the ship
and freezes the world synchronously, and no contact can happen under an
overlay because the sim does not run there. See **AI boats and the battle**.

What a contact freezes the world WITH is `battleCover.isOpen`, not
`battleUi.isOpen`. A ram raises the cover card and the fight itself is opened
three seconds later, so for those three seconds the loop is on the FROZEN
branch and the battle branch has not been reached yet. See **The beat before a
fight**.

While a fishing overlay is up the loop takes a different branch and stops after
five calls:

```
energy.update(dt, restingShip, env)   // restingShip = { ...ship.state, speed: 0 }
fishing.update(dt)                    // only while the card itself is open
fishCover.update()                    // re-reads the plant, so START FISHING can come alive
battleCover.update()                  // NO dt: the count into a fight is wall-clock
hud.update(shipState, energyState, windState)
postFx.render(0, scene, camera)       // zero dt: freeze the frame, survive a resize
controls.endFrame()                   // zoomDelta must not accumulate under the card
```

Everything else — wind, hazards, ship, camera, globe, reflection, docks, wake,
radar — is skipped. See **Fishing** for why each of those five is in the list
and what happens to the world while it runs. Hazards being skipped means they
are frozen with the rest of the world, uniforms and all; the `[FISH]` and
`[SHOP]` buttons carry an extra `hazards.state.phase !== 'free'` guard so no
overlay can be opened over a hull that is being carried into a funnel.

Power runs **before** the ship, so it charges for a frame of travel the ship has
already made rather than one it might not be able to afford. `globe.update` is
what writes `env`, so the sun the solar panels see is one frame old too — 16 ms
of a 10-minute day.

`globe.update` takes `shipState` and `camera` because two of the water's
plugins follow the ship: a wake map and a reflection cube, neither of which is
available from `env` or `wind`. `globe.ts` forwards both straight through to
`water.update`, which hands them to every plugin's own `update`; the sphere's
own shading ignores them. `globe.update` also calls `fog.ts`'s `updateFog(env)`
first, right after `dayNight.update`, so water and land sample this frame's
fog colours rather than last frame's — see **Shader notes** for the plugin and
fog contracts. `createGlobe` itself also takes `quality` (read by the
displacement patch and forwarded to the plugins `main.ts` built) and the list
of water plugins, built and passed in from `main.ts` rather than from inside
`globe.ts` — see **The wave field** for why a plugin has to exist before
`createGlobe` runs at all.

`reflection.update` and the wake map's own fill (inside `wake.update`) both
have to land before `postFx.render` draws the visible frame, and for the same
reason: each renders into its own off-screen target — a cube, a small
top-down RGBA8 map — that the water shader samples during that very draw. Run
either after `postFx.render` and the *next* frame shows this frame's
reflection and wake, one frame stale. Worse, both `reflection.ts` and
`wakemap.ts` render by temporarily rebinding the renderer's active target;
skip restoring it and the very next thing drawn — the whole visible game —
renders into that off-screen target instead of the canvas, and the player
sees black. `wake.update` fills its map *last* within itself, after `now` and
every rib/spray value for the frame are final, rather than from an
`onBeforeRender` callback, so the fill happens at one predictable point in the
loop instead of at a moment tied to when Three happens to draw the ribbon.

`stormOdds` is `main.ts`'s own one-line number, `1 + STORM_ODDS_GAIN * weather.state.storm`, computed there for the same reason `suppressed()` is: two sims must not develop two opinions of one sky. What it buys differs sharply between them and "tripled" is only half true — see **Weather**.

Wind and hazards are wedged **between** the two, and the order is load bearing
in both directions. It runs after energy because a berth is shelter and `energy.ts`
owns the only definition of docked, so the wind has to see this frame's verdict
rather than last frame's. It runs before the ship because the ship spends the
push the same frame it is written. Energy therefore still bills last frame's
speed, exactly as it did before. `hazards.update` sits immediately after it for
both of the same reasons — a berth is shelter from rough water too, and the
hull spends the hazard push and obeys the hazard drive this same frame — and
the water plugin reads that state later, inside `globe.update`, so the sea on
the GPU and the sea the hull just climbed are one frame's numbers.

Energy-before-ship earns its place a third time now that a berth takes the
helm. `ship.ts` reads `energy.mode === 'docked'` to decide whether the hull is
made fast, so running the plant first means the freeze lands on the frame the
lock is set rather than the one after it — a made-fast ship that answered the
helm for one more frame would visibly creep off its berth.

## TypeScript constraints (tsconfig)
- `verbatimModuleSyntax`: use `import type { X }` for type-only imports.
- `erasableSyntaxOnly`: no `enum`, no constructor parameter properties, no namespaces.
- `noUnusedLocals` / `noUnusedParameters` are errors. Prefix intentionally unused
  parameters with `_`.

## Shader notes
- Three r182 on WebGL2. `ShaderMaterial` still accepts legacy GLSL:
  `varying`, `gl_FragColor`. Keep to that style for consistency with `sky.ts`.
- Build GLSL as a joined array of lines (see `sky.ts` / `water.ts`) rather than a
  template literal.
- Do not add `uniform`s that Three already injects (`modelMatrix`, `viewMatrix`,
  `projectionMatrix`, `normalMatrix`, `cameraPosition`) — redeclaring them fails
  to compile.

### The water plugin contract

`water.ts` no longer holds the whole fragment shader inline. The chunks live in
`waterglsl.ts` as named exports (`WATER_UNIFORMS`, `waterWavefield`,
`waterDepth`, `WATER_LIGHTING_HEAD`/`_TAIL`, `waterFoam`/`WATER_FOAM_TAIL`,
`WATER_OUTPUT` — see that file's top-of-file comment for the exact assembly
order), and `noiseglsl.ts` holds the inlined Ashima/Gustavson simplex noise
(`NOISE_GLSL`) so `land.ts` can share the same function instead of a second
copy drifting out of sync.

`createWater(terrain, heightMap, waterBodies, plugins?: WaterPlugin[])` takes
an optional list of plugins, each shaped:

```ts
export interface WaterPlugin {
  name: string;
  uniforms: Record<string, THREE.IUniform>;
  /** GLSL pasted before main(): uniforms, samplers, helper functions. */
  declarations: string;
  /** Each hook is a GLSL statement block, or omitted. See the slots. */
  hooks: Partial<Record<WaterHook, string>>;
  update?(dt: number, env: WorldEnv, ship: ShipState, camera: THREE.Camera): void;
}
export type WaterHook = 'slope' | 'normal' | 'foam' | 'reflection' | 'colour';
```

Five hook slots, in shader order, with the GLSL variables in scope at each
(also documented in `waterglsl.ts` above the chunk that contains the seam):

| Hook | Where | May modify | Also in scope |
|---|---|---|---|
| `slope` | after the tangent basis, **before** the LOD and before `N` exists | `steep`, `steepN`, `crestLift`, `tiltBoost` | `n`, `viewDir`, `camDist`, `sunDir`, `tanU`, `tanV`, `inland`, `motion`, `lakeTime`, `vWorldPos` |
| `normal` | after `N` is built, before lighting | `N` (unit) | `n`, `vWorldPos`, `camDist`, `w0`, `motion`, `lakeTime`, `lod`, `nearMid`, `tanU`, `tanV`, `wu`, `wv`, `tilt`, and the four seam locals |
| `reflection` | right after `skyCol` is computed | `skyCol` | everything `normal` could read, plus `ndv`, `fres`, `refl`, `skyUp`, `lightAmt` |
| `foam` | inside the foam section, before `foamLit`/the mix into `col`; **also runs when `fd >= 2.6`** | `foam` (0–1 mask) | `fd`, `depth`, `inland`, `col`, everything above |
| `colour` | after all lighting and foam, before `applyAerial` and the sRGB encode | `col` | everything above |

The `foam` hook is the one slot that fires on every pixel, not just near a
shore: `fd` and `foam` are declared unconditionally, the coastal shoreline
computation that raises `foam` above zero still only runs `if (fd < 2.6)`, and
the hook runs after that `if` closes but before `foam` is lit and mixed into
`col`. That is what lets a plugin's own foam (a ship's wake, out in open water)
appear far from any coastline.

**`slope` is the odd one**, and worth reading before using it. The other four
each modify one value. This one runs before the LOD and changes how the core
shader treats the pixel for the whole rest of `main()`, because four separate
places in the lighting ask the smooth *sphere* normal `n` whether this is open
sea — the grazing LOD, `lightAmt`, the diffuse blend factor and the sun-road
gate — and every one of them is wrong for a plugin that has put a wall of
water on the sphere. A face tilted 64° off `n` was being lit as though tilted
29°, faded as though it were a grazing pixel, and held at 8% of its specular
however exactly it pointed at the sun. Raising `steep` (with `steepN` set to
the plugin's own normal) hands those four gates back to the surface that is
actually there; `crestLift` adds thickness for the backscatter term to shine
through, outside the `uWaveIntensity` factor so a rogue wave still glows in a
calm; `tiltBoost` scales the chop for water being torn apart rather than
merely lifted. All four are no-ops at their defaults (`0`, `n`, `0`, `1`), and
every gate is written so that `steep = 0` is arithmetically the expression that
was there before the seam existed.

Uniform names are prefixed per plugin (`uWake…`, `uRefl…`, …) so two plugins
sharing one shader can never collide.

**The wake map's channel layout**, since `waterwake.ts` is the plugin that
reads it: `wakemap.ts` renders into its own RGBA8 render target, cleared to
`(0, 0.5, 0, 0)` — R is foam density (0–1), G is a signed surface-height
offset packed as `0.5 + h * WAKE_HEIGHT_SCALE` (0.9), B is foam age (0–1, 0 =
just laid near the ship, 1 = about to dissolve), A is unused. This is data,
not colour: the target's `colorSpace` is `THREE.NoColorSpace`, nothing
sRGB-encodes it going in and `waterwake.ts` does not decode it coming out.
Its `normal` hook tilts `N` by a two-tap gradient of the height channel, its
`foam` hook floors the shader's own foam mask under the map's foam channel
(scaled by the same world-keyed `wakeBreakup` noise `wakemap.ts` paints with
— pasted into both shaders verbatim so the two can never disagree about what
"breakup" means), and its `colour` hook fades a cyan tint in near the stern
as foam age approaches zero.

**`WATER_DISPLACED`** is the `#define` `waterpatch.ts`'s material sets
(`defines: { WATER_DISPLACED: 1 }`) on the fragment shader it clones byte for
byte from the sphere. As things stand, no chunk in `waterglsl.ts` branches on
it: the patch's normal is reconstructed by the same finite-difference
tangent-plane code the sphere runs, sampled around the patch's own `vDir`
(`normalize(displaced)`, not quite radial at the patch's edges). The define
compiles and does nothing yet — it is the seam the vertex-side displacement
was built against (`water.ts`'s own vertex shader carries a matching, equally
empty `#ifdef WATER_DISPLACED` block), not a live branch.

`fogglsl.ts` is the aerial-perspective **contract**: `applyAerial(col,
worldPos, camPos, sunDir, dayFactor)` is called from the water's `colour`
position (after any plugin `colour` hooks, before the sRGB encode) and from
the land shader's `<opaque_fragment>` injection. Its body blends `col` toward
the atmosphere's own colour as distance grows, thickened at grazing angles
(more air looking along the horizon than straight down) and weakened with the
camera's own altitude above the local surface, capped at `FOG_MAX_AMOUNT`
(0.15) so the exponential never washes the water's deep-colour ramp into a
flat pale sheet. A weather BANK raises that ceiling toward `FOG_MAX_BANK`
(0.92) and thickens the density, but only with distance: the bank's share of
every weather term is multiplied by `smoothstep(0.0, FOG_BANK_ONSET, dist)`,
so the near field belongs to `fogbank.ts`'s geometry and this term is the far
half of fog. The ramp is a factor ON the bank rather than a change to it, so
`wx.y = 0` is still exactly zero at every distance and the battle arena, which
passes `vec2(0.0)`, is untouched. The three uniforms it reads (`uFogColorDay`, `uFogColorNight`,
`uFogDensity`) are owned by `fog.ts`, which exposes them as one shared
`fogUniforms` object — merged into every caller's material uniforms, so there
is exactly one writer — and `updateFog(env)`, called from `globe.update`
before water and land. `uFogDensity` is `2.0 / GLOBE_RADIUS` (world-scale):
an earlier `0.8 / GLOBE_RADIUS` was tried and was too strong once combined
with the grazing-angle term and no ceiling — `fog.ts`'s own comment has the
arithmetic.

## Post-processing and colour management
The frame goes through an `EffectComposer` in `postfx.ts`: render → bloom →
raw copy to the canvas. Two rules fell out of a bug that only reproduced on
real GPUs, never under headless software rendering:

- **Never set `isXRRenderTarget` on a composer target.** It is not a
  colour-space switch. When the GPU exposes
  `WEBGL_multisampled_render_to_texture` it routes multisampled targets through
  the WebXR render-to-texture path, which skips the explicit MSAA resolve the
  composer's ping-pong buffers depend on. Result on hardware: a mostly black,
  unresolved frame and colour flicker between frames.
- **Composer targets are RGBA8 with standard MSAA**, not the composer's default
  half float. Multisampled half-float targets are not renderable on every GPU;
  RGBA8 MSAA is core WebGL2. Over-range highlights therefore clamp to 1.0, and
  the bloom knee is sized for that.

Stock materials (`MeshStandardMaterial`, `PointsMaterial`, `LineBasicMaterial`)
would lose their sRGB encode inside a linear render target. `postfx.ts` patches
every non-`ShaderMaterial` in the scene, once, to encode with Three's own
`sRGBTransferOETF` regardless of which buffer is bound. Hand-written
`ShaderMaterial`s are left alone: they write raw and were tuned that way. Net
effect is pixel-equivalent to a direct render, with bloom as the only
difference. A stock material added after the first frame is not patched by the
scene walk — add it before the first `postFx.render`, or hand its subtree to
`postFx.adopt(root)`, which is what `main.ts` does when the ship's glTF hull
finishes loading.

The self-encode patch used to `throw` the moment a material already carried
an `onBeforeCompile` hook. It now **chains**: `land.ts` needs to add its own
hook to the same `MeshStandardMaterial` this patch already targets (per-pixel
slope, curvature, AO and horizon shadow — see the module ownership table), so
the prior hook runs first, unchanged, and this patch's encode replacement
runs after it. That is what makes `land.ts`'s `onBeforeCompile` legal at all.

**The trap**: `customProgramCacheKey` has to stay unique per *combination* of
hooks, not merely per patch. Three's own default cache key is
`onBeforeCompile.toString()`, so `postfx.ts` captures it — before overwriting
`onBeforeCompile` — and appends its own key onto it, rather than replacing it
outright. Skip that capture, or read it after the swap, and every
differently-hooked material collapses onto the same cache key regardless of
what its shader actually contains. Two materials then share one compiled
program, and one of them silently renders with the other's code: a bug that
shows up as one material looking like a different one, not as a compile
error or a console warning.

## Quality tiers and the dev timing overlay
`quality.ts` resolves one `QualityTier` — `'low' | 'medium' | 'high'` — once,
at the top of `main.ts`, before anything below reads a row of its table:
`?quality=` on the URL beats a stored `localStorage['pirate-world/quality']`
choice beats the default of `'high'`. The result is frozen, so nothing built
afterwards can drift its own copy out of step with the table it was read
from.

Every field is a pipeline/wiring number, not a world- or ship-scale one: a
pixel-ratio ceiling, a bloom working-width cap, three render-target/vertex
counts (`wakeMapSize`, `patchSegments`, `reflectionSize`, `landDetail` --
icosphere subdivisions per 100 units of `GLOBE_RADIUS`, so the land triangle
keeps its world size as the globe is retuned: 64/80/96, giving 133k/204k/289k
drawn triangles after the coastal cull), a blend weight
(`landFacetBlend`, how far land's per-pixel normal replaces its flat facet
normal -- the one row that costs nothing to move at runtime, since it reaches
the shader as a uniform rather than a baked constant), a face count
(`reflectionFacesPerFrame`), a slice count (`fogSlices`, how many caps
`fogbank.ts` stacks its bank out of), and whether the water shader's
fragment-side chop octave runs at all (`waveChop`).

**`fogSlices: 0`** (the `low` tier) is the same ABSENT-not-idle convention as
`reflectionSize` and `rainDrops`: `globe.ts` builds no fog-bank module at all
there and fog is the aerial haze alone, which is what fog was everywhere
before `fogbank.ts` existed. Above zero the per-slice alpha is solved from the
count (see **The fog bank**), so a `medium` machine gets fog that is exactly as
THICK as a `high` one and only less smooth in the gradient. It is the row a
machine feels soonest when the weather turns: the layer is almost pure fill
rate and, unlike the cloud deck, it cannot be faded off near the camera,
because the player is inside it. **`reflectionSize: 0`** (the `low`
tier) means the reflection cube is **absent, not idle**: `reflection.ts`
allocates no render target at all, its `texture` is `null`, and `main.ts`
never builds `waterreflect.ts`'s plugin — so the water shader compiles with
one texture sampler fewer rather than sampling a black cube every frame.

The performance budget these tiers exist to protect drops features in a
fixed order when a frame runs over it: reflection size, wake map size, patch
segments, chop octave, pixel ratio cap. The owner moves a machine to a lower
tier rather than cutting one feature by hand.

`?quality=` or `?debug` on the URL also publishes
`window.__pirateWorld = { quality }`, which is how the smoke tests (and any
other query-driven check) confirm which tier actually loaded. An ordinary
player's session sets neither parameter, so the hook never exists for them —
`import.meta.env.MODE !== 'production'` would be the wrong guard here, since
`vite preview` serves a genuine production build and the smoke test's
`?quality=low` pass needs the hook under exactly that build.

A rolling GPU ms / CPU ms / draw-call readout lives at the foot of the
telemetry panel, fed by `postfx.ts`'s `EXT_disjoint_timer_query_webgl2`
wrapper around the composer's render call. It is off by default — a disjoint
timer query carries a real GPU cost — and toggled with **Backquote**:
`main.ts`'s keydown listener flips both `postFx.setTimingEnabled` and
`hud.setDevTimingVisible` together. When the extension is unavailable, or
while the timer is off, the row prints `n/a` rather than a guessed number.

## Day, night, and travel
`daynight.ts` places the sun in world space from elapsed time alone, and every
shader decides day or night from `dot(surface normal, sunDirection)` at the
point being drawn. Local time is therefore a property of *where the ship is*,
never of a clock it carries, and cross-timezone travel falls out for free: sail
east into the sunrise and dawn arrives sooner, sail west and you hold the
sunset. Nothing models this; deleting it would take work.

The numbers are worth knowing before retuning `DAY_LENGTH`, which is now
**1200 s for one full turn of the sun**. That is not ten minutes of day and ten
of night: the day is measured from the drawn horizon rather than from eye level
(see **Where the day starts** below), so at the equator the sun's disc is
visible for about 13 of those 20 minutes. The
terminator sweeps the ground at `2*PI*GLOBE_RADIUS / DAY_LENGTH` — 1.05 world
units a second — while the ship does 10. About ten to one, still the reverse of
Earth, where the ground beats a ship roughly forty to one, but no longer the
sixty to one it was: the day went from an hour to twenty minutes and the hull
from 15 kn to 10 in the same pass. So at anchor the cycle is the twenty minutes
`DAY_LENGTH` says, and under way it is not: full ahead east compresses it to
about two minutes, and full ahead west stretches it a long way without quite
stopping the sun the way it used to. Only a shorter day, a slower ship or a
larger `GLOBE_RADIUS` moves that ratio — the last because it slows the ship in
degrees without slowing the sun.

### Where the day starts, and where the horizon is
The horizon is **not eye level**, and on a globe this small the difference runs
the whole day. At the chase camera's opening framing the drawn limb sits **25°
below horizontal** (`horizon.ts`), so a sun at elevation zero — the angle every
sunrise equation in the world is written against — is already a quarter of the
sky clear of the water and has been for a third of the morning.

That gap used to be nobody's business, and it showed. The sun's disc hung
plainly over the sea while every shader lit the world as midnight, and the dial
said 04:00. `horizon.ts` now names the gap once: `limbSin(cameraRadius)` is the
same `-sqrt(1 - R²/d²)` the sky dome recomputes per pixel, and
`SUN_APPEARS_SIN` is that minus the sun's own disc radius — the elevation the
centre stands at as the top edge touches the sea. **One threshold serves both
ends of the day**, because the top edge is the last part to go under as well as
the first to come up, so daybreak and nightfall cannot drift apart.

The horizon really does drop further as the camera climbs, and both CPU-side
consumers pin themselves to the opening framing anyway, for different reasons:

- **`solartime.ts`**, because the phase of the day must not move when the
  player zooms — otherwise pulling the wheel back would set the sun on the dial
  without moving it in the sky.
- **`daynight.ts`**, because `env.dayFactor` reaches the water, the land and
  the fog as a single global scalar. Tracking the live camera there would
  brighten the whole sea as a player zoomed out at dusk, which is a worse lie
  than a fixed offset and a far more visible one.

`sky.ts` is the one that does follow it, per pixel, because the dome is the
surface actually being drawn against the horizon.

The world opens on **daybreak** at the spawn: the first frame is the moment the
disc touches the water. The ship spawns on heading 090, so that puts a rising
sun dead ahead — at the noon this used to open on, the sun was overhead and
behind the chase camera. `START_ELAPSED` is **solved**, not written down, and
solved as a fixed point rather than inverted, because the moment of daybreak
depends on the sun's declination and the declination depends on the elapsed
seconds being solved for. With `AXIAL_TILT` at zero the second dependency
vanishes and the first pass is exact; restore the tilt and the solve still
lands, where a closed-form inversion would quietly sit minutes off.

`MOON_PHASE_OFFSET` is tuned against this opening and has been retuned every
time it moved. A noon opening can only manage a thin crescent low in the east,
because at noon anything far enough from the sun to be well lit is also below
the horizon. A daybreak opening frees the whole western sky, so the moon opens
nearly opposite the sun — a bright gibbous setting astern as the sun rises
ahead.

### The day, the night, and the dial
`solartime.ts` reports a **phase and a progress**, not an hour. There used to be
an `HH:MM` readout and it could not be made honest: pinning 06:00 to the sun a
player can actually see would have meant squeezing about 15.6 hours of visible
sun into 12 clock hours, so a daylight hour would have run nearly twice as long
as a night one. The hour was the part that had to go. What a player wants off
that dial is not the time; it is how much light is left.

So the day runs from the disc appearing to the disc vanishing, the night runs
from one to the other, and `progress` runs 0 → 1 across whichever one the ship
is in. Both phases change length with latitude, and normalising that away is
the whole point. The consequences, all falling out of the threshold rather than
being arranged:

- The day is **longer than the night**, about 65% of the turn at the equator,
  because the sea is below eye level. The dial's lit arc is honestly that size.
- Above about **63° of latitude the sun never sets at all**. With the tilt at
  zero that is permanent, so the dial says `NO SUNSET` rather than showing a
  percentage of a phase that has no ends.
- A **night that never breaks** is now unreachable in play: it needs the sun
  more than 116.7° from the zenith all day and this globe tops out at 113.5°.
  The branch stays, and is still pinned by a test, because restoring the tilt
  brings it back.

### Why the sun does not lean
`AXIAL_TILT` is **0**, and the season machinery is left standing around it. The
tilt bought variety: a terminator at an angle, a sunrise that was not always
due east, a day whose length moved through the year. What it cost was that no
two days at a latitude were alike — and at `SEASON_DAYS = 6`, a year inside six
game days, they were nowhere near alike. At latitude 40 the visible day ran
16.8 hours one day and 21.3 the next. A player cannot learn a sky that changes
that fast, and with the dial now measuring progress rather than naming an hour,
a learnable day is worth more than a varied one.

Raising `AXIAL_TILT` back toward 0.41 undoes it; everything downstream is
written in the general form and follows without further edits, including
`solartime.ts`'s day-length solve, which uses the full
`cos H = (sin h₀ − sin φ sin δ) / (cos φ cos δ)` rather than the textbook
`−tan φ tan δ` — that shortcut is the same equation with the horizon at zero,
and zero is the one elevation the horizon is not. Raise `SEASON_DAYS` alongside
it, or the days will not resemble each other.

### The moon
The moon is placed the same way and on its own period, not opposite the sun. It
circles slightly slower than the sun does (`MOON_DAY_LENGTH`, derived so the sun
gains exactly one lap per `MOON_MONTH_DAYS`), which is the whole mechanism: it
rises later each night, it is sometimes up in daylight and sometimes gone by
dark, and its phase is `(1 - dot(sunDirection, moonDirection)) / 2` — so a full
moon is one that rises as the sun sets, by construction rather than by
arrangement. The fill light follows that number, so a new moon, or a moon below
the horizon, leaves the night hemisphere on the hemisphere light and the ambient
floor alone. Nights are no longer interchangeable.

The moon carries a **halo**, drawn with the same billboard as the sun's disc and
separated from it by one uniform. `uCoreGain` is what makes the sun a hard disc
inside a wide falloff; the moon sets it to **zero**, which drops the core term
entirely and leaves only the falloff. That is not a saving, it is the
requirement: the moon already draws its own body as a lit sphere, and a second
bright disc behind that sphere would fill in the dark half and destroy the
phase. A crescent has to stay a crescent with the glow on.

Its peak brightness is derived rather than written down —
`(SUN_CORE_GAIN + SUN_CORONA_GAIN) * 0.1`, a tenth of the sun's peak, which is
0.215 and therefore comfortably under `postfx.ts`'s `BLOOM_THRESHOLD` of 0.9.
Deriving it means retuning either of the sun's gains carries the moon with it
instead of quietly ending the tenth. `uCoronaGain` is then scaled every frame by
`env.moonIllumination`, because a glow is light coming off the lit face and a new
moon has no lit face to give any — left flat, the one night the moon is a dark
disc would be the night it wore its brightest ring.

### The moon's rim aurora, and the 1.3% it misses the bloom by
The moon now wears a third billboard as well: a narrow band of light standing
just outside its own limb, in the same silvery yellow the halo is, its
brightness drifting around the ring on two slow sines at coprime frequencies
running opposite ways. It is the same shared shader again — `uRimGain` separates
it exactly as `uCoreGain` separates the sun — so there is still ONE billboard in
that file, which is what `celestial-shader.test.ts` asserts rather than keeping
a second golden free to drift.

**Its renderOrder is the whole difference between a halo and a rim.** The halo
is light BEHIND the sphere at -6 and has to be painted over by the lit face;
the aurora is light standing at the sphere's EDGE, so it goes at -4, over the
body, and adds to it. The sun moved to -3 to keep the table strictly ordered.
Both ride the moon's position exactly, and both scale by
`env.moonIllumination`: a full moon wears a complete ring, a thin crescent
wears one on the lit horn, a new moon wears none.

**It glows; it does not go through the bloom pass, and the margin is 1.3%.**
Worth recording because it is precisely the kind of thing that gets "fixed" by
someone who did not measure it. `postfx.ts` thresholds on the peak channel at
0.9. The brightest pixel this ring can ever appear on is the lit limb of a full
moon over the brightest crater the hash produces: `MOON_ALBEDO` is 0.565 in the
linear space these shaders write (they do not self-encode), the crater term tops
out at 1.22 of it, `MOON_GLOW_COLOR`'s own peak channel is 0.922, and the ring
is additive over the face — so the best case is
`0.689 + 0.922 * 0.215 = 0.887`, and the bright pass never sees it.

That is a real tension in what was asked for rather than an oversight: a bloom
and a tenth of the sun are two different instructions and on this threshold they
are 0.013 apart. The tenth won because it is the number that was written down,
and because it is the same tenth the halo has always been held to — the moon is
the one body in this world that is not allowed to glare, which is the whole of
`MOON_MAX_LUMA`'s argument. `MOON_AURORA_GAIN` is the one constant to move if
that is ever decided differently: about 0.23 puts the brightest full-moon limb
over the line, about 0.36 — a sixth of the sun — puts the whole lit half of an
ordinary full moon over it. A unit case pins the arithmetic in BOTH directions,
so a later brightness tweak cannot cross the line without noticing.

The aurora keeps its own clock, accumulated from `dt` rather than read off
`env.elapsed`: that one is the world's day clock and runs at whatever rate the
day runs at, and the shimmer is a thing the light does rather than a thing the
calendar does. It should drift at the same rate at noon and at midnight.

Two constants exist only to stop degenerate openings. `MOON_PHASE_OFFSET` keeps
the world from starting on a new moon beside a noon sun, the one arrangement in
which there is nothing to see. And the sun's and moon's declinations run on
6- and 5-day beats, so the two orbits are inclined to each other and exact new
and exact full are never quite reached — the same reason eclipses are rare, and
the reason `daynight-moon.test.ts` pins a swing rather than the endpoints.

### The sky, and the two views it serves
`sky.ts` draws a graded sky dome as well as the atmosphere rim shell, and the
chase camera is a continuous wheel between the two views they each belong to: a
deck under an atmosphere, and a planet in space. So they cross-fade over camera
altitude, in opposite directions. Getting that wrong is not subtle — the shell
is additive and sits exactly where the dome is brightest, and at noon the two
summed past white and bleached the horizon.

Every horizon effect in the dome is measured from the **limb**, not from eye
level. On a globe this small they are nowhere near each other: 9.5 units above
a radius-200 planet puts the horizon about 17° BELOW horizontal, at the chase
camera's actual opening framing about **25°**, and it drops further as the
camera climbs. `limbElev` is recomputed per pixel from `cameraPosition`, and
the gradient, the twilight band and the sun's glow lobe all key off
`rayElev - limbElev`.

`horizon.ts` computes the same quantity on the CPU from the same expression,
and the two must stay the same expression: it is what `solartime.ts` calls
daybreak and what `daynight.ts` grades the key light and `env.dayFactor`
against. A sun that rose out of a band of sky it was not drawn against would be
the visible symptom. See **Where the day starts, and where the horizon is**.

### Draw order in the sky
Everything in the sky is centred on the world origin, so Three's back-to-front
distance sort sees it all at the same depth and `renderOrder` is the only thing
holding the layering up. It is set explicitly, in one place per file:

| Object | `renderOrder` |
|---|---|
| starfield (`sky.ts`) | -20 |
| sky dome (`sky.ts`) | -10 |
| moon glow (`celestial.ts`) | -6 |
| moon (`celestial.ts`) | -5 |
| moon aurora (`celestial.ts`) | -4 |
| sun disc (`celestial.ts`) | -3 |
| atmosphere shell (`sky.ts`) | 0 |
| cloud slices (`clouds.ts`) | 2 + i |

The halo goes UNDER its own body on purpose. Both are centred on the same point,
so the distance sort cannot separate them, and drawn the other way round the
glow would paint over the terminator it is supposed to surround. The moon is the
one body with something on BOTH sides of it: the rim aurora is light at the
sphere's edge rather than behind it, so it goes over the face and adds to it.

The sun and the moon are deliberately NOT on `LAYER_REFLECTED`: they sit at
8 × `GLOBE_RADIUS`, outside the reflection cube's 3 × far plane, and the water
draws its own sun disc in the specular anyway. The sky dome IS on it, since a
sea reflecting a dawn sky rather than a constant is most of what that pass is
for.

## The boot, and the screen it happens behind
`startGame()` is `async`, and the reason is not concurrency. Building the world
is heavy **synchronous** work — the height map is rasterised, the islets are
culled, the land mask is installed, the towns are placed — and synchronous work
does not let the browser paint. Written straight through, a progress bar would
jump from 0 to 100 on the frame everything finished and never once be seen.

So `loading.step()` sets the bar and then *waits for the paint*, and every call
site names the stage that is **about to** run rather than the one that just
did. The bar is a promise, not a report. `painted()` waits two animation frames
for it: a single `requestAnimationFrame` callback runs before the paint it is
scheduled against, so resolving there would hand control straight back to a
caller that blocks the main thread for half a second.

| | |
|---|---|
| Splash markup | ships **visible** in `index.html` — `main.ts` is a deferred module, so the browser paints it from HTML and CSS before a line of the bundle runs |
| `loading.ts` | takes it over; it is the one piece of UI in the project a module does not build |
| Hull progress | real bytes, via `createShip`'s `onHullProgress` → `GLTFLoader`'s `onProgress`. It occupies 0.56–0.88 of the bar and reports through `set`, not `step`, because it is not a stage boundary and must not stop for a paint |
| `?probe=wave` | removes the splash itself; it draws its own canvas and has no world to build |
| Failure | a bundle that never loads leaves the splash up forever, which is correct — there is no game behind it to reveal |

**The hull is awaited before the first frame.** It used to land mid-game behind
the stand-in; now the first frame the player sees has a ship in it. `loadHull`
catches its own failure, so a missing model costs the boot one request and no
more.

**One frame is rendered and thrown away while the splash is still up.**
Materials in this engine compile on first draw, so without it the first frame
the player sees is the frame every shader in the world is handed to the driver
— a hitch of hundreds of milliseconds arriving exactly when they have just been
told the game is ready. It runs the frame loop's own sequence minus the ship's
physics, so nothing compiles there that would not have compiled here.

### Illustrations
The two paintings in `assets/Illustrations/` are **WebP at web sizes**, not the
1792x1024 PNGs they were authored as: 2.5 MB each became 133 KB and 119 KB,
a 95% cut with no visible loss. The masters are kept alongside in
`assets/Illustrations/masters/`.

The sizes are picked against where each is actually drawn. The cover is 1280
wide because its panel is at most 572 CSS px across, which is 1144 device
pixels on a 2x display — a slight downscale at every size it is really used
rather than an upscale. The splash is 1600 because it is full-bleed.

Both are CSS `background-image`s with the painting's own deep navy as a
`background-color` underneath, so the first paint is the right colour rather
than a white flash. The cover's element ships `display: none`, so its file is
not fetched until the screen is first opened; the splash's is fetched
immediately, which is the whole point of it.

## Frames, and where they stop working
A tangent frame exists at a point. `tangentFrame(up)` is degenerate at the
poles and *near*-degenerate around them: the meridians converge, so a few
metres of travel can swing `north` through ninety degrees. Anything stored as
an angle in that frame therefore means something different a moment later.

Both `ship.ts` and `wind.ts` made that mistake, and together they made a ship
in high latitudes twist on the spot:

- `ship.ts` kept `heading` — a compass bearing — as its orientation and rebuilt
  `forward` from it against the frame at the new position every frame. Holding
  the heading constant **swung the bow**.
- `wind.ts` held `bearing` for the length of an event and re-resolved it the
  same way, so the push swung too. The two then drove each other in a circle.

Neither module's arithmetic was wrong. Both were storing a reading and treating
it as the truth. **The vectors are the truth; the angles are read off them.**

- The bow turns about the surface normal by the helm and is carried across each
  step by **parallel transport** — rotated by exactly the rotation that carried
  the hull — so a ship with its helm amidships runs a great circle, which is
  what sailing straight ahead means on a sphere.
- The wind is resolved from a bearing once, when its event is authored, and
  transported the same way after that. Its angle to the bow is measured between
  two world vectors rather than subtracted between two compass readings, so the
  number deciding which way the hull is shoved never passes through a chart.
- Both re-orthogonalise against `position` after transporting. Rounding walks a
  tangent vector off the plane, and over a long passage it is visible.
- `heading` and `bearing` survive as derived readings for the HUD and the
  scope. They still spin at the pole. That is what a compass does there,
  and it is now cosmetic.

Measured over 90 s of simulation, bow rotation relative to the path with no helm
input — the ship turning when it should not:

| | before | after |
|---|---|---|
| equator, no wind | 180.0° | 0.0000° |
| over the pole, no wind | 180.0° | 0.0000° |
| over the pole, with wind | 180.0° | 0.0000° |
| at 89.97° N, with wind | 180.0° | 0.0000° |

The wind's angle to the bow within one event holds to 0.00° where it swung by
up to 34.8°. Before the fix every one of those runs ended pinned at 89.97° N —
the ship reached the pole and stayed there, spinning. It now sails over the top
and down the far side.

### The dock hangs off the telemetry panel
Every box on the HUD is absolutely positioned, so none of them is in flow with
any other and no selector can see where a neighbour's edge falls. The telemetry
panel is also content-sized — it grew a row the day GOLD landed in it — so the
dock beneath it is positioned off `--telemetry-h`, a custom property `hud.ts`
publishes from a `ResizeObserver`. It is the RENDERED height, measured after
`scale(var(--panel-scale))`, so CSS uses it as an offset without scaling it
again, and it carries a stylesheet fallback only ever seen on a browser with no
`ResizeObserver` at all.

A `--telemetry-w` existed for one commit, for a CONTROLS card hung off the
panel's right edge. The card is a pane of the Escape menu now — it was half
size to afford the corner it stood in and `display: none` below 560px of
viewport height, which is the wrong place for the one thing explaining the
on-screen keys — and the property went with it. See `menu.ts`.

The bottom-left corner is the **helm's**, and that is deliberate: a corner is a
thumb's reach on a phone without the hand leaving the edge, and the centre of
the bottom edge — where the pad used to sit — is the water directly ahead of
the bow, which is the one part of the screen a player steering is actually
looking at.

The pad itself is a T, not a cross: `up` alone on row 1 column 2, and `left`,
`down`, `right` abreast on row 2. Row 1's outer columns are left empty rather
than collapsed, because they are what keeps THRUST over REVERSE instead of over
PORT. `--stack-gap` (3px) separates the two rows and the columns keep the old
7.875px: thrust and reverse are the two ends of ONE axis and are spaced to be
rocked between, while port and starboard are separate aims where a mis-hit
costs a heading. The old cross put a whole key height and two gaps — about
70px — between W and S, which is a reach rather than a rock. The empty `.dpad__hub`
that used to hold that cross open is gone with it.

The whole pad is drawn at `--dpad-scale` (1.25) by a `transform` anchored at its
bottom-left corner, for `--panel-scale`'s reason: it carries a dozen fixed pixel
figures — the ship keys' 27px height, their radii, margins and gaps — that
`--key-size` does not reach, and scaling keeps every one in proportion. The
variable lives on `:root` beside `--key-size` because `.moor`'s narrow-screen
offset has to clear the pad and cannot read a variable declared on it; that
offset multiplies the pad's authored height by the scale.

`[COIL]` and `[ANCHOR]` are 30% taller than the other ship keys, and the extra
height is cancelled by a negative margin on the far side. The pad is pinned by
its BOTTOM edge, so an ANCHOR row that really grew would lift every key above
it; with the margin each row contributes exactly the track it did before, and
the two buttons overhang the grid instead. Both heights are written against
`--act-h`, which the compact block changes, so the compact pad follows without
a second copy of the figure.


## HUD text sizing
Browsers carry a **minimum font size** preference (Chrome: Settings →
Appearance → Customize fonts). It clamps the *computed* `font-size`, so any
rule asking for less than the floor — commonly 12px — is silently discarded.
Most of this HUD is authored below that: `.readout__key` at 9.5px,
`.rsv__head .readout__key` and `.radar__range` at 8.5px, the D-pad glyph at
11.4px. On a
machine with the floor set they all render at 12px and the typographic
hierarchy flattens.

That is a user preference and is mostly left alone, with **two**
exceptions — and the second one was found the hard way, which is the argument
for reaching for this pattern sooner.
`.dbtn__label` has to fit inside its key — `STARBOARD` is nine characters in a
key as narrow as 42px — so it is sized from `--key-size` and drawn through a
`transform: scale()`, which is applied after layout and is never clamped. Its
layout box is therefore ten times wider than its ink and reaches over the
neighbouring keys, which is why it carries `pointer-events: none`. Do not
"simplify" that back to a plain `font-size`.

**`.dpad__act__inner` is the second exception, and it was a bug before it
was a rule.** `[COIL]`, `[FISH]` and `[ANCHOR]` moved onto the helm pad and
were stretched to a helm key's column, which turned them from buttons sized *by*
their label into labels fitted *into* a button — the same predicament
`.dbtn__label` is in, and nobody noticed the pattern had to come with it. They
were authored at 7.45px; a machine with the floor set served 12.6px and
`ANCHOR x5` ran off both ends of its button. It was reported as "the text is
too big", and shrinking it would have done nothing at all: 15% off 7.45 is 6.3,
which clamps to 12 just the same.

The tell, if this happens again, is a *ratio*. Measuring the report, the glyphs
were 7.6 CSS px wide against the 4.5 they are drawn for — 1.69x, which is
12.6/7.45 and not any size anybody chose. Meanwhile `STARBOARD` beside it
measured exactly right, because it already had the dodge.

It needs a **wrapper** where the helm label needed none: the word and its count
are two boxes that must stay together, and scaling them separately leaves both
the right size and the pair ten times too far apart. Everything inside is
therefore in `em` — margins, and the text shadow's blur — and the group is
scaled once. `.dock__key`'s absolute `10px` has to be overridden to `inherit`
inside it, or the wrapper scales a 10px label down to 1px.

The dock's own `[SHOP]` is the counter-example, and it is authored at 10px on
purpose. It is sized *by* its label — the key is as wide as its word plus
padding — so a floor raising it to 12px widens one button by a few pixels and
collides with nothing. The rule is not "never author under 12px"; it is
**never let a floor break a layout that assumed the smaller size**, and a key
pinned to a column is always such a layout.

A second sizing rule, learned the same way. **Type on a fluid element belongs
in container units, not pixels.** The scope runs from 118px to 158px, and the
position fix was first placed inside the glass in px: it fitted at 158 and the
two coordinate blocks collided in the middle at 118 — a live window between the
desktop layout and the 720px breakpoint, not a hypothetical. A disc also has no
corners, so the blocks had to be pushed inward to clear the rim, which is what
made them meet. A row above the scope was the second attempt and it lasted
longer, but three blocks sharing one band is the same squeeze in a straight
line: at the bottom of the clamp the two coordinates met again.

They are in a **column beside the scope** now, HDG first with the big figure,
then LAT and LON. Each row gets the side column's full width to itself, so
nothing competes with anything and there is no breakpoint at which two of them
meet. The lesson generalises past this instrument: when three readings will not
fit across a fluid width, the fix is usually to stop asking them to share one.

## What a bar is doing
The telemetry panel carries three levels that move on their own — the tank, the
bought cell and the hull. The figure says where each one is and the tag says
why, but neither says it is *moving*, and a player watching for the moment a
storm starts eating the hull should not have to read two rows of small type to
catch it.

One vocabulary covers all three, written by `hud.ts` as a `flow--*` modifier on
the **bar element** (not the block: the hull's bar is not inside the power block
and wants the same four states): `still`, `drain`, `drain-fast`, `charge`. Two
markers ride the segments, one notch at a time:

- **`is-crest`** — the highest lit notch, the one the level stands on and so the
  one a drain is about to take. This is what blinks, once every three seconds
  while draining. Not the whole bar: `pwr--dead` and `hull--critical` already
  flash whole bars as alarms, and an ordinary burn must not look like one.
- **`is-sweep`** — the notch a charging sweep is passing over, moving one notch
  per 500ms. It wraps at the crest rather than running out over dark notches:
  it is the bar filling, and sweeping notches the charge has not reached would
  draw charge that is not there.

The hull under weather gets **two** pulses a second instead of one. A doubled
beat for the doubled wear rate, so the difference from an ordinary drain is a
*count* rather than a colour and survives being seen sideways.

Two decisions in the wiring are worth keeping. The power bar reads its flow off
`rate` **except** in `reserve`, where the main tank is already on the floor and
every watt is coming out of the cell: the total is falling there and that bar is
not, so the news belongs to the backup bar and blinking both would say the ship
is losing charge twice over. And the hull reads its flow off the **rate**, not
the mode — `hull.ts` publishes 0 at the 1% floor rather than the wear it is no
longer paying, and a bar blinking over a number that has stopped moving is the
same lie the rate readout beside it was written to avoid.

Nothing here is load-bearing: every rule is an animation on a marker class, so
`prefers-reduced-motion` drops the motion and keeps the whole reading.

### Colour names a severity, on every bar
The hull bar was **brass** for a while, on the reasoning that it is the one
thing on the panel that is a physical object rather than a flow. That died on
arithmetic rather than taste: `pwr--warn` is `#ffb445` and `hull--worn` is the
same `#ffb445`, so the moment the tank fell to mid, the tank went the colour
brass was meant to be distinctive against — and with the cell taking the plant's
accent too, that is three warm bars in one column with nothing to say which is
the hull.

Colour was carrying identity *and* severity and could not do both. It carries
only severity now, the same ladder on every bar: cyan is fine, amber is a
warning, orange is failing, red is an emergency. Identity is left to position
and to the key beside each bar, which are the two things that never change.
Only the `sound` swatch actually moved — the other three were already the power
block's own amber, orange and red.

## The radar
`radar.ts` paints `#hud-radar`, a 2D canvas, from the height map and the inland
mask on the CPU — no second WebGL view, no draw calls, and no way for the scope
to disagree with the world. The projection is azimuthal equidistant about the
ship, so distance from the centre is true great-circle distance out to
`RADAR_RANGE`, and the scope is bow-up: own ship sits at the centre pointing at
12 o'clock and the whole compass swings round the rim.

**N, E, S and W ride just inside the rim, and they rotate with the bow.** That
is the point of them on a bow-up display: a player reading `E` off the
right-hand rim is being told east is to starboard, which is the question the
instrument is actually being asked. A fixed ring of letters would be a
north-up instrument's ring on a bow-up one, and would disagree with the terrain
under it the moment the ship turned. **North's letter is drawn at twice the
size of the other three** and keeps its arrow, pointing at it from inside, and
both are **blue** — cyan is the instrument itself and magenta is own ship, so
north needed a hue of its own.

The letters are the one mark on the scope drawn in device pixels rather than in
scope radii, because a glyph has a legible size of its own that the rest of the
instrument's unit system cannot express. Same escape the wind's gust glyph
makes, by the same route, and each is stroked with a dark halo first so it
survives crossing a lit coastline.

That pixel floor is also why neither north's letter nor its arrow sits at a
fixed radius. On a 104px scope at 1x the floor holds each glyph at nearly a
fifth of the scope's radius, so a double-size N placed where the other three go
would have its top sliced off by the canvas edge — the canvas is exactly the
disc, and there is no bezel to spill onto. `letterRadius` therefore treats the
ring as a ceiling and pulls a glyph in only as far as it must, and the arrow is
placed off the N's own inner edge rather than off a constant. On a large scope
or any 2x display the floor stops binding and all four letters sit on the same
ring.

The per-pixel trig is precomputed once into three tables, because only the
ship's `up`, `forward` and `starboard` change:

```
dir = up * cos(d/R) + (forward * cos(b) + starboard * sin(b)) * sin(d/R)
```

Terrain is rasterised at `RASTER_HZ`, the overlay every frame. The scope's
colour bands are deliberately copied from `land.ts` and `water.ts`, so an
island is the same shape and shade on the scope as out of the window.

Towns are plotted in the overlay pass, under the own-ship blip and clipped to
the bezel: a mint diamond in a hairline ring for a berth, a dim grey dot for a
landlocked town. So the scope doubles as the fuel map.

**Icons project through the frame the raster was taken in, not the live one.**
That table above is inverted rather than reimplemented — `dir · up` is already
`cos(d/R)` and the two tangent dots are already the bearing's sine and cosine,
so an icon needs three dot products and no second projection. The staleness is
the point: terrain only refreshes at `RASTER_HZ` while the ship turns at up to
1.2 rad/s, so an icon placed from the live frame would slide an eighth of the
scope off its own island between rasters and snap back, ten times a second.
Stale together is coherent; stale apart is a bug that reads as the radar lying.
Culling is a dot product against a precomputed cosine, so only the handful of
towns actually in range ever reach `acos`.

**Raiders are own ship's own blip, moved and turned.** `blipPath` emits the
arrowhead once and both the centre mark and every AI boat are drawn with it,
because they are the same kind of thing and the scope has to say so: a raider
drawn a shade smaller would read as further off than the projection had
already placed it, and the player would be judging a closing distance against
a mark quietly lying about it. Colour is the whole warning, `--red` for the
hunter and `--orange` for the one running a straight line past you, and the
mark carries the boat's `envelope` as its alpha, so it arrives on the scope as
the hull arrives on the water and leaves the same way. Like the crests, they
are placed from the LIVE frame rather than the raster's: a raider is attached
to nothing on the picture, and the thing it is closing on is at the centre of
the scope. Which way its bow points is measured between two world vectors, not
subtracted between two compass readings, per **Frames, and where they stop
working**; both the crests and the raiders project through one captured live
frame rather than each building its own.

The panel's fix — **heading, LAT and LON** — stands in a column beside the
glass, and the time dial sits in that column under it, bottom-aligned with the
scope. The dial is scaled up by a `transform` (1.3225, anchored bottom-centre)
rather than widened, so it takes the spare height under the fix instead of
widening the whole panel; `timedial.ts` sizes its backing store off
`clientWidth`, which a transform does not change, so the ring stays round. WIND
and SKY share one two-column row across the foot of the panel. Both instrument
panels are drawn at `--panel-scale` 0.805, the 0.7 they were cut to grown back
by 15%. The range readout is gone — it never varied, so it was a constant printed every
frame. The wind arrow rides the rim on the true bearing from the **live** frame,
not the raster's: it is attached to nothing on the picture, so projecting it
through a frame up to a tenth of a second old would simply lag the bow through
every turn. It carries the gust glyph on its **tail**, byte-for-byte the same
SVG path data the SPEED row uses, parsed by `Path2D` so the two cannot drift
apart by a curve — on the tail because the head is the reading, and a mark laid
over it would be taken for part of the arrowhead. That glyph is the one thing
on this canvas authored with a pixel floor rather than purely in scope radii:
three strokes four viewBox units apart smear together below about 20px.

## Ship energy
`energy.ts` owns one `EnergyState`, mutated in place for the life of the run —
the HUD, the thrust gate, the dock rings and the model's neon all hold that same
reference, so handing out a copy would leave them reading a tank that had
stopped moving.

Every constant is authored as an **endurance in seconds** and the level/s rate
divided out of it, for the same reason `ACCEL` is derived from `MAX_FORWARD`:
write the rate directly and leave the endurance in the prose beside it, and the
two drift apart the first time either is retuned. `IDLE_DRAIN` is subtracted out
of `FULL_BURN` and added back into `SOLAR_PEAK`, because both targets are claims
about the *net* result rather than the gross.

**`NAV_BURN_SCALE` (0.5) halves the propulsion draw and nothing else** (owner,
2026-09-11). It is applied inside `FULL_BURN`, so the speed-squared curve, the
Overdrive Coil's flat multiple of it and a tow's doubling of the sum all move
together and cannot disagree. `IDLE_DRAIN` is left alone deliberately: the hotel
load is drawn at anchor and at a berth too, so it is not a cost of navigating,
and it is what `IDLE_ENDURANCE` is tuned against. The panel therefore reads 48%
lower at full throttle rather than a round 50%. Nothing a maelstrom, a battle or
a purchase takes is scaled — those are events, not navigation.

| | |
|---|---|
| Burn | `IDLE_DRAIN + FULL_BURN * (speed / MAX_FORWARD)^2`, `FULL_BURN` already scaled |
| 15 / 7.5 / 5 kn to dry | 174 s / 9.6 min / 16.8 min |
| Solar (stopped only) | `SOLAR_PEAK * max(0, up · sunDirection)` — 0.5%/s net at noon (200 s to full), 7.2 min at 30°, negative after dark |
| Berth | 5.0%/s net (20 s to full), overrides solar rather than stacking |
| Mooring | inside the ring and a `Space` press — the dwell is gone, see below |
| Backup cell | drawn on only once `level` is 0; never charged by anything |
| No thrust | full thrust refused at zero until `RESTART_LEVEL` (3%) of **both tanks together**; `ship.ts`'s `LIMP_SPEED` crawl (1 kn) is all the helm has in between |

`MAX_FORWARD` is exported from `ship.ts` and imported here rather than copied,
so a change to top speed moves the fuel economy with it instead of silently
rebalancing the game. The burn is quadratic, which is what makes cruising slowly
a strategy rather than a slower way to arrive equally empty.

**The backup cell is a second tank that nothing fills.** `battery.ts` owns the
charge, `energy.ts` owns when it is reached, and the rule is one sentence: the
main tank is drawn down first, to zero, and only what it could not pay for
comes out of the cell. That holds for the per-frame burn and for `spend`
alike, so a player on 20% with a full cell can still buy a fishing session and
pays for it out of both. Neither the panels nor shore power can touch it —
both write `level` and the cell is not `level` — which is what makes it a
consumable wearing a battery's clothes and the reason a player thinks before
leaning on it.

The HUD side of it changed on 2026-09-09 and the reason is arithmetic.
`BATTERY_CAPACITY` is `BATTERY_CELL * BATTERY_CELLS_MAX` — a **whole** tank —
and the bar had been left at the five half-width notches it was given when a
cell really did hold half a tank, so a full cell drew as a half-full one. It is
ten notches on the tank's own scale now, indented under the power bar and
taking `--pwr-accent` off it, so 55% lights the same notch in both places and
the cell reads as more of the same charge rather than a second, unrelated
gauge.

Three consequences worth holding on to:

- **`rate` is over the total**, main tank plus cell. Once `level` is pinned at
  zero it stops moving while the ship is still visibly burning, and a HUD
  reading `+0.00 %/s` under full throttle would simply be wrong.
- **`canThrust` is over the total too**, so a ship that runs its tank dry with
  a cell aboard never stops — it changes which tank it is drinking from, and
  the `reserve` mode says so on the panel.
- **`reserve` is ranked above both burns.** A ship drifting at night on its
  cell is doing what a drifting ship always does, and calling that `burn`
  would let a bought battery empty itself without the panel ever naming the
  tank going down.

**The tag names a cause; the colour names a severity.** `EnergyMode` is ten
names for what the plant is doing, and `hud.ts` derives the colour separately
from `level`, `rate` and `canThrust`. One enum carrying both jobs is what
forced `low` to exist as a HUD-only sixth state and left `reserve` — the one
reading that cannot be undone — wearing the same neutral cyan as a healthy
ship under way.

| | |
|---|---|
| `dead` / `restart` | no thrust past the 1 kn crawl, and whether the rate says the rest is coming back |
| `docked` / `mooring` | made fast, or inside the ring and not yet made fast |
| `reserve` | the main tank is on the floor and the cell is paying |
| `overdrive` / `burn` | the coil's flat bill, or the ordinary speed-squared draw |
| `solar` / `moon` / `hotel` | at rest: sun on the panels, moonglass, or neither |

Severities are `dead` (red, and the only one that flashes), `warn`, `hot`,
`gain` and `steady`. The panel's own `full` tag lives on that side too, because
a tank at its ceiling is a fact about `level` — and because making it a mode
would have put it in front of `docked`, which five modules test as the single
definition of being at a berth. The shop gate must not close because the tank
filled up.

Two of the ten exist because the old five said something untrue. `empty`
covered both a ship adrift in the dark and one whose panels were already
climbing back through the first percent — the tag read EMPTY beside a positive
rate, which is a plant that has failed rather than one restarting. And a
Moonglass Array charging at midnight claimed `solar`.

### A berth connects on a key press
Arriving and docking used to be one event. The ring alone did it — first with
a 3 kn ground-speed test, then with a two-second dwell — and that was fine
while docking only *gave* things: shore power, a shop, a repair. It stopped
being fine the moment docking began to **take** something. A made-fast ship
cannot be steered, and nothing may take the helm away from a player who has not
asked for it; drifting across a ring would have frozen the ship solid two
seconds later.

So the two halves are now separate, and `energy.ts` owns both because it
already owned the ring test:

- **`berthReady`** is the ring's verdict, and since the dwell was dropped it is
  the ring and nothing else: the hull is inside one. It says the ship *may* be
  made fast and nothing more.
- **`mode === 'docked'`** is the helm's, and it is still the single definition
  every other module means by "at a berth" — shore power, the shop gate, the
  hull's repair, the wind's shelter, the hazard and raider suppression, and the
  harbour's discovery all hang off it, unchanged.

`toggleMooring()` is the only door between them and it refuses unless
`berthReady`. Keeping the ring test and the lock that consumes it in one file
is the point: a caller able to set the lock without passing the ring would be a
second opinion about what it means to have arrived.

**The dwell is gone and its job went with it, not away.** Both the speed limit
and the two seconds existed to stop a ring being collected by crossing it at
15 kn. That protection now lives in the key press — docking is a deliberate act,
and nobody presses Space by accident at speed — so the clock was pure delay,
and worst at exactly the moment it mattered least: a player stopped in the ring
watching a timer they could not see.

**The freeze is `ship.ts`'s, off the same field.** It tests
`energy.mode === 'docked'` rather than taking a flag of its own, so a ship that
is docked and a ship that is held fast cannot come apart. The whole
implementation is skipping the helm block: that block is where the throttle,
the wind's push and the hazard's push are all spent, so not running it is all
three at once. A maelstrom's `drive` still outranks it — the sea taking the
hull is the truth and a rope is not.

**The lock releases itself if the ring is ever lost.** That is a safety rule
rather than a behaviour: a made-fast hull cannot steer, so a lock outliving its
berth would be a ship frozen in open water with no key that does anything.

The HUD carries both states in one notice at the foot of the screen, and the
made-fast one names the way out in the same breath as the state — being moored
takes the helm away, and a message that had faded three seconds ago would leave
a player pressing keys at a ship that will not answer.

Three subtleties worth keeping:

- **The dead-stop snap tests `thrust === 0`, not the absence of input.** They
  are the same key press until the tank runs dry. After that, a player holding W
  on a dead ship is holding the `LIMP_SPEED` crawl open and is genuinely under
  way at one knot, so `speed === 0` is false and the solar test above correctly
  does not fire — that is the trade the crawl is sold under. Releasing the key
  is what has to reach an exact zero, and the closed-form drag decay approaches
  it without ever arriving, so a test on the keys instead of on `thrust` would
  leave `speed` at 1e-9 forever and the ship would refuse to charge with nothing
  on screen saying why.
- **`canThrust` is hysteretic**: dry at 0, thrust only at `RESTART_LEVEL`.
  Relighting at the first positive level would spend it on thrust inside the
  same frame and drop straight back to empty, stuttering the thrusters and
  strobing the HUD tag every frame the panels trickled.
- **`dead` and `restart` outrank everything**, a berth included, because they
  are statements about thrust rather than about charge. Which of the two shows
  is the sign of `rate`, so a plant already climbing back says so.

`energy.update` runs before `ship.update` and therefore bills last frame's
speed. That is deliberate: the alternative is the ship spending power it turns
out not to have.

## Wind

`wind.ts` owns one `WindState`, mutated in place for the life of the run, on
the same terms as `EnergyState`: `ship.ts`, `hud.ts`, `radar.ts` and `shipfx.ts`
all hold that one reference. Handing out a copy would leave them reading a wind
that had stopped moving.

**The wind never stops.** It alternates forever between a **lull** (3–15 s,
speed exactly `LULL_SPEED` = 1.0 world units/s, which `hud.ts` prints as 1 kn)
and an **event** (5–30 s, one fixed bearing drawn uniformly per event). A lull
was a dead calm once, and three things follow from its no longer being one:

- **`hud.ts` has no CALM state.** The WIND row has one appearance, always
  carries a figure, and always points the arrow somewhere real; `.wnd--calm`
  and its arrow-hiding rule are gone from `style.css`, and `index.html` ships
  the row blowing. `radar.ts`'s `wind.speed > 0` test survives only as a guard
  against a zero-length arrow in a hand-built `WindState`, not as a calm.
- **A lull draws its own fresh bearing**, exactly as an event does. It used to
  hold the last event's, because at zero speed nothing read the direction and
  spinning the arrow through a dead calm would have reported weather that was
  not there. Now the reverse is true: holding it would make every lull a weak
  continuation of the gust before it, and the wind would only ever change
  direction on the way *up*.
- **`hazards.ts` leans on the floor.** A crest travels with the wind and is
  raised upwind of the ship, so a wind with no direction would leave a wave
  with no heading and nowhere to be born. See **Hazards**.

`LULL_SPEED` is applied as a **floor on the finished speed**, not as an offset:
`Math.max(LULL_SPEED, ramp × gust × cap)`. The top of the range is exactly
where it was, and the fades at either end of an event no longer pass through
zero. Speed during an event is otherwise `envelope × gust × cap`:

- the **envelope** fades in over `FADE` (2 s) and out again, *clamped to a
  quarter of the event's own duration*. Without that clamp a 5 s event spends
  four of its five seconds fading and never once reaches its cap, so the short
  half of the duration band would produce nothing the player could feel;
- the **gust** is smoothed simplex noise remapped from [-1, 1] into
  `[GUST_FLOOR, 1]` — floored at 0.55, because a wind that dies in the middle
  of its own event and comes back is a bug report, not weather;
- the **cap** comes from the coast ramp below.

Randomness comes from one seeded `mulberry32` stream, same house style as
`towns.ts`, so a given world always blows the same way. That is worth more than
novelty here: tuning the caps and chasing a drift bug both need the same gust
to come back on the next run.

**The coast ramp.** The cap is a linear interpolation from `COAST_CAP` (8) at
the shoreline to `OCEAN_CAP` (16) at `OPEN_SEA_DISTANCE` (40 world units)
offshore, so there is no line to cross — standing out from a coast, the wind
builds. Distance to land is probed on the CPU from **the same height map
`radar.ts` rasterises**, which is the point: the wind and the scope can never
disagree about where the land is, so the sheltered water on the display is the
sheltered water the ship actually finds. The probe walks 16 bearings at 5, 10,
20, 30 and 40 units, stops at the first ring that finds land, and runs at
`PROBE_HZ` (4) rather than every frame. Its answer steps in rings, so it is
eased with a ~1 s time constant; that smoothing is also what covers an islet
the inner ring misses for a beat. The cap is re-evaluated **every frame, never
locked at the start of an event** — a ship under a 30 s gust crosses 200 units,
five times the width of the ramp.

**The eight-sector push.** The wind's travel bearing relative to the bow is
quantised to the nearest 45° and indexed into a fixed table of
along/starboard pairs. Being a table rather than a cosine is the design and not
a shortcut: the player is meant to learn eight distinct behaviours, not a
continuum. Every entry is a unit vector, so the cap means the same thing on
every point of sail. The push is then `WIND_GRIP × speed ×` the table entry,
with `WIND_GRIP` 0.35 — the rule the whole system is tuned around, and the one
worth remembering: **8 kn of engine under a 10 kn tailwind makes 11.5 kn over
the ground.** The engine still clamps at `MAX_FORWARD`, but ground speed has no
ceiling beyond the arithmetic and reaches ~13.6 kn flat out downwind under the
ocean cap. The engine stays the thing the player steers; the wind is a hand on
it, never the larger half of how fast the ship is going.

The applied vector is **eased** toward the table value with `PUSH_TAU` (0.3 s),
using the same `1 - exp(-dt / tau)` damping as `bankRoll`. Without it, crossing
a sector boundary at the ocean cap jumps the push by 4.3 kn inside a frame and
the hull visibly snaps sideways. The accepted consequence is that during a
transition the push is briefly *not* exactly one of the eight table values;
nothing downstream assumes it is.

### The wind raises the sea
`water.ts` is the only module that reads `WindState`, handed to it through
`globe.update(dt, env, wind)` rather than pushed onto `WorldEnv` — `env.ts`
names `daynight.ts` as its sole writer, and a second writer is a harder thing
to give up than an extra argument.

The three wave layers drift at 1.5 / 1.9 / 2.4 world units per second at
`OCEAN_CAP`, and wave height runs as `strength²`, where `strength` is
`seaWindStrength(speed)`. Height square, drift linear: a freshening wind
lengthens the swell noticeably before it starts throwing it about.

**The drift offset marches UPWIND, and that sign is the whole of which way the
sea runs.** `waveField` in `waterglsl.ts` samples the noise at `p + offset`, so
marching the offset one way slides the pattern the other: to make the crests
travel downwind — the way a wind-driven sea moves, and the way
`WindState.direction` points — the offset has to be integrated against
`wind.direction`. It was added rather than subtracted until v0.11.0, which put
the whole sea running into the weather that raised it. All three layers take the
same sign, so they still travel together and the ratios between the three speeds
are untouched, and `ship.ts` and `wavefield.ts` read the very same `Vector3`s
through `Water.offsets`, so the hull and the CPU port of the field turn round
with the shader rather than against it.

**The sea is drawn four knots ahead of the weather.** `seaWindStrength` is
`(speed + SEA_WIND_BIAS) / OCEAN_CAP`, clamped — so the 1 kn lull that
`LULL_SPEED` guarantees is painted as a 5 kn breeze, 2 as 6, and so on. The
bias is appearance only: the push on the hull, the SPEED and WIND readouts, the
scope's arrow, the flag and the sail all still read the true `WindState.speed`.
The reason is the paragraph below on the two floors — at `LULL_SPEED` the
wind's own contribution to the height is a hundredth of it, so between gusts
the sea was almost entirely `CALM_INTENSITY` and read as a plate rather than as
water.

**It costs the top of the range, and that is a real trade rather than an
oversight.** Strength is clamped to 1, so past `OCEAN_CAP - SEA_WIND_BIAS`
— 6.4 kn offshore, and the cap near a coast is only 5.2 — the sea is already
at full height and a harder blow does not raise it. Above that the water stops
being a reading of the weather, and the arrow on the scope no longer tops out
with it: the sea is full at 6.4 while the arrow goes on lengthening to 10.4.
If the top of the range ever has to separate again, the fix is to RESCALE the
mapping rather than shift it; `SEA_WIND_BIAS` in `wind.ts` is where that
argument starts.

**The bias is single-sourced; the height law around it is not.** `water.ts`
(what is drawn) and `ship.ts` (what the hull rides) keep deliberate copies of
the `CALM_INTENSITY + (1 - CALM_INTENSITY) · strength²` law — see
`HULL_CALM_INTENSITY` for why — and both call the one exported
`seaWindStrength`. A duplicated bias is the desync that duplication invites: a
hull riding an unbiased sea under a biased one is a boat sitting flat in
visible waves.

**The trap: the drift offsets are positions, not velocities.** The shader used
`p + DRIFT * uTime`, which encodes where the field has *always* been — so
changing the drift rewrites its whole history and every shift of wind would
teleport the ocean by minutes of travel. They are now integrated on the CPU
each frame, so a change of wind changes only where the sea goes next. Measured:
a 90° shift moves the field by one frame's travel, 0.025 world units. The lake
clock still works because `motion` is constant in time, so scaling an
integrated offset is the same as integrating a scaled rate.

Two floors, both deliberate departures from strict proportionality. Lulls run
3–15 s, and a sea whose height and drift both go to zero is a mirror — which
reads as a bug, not as weather. `CALM_DRIFT` (0.2) and `CALM_INTENSITY` (0.16)
keep the swell running through one, which is roughly what real swell does.
They are named for a state the wind no longer has, and they still earn their
place: at `LULL_SPEED` the wind's own contribution is a hundredth of the
height, so these two are still what the sea is made of between gusts. Between those floors and a full gale the law is exact:
half the wind gives 25.0% of the height. Coastal foam keeps its own fixed
drift — surf runs onto the beach, not downwind.

### The two speeds

This is the split to get right, and the reason `ShipState` carries both.

`ship.ts` no longer steps along its heading. It builds a **ground velocity** —
`forward × (speed + wind.along)` plus `starboard × wind.across` — and walks the
great circle along *that*. Adding the wind as a velocity rather than as a
turning force is what produces real leeway: the bow holds its heading and the
hull crabs off its course. There is no weathervaning; the bow never turns on
its own.

| Number | Means | Who reads it |
|---|---|---|
| `ShipState.speed` | engine only, along the bow | the burn, turn rate, bank, `MAX_FORWARD` clamp, `STOP_EPSILON`, the solar test. Heave, pitch and roll no longer read it at all — they are `sampleWave` readings at the hull, driven by the wave field and the wind, not by the engine; see **The wave field** |
| `ShipState.groundSpeed` | engine + wind, signed | the HUD's `SPEED` row, the berth connect test |

Two rules in `energy.ts` moved or deliberately did not:

- the **berth test moved to ground speed**, or a ship blown through a ring at
  12 kn with its engines stopped would read as moored, take on shore power, and
  — because a berth switches the wind off — be becalmed mid-drift;
- the **solar test stayed on engine speed** (`ship.speed === 0`), so a dead
  ship drifting downwind still deploys its panels. That is the entire point of
  running out of charge in a wind: you are not stranded, you are being carried
  somewhere while you recover. The `STOP_EPSILON` snap stays on engine speed
  for the same reason — it is what makes that exact `=== 0` test safe.

The burn also stays on engine speed, so a tailwind extends the ship's range
rather than costing extra, which is what makes reading the weather worth doing.

**Collision fallback.** When the combined course is blocked by land, `ship.ts`
retries the step under **engine alone** before giving up, and only zeroes the
speed when both are blocked. A beam wind pinning the hull against a coast must
not also stop it sailing *along* that coast — without the retry, a player with
a shore to leeward loses the helm entirely until the wind drops.

**`groundSpeed` is written from what the hull committed, never from what it
attempted.** The velocity is built before the land gets a vote, so the obvious
ordering — build it, report it, then move — leaves a ship hard aground still
reading a knot and a half. Found by running the game, not by building it; the
types are identical either way. It matters well beyond the HUD, because
`energy.ts` decides whether a berth may connect on this number, so a phantom
speed is a berth silently refused. Each of the three outcomes writes its own
answer: the combined velocity when the course is clear, `forward × speed` when
only the engine got through, and zero when the ship is beached.

**`COAST_CAP` is never actually reached.** The innermost probe ring is 5 world
units, so the probe can never report land closer than that, and the ramp floors
at `5.2 + 5.2 × (5/40)` = **5.85 kn**. `COAST_CAP` is what the ramp
extrapolates to at a coast distance of zero, which no reading can produce. Both
numbers are implemented as specified rather than one being quietly bent to fit
the other; if a true `COAST_CAP` at the shoreline is ever wanted, either add a
ring at 0 or treat a hit on the innermost ring as distance zero.

**Feedback.** The HUD carries a `WIND` row (arrow relative to the bow, matching
the bow-up scope, or `CALM`) and breaks the `SPEED` row down into ground speed
plus the wind's signed contribution, which is what makes the grip rule legible.
The radar draws a rim arrow on the wind's *true* bearing in the **overlay**
pass on the live frame, like the cardinal ring — it is not attached to terrain, so
the stale-raster-frame rule does not apply to it. `shipfx.ts` streams the flag
along the **apparent** wind (true wind minus the hull's own motion, so a ship
under way in a calm streams astern — it used to lean toward the bow, because the
model was authored around a permanent following wind) and adds the tailwind
component to the sail's belly. The model only bellies the sail one way, so beam and head winds
show on the flag and not on the sail.

## Hazards — rough water
Strong waves that shove the hull and maelstroms that eat it. `hazards.ts` is
the sim, `hazardfield.ts` the height field, `waterhazard.ts` the plugin that
draws it. The brief is `docs/HAZARDS_PLAN.md`; this section records the two
decisions a later reader is most likely to undo by accident.

**Two kinds, not three.** `greatwave` is gone: it and `wave` were the same
geometry at two fixed strengths, and every property that separated them —
height, push, dissipation — is now rolled per wave off a continuous range, so
the second kind carried nothing but a second pair of constants. What was the
great wave is the top of the range: `CREST_HEIGHT_MAX` is the 2.4 that constant
always was, and the fastest wave's push peak is the 10 the great wave was worth.

Three hazards at most, rolled every **1 s at 45% / 2%**, with a live budget of
**two crests and one maelstrom** — the same `MAX_HAZARDS` = 3, so the shader's
uniform block and its fragment loop are untouched. `P_WAVE` is the sum of the
two crest odds it replaced (0.3 + 0.15), and the freed slot went back into the
same pool: between them, collapsing the kinds left the sea neither busier nor
quieter than it was. Two crests may now overlap, and where they cross the water
genuinely stands higher — `hazardHeight` has summed its slots since the day it
was written. There is ONE roll timer and both kinds are drawn on it, so
`hazards.ROLL_PERIOD` moves both frequencies together — retune a single
probability instead. Note `aiboats.ts` exports a `ROLL_PERIOD` of its own on
the same name and a different value (10 s); nothing imports both, and neither
is the other's to retune.

**Every crest rolls its own length, width, height, speed and bow** in `build()`,
so a wave forced by a test or by `?hazard=` is as varied as one the weather
raised — there is no such thing in that file as a crest of the default
anything. No range is weighted toward the middle: the whole point of a size
moving off a constant is that the sea can produce a wave the player has not seen
before, and a distribution avoiding its own ends would be the old single value
with jitter on it.

- **Length** `CREST_HALF_LENGTH_MIN`/`_MAX`, 6 to 24 units of front.
- **Width** `CREST_WIDTH_MIN`/`_MAX`, 1 to 12 units, unchanged.
- **Height** `CREST_HEIGHT_MIN` to `CREST_HEIGHT_MAX_START`, 1.2 to 2.0.
- **Speed** `CREST_SPEED_MIN`/`_MAX`, 2 to 12 units/s — which is 2 to 12 knots,
  since the hull's `MAX_FORWARD` of 10 units/s is what the HUD reads out as
  10 kn. The top of that range is deliberately faster than the ship: a 12-knot
  wave has to be steered out of the way of rather than fled from.
- **Bow** 0 to `CREST_BOW_MAX`, the arc — see below.

**And a crest grows while it lives**: +10% of its length and +5% of its height
a second, both compounding, both recomputed from the wave's age rather than
accumulated, so a long frame or a clamped `dt` cannot leave one wave
permanently smaller than another that rolled the same numbers. Length is capped
at 3x what it rose at and at `CREST_HALF_LENGTH_CAP` (20) absolutely, because
the displacement patch skirts its own displacement from 34 units out and a
front wider than about 40 has ends hanging in undisplaced water. Height is
capped at `CREST_HEIGHT_MAX`, so nothing on screen is taller than the great
wave the game already shipped.

Growth meets the coast clip, whose standing rule is that a broken end never
comes back. Both hold at once because the loss is carried as a **share** of the
wave's ideal length (`MutableHazard.clipRatio`) rather than as a length: the
part of the front that broke on the shore is gone for good, and what is left of
the wave goes on building. Reverse that and a wave whose ends had been pushed
back out over the rock would simply re-break there, flickering once a frame.

**A crest is a bowed front, not a straight wall.** `hazardfield.ts`'s `hazBowV`
displaces the along-travel coordinate by `bow · L · (u/L)²`, so the crest line
runs from the centre back to `bow · L` behind it at each end and the middle of
the wave arrives first. A parabola rather than a circular arc, because
polynomial is the one rule the height field has and the two ports have to stay
bit-identical; over the longest front the difference is under the patch's own
vertex spacing. The bow is a genuine draw scaled by the wave's length, so a long
front tends to be an arc and a short one tends to be a straight stub without
either being guaranteed. `bow = 0` multiplies the term by exactly zero on both
ports, so a straight crest is bit-for-bit the crest the field drew before the
bow existed — the parity probe carries one bowed crest and one straight one for
exactly that reason. Everything that reads the wave reads the same displaced
coordinate: the height field, the art's foam and streaks, the contact test, and
the scope, which draws the mark as a six-segment polyline along the arc rather
than as a chord across it.

**A crest spawns on a lead TIME, not a distance.** `SPAWN_LEAD_MIN`/`_MAX`,
3 to 5 seconds of closing, clamped to `SPAWN_DIST_MIN`/`_MAX` (12 to 32 units):
near enough that a 2-knot wave is not born crawling in the far distance, far
enough that a 12-knot one is still born at full strength inside `FADE_NEAR`. Its
life is likewise rolled as a travel DISTANCE (`CREST_TRAVEL_MIN`/`_MAX`, 34 to
57 units) and divided by its speed, so every wave still crosses its own spawn
band whatever it rolled and no draw puts a wave on the water that could never
have arrived. At the 6 units/s every crest used to travel at, both reproduce
the bands this file always had.

**The push is proportional to the wave's speed**: `PUSH_PEAK · speed / 6`, so
a wave shoves the hull in proportion to how fast the water was moving when it
arrived. The anchor is chosen so nothing gets stronger than the game already
shipped — at 6 units/s the peak is exactly the 5 it always was, and at 12 it is
the 10 the great wave was worth. `DISSIPATE` stays a flat 3 s: a fast wave hits
harder, not longer, or the two would compound into a fast wave carrying the hull
four times as far as a slow one rather than six-fifths as hard.

What the WIDTH does not change is how hard a wave hits: a wide wave is a longer
shove of the same strength rather than a bigger one. It does change the contact
test, which measures against `halfWidth` — a 12-unit wave is genuinely harder to
be missed by, which is the honest consequence of it being wider water.

A crest is a travelling line that
shoves the hull the way the water went — the push is a velocity, added exactly
as the wind's is, so the bow holds its heading and the ship is carried off its
course with the helm still answering. A maelstrom is a 20-unit funnel that
takes the ship outright: the player loses the helm, `HazardState.drive` goes
non-null and `ship.ts` runs no physics of its own until `hazards.reset()`.

**A crest travels with the wind, and only with the wind.** `hazards.update`
therefore takes `WindState`, and the frame loop's existing "hazards after the
wind" ordering now carries a second reason: a crest raised on last frame's
weather would be laid across a bearing the sea is no longer running on.
`crestHeading` projects `wind.direction` onto the tangent plane at the crest's
own centre rather than using it as it stands — the crest is up to 30 units
away, where the ship's tangent plane is a fraction of a degree off.

That rule is also why crests spawn **upwind** (`UPWIND_SHARE`, three draws in
four within 60° of it) rather than ahead of the bow, and why the aim-point
machinery that used to lead the ship by four seconds is gone. Once the heading
is the wind's, placement is the only thing left that decides whether a wave is
ever met: raised upwind it comes down on the hull, raised downwind it leaves at
6 units/s and is never seen. `force()` is the exception and stays explicitly
aimed — it is the test and `?hazard=` entry point, and a debug wave that
wandered off with the weather would be no use for looking at one.

The crest's cross-section is **asymmetric about `v = 0`**: `CREST_FRONT_RATIO`
(0.8) of a half-width ahead of the crest line, `CREST_BACK_RATIO` (2.4) behind,
so the face the hull meets is 2 units of run against 2.4 of rise and the water
lets down over 6 astern. Both are read against the same `halfWidth` the contact
test uses, so widening the tail never widens what the hull can be hit by. The
branch on `v > 0` is safe for parity because the two widths agree to O(v²) at
the crest line itself. A symmetric crest with a flat top and a broad foam wash
was the first cut, and it read as a slab of ice rather than as a sea running.

**The height field is polynomial, plus one `sqrt`, and that is not a style
choice.** The sea's displacement is one function pasted into three consumers
that must agree to the pixel, guarded by `tests/smoke/wave-parity.spec.ts` —
see **The wave field**. Hazards go *beside* `waveField`, never inside it, as a
second function with the same three consumers (the patch's vertex shader, the
fragment shader through the plugin's `declarations`, and the CPU port
`ship.ts` samples) and the same parity guard. `bump(x) = (1 - x²)²`,
`crest(x) = (1 - x²)³`, `plateau`, and a maelstrom bowl that reuses `bump`
itself (it was `(1 - r)³` until that cube's apex was found to be a shading
singularity), all written as multiplications: no `sin`, `cos`,
`exp`, `pow` or noise anywhere in the *height*. Those are the transcendentals
whose last bits differ between a GPU and `Math`, which is what `dev/probe.ts`
already had to design around. The spin of a maelstrom and the froth on a crest
are fragment-side art, in the plugin's `foam` and `colour` hooks, where `sin`
and `snoise` are welcome because nothing on the CPU has to match them.

Local coordinates are dot products, never angles: `u = dot(p, east)`,
`v = dot(p, north)` against the hazard's own tangent frame, times
`GLOBE_RADIUS` for world units. That is the small-angle approximation — at 30
units on a radius of 200 the error is under 0.2%, and both sides make the same
error.

**A crest breaks on the shore, and loses only the part that met it.** Every
frame a travelling crest's centre line is probed along `east` between its own
current ends (`clipToWater`, 24 intervals plus 5 bisection steps), the longest
stretch still over water wins, and `extent` and `centre` are moved onto it —
`centre` slides along `east` onto the middle of what survived, because the
profile in `hazardfield.ts` is symmetric about `centre` and there is no offset
uniform to carry the difference. So the shader, the CPU field the hull rides,
the contact test and the scope's bar all follow from the same two numbers with
no change of their own, and **nothing may cache a crest's `centre` or `extent`
across a frame**. There is no fade on the lost part: it is gone the frame the
water under it turns to land, and a wave with nothing left is dropped outright
rather than dissipated. The clip only ever shrinks — the probe runs between the
current ends, so a wave that has broken cannot grow the lost end back when it
travels clear of the rock, which is both what water does and what stops the
clip oscillating on a bilinear waterline. Only the centre line is probed, not
the crest's 2.5-unit depth, and a wave cut in two by an islet keeps the bigger
half: one hazard is one span in the uniforms, so the alternative to choosing is
a wall of water across the rock.

**The distance fade is what keeps a hazard on the patch.** `waterpatch.ts` is
80 units square and fades its displacement to zero over its outer 15%, from 34
units out. A hazard that left the patch would keep tilting the normal and
foaming on the undisplaced sphere behind it. So every hazard's `envelope` is
multiplied on the CPU by a fade that is 1 within `FADE_NEAR` (32 units of the
ship) and 0 beyond `FADE_FAR` (38), and all three consumers read that one
product — including `radar.ts`, which sets its marks' alpha from it, so a crest
that has dissolved in the water is not still drawn on the scope. A crest that
outruns the patch therefore dissolves rather than turning into a painted
stripe.

**Hazard heights are world units and are not wind-scaled.** The ordinary sea
peaks at `DISPLACE_AMPLITUDE` (0.3) through `uWaveIntensity`; a strong crest is
1.6 and a great one 2.4, flat. The wind raises the ordinary sea, a hazard is
its own weather, and putting one through `waveGain` would make a maelstrom
shallow in a calm. In `ship.ts` this is the one ordering that matters:
`hazardHeight` is added to each of the five hull samples **after** the
`DISPLACE_AMPLITUDE * waveGain` scaling and **inside** the pitch/roll `atan2`
numerators, which are heights in world units. Add it around them instead and
the hull rides a crest without ever tipping on it.

**The plugin is built before `createGlobe` and bound after.** A `WaterPlugin`
can only be woven in while the shader is being assembled (see **The wave
field**), but `hazards.ts` needs `globe.heightMap`, `globe.waterBodies` and
`globe.towns`, which exist only after. So `main.ts` constructs the plugin
empty, passes it into `createGlobe`, then calls `waterHazard.bind(hazards.state)`.
Unbound it writes `uHazCount = 0` and the sea is the sea.

**`wind.ts` needs no change across a teleport, and must not be given one.** It
transports its direction by the rotation between the last and current ship
positions, and a large rotation is still a rotation — the respawn is a single
enormous step and parallel transport handles it exactly as it handles a
sixtieth of a second of sailing. See **Frames, and where they stop working**.
`camera.ts` is the module that *does* need one, and has it: `snap` exists
because damping is a rate, not a distance.

The wreck itself is three calls in `main.ts`'s `onSunk`, in an order the fade
is the whole point of: `energy.wreck()` runs immediately (the HUD is behind the
black sheet, and a power bar halving itself in front of the player would read
as a second, separate event), and everything that MOVES the ship —
`ship.place(hazards.pickRespawn(), …)`, `view.snap`, `hazards.reset()` — runs
inside `blackout.run`'s callback, at the one instant in the game the world may
be rearranged unseen. `blackout.ts` drives its fades with CSS transitions and
`transitionend` **plus a timer fallback**, because a throttled or backgrounded
tab may never fire the event and a screen stuck black is the one failure with
no way out. Its three durations are written twice — there and as the two
`transition` rules in `style.css`'s `BLACKOUT` block — so change them together.

`?hazard=wave|maelstrom` forces one 25 units dead ahead, three
seconds after the first frame. It is guarded through `URLSearchParams` and
never through `import.meta.env.MODE`, on the same terms as `?quality=`: the
owner uses it against a `vite preview` production build, and a 1%-per-10-s
event cannot otherwise be seen inside the testing budget.

## AI boats and the battle
`docs/BATTLE_PLAN.md` is the approved brief and the record of what was
decided; this section is the contract the rest of the codebase has to keep.

Seven modules, one overlay and one more branch in the frame loop. Two raiders
sail the world, and touching either one takes the fight to a **separate
screen**: the world is frozen exactly as it is under the fishing card, and an
arena scene with its own flat ocean and its own camera is rendered instead.

The split is the same one `hazards.ts` and `waterhazard.ts` keep. `aiboats.ts`
is the sim and `aihulls.ts` is what puts meshes where it says; `battle.ts` is
the ruleset and `battlescene.ts` is what draws it. Both sims are DOM-free and
scene-free, which is what makes them the modules the unit tests exercise.

### An orange boat is weather; a red one is an event
`P_ORANGE` is 0.72 a roll and `P_RED` is 0.032 — more than an order of magnitude apart,
on a `ROLL_PERIOD` of ten seconds. That gap is the whole shape of meeting a
raider. An orange boat wanders a track drawn once and never revised: it is
scenery that can be sailed around, and meeting one is the normal condition of
being at sea. A red one steers at the player every frame and ends in a fight
unless it is out-turned, so it interrupts whatever was being done, and an
interruption that arrives every minute is a chore rather than an event.

`P_RED` was cut by four fifths on 2026-09-08 (0.16 to 0.032, the owner's
call), having been doubled from 0.08 the day before. That puts an aggressive
raider at roughly one every five minutes of sailing. `P_ORANGE` went the other
way on 2026-09-09, tripled from 0.24, for the mirror of the same reason: at
0.24 the sea between harbours read as empty for minutes at a stretch, and
orange is the colour the player is meant to keep meeting. At 0.72 a roll all
but always lands, so the rate is governed almost entirely by how long a boat
lives and by the one-per-colour cap — which is the intent. Both figures are
ceilings the sea does not deliver in full — the odds are per roll and per
COLOUR, and a colour already on the water is drawn for and skipped — but the
correction bites almost entirely on orange, which is far more often already
out; at 3.2% red is hardly ever the colour being skipped.

### Both raiders run at the same speed
`RED_SPEED` and `ORANGE_SPEED` are both 15, against the player's `MAX_FORWARD`
of 10. The aggressor is deliberately NOT the faster hull: what separates the two
colours is intent, not pace. A red boat re-aims at the player every frame while
an orange one runs a track drawn once and never revised, so red closes because
it is pointed at you, not because it is quick.

Both are still faster than the player, which is the load-bearing part — neither
can be outrun in a straight line, so avoiding a fight has to be a **turn**. The
escape survives the speed drop and gets easier in degree: at 15 kn against
`RED_TURN_RATE`'s 35°/s the chaser's turning circle is about 25 units where it
was 33, and its whole pursuit leg covers 75 to 120 units rather than 100 to 160.
Any future item that lets the player simply outrun a raider deletes this
arrangement rather than extending it — see `docs/SHOP_PLAN.md`.

### The track and the sway are two different things
A hull's `angle` is where it is ON THE CIRCLE, exactly as it was before the sea
rework: the throttle still moves it, the ring still shrinks under it, and the
heading is still its tangent. What is new is `swayX`/`swayZ`, a displacement
FROM that point written every tick by `battlesea.ts`, and a hull's actual
position — `x`/`z`, and the only place anything should ever look for a hull —
is the sum of the two: track plus sway.

The gun does not fire at the sum. It fires from wherever the hull actually is,
but along the TRACK's own inboard beam, `(-cos angle, -sin angle)`, never
toward the arena centre and never corrected for the sway that moved the
muzzle. With no sway the two lines coincide, which is what the arena has
always thrown: a diameter, muzzle to the point opposite. With sway they do
not: a hull shoved four units west throws a line parallel to that diameter
and four units off it, and the shot lands only if the enemy has drifted onto
the same line. Nothing in `battle.ts` special-cases this — there is no `if`
for a wave spoiling an aim anywhere in the fight. It is what the geometry
above already says once sway exists at all, which is the only reason it was
free to add.

**Anything that assumes a combatant's position is its point on the circle
will be wrong now.** That used to be true — `angle` alone was enough to place
a hull and aim a gun — and it no longer is. A future reader who reaches for
`Math.cos(angle) * radius` where they mean "where is this hull" has reached
for the track and dropped the sway on the floor; the two are only equal while
`swayX` and `swayZ` both happen to be zero, which on a rough sea is most of
the time but never all of it.

### What the AI sees, and the horizon that follows
The AI's read of the player, its telegraph and the ball's own flight are
three separate delays and they stack rather than overlap. `battleai.ts` keeps
a **two-second-old** snapshot of the player (`AI_LAG`) and solves every shot
against it; once it commits, the shot is a further `AI_FUSE` — **1.5 s** —
from going, regardless of whether the solution the AI committed to still
holds by then; and once it goes, the ball is in the air for `2 * radius /
BALL_SPEED`, which is **0.9 s at the opening radius** and shrinks with the
ring. Add the three and a shot the AI commits to lands at

```
2 s (stale)  +  1.5 s (telegraph)  +  ~0.9 s (flight at R0)
```

— **about 4.4 seconds** after the reading it was solved on, at the opening
radius, and less as the ring closes and the flight shortens. A player only
has to touch the throttle once inside that window to no longer be where the
shot was aimed.

The accepted consequence is that **more fights now reach `BATTLE_TIMEOUT`
(120 s) and end STAND-OFF** than did before this rework, because a gunner
solving a problem that stale against a player working the helm is a gunner
that frequently does not solve it at all. This is deliberate for this pass
and is not tuned away blind: `AI_LAG` and `AI_FUSE` are authored to be moved,
but only after the owner has played the result. A change that shortens either
number to make the AI hit more often is retuning a decision the plan
recorded, not fixing a bug, and belongs in a change of its own with the
owner's sign-off — not folded into unrelated work because the fight felt too
easy while it was being tested.

### The sea is switched, and the gunner is measured without it
Two systems — crests that shove a hull off its track, and drifting rafts that
block a diameter and foul whatever they touch — live in `battlesea.ts`, draw
from the sim's own seeded `rng` and nothing else, and are switched together by
one `BattleOptions` value handed to `createBattleSim`. There is no way to turn
on one and not the other; the plan treats them as one "the sea is rough"
toggle, because the question the toggle answers is always the same one — is
the arena moving today, or not.

There were three. **Shoals and wreckage are gone**: rocks that stood still
inside the ring for a whole fight, at a fixed place rolled once. A blind spot
that never moves is learned in the first ten seconds and costs nothing to
respect after that, so it stopped being a decision almost as soon as it was
made. The rafts took over the job of eating a shot, and there are three to six
of them now instead of one, each its own size and its own speed. The crests
were made finite in the same pass and for the same reason: one wave spanning
the whole arena was a metronome, and up to three shorter ones at three speeds
from three directions have to be read rather than counted.

Both are **off** under the dev query `?calm=1`, which `main.ts` reads once and
hands to both `createBattleSim` call sites as `CALM` in place of the default
`ROUGH`, and both are off in **every unit case that measures the gunner**, for
the same reason: a hit rate measured while the target is also being shoved,
having its shots eaten, or slowed by a raft is not a measurement of the
gunner, it is a measurement of the gunner plus whatever the sea did to that
one seeded run. `docs/BATTLE_REWORK_PLAN.md`'s own pinned gunner case
runs on `CALM` for exactly this reason, and any future test that wants to say
something specific about `battleai.ts` should reach for `CALM` rather than
accept `ROUGH`'s default and hope the noise averages out.

### The beat before a fight
A ram does not open the arena. It halts the ship, raises `battlecover.ts` and
freezes the world; three seconds later the card's own count calls `onReady`,
and THAT opens the fight and runs the fade. `main.ts` splits accordingly:
`onContact` is the ram, `onCoverReady` is everything the old `onContact` did
from `createBattleSim` down.

The screen exists because the arena teaches none of its own rules. Three
hits, a gun on a cooldown rather than a locker, a barrel that fires out of the
beam and a helm that is only a throttle are all learnable in one sentence and
not one of them is guessable from the scene, so a player used to arrive
already being shot at by a ruleset nobody had told them. The sentence is built
from `FIRE_COOLDOWN` and `HITS_TO_LOSE` rather than typed into `index.html`,
on the house rule every other overlay figure follows — and the cadence is
stated as shots per second rather than as the cooldown itself, because a third
of a second is not a figure anyone holds in their head while aiming.

**This is a card over a frozen world, and the fight is not.** `battleui.ts`
says "nothing here hides the scene", and that is a rule about the FIGHT: a
result card over a live arena, because a fight that froze would read as the
game stopping. The cover is not the fight. It is on the near side of the fade,
over a world the ram has already halted, and it freezes exactly as
`fishcover.ts` does. The two rules do not conflict because they are about two
different screens.

**`battleUi.open` is deliberately late.** It could have been left in
`onContact` — the world would freeze on `battleUi.isOpen` as before and the
cover would just be a picture on top. It must not be, because `battleui.ts`
latches its fire edge in `tap()` and only drains it in `input()`, which runs
only once `inArena`. A fight open behind the cover would bank a Space pressed
during the count and spend it on the first frame of the arena, firing a round
the player never aimed. Opening the fight after the count means nothing is
listening for Space while the card is up.

Both `[FISH]` and `[SHOP]` therefore test `battleUi.isOpen || battleCover.isOpen`.
A guard on the fight alone would leave a three-second window where a cover
screen could be opened over a ram that has already landed — and once the battle
branch took over, that screen would never be ticked and never be closed.

**The count is on the wall clock, and that is not a style choice.** Everything
else in the frozen branch either runs on the frame loop's `dt` or does not
advance at all; this runs on `performance.now()`, because `dt` is capped at
100 ms and a cap is exactly wrong for a number the player reads as seconds. On
a machine drawing the frozen world at 4 fps — which is what the software
renderer in the smoke tier does — the cap advances the count 0.4 s per real
second and the three-second beat becomes seven and a half. The slower the
machine, the longer the game holds you in front of a card you have finished
reading. `MAX_TICK` (0.5 s) is what keeps the case the cap used to cover: raw
elapsed time would let a tab backgrounded across the count come back with the
whole beat spent, dropping the player into a fight they never saw declared.

The card is taken down inside the fade's `onBlack`, not when the count hits
zero, for the reason the world's instruments are: a card removed on a screen
that is still transparent shows half a second of the world the player is about
to leave, which reads as the fight having been called off.

### The world's instruments come down with the fade
A battle is the one overlay in this project that is **not** a card over a
frozen world. The arena is a live scene, and the HUD would otherwise sit on
top of it still reading the world: a scope plotting a coastline a hundred
units from an arena that has no coast, a SPEED off a halted hull, a WIND
nobody is sailing in. So `main.ts` puts `in-battle` on the document body and
`style.css`'s BATTLE block hides the telemetry panel, the scope and the
activity keys behind it.

The controls guide used to be a fourth entry in that list. It is a pane of the
Escape menu now and never on the HUD, so there is nothing to hide — and the
menu itself cannot be over a fight either, because `canOpen` is false for the
whole of one. See **One owner for the Escape key**.

Two details are load bearing. The class is toggled from **inside the
blackout's `onBlack`**, both ways, at the same point `inArena` flips: the swap
therefore happens on a screen that is already opaque, and hiding the
instruments at `open()` instead would pop the whole HUD out in front of a
player still looking at the sea. And the **helm keys stay**, dimmed rather
than removed for port and starboard: W and S are the throttle on the circle,
and on a touch device that pad is the only way to reach it.

### The player's real hull is reparented, not cloned
For the length of a fight `ship.object` is a child of the **arena** scene, and
`main.ts` moves it there and back inside the two blackout fades. It is the
real hull rather than a copy because `ship.ts`'s `applyTransform` rebuilds
`object.position` and `object.quaternion` from scratch every frame, so the
arena can drive the object directly and the first world frame after the fight
puts it back where the state says. The alternative was a second copy of a 5 MB
model's materials, with its own neon and its own charge dimming to keep in
step.

Two things follow, and both have to be held on to:

- **Any future code that assumes `ship.object` never leaves the world scene
  will be surprised.** It leaves twice per fight.
- **The parent is read, never assumed.** `main.ts` captures
  `ship.object.parent` and the AI clone's parent on the way in and adds each
  hull back to what it captured, rather than to `scene`. The clone's owner is
  `aihulls.ts` and where it keeps its pool is that module's business.

Both moves happen inside `blackout.run`'s `onBlack`, which is the one instant
in the game the world may be rearranged unseen. `inArena` is what says which
scene is being rendered, and it is false for the whole of the first fade and
true for the whole of the second, so the cut between two scenes is always
under an opaque screen.

`ship.update` is not called during a fight at all. The sail and the flag
therefore hang still in the arena; animating them would need `shipfx.ts` to
learn to tick without a hull update, and that is out of scope.

### The arena sea is not the globe water, but it is the same wave

> **Dormant.** A fight is staged on the globe's own water now and
> `battlescene.ts` builds no sea plane at all, so nothing below is on screen
> during a fight. It is left standing because `battlewave.ts` is still
> compiled and the crest meshes still exist, both switched off rather than
> deleted — docs/ROADMAP.md stages that deletion at step 3. See **The fight
> happens in the world**.

`battlewave.ts` builds the arena's plane and its crest, and it **must never
import `water.ts` or `waterpatch.ts`**. The globe's water is a full sphere at
`GLOBE_RADIUS` carrying a depth ramp, an inland mask, a foam pass, a wake map,
a reflection cube and every registered `WaterPlugin`; the arena is 300 units of
flat open ocean with nothing under it and nothing to sample. Reaching for the
real water here would drag all of that into a scene that has no ship state to
feed any of it.

The arena is a **flat plane in world units**: plain `x`/`z` metres about its
own centre with `+y` up, and nothing in it is on the globe. The hull is drawn
at `MODEL_SCALE` and mounted at `MODEL_MOUNT_Y`, exactly as in the world, so
the two scenes agree about how big a ship is.

**What they now also agree about is the water itself, and that is a change.**
The arena used to run two octaves of plain `snoise` for its sea and a flat
translucent quad for the wave crossing it, with its own copies of the two
wavelengths and a note saying nothing may come to depend on them staying equal
to the globe's. That note has been overruled deliberately: smooth noise gives
rounded blobs where the ocean's ridged octaves give the creased crest lines the
sun glitter runs along, and a quad has no front face to meet, no lip to break
and no silhouette at all. Side by side with the sea outside the fight it read
as an older draft of the same game. Four things are now SHARED CODE rather than
a second description of the same idea:

| what | from | why it cannot be copied instead |
| --- | --- | --- |
| the ridged three-octave field | `waterglsl.ts`'s `waveField`, rewritten for the xz plane | the `ridge()` fold is the whole difference between crest lines and blobs |
| the wavelengths and stretch axes | `waveconstants.ts` | already the one source the GPU and CPU ports read; the arena is now a third |
| the crest's profile | `hazardfield.ts`'s `HAZARD_PROFILE_GLSL` | the identical characters both shaders compile — see below |
| the crest's art | `hazardcrest.ts`'s constants | retuning a wave at sea has to retune the one in the arena |

`HAZARD_PROFILE_GLSL` and `HAZ_CREST_RATIO_GLSL` are a **pure split** out of
`HAZARD_GLSL`: the two chunks are spliced back into it in place, so the string
the globe compiles is byte-identical and `tests/fixtures/hazard-shader.json`
did not move. That is the proof the split cost the sphere nothing. The chunks
declare no uniform, which is what lets the arena take the shapes without the
sphere's slot block coming with them.

**The frequency bug this uncovered.** The globe's `freq()` is
`GLOBE_RADIUS / wavelength` against a UNIT DIRECTION vector, and an arc of `s`
world units subtends `s / GLOBE_RADIUS` radians — so it advances the noise by
one unit per wavelength of surface, i.e. `1 / wavelength` against a world
position. The old arena shader multiplied by `2 * PI / wavelength`. Its
"22-unit swell" was really a 3.5-unit one, six times too small, which is most
of why that sea read as noise rather than as water.

Two departures from the globe are deliberate and marked at the line they
happen. The arena is entirely near field for the LOD's DISTANCE term (the
camera sits 43 units back), but the grazing term and the distance fades are
computed rather than compiled in at 1 — a 300-unit plane under that camera
reaches four times as far at the corners of the frame, and full chop out to the
last of them was the one thing about this sea that still read as a texture.
And the night sea sits at `NIGHT_FLOOR` (0.22 of base) against the globe's
0.075: out at sea a night ocean may go almost black because the player has a
lantern, a wake and a coastline to read the world by, and in the arena there is
a fight on the water and nothing else in the frame.

The crest itself is a 120x40 grid in its OWN frame — x along the front, z
across it and positive the way the wave travels — yawed onto whichever of the
four cardinal axes `battlesea.ts` rolled. That is what lets the vertex shader
raise the profile straight out of `position.xz` with nothing to un-rotate, and
it replaces the old quad's trick of swapping its own scale for an east/west
crest. `CREST_WIDTH` (3) now does three jobs rather than two: the heave-and-roll
proximity the hull is rocked by, and the half-width the wall is actually built
on, so the wave a player sees is the wave the hull is riding. The mesh's own
skirt lies flat on the sea and is faded out by the profile mask in the alpha
channel — the sea's waves are a per-pixel normal on an undisplaced plane, so a
skirt that rose with the field would part company with the water beside it.

### The rim patch goes on before `postFx.adopt`
`rimglow.ts` installs an `onBeforeCompile` hook on every
`MeshStandardMaterial` under a cloned hull, and `postfx.ts`'s sRGB self-encode
patch **chains** after whatever hook a material already carries. So the order
is fixed: install the rim first, adopt second. Adopt first and the encode
patch captures an empty hook, the rim's own `onBeforeCompile` replaces it
outright, and the clone renders unencoded. See **Post-processing** for the
`customProgramCacheKey` trap that makes this worse than it sounds: two
differently-hooked materials that collapse onto one cache key silently render
with each other's code.

`aihulls.ts` is the only module that adopts a clone, and it does exactly this.
Nothing else may adopt one.

### Suppression, and where the verdict lives
No raider spawns, closes or touches the hull while the ship is **docked**,
while a **blackout** is running, or while a **maelstrom** has the hull.
`main.ts` computes that as one expression and hands it to `aiBoats.update`,
because all three terms are owned by other modules: `energy.ts` owns the
project's single definition of docked, `blackout.ts` owns whether a fade is
running, and `hazards.ts` owns the phase. A sim that re-derived any of them
would be a second definition free to disagree with the first.

Overlays are not in that verdict and must not be added to it. The loop does
not call `aiBoats.update` under one at all, so a contact under a card is not
possible: a fight opens from `onContact`, which halts the ship and flips
`battleUi.isOpen` synchronously, and by then no overlay is up.

The other direction does need a guard, and `[FISH]` and `[SHOP]` carry it.
Unlike every other overlay in the project, the battle's is a HUD over a LIVE
scene rather than a card over a frozen one: it paints a strip, a key and a
card and is `pointer-events: none` everywhere else, so the telemetry panel and
its two keys stay on screen and stay pressable underneath it. And the battle
branch is tested first, so a cover screen opened over a fight would never be
ticked and never be closed. Both buttons therefore test `battleUi.isOpen`
alongside the four overlays and the hazard phase.

A red boat that reaches a docked ship gives up and turns orange. That is the
rule, not a bug.

### The outcome is rolled once, and it is rolled early
The result card prints the gold and the power the player **actually got**, so
the roll and the payment happen the frame `outcome` first becomes non-null,
not on CONTINUE. `main.ts` latches that with `outcomeSettled` rather than
testing `outcome` alone, because `battle.ts` keeps the boats circling and the
balls flying after the fight is decided: the card sits over a live scene, and
the frame that ended it is followed by however many the player leaves the card
up for. CONTINUE only runs the second fade.

The three payouts go through `bounty.ts`, which is pure, and then through
`wallet.ts` and `energy.ts`, which are the only writers of gold and charge.
`wallet.lose` is best-effort where `spend` is all-or-nothing, and that
difference is the whole reason it exists: a purchase that cannot be paid for
must be refused whole, but a defeat is another captain going through the hold,
and an empty hold does not save a player from having lost.

`energy.defeat` reaches the backup cell through `battery.draw` and never
through a setter, because `draw` is what notifies the cell's subscribers and
the only subscriber is the save file. A defeat written straight into
`battery.level` would leave the run playing on a cell the reload puts back.

## Towns, berths and the dock zones
`towns.ts` owns settlement placement, which used to live inside `citylights.ts`
and be thrown away as soon as the lights were scattered. Four modules need those
positions now, so the search moved out and `citylights.ts` became a consumer like
the rest — it draws its own PRNG stream from `TOWN_SEED ^ 0x9e3779b9`, so the
lamps shifted once, deliberately, and are fixed from here. Town positions did not
move.

**Every town is a port.** A candidate that cannot find a berth is not founded
at all, so `Town.dock` is non-null for every town in `all` and the fleet is the
map. `CLUSTER_TARGET` came down a quarter with that rule, 76 → 57, because
76 towns used to yield 48 berths and leaving the target alone would have handed
the player half again as many places to charge. It came down again on the
owner's call, 57 → **40** (2026-09-07). It fills in under 6000 of its 20000
tries.

It is a TARGET, not a count: a candidate that cannot find lowland, open coast,
room from its neighbours or reachable water is simply not founded, so the world
gets at most this many and can get fewer. At seed 1337 it gets exactly 40, and
`world-golden.json` pins that — `townCount` and `dockCount` moved together,
which is the golden's own restatement that every town is a port.

`CLUSTER_MIN_ARC` was deliberately NOT relaxed to spread 40 towns over the same
coastline. The spacing is what every berth-overlap argument here leans on, and
a world with fewer ports should read as emptier rather than as evenly thinned.
Nothing else was retuned with it: the reserve, the solar rate and the 2%/s
shore rate are untouched, so what the player feels is the same tank across a
wider gap between charges.

The berth search still draws **nothing** from the PRNG — only from the height
map — so the random stream advances exactly once per candidate whatever the
search decides, and retuning it moves which candidates survive without moving
which are offered. Keep it that way; a berth test that rolled a die would move
every town downstream of it.

A town earns a `Dock` only if the ship can actually reach it. `waterbodies.ts`
is the authority — its flood fill from the spawn point *is* the water the player
can ever sail on — so a town on a landlocked lake gets no berth however coastal
the height map thinks it is. The berth then has to survive a rim test: the
outward walk only promises water directly seaward, which the head of a creek
satisfies while its ring lies on the bank, so three quarters of a ring sampled at
`DOCK_RADIUS` must be over reachable water. Not all of it — a berth inside a
harbour *should* have land behind it. Now that a failed search costs the town
itself, `BERTH_CLEAR` is the sharpest edge in the file: raise it and the map
empties out, lower it and the fleet starts finding berths in ponds.

Zones are 8 world units against a 19-unit minimum town spacing, so two cannot
touch; where the geometry conspires anyway — two towns either side of one strait
— placement rejects the second outright, so `Towns.dockAt`'s no-overlap promise
holds by construction rather than by arithmetic.

`docks.ts` draws all 48 berths in **two draw calls**: one merged ring mesh and
one merged beacon mesh, with the berth index arriving as a vertex attribute and
the ship's whereabouts as a single uniform. A frame is four scalar writes; no
buffer is touched. Ring vertices are sampled on the sphere, not laid out on the
tangent plane — at radius 8 a flat disc's rim sinks 0.16 units under a sea that
sits at exactly `GLOBE_RADIUS`, which is more than `RING_LIFT` clears.

The beacon masts exist because `citylights.ts` is night-only: without them a
port is invisible in daylight and the whole refuelling loop is unfindable for
half of every day.

Two traps, both paid for once:

- **`active` is a reserved word in GLSL ES.** Both dock shaders used it as a
  local and neither compiled. Nothing in the TypeScript build can see this —
  `tsc` and Vite treat a shader as a string — so it costs a green build and a
  scene with no dock rings in it. The locals are named `berthed`.
- These are `ShaderMaterial`s, so they sit outside `postfx.ts`'s self-encode
  patch **by design** and each does its own linear→sRGB on the last line, as
  `water.ts` does. Every material is built at construction; one created lazily on
  first dock would miss the patch *and* have no encode of its own.

The 3 units/s charging limit lives in `energy.ts` and reaches the rings only as
`EnergyState.mode`, so an amber ring can never disagree with the power plant
about whether it is paying out.

## Charted harbours, the ship's beam, and the course

Three navigation aids, one rule under all of them: **a harbour is known by
NAME, and only a known harbour is a place you can aim for.** `knownharbours.ts`
was already that list and already persisted; nothing here adds a second one.

**Uncharted beacons.** `createDocks(towns, known)` reads the set live. A berth
whose name is not in it draws its mast at `UNCHARTED_HEIGHT` (a quarter) and its
lamp at `UNCHARTED_LAMP` (a tenth), which is under the bloom threshold, so the
beacon stops being a point of light. The beacons are one merged mesh, so the
state is a `uCharted[DOCK_COUNT]` uniform array indexed by the `aDock` attribute
already there, and a new mooring costs a uniform write. Two things had to be
right for that to work:

- **A uniform array needs a compile-time length.** `DOCK_COUNT` arrives as a
  `define`, floored at 1 so a world with no berths still compiles.
- **Lower along the berth's own axis, never along `normalize(position)`.** The
  lamp's six vertices sit a lamp-radius off the mast either side, so each one's
  normalised position points a slightly different way, and lowering along those
  shears the octahedron. The berth's `dir` goes in as an `aAxis` attribute.

The level eases linearly over `CHART_EASE` (1.2 s) and starts at its target, so
a boot does not raise every remembered beacon out of the sea at once. The name
label rides the same level down, so an uncharted harbour's name does not hang
six units over a stub.

**The beam.** `shipbeam.ts` is one quad turned about the local up in the vertex
shader to face the lens, fading on `FollowCamera.zoom` between 0.45 and 0.85 and
breathing between 35% and full on a 2.6 s period. Two numbers were measured
rather than chosen:

- **A world width alone was a two-pixel thread from the far framing** and was
  lost against a lit sea, so the half width has a floor of 7 SCREEN pixels,
  computed per vertex from the distance to the lens and
  `2 tan(fov/2) / viewHeight`.
- **45 units read as a stub.** The far framing looks down on the hull, so the
  column is heavily foreshortened in exactly the view it exists for; it is 80.

It is drawn after the cloud deck (`renderOrder` 50) and additive, because the
point is to find the ship from above the weather, and it is excluded from the
reflection cube so the sea under the hull does not double it.

**Picking.** `harbourpick.ts` does not raycast. A beacon is a three-sided stick
and a sprite, and a player aiming at one from orbit is aiming at a few pixels,
so each beacon is projected as a SEGMENT from its mast foot to the top of its
label (`Docks.markers()`, at this frame's charted height) and the click takes
the nearest within 28 px. A beacon is skipped only when both ends are over the
horizon — the segment from the lens passes through a sphere shrunk to 0.995 of
the radius, so a point ON the surface is not hidden by the surface it stands on.
Presses are paired by `createDoubleTap` (350 ms, 30 px) on raw `pointerdown`
rather than on `dblclick`, which a touch screen does not reliably send. It
listens on the canvas alone, so a press on a HUD key never counts, and it refuses
while anything else owns the screen, on the [FISH] key's list.

`course.ts`'s `pickCourse` is the whole rule, shared by the double-click and the
HARBOURS page's `SET COURSE`: an unknown name is refused with a toast, the
current course toggles off, anything else replaces it. The course is saved as
`destination`, a name or null; a save without the field repairs to null, so
`SAVE_VERSION` did not move. A name this world cannot place is KEPT, on the
`knownHarbours` terms, and simply draws no line.

**Arrival clears the course on the TRANSITION.** `main.ts` keeps
`lastMooredAt` and clears only on the frame the ship comes alongside its
destination. Clearing on every docked frame would clear a course set for the
harbour the ship is already moored at on the frame after it was set; and the
field is seeded with wherever the ship boots, so a save moored at its own
destination does not announce an arrival nobody made.

**The line.** `courseline.ts` samples 256 points of the great circle
(`sampleArc`, which handles identical and antipodal ends) at `LINE_LIFT` 0.5
over the sea, and builds a ribbon rather than a GL line, which is one device
pixel wide on every browser that matters. Width is held at 1.6 px a side the
same way the beam's is. The dots are phased by distance **from the berth**:
phased from the ship they travel with the hull and crawl over the water; phased
from the berth, a dot stays over the same patch of sea and the ship sails past
it. The spacing tracks the lens's distance from the hull, clamped to 1.2..9
units, so the rhythm reads the same on the deck and from orbit — at the cost of
the dots sliding while the player zooms. The arc is re-laid only once the hull
has moved one world unit, which is well inside the 4-unit fade at the ship end.

It is depth-tested against the terrain, so land hides it where the great circle
crosses, and like the beam it is drawn after the cloud deck. The fragment shader
names its mark `mark`: `dot` is a GLSL built-in, and shadowing it is the kind of
thing `tsc` cannot see and a browser refuses to compile.

## Fishing
`docs/FISHING_PLAN.md` is the approved brief and the record of what was
decided; this section is the contract the rest of the codebase has to keep.

Seven modules, one HUD button and one branch in the frame loop. It is the first
thing in the project that **stops the world**, and the first that persists
anything across a reload.

### The pause contract
`main.ts` holds no `paused` field. Every frame it asks the two overlays:

```ts
if (
  fishing.isOpen || fishBook.isOpen || shop.isOpen ||
  fishCover.isOpen || battleCover.isOpen || menu.isOpen
) { /* frozen frame */ return; }
```

**Derived, not latched.** The fish book closes on its own Escape key and its
own close button, and it tells nobody when it does; a flag set where `open()`
is called would strand the world stopped the first time a player dismissed the
book. The cost of deriving it is a contract on the two modules: `isOpen` must
be a **live getter**. A module returning a plain `false` property — which is
what the stubs did — would freeze the game the first time it opened and never
thaw.

Exactly five things run in a frozen frame:

| Call | Why it is not skipped |
|---|---|
| `energy.update(dt, restingShip, env)` | a session costs half the tank and the sun is still up. Recharging *through* one is the point, and the ship may be at a berth |
| `fishing.update(dt)` | the sim and its canvas — guarded on `fishing.isOpen`, so the fish book alone does not tick a session that is not running |
| `hud.update(...)` | the power bar is still moving, and it is the thing the player is watching |
| `postFx.render(0, scene, camera)` | a resize while the card is up rebuilds the composer's targets, and a target that is never rendered into is a black screen behind the card. The `0` is what makes it a freeze rather than a slow-motion world |
| `controls.endFrame()` | `zoomDelta` accumulates from the wheel whether anything reads it or not. Without this, a player scrolling under the card banks a minute of notches and dumps the lot into the camera on the frame it closes |

Everything else is skipped, and skipping it is the freeze: no wind, no ship, no
camera, no `globe.update` — so `env` is not rewritten either and the sun the
panels see is the sun that was up when the card opened, which is the "frozen
sun's elevation" the brief promises.

`controls.ts` keeps its listeners through all of this. Nothing reads
`InputState` while paused, but key *releases* are still tracked, so a W held
across a session does not stick to the throttle when it ends. `fishing.ts` adds
its own `window` keydown for Space and Escape.

### One owner for the Escape key
`menu.ts` opens AND closes on Escape, in a single `window` listener, and that
is not tidiness. Split across two — `main.ts` opening, `menu.ts` closing — one
press would reach both handlers and the menu would open and shut on the same
event, with the registration order of two listeners deciding whether the player
saw anything at all. So the key has one owner.

What `main.ts` keeps is the *permission*, as the `canOpen` callback, because
the answer is "nothing else owns the screen" and `menu.ts` cannot see a fight,
a cover card or a hazard phase. A callback rather than a flag, for the pause
contract's reason: a value read once at construction is a lie by the second
frame.

The other overlays are deliberately **not** in `canOpen`. Each closes on its
own Escape, guarded on its own `open`, so a press that dismisses the fishing
card would otherwise open the menu behind it on the very same event. Leaving
them out means Escape closes what is in front of you, and opens the menu only
when nothing is.

`battleui.ts` still does not handle Escape at all, and the menu inherits that:
`canOpen` is false for the whole of a fight and its cover. A fight the player
can pause is a fight with no stake in it.

### The resting snapshot
Energy is billed against a snapshot of the ship with the engine pinned at zero,
never against the live state:

```ts
const restingShip = { ...ship.state };   // built once, refreshed in place
restingShip.speed = 0;
```

`ship.halt()` has already zeroed the speed by the time the first paused frame
runs, so on that frame the two agree — the snapshot is there for the frame
that *straddles* the purchase. `open()` is called from a pointer event, which
lands between frames but after the frame that billed the hull for its last
knot; pinning the speed here means a session can never be charged at
travelling rates however the timing falls.

Two details that are load bearing:

- **It is built once and refreshed in place.** This runs at 60fps for as long
  as a card is open, and a fresh object per frame is a collection pause in the
  middle of a mini-game.
- **The vectors are shared by reference, not copied.** `position` and `up` are
  the two fields the berth and solar rules actually read, and they are the same
  `Vector3` objects `ship.ts` mutates — the same rule `EnergyState` and
  `WindState` are handed out under. Only the scalars are copies, which is why
  `Object.assign` refreshes them rather than the snapshot being built once and
  trusted forever.

### Where the 50% goes, and why the world resumes from rest
The charge is taken **inside `fishing.open()`**, through `energy.spend(0.5)`,
and nowhere else. `open()` returns `false` and leaves the tank untouched if it
cannot pay, so a refusal is not a half-purchase. `hud.ts` puts a `disabled`
attribute and a `Needs 50% power` title on `[FISH]` below that level, but that
is an **affordance and never the lock** — the HUD cannot spend anything, and
`open()` re-tests on its own account.

`main.ts`'s `onOpen` hook calls `ship.halt()` before the first frozen frame
runs — `open()` flips its own flag and calls the hook synchronously inside the
click, so no frame of the loop ever sees an overlay up over a ship still
making way. A ship that kept its way through a paused minute would have travelled
nowhere and would leap forward on the frame the card closes, having banked
sixty seconds of momentum against zero seconds of ocean. `halt()` also unwinds
`bankRoll`, because a hull leaning into a turn it is no longer making reads as
a bug in the still frame behind the card. Nothing about *where* the ship is is
touched: it is a stop, not a teleport.

The power is not refunded on an abort. Escape ends the session and shows the
summary; it does not undo the purchase.

### The cover screen, and where the power gate lives
`[FISH]` no longer starts a session. It opens `fishcover.ts` — one piece of
art and two doors, START FISHING and FISHING RECORD — and the record's own key
has come off the dock, because a dock carrying a menu is not a set of
controls.

The screen knows nothing about either destination; `main.ts` hands it two
callbacks. Four things about the arrangement are deliberate:

- **The art says where the ship is.** Alongside a berth the screen wears
  `Activity - Fish in harbor - Cover.webp`; at sea it wears the open-water
  plate. `fishcover.ts` toggles one class (`fishcover--harbour`) and
  `style.css` owns everything that follows, the same split the HUD's `.pwr`
  and `.wnd` rows use. The verdict comes from `energy.mode === 'docked'` —
  the project's single definition of berthed, shared with the `[SHOP]` key and
  `wind.ts`'s shelter — and it is read **on open, never in `refresh`**:
  `refresh` runs every frame the screen is up, the hull is halted but not
  anchored, and a gust or a hazard's push can still carry it out of the ring.
  A background that changed under the player mid-read would be the screen
  redecorating itself for no reason they can see.

- **`[FISH]` is no longer gated on power.** It opens a menu, and a menu must
  not be locked by the price of one thing on it — a player with a flat battery
  is exactly the player who wants to look at their record. START FISHING
  carries the gate instead, which is where the charge is actually made. It is
  still an affordance and not a lock: `fishing.open()` re-tests the plant and
  refuses on its own account, and `onStart` hands the answer back so a refusal
  leaves the cover up rather than closing onto nothing.
- **FISHING RECORD does not close the cover.** The record's overlay is
  `z-index` 40 and the cover is 20, so it opens on top and closing it comes
  back to the cover with no coordination between the two modules at all. The
  fishing card is 30, between them, and START FISHING closes the cover first —
  a session replaces the activity screen rather than sitting on it.
- **The screen is redrawn every frame it is up.** The world is frozen but the
  power plant is not, so a player who opens it at a berth on 40% watches START
  FISHING come alive without touching anything — the same reason FISH AGAIN on
  the summary is re-read rather than set once.

The art is a CSS `background-image` on an element that ships `display: none`,
so the 2.6 MB file is not fetched until the screen is first opened. The
element carries the painting's own deep navy as a `background-color`
underneath, which is what that first beat looks like.

### Card units
The simulation runs in **card units** and knows nothing about pixels: x in
[0, 1] across, y in [0, 16/9 = 1.778] down from the top, which is the card's
own 9:16 aspect. The waterline is at y = 0.28, the harpoon pivots at
(0.5, 0.30), the five fish rows are centred at 0.55 / 0.78 / 1.01 / 1.24 /
1.47, and a fish is 0.06 card widths long before its `size` multiplier.

`fishrender.ts` scales that to the canvas through one `setTransform`, sizing
the drawing buffer to `clientWidth x devicePixelRatio` (capped at 2) on open
and on resize. This is the same split `radar.ts` keeps and for the same
reason: a sim written in pixels would have to be retuned every time the card
changed size, and every constant in `FISHING_PLAN.md`'s geometry table would
mean something different on a phone.

### Persistence
`save.ts` owns one versioned localStorage key and `createRecords()` is its
only entry point — it loads the file, builds the wallet, the fish book, the
backup cell, the harpoon locker and, as of `docs/SHOP_PLAN.md`'s Navigation
and Fishing items, the Sea Anchor, Overdrive Coil, Chum Drum and Barbed Heads
stocks and the Trim & Sheathing, Moonglass Array, Arc-Lamp Rig and Efficiency
Governor tiers, and subscribes all twelve to a writer. Separate calls would let
a caller wire some of them and end up with a save that silently stopped
updating for the rest.

**The shop's fields were added to version 1 rather than bumping it, twice
over.** A version bump means "every field below is of unknown meaning", and
that would be false of a pre-shop (or pre-Navigation, pre-Fishing) save: it is
a perfectly good file whose owner never bought that thing, which is exactly
what absent-means-zero gives back. Every one of the ten stock/tier fields is
also clamped to its own ceiling on the way in, because an edited file claiming
900 harpoons — or a Trim tier of 40 — is the cheapest cheat there is. See
`save.ts`'s comment on `SAVE_VERSION` for the current, exact field list.

**The cell's range doubled without a bump either.** `reserve` is clamped on the
way in to `BATTERY_CAPACITY * 100`, which went from 50 to 100 when the ship
gained a second cell slot, so an old save's 0-50 is still a legal 0-100 value
and needs no migration. The clamp reads the constant rather than a literal,
which is the only reason that was free.

**The cell is the only saved thing that moves continuously**, and it is why
`battery.ts` notifies its subscribers on the *persisted* figure — whole percent
of a main tank — rather than on every draw. Without that, a ship burning
through its backup would write `localStorage` sixty times a second for a number
read back exactly once, at boot. The rounding is downward, so a reload never
hands back more charge than was aboard.

Gold reaches the HUD by **subscription, not by polling**: `wallet.onChange`
fires once immediately with the current figure and again only when it moves, so
the GOLD row costs nothing between catches and cannot be a frame behind one.
It is the only reading on the telemetry panel not taken off a live sim state
each frame.

**Gold is grouped from four digits up**, with a thin space: `1 565`. The same
purse is printed in five places now — the telemetry row, the card's chrome, the
book's footer, the chandlery and the battle strip — so the rule is one rule;
the one failure that matters is the HUD reading `1565` while the book reads
`1 565`. `FISHING_PLAN.md` contradicts itself on this (its prose says no
separator under 10 000, its mock-ups group from four), and the mock-ups won.
The separator is written out by hand rather than through `toLocaleString`,
which would print `12,400` here and `12.400` on a German machine: the HUD is
one instrument in one language.

**Write the separator as `' '`, never as the character.** Two of the five
had been flattened to an ordinary space (0x20) at some point and nobody saw it:
a thin space and a plain space are identical in a diff, they survive a build,
and on screen the difference is a fraction of an em on a figure most players
glance at. So the chandlery and the battle strip disagreed with the HUD about
the exact thing this rule exists to keep them agreeing on — the failure the
paragraph above names, arrived at from the one direction it did not anticipate.
`hud.ts` was the only file that had written the escape and the only one still
correct, which is the argument for the escape by itself. `tests/smoke/game.spec.ts`
is what finally caught it, asserting `10 000` on a real click.


## The leviathan hunt
`docs/LEVIATHAN_PLAN.md` is the MVP's brief and
`docs/LEVIATHAN_PHASE2_PLAN.md` is phase 2's; this section is the contract the
rest of the codebase has to keep. No HUD button, and **no branch in the frame
loop**, which is the whole of what makes it different from everything above it.

### The modules, and the one rule between them
Two modules own every rule and eight draw or sound what they are told.

| Module | Owns |
|---|---|
| `leviathan.ts` | The animal: the roll, the chained body, the turn, the flee, the coast steering, the gate, the endings, the purse's caller |
| `huntsweep.ts` | The needle and the money: the sweep, `damageAt`, `LEVEL_MULTIPLIER`, `huntGoldFor`. Pure functions, no state, no DOM, no `three` |
| `leviathanshadows.ts` | The body as sprites — the `low` tier's path |
| `leviathanwater.ts` | The body as a darkening term in the water shader — `medium` and `high` |
| `huntreticle.ts` | The gate, drawn on the water |
| `hunttells.ts` | Birds and spouts |
| `huntfx.ts` | The throw: line, splash, spray, ink, the dive swell |
| `huntnumbers.ts`, `huntpointer.ts`, `screenfx.ts` | The screen layer |
| `leviathandial.ts` | The bar, and the only place `Space` is bound |
| `huntaudio.ts` | Cues to voices, on `audio.ts` |

**The rule: one sim, many views, one fan-out.** The sim emits a `HuntCue`,
`main.ts` hands it to everyone who cares, and no view knows another view
exists. This is the `aiboats.ts`-to-`aihulls.ts` split extended to eight
consumers, and it is what keeps the whole of the hunt testable under node with
no DOM and no scene.

**Cues are not events.** `HuntEvent` is money and the notification strip and
has exactly one consumer; `HuntCue` is pictures and sounds and has six. They
are separate types because folding them together would put `wallet.add` behind
a switch that six view modules also read, and the first bug from that is a
splash ring able to pay gold.

### Two shadow renderers, and why both
`quality.huntShadows` picks one. The shader term is the right answer — a term
INSIDE the surface cannot be above or below it and has no height to tune — but
the `low` tier is the software rasteriser the browser tier runs on, and a
fragment loop over fourteen segments there is a real cost. So both are built.

This is also a debugging contract: `sprites` on the debug hook is 0 on the
shader tier by design and a BUG on the sprite tier, and `shadowPath` is what
tells the two apart. "Illegible" and "absent" look identical in a screenshot
and only one of them is a design trade.

### The gate is a word, not a boolean
`HuntState.gate` says WHICH of five conditions is failing, in the order a
player meets them: `far`, `arc`, `close`, `dry`, `suppressed`. The reticle
colours by it and the dial's hint prints it, so the shape on the water and the
text in the HUD can never tell the player two different stories. This is the
single biggest onboarding fix phase 2 made, and it is one field.

### The sweep starts at the red edge
The MVP reset a clock to zero and read `sin(0)` — the middle of the bar, worth
very nearly 100 damage — so tapping `Space` on the frame the gate opened beat
reading the needle. `huntsweep.ts` starts at `cos(0)`, the edge, worth nothing,
and refuses a press for `ARM_UP` while the needle visibly charges.
`tests/unit/huntsweep.test.ts` holds the 1 000-trial mash case that keeps it
honest.

### It is not an overlay, and that is the feature
Fishing, the chandlery, the contract board, the fish book and the menu are all
the same shape: a card over a frozen world, listed in **The pause contract**. A
fight is the one thing that is not, and it is only half not: since the
`battlescene.ts` rework the clock runs through a duel, but the player has no
helm in one (`battle.ts` computes in flat metres in a tangent frame pinned at
the ring's centre, and W/S only move a combatant along the circle).

A hunt runs on the **sailing branch**. Nothing is halted, nothing is dimmed,
and the player is steering the entire time. It is therefore the first activity
in this project played with the actual helm, and the first whose distance is a
great-circle arc rather than flat metres. Both of those are load-bearing rather
than decorative: the activity IS the pursuit, and an implementer who moves it
behind a cover screen has deleted the feature while leaving every line of it
compiling.

### The gate is the design
`leviathan.state.armed` is true only when all four of these hold:

1. the marked shadow is inside `HARPOON_RANGE` (12 units, four hull lengths);
2. and outside `HARPOON_MIN_RANGE` (5 units, under two);
3. it is within `BOW_ARC` (30 degrees) of the bow;
4. the locker has at least one spare;
5. `main.ts`'s `suppressed()` is false.

Three of these are interesting. Without the **arc**, the dial is
`fishsim.ts:684`'s sine with a different readout and the helm does nothing:
proximity alone is the fishing card played outdoors. The shoal reroll (a turn
of up to 60 degrees every 5 to 10 seconds) is what keeps satisfying the arc a
continuous act of steering rather than a one-time approach.

The **floor** is not symmetry with the ceiling, it is what makes the arc
satisfiable at all. Without it the gate is unreachable at point blank, and not
as an edge case: the player's whole instinct is to close, and the bearing to
something the hull is standing on swings past ninety degrees. A browser probe
sailed the ship onto the marked shadow and read `markRange` 0.18 with
`markOffBow` -88.4, having never armed once on the way in. It is the same
geometry `aiboats.ts` leans on from the other side, where a bearing that swings
faster than a chaser can turn is exactly what makes a raider shakeable. It also
says something true: a harpoon is thrown at water ahead of the ship, not at
water under it, so overshooting now costs a pass.

Without the **locker check**, an empty locker would be a press that silently
did nothing. Instead the bar stays dark and a `dry` event puts one line on the
strip naming the chandlery, once per shoal. A player can always fish, because a
fishing session has ten harpoons of its own, so an empty locker is never a
soft-lock; it is the shop teaching itself.

**A new captain therefore starts with one bundle already in the locker.**
`save.ts`'s `EMPTY_SAVE` carries `harpoons: 5`, and it is the only field there
that is not a zero. Without it a new player's first shoal was one they could
watch and could not touch: they would have had to fish, earn about 500 gold,
reach a berth and buy a bundle before a second shoal would arm. Five is exactly
`HARPOON_BUNDLE`, so the first hunt is free and the shared-locker economy is
untouched from the second one onward (owner's call, 2026-09-11).

It reaches only genuinely new players. `sanitize` reads every stored field on
its own and defaults a missing one to zero, so a save written before the
chandlery existed still opens with an empty locker: absent is not damage, and
it is not a gift either.

The gap was found by `?hunt=armed` failing to arm in a browser while every unit
case passed, because every unit case hands the sim a stocked locker and the
game did not.

### One ramp, five bands
`damageAt(p) = round(100 * (1 - |p|))`. The five colour stops `style.css` paints
are a READOUT of that and nothing reads them back, so the palette retunes
without the ruleset moving.

The dial is a **sine**, `sin(2*PI*t/DIAL_PERIOD)`, and that is not an arbitrary
easing choice. A sine lingers near its extremes and crosses zero fastest, so the
green band is harder than its width suggests: a press at a uniformly random
moment averages `100 * (1 - 2/PI)`, about **36 damage**, where a linear sweep
would average 50. The skill gradient is steeper for free.

`t` resets to zero every time the dial arms. A player who loses the target and
comes round again gets the sweep from a known start rather than from wherever a
free-running clock happened to be. It is the same argument `fishsim.ts` makes for
stopping `swingClock` while the rope is out, and for the same reason: a skill
whose phase depends on how long the approach took is not learnable.

### One locker, one bundle, one hunt
Harpoons come out of `harpoons.ts`, the same store the fishing card draws
spares from. One press is one harpoon and `HUNT_TARGETS` is 5, which is exactly
one `HARPOON_BUNDLE`. There is deliberately **no second constant** for the
per-hunt ceiling: two numbers that must agree are two numbers that can be
half-changed.

The locker is debited as the shot fires and never reserved up front, which is
`fishing.ts`'s rule and the reason a hunt and a session can never disagree about
what a spare is.

### The purse, and why it is ten a point
`huntGold(banked) = round50(banked * 10)`. A perfect hunt is 500 damage and
5 000 gold; a player pressing blind banks about 182 and takes 1 820.

Fifty a point was proposed and rejected: it tops out at 25 000, which beats
`bounty.ts`'s best won fight (20 000) while carrying no stake at all, and an
activity that pays more than the jackpot and risks nothing makes the other four
irrelevant. Ten lands just above the fight's ~2 800 expected value and level
with the best contract, and `questconstants.ts` already holds exactly this line
for deliveries.

**No reputation.** `REPUTATION_BY_TIER` tops out at 40 plus a 5 window bonus,
so the proposed `damage / 10` would have had one hunt beat the best contract in
the game. `reputation.ts` records that the scale is earned before it is spent
precisely so Phase 2 has a history to gate on, and flooding it before it means
anything would set that baseline wrong. Gold only.

### The six ways a hunt ends
All six pay what was banked, and all six pay exactly once: the purse settles
on the transition INTO `settling`, so the fade that follows cannot pay twice.

| Ending | Where |
|---|---|
| Five targets banked, however feeble the fifth | `fire`, `settled` |
| A press under `SOUND_BELOW` (10 damage), on any target but the last | `fire`, `sounded` with `reason: 'pinprick'` |
| Sailed more than `DESPAWN_RANGE` from the mark | `update`, `reason: 'lost'` |
| The mark aground for `AGROUND_SECONDS` without a break | `update`, `reason: 'lost'`. Rare, because the head steers off coasts; see **Keeping the animal off the coast** |
| `suppressed()` went true: docked, a blackout, or a maelstrom | `update`, `reason: 'lost'` |
| A fight started | `main.ts`'s `onContact` calls `leviathan.scatter()` |

**The `reason` is a word, not a rule.** Both values cost exactly the same, and
they exist so the strip can tell a player who was out-swum from a player who
steered off. A `pinprick` gets the animal named at it (`THE LEVIATHAN TIRED OF
YOUR PINPRICKS AND SOUNDED`) because it is the player's own press and the
animal's answer to it; everything passive gets the plain line, because telling
someone who deliberately sailed away that the leviathan tired of them would be
the game mislabelling their own choice. `quests.ts` carries `expired` against
`abandoned` for the identical reason.

**The last target is exempt from the threshold**, and the order in `fire` is
what makes it so: the count is checked before the damage. A player who has
banked four and puts a feeble fifth into the water has finished the hunt
whatever the rule says, and greeting a four-out-of-five run with "the leviathan
tired of you" would read as a failure rather than as the end of a good one.

The fight row is the one that needs saying. The battle branch runs the world but
does not run `leviathan.update`, and must not: the hull is halted and
`battle.ts` is steering it, so there is no helm to hold a target with, and a
shoal frozen through ninety seconds of a moving sea would be the one object on
the water that did not live through the fight.

An **overlay** is deliberately the opposite case and is not in that table. The
frozen branch stops the whole world, the shoal with it, and the player comes
back to the sea exactly as they left it. That is the pause contract doing its
job rather than a hunt being spared, and it is why nothing hunt-shaped appears
in the frozen branch's five calls.

### Who owns Space
`leviathandial.ts` binds Space for the life of the run and acts on it **only
while `state.armed` is true**. That is the same discipline **One owner for the
Escape key** keeps, applied to a key with more claimants:

| State | Space means | Owner |
|---|---|---|
| Inside a berth ring, nothing else open | make fast / cast off | `main.ts`'s own listener |
| A fishing session | fire the harpoon | `fishing.ts` |
| A battle | fire a broadside | `battleui.ts` |
| A shoal inside range and arc | loose a harpoon | `leviathandial.ts` |

They cannot collide, but the reason is worth writing down because one half of
it was a bug first. The moor listener already refuses while any overlay, menu,
fight or maelstrom owns the screen; the dial refuses unless armed, and
`leviathan.ts` holds `armed` false while docked and while suppressed. A shoal is
also never laid within `BERTH_MARGIN` (25 units) plus the widest berth radius of
a dock, which is a second guard on the same thing.

What that misses is the **frozen branch**. `huntDial.update` is only called
while sailing, so an overlay freezes the bar without clearing its `armed` flag,
and a Space aimed at the fishing card would reach `leviathan.fire()` as well as
`fishing.ts`. The guard is therefore in `main.ts`'s `fireHarpoon`, which is the
moor key's list exactly and sits where this file already owns the knowledge of
who has the screen. Ticking the dial inside the frozen branch would have been
the other fix and is the wrong one: it puts a sixth call in the pause contract's
five to repair something that belongs to the caller.

### Rendering, and the artefact it accepts
`leviathanshadows.ts` is a pool of `SHOAL_COUNT` flat `PlaneGeometry` quads with
two procedurally drawn `CanvasTexture`s, placed through the same surface basis
`aihulls.ts` writes for a raider: local +X starboard, +Y the surface normal, +Z
astern, with the quarter turn baked into the geometry once so the per-frame path
composes nothing.

No glTF, no rig, no asset file. That is the MVP's entire economy: the ironwhale
the feature is named for is Phase 2 work and the shadows exist to answer the one
question that has to be answered before paying for it.

**`SHADOW_LIFT` is not a z-fighting epsilon**, though it was written as one and
that was a bug worth recording. The water is a sphere at `GLOBE_RADIUS`, but
`waterpatch.ts` genuinely DISPLACES it near the ship by up to
`DISPLACE_AMPLITUDE` (0.3) and writes depth. At 0.05 the shadows were under the
sea almost everywhere and the depth test discarded every fragment: the shoal was
placed, counted visible, and drawn nowhere. It is now `DISPLACE_AMPLITUDE + 0.1`
and imports that constant rather than restating it, so the clearance cannot
drift away from the displacement it exists to clear. `depthTest` stays ON, which
is what keeps land occluding a shoal behind a headland.

**The footprint is set from a screenshot, not from a guess.** The first figures
were 4.2 by 1.7 units, a little over a hull length, which sounds right and is
not: the chase camera sits 52 units back, so a shadow 22 units ahead is 74 from
the lens and foreshortens at 20 degrees to about ten pixels. It is 7 by 2.6 now,
over twice the hull's length, which sounds far too big written down and is about
right on screen.

**The accepted artefact**, which is a different thing from the bug above. A dark
plane above the water is still an approximation of a shape below it and can read
as a texture artefact rather than as an animal. That is a limitation of this
phase rather than something to tune away by dropping the opacity until a
screenshot passes. "Illegible" and "absent" look identical in a screenshot and
only one of them is a design trade, which is why `ShadowField.visible` publishes
the count of planes actually submitted. The real fix is a darkening term inside
the water shader through the plugin contract `waterhazard.ts` already uses: a
term inside the surface cannot be above or below it, and has no height to tune.

### Keeping the animal off the coast
A hunt ends once the mark is aground, so anything that puts the mark on land
ends a hunt the player did nothing to lose. Until v0.27.0 that was nearly every
hunt followed along a coast. A probe forced shoals at 55 water points within 35
units of land and held a hull 40 units off the mark for three minutes each, on
the game's own 2048x1024 height map. All 55 were lost to land. Two things were
wrong, and they had to be fixed in this order.

**The body was a rod.** Each segment was laid astern along the head's current
heading, so the whole animal pivoted on its head and every turn swung the tail
through a 21-unit arc. Steering the head cannot fix that. A second attempt drew
each segment after the one in front, like a rope, and that cut up to three
units inside every tight turn. The body now rides the head's **recorded path**:
the head drops a point every `TRAIL_STEP` (0.25 units) into a fixed ring, and
each segment is placed on that polyline at its rank's distance back. A head
kept on water keeps every segment on water, and a turn travels down the body.

**Then the head has to steer.** In priority order, all in `update`:

| Mechanism | What it does |
|---|---|
| Escape | Land inside `COAST_LOOKAHEAD` (a body length) ahead triggers `escapeTurn`. It weighs every 15 degrees out to a reversal, both sides, along the arc the head would actually swim: straight through the telegraph, then round a circle of `speed / HEAD_TURN_RATE`, then open water from where the arc ends. It takes the smallest turn with full room, or else the turn with the most room |
| Urgency | Land closer than a telegraph plus a turning circle skips the telegraph. The `turn` cue still fires |
| Wheel about | If no turn at speed beats holding on, the animal drops to `TIGHT_SPEED` (a quarter) and turns at `TIGHT_TURN` (3x). The radius is a third of a unit, which gets it out of inlets narrower than its eight-unit turning circle |
| Drawn turns | A random turn whose arc meets land is replaced by holding on, or by an escape. While spent, a drawn turn that loses open water stops where it is |
| Flee | Weighs open water from half a unit out, because it turns a few degrees a frame and land right off the beam is what it swings into. It leaves an escape alone |

None of it draws from the seeded stream, so a coast cannot reorder the draws
behind it.

**Judging a turn by its end heading was the trap.** The first escape picked a
reversal whose final heading had open water, and swam it on the wrong side of a
bay, through land four units off its beam. Checking the whole arc is what fixed
it.

**A sandbar is not a beach.** The 2048 map carries slivers of land a fraction of
a unit wide that break the surface by a hair, narrower than any probe spacing
the steering can afford. The hunt now ends only when the mark has been aground
for `AGROUND_SECONDS` (1 s) without a break.

**Measure at game resolution.** The unit tier builds the height map at 256x128,
about five units a cell. At that size the slivers and the narrow inlets do not
exist, and most of the real losses were invisible. The committed unit case runs
at 256 for speed; the numbers above were taken at 2048 in a throwaway probe.
With a hull held inside `FLEE_RADIUS` against a coast for minutes, 4 hunts in 55
are still lost. A real player does not hold that position.

### What `?hunt=shoal` does
Lays a shoal at `SHOAL_SPAWN_MIN` off the bow three simulated seconds in, and
**re-lays it two seconds after every one ends**. That standing behaviour is the
one thing it does not share with `?hazard=` and `?cell=`, and it is not
convenience: a forced shoal heads back down the bow, so it closes, passes a
stationary hull and is past `DESPAWN_RANGE` about twenty-five simulated seconds
later. On the software rasteriser the smoke tier runs at, that is most of two
minutes of wall clock, so a one-shot lays its shoal during the boot and has
taken it away again before anything gets to look at it. The smoke case caught
exactly that, by failing.

If the point off the bow is not sailable the force falls back to the ordinary
compass search rather than laying one on a beach. A shoal is also cleared along
its WHOLE body at spawn (one read per segment down the heading it is laid on,
and open water a body's length ahead), not just at its head: `update` ends a
hunt once the marked segment has been aground for `AGROUND_SECONDS`, and the
mark starts at the tail, so a centre-only test put shoals on coasts that
scattered straight away and reached the player as a notice about a shoal they
never saw.

**`?hunt=armed`** is the same query with the shoal laid INSIDE the gate and the
marked shadow moved onto the bow at the middle of the band, so the dial is live
within a frame. The armed state cannot be reached by waiting, only by steering,
so the browser tier cannot otherwise test the keystroke without sailing to it,
and a scripted hull sails into headlands: the first attempt stalled at 20.7
units having driven into a coast. It is the same affordance `?battle=1` is for a
fight, and it leaves the expensive tier only one thing to prove, which is that a
Space press reaches the sim. It is also the ONLY thing in `leviathan.ts` that
moves a shadow rather than letting it drift, and it lays the mark ACROSS the
bow so the dial goes dark again on its own: an armed dial that stayed armed
would be testing nothing.

`window.__pirateWorld.hunt` publishes the phase, the shadow count, the dial and
the two numbers the gate is made of (`markRange`, and `markOffBow` SIGNED, with
negative to port), so a shot can wait on a condition rather than on a clock, per
rule 2 in docs/TESTING.md. It exists only under `?quality=` or `?debug`, like
the rest of that hook.


## The chandlery
`shop.ts` owns the panel, its own Escape and the only path by which gold leaves
the purse. It knows nothing about who may open it: `main.ts` gates that on the
berth and `hud.ts` dims the key when there is no berth to gate on.

Every purchase is two all-or-nothing moves in a fixed order — test the goods,
take the gold, hand the goods over — and the test runs BEFORE the wallet is
touched. Both halves can refuse (a full store refuses a cell, a full locker
refuses a bundle), and the order where the wallet went first would make a
refusal on the second half mean gold spent on nothing.

### Two cells, one price, and no top-up bargain
`BATTERY_CELL` is what a purchase buys — half a main tank — and
`BATTERY_CAPACITY` is what the ship can hold, derived as
`BATTERY_CELL * BATTERY_CELLS_MAX`. They were the same number until the ship
gained a second slot, and keeping them separate is what lets the HUD's bar, the
save file's clamp and the shop's stock line all move together from one edit.

`charge()` adds a fixed cell and clamps, rather than filling to capacity. That
is not a detail: a `charge()` that topped up to the top would make the cheapest
way to stay full a purchase every time a berth went past, which is the exact
trap the single-cell version was written to avoid. Adding a fixed amount instead
means a cell bought at 90% wastes the overflow, and the waste is the deterrent.

### The dev gold button, and the trap it shipped with
Behind `?dev` the panel grows a third control that is not an offer:
`DEV_GOLD_GRANT` (10 000) straight into the wallet, per click. It is read
through `URLSearchParams` and never through `import.meta.env.MODE`, on exactly
the terms `?quality=` and `?hazard=` are read on — `vite preview` serves a
genuine production build and these harnesses are meant to be used against one,
so a MODE test would switch the button off in the very build it is wanted in.
It is deliberately not routed through the purchase helper above: that helper
exists to guarantee gold never leaves the purse for nothing, and this moves gold
the other way, so it has neither half of that contract to honour.

**It shipped visible to every player, and the cause is worth writing down.**
`.shop__dev` sets `display: flex`, which **beats the UA's
`[hidden] { display: none }`** — the same trap `.shop[hidden]` already carries an
explicit guard against, and the fishing card before it. So the row rendered for
everyone: `shop.ts` only writes the label and attaches the listener behind
`?dev`, and what a player without the query actually got was an unlabelled box
that did nothing when clicked. Any new rule that sets `display` on an element
that is ever `hidden` needs the same guard in the same commit.

The check that MISSED it asserted `element.hidden === true`. That property was
set the whole time; it was the CSS ignoring it. **To prove something is not
visible, ask the renderer** — `toBeHidden()`, `getComputedStyle(el).display`, or
`offsetParent === null` — never the attribute, because the attribute was never
the thing that was wrong. `tests/smoke/game.spec.ts` now asks all three, and the
pair of tests there was confirmed to fail with the guard removed before being
trusted.

### Navigation and Fishing: eight more offers, two tabs
Everything above this paragraph describes the chandlery as it was with two
offers. It now sells ten, across a NAVIGATION tab and a FISHING tab — Battle
stays undelivered, see `docs/SHOP_PLAN.md` for why — and the reasoning for
each of the eight new items lives in that document and in the item's own file
rather than here, on the same principle `shop.ts`'s own comment states: a
price typed in more than one place is a price that can disagree with itself.
Two structural changes worth recording here rather than there, because they
are about the PANEL and not about any one offer:

- `wireConsumable`/`wireDurable` in `shop.ts` are the generic wiring two new
  shapes needed — a fixed-price stock cap and a per-tier price ladder — so
  eight offers did not mean eight hand-written copies of the same dim-reason
  and refresh logic the original two offers carried inline. `tierstore.ts`
  and `stockstore.ts` are the matching generic STORES the item files
  themselves build on.
- `.shop__panel` gained `display: flex; flex-direction: column` and a capped
  `max-height`, with `.shop__body` doing the scrolling — the Fish Book's own
  `.fishbook__panel`/`.fishbook__body` split, copied rather than reinvented,
  because five offers to a tab is already taller than a panel sized for two.
- **The tabs shipped doing nothing, and it was the trap two sections up.**
  `.shop__panel-group` sets `display: flex` and had no `[hidden]` guard, so
  both groups painted whatever `paintTabs` wrote: the panel showed all ten
  offers in one list, and clicking a tab moved the highlight and nothing else.
  `shop.ts` was never wrong — it sets `panelFishing.hidden` correctly and
  always did — the CSS was ignoring it, exactly as it ignored `.shop__dev`'s.
  Every other component in `style.css` carries the guard (`.shop[hidden]`,
  `.shop__dev[hidden]`, `.menu[hidden]`, `.fishcover[hidden]`, six more); the
  panel groups were the one place it was missed. Verified the way that section
  says to verify it: computed `display` per group off the renderer with the
  panel forced open, before the tab click and after it, never `el.hidden`.

## The ship model
`assets/pirateship_beginner.glb` is built by `tools/build_ship.py` (headless
Blender) and imported through Vite with `?url`, so the bundler fingerprints and
emits it. It is authored to `ship.ts`'s axis convention already — bow `-Z`, deck
normal `+Y`, starboard `+X` — so it needs no rotation and no scaling, only the
vertical mount that puts `MODEL_WATERLINE_Y` on the sea. `ship.ts` shows a
primitive stand-in hull until the load resolves and keeps it if the load fails:
a missing asset costs detail, not the ship.

Surfacing is procedural too: `tools/ship_textures.py` generates the plank,
brushed-metal, rope, canvas and Jolly Roger maps with numpy and packs them into
the GLB, tiled through `KHR_texture_transform` rather than baked per UV. Tiling
is why `main.ts` passes `renderer.capabilities.getMaxAnisotropy()` down to
`shipfx.ts`, which raises it on every map the model brings: the deck repeats its
planks three times along a hull the chase camera sees almost edge-on, and that
is the one case isotropic filtering cannot survive.

The build script joins its 233 authored parts by material, so the ship draws in
26 calls instead of one per bolt, and exempts a handful of parts in its
`KEEP_SEPARATE` tuple **because the game addresses them**. `shipfx.ts` is the
consumer of that contract: it bellies the mainsail and streams the flag by
rewriting their vertices from a stored rest pose (both are welded grids of well
under a hundred vertices, so the per-frame cost is a normals rebuild on two
small meshes), pulses each neon lamp off its own cloned material at a rate
hashed from its node name, and drives the thruster flames from the throttle.
Only the three parts needing bespoke motion are matched by name; the lamps are
found by material — flat emissive, no emissive map — so a new light on the rig
needs no change here. The cloning happens during the load, before `ready`
resolves, because a material cloned after `postfx.adopt` would carry the
"already encoded" flag without the `onBeforeCompile` behind it and render dark.
