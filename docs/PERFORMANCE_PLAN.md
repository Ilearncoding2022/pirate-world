# Ship battle performance: review and plan

Status: review only. Nothing in this document has been implemented yet.

The complaint: the game stutters in a cannon fight, and it stutters most
when the player presses the D-pad or the FIRE key. This is a read of the
whole battle frame branch (`main.ts`, `frame()`, the `battleUi.isOpen`
branch) and every module it calls, looking for the hitch and for the
steady-state cost around it. Findings are ranked by how well they match the
symptom, then by per-frame cost. File and line references are against
v0.28.0.

## What is NOT the problem

Worth stating first, because it narrows the search to the render side.

- **The sim is trivial.** `battle.ts` moves two angles, a handful of balls
  and a few events per tick; `battleai.ts` and `battlesea.ts` are small
  arithmetic. Nothing in it is input-dependent beyond `omegaPlayer`.
- **The strip and the sim input are diff-cached.** `battleui.ts` writes the
  DOM only when a value moves (`paintSide`, `lastFusePct`, `lastFouledHidden`,
  `lastPromptHidden`). `controls.ts` is event-driven and `endFrame()` is one
  field write. Pressing W or S changes nothing per frame except one float.
- **No audio fires on a shot.** `audio.ts` is only reached by the hunt.
- **No per-shot allocation of meshes, lights or materials.** Balls, splashes,
  flashes, crests and rafts are pooled at construction in `battlescene.ts`.
- **`postFx.render` does not rebuild anything on the camera swap.** The
  scene and camera are field writes on the render pass (`postfx.ts:481`).

So a press does almost no CPU work of its own. What it does is make something
*visible* for the first time, and change the *style* of a button.

## Findings

### 1. First-shot shader compiles (best match for "press FIRE, stutter")

