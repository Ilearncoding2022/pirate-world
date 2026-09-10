# Land, wave face and maelstrom surface detail: implementation plan

Status: **Complete. Waves 0 to 3 landed.** Branch:
`claude/terrain-wave-maelstrom-texture-kvbh49`.

## Wave 3: what landed, and what is unverified

Two streams, S (crest silhouette) and Q (quality tiers and cost). Both merged
without a conflict. **Screenshots were cut partway through this wave at the
owner's instruction**, so the visual claims below are marked for what was
actually seen and what was not; the owner is verifying by eye.

**S: the crest's silhouette.** The wave shaded like water after Wave 1 but
still drew a mesa: a flat top with a hard corner at each shoulder, made more
conspicuous by Wave 2 because the wave is now lighter than the sea behind it.
The brief blamed the plateau's width; the real fault was that `hazPlateau` was
C1 but not C2 at the shoulder, so curvature stepped from nothing to 16.7
inside one vertex. A flat top AND a curvature step is what the eye reads as a
tabletop. It is now `hazBump(x * x)`, the bump the file already carried with
the square handed to it -- which rounds the top, removes the step, and DELETES
two baked constants rather than adding any. Same shape reused a second way is
one fewer thing the two ports can disagree over. Footprint unchanged, so
`hazards.ts`'s contact test is untouched; not steeper (30 degrees at the
shoulder against 31); parity 0/255.

Two things S declined, both correctly. A face steeper at the lip than at the
base is not available to a height field: `hazCrest` starts the crest line at
zero slope, which is what makes it a rounded top rather than a crease, so the
steepest point is necessarily inside the face. And the curvature-driven normal
the plan sketched sits in the `normal` hook, which `waterhazard.ts` owns; S
used `tiltBoost`, a seam it did own, rather than editing outside its files.

**Q: `patchSegments` stays at 160.** The plan deferred a rise to 192 to be
tried after the shader work. Q made the change and then reverted it, on a
finding that reframes the question: raising the patch's density buys none of
the shading. The patch vertex shader emits only `vDir` and `vWorldPos`; the
water shader finite-differences its own normal per PIXEL and the hazard slope
is three taps at a fixed 0.5-unit step. Neither knows how finely the grid was
cut. So 44% more vertex-shader invocations (1.54M/s to 2.21M/s at 60 fps, each
running two simplex octaves plus `hazardHeight`) buys a marginally sharper
silhouette and nothing else -- and because the grid snaps to the ship while a
maelstrom sits still, whether a vertex lands on the lip's crown is phase, not
density. `RENDER_PLAN.md` also lists patch segments as the third feature to
drop under budget pressure, which is hard to square with raising it first.

**Q: `landDetail` added to the quality table** (64/80/96 subdivisions per 100
units of radius; `land.ts` does the multiplication so the triangle keeps its
world size). High is arithmetically identical to the old fixed value, which is
what makes `world-golden.json` coming back byte-identical the real proof that
the high tier did not move. Low drops the drawn mesh from 289k triangles to
133k.

With no way to look, Q measured the coastline risk in Node instead of assuming
it: the real cull against the real height map, per tier, with the surviving
landmasses flood-filled. All 93 landmasses survive at every tier and at a
third of high's detail; the drawn envelope grows 3.2% from high to low against
a true land area of 125,654; the smallest islet goes from 50 triangles to 28.
It also found 11 faces on low spanning two landmasses and correctly judged
them harmless, since such a face's seaward vertex is sunk by `SHORE_DIP` and
dives under the water rather than bridging it.

**Integration also corrected a documentation error Q surfaced.** `land.ts`
claimed a "~2.2 unit triangle"; the icosphere at the high tier is 744,980
triangles over 502,655 square units, so the edge is about 1.25. The
finite-difference step is therefore nearly one triangle wide rather than half
of one, and always was. The number stays; the reasoning around it is now
right.

**Verified**: build and tsc clean, 140/140 unit tests, wave parity 1/255 on
the wave field and 0/255 on the hazard field through the crest reshape, all
four fixtures settled (`hazard-shader.json` moved with S, the other three
byte-identical).

**Unverified, and needing the owner's eye:**

- `SHOULDER_CHOP = 1.2` at strength. `tilt` scales with wind and every frame S
  saw was at 1 KN, so the shoulder chop was near its floor. This is the first
  constant to pull if the crest glitters in a gale.
