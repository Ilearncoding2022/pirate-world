# Pirate World — architecture

Vite + Three.js + TypeScript. No external art assets; everything is procedural.

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
15 kn. The price cannot be avoided: the time constant is `1 / DRAG`, so it
went 1.4 s to 2.9 s in **both** directions and the hull now carries its way
twice as far. Against constant thrust and linear drag there is no third number
to spend.

Drag is integrated in **closed form**, not stepped:

```ts
const terminal = thrust / DRAG;
state.speed = terminal + (state.speed - terminal) * Math.exp(-DRAG * dt);
```

Stepping thrust and then drag lands on `(ACCEL / DRAG) * (1 - DRAG * dt)`,
which makes the top speed depend on the frame rate: 14.8 kn at 60fps, 14.0 at
10. The closed form is exactly `thrust / DRAG` at any rate, and still decays
cleanly to zero with no throttle, so the ship coasts as before.

The hull is drawn at `MODEL_SCALE` (0.65), exported from `ship.ts` because the
wake is authored against the hull's own dimensions and has to shrink with it —
`STERN_BACK`, `BOW_FORWARD` and `HALF_WIDTH_0` in `wake.ts` all carry the
factor. `MODEL_WATERLINE_Y` is a model-space number, so `MODEL_MOUNT_Y` scales
it before subtracting; skip that and the ship floats at the wrong depth. Scale
is deliberately kept out of the motion constants: `BOB_AMPLITUDE`, the sway and
the bank are absolute, so a smaller hull moves the same distance in the swell
and therefore looks livelier in it.

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
| `env.ts` | `WorldEnv`, `createEnv()` | shared frame state |
| `heightmap.ts` | `HeightMap`, `createHeightMap(terrain, w?, h?)`, `HEIGHTMAP_GLSL` | built once |
| `terrain.ts` | `createTerrain(seed?)`, `SEA_LEVEL`, `DEFAULT_SEED`, `SPAWN_LAT_DEG`, `SPAWN_LON_DEG` | seeded fBm; owns where the player starts and the land/water ratio; `useLandMask` re-points collision at the culled raster |
| `islets.ts` | `cullIslets(heightMap, seaLevel)`, `MIN_ISLAND_AREA` | sinks landmasses too small to see; runs once, before anything reads the map |
| `waterbodies.ts` | `WaterBodies`, `createWaterBodies(heightMap, seaLevel, spawnDir)` | built once; ocean vs. inland mask, texture + CPU `sample` |
| `land.ts` | `createLand(terrain, heightMap)`, `landRadius`, `MAX_LAND_RELIEF`, `COAST_LIFT` | land-only mesh, sub-sea vertices sink under the water |
| `water.ts` | `createWater(terrain, heightMap, waterBodies)` | full sphere at `GLOBE_RADIUS`; `update(dt, env, wind)` — the only module that reads the weather |
| `grid.ts` | `createGrid()` | lat/long lines |
| `sky.ts` | `createSky()` | atmosphere shell + starfield |
| `daynight.ts` | `createDayNight()` | lights, writes `WorldEnv` |
| `clouds.ts` | `createClouds()` | cloud deck, `SHELL_COUNT` stacked slices |
| `towns.ts` | `createTowns(heightMap, waterBodies, seaLevel)` | settlement placement; a town without a berth is never founded, so every `Town.dock` is non-null; built once |
| `citylights.ts` | `createCityLights(terrain, heightMap, towns)` | night-side settlements, lit from the shared list |
| `docks.ts` | `createDocks(towns)` | charging zones on the water + daylight beacons |
| `energy.ts` | `createEnergy(towns)` | burn / solar / dock charge; owns `EnergyState` |
| `wind.ts` | `createWind(terrain, heightMap, seed?)`, `COAST_CAP`, `OCEAN_CAP`, `OPEN_SEA_DISTANCE` | calm/event weather; owns `WindState`; probes the shared height map for the coast |
| `wake.ts` | `createWake()` | ship wake and spray |
| `postfx.ts` | `createPostFx(renderer)` | composer / bloom; `adopt(root)` for late materials |
| `globe.ts` | `createGlobe(terrain): { group, heightMap, waterBodies, towns, update(dt, env, wind) }` | orchestrator only; culls islets and installs the land mask before anything reads the map |
| `ship.ts` | `createShip(terrain, start?, maxAnisotropy?)`, `MAX_FORWARD`, `MODEL_SCALE` | glTF hull + physics + collision; `ready` settles on load |
| `shipfx.ts` | `createShipFx(model, maxAnisotropy)` | animates the model's separate nodes: sail, flag, neon |
| `camera.ts` | `createFollowCamera(aspect)` | follow camera, tracks ship up |
| `controls.ts` | `createControls()` | keyboard + on-screen D-pad + wheel |
| `hud.ts` | `createHud()` | compass needle, speed, power; heading and lat/long live on the radar panel |
| `radar.ts` | `createRadar(heightMap, waterBodies, seaLevel, towns)`, `RADAR_RANGE` | 2D canvas scope, no draw calls |
| `main.ts` | — | bootstrap and frame loop |

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
ship.update(dt, input, energyState, windState)  // thrust gated on energy.canThrust
camera.update(dt, shipState, input)
globe.update(dt, env, wind.state)  // daynight first, then water (reads wind), land, citylights, clouds, sky
docks.update(dt, env, shipState, energyState)
wake.update(dt, shipState, env)
hud.update(shipState, energyState, windState)
radar.update(dt, shipState, windState)
postFx.render(dt, scene, camera)
controls.endFrame()
```

Power runs **before** the ship, so it charges for a frame of travel the ship has
already made rather than one it might not be able to afford. `globe.update` is
what writes `env`, so the sun the solar panels see is one frame old too — 16 ms
of a 30-minute day.

Wind is wedged **between** the two, and the order is load bearing in both
directions. It runs after energy because a berth is shelter and `energy.ts`
owns the only definition of docked, so the wind has to see this frame's verdict
rather than last frame's. It runs before the ship because the ship spends the
push the same frame it is written. Energy therefore still bills last frame's
speed, exactly as it did before.

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

## Day, night, and travel
`daynight.ts` places the sun in world space from elapsed time alone, and every
shader decides day or night from `dot(surface normal, sunDirection)` at the
point being drawn. Local time is therefore a property of *where the ship is*,
never of a clock it carries, and cross-timezone travel falls out for free: sail
east into the sunrise and dawn arrives sooner, sail west and you hold the
sunset. Nothing models this; deleting it would take work.

The numbers are worth knowing before retuning `DAY_LENGTH`. The terminator
sweeps the ground at `2*PI*GLOBE_RADIUS / DAY_LENGTH` — 0.35 world units a
second — while the ship does 20. About sixty to one, the reverse of Earth,
where the ground beats a ship roughly forty to one. So at anchor the cycle is
the hour `DAY_LENGTH` says, and under way it is not: full ahead east collapses
it to about a minute, and full ahead west reverses the sun outright. Only a
shorter day, a slower ship or a larger `GLOBE_RADIUS` moves that ratio — the
last because it slows the ship in degrees without slowing the sun.

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
- `heading` and `bearing` survive as derived readings for the compass, the HUD
  and the scope. They still spin at the pole. That is what a compass does there,
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
12 o'clock and north swings round the rim.

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

The panel's head row carries **LAT, heading and LON** above the glass. The
range readout is gone — it never varied, so it was a constant printed every
frame. The wind arrow rides the rim on the true bearing from the **live** frame,
not the raster's: it is attached to nothing on the picture, so projecting it
through a frame up to a tenth of a second old would simply lag the bow through
every turn. It carries the gust glyph on its **tail**, byte-for-byte the same
SVG path data the SPD row uses, parsed by `Path2D` so the two cannot drift
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
| Solar (stopped only) | `SOLAR_PEAK * max(0, up · sunDirection)` — 185 s at noon, 6.6 min at 30°, negative after dark |
| Berth | 40 s, overrides solar rather than stacking |
| Mooring | 2 s continuously inside the ring — see below |
| Empty | thrust refused until `RESTART_LEVEL` (3%) |

`MAX_FORWARD` is exported from `ship.ts` and imported here rather than copied,
so a change to top speed moves the fuel economy with it instead of silently
rebalancing the game. The burn is quadratic, which is what makes cruising slowly
a strategy rather than a slower way to arrive equally empty.

**A berth connects on a dwell, not on a speed.** It used to require the ring
*and* under 3 kn of ground speed, which was a proxy and wrong at both ends:
true of a hull drifting quietly across the ring on the wind, false of one that
had genuinely arrived and not yet lost way. Two seconds inside the ring asks
the question the ring is drawn to ask. It gives the same protection the speed
limit did — the zone is 16 units across, so a straight run through it lasts
1.07 s at 15 kn and 1.6 s at 10 — and it drops this file's last reader of
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
- **`mode: 'empty'` outranks everything**, a berth included, because it is a
  statement about thrust rather than about charge.

`energy.update` runs before `ship.update` and therefore bills last frame's
speed. That is deliberate: the alternative is the ship spending power it turns
out not to have.

## Wind

`wind.ts` owns one `WindState`, mutated in place for the life of the run, on
the same terms as `EnergyState`: `ship.ts`, `hud.ts`, `radar.ts` and `shipfx.ts`
all hold that one reference. Handing out a copy would leave them reading a wind
that had stopped moving.

**The state machine** alternates forever between a **calm** (3–15 s, speed
exactly 0) and an **event** (5–30 s, one fixed bearing drawn uniformly per
event). Speed during an event is `envelope × gust × cap`:

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
ceiling beyond the arithmetic and reaches ~20.6 kn flat out downwind under the
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

The three wave layers drift along `wind.direction` at 1.5 / 1.9 / 2.4 world
units per second at `OCEAN_CAP`, and wave height runs as `strength²`, where
`strength` is `speed / OCEAN_CAP` — the same cap the radar arrow scales its
length by, so a full-length arrow and a full sea arrive together. Height square,
drift linear: a freshening wind lengthens the swell noticeably before it starts
throwing it about.

**The trap: the drift offsets are positions, not velocities.** The shader used
`p + DRIFT * uTime`, which encodes where the field has *always* been — so
changing the drift rewrites its whole history and every shift of wind would
teleport the ocean by minutes of travel. They are now integrated on the CPU
each frame, so a change of wind changes only where the sea goes next. Measured:
a 90° shift moves the field by one frame's travel, 0.025 world units. The lake
clock still works because `motion` is constant in time, so scaling an
integrated offset is the same as integrating a scaled rate.

Two floors, both deliberate departures from strict proportionality. Calms run
3–15 s, and a sea whose height and drift both go to zero is a mirror — which
reads as a bug, not as weather. `CALM_DRIFT` (0.2) and `CALM_INTENSITY` (0.16)
survive a calm, running on the last bearing the wind held, which is roughly
what real swell does. Between those floors and a full gale the law is exact:
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
| `ShipState.speed` | engine only, along the bow | the burn, turn rate, bob, sway, bank, `MAX_FORWARD` clamp, `STOP_EPSILON`, the solar test |
| `ShipState.groundSpeed` | engine + wind, signed | the HUD's `SPD` row, the berth connect test |

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
at `8 + 8 × (5/40)` = **9.0 kn** — confirmed in a live run, where the lowest cap
observed anywhere was exactly 9.00. The 8 is what the ramp extrapolates to at a
coast distance of zero, which no reading can produce. Both numbers are
implemented as specified rather than one being quietly bent to fit the other; if
a true 8 kn at the shoreline is ever wanted, either add a ring at 0 or treat a
hit on the innermost ring as distance zero.

**Feedback.** The HUD carries a `WND` row (arrow relative to the bow, matching
the bow-up scope, or `CALM`) and breaks the `SPD` row down into ground speed
plus the wind's signed contribution, which is what makes the grip rule legible.
The radar draws a rim arrow on the wind's *true* bearing in the **overlay**
pass on the live frame, like the north mark — it is not attached to terrain, so
the stale-raster-frame rule does not apply to it. `shipfx.ts` streams the flag
along the **apparent** wind (true wind minus the hull's own motion, so a 15 kn
ship in a calm streams astern — it used to lean toward the bow, because the
model was authored around a permanent following wind) and adds the tailwind
component to the sail's belly. The model only bellies the sail one way, so beam and head winds
show on the flag and not on the sail.

## Towns, berths and the dock zones
`towns.ts` owns settlement placement, which used to live inside `citylights.ts`
and be thrown away as soon as the lights were scattered. Four modules need those
positions now, so the search moved out and `citylights.ts` became a consumer like
the rest — it draws its own PRNG stream from `TOWN_SEED ^ 0x9e3779b9`, so the
lamps shifted once, deliberately, and are fixed from here. Town positions did not
move.

**Every town is a port.** A candidate that cannot find a berth is not founded
at all, so `Town.dock` is non-null for every town in `all` and the fleet is the
map. `CLUSTER_TARGET` came down a quarter with that rule, 76 → **57**, because
76 towns used to yield 48 berths and leaving the target alone would have handed
the player half again as many places to charge. It fills in under 6000 of its
20000 tries.

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
