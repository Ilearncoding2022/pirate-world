# Water, wake and terrain rendering — implementation plan

Status: **implemented**, and landed on `main`.

This document is kept as the record of what was approved. Like
`docs/WIND_PLAN.md`, it is deliberately NOT updated to follow later tuning —
`docs/ARCHITECTURE.md` is the current truth. Five things it says turned out to
be wrong, and they are worth knowing before trusting the rest:

- **The fog density is wrong.** The plan specifies `0.8 / GLOBE_RADIUS`. At the
  distances the orbital camera actually works at, that saturates and flattens
  the ocean's whole depth palette into a pale sheet. The shipped value is
  `2.0 / GLOBE_RADIUS` with a hard ceiling on the blend and a falloff with
  camera altitude, because none of it works at all three framings otherwise.
- **The GGX specular must be normalised, not capped.** The plan does not say
  either way, and capping was tried first. Raw `D` peaks near 25 at the
  near-field roughness, so clamping it flattens the top of the lobe rather than
  narrowing it, and the near water turns into a white sheet. Dividing by the
  peak is the fix, and the `PI` cancels.
- **`WATER_DISPLACED` is vestigial.** The define is set on the patch material
  and the seam exists in the vertex shader, but nothing branches on it. The
  patch's normal runs through the same finite difference the sphere uses, which
  is why this is harmless rather than a bug. Finish it or delete it.
- **The "one line" file budgets were unrealistic.** Wiring a patch, a wake map
  and a reflection cube into `globe.ts` and `main.ts` takes more than a line
  each, and two streams each wanted their own parameter on `createGlobe`. They
  go through a single water-plugin list instead.
- **Cube mip sampling is not available.** These are legacy-GLSL shaders, which
  compile as ES 1.00 even on WebGL2, so there is no texture-LOD extension. The
  reflection cube is small enough to read as pre-blurred and is sampled flat.

Two visual regressions reached the integration branch and were caught by
comparing screenshots, not by any assertion: the fog above, and the specular
above. Both passed a green build, every unit test and an empty console-error
list. `docs/TESTING.md` records what that means for how much a green run is
worth.

This document is the complete brief. An implementing agent should not need the
conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**World scale**, **The shared height map**, **Frame loop**, **Shader notes**
and **Post-processing and colour management** — every stream below adds to
those conventions and none may break them. Read `ART-DIRECTION.md` §1, §2.2
and §2.4 before choosing any colour.

The work is split into phases. Phase 0 is short and mostly sequential: it puts
a regression harness in place and pulls the water shader apart so that five
agents can then work on it at once without merging each other's GLSL by hand.
Phase 1 is the five parallel streams. Phase 2 is one integration agent and the
owner's visual pass. Phase 3 is the larger items, deferred until the owner has
signed off on Phase 2 by eye.

## Decisions already made

Settled with the project owner. Do not re-litigate them; if one turns out to be
unworkable, say so and stop rather than substituting another.

| Question | Decision |
|---|---|
| Renderer | **WebGL2 stays.** No WebGPU port, no TSL. Every technique below is render-to-texture on the existing `WebGLRenderer`. |
| Hardware acceleration | Already in place: every shader runs on the GPU and `main.ts` asks for the high-performance adapter. Nothing to "turn on". |
| Assets | Still none. Everything procedural, generated at startup or in-shader. No texture files. |
| Testing | **Regression only.** Tests prove the world, the physics and the pipeline still behave and that nothing fails to compile or throws. No test asserts on how anything looks; the owner inspects visually. |
| Screenshots | The harness saves screenshots at fixed stations for the owner to look at. They are artefacts, never assertions. |
| Colour | In-world glow is cyan `#59ddff` family and the hull's authored neon. **Magenta never appears in the world** (ART-DIRECTION §2.4). |
| Reflections | Low-resolution cubemap plus glow decals. **Not** screen-space reflection: the camera looks down on the sea, so the sources that should reflect are off-screen or at grazing angles where SSR fails, and the RGBA8 composer target has no normal buffer. |
| Land material | Stays `MeshStandardMaterial`, extended with `onBeforeCompile`, so it keeps the three-light rig and is shadow-ready. `postfx.ts` is changed to chain `onBeforeCompile` instead of throwing. |
| Scope guard | The frame loop order in ARCHITECTURE is preserved. New systems slot in; nothing is reordered. |

## Baseline: what is wrong today

Observed on `main` at `ca773b6`, chase view, headless software render.

- **Water** (`src/water.ts`). One smooth sphere; every wave is a fragment-side
  normal trick, so the waterline against the hull and the horizon are flat. The
  hull's bob is a fixed sine (`ship.ts` ~line 721) unrelated to the wave field.
  The reflected sky is two constants (`uSkyColor`, `uHorizonColor`); nothing in
  the world reflects. Blinn-Phong glint with no sun disc. No aerial perspective,
  so the sea meets the atmosphere shell as a hard edge, and the shell's 8-bit
  gradient shows as concentric rings.
- **Wake** (`src/wake.ts`). A flat translucent decal. Its foam texture is a
  sine of distance sailed (`band`, `fleck`, ~line 191), which reads as regular
  stripes. No Kelvin pattern, no bow hump, no stern trough. The ribbon never
  talks to the water shader; waves do not tilt through it and it is lit only by
  a sun dot. Spray is round untextured points.