- Anything at `?quality=low` or `medium` for the crest, and the STRONG wave
  (amplitude 1.6) at any tier -- S only ever shot the great wave at high.
- A crest and a maelstrom overlapping, to confirm the shared `steep`/
  `tiltBoost` seam behaves. The max-never-assignment discipline is preserved
  and `hazard-shader.test.ts` pins it, but no picture backs it.
- Whether a 6-unit islet drawn with 1.87-unit triangles reads as blobbier to a
  person on the low tier. The numbers say no island is lost; they cannot say
  how it looks.
- Any after-shot of the land change at any tier.

**Available but not taken**: low's `landDetail` could go to 48 (a 73% triangle
cut) and all 93 islands still survive, but the smallest islet would fall to
about 10 interior triangles and Q would not push that far without being able
to look at a beach.

## Wave 2: what integration actually changed

The four streams merged with one conflict, in the generated
`hazard-shader.json`, resolved by `npm run golden:update` as planned. Beyond
the merge, integration did seven things, and the first three are the
interesting ones because no single stream could have seen them.

1. **The maelstrom is a siphon now, and that took geometry, not shading.**
   The owner asked for water that gets lower and lower toward the centre.
   Stream M's darkening was driven by RADIUS -- `(1 - r)^2`, a fact about the
   plan view -- and capped at 0.6, which `applyAerial` then washed a third of
   straight back out. It now runs off `hazHeight0`, the field's own height at
   the pixel, with the throat's sky occluded as well, so the shading follows
   the profile the hull rides. That got the gradient onto the screen and it
   still read as a saucer, because at `FUNNEL_DEPTH` 3.0 against a radius of
   10 it WAS a saucer: 15% depth to width, seen from a camera looking along
   the surface. `FUNNEL_DEPTH` is now 4.0, and the sphere's shell is cut away
   under the patch so the hole is drawn at all. One constant, both ports read it,
   parity unmoved at 0/255.
2. **The doughnut was a compound of two independent widenings.** P widened the
   height's lip 1.5x for the polygonal-ring problem; M widened its art copy a
   further 1.18x for the same problem; neither could see the other, and 1.8x
   of lip is a doughnut. `RIM_ART_INV_SCALE` is now 1.25, i.e. the art band
   sits INSIDE the geometry lip. P predicted this interaction in its report.
3. **Foam had to be exempted from the depth darkening.** `WATER_FOAM_TAIL`
   mixes froth into `col` before the `colour` hook runs, so darkening by depth
   darkened the spiral with the water and the first cut of the siphon
   photographed as a dark disc with its arms wiped off. Froth floats on the
   descending water; it is the thing that draws the descent. `WALL_STRENGTH`
   also came down 0.85 to 0.5 so the darkened water shows between the arms at
   all.
4. `sessionQuality()` removed. `createLand` takes a `quality` parameter and
   `globe.ts` passes the one it already holds -- the shape L flagged as right
   but could not reach without owning that file.
5. `DETAIL_FADE_NEAR`/`FAR` 18/40 to 28/70. Forty units is practically beached
   on the real chase camera; the plan's number was a guess made before anyone
   had sailed at it.
6. `shots.mjs` timeouts are overridable (`--shot-timeout`, `--hazard-timeout`).
   All three hazard streams independently ran private copies of that file with
   these raised, which is the definition of a number that should be an
   argument.
7. `hazardfield.test.ts`'s vertex-step assertion is now a fraction of
   `FUNNEL_DEPTH` rather than an absolute. It was a shape assertion that would
   silently become a depth assertion, and it did: doubling the depth failed it
   while the apex it exists to check had not moved. `hazard-shader.test.ts`
   gained a case pinning that both art modules raise `steep` with `max`, never
   assignment, which is what stops two live hazards clobbering each other.

Docs updated for the new profile (`HAZARDS_PLAN.md`, `ARCHITECTURE.md` both
still described `(1 - r)^3`), the five hook slots, the crest/funnel split and
land's new quality row.

**Verified**: build and tsc clean, 139/139 unit tests, wave parity 1/255 on
the wave field and 0/255 on the hazard field through a profile change, a depth
change and two art rewrites. `terrain-golden`, `world-golden` and
`water-shader` fixtures byte-identical. The two `game.spec.ts` screenshot
timeouts are the same pre-existing SwiftShader ones that fail on the base
commit.

