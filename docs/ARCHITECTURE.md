# Pirate World — architecture

Vite + Three.js + TypeScript. No external art assets; everything is procedural.

## Conventions (see `src/geo.ts`)
- `GLOBE_RADIUS = 200`. The water surface sits at exactly this radius. See
  **World scale** below before changing it — half the constants in the project
  are written relative to it and half are deliberately not.
- +Y is the north pole. lon 0 = +Z, lon +90 = +X. Use `latLonToDir` / `dirToLatLon`.
- Heading: radians, 0 = north, clockwise positive (east = PI/2). Use `headingToForward`.
- `tangentFrame(up)` gives the local `north` and `east` tangents.
- Ship length is about 5.6 world units, so the ship is ~1/36 of the planet radius.

## Units, pinned
These have bitten us once. Do not reinterpret them in a consumer.
- `InputState.zoomDelta` is in **wheel notches** (1.0 ≈ one detent ≈ 100px of `deltaY`).
  Consume as-is. `controls.endFrame()` resets it.
- `dt` is **seconds**, already clamped to ≤ 0.1 by `main.ts`.
- `Terrain.heightAt` returns roughly **[-1, 1]**. Land is `> terrain.seaLevel` (0.08).
- `WorldEnv.elapsed` is **seconds** since start. `timeOfDay` is **[0, 1)**.
- `ShipState.speed` is **world units per second**, which `hud.ts` prints as
  knots. So is `RADAR_RANGE`, and so is the cloud deck's `DRIFT_SPEED`.

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

Drag is integrated in **closed form**, not stepped:

```ts
const terminal = thrust / DRAG;
state.speed = terminal + (state.speed - terminal) * Math.exp(-DRAG * dt);
```

Stepping thrust and then drag lands on `(ACCEL / DRAG) * (1 - DRAG * dt)`,
which makes the top speed depend on the frame rate: 19.8 kn at 60fps, 18.6 at
10. The closed form is exactly `thrust / DRAG` at any rate, and still decays
cleanly to zero with no throttle, so the ship coasts as before.

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
| `types.ts` | `InputState`, `Terrain`, `ShipState` | interfaces only |
| `env.ts` | `WorldEnv`, `createEnv()` | shared frame state |
| `heightmap.ts` | `HeightMap`, `createHeightMap(terrain, w?, h?)`, `HEIGHTMAP_GLSL` | built once |
| `terrain.ts` | `createTerrain(seed?)`, `SEA_LEVEL`, `DEFAULT_SEED`, `SPAWN_LAT_DEG`, `SPAWN_LON_DEG` | seeded fBm; owns where the player starts |
| `waterbodies.ts` | `WaterBodies`, `createWaterBodies(heightMap, seaLevel, spawnDir)` | built once; ocean vs. inland mask, texture + CPU `sample` |
| `land.ts` | `createLand(terrain, heightMap)`, `landRadius`, `MAX_LAND_RELIEF`, `COAST_LIFT` | land-only mesh, sub-sea vertices sink under the water |
| `water.ts` | `createWater(terrain, heightMap, waterBodies)` | full sphere at `GLOBE_RADIUS` |
| `grid.ts` | `createGrid()` | lat/long lines |
| `sky.ts` | `createSky()` | atmosphere shell + starfield |
| `daynight.ts` | `createDayNight()` | lights, writes `WorldEnv` |
| `clouds.ts` | `createClouds()` | cloud deck, `SHELL_COUNT` stacked slices |
| `citylights.ts` | `createCityLights(terrain, heightMap)` | night-side settlements |
| `wake.ts` | `createWake()` | ship wake and spray |
| `postfx.ts` | `createPostFx(renderer)` | composer / bloom; `adopt(root)` for late materials |
| `globe.ts` | `createGlobe(terrain): { group, heightMap, waterBodies, update(dt, env) }` | orchestrator only |
| `ship.ts` | `createShip(terrain, start?, maxAnisotropy?)` | glTF hull + physics + collision; `ready` settles on load |
| `shipfx.ts` | `createShipFx(model, maxAnisotropy)` | animates the model's separate nodes: sail, flag, neon |
| `camera.ts` | `createFollowCamera(aspect)` | follow camera, tracks ship up |
| `controls.ts` | `createControls()` | keyboard + on-screen D-pad + wheel |
| `hud.ts` | `createHud()` | compass needle, speed, heading, lat/long |
| `radar.ts` | `createRadar(heightMap, waterBodies, seaLevel)`, `RADAR_RANGE` | 2D canvas scope, no draw calls |
| `main.ts` | — | bootstrap and frame loop |

## Land / water split
`land.ts` builds an icosphere, drops every face lying entirely below
`seaLevel - CULL_MARGIN`, and displaces the rest. Kept vertices below sea level
are pushed *under* the water sphere so shores run into the sea instead of
forming floating plates.

`water.ts` is one smooth full sphere at `GLOBE_RADIUS`. Dry parts are simply
hidden by the land above. All coastal detail (shallows, foam) is computed per
pixel from the height map, so the water mesh stays cheap.

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
ship.update(dt, input)
camera.update(dt, shipState, input)
globe.update(dt, env)      // daynight first, then water, land, citylights, clouds, sky
wake.update(dt, shipState, env)
hud.update(shipState)
radar.update(dt, shipState)
postFx.render(dt, scene, camera)
controls.endFrame()
```

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
