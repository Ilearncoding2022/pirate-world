# Roadmap and handoff

Status of the project as of **v0.19.0** (2026-09-09), and what is worth doing
next. This is a handoff document: it assumes you have read `README.md` for what
the game is and `docs/ARCHITECTURE.md` for how it is built, and it exists so
the next person does not have to re-derive which of the obvious improvements
have already been made and which have not.

Every claim below was checked against the code on the day it was written, not
recalled. Where something is absent, the check that proves it absent is named
so you can re-run it rather than trust this file.

## Where the project stands

| | |
|---|---|
| Version | 0.19.0 |
| Source | 102 TypeScript modules, ~41 200 lines, plus 3 800 lines of CSS |
| Tests | 47 unit files / 405 cases (~4 s), 8 browser cases (~2.2 min) |
| Bundle | 929 KB JS (263 KB gzipped), 40 KB CSS, one chunk |
| Assets | One 5.1 MB glTF hull, four WebP illustrations. Everything else procedural |
| Dependencies | 2 runtime (`three`, `simplex-noise`), 7 dev |

The codebase is unusually healthy in the ways that are easy to measure and
unusually exposed in the ways that are not. There is **not one TODO, FIXME,
HACK or XXX comment** in `src/` — search case-sensitively, or the `C.xxx`
swizzles in the GLSL modules will give you six false hits. The sim half is
densely tested and the architecture document is genuinely authoritative. What is missing is almost entirely
*category* rather than *quality*: no audio, no goal, no CI, no linter.

## What v0.19.0 delivered

The harbours release (`docs/HARBOURS_PLAN.md`) closed or partly closed five
items that were on the improvement list before it:

- **A world worth re-entering.** The seed was a hard-coded constant, so every
  player sailed one planet forever. It is now drawn at random on every load,
  measured, and rejected if it is unusable. Gold, the fish book, the stock, the
  hull and **the harbours you have moored at** survive; the chart does not, and
  is keyed to its seed so it cannot be drawn over a coastline that no longer
  exists.
- **Places with identity.** 40 anonymous towns and 440 unmoorable outpost
  lights became **36 named harbours**, each one town + lights + beacon + berth
  under a single name, with two fixed at the poles. The name is the identity:
  it is what the save keys on, so a harbour survives the world it was in.
- **A recurring economy sink.** Hull durability wears with time and weather and
  is knocked down by fights and maelstroms. Repair is free at a berth and 100
  gold per 10% anywhere else.
- **Difficulty that answers back.** A worn hull loses a fight in two
  broadsides and a failing one in a single broadside, which closed
  `docs/SHOP_PLAN.md`'s long-standing per-combatant prerequisite.
- **A navigation aid.** An `Esc` → HARBOURS page listing all 36 by bearing and
  distance, because a remembered harbour beyond the scope's 50-unit range was
  otherwise unfindable.

It did **not** add audio, a goal, a settings menu, CI, or any performance work.
Those were never in its scope.

## Player-facing work not yet done

Ordered by how much each would change the experience per unit of effort.

### 1. Audio — the largest single gap

There is none. Not a sound, not a tone, not a music bed. Verified by grepping
`src/`, `index.html` and `public/` for `AudioContext`, `new Audio`, `<audio>`,
`.mp3`, `.ogg`, `.wav`, `GainNode` and `createOscillator`: the only hits are
the substring `audio` inside unrelated words. Every plan document in `docs/`
lists sound as out of scope, which is how it has stayed absent through
nineteen releases.

Wind that rises with the gale, a hull working in a swell, the thruster, the
harpoon, a broadside, thunder tied to the existing `flash` envelope, and a
harbour hum would do more for how the game feels than any remaining visual
item. It fits the project's ethos too: procedural Web Audio needs no asset
pipeline, no files, and no change to the build.

**Where it goes:** a new `audio.ts` owning one `AudioContext`, driven from the
frame loop beside `hud.update`, reading the same `WeatherState`, `WindState`
and `ShipState` everything else does. The pause contract already exists — the
frozen branch is where the bed should duck.

### 2. A reason to sail somewhere

There is still no objective, quest, contract, destination or win condition.
Verified: grepping `src/` for `quest|objective|mission|win condition` returns
only unrelated uses of the word "contract" in module documentation.

v0.19.0 made the world worth re-entering and gave the player 36 named places,
which is exactly the substrate a goal needs and stops short of being one. The
cheapest thing that would work: **port-issued contracts** — carry something
from Rustwharf to Ionport inside a time or hull budget for a purse — using the
harbour list, the known-harbour memory and the bearing formatter that already
exist. A chart-completion milestone is the other obvious one and is nearly
free, since `chart.ts` already knows what fraction has been revealed.

### 3. Onboarding

