# Pirate World — Art Direction

House style and pipeline for every art asset in this project. It covers both
stages we actually use:

1. **Concept art** — a 2D image generated from a prompt, used as the reference
   a model is built against. Not shipped.
2. **The shipped asset** — a procedural Blender build, exported to glTF, loaded
   by the game. This is what the player sees.

Stage 2 is the deliverable. Stage 1 exists to give it a target, so a concept
image is judged on whether it can be modelled, not on whether it is pretty.

Sibling project note: `E:\My Apps\Game - Sunrise Smoothie` has its own
`ART-DIRECTION.md`. The **prompt mechanics** in §3 are inherited from it and
work here unchanged. Its **content** rules — kawaii faces, tropical sunrise
palette — are Sunrise's, not ours, and must not be carried over.

---

## 1. Core style at a glance

| Element | Spec |
|---|---|
| **World** | Fantasy techno-funk pirates: age-of-sail hulls retrofitted with glowing tech |
| **Read** | Warm weathered wood + brass, against cold neon. The contrast *is* the genre |
| **Era cue** | Retrofitted, never purpose-built sci-fi. Tech is bolted onto timber |
| **Tier cue** | This is a *beginner's* ship: small, scrappy, patched. Not a warship |
| **Lighting** | One key from upper-left, cool fill. Night-side is the signature look |
| **Silhouette** | Must read small and far: the ship is ~1/64 of the planet radius |
| **Rendering** | Low-poly forms, beveled edges, procedural texture. Not photoreal, not flat-shaded blocks |

### The one-line test
If a new asset does not have both *weathered timber* and *cold glow* on it, it
is not in this world yet.

---

## 2. Palette

Three families. Keep them separate — that separation is doing real work.

### 2.1 Hull materials (3D, from `tools/build_ship.py`)
Linear-space base colours, tinted from one shared wood pass and one metal pass:

| Material | Tint | Use |
|---|---|---|
| `hull_planks` | `(0.34, 0.20, 0.115)` | Topsides, the ship's dominant mass |
| `hull_seam` | `(0.19, 0.105, 0.060)` | Plank battens, recessed seams |
| `deck_planks` | `(0.62, 0.395, 0.205)` | Deck — lightest wood, so the deck reads |
| `wood_trim` | `(0.48, 0.290, 0.150)` | Mast, spars, barrels, fittings |
| `brass` | `(0.86, 0.560, 0.165)` | Rails, bands, rings. The second read after wood |
| `brass_dark` | `(0.45, 0.265, 0.085)` | Straps, ribs, recessed metal |
| `iron` | `(0.135, 0.130, 0.150)` | Anchor, nozzle throats |

### 2.2 In-world neon (3D)
Authored linear in the build script; the sRGB column is the same colour as
Three reads a hex, for the `ship.ts` stand-in to match against.

| Name | Emissive (linear) | sRGB | Use |
|---|---|---|---|
| `neon_cyan` | `(0.10, 0.72, 1.0)` | `#59ddff` | Circuit runes, data glow |
| `neon_violet` | `(0.62, 0.20, 1.0)` | `#ce7cff` | Engine cores, portholes, power |
| `neon_lime` | `(0.48, 1.0, 0.16)` | `#b8ff6f` | Cabin lights, weapon tips |
| `thruster_flame` | `(0.80, 0.60, 1.0)` | `#e7cbff` | Exhaust only |

Two more, and they are not on the player's ship. The AI boats are the same
hull recoloured, and the colour is the entire warning: red hunts you, orange
is running a straight line past you, and that has to be readable at sixty
units before the silhouette is. `aihulls.ts` writes them into every material
`shipfx.ts`'s `isNeon` matches, and `rimglow.ts` lights the whole hull in the
same value, so a raider reads as one solid coloured shape rather than as a
grey boat with lit windows.

| Name | Emissive (linear) | sRGB | Use |
|---|---|---|---|
| `RED_NEON` | `(1.0, 0.09, 0.05)` | `#ff553f` | The hunting raider, hull and rim |
| `ORANGE_NEON` | `(1.0, 0.34, 0.05)` | `#ff9e3f` | The wandering raider, hull and rim |

`aihulls.ts` is the authority on both, and the linear column is copied from its
constants rather than picked again here: two pairs claiming to be the same
colour is exactly the drift this table exists to stop. The rim carries the same
value at `RIM_STRENGTH` (1.6), which is the authored neon's own order of
magnitude, so the bloom treats a raider's silhouette as neon rather than as a
lit edge.