The arena's props are built once but every one of them ships `visible =
false`: the 12 cannonballs (`battlescene.ts:584`), the 6 splash rings
(`:636`), the crest slots (`:755`) and the rafts (`raftmesh.ts:104`). Three
skips invisible meshes in `projectObject`, so their programs are never built
until the first frame each becomes visible. Those flips are exactly the
player's actions:

- first FIRE lights `balls[0].visible = true` (`battlescene.ts:1070`) and
  compiles the ball's `MeshStandardMaterial` program, a full PBR shader with
  the world's fog and four point lights in it;
- about a second later the first splash compiles the ring's material
  (`:1108`);
- the first crest of the fight compiles the crest `ShaderMaterial` (`:1026`).

The loading screen's warm-up frame (`main.ts:2333`, `WARM_DT`) cannot help:
the props are not in `scene` until `onCoverReady` adds them (`main.ts:1665`),
and even then they are hidden. There is no `renderer.compile` or
`compileAsync` call anywhere in `src/`. `battlescene.ts:211` even names the
hitch it was trying to avoid; pooling the meshes avoided the allocation but
not the compile.

The 12 ball materials share one program (identical parameters and the same
`customProgramCacheKey` from `postfx.ts:190`), so this is three or four
distinct compiles per fight, not thirty, but the first one is the big one
and it lands on the first press.

### 2. Every fight recompiles the whole world, twice

`scene.add(battleScene.props)` puts four `PointLight`s into the world scene
(three muzzle flashes, `battlescene.ts:654`, and the fuse, `:667`). The
lights hash changes, so every lit material in the world (hull, AI hulls,
land, derelicts, rafts) gets a new program on the next frame. The same
happens in reverse on `scene.remove` at `main.ts:1874`.

Both land inside `blackout.run`, behind an opaque sheet with a 0.4 s hold,
so this is not the input hitch. It is still two multi-hundred-millisecond
stalls per fight, it throws away the warm-up frame's programs, and it makes
every lit fragment in the fight loop over four point lights, three of which
are dark for all but 120 ms at a time.

### 3. Forced synchronous layout on `hit` and `aim` events

`battleui.ts:582` and `:587` read `offsetWidth` to restart a CSS animation.
Each read flushes style and layout for the whole document, and the HUD is a
big tree under a 4,400-line stylesheet. `aim` fires on every enemy shot
cycle, `hit` on every ball the player takes. Periodic, not input-correlated
with the player's own key, but it is a reflow in the middle of a frame that
is already the heaviest in the game.

### 4. D-pad and FIRE key CSS repaints (best match for "press D-pad, stutter")

`controls.ts` toggles `.active` on the pressed key, and `.dbtn.active`
(`style.css:1455`) transitions `box-shadow` (a 60 px blur), `background`
(a gradient), `border-color` and `color` over 130 ms, on an element that
carries `backdrop-filter: blur(8px) saturate(1.2)`. None of those properties
is compositor-only, so for eight or so frames after every press and every
release the main thread re-rasters the button, and the compositor re-runs
the backdrop blur over a region of a WebGL canvas that changes every frame.
`.battle__fire` (`style.css:4161`) has the same shape: a `color-mix` glow, a
`:hover` shadow change and a `:active` transform.

On its own this is a couple of milliseconds per frame on a phone. It matters
because the battle frame has no headroom left (finding 5), so a couple of
milliseconds is the difference between 60 and 45.

There are 29 `backdrop-filter` rules in `style.css`. In a fight the
telemetry and radar panels are hidden, but the four helm keys, the two
strip sides (`.bside`) and the FIRE key are all still blurring the canvas
every frame whether or not anything is pressed.

### 5. The battle branch is the heaviest frame in the game

The fight is drawn in the world (`docs/ROADMAP.md` step 1), so the branch
runs everything the sailing branch runs, minus the ship physics, plus the
arena. Steady-state GPU work per frame on the `high` tier, which is the
default with no auto-detection (`quality.ts:230`):

| Work | Where | Cost shape |
|---|---|---|
| Two extra full-scene renders into the reflection cube | `reflection.ts:161`, `reflectionFacesPerFrame: 2` | Two scene-graph walks and two draws per frame, plus a mip regeneration |
| Wake map render | `wakemap.ts:513`, 512 px target | One offscreen render of a private two-mesh scene; cheap but unconditional |
| Bloom chain | `postfx.ts:437`, six full-screen passes over a five-step pyramid | Fill-rate bound, capped at 1280 px working width |
| Water shader over nearly the whole screen | arena camera at (0, 19, 52) looking down at the ring | The most expensive fragment shader in the project fills more pixels than it does in the chase view |
| Rain | 24,000 drops on high | Uniform-only when it rains, early-out when it does not |
| Fog bank | 14 slices on high | Pure fill rate; battle caps fog at 0.35 rather than zero |

Nothing here is wrong. It is the sum that leaves no room for the compiles
and repaints above, and it is why they show as stutter rather than as a
missed millisecond.

### 6. Per-frame work that is wasted or allocating (small, cumulative)

- `timedial.ts:103` repaints its 2D canvas every frame with no diff: a
  layout-forcing `clientWidth` read, a `createRadialGradient` allocation, two
  font-string parses and two `fillText` calls. In a fight the dial is inside
  the hidden radar panel, so the read returns 0 and `resizeToCss` bails
  early. Outside a fight it is a steady ~0.5 ms for a reading that moves
  once a second.
- `weathermap.ts:207` rebakes a 512 x 256 texture four times a second while
  any weather cell is alive and re-uploads it. That is a periodic spike of
  its own, unrelated to input.
- `main.ts:1754` `battleWeather` spreads a fresh `WeatherState` every frame
  while fog or rain is above its cap.
- `battleui.ts:497` returns a fresh `BattleInput` object per frame;
  `battle.ts` pushes one object per event. Tiny.
- `hud.ts` builds about 15 template strings per frame before its caches
  reject them. Tiny.
- `battlescene.ts:974` and `wake.ts:629` read `window.innerWidth/Height`
  every frame. Usually free, occasionally a layout flush.
- `reflection.ts:55` allocates a small `faces` array per frame.

## Plan, in the order it should be done

Each step is independently shippable and independently measurable with the
Backquote overlay (GPU ms, CPU ms, draw calls; see **Quality tiers and the
dev timing overlay** in `docs/ARCHITECTURE.md`). Watch the CPU figure at the
instant of a press: the 60-frame rolling mean smears a 300 ms stall into a
+5 ms bump, so look for the bump rather than the spike.

### Step 1. Pre-compile the arena behind the blackout

Inside `onCoverReady`'s `blackout.run` callback, immediately after
`scene.add(battleScene.props)`, call
`renderer.compile(battleScene.props, battleScene.camera, scene)` (or
`compileAsync`, awaited before the fade lifts). `compile` gathers materials
with a plain `traverse`, not `traverseVisible`, so the hidden balls, rings,
crests and rafts get their programs then. It must run after the add, so the
four point lights are in the hash the programs are built against; in the
loading warm-up frame it would compile the wrong variant and be wasted.

Verify the traversal claim against the installed `three@0.182` source before
relying on it; `node_modules` was not present in this checkout.

Pros: directly removes the first-shot, first-splash and first-crest hitches;
one call, one place, behind a screen that is already black; no change to
any shader or pool.
Cons: adds compile time to the blackout hold, which may need to grow from
0.4 s on slow GPUs; `compileAsync` is the safer spelling but makes the entry
sequence asynchronous.

### Step 2. Stop the light-count churn

Two options.

**2a. Keep the four point lights in the world scene permanently**, at
intensity 0 outside a fight, and only reparent the meshes. Then the lights
hash never changes, the warm-up frame compiles the real programs, and entry
and exit stop recompiling the world.
Pros: removes both blackout stalls and the double program set; smallest
diff.
Cons: every lit fragment in the sailing game pays four dark point lights it
never sees; a `visible = false` toggle would not help, since Three counts
visible lights only and would put the hash change back.

**2b. Replace the point lights with something unlit**: an emissive sprite or
a small additive quad for the muzzle and hit flashes, and an emissive pulse
on the AI hull for the fuse.
Pros: no lights hash at all, no per-fragment cost, and the flash reads
better against bloom; the fuse light currently has to be told the hull's
position every frame anyway.
Cons: loses the flash lighting the water and the near hull, which is part of
the look; a bigger change with an art decision in it.

Recommendation: 2a first, since it is mechanical and measurable, and revisit
2b if the four-light fragment cost shows on the low tier.

### Step 3. Take the forced reflows out of the hit and fuse flashes

Replace `void el.offsetWidth` with either the Web Animations API
(`el.animate(...)` returns a handle that can be `cancel()`ed and replayed
without a reflow) or a two-frame class toggle. Pool the two animations at
build time so a hit is a `play()` call.
Pros: removes a whole-document layout flush from every enemy shot; small,
local to `battleui.ts`.
Cons: `element.animate` keyframes duplicate what `style.css` declares, so the
two must be kept in step, or the keyframes must be read off the stylesheet.

### Step 4. Make the pressed-key styling compositor-only

For `.dbtn.active` and `.battle__fire:active`, drive the pressed look
through `transform` and `opacity` on a pre-rendered glow layer (a
`::after` with the lit gradient and shadow, faded in with `opacity`) rather
than transitioning `box-shadow`, `background` and `border-color`. Drop
`backdrop-filter` from the keys in a fight, or globally on the `low` tier,
via `body.in-battle .dbtn { backdrop-filter: none }`.
Pros: a press stops costing main-thread raster; the biggest single
per-press cost on phones goes away; pure CSS.
Cons: the pressed look changes subtly (a crossfade rather than a true
shadow interpolation); the blur behind the keys is part of the HUD style
and removing it in fights will be visible on a bright sea.

### Step 5. Lower the fight's steady-state cost

Options, cheapest first.

- **Halve the reflection during a fight**: pass a per-branch face budget so
  the battle branch renders one cube face per frame instead of two (the
  ring is stationary and the sky changes slowly).
  Pros: one full-scene walk and draw back per frame. Cons: the reflection
  lags the sky by up to six frames instead of three; invisible in practice.
- **Auto-detect the quality tier** on first run from `devicePixelRatio`,
  `navigator.hardwareConcurrency` and a one-frame GPU timing sample, instead
  of defaulting every machine to `high`.
  Pros: the single biggest lever on phones; the table and the override
  already exist. Cons: a heuristic can misjudge; needs a visible way to
  override, which the menu could carry.
- **Skip `timeDial.update` when its canvas is display-none** by testing
  `hidden` once rather than reading `clientWidth` each frame, and diff the
  dial on the rounded readout so it repaints when the reading moves.
- **Throttle `weathermap` bakes** further while a fight is up, or bake
  incrementally, so the 4 Hz spike stops landing on the heaviest frame.
- **Scratch-object `battleWeather`**, the `BattleInput` return and the
  `reflection` faces array. Zero-risk, measurable only under GC pressure.

### Step 6. Measure first, on the target device

Before any of the above, capture a baseline on the machine that shows the
stutter: Backquote overlay on, `?battle=1&calm=1` to start a fight
immediately, and a Chrome performance trace across ten presses of FIRE and
ten of W. The trace will show whether the press frame is a `ProgramLink`
(finding 1), a `Layout` (finding 3), a `Paint`/`Composite` (finding 4) or a
GPU stall (finding 5). Steps 1 to 4 are cheap enough to do regardless, but
the trace decides how far into step 5 to go.

## Out of scope for this branch

- Replacing the bloom pass or the water shader. Both are the look of the
  game and both are already tiered.
- Moving the sim to a fixed timestep. It is not the cost and the closed-form
  drag in `ship.ts` already makes the physics rate-independent.
- Touch-event latency work in `controls.ts`. The pad already captures the
  pointer and calls `preventDefault`; nothing there adds a frame.
