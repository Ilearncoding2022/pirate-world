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
| `types.ts` | `InputState`, `Terrain`, `ShipState`, `Town`, `Dock`, `Towns`, `EnergyState`, `EnergyMode`, `WindState` | interfaces only |
| `quality.ts` | `QualityTier`, `QualitySettings`, `Quality`, `createQuality(search?)`, `QUALITY_STORAGE_KEY` | resolved once at startup (`?quality=` beats `localStorage` beats `'high'`); frozen, read-only table everything built after it treats as fixed; `reflectionSize`/`reflectionFacesPerFrame` of 0 means the reflection pass is absent, not idle |
| `layers.ts` | `LAYER_DEFAULT`, `LAYER_REFLECTED` | the two `Object3D.layers` bit indices every rendering stream shares; wiring constants, not world- or ship-scale |
| `env.ts` | `WorldEnv`, `createEnv()` | shared frame state |
| `heightmap.ts` | `HeightMap`, `createHeightMap(terrain, w?, h?)`, `HEIGHTMAP_GLSL` | built once; `aux`/`horizon` start `null` and are filled in later by `land.ts`'s startup bake (`terrainbake.ts`) |
| `terrain.ts` | `createTerrain(seed?)`, `SEA_LEVEL`, `DEFAULT_SEED`, `SPAWN_LAT_DEG`, `SPAWN_LON_DEG` | seeded fBm; owns where the player starts and the land/water ratio; `useLandMask` re-points collision at the culled raster |
| `islets.ts` | `cullIslets(heightMap, seaLevel)`, `MIN_ISLAND_AREA` | sinks landmasses too small to see; runs once, before anything reads the map |
| `waterbodies.ts` | `WaterBodies`, `createWaterBodies(heightMap, seaLevel, spawnDir)` | built once; ocean vs. inland mask, texture + CPU `sample` |
| `land.ts` | `createLand(terrain, heightMap, quality)`, `landRadius`, `MAX_LAND_RELIEF`, `COAST_LIFT` | land-only mesh, sub-sea vertices sink under the water; `MeshStandardMaterial` extended with a chained `onBeforeCompile` (see **Post-processing**) that modulates the vertex-coloured base with per-pixel slope, curvature, wetness, a detail-normal octave, noise, per-mask roughness, baked AO and a sun-tracking horizon shadow from `terrainbake.ts`. Every noise term is distance-faded (`landLod`), and the detail normal's two taps are branched away entirely past its fade, so the orbit framing costs what it did before any of it existed |
| `terrainbake.ts` | `bakeTerrain(heightMap, seaLevel)`, `bakeAmbientOcclusion`, `bakeHorizon`, `TerrainBake`, `BAKE_WIDTH`, `BAKE_HEIGHT` | startup-only ambient-occlusion and 8-azimuth horizon bake over a half-resolution copy of the shared height map; called from inside `createLand`, after `globe.ts`'s islet cull, so it never occludes for an island that is about to be sunk |
| `noiseglsl.ts` | `NOISE_GLSL` | inlined Ashima/Gustavson simplex noise; `water.ts` and `land.ts` share this one copy |
| `waveconstants.ts` | `SWELL_WAVELENGTH`, `WAVE_WAVELENGTH`, `CHOP_WAVELENGTH`, `AXIS_WAVE`, `AXIS_CHOP`, `DISPLACE_AMPLITUDE`, `freq`, `freqNumber`, `vec3Literal` | the one source both `waterglsl.ts` (GPU) and `wavefield.ts` (CPU) read, so the two wave fields can never numerically drift apart — see **The wave field** |
| `waterglsl.ts` | `WATER_UNIFORMS`, `waterWavefield`, `waterDepth`, `WATER_LIGHTING_HEAD`/`_TAIL`, `waterFoam`, `WATER_FOAM_TAIL`, `WATER_OUTPUT` | the water fragment shader, as named chunks `water.ts` assembles; see **Shader notes** for the plugin hook seams between them |
| `fogglsl.ts` | `FOG_GLSL` (`applyAerial` contract) | aerial-perspective blend toward the atmosphere colour, thickened at grazing angles and weakened with camera altitude, capped at `FOG_MAX_AMOUNT`; called from water and land |
| `fog.ts` | `fogUniforms`, `updateFog(env)` | owns the three uniforms `applyAerial` reads; called from `globe.update` before water and land |
| `water.ts` | `createWater(terrain, heightMap, waterBodies, plugins?: WaterPlugin[])`, `WaterPlugin`, `WaterHook` | full sphere at `GLOBE_RADIUS`; `update(dt, env, wind, ship, camera)` — the only module that reads the weather; exposes `offsets`, the three wave layers' integrated drift (direction-space, read-only), for `wavefield.ts`'s CPU port; see **Shader notes** for the plugin contract |
| `wavefield.ts` | `snoise`, `sampleWave`, `waveHeight`, `waveNormalBasis`, `WaveOffsets`, `WaveSample` | float32-rounded CPU port of `waterglsl.ts`'s swell+wave `waveField`; `ship.ts` rides this, the player sees the GPU copy — see **The wave field** |
| `hazardfield.ts` | `HAZARD_GLSL`, `HAZARD_PROFILE_GLSL`, `HAZ_CREST_RATIO_GLSL`, `hazardHeight(dir, hazards)`, `MAX_HAZARDS`, the crest/funnel sizes | the SECOND height field, beside `waveField` and never inside it: GLSL for three consumers and a float32 CPU port for the hull. Polynomial plus one `sqrt`, which is what makes its parity free — see **Hazards** |
| `waterpatch.ts` | `createWaterPatch(water, quality)`, `WaterPatch` | ship-following grid that actually displaces in the vertex shader, reusing the sphere's already-assembled fragment shader byte for byte; built after the water plugins are woven in |
| `grid.ts` | `createGrid()` | lat/long lines |
| `sky.ts` | `createSky()`, `skyHorizonColor(env, out)`, `ATMOSPHERE_COLOR` | graded sky dome + atmosphere shell + starfield. The dome and the shell are a CROSS-FADE, not two effects: the dome fades out over `SKY_FADE_LO`..`SKY_FADE_HI` of camera altitude and the shell fades in over the same two, because a limb is something you see from outside an atmosphere and additively over a lit sky it bleaches the horizon. `skyHorizonColor` is what `fog.ts` fades the sea toward |
| `daynight.ts` | `createDayNight()`, `DAY_LENGTH`, `MOON_MONTH_DAYS`, `START_ELAPSED` | lights, writes `WorldEnv`; places BOTH bodies from elapsed time |
| `celestial.ts` | `createCelestial()` | the sun disc, the moon, the moon's halo and its rim aurora as things you can see; draws only what `daynight.ts` already decided and writes nothing |
| `clouds.ts` | `createClouds()` | cloud deck, `SHELL_COUNT` stacked slices |
| `towns.ts` | `createTowns(heightMap, waterBodies, seaLevel)` | settlement placement; a town without a berth is never founded, so every `Town.dock` is non-null; built once |
| `citylights.ts` | `createCityLights(terrain, heightMap, towns)` | night-side settlements, lit from the shared list |
| `docks.ts` | `createDocks(towns)` | charging zones on the water + daylight beacons |
| `energy.ts` | `createEnergy(towns, battery)`, `DEFEAT_KEEP`, `STALEMATE_COST` | burn / solar / dock charge, and the bought cell behind them; owns `EnergyState` and the ten-rung `EnergyMode` ladder that names what the plant is doing; `spend(level)` is the overlays' withdrawal, `wreck()` the shipwreck's — the main tank keeps `WRECK_KEEP` (25%), the reserve, `rate` and `mode` untouched. `defeat()` / `stalemate()` are the lost and drawn battle's, the only two that reach the backup cell without a purchase; see **AI boats and the battle** |
| `wind.ts` | `createWind(terrain, heightMap, seed?)`, `COAST_CAP`, `OCEAN_CAP`, `OPEN_SEA_DISTANCE`, `LULL_SPEED` | lull/event weather, floored at `LULL_SPEED` so it never stops and there is no calm state anywhere downstream; owns `WindState`; probes the shared height map for the coast |
| `hazards.ts` | `createHazards(deps)`, `HazardsDeps`, `Hazards` | the rough-water sim: the roll, spawning, transport, contact and push, capture and the spiral, `pickRespawn`. Owns `HazardState`, mutated in place; DOM-free and scene-free, like `wind.ts` — see **Hazards** |
| `aiboats.ts` | `createAiBoats(deps)`, `AiBoatsDeps`, `AiBoats`, `ROLL_PERIOD`, the spawn and pursuit constants | the raider sim: the roll, spawning, transport, pursuit, conversion, contact and the post-fight grace. Owns `AiBoatState`, mutated in place; DOM-free, scene-free and seeded, exactly as `hazards.ts` is; see **AI boats and the battle** |
| `aihulls.ts` | `createAiHulls(scene, cloneHull)`, `AiHulls` | the raiders as things you can see: at most two hull clones from `ship.cloneHull()`, placed on the globe from `AiBoatState` each frame, neon recoloured, `rimglow.ts` installed. `hullOf(boat)` is what the arena borrows |
| `rimglow.ts` | `installRimGlow(root, color, strength?)`, `RimGlow`, `RIM_STRENGTH` | the Fresnel `onBeforeCompile` patch that lights a whole silhouette in one colour. Installed BEFORE `postFx.adopt` chains its own hook; see **Post-processing** |
| `battle.ts` | `createBattleSim(rng?)`, `BattleSim`, `ROUNDS`, `HITS_TO_LOSE`, the arena constants | the whole cannon fight in flat arena units: the shrinking circle, W/S, the rounds, the balls, the hits, the AI gunner and the outcome. No DOM and no Three, exactly as `fishsim.ts` is; one sim is built per fight and thrown away with it |
| `battleconstants.ts` | `ARENA_R`, `ARENA_R_MIN`, `ARENA_SHRINK`, `ARENA_OMEGA`, `THROTTLE_GAIN`, `ROUNDS`, `HITS_TO_LOSE`, `FIRE_COOLDOWN`, `BALL_SPEED`, `HIT_RADIUS`, `BATTLE_TIMEOUT` | the numbers the cannon fight is built out of, split out of `battle.ts` by the rework so that `battleai.ts` and `battlesea.ts` can read the ring's dimensions without importing the module that imports them. No logic, only tuning decisions with the reasoning attached; `battle.ts` re-exports the lot so every existing importer keeps working. The AI's own constants deliberately do NOT live here — they describe a gunner rather than an arena, and sit in `battleai.ts` |
| `battleai.ts` | `createBattleAi(rng)`, `BattleAi`, `AiView`, `AI_LAG`, `AI_HELM_PERIOD`, `AI_HELM_COIN`, `AI_FUSE`, `AI_SOLUTION_TOLERANCE` | the enemy gunner and the enemy helm, and nothing else: it knows nothing of the sea, the ring's shrink or the locker's bookkeeping. A two-second delay line (`observe` records every tick, `throttle`/`gun` read it `AI_LAG` later, so every decision is aimed at the player of two seconds ago), a coin flip in one helm decision in four, and a fuse that commits a shot `AI_FUSE` before it fires — which is what makes it dodgeable. Decisions 1, 2 and 4 of `docs/BATTLE_REWORK_PLAN.md` |
| `battlesea.ts` | `createBattleSea(rng, options)`, `BattleSea`, `BattleSeaState`, `SwayTarget`, `CALM`, `ROUGH`, the crest/sway/flotsam constants, `FOUL_SECONDS` | the two seeded systems that put something in the arena, each switched independently by `BattleOptions`: up to `CREST_MAX` crests at once, each a finite length of a line perpendicular to one of the four cardinal directions, rolling across the ring at its own speed and shoving the hulls it actually passes over as a closed-form pulse (nothing to integrate, so nothing that can go unstable at a capped `dt`); and a fleet of three to six flotsam rafts, each its own size and speed, that swallow a ball crossing them and foul a hull they touch for `FOUL_SECONDS`. `CALM` turns both off and is what every unit case measuring the gunner is pinned against; `ROUGH` is the shipping default. Decisions 5 and 7 |
| `bounty.ts` | `WIN_TIERS`, `rollWinGold(rng)`, `lossGold(purse)`, `rollDrawGold(rng, purse)`, `LOSS_SHARE`/`LOSS_MIN`/`LOSS_MAX`, `DRAW_SWING` | data and pure functions for the three gold outcomes; every roll takes the caller's `rng` |
| `battlescene.ts` | `createBattleScene(quality)`, `BattleScene` | the arena: a SECOND `Scene` with its own sea, lights, fixed camera, cannonballs, splashes and the wall of water crossing the ring. It is not the globe water and must never import `water.ts`; see **AI boats and the battle** |
| `battlewave.ts` | `SEA_VERTEX`, `seaFragment(fine)`, `CREST_VERTEX`, `crestFragment(fine)`, `ARENA_CREST_HEIGHT`, `CREST_GRID` | the arena's water as GLSL, split out of `battlescene.ts` the way `hazardcrest.ts` was split out of `waterhazard.ts`. Compiles `waterglsl.ts`'s ridged field on a plane, `hazardfield.ts`'s crest profile as shared characters and `hazardcrest.ts`'s art constants, so the fight is fought on the same wave the world raises — see **The arena sea is not the globe water, but it is the same wave** |
| `battlecover.ts` | `createBattleCover(deps)`, `BattleCover`, `COUNTDOWN` | the card a fight is DECLARED on: the plate, the rules in one sentence off `ROUNDS`/`HITS_TO_LOSE`, and the three-second count into the arena. A card over a FROZEN world, unlike `battleui.ts` — see **The beat before a fight**. Counts on the wall clock, not on `dt` |
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
| `camera.ts` | `createFollowCamera(aspect)` | follow camera, tracks ship up; `snap(ship)` puts it at this frame's damped destination immediately, for the one event that moves the hull without sailing it there |
| `controls.ts` | `createControls()` | keyboard + on-screen D-pad + wheel |
| `hud.ts` | `createHud(wallet)` | speed, wind, gold, power, the backup cell, and the dock's keys; heading and lat/long live on the radar panel. Owns the power panel's two derived readings — `powerTag` (the ten `EnergyMode` causes plus its own `full`) and `powerSeverity` (the five colours), which are deliberately two axes rather than one enum; see **The tag names a cause; the colour names a severity**. Also publishes `--telemetry-h`, the panel's rendered height, which the dock is positioned off |
| `menu.ts` | `createMenu(deps)`, `Menu` | the Escape menu and the controls guide inside it. Owns the Escape key OUTRIGHT — opening as well as closing — and asks `main.ts`'s `canOpen` whether it may; a card over a frozen world, on the pause contract's terms |
| `radar.ts` | `createRadar(heightMap, waterBodies, seaLevel, towns)`, `RADAR_RANGE` | 2D canvas scope, no draw calls; `update(dt, ship, wind, hazards, boats?)`; hazards and raiders alike are drawn from the LIVE frame, like the wind arrow and for the same reason: hazards in `--magenta`, raiders as own ship's own arrowhead turned to their relative heading, in `--red` or `--orange` at `envelope` alpha |
| `solartime.ts` | `solarPhase(up, sunDirection)`, `phaseName`, `formatLocalTime`, `SolarPhase` | where the ship stands in its own solar day; DOM-free, so the geometry is testable without a canvas |
| `timedial.ts` | `createTimeDial(canvas)` | draws that phase under the scope; 2D canvas, no draw calls |
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
| `save.ts` | `createRecords()`, `loadSave()`, `writeSave(data)`, `SAVE_KEY` | localStorage, versioned, tolerant of garbage |
| `dev/probe.ts` | `runProbe()` | `?probe=wave`'s only entry point; renders the GPU `waveField` chunk to a canvas and publishes the matching CPU samples for `tests/smoke/wave-parity.spec.ts`; tree-shaken out of a normal load |
| `blackout.ts` | `createBlackout()` | the fade a wreck happens behind, and both of a battle's; owns `#blackout` and the promise that `onBlack` runs when the screen is ACTUALLY opaque, on `transitionend` with a timer fallback |
| `loading.ts` | `createLoading()` | drives the splash `index.html` ships visible; the only UI a module does not build |
| `main.ts` | — | staged bootstrap and frame loop |