These are IN-WORLD values and are not the UI's `--red` / `--orange` in §2.3.
The two pairs are near neighbours by design and are not interchangeable: one
is a linear emissive on a lit surface that blooms and is occluded, the other
is a flat hue on a 2D canvas. Same rule, and the same reason, as the two
cyans in §2.4.

Emissive **strength** stays in the 2.2-3.5 band. Above roughly 5 every hue
clips to the same white blob and the palette above stops existing.

### 2.3 UI chrome (2D, from `src/style.css`)
`--cyan #3fe0ff` primary · `--magenta #ff4fd8` accent · `--ink #cfeffb` ·
`--bg #05080f` / `--bg-deep #02040a` · power states `#4bf0a6` / `#ffb445` / `#ff5470`.

The two raiders: `--red #ff4a3c` the hunter, `--orange #ff9a3c` the one just
passing through. They paint the scope's arrowheads and the battle strip's FOE
side, and they are UI-only on §2.4's terms; the hulls' own neon is the linear
pair in §2.2. `radar.ts` carries the same two values written out as `rgb()`
literals, because a 2D canvas context has no cascade to read and a
`getComputedStyle` per mark per frame would be the most expensive thing on the
instrument. Keep the two copies in step.

### 2.4 The magenta rule
**Magenta is UI-only. It never appears on an in-world object.**

Two independent reasons, and they happen to agree:

- Generated concept art keys out a flat `#FF00FF` background (§3). Magenta glow
  on the subject bleeds into that key and tears holes in the cutout.
- It keeps the HUD legible over the ship. If the hull glowed the same magenta
  as the telemetry accents, the readout would sit *in* the scene instead of on
  top of it.

Cyan is the exception, and it is shared on purpose: `--cyan #3fe0ff` and the
in-world `#59ddff` are near neighbours, which is what makes the HUD look wired
into the ship rather than pasted over it. What separates them is depth, not
hue -- in-world cyan is a lit surface that moves, blooms and is occluded, the
HUD's is flat and pinned. Keep it that way: do not put a cyan-glowing part
directly under the telemetry panels, where neither cue is available.

---

## 3. Stage 1 — concept art prompts

### Rules
1. **Under 990 characters.** Count it (`awk '{print length}'`). Trim cosmetic
   words ("humming", "weathered", "chrome") before style-critical ones (white
   outline, magenta fill, flat illustration).
2. **Open with the asset type and subject**, then the tech clause, then the
   view clause, then the boilerplate, then the exact background sentence.
3. **State the view three ways.** Image models default hard to a broadside
   profile; one mention of "rear view" loses to the training prior. See §3.2.
4. **State the tier as a negative.** "A humble first vessel, not a warship" —
   models inflate any pirate ship into a galleon otherwise.
5. **No text.** The engine renders every label. Baked-in words come back
   misspelled.
6. **No crew.** If people appear anyway, say "NO crew, NO people" twice.

