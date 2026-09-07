# Fishing mini-game — implementation plan

Status: **approved, not started.**

This document is the complete brief. An implementing agent should not need the
conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**Frame loop**, **Ship energy**, **HUD text sizing** and **TypeScript
constraints**, and `ART-DIRECTION.md` §1–2 for the palette. This plan follows
the conventions recorded there and adds to them.

## Decisions already made

Settled with the project owner. Do not re-litigate them; if one turns out to
be unworkable, say so and stop rather than substituting another.

| Question | Decision |
|---|---|
| Where it lives | A **HUD button** opens it. Playable anywhere on the globe, docked or not, day or night. |
| World while fishing | **Frozen.** The ship is halted (speed → 0) on open; ship, wind, day-night, clouds, water, wake, camera and radar all stop updating. Only the power plant keeps ticking, and the last rendered frame stays on screen behind a dimmed backdrop. |
| Power | A session **costs 50% of the tank**, deducted at the moment it starts. The button is disabled below 50%. Recharge (solar at the frozen sun's elevation, or shore power if docked) continues during the session. |
| Session | **30 seconds** and **10 harpoon shots**, whichever runs out first. A fish already hooked when the clock hits zero is still reeled in (struggle included). Then a summary card. |
| Rendering | One **2D `<canvas>`** in the HUD layer, drawn every frame by its own module, like `radar.ts`. No three.js. |
| Layout | A **centred 9:16 card** over the dimmed 3D view: boat above the waterline, five fish rows below, timer / shots / gold in the card's chrome. Sized from the viewport height so it fits phones and desktops. |
| Harpoon | Pivoted under the boat, **swings left-right** below the waterline. One click / tap / Space fires it straight along its current angle. It **hooks the first fish it touches** on the way down; a miss retracts empty. |
| Fish rows | **5 rows**, each with a fixed direction (alternating) and its own base speed. The deeper the row, the better the odds of a high tier. |
| Species | **20**, in **5 tiers** of 4. Names are **tech-word + real creature** ("Voltfin Sardine"). Placeholder **emoji** now; gen-AI art later through a single art table. |
| Break-away | Tiers 4 and 5 **fight**: a tension bar drains while reeling and each rapid tap / click / Space refills it. Tension at zero = the line snaps and the fish escapes. Tiers 1–3 never escape. |
| Fish Book | A separate HUD button opens a record of every species: **caught count**, silhouette + "UNKNOWN" until first caught. |
| Gold | Every catch pays gold. Shown on the main HUD at all times and in the fishing card. Spending is **out of scope**. |
| Persistence | **localStorage**, one versioned key. Gold and the Fish Book survive reloads. |

## Session flow

```
HUD [FISH] (enabled iff energy.level >= 0.50 and no overlay open)
  └─ open(): ship.halt(); energy.spend(0.50); paused = true; card fades in
       ├─ 30 s clock runs, shots = 10
       ├─ harpoon swings; fire → travels → hook | miss → retract
       │     hooked tier 1–3: reel to boat → CATCH
       │     hooked tier 4–5: reel to boat with tension bar; tension 0 → ESCAPE
       ├─ CATCH: gold += species.gold, fishBook[id] += 1, save, "+N" floats up
       └─ clock 0 or shots 0 (after any in-flight harpoon settles) → SUMMARY
            [FISH AGAIN  -50% PWR] (disabled below 50%)   [CLOSE]
  └─ close(): paused = false; card fades out; world resumes from rest
Esc during a session: ends it at once (shows the summary; power is not refunded).
```

## Species

Twenty, four per tier. `gold` is per catch. `size` is a multiplier on the base
fish length (0.06 card widths). `speed` is a multiplier on the row's base speed.
`emoji` is the placeholder sprite; `tint` is the glow drawn behind it so tiers
read at a glance even before real art exists.

| # | id | Name | Tier | emoji | size | speed | gold | tint |
|---|---|---|---|---|---|---|---|---|
| 1 | `voltfin-sardine` | Voltfin Sardine | 1 | 🐟 | 0.6 | 1.3 | 5 | `#3fe0ff` |
| 2 | `rustgill-herring` | Rustgill Herring | 1 | 🐟 | 0.7 | 1.1 | 6 | `#c8763a` |
| 3 | `tinscale-anchovy` | Tinscale Anchovy | 1 | 🐟 | 0.5 | 1.5 | 4 | `#b8c4cc` |
| 4 | `sparkplug-minnow` | Sparkplug Minnow | 1 | 🐠 | 0.5 | 1.4 | 5 | `#ffe14d` |
| 5 | `brass-gill-grouper` | Brass-Gill Grouper | 2 | 🐠 | 1.0 | 0.8 | 15 | `#dba43a` |
| 6 | `coilfin-mackerel` | Coilfin Mackerel | 2 | 🐟 | 0.8 | 1.2 | 12 | `#4bf0a6` |
| 7 | `neon-wrasse` | Neon Wrasse | 2 | 🐠 | 0.8 | 1.0 | 14 | `#ff4fd8` |
| 8 | `gearback-bream` | Gearback Bream | 2 | 🐡 | 0.9 | 0.9 | 13 | `#9fb3c8` |
| 9 | `reactor-eel` | Reactor Eel | 3 | 🐍 | 1.3 | 1.0 | 35 | `#7dff5a` |
| 10 | `chrome-manta` | Chrome Manta | 3 | 🛸 | 1.3 | 0.7 | 40 | `#e8f4ff` |
| 11 | `piston-pufferfish` | Piston Pufferfish | 3 | 🐡 | 1.0 | 0.6 | 30 | `#ffb445` |
| 12 | `cobalt-lionfish` | Cobalt Lionfish | 3 | 🐠 | 1.1 | 0.8 | 38 | `#4d7cff` |
| 13 | `dynamo-swordfish` | Dynamo Swordfish | 4 | 🐬 | 1.5 | 1.4 | 90 | `#3fe0ff` |
| 14 | `ironjaw-barracuda` | Ironjaw Barracuda | 4 | 🦈 | 1.4 | 1.3 | 85 | `#8a96a3` |
| 15 | `flux-octopus` | Flux Octopus | 4 | 🐙 | 1.3 | 0.6 | 100 | `#b05cff` |
| 16 | `arc-light-jellyfish` | Arc-Light Jellyfish | 4 | 🪼 | 1.2 | 0.4 | 80 | `#ff4fd8` |
| 17 | `warp-core-hammerhead` | Warp-Core Hammerhead | 5 | 🦈 | 2.0 | 0.9 | 250 | `#ff5470` |
| 18 | `leviathan-squid` | Leviathan Squid | 5 | 🦑 | 2.2 | 0.6 | 300 | `#b05cff` |
| 19 | `plasma-narwhal` | Plasma Narwhal | 5 | 🐋 | 2.0 | 0.7 | 280 | `#3fe0ff` |
| 20 | `clockwork-coelacanth` | Clockwork Coelacanth | 5 | 🐢 | 1.8 | 0.5 | 320 | `#dba43a` |

Tier names and colours, used by the Fish Book and the catch flash:

| Tier | Name | Colour |
|---|---|---|
| 1 | COMMON | `#9fb3c8` |
| 2 | UNCOMMON | `#4bf0a6` |
| 3 | RARE | `#3fe0ff` |
| 4 | EPIC | `#b05cff` |
| 5 | LEGENDARY | `#ffb445` |

### Row odds

Percent chance that a fish spawned on a row belongs to each tier. Row 1 is the
shallowest. Within a tier, species are picked uniformly.

| Row | T1 | T2 | T3 | T4 | T5 |
|---|---|---|---|---|---|
| 1 | 71.8 | 25.7 | 2.5 | 0 | 0 |
| 2 | 56.9 | 34.1 | 7.5 | 1.5 | 0 |
| 3 | 41.8 | 41.8 | 12.5 | 3.6 | 0.3 |
| 4 | 29.3 | 48.7 | 15 | 6 | 1 |
| 5 | 18.5 | 55.5 | 15 | 9 | 2 |

RARE is at half the first-pass share, EPIC at three tenths and LEGENDARY at a
tenth; what each row gave up went back to COMMON and UNCOMMON in the
proportion they already stood in, so every row still totals 100 and the shape
of the curve is unchanged — only its ceiling moved.

### Spare harpoons

A session gets **ten harpoons of its own**, and may reach up to ten more out of
the locker `harpoons.ts` keeps. The two budgets are counted separately all the
way through the sim: `shotsLeft` is spent first and to the last one, and only
then does a shot come out of `extraLeft`. That order is the rule the locker is
sold under, and keeping the counts apart is what `fishing.ts` debits the locker
against — a session that could not tell its own ten from its bought ones would
have to guess how many to charge for.

The locker holds a hundred and sells five at a time; a session may draw ten.
Two different ceilings on purpose: the first is how many can be kept, the
second is what keeps the mini-game from becoming a matter of how much gold was
brought to it.

Worth knowing before the per-session ceiling is raised: **the 30 s clock is now
the binding constraint, not the harpoons.** Firing the instant the rope is home
and never aiming, 19 shots fit in a session. A player who actually aims will
spend rather fewer, so the last few spares of a full grant are mostly
theoretical, and a session with spares granted ends on `time` rather than on
`shots`. Raising `SESSION_SECONDS` is the knob if the extras are meant to be
reliably spendable.

Spares are debited **as they are fired**, not reserved when the session starts:
a tab closed mid-session should cost the player the harpoons they threw and not
the ones they did not.

### Row motion

| Row | Direction | Base speed (card widths / s) | Fish alive (min–max) | Min gap |
|---|---|---|---|---|
| 1 | → | 0.22 | 6–12 | 0.06 |
| 2 | ← | 0.16 | 4–8 | 0.09 |
| 3 | → | 0.13 | 2–3 | 0.18 |
| 4 | ← | 0.10 | 2–3 | 0.18 |
| 5 | → | 0.08 | 1–3 | 0.18 |

A fish spawns just off the edge it enters from and despawns just past the
other edge. New fish spawn when a row is under its minimum, or on a 1.5–3.5 s
timer while under its maximum, and never closer to the nearest fish on that
row than the row's own minimum gap.

Rows 1 and 2 carry three times and twice their first-pass populations. The
gap is per-row rather than a single 0.18 because it is also a hard cap: the
card is one unit wide, so at 0.18 no row could ever hold more than six fish
however high its maximum was set. Rows 1 and 2 divide the gap by the same 3x
and 2x, so the water gets denser in exactly the proportion intended instead of
jamming against a constant.

### The struggle (tiers 4 and 5)

| | Tier 4 | Tier 5 |
|---|---|---|
| Reel time boat-ward | 2.2 s | 2.8 s |
| Tension at hook | 0.60 | 0.50 |
| Drain per second | 0.45 | 0.60 |
| Gain per tap | 0.12 | 0.12 |
| Taps/s to hold steady | ~3.8 | ~5.0 |

Tension is clamped to [0, 1]. The fish escapes the instant it reaches 0. The
harpoon then retracts empty and the shot is spent. Tiers 1–3 reel in
`1.0 + 0.3 × tier` seconds with no bar.

Two readings of the tables above were settled during implementation, and the
resolutions are the truth:

- **The table wins over the formula for tiers 4 and 5.** `1.0 + 0.3 × tier`
  is scoped to tiers 1–3. It happens to agree with tier 4's tabulated 2.2 s
  and disagrees with tier 5's 2.8 s; the table is the more specific statement
  and is what `REEL_SECONDS` implements. Change that constant, not the
  formula, if tier 5 should come up faster.
- **The band and the bob are different things.** A fish takes a fixed depth
  drawn uniformly within ±0.07 of its row centre, then bobs ±0.02 about that
  depth. The two sum to exactly the 0.09 half-height, so a row fills its band
  and no fish ever strays into its neighbour. Read as a 0.09 bob instead, the
  0.09 would be doing no work.

The struggle's "taps per second to hold steady" column is not an independent
number: it is `drain / gain` for the tier. Retune either input and the column
follows; do not pin it separately.

## Geometry

The simulation runs in **card units**: x in [0, 1] across, y in [0, 16/9 ≈ 1.778]
down from the top. The renderer scales that to the canvas; nothing in the sim
knows about pixels.

| Thing | Value |
|---|---|
| Waterline | y = 0.28 |
| Boat | centred x = 0.5, hull bottom at the waterline; harpoon pivot at (0.5, 0.30) |
| Row centre lines | y = 0.55, 0.78, 1.01, 1.24, 1.47 |
| Row band half-height | 0.09 (fish bob ±0.02 inside it) |
| Harpoon swing | ±60° from straight down, `angle = 60° × sin(2π t / 2.4 s)` |
| Harpoon speed | 1.6 card units / s going out, 2.4 retracting |
| Max reach | until the tip leaves the card (y > 1.78 or x outside [0, 1]) |
| Hit test | tip point inside the fish's ellipse: half-width `0.06 × size × 0.5`, half-height `0.06 × size × 0.25` |
| Base fish length | 0.06 card widths, times `size` |

## Interfaces

These are the contracts the parallel agents code against. They are written
here so the agents can start together; the orchestrator lands them in
`src/types.ts` before anyone else begins.

```ts
/* ---- species -------------------------------------------------------- */
export type Tier = 1 | 2 | 3 | 4 | 5;

export interface Species {
  readonly id: string;            // kebab-case, stable, used as the save key
  readonly name: string;
  readonly tier: Tier;
  readonly size: number;          // multiplier on the base fish length
  readonly speed: number;         // multiplier on the row's base speed
  readonly gold: number;
  readonly art: SpeciesArt;
}

/** Placeholder today, PNG tomorrow: the renderer looks here and nowhere else. */
export interface SpeciesArt {
  readonly emoji: string;
  readonly tint: string;          // CSS colour for the glow behind the sprite
  readonly image?: string;        // future: path under /public, drawn instead of the emoji
}

/* ---- simulation ----------------------------------------------------- */
export type HarpoonPhase = 'swinging' | 'flying' | 'reeling' | 'retracting';

export interface FishState {
  readonly species: Species;
  readonly row: number;           // 0..4
  readonly x: number;
  readonly y: number;
  readonly dir: 1 | -1;           // +1 travelling right
  readonly hooked: boolean;
}

export interface HarpoonState {
  readonly phase: HarpoonPhase;
  readonly angle: number;         // radians from straight down, +ve toward +x
  readonly tipX: number;
  readonly tipY: number;
  readonly hooked: FishState | null;
  readonly struggling: boolean;
  readonly tension: number;       // [0,1], meaningful only while struggling
}

export type FishingEvent =
  | { kind: 'fired'; shotsLeft: number }
  | { kind: 'hooked'; fish: FishState }
  | { kind: 'caught'; species: Species; gold: number; x: number; y: number }
  | { kind: 'escaped'; species: Species }
  | { kind: 'missed' }
  | { kind: 'ended'; reason: 'time' | 'shots' | 'abort' };

export interface FishingState {
  readonly timeLeft: number;      // seconds, 30 → 0
  readonly shotsLeft: number;     // 10 → 0
  readonly fish: readonly FishState[];
  readonly harpoon: HarpoonState;
  readonly caught: readonly Species[];   // this session, in order
  readonly goldEarned: number;           // this session
  readonly over: boolean;
  /** Events raised since the last update(); the sim clears this at the top of each update. */
  readonly events: readonly FishingEvent[];
}

export interface FishingInput {
  /** True on the frame the player pressed (click / tap / Space). Fires, or taps the struggle. */
  readonly press: boolean;
}

/* ---- persistence ---------------------------------------------------- */
export interface SaveData {
  readonly version: 1;
  readonly gold: number;
  /** species id → times caught. Absent = never. */
  readonly fishBook: Readonly<Record<string, number>>;
}
```

### Module ownership (new rows for `docs/ARCHITECTURE.md`)

| File | Exports | Notes |
|---|---|---|
| `species.ts` | `SPECIES`, `TIERS`, `speciesById(id)`, `rollSpecies(row, rng)` | data only; the row-odds table lives here |
| `fishsim.ts` | `createFishingSim(rng?)` → `{ state: FishingState; update(dt, input): void; abort(): void }` | pure logic in card units; no DOM, no canvas |
| `fishrender.ts` | `createFishRenderer(canvas)` → `{ draw(state, now): void; resize(): void }` | 2D canvas; the only reader of `SpeciesArt` |
| `fishing.ts` | `createFishing(deps)` → `{ open(): void; close(): void; readonly isOpen: boolean; update(dt): void; dispose(): void }` | the overlay controller: card DOM, input capture, gold + book bookkeeping |
| `fishbook.ts` | `createFishBook(save, wallet)` → `{ open(); close(); readonly isOpen }` | the record panel |
| `save.ts` | `loadSave()`, `writeSave(data)`, `SAVE_KEY` | localStorage, versioned, tolerant of garbage |
| `wallet.ts` | `createWallet(initialGold)` → `{ readonly gold; add(n): void; onChange(cb): () => void }` | the only writer of gold |

### Changes to existing modules

| File | Change |
|---|---|
| `types.ts` | the interfaces above |
| `energy.ts` | `spend(level: number): boolean` on `Energy` — subtracts if `state.level >= level`, returns whether it did. Mode is recomputed on the next `update`. |
| `ship.ts` | `halt(): void` on `Ship` — zeroes speed and any turn rate, so the world resumes from rest. |
| `hud.ts` | `createHud(wallet)`; a `GOLD` readout in the telemetry panel through the same write-through cache. |
| `main.ts` | a `paused` flag; see **Frame loop** below. |
| `index.html` | `[FISH]` and `[FISH BOOK]` buttons; the fishing card; the fish book panel. |
| `style.css` | three new sections: HUD buttons + gold readout, fishing card, fish book. |
| `docs/ARCHITECTURE.md` | new **Fishing** section, the ownership rows, the frame-loop change. |
| `README.md` | one paragraph under **The world**, and the new keys in **Controls**. |

### Frame loop while paused

```
energy.update(dt, restingShip, env)   // restingShip = { ...ship.state, speed: 0 }: hotel load and recharge only
fishing.update(dt)                    // sim + draw, if open
hud.update(ship.state, energy.state, wind.state)
postFx.render(0, scene, view.camera)  // keeps the frozen frame valid through a resize
controls.endFrame()                   // zoomDelta must not accumulate under the card
```

Everything else in the loop is skipped. `paused` is true while either the
fishing card or the fish book is open. The ship is halted on open, so the
resting snapshot and the real state agree on speed; the snapshot exists so a
frame that halts mid-way cannot bill the last speed at the moment of purchase.

### Input while paused

`controls.ts` keeps its listeners; nothing reads `input` while paused, and key
releases are still tracked, so a key held across the overlay does not stick.
`fishing.ts` adds its own `keydown` listener on `window` for **Space** (fire /
tap) and **Escape** (abort), and a `pointerdown` on the canvas for fire / tap.
It must `preventDefault()` Space so the page does not scroll, and must ignore
key repeat (`event.repeat`) so a held Space is one tap, not sixty.

### HUD buttons

Two buttons in a new `nav.dock` under the telemetry panel, styled as the
D-pad keys are: `[FISH]` and `[FISH BOOK]`. `[FISH]` carries a
`disabled` attribute and a `title` of `Needs 50% power` while
`energy.level < 0.5`; `hud.ts` toggles it through the same cache pattern as
everything else. Both buttons opt back into `pointer-events`.

### Gold readout

A new `readout` row `GOLD` in the telemetry panel between WIND and POWER,
value in `--gold: #ffc44d`, tabular numerals, no thousands separator under
10 000 and a thin space above. The card header shows the same figure and the
session's earned figure beside it.

### The fishing card

```
+--------------------------------+
| 0:27        7 shots      1 565 |  chrome: mono, cyan on panel-bg
|          ~~~~ boat ~~~~        |
| ---------- waterline --------- |
|   fish->      fish->    fish-> |  row 1
|      <-fish        <-fish      |  row 2
|  fish->          fish->        |  row 3   ...canvas
|     <-fish                     |  row 4
|          fish->                |  row 5
|  [ tension ########..... ]     |  only while struggling
+--------------------------------+
```

- Card: `aspect-ratio: 9 / 16; height: min(92vh, 900px); width: auto`, centred,
  `--panel-bg` with `--panel-border` and `--panel-glow`, over a
  `rgba(2,4,10,0.72)` backdrop that covers the viewport.
- The canvas is `width: 100%; height: 100%` inside the card body; the renderer
  sizes the drawing buffer to `clientWidth × devicePixelRatio` (cap 2) on
  open and on resize, and draws in card units through one `setTransform`.
- Water: a vertical gradient from `#0b3a5e` at the waterline to `#03101f` at the
  bottom, with a faint sine ripple along the waterline. Sky above: `--bg`
  with a soft cyan horizon glow. The boat is an emoji ⛵ at 3× the base
  fish length until art exists; the same art-table mechanism replaces it.
- Rope: 1.5 px line from pivot to tip, `--ink-mute`; the tip is a 6 px cyan
  chevron rotated to the travel angle. While swinging, a dotted aim line
  from the pivot to the card edge shows where a shot would go.
- Fish: the emoji, mirrored horizontally when `dir = -1`, over a radial glow
  in `art.tint` at 35% alpha. Hooked fish are drawn at the tip, tilted toward
  the pivot.
- Tension bar: a 10-segment bar in the bottom 6% of the card, same segment
  style as `.pwr__bar`, magenta below 30%.
- Catch: "+N" in `--gold` floats up 0.15 card units over 0.9 s and fades;
  escape: "SNAPPED" in magenta the same way. These live in the renderer's
  own short-lived list, fed by `FishingEvent`s.
- Summary: a centred panel inside the card: list of catches (emoji, name,
  gold) grouped, total gold, `[FISH AGAIN -50% PWR]` and `[CLOSE]`.

### The Fish Book

A modal panel like the card but wider (`min(92vw, 640px)`), scrollable body.
Species grouped by tier, tier heading in the tier colour, each entry a row:
sprite (emoji, or a dark silhouette of it via `filter: brightness(0)` while
uncaught), name (or `UNKNOWN`), gold per catch, and `× count` (or `—`).
A footer line: `12 / 20 SPECIES · 1 565 GOLD`. Close button and Escape.

### Persistence

`SAVE_KEY = 'pirate-world.save'`. `loadSave()` returns a valid `SaveData` no
matter what is in storage: missing → defaults; wrong version or unparsable →
defaults (log once with `console.warn`); unknown species ids in `fishBook` are
kept, not dropped, so a renamed species does not erase history. `writeSave` is
called after every catch, not on a timer.

## Work split

Four agents in parallel, in the same working tree, after one preparatory step
by the orchestrator. Files are partitioned so no two agents write the same
file; where two must touch `index.html` or `style.css`, the orchestrator has
already inserted a marked block for each and agents edit **only inside their
block, with Edit, never Write**.

**Step 0 landed as follows** (done; the agents start from here). The interfaces
above are in `types.ts`; `energy.spend(level)` and `ship.halt()` exist; the
marked blocks and the `--gold` / `--tier-N` tokens are in. Two departures from
the split below, both to unblock parallel work:

- **`species.ts` is already complete** — the catalogue, `TIERS`, `ROW_ODDS`,
  `speciesById`, `rollSpecies`. It was pure transcription of the approved
  tables, and both the sim and the Fish Book need it on their first line.
  Agent A still *verifies* the odds; it does not have to author them.
- **Every module below exists as a typed stub**, so `npm run build` is green
  before any agent writes a line and stays green for all of them. Each agent
  replaces its own stubs and must not edit another's. The stub signatures are
  the contract:

```ts
createFishingSim(rng?): { state: FishingState; update(dt, input); abort() }   // A
createFishRenderer(canvas): { draw(state, dt); resize() }                     // B
createFishing({ energy, wallet, book, onOpen, onClose }):
  { isOpen; open(): boolean; close(); update(dt); dispose() }                 // B
createWallet(initialGold): { gold; add(n); onChange(cb): () => void }         // C
createRecords(): { wallet, book }   // loads the save and wires autosave      // C
createFishBook(store, wallet): { isOpen; open(); close(); dispose() }         // C
```

`createFishing.open()` returns **false** if the tank is under 50%, and must
leave the tank untouched on a refusal. `createRecords()` is the single entry
point for persistence: it exists so no caller can half-wire a save.

**Step 0 — orchestrator, before the agents start.**
Land the interfaces in `types.ts`; add `spend` to `energy.ts` and `halt` to
`ship.ts`; insert the marked blocks (`<!-- FISHING CARD -->`,
`<!-- FISH BOOK -->`, `<!-- HUD DOCK -->` in `index.html`; `/* FISHING */`,
`/* FISH BOOK */`, `/* HUD DOCK */` in `style.css`); add `--gold` to `:root`.
Build must be green before step 1.

| Agent | Owns | Deliverable |
|---|---|---|
| **A — sim** | `species.ts`, `fishsim.ts` | The whole ruleset, in card units, with no DOM. Verified by a node probe (see memory note `verify-by-running`): 10 000 spawns per row match the odds table within 2%; a scripted session fires at known fish and produces the expected events; the struggle drains and escapes at the tabulated rates. |
| **B — render + card** | `fishrender.ts`, `fishing.ts`, the `FISHING CARD` blocks | The overlay as specified, driven by `FishingState`. Until A lands, B develops against a hand-built `FishingState` fixture with a few static fish. |
| **C — records** | `save.ts`, `wallet.ts`, `fishbook.ts`, the `FISH BOOK` blocks | Persistence and the book. Verified by a node probe for `loadSave` on garbage, wrong version, and round-trip. |
| **D — HUD + loop** | `hud.ts` gold readout and button gating, the `HUD DOCK` blocks, `main.ts` pause loop, `docs/ARCHITECTURE.md`, `README.md` | The plumbing. Wires `createFishing` and `createFishBook` once B and C export them; until then, against the interfaces in this plan. |

**Step 5 — orchestrator, integration.**
`npm run build`, then launch (`npx vite --port 5178` + headless Chrome per
the memory note) and check: the HUD renders with the two buttons and the
gold row; the card opens, the harpoon swings, a shot hooks a fish, gold
increments on the HUD, the fish book shows the catch, a reload keeps both.
Check the Vite log for browser `console.error`. A green build is not a pass.

## Out of scope

- Spending gold, shops, upgrades.
- Real art. The art table (`SpeciesArt`) is the seam; nothing else changes.
- Sound.
- Balancing beyond the tables above. The numbers are a first pass and are
  expected to move; keep every one of them as a named constant with the
  endurance-style comment `energy.ts` uses, so the next pass is a retune and
  not an archaeology.
- Fishing while the ship is moving. The halt is deliberate.