## Land / water split
The world is **25% land, 75% water**, and that is one constant: `HEIGHT_BIAS`
in `terrain.ts`, tuned against the figure *after* the islet cull below.

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
they are 0.66%, and no choice of `GAIN` recovers the difference. Only a
different noise field would.

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
under two ship lengths. 160 of the world's 253 islands go, and they take 0.63%
of its land with them.

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

## Frame loop
```
energy.update(dt, shipState, env)          // burn / solar / dock, on last frame's speed
wind.update(dt, shipState, energyState)    // needs this frame's docked verdict
hazards.update(dt, shipState, energyState) // rolls, transport, contact, push, spiral; writes HazardState
aiBoats.update(dt, shipState, energyState, hazards.state, suppressed())  // after hazards: needs this frame's phase. Before the ship: a contact halts the hull this frame
ship.update(dt, input, energyState, windState, globe.waveOffsets, hazards.state)  // thrust gated on energy.canThrust; waveOffsets is the CPU twin of the sea the patch draws; hazards.state is the push it spends and the drive it obeys
camera.update(dt, shipState, input)
aiHulls.update(dt, aiBoats.state)          // places and lights the clones; nothing reads them until the render
globe.update(dt, env, wind.state, shipState, camera)  // daynight (places sun AND moon, writes env), fog, then water (reads wind + its plugins), the displacement patch, land, citylights, clouds, sky (dome + shell + stars), celestial (the two discs, last: it only draws what env already says)
reflection.update(dt, shipState.position, renderer, scene)  // this frame's share of reflection-cube faces; must land before postFx.render
docks.update(dt, env, shipState, energyState)
wake.update(dt, shipState, env, renderer)  // fills the wake map render target last, after every rib/spray value this frame is final
hud.update(shipState, energyState, windState)
radar.update(dt, shipState, windState, hazards.state, aiBoats.state)
postFx.render(dt, scene, camera)
controls.endFrame()
```