### 3.1 Reusable boilerplate
> Bold, rounded, chunky hand-drawn shapes, thick clean white outline, soft drop
> shadow, legible at small sizes. Palette: warm wood browns, brass gold, deep
> indigo shadows, electric cyan and violet neon, acid-lime highlights. Glossy
> finish, top-left light. Centered, vector sticker style, flat illustration, no
> photorealism. Background: a single FLAT, SOLID, UNIFORM bright magenta
> (#FF00FF) fill — no gradient, texture, or lighting — sharp edge between
> artwork and background.

The flat magenta key and white outline exist to make background removal clean.
**Never** change the background colour or drop the white outline.

### 3.2 The view clause — ships
The game's chase camera sits **behind and above** the ship, so the stern is the
face the player actually looks at. Concept art for a vessel must show that:

> Rear three-quarter view from behind and above: the stern faces the viewer,
> the bow points away into the distance, sail seen from the back.

A side elevation is a *supporting* view for a ship, never the primary one. It
puts all the design effort on a surface the player rarely sees.

### 3.3 Worked example — the beginner ship
The prompt that produced `assets/pirateship_beginner.png` (973 chars):

```
Mobile game sprite: a beginner's starter pirate ship — a small scrappy single-mast wooden sloop with fantasy techno-funk gear. Patched sail stitched with glowing circuit runes, brass trim, an energy core in the hull, vents trailing violet light, a holographic skull-and-crossbones flag. A humble first vessel, not a warship. Rear three-quarter view from behind and above: the stern faces the viewer, the bow points away into the distance, sail seen from the back. No crew, no people, no text. Bold, rounded, chunky hand-drawn shapes, thick clean white outline, soft drop shadow, legible at small sizes. Palette: warm wood browns, brass gold, deep indigo shadows, electric cyan and violet neon, acid-lime highlights. Glossy finish, top-left light. Centered, vector sticker style, flat illustration, no photorealism. Background: a single FLAT, SOLID, UNIFORM bright magenta (#FF00FF) fill — no gradient, texture, or lighting — sharp edge between artwork and background.
```

### 3.4 Progression families
For an upgrade line, keep the base prompt **byte-identical** and change only the
tech clause per tier (one glowing rune → full circuit sail → engine pods).
Rewriting the whole prompt per tier produces unrelated ships rather than one
hull upgraded.

---

## 4. Stage 2 — the Blender build

Source: [tools/build_ship.py](tools/build_ship.py) +
[tools/ship_textures.py](tools/ship_textures.py).

```
blender --background --python tools/build_ship.py
```

**The script is the asset.** The `.glb` is generated output — edit shapes in the
script and rebuild, never hand-edit the binary. Current build: 212 authored
parts → 27 merged objects, 86,684 triangles, 18 embedded textures, 4.86 MB.

### 4.1 Axis convention — the trap that bit us
Blender is Z-up; the glTF exporter maps Blender `(x, y, z)` onto glTF
`(x, z, -y)`. So Blender `+Z` becomes glTF `+Y` (up, as wanted) but Blender
`-Y` becomes glTF **`+Z`** — the opposite end from the bow.

The fix, and the rule for every future model: **author bow-toward `-Y` in
Blender, parent everything to one empty, and yaw only that empty 180° about Z
before export.** That is a rotation, not a mirror, so handedness survives.

The consequence, which surprises everyone who meets it second:

| Frame | Bow | Starboard |
|---|---|---|
| Outside the glTF root (`ship.ts`) | `-Z` | `+X` |
| Inside the root (`shipfx.ts`, authored coords) | `+Z` | `-X` |

The yaw lands on the root node, so the parts keep their authored coordinates.
A part built on `-X` in the script is the one the game calls starboard.

### 4.2 Scale and waterline contract
- `y = 0` in model space is the **deck reference plane**.
- Keel bottoms around `-0.49`; appendages reach `-0.69`; gunwale runs `+0.44`
  amidships to `+0.90` at the ends.
- `ship.ts` owns `MODEL_SCALE = 0.65` and `MODEL_WATERLINE_Y = -0.2`, and mounts
  the model at `-HULL_OFFSET - MODEL_WATERLINE_Y * MODEL_SCALE`.
- Anything measured off the hull outside `ship.ts` (`wake.ts`'s `STERN_BACK`,
  `BOW_FORWARD`, `HALF_WIDTH_0`) is authored against `MODEL_SCALE` too. A new
  hull with different proportions means revisiting those.

### 4.3 What actually makes a model stop looking crude
In order of impact. The first two matter far more than triangle count:

1. **Bevel + smooth-by-angle on everything.** Hard 90° edges catch no
   highlight, which is what reads as "primitives glued together". `finish()`
   applies `shade_smooth_by_angle(41°)` plus a 3-segment bevel to every part.
2. **Analytic UVs on lofted parts.** `loft()` emits U along the length and V
   around the section, so plank texture runs fore-and-aft. An automatic unwrap
   rotates islands arbitrarily and the grain runs in random directions.
3. **Trim that rides the surface.** Planks, strakes and ribs are placed with
   `hull_point()` / `hull_frame()` so they curve *with* the hull. Trim placed at
   a guessed coordinate floats off it — see §6.
4. **Enough sections that curves read as curves.** Cylinders at 28 sides, hull
   at 46×17. Below ~16 sides a barrel reads as a prism.
5. **Detail geometry with a job**: rigging, ratlines, rivet rings, plank seams,
   grating bars. Silhouette detail beats surface detail at game distance.

### 4.4 Textures
All maps are generated procedurally with numpy in `ship_textures.py` and packed
into the GLB. No Cycles bake pass, so a full rebuild — geometry, textures and
three preview renders — takes about 12 seconds.

- **Share aggressively.** One wood normal/roughness pair serves hull, deck and
  trim; one metal pair serves brass, dark brass and iron. Only the base colour
  tint differs. Sharing an image datablock exports as a single glTF image.
- **Normals at half the albedo's resolution.** They are low-frequency; full-res
  normal maps were the single largest chunk of the GLB (6.94 MB → 4.86 MB).
- **Tiling belongs in the material,** via a Mapping node → `KHR_texture_transform`,
  not baked into UVs. `shipfx.ts` raises anisotropy on every map because tiled
  planks at the chase camera's grazing angle turn to mush otherwise.
- **Fine repeated detail belongs in texture, not geometry.** The sail's circuit
  runes and the flag's skull were 21 floating objects; as pixels they carry far
  more detail and cost nothing.

### 4.5 Draw calls and the naming contract
The build applies every bevel, then **joins static parts by material** — one
draw call per material. Order matters: `join` keeps only the active object's
modifier stack, so joining before applying would silently discard the bevels.

`KEEP_SEPARATE` in the build script exempts parts the game animates. This is a
**two-sided contract with `src/shipfx.ts`** — breaking either half leaves the
neon dead with no error:

| Contract | Held by |
|---|---|
| `thruster_flame*` node name prefix | `shipfx.ts` matches `startsWith` |
| `mainsail`, `flag` exact node names | `shipfx.ts` matches `===` |
| Lamps: **flat emissive, no emissive map** | `shipfx.ts` `isNeon()` finds them by material |
| Sail/flag: glow **in an emissive texture** | That is exactly how they are told apart from lamps |

So: a new lamp needs no code change — give it a flat emissive material and the
game finds it. A new *animated* part needs a name and a matching branch.

### 4.6 Quality knobs
The `QUALITY` dict at the top of the build script scales the whole model —
sections, cylinder sides, bevel segments, texture sizes. Halving it gives a
cheap LOD from the same script with no shape changes. Use that rather than
hand-authoring a second model.

---

## 5. Output and naming

- Concept art: `assets/<subject>.png`, magenta background left in place (it is
  the record of what was generated).
- Model: `assets/<subject>.glb`, imported with Vite's `?url` suffix.
- Preview renders: `assets/<subject>_preview.png` (the game's 3/4 stern view),
  `_side.png`, `_detail.png`. Regenerated by the build script every run, and
  **gitignored** for exactly that reason — they are build output, like `dist/`.
- Illustrations: `assets/Illustrations/<name>.webp` is what the game loads, cut
  down from the authored PNG in `assets/Illustrations/masters/`. The masters are
  **gitignored**: they are 2.5 MB each against the ~130 KB shipped, and nothing
  in the bundle reads them. Keep them on disk — they are what a different crop
  or a larger size gets re-cut from.
- Build scripts: `tools/build_<subject>.py`, shared helpers in
  `tools/<subject>_textures.py`.

---

## 6. Traps we have already hit

Each of these shipped a visibly wrong model at least once.

- **Exported sailing backwards.** The glTF axis map is not the obvious one.
  §4.1. *Always verify by decoding the exported file, not by eyeballing a
  render* — a symmetric-looking hull hides it.
- **Validators that lie about bounds.** Reading accessor `min`/`max` and
  transforming the AABB corners over-reports badly once parts are merged and
  rotated (it claimed a 6.6-wide beam against a true 2.47). Decode actual
  `POSITION` data.
- **Trim floating in mid-air.** The anchor was placed at a literal `x = 0.92`
  where the topside is only ~0.6 wide. Place anything touching the hull with
  `hull_point()`.
- **Parts poking through the skin.** Balusters set at the sheer half-width
  emerged through the topsides as dark dashes. Inset them.
- **Single-sided hull.** The chase camera looks *down into* the ship past the
  rail; a culled backface shows sky through the deck. The hull material is
  double-sided for exactly this reason.
- **Fittings overlapping.** The porthole ring and engine pods were both placed
  on the transom without checking radii against separation.
- **Emissives clipping to white.** Strength 6–12 renders every neon colour as
  the same white blob. The values in §2.2 sit at 2.2–3.5 and stay coloured.
- **Washed-out cloth.** The sail first came out pale lavender; the reference
  canvas is dark indigo and the *glow* provides the brightness, not the base.

---

## 7. Open inconsistencies

Where a known deviation from this document gets recorded, so it is fixed
deliberately rather than rediscovered. **None open.**

Two were closed when this file was written, and both are worth not repeating:
the stand-in hull in `ship.ts` glowed magenta while the shipped model has none,
so the load-in flickered between palettes; and `shipfx.ts` quoted object counts
that had drifted two rebuilds out of date. Counts belong in build output, not
in prose.

---

_Update this file whenever the style or the pipeline moves. It is the source of
truth for both._