- **Terrain** (`src/land.ts`). One colour per vertex, flat shading, triangles
  about 2.2 units across, nothing per pixel. No slope or curvature response,
  no occlusion, no shadowing, no haze. Beach is a hard colour step.

## Phase 0 — foundation

Three agents. **T** runs first and alone (it creates `package.json` scripts and
the `tests/` tree everyone else writes into). **Q** and **W0** then run in
parallel, each in a worktree, and merge before Phase 1 starts.

### T — regression harness

Owns: `package.json`, `package-lock.json`, `tsconfig.test.json` (new),
`vitest.config.ts` (new), `playwright.config.ts` (new), `tests/**` (new),
`.gitignore` (add `tests/out/`).

Adds `vitest` and `playwright` as devDependencies. Playwright must **not**
download browsers in `npm install`; the smoke test uses the Chromium already
in `%LOCALAPPDATA%/ms-playwright/chromium-1243` and fails with a clear message
if it is absent. Scripts:

```
"test":       "vitest run",
"test:smoke": "playwright test",
"test:all":   "npm run build && npm test && npm run test:smoke"
```

`tsc` in `build` keeps `include: ["src"]`; tests type-check through
`tsconfig.test.json` which extends the main one and adds `tests`.

**Unit tests** (`tests/unit/*.test.ts`, Node, no WebGL). Three's math and
`BufferGeometry` work in Node; nothing here may touch a renderer.

| Test | Asserts |
|---|---|
| `geo` | `latLonToDir`/`dirToLatLon` round trip; `tangentFrame` orthonormal off the poles; `headingToForward` on the four cardinal headings. |
| `terrain-golden` | `heightAt` at 64 fixed directions equals a fixture captured from `main` now, to 1e-9. This pins the coastline: no stream may move it. |
| `heightmap` | Bilinear `sample` matches a hand-computed value on a 4×2 map; wrap in u, clamp in v; `dirToEquirect` in GLSL and `sample` in TS use the same mapping (test the TS side of the formula). |
| `world-golden` | Land fraction after `cullIslets`, lake fraction from `createWaterBodies`, town count and every `Town.dock` non-null, all equal to fixtures captured now. Built at the real 2048×1024, so this is the slow test (~2 s); mark it as such. |
| `ship-physics` | From rest with forward held, engine speed reaches `MAX_FORWARD` and stays; `position` stays unit length to 1e-9 over 600 steps; halt zeroes speed; reverse never exceeds its own cap. Uses a stub terrain whose `isLand` is always false. |
| `wake-ring` | After N updates at speed, `liveRibs` ≤ `RIB_CAPACITY`, draw range is contiguous and inside the doubled index buffer, no rib has a zero `aRight`. Requires `createWake` to expose a read-only `debug` view; adding it is T's only change to `src/`. |
| `wind` | Speed never exceeds `OCEAN_CAP`; `direction` stays unit; docked ⇒ zero. |
| `save` | Round trip and garbage tolerance. |

Golden fixtures live in `tests/fixtures/*.json`. Any later stream that
legitimately changes a golden updates the fixture **in the same commit** and
says so in its report. A golden that changes without such a note is a
regression.

**Smoke test** (`tests/smoke/game.spec.ts`, Playwright). Builds with
`vite build`, serves `dist` with `vite preview` on port 4173, launches
Chromium headless with `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader --ignore-gpu-blocklist`, 1600×900, DPR 1.

1. Collect every `console.error`, every `pageerror`, and every `console.warn`
   whose text starts with `THREE.`. Three reports shader compile and link
   failures through `console.error`, so **this one check is the shader
   regression test** for every stream. The final assertion is that the
   collected list is empty.
2. Wait 6 s, screenshot `idle`. Decode with `pngjs`; assert mean luminance
   over the centre 60% of the frame is above 6/255 and the frame has more than
   64 distinct colours. Guards against a black or single-colour canvas.
3. Read the HUD `SPD` text. Hold `KeyW` 5 s, read again; assert it increased.
   Screenshot `sailing`. Materials compile lazily on first draw, so the wake and
   spray shaders are only exercised here — do not shorten this step.
4. Hold `KeyD` 2.5 s, screenshot `turning`, release.
5. Wheel +300, wait 3 s, screenshot `mid`. Wheel +600, wait 3 s, screenshot
   `far`. Release `KeyW`.