A first-time player still gets a loading bar and then the sea. The `Esc` menu
now has two pages (Controls, Harbours), but the Controls page still documents
only the six keys and says nothing about `[FISH]`, `[SHOP]`, `[ANCHOR]` or
`[COIL]`, and nothing anywhere says the scope is the fuel map or that a hull
below 50% is why the ship went slow.

Contextual first-run prompts, shown once and dismissible, are the whole of the
work. There is no tutorial framework to build — `main.ts` already knows every
state a prompt would key on.

### 4. Feedback and notifications

There is no toast or notification layer. Gold changes are a silent number swap
in the telemetry panel; a caught fish, an arriving storm, a raider sighting and
a harbour first-visit all pass without comment. The hull block added in
v0.19.0 is the model to follow — it names its cause in words and colours by
severity — but it is a *panel*, and events need something transient.

Battle feedback is still pooled point lights and pips. There are no hull damage
states, no smoke, no listing.

### 5. Settings, pause, and accessibility

- **No settings menu.** Quality is URL-only (`?quality=`), so a player on a
  slow machine has no way to reach it. This is the single most user-hostile
  gap left, and the `Esc` menu now has a working multi-pane pattern to hang it
  on.
- **No real pause.** The world freezes under an overlay, but there is no
  `visibilitychange` handler, so alt-tabbing leaves the game running. Only
  `blur` is handled, and only to release stuck keys.
- **Colour is load-bearing and unaided.** Red versus orange raiders is the most
  important read in the game and is invisible to a deuteranope. A shape or
  glyph difference in `aihulls.ts` and on the scope would fix it.
- **`prefers-reduced-motion` is honoured in exactly one place**, the loading
  bar. Rain, lightning, the flashing power and hull alarms, and the maelstrom
  spin all ignore it.
- All strings are hard-coded English. There is no string table.

### 6. Camera and touch

The chase camera is wheel-zoom only: no orbit, no pan, no look-astern.
Verified: no `requestPointerLock`, no `getGamepads`, and **no pinch gesture**,
which means the nine-times zoom range the game is designed around is
unreachable on a phone.

### 7. Content breadth

One hull. Two raiders that are the same mesh recoloured. Twenty fish. The
36 harbours now have names and their own upgrade stock, which is the first
identity any location in this game has had, but there is still nothing to
*find*: no wrecks, no landmarks, no ruins, no NPCs.

### 8. Shadows

Nothing casts one. The sun crosses the sky for twenty minutes and the world is
lit but unshadowed. `docs/RENDER_PLAN.md` Phase 3 specifies a single
directional shadow map for the hull and near land; it is deferred pending the
owner's sign-off on Phase 2, not blocked.

### 9. The rest of the deferred design

Two documents hold real, costed designs that were never built:

- **`docs/SHOP_PLAN.md` — the Battle tab.** Four items, ~48 700 gold of sink:
  Chain Shot (900), Signal Smoke (1 200), Hull Plating Mk I–III
  (3 000/8 000/18 000), Long Nines Mk I–III (2 500/5 000/10 000). **Its stated
  blocker is now gone** — the per-combatant `hitsToLose` split it was waiting
  on shipped in v0.19.0 — so Hull Plating in particular is close to
  buildable. Signal Smoke is called out in that document as the best-shaped of
  the twelve because it scales with wealth and needs no tuning table.
- **`docs/RENDER_PLAN.md` Phase 3.** Gerstner mid layer, FFT ocean, spray
  sprites, shadow map, ship-local land patch, depth-buffer shoreline.

## Technical work not yet done

### 1. No device detection, no frame governor

`quality.ts` resolves to `'high'` for everyone unless a URL parameter or a
stored choice says otherwise, so a phone gets the high row: 24 000 raindrops,
14 fog slices, a 256² reflection cube refreshed two faces a frame, and a 2×
pixel-ratio cap. There is no GPU sniff, no `hardwareConcurrency` check, no
device-pixel-ratio heuristic, and **no dynamic resolution scaling** — the
settings object is `Object.freeze`d, so runtime downgrade is impossible by
construction.

This is the highest-value technical item. It is also entangled with the
settings menu above: detection without a way to override it is worse than
neither.

**Related:** the Backquote timing overlay wraps only `composer.render`, so its
`gpuMs` and draw-call figures **exclude the reflection cube faces and the wake
map** — the two passes most likely to be the problem on a weak machine.

### 2. The 5.1 MB ship

`assets/pirateship_beginner.glb` is 78% of the first-load payload and contains
18 uncompressed PNG textures. There is no Draco, no meshopt, no KTX2, and no
`DRACOLoader`/`KTX2Loader` in `src/`. Running the file through
`gltf-transform` with meshopt and KTX2 and wiring it into an npm script after
`tools/build_ship.py` is a day's work for the largest single win available.

### 3. Startup is synchronous and on the main thread

