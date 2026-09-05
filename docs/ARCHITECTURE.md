# Pirate World — architecture

Vite + Three.js + TypeScript. No external art assets; everything is procedural.

## Conventions (see `src/geo.ts`)
- `GLOBE_RADIUS = 100`. The water surface sits at exactly this radius.
- +Y is the north pole. lon 0 = +Z, lon +90 = +X. Use `latLonToDir` / `dirToLatLon`.
- Heading: radians, 0 = north, clockwise positive (east = PI/2). Use `headingToForward`.
- `tangentFrame(up)` gives the local `north` and `east` tangents.
- Ship length is about 5.6 world units, so the ship is ~1/18 of the planet radius.

## Units, pinned
These have bitten us once. Do not reinterpret them in a consumer.
- `InputState.zoomDelta` is in **wheel notches** (1.0 ≈ one detent ≈ 100px of `deltaY`).
  Consume as-is. `controls.endFrame()` resets it.
- `dt` is **seconds**, already clamped to ≤ 0.1 by `main.ts`.
- `Terrain.heightAt` returns roughly **[-1, 1]**. Land is `> terrain.seaLevel` (0.08).
- `WorldEnv.elapsed` is **seconds** since start. `timeOfDay` is **[0, 1)**.

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
| `terrain.ts` | `createTerrain(seed?)`, `SEA_LEVEL`, `DEFAULT_SEED` | seeded fBm |
| `land.ts` | `createLand(terrain)`, `landRadius`, `MAX_LAND_RELIEF`, `COAST_LIFT` | land-only mesh, sub-sea vertices sink under the water |
| `water.ts` | `createWater(terrain, heightMap)` | full sphere at `GLOBE_RADIUS` |
| `grid.ts` | `createGrid()` | lat/long lines |
| `sky.ts` | `createSky()` | atmosphere shell + starfield |
| `daynight.ts` | `createDayNight()` | lights, writes `WorldEnv` |
| `clouds.ts` | `createClouds()` | cloud shell |
| `citylights.ts` | `createCityLights(terrain, heightMap)` | night-side settlements |
| `wake.ts` | `createWake()` | ship wake and spray |
| `postfx.ts` | `createPostFx(renderer)` | composer / bloom |
| `globe.ts` | `createGlobe(terrain): { group, heightMap, update(dt, env) }` | orchestrator only |
| `ship.ts` | `createShip(terrain, start?)` | model + physics + collision |
| `camera.ts` | `createFollowCamera(aspect)` | follow camera, tracks ship up |
| `controls.ts` | `createControls()` | keyboard + on-screen D-pad + wheel |
| `hud.ts` | `createHud()` | compass, speed, lat/long |
| `main.ts` | — | bootstrap and frame loop |

## Land / water split
`land.ts` builds an icosphere, drops every face lying entirely below
`seaLevel - CULL_MARGIN`, and displaces the rest. Kept vertices below sea level
are pushed *under* the water sphere so shores run into the sea instead of
forming floating plates.

`water.ts` is one smooth full sphere at `GLOBE_RADIUS`. Dry parts are simply
hidden by the land above. All coastal detail (shallows, foam) is computed per
pixel from the height map, so the water mesh stays cheap.

## Frame loop
```
ship.update(dt, input)
camera.update(dt, shipState, input)
globe.update(dt, env)      // daynight first, then water, land, citylights, clouds, sky
wake.update(dt, shipState, env)
hud.update(shipState)
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
difference. If you add a stock material after the first frame, it will not be
patched; add it before the first `postFx.render`.