6. Load again with `?quality=low` and repeat step 1–2 only. (Quality tiers
   arrive from Q; until then this step is skipped by feature-detecting the
   query parameter's effect through `window.__pirateWorld?.quality`.)

Screenshots go to `tests/out/<label>/` where `<label>` is `SMOKE_LABEL` from
the environment or `main`. They are for the owner; nothing compares them.

Every screenshot here is a **software render**. It proves the shaders compile
and the pipeline runs. It does not prove the look or the frame rate on a real
GPU; the owner checks both.

### Q — quality tiers, GPU timer, postfx chaining

Owns: `src/quality.ts` (new), `src/layers.ts` (new), `src/postfx.ts`,
`src/main.ts`, `src/hud.ts` (one dev line), `src/style.css` (one rule).

- `quality.ts`: `QualityTier = 'low' | 'medium' | 'high'`. Resolved once at
  startup from `?quality=` then `localStorage['pirate-world/quality']` then
  a default of `'high'`. Exposes a frozen settings object read by the modules
  built after it:

  | Setting | low | medium | high |
  |---|---|---|---|
  | `pixelRatioCap` | 1 | 1.5 | 2 |
  | `waveChop` | off | on | on |
  | `bloomMaxWidth` | 960 | 1280 | 1280 |
  | `wakeMapSize` | 256 | 512 | 512 |
  | `patchSegments` | 96 | 128 | 160 |
  | `reflectionSize` | 0 (off) | 128 | 256 |
  | `reflectionFacesPerFrame` | 0 | 1 | 2 |

  Streams A, B, D read their rows; Q only defines them. Also exposes
  `window.__pirateWorld = { quality }` in dev and preview builds (guarded on
  `import.meta.env.MODE !== 'production'` is wrong here because preview serves
  a production build; guard on a `?debug` or `?quality` parameter being
  present instead).
- `layers.ts`: `LAYER_DEFAULT = 0`, `LAYER_REFLECTED = 1`. Constants only, so
  D and any later stream agree on the numbers.
- GPU timer: `EXT_disjoint_timer_query_webgl2` around `composer.render`, with
  the standard async result queue; when the extension is missing the overlay
  shows `n/a`. Rolling 60-frame mean of GPU ms, CPU frame ms and
  `renderer.info.render.calls`, in a small monospace line at the bottom of the
  telemetry panel, toggled with `Backquote`. Off by default.
- `postfx.ts`: replace the `throw` in `selfEncodeToSRGB` with chaining — keep
  the existing `onBeforeCompile`, call it first, then apply the encode
  replacement. Keep the `customProgramCacheKey` unique per combination (append
  the previous key if one exists). This is what lets Stream C extend the land
  material. Add a unit test in `tests/unit/postfx-chain.test.ts` that builds a
  `MeshStandardMaterial` with a prior hook, patches it, and checks both hooks
  run in order on a fake shader object.
- `main.ts`: build `quality` first, pass `pixelRatioCap` to the two
  `setPixelRatio` calls.

### W0 — water shader decomposition

Owns: `src/water.ts`, `src/waterglsl.ts` (new), `src/noiseglsl.ts` (new),
`src/fogglsl.ts` (new), `src/globe.ts`, `docs/ARCHITECTURE.md` (Shader notes).

The point of this stream is that `water.ts` is the file every Phase 1 stream
wants to edit. After W0, they edit their own files instead.

- Move `NOISE_GLSL` to `noiseglsl.ts` unchanged (land will import it too).
- Move the fragment shader body into `waterglsl.ts` as named chunks:
  `WATER_UNIFORMS`, `WATER_WAVEFIELD`, `WATER_DEPTH`, `WATER_LIGHTING`,
  `WATER_FOAM`, `WATER_OUTPUT`. The vertex shader gains a `#ifdef
  WATER_DISPLACED` block (empty for now) and the material a `defines` map.
- Define the **water plugin** contract in `water.ts`:

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
  export type WaterHook = 'normal' | 'foam' | 'reflection' | 'colour';
  export function createWater(terrain, heightMap, waterBodies, plugins?: WaterPlugin[]): Water;
  ```

  Slots, and the variables in scope at each, are documented in
  `waterglsl.ts` above the chunk that contains them:

  | Hook | Where | In scope, may be modified |
  |---|---|---|
  | `normal` | after `N` is built, before lighting | `N` (unit), read `n`, `vWorldPos`, `camDist`, `w0` |
  | `foam` | inside the foam section, before `col = mix(col, foamLit, …)`; also runs when `fd >= 2.6` | `foam` (0–1 mask), read everything above |
  | `reflection` | after `skyCol` is computed | `skyCol` |
  | `colour` | after all lighting and foam, before the sRGB encode | `col` |

  Uniform names are prefixed by plugin (`uWake…`, `uRefl…`) so two plugins
  never collide. A plugin's `update` receives the ship and the camera because
  the wake map and the reflection cube both follow the ship; `globe.update`
  therefore gains `ship: ShipState` and `camera: THREE.Camera` parameters, and
  ARCHITECTURE's **Frame loop** is updated to show it.
- `fogglsl.ts`: the aerial-perspective **contract**, with a placeholder body
  that returns its input unchanged. Signature:

  ```glsl
  uniform vec3 uFogColorDay; uniform vec3 uFogColorNight; uniform float uFogDensity;
  vec3 applyAerial(vec3 col, vec3 worldPos, vec3 camPos, vec3 sunDir, float dayFactor);
  ```

  Stream E writes the body; Stream C calls it from the land shader. W0 wires
  the `colour` hook of the water to call it and adds the three uniforms to
  `WATER_UNIFORMS`. The uniforms are owned by a tiny `src/fog.ts` that exposes
  `fogUniforms` (one shared object) and `updateFog(env)`, called from
  `globe.update` before water and land.
- **Golden string test** (`tests/unit/water-shader.test.ts`): with no plugins,
  `material.fragmentShader` and `vertexShader` must equal fixtures captured
  from `main` **before** this refactor, modulo whitespace-only changes. This
  is the proof that the decomposition changed nothing. Streams that
  intentionally change the shader (E, and W0's own fog hook) update the
  fixture in the same commit.

## Phase 1 — five parallel streams

Launch all five in one message, each with `isolation: "worktree"` on a branch
named `feat/render-<letter>`. Each agent gets: this file, its own section, the
**Rules for every stream** below, and nothing else from the conversation.

### Rules for every stream

1. Touch only the files listed under **Owns**. If the work truly needs another
   file, stop and report; do not edit it.
2. `npm run build && npm test` must pass before reporting, and
   `npm run test:smoke` must pass with `SMOKE_LABEL=<letter>` so the
   screenshots land in `tests/out/<letter>/`.
3. Every new number the owner might want to tune is a named constant at the
   top of its file with a comment saying what it does in world units, exactly
   as `water.ts` and `wake.ts` already do. World-scale versus ship-scale (see
   ARCHITECTURE **World scale**) must be stated in the comment.
4. No `uniform` that Three already injects; legacy GLSL style; joined-array
   shaders. Hand-written `ShaderMaterial`s encode to sRGB themselves at the
   end, stock materials do not (ARCHITECTURE **Post-processing**).
5. Nothing allocates per frame. Module-scope scratch vectors, as in `wake.ts`.
6. No debug harness may be left in `index.html` or `main.ts`. Anything for a
   test lives behind a `?probe=` query parameter handled in one place
   (`src/dev/probe.ts`, created by whichever stream needs it first — that is B)
   and is listed in the report. A killed agent has left temp harnesses in
   `index.html` before; the integration agent greps for them regardless.
7. Report format: files changed, constants added with their defaults, goldens
   updated and why, known interactions with other streams, and the path to
   the screenshot set.

### A — wake map

Owns: `src/wake.ts`, `src/wakemap.ts` (new), `src/waterwake.ts` (new, the
plugin), one line in `src/globe.ts` (register the plugin), one line in
`src/main.ts` (pass the wake to the globe or the plugin).

Goal: the wake becomes an **input to the water shader** rather than a decal
drawn over it.

- `wakemap.ts`: a `WebGLRenderTarget` of `quality.wakeMapSize`² RGBA8,
  linear filtered, covering `WAKE_MAP_EXTENT = 48` world units square
  (ship-scale) centred `WAKE_MAP_AHEAD = -12` units along `ship.forward` from
  the ship, so most of the map trails astern. An `OrthographicCamera` sits
  `WAKE_CAM_HEIGHT = 30` units above the surface along `ship.up` looking down
  it, with its own up vector `tangentFrame(ship.up).north`. Both the write and
  the read use that same frame in the same frame of animation, so the pole
  degeneracy ARCHITECTURE warns about cancels; nothing is stored in the frame.
- Channels: **R** foam density 0–1, **G** surface height offset encoded as
  `0.5 + h * WAKE_HEIGHT_SCALE`, **B** foam age 0–1 (for colour), **A**
  unused. Cleared to `(0, 0.5, 0, 0)` each frame.
- What is rendered into it, all with `LAYER_REFLECTED` **cleared** and a
  dedicated `wakeMapMaterial` per mesh:
  1. The existing ribbon, with the sine `band`/`fleck` **deleted** and
     replaced by `snoise(vWorldPosition * WAKE_FOAM_FREQ)` at two octaves keyed
     to world position, so the foam sits still in the water and is irregular.
     Writes R and B.
  2. A **Kelvin pattern** quad the length of the trail: in the ribbon's
     `vDist`/`vSide` parameterisation, height
     `cos(k * (dist - 0.5 * side² …))` with the classic 19.47° envelope
     approximated as `exp(-((|side| - KELVIN_ARM) / KELVIN_WIDTH)²)` for the
     divergent arms plus a transverse `cos(k * dist)` term, both scaled by
     `speedFrac` and fading with age. Writes G. Wavelength constant
     `KELVIN_WAVELENGTH = 2.6` world units at `MAX_FORWARD` and proportional to
     speed², as the physics says.
  3. A **bow hump and stern trough**: one small quad under the hull writing
     `+WAKE_BOW_HEIGHT` ahead of the stem and `-WAKE_STERN_DEPTH` behind the
     transom, scaled by `speedFrac`.
  4. A **stern churn** quad `STERN_CHURN_LENGTH = 2.5` units long with
     scrolling two-octave noise, R only, brightest at the transom.
- `waterwake.ts` plugin: uniforms `uWakeMap`, `uWakeCentre` (world),
  `uWakeEast`, `uWakeNorth`, `uWakeExtent`. Declarations project
  `vWorldPos - uWakeCentre` onto east/north to a uv and sample; a helper
  returns `(foam, height, age)` and the height's gradient by two extra taps.
  `normal` hook: tilt `N` by the gradient times `WAKE_NORMAL_STRENGTH`.
  `foam` hook: `foam = max(foam, wakeFoam * breakup)` where `breakup` is the
  same world-keyed noise the ribbon used, so map and shader agree. `colour`
  hook: near the stern, foam picks up `WAKE_NEON_TINT` (a desaturated cyan,
  `#8fe8ff` at 0.25 weight) scaled by night, which is the "cold glow" the art
  direction asks for on everything in this world. Never magenta.
- The on-screen ribbon and spray still draw as today (Stream B may raise
  `SURFACE_LIFT`; see integration). Once the owner is happy with the map-driven
  foam, deleting the on-screen ribbon draw is a one-line change in Phase 2 and
  is left to the owner's eye.
- Cost: one extra small render pass per frame. Budget 0.4 ms GPU on the
  owner's machine.
- Regression: `tests/unit/wakemap.test.ts` — the TS projection (world → map
  uv) is exported as a pure function and must agree with the GLSL formula
  transcribed into TS at 32 random points on the sphere near the ship, and
  must be the identity's inverse of the camera placement (a point placed at
  the map centre maps to uv 0.5). `wake-ring` keeps passing. Smoke run must
  compile the four new materials, which only happens while sailing.