There is no `Worker` and no `OffscreenCanvas` anywhere in `src/`. The height
map (2048×1024, ~29 M noise evaluations), two flood fills, the town search and
a 2.2-million-vertex land mesh all run on the main thread behind the loading
bar. v0.19.0 made this worse in the tail case, because a rejected world pays
for the data half again — though it never pays for the mesh, and 0 of 270
measured seeds were rejected.

Moving `buildWorldData` into a Worker is now much easier than it was: the split
between data and meshes already exists, was made for the rejection loop, and is
exactly the boundary a Worker needs.

### 4. No CI, no linter, no strict mode

- **No CI of any kind.** No `.github/`, no workflow, no pipeline. Every check
  is manual on one Windows machine.
- **No ESLint, Prettier, Biome, EditorConfig, husky or lint-staged.**
- **`tsconfig.json` has no `strict`**, and no `strictNullChecks` or
  `noImplicitAny` either, so 41 000 lines compile in non-strict mode. It does
  enable `noUnusedLocals`, `noUnusedParameters` and
  `noFallthroughCasesInSwitch`.
- **`tsconfig.test.json` is referenced by no script**, so `tests/` is never
  type-checked. This has already bitten: a test fixture missing three required
  `SaveData` fields compiled happily and only failed at runtime.

A workflow running `tsc`, `vitest`, Playwright and the build would have caught
every mechanical problem in the last release without a human.

### 5. Nowhere to play it

No deploy configuration of any kind: no Pages workflow, no `netlify.toml`, no
`vercel.json`, no Dockerfile, no `manifest.json`, no service worker. **There is
no `vite.config.*` at all**, so the build is entirely Vite defaults — no
`base` path (the emitted `/assets/…` are absolute and would break on a project
page), no manual chunks, no source maps.

There is also **no error reporting and no analytics**, so a crash on someone
else's machine is invisible.

### 6. The bundle is one chunk and three.js is imported whole

23 of 102 modules do `import * as THREE from 'three'`, which defeats
tree-shaking in practice. Everything ships as a single 929 KB chunk (263 KB
gzipped); the only split is the accidental one for the `?probe=` dev harness.
Named imports plus a vendor chunk are a day's work.

### 7. Storage

`chart.ts` base64-encodes ~87 KB into `localStorage` every five seconds on the
main thread while the ship is moving — a guaranteed hitch. IndexedDB is used
nowhere.

The save file is better than it was: v0.19.0 added three fields under the
existing per-field repair convention. But an unknown version still discards
everything, there is still **one slot, no export and no import**, and the ship's
position and the world seed are deliberately not saved.

### 8. Overdraw

`water.ts` sets `renderOrder = -1`, so the most expensive fragment shader in
the scene (up to nine simplex evaluations per pixel for the finite-difference
normal) draws **first** and is then painted over by land wherever land covers
it. Drawing land first, or adding a depth prepass, is a contained change.

The radar's vector layer redraws every frame while the raster beneath it
refreshes at 10 Hz.

### 9. Failure has no handler

`postfx.ts` tests for WebGL2 to decide whether to issue a timer query, but
nothing tests for it at boot. A machine without WebGL2 throws inside the
un-awaited `startGame()` promise and **sits on the splash screen forever** with
no message. There is no `webglcontextlost` handler either.

## Suggested order

If the next stretch is one person working alone, this is the sequence with the
best ratio of felt improvement to risk. Each is independently shippable.

1. **CI, linter and strict mode.** Do this first, not because it is exciting
   but because everything after it is safer and the release ritual currently
   rests on one machine. Half a day.
2. **Audio.** The largest felt change available, no asset pipeline, no
   architectural risk.
3. **Settings menu with quality auto-detection.** These are one job: detection
   is only safe once the player can override it. Fixes the worst
   user-hostility left and the worst performance exposure at once.
4. **Compress the ship and add a deploy target.** Cuts first load by roughly
   four fifths and finally puts the game somewhere other than localhost.
5. **Contracts between named harbours.** The first actual goal, built entirely
   on substrate v0.19.0 already shipped.
6. **The Battle tab** from `SHOP_PLAN.md`, now that its blocker is gone.
7. **World generation in a Worker**, using the split that already exists.
8. Everything else, by taste.

## A standing warning

`docs/TESTING.md`'s rule is that **no test asserts on how anything looks**, and
that rule is load-bearing for the suite's speed. The price is that a whole
class of bug reaches `main` with every check green.

v0.19.0 shipped 36 harbour name labels that were built, added to the scene,
marked visible, at full opacity, with a valid texture — and 0.034 **world**
units tall, far below one pixel, because `sizeAttenuation` was described in two
comments and never set. `tsc` passed, 405 unit tests passed, 8 browser tests
passed, and no one had ever seen a label.

**Budget for looking at the game.** `npm run shots` exists for this, and
`?seed=`, `?spawn=`, `?hull=`, `?weather=`, `?hazard=` and `?clock=` exist to
put the thing you changed in front of the camera. A green build proves the game
still runs. It does not prove anyone can see what you built.