`suppressed()` is `main.ts`'s own one-line verdict, `energy.mode === 'docked'
|| blackout.active || hazards.state.phase !== 'free'`, and it is computed
there rather than inside `aiboats.ts` because all three of its terms are owned
by other modules. Overlays are not in it and do not need to be: the loop does
not reach `aiBoats.update` under one at all.

While a battle is up the loop takes a THIRD branch, tested **before** the
overlay branch below:

```
energy.update(dt, restingShip, env)        // the plant keeps running, on a resting hull
battleSim.update(dt, battleUi.input(controls.input))   // only while inArena: the fire edge plus W/S
settleOutcome(...)                         // once, the frame `outcome` first becomes non-null
battleScene.update(dt, battleSim.state)
battleUi.update(battleSim.state)
hud.update(shipState, energyState, windState)
timeDial.update(shipState, env)            // redrawn, not advanced, as under an overlay
postFx.render(dt, inArena ? battleScene.scene : scene, inArena ? battleScene.camera : view.camera)
controls.endFrame()
```

It is tested first because it is the more specific state, and because it is
the one branch that renders a **different scene**: it therefore cannot share
the frozen branch's `postFx.render(0, scene, camera)`, and it renders LIVE
rather than at dt 0, because the arena is the game while it is up. A fight and
a card can never be up together anyway: a contact halts the ship and freezes
the world synchronously, and no contact can happen under an overlay because
the sim does not run there. See **AI boats and the battle**.

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
flat pale sheet. The three uniforms it reads (`uFogColorDay`, `uFogColorNight`,
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
(`reflectionFacesPerFrame`), and whether the water shader's fragment-side
chop octave runs at all (`waveChop`). **`reflectionSize: 0`** (the `low`
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
**1200 s — ten minutes of day and ten of night** at the equator. The
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

### Where the day starts
The world opens at **06:00 local** on the spawn meridian, not at 0 on the world
clock: `createEnv` seeds `elapsed` from `START_ELAPSED`. The ship spawns on
heading 090, so a dawn opening puts the sun dead ahead and low, which is the
only arrangement that shows off the sky the moment the game loads — at the noon
this used to open on, the sun was overhead and behind the chase camera.

`START_ELAPSED` is **derived**, by inverting `solartime.ts`'s
`time = fract(0.5 + tod + lon / 2PI)`, rather than written down as a number.
Local time is the angle between two meridians and never a clock the world
carries, so the elapsed seconds that land on dawn depend on `DAY_LENGTH` and
`SPAWN_LON_DEG` — both documented as retunable. Deriving it means changing
either one moves the opening with it instead of silently landing on the wrong
hour.

One consequence worth knowing: `MOON_PHASE_OFFSET` is tuned against this hour
and had to be retuned when it moved. A noon opening can only manage a thin
crescent low in the east, because at noon anything far enough from the sun to
be well lit is also below the horizon. A dawn opening frees the whole western
sky, so the moon now opens nearly opposite the sun — a bright gibbous setting
astern as the sun rises ahead.

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
a radius-200 planet puts the horizon about 17° BELOW horizontal, and it drops
further as the camera climbs. `limbElev` is recomputed per pixel from
`cameraPosition`, and the gradient, the twilight band and the sun's glow lobe
all key off `rayElev - limbElev`.

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


## HUD text sizing
Browsers carry a **minimum font size** preference (Chrome: Settings →
Appearance → Customize fonts). It clamps the *computed* `font-size`, so any
rule asking for less than the floor — commonly 12px — is silently discarded.
Most of this HUD is authored below that: `.readout__key` at 9.5px,
`.panel__note` and `.radar__range` at 8.5px, the D-pad glyph at 11.4px. On a
machine with the floor set they all render at 12px and the typographic
hierarchy flattens.

That is a user preference and is mostly left alone, with one exception.
`.dbtn__label` has to fit inside its key — `STARBOARD` is nine characters in a
key as narrow as 42px — so it is sized from `--key-size` and drawn through a
`transform: scale()`, which is applied after layout and is never clamped. Its
layout box is therefore ten times wider than its ink and reaches over the
neighbouring keys, which is why it carries `pointer-events: none`. Do not
"simplify" that back to a plain `font-size`.

The dock's `[FISH]` / `[FISH BOOK]` keys are the counter-example, and they are
authored at 10px on purpose. They are sized *by* their label rather than the
label being fitted into them — the key is as wide as its word plus padding —
so a browser floor raising them to 12px widens two buttons by a few pixels and
collides with nothing. The rule is not "never author under 12px"; it is
**never let a floor break a layout that assumed the smaller size**.

A second sizing rule, learned the same way. **Type on a fluid element belongs
in container units, not pixels.** The scope runs from 118px to 158px, and the
position fix was first placed inside the glass in px: it fitted at 158 and the
two coordinate blocks collided in the middle at 118 — a live window between the
desktop layout and the 720px breakpoint, not a hypothetical. A disc also has no
corners, so the blocks had to be pushed inward to clear the rim, which is what
made them meet. They now sit above the scope in a grid with equal flexible
flanks, so the heading is centred on the *panel* rather than merely placed
between two neighbours of different widths.

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

The panel's head row carries **LAT, heading and LON** above the glass. The
range readout is gone — it never varied, so it was a constant printed every
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

| | |
|---|---|
| Burn | `IDLE_DRAIN + FULL_BURN * (speed / MAX_FORWARD)^2` |
| 15 / 7.5 / 5 kn to dry | 90 s / 5.4 min / 10.5 min |
| Solar (stopped only) | `SOLAR_PEAK * max(0, up · sunDirection)` — 0.5%/s net at noon (200 s to full), 7.2 min at 30°, negative after dark |
| Berth | 2.0%/s net (50 s to full), overrides solar rather than stacking |
| Mooring | 2 s continuously inside the ring — see below |
| Backup cell | drawn on only once `level` is 0; never charged by anything |
| No thrust | refused at zero until `RESTART_LEVEL` (3%) of **both tanks together** |

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
| `dead` / `restart` | no thrust, and whether the rate says it is coming back |
| `docked` / `mooring` | connected, or inside the ring with the dwell running |
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

**A berth connects on a dwell, not on a speed.** It used to require the ring
*and* under 3 kn of ground speed, which was a proxy and wrong at both ends:
true of a hull drifting quietly across the ring on the wind, false of one that
had genuinely arrived and not yet lost way. Two seconds inside the ring asks
the question the ring is drawn to ask. It gives the same protection the speed
limit did — the zone is 16 units across, so a straight run through it lasts
1.6 s at the ship's 10 kn top speed — and it drops this file's last reader of
`groundSpeed`. The clock tracks the *identity* of the berth, so crossing from
one ring to another restarts it rather than inheriting the time. Anything under
about 8 kn can now dwell, drifting included: being blown into harbour is an
arrival, and `wind.ts` shelters what is docked, so the drift ends there.

Three subtleties worth keeping:

- **The dead-stop snap tests `thrust === 0`, not the absence of input.** They are
  the same key press until the tank runs dry. After that, a player holding W on
  a dead ship gets thrust 0, and the closed-form drag decay approaches zero
  without ever arriving — so `speed` sits at 1e-9, `speed === 0` stays false, and
  the solar test above never fires. The ship would refuse to charge for as long
  as the key was held, with nothing on screen saying why.
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
`P_ORANGE` is 0.24 a roll and `P_RED` is 0.032 — an order of magnitude apart,
on a `ROLL_PERIOD` of ten seconds. That gap is the whole shape of meeting a
raider. An orange boat wanders a track drawn once and never revised: it is
scenery that can be sailed around, and meeting one is the normal condition of
being at sea. A red one steers at the player every frame and ends in a fight
unless it is out-turned, so it interrupts whatever was being done, and an
interruption that arrives every minute is a chore rather than an event.

`P_RED` was cut by four fifths on 2026-09-08 (0.16 to 0.032, the owner's
call), having been doubled from 0.08 the day before. That puts an aggressive
raider at roughly one every five minutes of sailing. Both figures are
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

The screen exists because the arena teaches none of its own rules. Ten rounds,
three hits, a gun that fires out of the beam and a helm that is only a
throttle are all learnable in one sentence and not one of them is guessable
from the scene, so a player used to arrive already being shot at by a ruleset
nobody had told them. The sentence is built from `ROUNDS` and `HITS_TO_LOSE`
rather than typed into `index.html`, on the house rule every other overlay
figure follows.

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