### B — displacement patch and a hull that rides the sea

Owns: `src/wavefield.ts` (new), `src/waterpatch.ts` (new), `src/ship.ts`
(bob/sway block only), `src/dev/probe.ts` (new), `src/main.ts` (probe hook,
one guarded line), one line in `src/globe.ts`, `tests/unit/wavefield.test.ts`,
`tests/smoke/wave-parity.spec.ts`.

Goal: the sea near the ship has real height, and the hull sits on it.

- `wavefield.ts`: a **CPU port** of the GLSL `waveField` for the swell and wave
  layers only (never chop): Ashima `snoise` transcribed line for line in
  float64, the same `stretch`/`ridge` helpers, the same `FREQ_*` constants
  imported from a shared `src/waveconstants.ts` that `waterglsl.ts` also
  reads (B creates `waveconstants.ts` by moving the three wavelength constants
  and `AXIS_*` out of `water.ts`/`waterglsl.ts`; this is the one edit B makes
  to W0's files and it is a pure move). Exposes
  `sampleWave(dir, offsets, motion, out: {h, gu, gv})` with the gradient by the
  same finite difference the shader uses (`NORMAL_STEP`). The offsets are the
  three integrated `uOffset*` vectors; `water.ts` exposes them read-only as
  `water.offsets`.
- `waterpatch.ts`: a flat grid of `quality.patchSegments`² vertices spanning
  `PATCH_EXTENT = 80` world units (ship-scale), positioned each frame in the
  vertex shader: grid xy → `centre + east * x + north * y` → `normalize` →
  `* GLOBE_RADIUS` → `+ up * height * amplitude`. `centre`, `east`, `north`
  are uniforms from `tangentFrame(ship.up)`, and the centre is **snapped** to
  a multiple of the grid spacing in that tangent plane so vertices do not swim
  as the ship moves. Amplitude: `DISPLACE_AMPLITUDE = 0.30` world units at a
  full gale, times `uWaveIntensity`, times a skirt fade to 0 over the outer 15%
  of the patch so it meets the sphere. Uses the **same** fragment shader as the
  sphere with `WATER_DISPLACED` defined, in which the `normal` from the
  displaced field replaces the sphere's `tanU/tanV` reconstruction for the
  swell and wave layers while chop stays fragment-side. `polygonOffset` on
  the patch material so the skirt does not z-fight the sphere. The sphere's
  own shader is unchanged.
- The vertex-side field uses `#include`-style pasting of the same
  `WATER_WAVEFIELD` chunk, so the two are identical by construction. If the
  vertex stage cost is a problem at `high`, the chop `if` is already gated.
- `ship.ts`: replace the sine `bob` with `sampleWave` at the hull centre for
  heave, and at bow/stern and port/starboard points (`HULL_SAMPLE_HALF_LENGTH
  = 1.4`, `HULL_SAMPLE_HALF_BEAM = 0.55`, ship-scale, scaled by `MODEL_SCALE`)
  for pitch and roll, each low-pass filtered with `HULL_RESPONSE = 3.0` per
  second. Keep a residual of the old sine at `BOB_AMPLITUDE * 0.3` so a dead
  calm still breathes. `bankRoll` from the helm is unchanged and adds on top.
  The hull must never go below the displaced surface: the sampled heave is
  also added to the position radius.
- `src/dev/probe.ts`: when `?probe=wave` is present, `main.ts` calls
  `runProbe()` instead of building the game. The probe renders a 128×128 quad
  with the GLSL `waveField` (swell + wave, `motion = 1`, fixed offsets, a
  fixed patch of directions around lon 0) into the canvas as grey, and puts
  the same 128×128 of CPU samples on `window.__pirateWorld.probe`. This is
  the only file allowed to reference a probe, and it must be removed from the
  graph by tree-shaking in a normal load (guard on the query string before
  importing).
- Cost: `patchSegments`² vertices × 6 `snoise` (two layers, three taps). At
  160² that is ~150 k snoise per frame in the vertex stage; budget 0.6 ms.
- Regression:
  - `wavefield.test.ts`: `snoise` is deterministic and bounded in [-1, 1]
    over 10 k random inputs; `sampleWave` gradient by finite difference agrees
    with a smaller-step finite difference to 5%.
  - `wave-parity.spec.ts` (smoke): loads `?probe=wave`, screenshots, decodes,
    and asserts the GPU grey equals the CPU value within 3/255 at every
    sample. This is what proves the hull rides the same sea the player sees.
  - `ship-physics` keeps passing; `terrain-golden` and `world-golden`
    unchanged.

### C — terrain per pixel, baked occlusion and horizon shadow

Owns: `src/land.ts`, `src/heightmap.ts` (additive: new fields),
`src/terrainbake.ts` (new), `tests/unit/terrainbake.test.ts`.

Goal: land stops reading as clay without adding a single vertex.

- `terrainbake.ts`: pure functions over a `Float32Array` equirectangular
  height field, run once at startup at **1024×512** (a 2× downsample of the
  shared map; the AO and horizon are low-frequency so nothing is lost):
  - `bakeAmbientOcclusion(data, w, h, seaLevel)`: 8 directions × 12 steps of
    horizon cone occlusion with the equirect metric corrected by `cos(lat)`.
    Output 0–1.
  - `bakeHorizon(data, w, h)`: for each of 8 azimuths the maximum elevation
    angle to the terrain along that azimuth, encoded 0–1 over 0–60°. Output
    two RGBA8 textures, four azimuths each.
  - Budget: under 300 ms on the main thread, measured and logged once at
    `debug` level. If it cannot be met, run it in a `Worker` and let the land
    draw unoccluded until it lands; do **not** shrink the resolution further.
- `heightmap.ts`: gains `aux: DataTexture` (R = AO, G/B/A free) and
  `horizon: [DataTexture, DataTexture]`, built by calling the bake after
  `cullIslets` has run and `flush` has been called — so the bake happens in
  `globe.ts` order, after the cull. Additive only; the existing texture, data
  and `sample` are untouched.
- `land.ts`: `MeshStandardMaterial` extended through `onBeforeCompile`
  (allowed after Q's chaining change):
  - Vertex: pass the unit direction `vDir` and world position.
  - Fragment, before `<color_fragment>`: sample the height map for height,
    slope (finite difference, `cos(lat)`-corrected) and curvature
    (Laplacian). Drive: rock where slope > `ROCK_SLOPE`; sand within
    `BEACH_BAND`; a **wet sand** band `WET_BAND = 0.012` above sea level,
    darkened by `WET_DARKEN = 0.55`; ridge lighten and valley darken by
    curvature × `CURVATURE_TINT`; two-octave triplanar-in-direction-space
    simplex (import `noiseglsl.ts`) for grass mottling and rock striation.
    The vertex colour is kept as the base and modulated, so the palette in
    `PALETTE` still rules the look.
  - Normal: blend the flat-shaded geometric normal with a per-pixel normal
    from the height-map gradient at `FACET_BLEND = 0.4` (0 = pure facets,
    1 = fully smooth). The art direction asks for beveled low-poly, not blocks
    and not photoreal; 0.4 is the opening bid.
  - Lighting: multiply diffuse and ambient by AO to `AO_STRENGTH = 0.8`; for
    the key light, compare the sun's elevation at this point with the horizon
    angle interpolated between the two nearest baked azimuths and soften the
    result over `HORIZON_SOFTNESS = 4°` — a sun-tracking self shadow with no
    shadow map.
  - `colour`: call `applyAerial` from `fogglsl.ts` before the encode, with the
    shared `fogUniforms` merged into the material's uniforms via the hook.
- Cost: ~6 extra texture taps and ~4 `snoise` per land pixel; budget 0.8 ms
  at 1080p.
- Regression:
  - `terrainbake.test.ts`: a flat field bakes AO = 1 everywhere and horizon =
    0; a single cone of known slope bakes the analytically known horizon angle
    at a ring of points to 1°; output arrays have the requested size and are
    in range.
  - `world-golden` unchanged (the bake reads, never writes).
  - Land mesh vertex count and `landRadius` at 8 fixed heights equal a fixture
    captured now (added to `world-golden` by C).

### D — neon in the water

Owns: `src/reflection.ts` (new), `src/waterreflect.ts` (new, the plugin),
`src/shipfx.ts` (expose glow), `src/docks.ts` (set layer on beacons),
`src/citylights.ts` (set layer), `src/sky.ts` (set layer), `src/clouds.ts`
(set layer), one line each in `src/globe.ts` and `src/main.ts`,
`tests/unit/reflection.test.ts`.

Goal: the beacons, the sky, the town lights and the hull's own neon appear in
the water at night. This is the signature shot.

- `reflection.ts`: a `CubeCamera` with a `WebGLCubeRenderTarget` of
  `quality.reflectionSize`, RGBA8, mipmapped, linear. Positioned at the ship's
  water-level point. Renders **only** objects with `LAYER_REFLECTED` enabled:
  the sky shell, the cloud deck, the beacons and their glow, the city lights.
  Not the land (its silhouette against the sky matters little at 128 px and it
  is the most expensive draw), not the water, never the ship. Renders
  `quality.reflectionFacesPerFrame` faces per frame round-robin, so a full
  refresh takes 3 or 6 frames; `update(dt, ship, renderer, scene)` does the
  scheduling and is a pure function of a counter, exported for the test.
  Disabled entirely when `reflectionSize` is 0.
- Colour space trap: stock materials are patched to self-encode sRGB
  regardless of target, so anything stock that lands in the cube arrives
  sRGB-encoded. The beacons and lights are hand-written shaders that also
  encode at the end. The cube therefore holds **sRGB**, and the plugin decodes
  with `pow(c, 2.2)` on sample. State this in a comment at the sample site.
- `waterreflect.ts` plugin: `reflection` hook replaces `skyCol` with
  `mix(skyCol, decoded cube sample along reflect(-viewDir, N), uReflWeight)`
  where the LOD is chosen by the wave tilt (`textureCubeLodEXT` is not
  available in legacy GLSL on WebGL2 — use `textureLod` via the
  `#version 300 es` path Three compiles to; if that fails to link, fall back to
  a fixed bias). `REFL_WEIGHT = 0.6` by day, `1.0` by night, driven by
  `lightAmt` which is in scope.
- **Hull neon decal**: the hull itself cannot be in the cube (the camera is
  inside it). Instead the plugin's `colour` hook adds a fake reflection: a
  vertical streak under the ship, `uNeonColor * uNeonLevel`, shaped by
  `exp(-(across / NEON_STREAK_WIDTH)²)` across the view-projected ship
  direction and `exp(-along / NEON_STREAK_LENGTH)` along it, broken up by
  `N` and gated by Fresnel. `shipfx.ts` exposes `glow: { color: Color;
  level: number }` updated in its existing `update`, which is the neon's
  current colour and its dimming under a flat battery, so the reflection dies
  with the lights.
- Cost: `facesPerFrame` × a 128² or 256² render of the emissive set. Budget
  0.8 ms amortised.
- Regression: `reflection.test.ts` — the face scheduler visits all six faces
  every `6 / facesPerFrame` frames and never the same face twice in a cycle;
  the layer mask constants match `layers.ts`; `glow.level` stays in [0, 1] as
  the energy level sweeps. Smoke must compile with `?quality=low` (cube off)
  and default (cube on).

### E — lighting polish and aerial perspective

Owns: `src/waterglsl.ts` (`WATER_LIGHTING` chunk only), `src/fogglsl.ts`
(body), `src/fog.ts` (tuning), `src/sky.ts` (dither + expose colour),
`tests/fixtures/water-shader.*.json` (updated goldens).

Goal: the sun on the water looks like a sun, crests glow when backlit, and
the world fades into its atmosphere instead of ending at a hard line.

- Specular: replace the two Blinn-Phong lobes with **GGX** (`D` only, with
  the existing Fresnel and `road` gates kept) and a sun disc of angular radius
  `SUN_DISC_RADIANS = 0.03` (larger than real, an art choice) so the glint is
  a road of discs rather than pin pricks. Roughness still runs from
  `nearMid` as today, so the orbital view keeps its tight spot.
- Backscatter: `scatter = pow(clamp(dot(viewDir, -sunDir), 0, 1),
  SCATTER_POWER) * max(w0, 0) * uWaveIntensity`, tinted `uScatterColor`
  (`#1fd0b4`, the existing shallow colour, so the palette does not grow),
  added to `col` at `SCATTER_STRENGTH = 0.35`. Reads as light through crests
  when sailing into the sun.
- `fogglsl.ts` body: distance-based blend of `col` toward
  `mix(uFogColorNight, uFogColorDay, dayFactor)` with
  `1 - exp(-dist * uFogDensity)`, plus a grazing-angle term so the horizon
  band gets more haze than the ground under the camera. `fog.ts` drives the
  two colours from `env.sunColor` and the sky's atmosphere colour (E adds a
  read-only `atmosphereColor` to `sky.ts`) and `uFogDensity` from a constant
  `FOG_DENSITY = 0.004` per world unit (world-scale: written as
  `0.8 / GLOBE_RADIUS`).
- Dither: the concentric rings on the atmosphere shell are 8-bit banding of a
  smooth gradient. Add an ordered/hash dither of ±0.5/255 before the encode in
  `sky.ts` and in `WATER_OUTPUT`. Cheap and fixes the rings on every GPU.
- Regression: update the water shader goldens in the same commit with a note
  in the report listing each intentional change. `sky.ts` gets a golden
  string test of its own added by E. Smoke passes.

## Phase 2 — integration

One agent on `main` after all five branches are ready, then the owner.

1. Merge in this order, running `npm run test:all` after each: **C**, **E**,
   **D**, **A**, **B**. C and E touch nothing the others depend on; D, A and B
   each add a plugin line to `globe.ts`, so the later merges are one-line
   conflicts by design.
2. Reconcile the things that sit at the water surface and now meet a surface
   that moves by up to `DISPLACE_AMPLITUDE`:
   - `wake.ts` `SURFACE_LIFT` (0.1) and the spray spawn height (`+0.12`);
   - `docks.ts` `RING_LIFT`;
   - `citylights.ts` `LIGHT_LIFT` is on land and is unaffected.
   The simplest rule: raise each lift to `DISPLACE_AMPLITUDE + old lift` and
   list the new values in the report. If the on-screen ribbon then floats
   visibly, note it; the owner decides whether to stop drawing it (Stream A
   made that a one-line change).
3. Grep `index.html`, `main.ts` and `globe.ts` for any `probe`, `debug` or
   `__pirateWorld` reference that is not the documented `?probe=`/`?quality=`
   handling, and remove it.
4. Update `docs/ARCHITECTURE.md`: module table rows for every new file, the
   plugin contract under **Shader notes**, the fog contract, the layers, the
   new `globe.update` signature in **Frame loop**, the quality tiers, and a
   note under **Post-processing** that `onBeforeCompile` is now chained.
5. Produce the screenshot set with `SMOKE_LABEL=integrated`, then hand over.
   The owner runs the game on real hardware, opens the timer overlay, and
   inspects: chase view idle and sailing, night and day, a turn, the mid and
   orbital views, a docked ship at night, a beach at both zooms.
6. Tuning is the owner's, by constant. The integration agent does not tune.
7. The release ritual (docs, commits split by stream, push) is triggered by
   the owner, not by this plan.

## Performance budget

To be **measured on the owner's machine** with Q's overlay; nothing here can be
measured under software rendering. Targets at 1080p, `high`, mid-range
discrete GPU:

| Item | Budget (GPU ms) |
|---|---|
| Whole frame | ≤ 8.0 |
| Bloom (unchanged) | as today |
| Wake map pass | 0.4 |
| Displacement patch | 0.6 |
| Land shader delta | 0.8 |
| Reflection cube, amortised | 0.8 |
| Water lighting delta | 0.2 |

If the total is over budget the tiers drop features in this order:
reflection size, wake map size, patch segments, chop octave, pixel ratio cap.
That order is already encoded in Q's table; the owner moves a machine to a
lower tier rather than a feature being cut.

## Phase 3 — deferred until the owner signs off Phase 2

Each is its own stream later, and each was chosen to build on Phase 1 rather
than replace it.

- **Gerstner mid layer.** Replace the ridged `WAVE` octave with three Gerstner
  trains along the wind, with horizontal displacement; the CPU port in
  `wavefield.ts` gets the same trains, so the hull still rides the sea. Sharper,
  directional crests.
- **FFT ocean.** A 256² Phillips spectrum evolved by ping-pong fragment passes
  (WebGL2 needs no compute for this), sampled by the patch and by the CPU
  through a per-frame readback of a 32² tile. Only if Gerstner is judged not
  enough.
- **Spray sprites.** Generate a 4×4 procedural droplet atlas on a canvas at
  startup; the spray points sample it, stretch along velocity, and are lit by
  the same sun and neon terms as the foam.
- **Shadow map.** One directional shadow for the hull and the land within
  ~60 units of the ship, following the ship. Land is already
  `MeshStandardMaterial`, so it receives for free; the water plugin gets a
  `shadow` hook.
- **Ship-local land patch.** Vertex-shader displacement of a dense patch from
  the height map, so beaches and cliffs near the ship get geometry finer than
  2.2 units. Phase 1 C's per-pixel shading already reads the map, so this only
  adds silhouette.
- **Depth-buffer shoreline.** A soft foam and translucency band where the land
  mesh actually intersects the water, from a depth texture. The composer
  target is MSAA RGBA8 and a multisampled depth texture is not portable; this
  needs a separate depth pre-pass, which is why it is deferred.

## Agent roster

| Phase | Agent | Branch | Runs with |
|---|---|---|---|
| 0 | T harness | `feat/render-t` | alone, first |
| 0 | Q quality/timer/postfx | `feat/render-q` | W0 |
| 0 | W0 water decomposition | `feat/render-w0` | Q |
| 1 | A wake map | `feat/render-a` | B, C, D, E |
| 1 | B displacement + hull | `feat/render-b` | A, C, D, E |
| 1 | C terrain | `feat/render-c` | A, B, D, E |
| 1 | D reflections | `feat/render-d` | A, B, C, E |
| 1 | E lighting + fog | `feat/render-e` | A, B, C, D |
| 2 | I integration | `main` | alone |

Nine agents, three waves. Every Phase 1 agent is handed the same three
inputs: `docs/ARCHITECTURE.md`, this file, and its letter.

### File ownership matrix

A cell means the stream may edit the file. Blank means it may not.

| File | T | Q | W0 | A | B | C | D | E | I |
|---|---|---|---|---|---|---|---|---|---|
| `package.json`, `tests/**` | ● | test | test | test | test | test | test | test | ● |
| `postfx.ts` | | ● | | | | | | | |
| `quality.ts`, `layers.ts` | | ● | | | | | | | |
| `main.ts` | | ● | | 1 line | probe | | 1 line | | grep |
| `hud.ts`, `style.css` | | ● | | | | | | | |
| `water.ts` | | | ● | | offsets | | | | |
| `waterglsl.ts` | | | ● | | | | | lighting | |
| `noiseglsl.ts` | | | ● | | | read | | | |
| `fogglsl.ts`, `fog.ts` | | | contract | | | read | | ● | |
| `waveconstants.ts` | | | | | ● (move) | | | | |
| `globe.ts` | | | ● | 1 line | 1 line | | 1 line | | ● |
| `wake.ts` | debug view | | | ● | | | | | lifts |
| `wakemap.ts`, `waterwake.ts` | | | | ● | | | | | |
| `wavefield.ts`, `waterpatch.ts`, `dev/probe.ts` | | | | | ● | | | | |
| `ship.ts` | | | | | bob/sway | | | | |
| `land.ts`, `terrainbake.ts` | | | | | | ● | | | |
| `heightmap.ts` | | | | | | additive | | | |
| `reflection.ts`, `waterreflect.ts` | | | | | | | ● | | |
| `shipfx.ts` | | | | | | | glow | | |
| `docks.ts`, `citylights.ts`, `clouds.ts` | | | | | | | layer | | lifts |
| `sky.ts` | | | | | | | layer | dither, colour | |
| `docs/ARCHITECTURE.md` | | | shader notes | | | | | | ● |

`test` means the stream adds its own test files under `tests/unit` or
`tests/smoke` and touches nothing else there. D and E both edit `sky.ts` in
disjoint places (a layer flag on the mesh; a dither and an exported colour in
the shader); the integration agent expects that conflict and it is trivial.