**Known not-right, for Wave 3 or a later pass**: the funnel's interior still
reads brighter than it should from the deck and the lip is still its most
conspicuous feature; the great wave, now lighter than the sea, shows its
flat-topped plateau silhouette more plainly than before (that silhouette is
Wave 3's `CREST_FRONT_RATIO` and `patchSegments` row); and nobody has yet
photographed land's detail normal at its shipping distance, because the
simulation runs at a tenth of wall clock in a container and the ship cannot
reach a beach.

This is the brief for making three surfaces read as vividly as the open sea
already does: the land (low-poly, rough), the front face of a great wave
(matte, clay-like, where the back reads as water) and the maelstrom (rough,
polygonal, painted rings on a cone). An implementing agent should not need
the conversation it came from. Read `docs/ARCHITECTURE.md` first, then
`docs/RENDER_PLAN.md` (stream C for land, the plugin contract for water),
`docs/HAZARDS_PLAN.md` (the parity rule) and `ART-DIRECTION.md` before
choosing any colour. `docs/TESTING.md` says what a green run is worth; the
two visual regressions recorded at the top of `RENDER_PLAN.md` are the reason
every wave below ends in screenshots, not only in assertions.

## The one diagnosis

All three surfaces compute a correct per-pixel normal and then dilute or
ignore it before lighting. The open sea looks good because its normal feeds
every term: Fresnel, GGX glint, reflection, backscatter. Concretely:

- **Land** (`src/land.ts`): the height-map normal is blended into the flat
  facet normal at only `FACET_BLEND = 0.4` (line 327); the mottling noise
  (lines 300-303) has no distance fade; `roughness 0.88` leaves no
  view-dependent term at all.
- **Wave front** (`src/waterglsl.ts`, `src/waterhazard.ts`): there is no
  front-face code path. The front is simply steep (2.0-unit run at ~64° vs a
  6.0-unit back at ~22°, `hazardfield.ts:345`), and the core shader gates
  diffuse (`mix(n, N, 0.45)`, line 211), the sun road (`dot(n, halfVec)`,
  line 280), the LOD (`graze = dot(n, viewDir)`, line 152) and backscatter
  (`w0` only, line 291) on the **smooth sphere normal `n`**, so the steeper a
  face is the more shading it loses. On top of that, the hazard foam band is
  biased onto the front (`FOAM_BIAS`, `waterhazard.ts:91`) and foam is a flat
  unlit constant (`waterglsl.ts:367-368`). That constant is the clay.
- **Maelstrom** (`src/hazardfield.ts:347-354`, `src/waterhazard.ts:219-240`):
  the profile `-D(1-r)^3` has a sharp cone apex at r = 0; the 2.4-unit lip
  spans 2 to 3 patch vertices; the swirl is a `sin^4` with no noise and no
  advection; the diffuse dilution above flattens the wall; nothing raises the
  chop or adds streaks where the water is supposedly being torn apart.

Almost none of this is vertex resolution. Every fix below is fragment-side
unless it says otherwise.

## Decisions, settled

Settled with the project owner before Wave 0. Do not re-litigate a row. If one
turns out to be unworkable, say so and stop rather than substituting another.

| Question | Decision |
|---|---|
| Lit foam for the whole sea, or hazards only? | **Whole sea.** Coastal foam gets the same Lambert + Fresnel treatment. Landed in W0-2. |
| `FACET_BLEND` target | **0.8, exposed as a quality knob.** Softens the "beveled low-poly" look `RENDER_PLAN.md:463-466` asked for; that is accepted. |
| Maelstrom apex profile | **Change it.** `(1-r)^3` becomes a bowl that is flat at r = 0. Stream P, with the parity re-record that implies. |
| `patchSegments` 160 to 192 on the high tier | **Deferred to Wave 3.** Try the shader fixes first and see whether the rim still reads as a polygon. |

## Shape of the work

Four waves. Wave 0 is one agent and mostly sequential: it cuts the seams so
that four agents can then work at once without merging each other's GLSL by
hand. Wave 1 is four parallel streams with disjoint file ownership. Wave 2 is
one integration agent plus the owner's visual pass. Wave 3 holds the geometry
items, deferred until Wave 2 has been signed off by eye.

Each Wave 1 stream works in its own git worktree on a branch off the head
that Wave 0 pushes (`claude/texture-L`, `-C`, `-M`, `-P`). The integration
agent merges them back onto `claude/terrain-wave-maelstrom-texture-kvbh49`.
Because file ownership is disjoint, the merges should be trivial; if two
streams needed the same file, the split in Wave 0 was wrong and should be
fixed there rather than resolved by hand in Wave 2.

Every stream, before it reports done: `npm run build`, `npm test`, and the
tier-appropriate screenshots via `npm run shots` against a running preview.
No stream bumps `package.json`'s version; that is a separate commit at the
end, following the existing "Set the version to X" convention.

---

## Wave 0: seams — **landed**

What actually shipped, against what this section specifies below.

- **W0-1, as written**, with one addition: `tiltBoost` was included from the
  start rather than left for M to ask for. `waterDepth` split into
  `waterSurface()` + `waterDepth(eps)` with the `slope` slot between them; the
  tangent basis moved above the LOD; four gates re-pointed from `n` to `gateN`.
- **W0-2, as written.**
- **W0-3, as written.** `hazardcrest.ts` and `hazardfunnel.ts` exist and are
  spliced by `waterhazard.ts`'s skeleton. The hazard normal moved from the
  `normal` hook to the `slope` hook, where `steepN` needs it; the `normal` hook
  now reuses the `hazSlope` computed there, so it is the same three taps used
  twice rather than a second finite difference.
- **W0-4, plus three things it did not anticipate:**
  - `?clock=<hour>` added (`main.ts`, `daynight.ts`'s new `elapsedAtLocalTime`).
    A day is 1200 s, so without it two screenshots a minute apart are lit
    differently enough to hide the change being looked at.
  - `?hazard=` turned out not to be photographable on a timer. The forced
    hazard rises three SIMULATED seconds in, `dt` is capped at 0.1 s a frame,
    and the software rasteriser draws about a frame a second — so the
    simulation runs at a tenth of wall clock and a maelstrom needs over two
    minutes to reach full envelope. **Nothing was broken**; a fixed sleep was
    simply photographing empty water. `main.ts` now republishes the live
    hazards' kind and envelope on the existing `window.__pirateWorld` debug
    hook, and `shots.mjs` has a `hazard` station that waits on
    `envelope > 0.85` (per `docs/TESTING.md` rule 2, wait for a condition) and
    is skipped entirely when the URL asked for no hazard.
  - `playwright.config.ts` and `tests/shots.mjs` only resolved Chromium under
    `%LOCALAPPDATA%`, so neither the smoke tier nor the shots ran anywhere but
    the owner's machine. Both now check `PLAYWRIGHT_CHROMIUM_PATH`, then
    `PLAYWRIGHT_BROWSERS_PATH`, then `%LOCALAPPDATA%` exactly as before. The
    Windows path is unchanged.
- **Fixtures**: `water-shader.json` regenerated with the six intentional
  changes itemised in `tests/unit/water-shader.test.ts`;
  `hazard-shader.json` and `tests/unit/hazard-shader.test.ts` added. Both
  shader fixtures now have a *writer* under `npm run golden:update` — they
  previously had none and were maintained by hand, which is not a thing to ask
  of four parallel streams. `terrain-golden.json` and `world-golden.json` are
  byte-identical.
- **Verified**: `npm run build` clean, `npx tsc --noEmit` clean, `npm test`
  137/137, `wave-parity.spec.ts` green (worst pixel diff 1/255 on the wave
  field, **0/255** on the hazard field — the hull rides the sea it is shown).
  Two `game.spec.ts` screenshot timeouts in the container are pre-existing:
  they fail identically on the base commit, and they are the 60 s Playwright
  timeout against a software rasteriser, not an assertion.
- **Baselines captured** at `?clock=10&quality=high`, `tests/out/w0-greatwave/`
  and `tests/out/w0-maelstrom/` (not committed). They confirm the diagnosis
  rather than merely recording it: the great wave's front is a matte grey slab
  with visibly polygonal edges standing in real water, and the maelstrom is a
  set of perfectly circular flat-grey rings sliding across a surface with no
  funnel visible under them at all.

The specification this was built to follows, unchanged.

### Wave 0 as specified (one agent, sequential)

Owns: `src/waterglsl.ts`, `src/water.ts`, `src/waterhazard.ts`, new
`src/hazardcrest.ts`, new `src/hazardfunnel.ts`, `tests/fixtures/water-shader.json`,
`tests/unit/water-shader.test.ts`, `src/dev/*` (spawn helper), `docs/TESTING.md`.

Goal: nothing renders differently at the end of Wave 0 except lit foam (if
approved). Everything else is plumbing.

### W0-1: a `steep` seam in the core water shader

Introduce two fragment locals the core declares and plugins may raise:

- `float steep = 0.0;` in 0..1, how far this pixel's true normal `N` should
  replace the smooth normal `n` in the gates below.
- `float crestLift = 0.0;` in world units, extra "height through which the
  sun is seen" for backscatter.

Add one new hook slot, `slope`, that runs after `n`, `tanU`, `tanV` exist
and **before** the `graze`/`lod` block, so a plugin can set `steep` early
enough to affect the LOD. Today the tangent basis is built after the LOD
(`waterglsl.ts:149-176`); reorder so the basis comes first. It is pure
arithmetic and the reorder does not change any value.

Then thread `steep` through the four gates, each as a lerp that is exactly
today's behaviour at `steep = 0`:

| Term | Today | After |
|---|---|---|
| Diffuse normal (line 211) | `mix(n, N, 0.45)` | `mix(n, N, mix(0.45, 0.90, steep))` |
| Sun-road gate (line 280) | `dot(n, halfVec)` | `dot(mix(n, N, steep), halfVec)` |
| Grazing LOD (line 152) | `dot(n, viewDir)` | `dot(mix(n, N, steep), viewDir)` (needs `N` early; if the wave normal is not yet available at the `slope` slot, plugins pass their own estimate) |
| Backscatter (line 291) | `max(w0, 0) * uWaveIntensity` | `max(w0, 0) * uWaveIntensity + crestLift` |
| `lightAmt` (line 208) | on `n` | on `mix(n, N, steep)` |

Keep `steep` out of the reflection `skyUp` term for now; the cube is rendered
from the ship's position and a steep face 20 units away would show wrong
parallax whichever normal it uses.

### W0-2: lit foam

Replace the constant `foamLit` (`waterglsl.ts:367-368`) with

```
float foamDiff = clamp(dot(N, sunDir), 0.0, 1.0);
float foamRim  = fres;                          // already computed
vec3  foamLit  = uFoamColor * mix(0.09, 0.52, lightAmt)
               * (0.55 + 0.45 * foamDiff)
               * (1.0 + 0.6 * foamRim)
               * mix(vec3(1.0), uSunColor, 0.30);
```

plus a small share of `glint` so foam sparkles where the water does. Tune so
the coastal foam at noon is no brighter than today. This is the one item in
Wave 0 that changes pixels; screenshot before and after.

### W0-3: split the hazard plugin

`src/waterhazard.ts` currently holds both the crest and the funnel GLSL in
one `foam` string. Split the art into two pure string modules that export
their share of each hook:

- `src/hazardcrest.ts`: everything under `if (hsh.x < 0.5)` plus its
  constants (`FOAM_BIAS`, `FOAM_BAND`, `FROTH_*`).
- `src/hazardfunnel.ts`: everything under the `else` plus its constants
  (`SPIRAL_*`, `FUNNEL_DARKEN`, `FUNNEL_ENV_NORM`).

`waterhazard.ts` keeps the uniform packing and the loop skeleton, and
concatenates the two modules' `slope`, `normal`, `foam` and `colour`
fragments. The locals the loop already derives (`hu`, `hv`, `ha`, `hb`,
`hr`, `hth`, `hin`, `henv`, `hazFunnel`) stay declared by the skeleton so
both modules can read them. Add a per-kind `float hazCrestMask` and
`float hazFunnelMask` (0..1) to the skeleton so Wave 1 streams can scope
their colour work without re-walking the slots.

### W0-4: fixtures, dev spawn, baseline shots

- Update `tests/fixtures/water-shader.json` via `npm run golden:update` and
  record, in the commit message and in a comment in
  `tests/unit/water-shader.test.ts`, the itemised list of intentional
  changes (the `slope` slot, the `steep`/`crestLift` locals, the four gate
  lerps, lit foam), the way the W0 report of `RENDER_PLAN.md` did.
- Add `tests/fixtures/hazard-shader.json`: the assembled fragment shader
  with the hazard plugin registered, so Wave 1 diffs are visible in review.
- Find or add a `?dev` spawn: a great wave and a maelstrom at fixed offsets
  from the hull, at a fixed sun hour, from a fixed seed, so every later
  screenshot is comparable. Document the query in `docs/TESTING.md`.
- Capture `npm run shots -- --label texture-before` on `high`, `medium` and
  `low`, with the spawn query, and commit nothing from `tests/out`.

### W0 regression

`npm test` green; `wave-parity.spec.ts` untouched and green (no height
change in Wave 0); `hazardfield.test.ts` untouched. Screenshots identical to
before except for foam if W0-2 was approved.

Pros: one agent, no merge risk, and it turns three later streams into
disjoint-file work. Cons: it is on the critical path; nothing in Wave 1 can
start until it is pushed. Budget one agent-session.

---

## Wave 1: four parallel streams

Ownership is exclusive. A stream that needs a file it does not own stops
and reports rather than editing it.

### L: land per-pixel detail

Owns: `src/land.ts`, `src/quality.ts` (additive: a `land` row),
`tests/unit/world-golden.test.ts` only if the fixture format needs a new
field (it should not).

- `FACET_BLEND` to the agreed value (0.8 recommended); add it to the
  quality table as `landFacetBlend` (low 0.6, medium 0.8, high 0.85) and read
  it through a uniform instead of a baked const so the tier can change it.
- Raise `NORMAL_GRADIENT_STRENGTH` to compensate for the stronger blend;
  target the same apparent relief on a 20° slope as today.
- Add a **detail normal**: a third direction-space `snoise` octave at 0.5 to
  0.8 world-unit wavelength (use `freq()`), finite-differenced along the
  `terrainTangentFrame`, mixed into the per-pixel normal at `DETAIL_NORMAL =
  0.35` and masked by `terrainRockMask` so grass stays soft and rock gets
  grain.
- **Distance fade** for mottling, striation and the detail normal: derive a
  `landLod` from `length(vTerrainWorldPos - cameraPosition)` the same way
  the water builds `lod` (`waterglsl.ts:149-156`); fade the detail normal to
  0 by ~40 units and mottling to half by ~120 units. No noise term at full
  amplitude at orbit height.
- **Per-mask roughness**: set `roughnessFactor` in `<roughnessmap_fragment>`
  from the wet-sand and rock masks (wet sand 0.45, rock 0.6, grass/forest
  0.88 as today, peak 0.7). This is the term that gives land a view-dependent
  rim like the water.
- Optional if budget allows: use the per-pixel normal, not only the
  height-map slope, in the rock mask so cliff faces stop being smeared with
  grass at the triangle level.

Cost: at most +2 `snoise` and +2 taps per land pixel; budget 1.2 ms at 1080p
on high, and the new fades must bring the orbit view back under today's
cost. Regression: `world-golden` unchanged (the bake reads, never writes);
`terrain-golden` unchanged; screenshots at deck, coast and orbit framings.

Pros: entirely shader-side; the constants already exist; the golden fixtures
are untouched. Cons: adds cost at exactly the framing (deck, near the coast)
that is already the heaviest; the fades are the only thing keeping it in
budget, so they are not optional.

### C: the wave's front face

Owns: `src/hazardcrest.ts`.

- In the `slope` hook, compute `steep` from the crest's own slope:
  `steep = max(steep, clamp(length(hazSlope) * 0.6, 0.0, 1.0) * hazCrestMask)`,
  so the 22° back gets a little and the 64° front gets most of it.
- Set `crestLift = hazardHeight(n) * hazCrestMask * CREST_LIFT` (start at
  0.4) so backscatter through the crest works without `uWaveIntensity`.
- **Thickness tint** in the `colour` hook: `col = mix(col, uShallow * 0.9 +
  vec3(0.0, 0.06, 0.04), thick)` where `thick = clamp(hazardHeight / 2.4,
  0, 1) * pow(fres, 0.5) * hazCrestMask`. A backlit wall of water is lighter
  and greener than the trough beside it.
- **Restructure the foam**: narrow the solid band to the lip (`FOAM_BAND`
  toward 0.25, `FOAM_BIAS` toward 0.0), and below it add streaks: `snoise`
  sampled in a frame stretched along `hv` and advected down the face with
  `uTime`, masked to the front (`hv > 0`). Aim for 20 to 30% coverage of the
  face at 30 to 60% intensity, not 50% at full.
- **Fresnel rim** on the lip: `col += skyCol * fres * hazLip * 0.4` so the
  edge catches the sky.
- Do not touch `CREST_FRONT_RATIO` or `CREST_BACK_RATIO`; the silhouette is
  P's or Wave 3's problem.

Cost: +1 `snoise` per hazard pixel; negligible globally. Regression:
`hazard-shader.json` updated with an itemised commit message; `wave-parity`
untouched; the `steep` contribution must be exactly zero when `uHazCount`
is 0 (add an assertion in `hazardfield.test.ts`'s CPU twin if it is cheap,
otherwise a note).

Pros: all inside a plugin module with documented seams; no height change;
`?quality=low` (no reflection cube) works because none of it reads
`uReflCube`. Cons: the `steep` lerp affects the sun road, so an over-tuned
value makes the sea sparkle along the whole crest; the fixture updates
twice (W0 and C) and both need honest itemising.

### M: the maelstrom's art

Owns: `src/hazardfunnel.ts`.

- **Spiral in the normal, not the height**: in the `normal` hook add a
  tangential perturbation `N -= tangential * SPIRAL_TILT * spiralPhase *
  hin * henv`, with `tangential = normalize(cross(n, radial))` and
  `spiralPhase = sin(hr * k - uTime * spin(hr) + hth * arms)`. Geometry stays
  radially symmetric so parity holds; shading finally shows flow.
- **Advected noise arms**: replace the `sin^4` with `snoise` in a rotated
  polar frame `(hr * a, hth + uTime * spin(hr), uTime * 0.2)` where inner
  rings spin faster (`spin(hr) = SPIRAL_SPIN * (0.4 + 1.2 * hin)`). Stack a
  finer octave for specks. Keep three broad arms as the low-frequency mask so
  the read is still a whirlpool, not static.
- **Torn water**: raise `steep` inside the funnel from the same slope math C
  uses; in the `slope` hook also raise a `tiltBoost` so the core's `tilt`
  (chop amplitude) is multiplied by `1.0 + 2.0 * hazFunnel`. W0 exposes
  `tiltBoost` alongside `steep` if M asks for it before W0 pushes; otherwise
  M owns adding it to the `slope` seam.
- **Lit lip and spray**: widen the lip band softly (`HAZ_RIM_INV` art copy
  at 0.6 of the height's), add edge noise so the rim is ragged water, and a
  sparse speck layer just outside the rim for spray. Foam is now lit (W0-2)
  so it will sit on the wall.
- **Depth**: keep `FUNNEL_DARKEN`, but tint toward a saturated deep green-blue
  rather than pure `uAbyss` (a constant next to the palette, agreed against
  `ART-DIRECTION.md`), and let `hazFunnel` also lower `steep`'s diffuse floor
  so the wall reads dark and glossy, not dark and matte.

Cost: +3 `snoise` inside the funnel only. Regression: `hazard-shader.json`;
`hazardfield.test.ts`'s "radially symmetric" case still passes because M
never touches the height; spin direction matches `HAZARDS_PLAN.md`.

Pros: art-only, no parity constraint, and the funnel covers few pixels so
the extra noise is cheap. Cons: it is the stream most likely to overdo it;
the arms must still read at orbit height, where the funnel is 20 pixels
wide, so M needs a distance fade on the fine octave.

### P: the maelstrom's profile and parity

Owns: `src/hazardfield.ts` (GLSL and CPU port together), `tests/unit/hazardfield.test.ts`,
`tests/smoke/wave-parity.spec.ts` and its fixtures, `src/dev/probe.ts` if the
probe bakes the profile.

- Replace `-D(1-r)^3` with a bowl that is flat at the apex, e.g.
  `-D * (1 - r*r)^2` or `-D * s*s*(3 - 2*s)` with `s = 1 - r`. Polynomial
  plus the one existing `sqrt`; mirror exactly in the CPU port.
- Re-derive the lip so its outer edge still reaches zero at `r = 1` and the
  lip peak keeps `RIM_HEIGHT`. Consider widening the lip by 1.5× (it is
  currently 2 to 3 vertices wide) if the hull tests allow it.
- Update the four maelstrom cases in `hazardfield.test.ts`: centre depth,
  radius scaling, lip and flatness, radial symmetry. Add a fifth: the slope
  at r = 0 is zero within 1e-6 on the CPU side.
- Run `wave-parity.spec.ts` and re-record only if the change is in the
  profile, never to paper over a GPU/CPU mismatch.
- Check `ship-physics.test.ts` and the hazard tests for any case that pins a
  depth at a given `r`; update the constants those expect and say so in the
  commit.

Cost: none at runtime. Regression: `hazardfield`, `ship-physics`,
`wave-parity`. Pros: small, exactly testable, and it removes the shading
singularity nothing in M can hide. Cons: changes gameplay feel in the
funnel (a bowl pulls differently from a cone near the centre); the parity
fixture re-record is the kind of change that hides mistakes, so the commit
must show the old and new profile values at five radii.

---

## Wave 2: integration and the owner's visual pass (one agent)

Owns: the merge, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, this file's
status line, constant tuning only.

1. Merge `-L`, `-C`, `-M`, `-P` onto `claude/terrain-wave-maelstrom-texture-kvbh49`
   in that order; a conflict means Wave 0's split was wrong, so fix the split
   and re-merge rather than resolving GLSL by hand.
2. `npm run build`, `npm test`, `npm run test:smoke`.
3. `npm run shots -- --label texture-after` on all three tiers with the dev
   spawn from W0-4; compare against `texture-before` by eye at deck, coast,
   hazard and orbit framings, day and night.
4. Tune constants only (no new terms): `steep` lerp targets, `FACET_BLEND`
   per tier, foam coverage, spiral tilt, thickness tint. Every constant that
   moves gets a one-line reason in its comment.
5. `ARCHITECTURE.md`: update the shader notes for the `slope` seam, the
   `steep`/`crestLift` locals, the crest/funnel split, and land's new
   quality row. Record the cost measured at 1080p on the integration
   machine.
6. Hand the owner the after screenshots. The owner decides Wave 3.

Pros: one pair of eyes on the whole picture; the only place cross-stream
tuning can happen. Cons: it is where the two `RENDER_PLAN.md` regressions
slipped through last time; the screenshot comparison is the gate, not the
green build.

---

## Wave 3: geometry, deferred until Wave 2 is signed off

Owner sign-off required for each row.

| Item | Owns | Why deferred |
|---|---|---|
| `patchSegments` 160 to 192 on high | `src/quality.ts`, `src/waterpatch.ts` | Costs every frame; try after the shader fixes to see if the rim still looks polygonal. |
| Land LOD or a quality row that lowers `LAND_DETAIL` on low | `src/land.ts`, `src/quality.ts`, `world-golden` fixture | Changes vertex count, so the golden must be re-recorded per tier. |
| Sharper crest silhouette (`CREST_FRONT_RATIO` and a curvature-based normal at the lip) | `src/hazardfield.ts`, `src/hazardcrest.ts` | Height change, parity re-record, and C's foam restructure has to land first so the two are not tuned against each other. |
| Reflection cube per hazard, or `steep` in `skyUp` | `src/waterreflect.ts`, `src/reflection.ts` | Only worth it if the wave face still reads flat after C; costs a second cube render. |

---

## Order and parallelism, in one table

| Wave | Agents | Files | Gate to next |
|---|---|---|---|
| 0 | 1 | `waterglsl.ts`, `water.ts`, `waterhazard.ts`, `hazardcrest.ts`, `hazardfunnel.ts`, fixtures, dev spawn | Pushed; `npm test` green; before-shots captured |
| 1 | 4 in parallel (L, C, M, P) | disjoint, see each stream | Each stream: build, test, shots, pushed on its branch |
| 2 | 1 | merge, docs, constants | Owner's visual pass |
| 3 | per row | see table | Owner sign-off per row |

Estimated: Wave 0 one agent-session, Wave 1 one session each in parallel,
Wave 2 one session. Wave 3 unbounded and optional.
