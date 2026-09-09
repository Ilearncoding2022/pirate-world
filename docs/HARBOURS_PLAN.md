# Harbours, a new sea every load, and the hull: implementation plan

Status: **proposed, not built.** Nothing in this document exists in `src/`.

This document is the complete brief. An implementing agent should not need the
conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**Units, pinned**, **World scale**, **Ship dynamics**, **The world
environment**, **The shared height map** and **Frame loop**; then
`docs/WEATHER_PLAN.md` for the shape of a four-stream split in this
repository and for how `save.ts` grows a field without a version bump.

Three things are planned here, and they meet at the save file:

- **Harbours.** Every settlement on the globe becomes one entity: a town, its
  lights, and a berth at its own shoreline, under one name. There are exactly
  36 of them, the lone outpost lights are gone, and two of the 36 sit at the
  poles under fixed names.
- **A new sea every load.** The world seed is drawn at random on every page
  load, a bad draw is rejected and redrawn, and the chart of explored water
  is wiped with the world. The 36 names persist. A harbour the player has
  moored at is remembered by name and shown, at its new position, in every
  later world.
- **The hull.** A second reserve beside the power reserve: durability, which
  wears with time and weather, is knocked down by fights and maelstroms, caps
  the ship's speed and its fishing, and is repaired free at any berth or for
  gold in any shop.

## Decisions already made

These were settled with the owner on 2026-09-09 and are not open:

1. The outpost lights (`citylights.ts`'s lone scatter) are removed. Every
   light cluster is a town, and every town has a berth. There is no berth
   without a town and no town without a berth.
2. **Exactly 36** harbours. The centre-to-centre spacing is relaxed to make
   room; the world may read as more evenly settled.
3. The berth sits at the town's own shoreline, not up to 21 units out in a
   cove.
4. Names: 34 authored here (one third gritty, two thirds sleek) plus two the
   owner named. **Marine Stronghold** is always at the North Pole and **No
   Man's Land** is always at the South Pole, in every world.
5. Names appear on the scope, in the HUD while moored, in the shop header,
   and as floating text over the harbour in the world.
6. Every harbour sells every consumable. Which of the four upgrade lines
   (Trim, Moonglass, Arc-Lamp, Governor) a harbour carries is random.
7. A new random world on every page load. No seed entry for players; `?seed=`
   stays for tests and screenshots.
8. The world is not durable across reloads. The chart is wiped with it.
9. A harbour the ship has moored at is remembered by name. In a new world it
   is drawn and named on the scope from the start, at its new position.
10. The spawn stays at lat 0, lon 0.
11. A world that fails its checks is rejected and redrawn.
12. The hull clock does **not** tick during fishing, a battle, the shop or
    the menu.
13. Wear doubles when any of storm, rain or fog at the ship is **0.5 or
    above**. It never stacks past 2x.
14. The speed caps ignore every upgrade (Trim, Overdrive). The wind still adds.
15. Below 25% the fishing START and AGAIN buttons are dead.
16. Repair is free at a berth at the same 2%/s shore power runs at. A paid fix
    is sold in every shop: 100 gold per 10%, in 10% steps or all at once,
    rounded up to the next 10%.
17. Durability is saved and survives a world change.
18. The hull block sits directly under the backup cell in the telemetry panel.
19. The scope shows a warning. In a battle the player's hits-to-lose is 2
    below 50% and 1 below 25%. There is no sinking and no game over; the
    floor is 1%.

## Interpretations made by the planner

These follow from the decisions above but were not stated in them. Change
them here, before a stream starts, not in a stream.

- **"Displayed again in the new map"** means the remembered harbour's NEW
  position is shown. Nothing about the old position is kept, because the old
  world no longer exists.
- **Per-harbour upgrade stock is rolled once and saved**, keyed by name, so a
  remembered harbour keeps the upgrades it had. Rolling it per world would
  make the memory of a harbour worth nothing. The roll covers all 36 at once
  so every upgrade line is guaranteed to be sold somewhere.
- **A HARBOURS page in the Esc menu** lists the 36 names, marks the known
  ones with a bearing and distance, and shows the rest as UNCHARTED. Without
  it a remembered harbour beyond the scope's 50-unit range cannot be found
  in a new world, and decision 9 would be true only inside 50 units.
- **The polar harbours carry no special service.** They are ordinary
  harbours with fixed names and fixed positions.
- **While moored the hull repairs and does not wear.** The two rates would
  otherwise fight at 2.00 against 0.004 and the tag would have to name both.
- **"Under 50%"** is strictly below 50; **"under 25%"** strictly below 25.

## Units

- `HullState.percent` is a **whole number in [1, 100]**, the same unit
  `SaveData.reserve` uses. The sim runs on a float internally and rounds for
  the file, exactly as `battery.ts` does.
- Wear is in **percent per second**: `HULL_WEAR = 0.25 / 60`.
- `speedCap` is **world units per second**, the same unit `MAX_FORWARD` and
  `PropulsionState.maxForward` are in, printed as knots one for one.
- `Town.name` is the **identity**: the save keys `knownHarbours` and
  `harbourStock` on it. `Town.index` is only how names are dealt out
  (position in `HARBOUR_NAMES`) and is never persisted.
- The world seed is a **uint32**, as `mulberry32` takes it.

## Why this shape, and the three traps

**Trap 1: `createGlobe` is one call, and the expensive half comes last.**
`globe.ts` rasterises the height map, culls islets, flood-fills the sea,
places towns and then builds the land mesh (2.2 million vertices on high).
A rejection loop that calls the whole thing costs a land mesh per rejected
world. The loop must sit between the data half and the mesh half, which
means splitting `createGlobe` into `buildWorldData` and `buildWorldMeshes`.
Stream A owns that split; nothing else may call either half.

**Trap 2: `HITS_TO_LOSE` is shared by both combatants.** `battle.ts:313`
compares both sides against the one constant, and `battlecover.ts` prints it
into the rules sentence. The player's threshold now varies per fight; the
AI's does not. The constant becomes the AI's number and the player's moves
into `Combatant`. `SHOP_PLAN.md` lists exactly this split as its open
prerequisite; this plan closes it.

**Trap 3: the poles are where `tangentFrame` breaks.** A town centre exactly
on a pole has no north. The polar town's centre is placed `POLE_OFFSET_RAD`
(0.01 rad, 2 units) down lon 0 from the pole, and its berth further down the
same meridian. Nothing in this plan stores a bearing at either harbour; every
direction is a unit vector, as ARCHITECTURE requires.

## Step 0: the contract (orchestrator, before any stream starts)

One commit. `npm test` green at the end of it. Nothing in Step 0 changes
behaviour a player can see, except that towns have names.

### `src/types.ts`

```ts
export interface Town {
  readonly dir: Vector3;
  readonly height: number;
  readonly coast: number;
  /** Never null any more: a town without a berth is not founded. Kept nullable through Step 0 so radar.ts's `if (town.dock)` keeps compiling; Stream A removes the null. */
  readonly dock: Dock | null;
  /** Display name, from HARBOUR_NAMES. Unique across `Towns.all`. */
  readonly name: string;
  /** Position in HARBOUR_NAMES. 0 and 1 are the poles. */
  readonly index: number;
}

export interface Towns {
  readonly all: readonly Town[];
  readonly docks: readonly Dock[];
  dockAt(dir: Vector3): Dock | null;
  /** The town called `name`, or null. */
  byName(name: string): Town | null;
}

export interface Combatant {
  // ...existing fields...
  /** Hits this side can take before it loses. 3 for the AI; 3, 2 or 1 for the player, read off the hull at the moment the fight starts and frozen for its length. */
  readonly hitsToLose: number;
}

export type HullMode = 'full' | 'wearing' | 'weathering' | 'repairing';

export interface HullState {
  /** [1, 100], whole percent for display and the file; the sim keeps a float. */
  readonly percent: number;
  /** Top speed the hull allows this frame, world units/s. Infinity at 50% and above. */
  readonly speedCap: number;
  /** False below 25%. */
  readonly canFish: boolean;
  /** 3, 2 or 1. */
  readonly hitsToLose: number;
  /** What the hull is doing, for the HUD to label. */
  readonly mode: HullMode;
  /** Signed, percent per SECOND, for the rate readout. */
  readonly rate: number;
}

export type UpgradeLine = 'trim' | 'moonglass' | 'arclamp' | 'governor';

export interface SaveData {
  // ...existing thirteen fields...
  /** Whole percent, [1, 100]. Missing or bad → 100. */
  hull: number;
  /** Harbour names the ship has moored at, in first-visit order. Missing or bad → []. Unknown names are kept, not dropped: a name table can grow. */
  knownHarbours: string[];
  /** Name → the upgrade lines that harbour sells. Missing or bad → {} (re-rolled at boot). */
  harbourStock: Record<string, UpgradeLine[]>;
}
```

### `src/harbournames.ts` (complete in Step 0, never a stub)

```ts
/** Index 0 is the North Pole, index 1 the South Pole, always. */
export const HARBOUR_NAMES: readonly string[] = [
  'Marine Stronghold',
  "No Man's Land",
  // Gritty, 11
  'Rustwharf', 'Cinder Quay', 'Slagharbour', 'Bilgewater Reach', 'Scrapmoor',
  'Tarhook', 'Ironmaw', 'Brinegut', 'Sootfall Landing', 'Gutterhaven', 'Rivet Row',
  // Sleek, 23
  'Neon Reach', 'Voltmeridian', 'Lumen Bay', 'Chromehaven', 'Halcyon Spire',
  'Azimuth Port', 'Prism Landing', 'Ionport', 'Skyline Berth', 'Aurelia Dock',
  'Cobalt Terrace', 'Quantum Quay', 'Helix Harbour', 'Zenith Mooring',
  'Solace Wharf', 'Vantage Cove', 'Cerulean Gate', 'Nova Anchorage',
  'Radiant Sound', 'Oberon Station', 'Silvercrest', 'Meridian Arc', 'Luminary Point',
];
export const HARBOUR_COUNT = 36;
export const NORTH_POLE_INDEX = 0;
export const SOUTH_POLE_INDEX = 1;
```

A unit test asserts length 36 and uniqueness. The two owner-named entries
are verbatim, apostrophe included.

### `src/hull.ts` (stub)

```ts
export interface Hull {
  readonly state: HullState;
  /** Advance the wear or the repair. `docked` wins over `weathered`. Called only from the sailing branch of the frame loop. */
  update(dt: number, docked: boolean, weathered: boolean): void;
  /** Knock `points` whole percent off, floored at 1. */
  damage(points: number): void;
  /** Add `points` whole percent, capped at 100. */
  repair(points: number): void;
  /** Fires when the whole-percent value changes, for the save. */
  onChange(fn: () => void): void;
}
export function createHull(initialPercent: number): Hull
```

The stub returns 100, `speedCap: Infinity`, `canFish: true`,
`hitsToLose: 3`, `mode: 'full'`, `rate: 0`, and no-ops. Stream B replaces
the body; the signature is fixed here.

### Threading, all optional and defaulted

- `createTowns(heightMap, waterBodies, seaLevel, seed = TOWN_SEED)`.
  Step 0 also assigns `name` and `index` by placement order from
  `HARBOUR_NAMES`, so 40 towns get 36 names and four get `''`. That is wrong
  and temporary; Stream A makes it exact. `byName` is a linear search.
- `createTerrain(seed)` already takes a seed. `main.ts` keeps passing
  `DEFAULT_SEED` until integration.
- `createShip(terrain, spawn, onProgress, hull = stubHull)`; `ship.ts` reads
  `hull.state.speedCap` and does nothing with it yet.
- `createHud(..., hull = stubHull)`, `createRadar(..., known = new Set<string>(), hull = stubHull)`,
  `createShop(deps & { hull, harbour: () => Town | null, stock: HarbourStock })`,
  `createFishCover(deps & { hull })`, `createFishing(deps & { hull })`.
- `createBattleSim(..., playerHitsToLose = HITS_TO_LOSE)`.
- `createRecords()` returns the existing twelve plus `hull`, `known`, `stock`
  (see Stream D for the two new stores); the stub `hull` until D lands.

## Stream A: the world

Owns `terrain.ts`, `towns.ts`, `citylights.ts`, `globe.ts`, a new
`worldgen.ts`, `tests/fixtures/*`, `tests/smoke/*`, `tests/shots.mjs`, and
the unit tests for each.

### `terrain.ts`: land at both poles, water beside it

`heightAt` gains a polar term for each of `+Y` and `-Y`, applied after the
spawn clearing and before the clamp, as a function of the angle `d` from the
pole:

| Band | Angle from pole (rad) | Height |
|---|---|---|
| Islet | `d < POLE_LAND_RAD = 0.02` | max(natural, seaLevel + 0.16) |
| Moat | `0.02 ≤ d < POLE_MOAT_RAD = 0.08` | min(natural, −0.32) |
| Fade | `0.08 ≤ d < POLE_FADE_RAD = 0.20` | smoothstep from the moat floor back to natural, biased downward by `(1 − t) * 0.12` so the moat usually opens to the sea |

Four units of rock in sixteen of water, in a forty-unit dimple. Whether the
moat actually connects to the ocean is not guaranteed by the terrain; that is
what the rejection loop is for. The bias in the fade band is what keeps the
rejection rate tolerable; A measures it (see Verification) and may widen the
band.

### `towns.ts`: exactly 36, poles first, berth at the shore

- `CLUSTER_TARGET` is replaced by `HARBOUR_COUNT` and becomes a **count**:
  the loop runs until 36 towns hold a berth or `CLUSTER_TRIES` is spent, and
  in the second case `createTowns` returns fewer than 36, which the loop in
  `worldgen.ts` treats as a rejection.
- `CLUSTER_MIN_ARC` relaxes from 0.095 to **0.075** (15 units). Decision 2.
  At that spacing two rings of `DOCK_RADIUS` 8 CAN touch by geometry alone,
  so the no-overlap promise on `dockAt` no longer follows from the arc. **The
  overlap test on `berthXyz` (`towns.ts:343`) stays and is the authority**;
  a candidate whose berth would overlap another's is skipped, as today.
- **The two polar towns are placed first**, outside the random stream, so the
  PRNG sequence for the other 34 is unchanged by their existence. Centre at
  `POLE_OFFSET_RAD = 0.01` down lon 0 from the pole; berth at
  `POLE_BERTH_RAD = 0.05` down the same meridian, which is inside the moat.
  If the berth direction is not reachable sea in `waterBodies`, the town is
  not founded and the count comes up short: rejection.
- **The berth moves to the shoreline.** The reach-and-margin walk
  (`BERTH_REACH`, `BERTH_MARGIN`) is replaced by: sweep the 12 coastal
  bearings, walk each outward from the centre in steps of `0.002` rad until
  the first reachable sea texel, continue `BERTH_SHORE_MARGIN = 0.012` rad
  (2.4 units) further so the ring's inner edge clears the surf, and take the
  bearing whose berth scores highest on open-water fraction around it (the
  existing `oceanFraction` probe). The berth must be within
  `BERTH_MAX_ARC = 0.04` rad (8 units) of the centre; a candidate that cannot
  find one that close is not founded.
- Names are dealt by `index`: the poles take 0 and 1, the rest take 2..35 in
  placement order. `byName` is a `Map`.
- `Town.dock` becomes non-null; `radar.ts`'s `if (town.dock)` becomes
  unconditional (that one line in `radar.ts` is A's to change, and nothing
  else in that file).

### `citylights.ts`: no outposts, fuller towns

- Delete the lone-outpost scatter (`OUTPOST_TARGET`, `OUTPOST_TRIES`, the
  second loop) outright. Decision 1.
- The per-town member count goes up by half, so the night side is not empty
  now that 440 lights are gone. The strip-along-the-shore shape is kept.
- The scatter seed derives from the **world** seed passed in, not from a
  constant.

### `globe.ts` and `worldgen.ts`: the loop

`createGlobe` is split in two, both exported, both pure functions of their
inputs:

```ts
export function buildWorldData(terrain, quality): WorldData
  // heightMap, islets cull, waterBodies, towns. No THREE objects. ~1 s on the owner's machine.
export function buildWorldMeshes(data, terrain, quality, plugins): Globe
  // land mesh, water, sky, clouds, city lights, everything that was the rest of createGlobe.
```

`worldgen.ts` owns the seed and the loop:

```ts
export interface WorldChecks { spawnIsSea: boolean; landFraction: number; polesReachable: boolean; harbourCount: number }
export function checkWorld(data: WorldData, terrain: Terrain): WorldChecks
export function worldPasses(c: WorldChecks): boolean
  // spawnIsSea && landFraction in [LAND_MIN, LAND_MAX] && polesReachable && harbourCount === 36
export async function generateWorld(seedHint: number | null, quality, onAttempt: (n: number, seed: number) => Promise<void>): Promise<{ seed: number; terrain: Terrain; data: WorldData }>
```

- With a `seedHint` (from `?seed=`) exactly one attempt is made and a
  failure **throws**, so a pinned test seed that stops passing is loud.
- Without one, seeds come from `crypto.getRandomValues`, up to
  `WORLD_ATTEMPTS = 12`. `onAttempt` is awaited before each so the loading
  bar can paint `CHARTING A NEW SEA (3)`. On exhaustion the loop falls back
  to `DEFAULT_SEED` (1337), which must pass by construction; A verifies that
  it does after the terrain change and regenerates `world-golden.json`.
- `LAND_MIN` and `LAND_MAX` are calibrated by A: measure seed 1337's land
  fraction from the culled height map and set the band to ±40% of it.
- `spawnIsSea` is true by construction of the spawn clearing; it is checked
  anyway because it is one texel read and the clearing is a constant someone
  will retune.

### Tests (Tier 1)

- `harbournames.test.ts`: 36 entries, unique, indices 0 and 1 verbatim.
- `towns.test.ts`: against the seed-1337 fixture height map, `all.length ===
  36`, every `dock` non-null, every berth within `BERTH_MAX_ARC` of its
  centre, no two berths within `2 * DOCK_RADIUS`, index 0 within 0.02 rad
  of `+Y` and index 1 of `-Y`, `byName` round-trips every name.
- `terrain.test.ts` (new cases): `heightAt(+Y)` and `heightAt(−Y)` above sea
  level; a point 0.05 rad from each pole below it.
- `worldgen.test.ts`: `worldPasses` truth table; a hand-built `WorldData`
  with 35 towns fails; a pinned seed that fails throws.
- `world-golden.json` regenerated once with `npm run golden:update`, and the
  diff reviewed: the coastline must be identical everywhere except inside
  0.20 rad of each pole.
- `tests/smoke/game.spec.ts` and `tests/shots.mjs` gain `&seed=1337` on every
  URL they open.

## Stream B: the hull

Owns `hull.ts`, `ship.ts`, `fishcover.ts`, `fishing.ts`, `battle.ts`,
`battleconstants.ts`, `battlecover.ts`, `battleui.ts`, `energy.ts` (one
export), and the unit tests for each.

### `hull.ts`

The sim. A float `value` in [1, 100].

```
update(dt, docked, weathered):
  if docked:            value += HULL_REPAIR_RATE * dt      // 2.0 %/s, same as DOCK_RATE's net
  else:                 value -= HULL_WEAR * dt * (weathered ? 2 : 1)   // 0.25 %/min or 0.50
  clamp [1, 100]
damage(points): value = max(1, value - points)
repair(points): value = min(100, value + points)
```

Derived on every read, never stored:

| `percent` | `speedCap` | `canFish` | `hitsToLose` |
|---|---|---|---|
| 50..100 | `Infinity` | true | 3 |
| 25..49 | 10 | true | 2 |
| 2..24 | 5 | false | 1 |
| 1 | 1 | false | 1 |

`mode`: `'full'` at 100 (docked or not); `'repairing'` when docked and
below 100; `'weathering'` when not docked and `weathered`; `'wearing'`
otherwise. `rate`: +2.0, −0.25/60, −0.50/60, or 0.

`onChange` fires when `Math.round(value)` changes, the same throttle
`battery.ts` uses so the save is not written sixty times a second.

### `ship.ts`

At `ship.ts:833`, after `propulsion.maxForward` is read:

```ts
const effMaxForward = Math.min(propulsion.maxForward, hull.state.speedCap);
```

That is the whole change. Trim and Overdrive are inside `propulsion`, so both
are overridden (decision 14). The wind is added to `groundSpeed` after the
engine integrates, untouched. The `accel` line below it already handles a
non-default top speed. Reverse is capped by the same number because it reads
`effMaxForward` too.

`energy.ts` exports `DOCK_NET_RATE = 0.02` so `hull.ts` can name the same
figure rather than copy it.

### The battle

- `battleconstants.ts`: `HITS_TO_LOSE` keeps its value and is renamed in
  meaning only: it is now the **AI's** threshold. Comment says so.
- `battle.ts`: `createBattleSim` takes `playerHitsToLose`; `Combatant`
  carries `hitsToLose`; `battle.ts:313-314` compare each side against its
  own.
- `battlecover.ts`: the rules sentence reads the player's number:
  "`${n} hit${n === 1 ? '' : 's'} lose${n === 1 ? 's' : ''} it`". The card
  is built at contact, which is where `main.ts` samples `hull.state.hitsToLose`.
- `battleui.ts`: the player's pip strip draws `hitsToLose` pips, not three.
  The AI's strip stays at three. `result()` gains `hull: number` and the
  card prints `HULL −5%` / `HULL −15%` under the gold line.

`main.ts` (integration, not B) applies the damage in `settleOutcome`: win
and draw −5, loss −15; and in `onSunk`: −15. Both **before** the result card
is filled so the card reads a hull that has already moved, the same ordering
the gold and the plant follow there.

### Fishing

`fishcover.ts:198`: `affordable && hull.state.canFish`; the title reads
`Hull under 25%` when the hull is the reason and the power text when power
is. `fishing.ts:270` the same for AGAIN. The FISH dock button itself stays
live: the record must always be readable (README, Fishing).

### `?hull=<percent>`

Read in `main.ts` at integration on the same terms as `?quality=`, but B
provides `createHull(initial)` and documents that the query overrides the
save for the session without writing it back. Shots need 49, 24 and 1.

### Tests (Tier 1)

`hull.test.ts`: wear over 60 s is 0.25; doubled is 0.50; docked overrides
weathered; floor at 1 under `damage(200)`; cap at 100 under `repair(200)`;
the four-row table above at each boundary (49.99 → 10, 50 → Infinity, 24.99
→ 5, 1 → 1); `onChange` fires once per whole percent. `battle.test.ts`:
a player with `hitsToLose: 1` loses on the first hit while the AI needs
three. `ship-physics.test.ts`: with a cap of 5 and Trim III the closed-form
top speed is 5; with a cap of `Infinity` it is 13.

## Stream C: the instruments and the world labels

Owns `hud.ts`, `radar.ts` (all but A's one line), `docks.ts`, `menu.ts`,
`index.html` **TELEMETRY, HUD DOCK, RADAR and MENU sections only**,
`style.css` **as a new section appended at the end of the file**, and the
unit tests for each.

### The hull block

In `index.html`, inside `#hud-pwr`, directly after `#hud-rsv` (decision 18):

```html
<div class="hull hull--sound" id="hud-hull">
  <div class="readout hull__head">
    <span class="readout__key">HULL</span>
    <span class="readout__val hull__val" id="hud-hull-value">100%</span>
  </div>
  <div class="hull__bar" id="hud-hull-bar" role="meter" aria-label="Hull durability" aria-valuemin="1" aria-valuemax="100" aria-valuenow="100">
    <!-- ten segments, as the power bar -->
  </div>
  <div class="hull__status">
    <span class="hull__tag" id="hud-hull-mode">HULL FULL</span>
    <span class="hull__rate" id="hud-hull-rate">0.00 %/min</span>
  </div>
</div>
```

Ten notches like the power bar, a hairline over it like the backup cell,
and a colour of its own (a brass-ish amber family, so it is neither the tank
nor the cell). One modifier on the wrapper carries the severity, on the
power block's rule that the modifier is a severity and the tag is a cause:

| Modifier | Percent |
|---|---|
| `hull--sound` | 50..100 |
| `hull--worn` | 25..49 |
| `hull--failing` | 2..24 |
| `hull--critical` | 1, flashing like `pwr--dead` |

Tags, from `mode` and `percent`:

| Tag | When |
|---|---|
| `HULL FULL` | 100 |
| `SOUND - WEARING` | ≥ 50, mode wearing |
| `SOUND - WEATHERING x2` | ≥ 50, mode weathering |
| `WORN - CAP 10 KN` | 25..49, either wear mode; suffix ` x2` when weathering |
| `FAILING - CAP 5 KN` | 2..24, same suffix rule |
| `CRITICAL - CAP 1 KN` | 1 |
| `BERTH - REPAIRING` | mode repairing, any percent |

Rate readout: `−0.25 %/min`, `−0.50 %/min`, `+2.00 %/s`, `0.00 %/min`.
Minutes for wear and seconds for repair, because a wear rate in per-second
prints as `−0.00`.

### The berth name in the HUD

`PWR_TAG` entries `BERTH - CONNECTING` and `BERTH - CHARGING` become
`<NAME> - CONNECTING` and `<NAME> - CHARGING`, upper-cased, where the name
comes from `towns.dockAt(ship.position)?.town.name`. The tag element may
need `text-overflow: ellipsis`; the longest name is 17 characters.

### The scope

- Every visible harbour icon gets its name beside it, 7 px on small
  screens and 9 px otherwise, in the same mint as the diamond, offset to the
  side away from the scope's centre so it never covers the coast under it.
- A harbour whose name is in `known` is drawn out to the full `RADAR_RANGE`
  whether or not the chart has it, by extending the condition at
  `radar.ts:945` with `|| known.has(town.name)`.
- A hull warning glyph on the bezel beside the weather mark: amber outline
  below 50, red filled below 25, flashing at 1. Nothing at 50 and above.

### The world label

`docks.ts` builds one `THREE.Sprite` per harbour above its beacon mast, from
a small `CanvasTexture` of the name in the HUD's face, `sizeAttenuation`
off so it holds a screen size, faded by distance from `LABEL_FADE_NEAR = 60`
to `LABEL_FADE_FAR = 140` units, and excluded from `LAYER_REFLECTED` so it
never appears in the water. 36 draws; measured against the Backquote
overlay before and after.

### The HARBOURS menu page

`index.html` MENU section gains a `menu__pane--harbours` with a list, and
the root pane a **Harbours** button. `menu.ts` fills the list on open: each
of the 36 names, and for a known one its bearing (`N 042°` style) and
distance in units from the ship, computed once at open from `towns.byName`
and `ship.state.position`. Unknown names read `UNCHARTED` in the dim face.
`createMenu` takes `harbours: () => { name: string; known: boolean; bearing: number; distance: number }[]`
so `menu.ts` never sees `Towns` or `ShipState`.

### Tests (Tier 1)

`hud.ts` and `radar.ts` have no tests today and this stream adds none for
the DOM. The tag and modifier selection are pure functions (`hullTag`,
`hullSeverity`) exported for `hull-hud.test.ts`, which covers the two
tables above at every boundary. The bearing and distance formatter for the
menu is exported and tested the same way.

## Stream D: the file and the shop

Owns `save.ts`, `chart.ts`, `shop.ts`, a new `harbourstock.ts`, a new
`knownharbours.ts`, `index.html` **SHOP section only**, `style.css` **as a
new section appended at the end of the file** (after C's if C lands first;
the two sections must not share a selector), and the unit tests for each.

### `save.ts`

Three fields join version 1 with per-field repair, on the convention
recorded at `save.ts:195`: `hull` (whole number in [1, 100], else 100),
`knownHarbours` (array of strings, non-strings dropped, else []),
`harbourStock` (object of string → array of `UpgradeLine`, bad entries
dropped, else {}). `EMPTY_SAVE` gains the three defaults. `createRecords`
constructs and subscribes `hull` (B's `createHull(save.hull)`), `known`
(`createKnownHarbours(save.knownHarbours)`) and `stock`
(`createHarbourStock(save.harbourStock)`), and `persist` writes all three.

### `knownharbours.ts`

```ts
export interface KnownHarbours { readonly names: ReadonlySet<string>; add(name: string): void; onChange(fn): void }
```

`add` is idempotent; `onChange` fires only on a genuinely new name. `main.ts`
calls `add` on the frame `energy.state.mode` becomes `'docked'`, which is
the project's one definition of moored.

### `harbourstock.ts`

```ts
export interface HarbourStock { linesFor(name: string): readonly UpgradeLine[]; snapshot(): Record<string, UpgradeLine[]>; onChange(fn): void }
export function createHarbourStock(saved: Record<string, UpgradeLine[]>, names = HARBOUR_NAMES, random = Math.random): HarbourStock
```

If `saved` holds an entry for every name in `names`, it is used as is. If
any name is missing, the **whole table is rolled once**: each harbour draws
each of the four lines at 50%, a harbour that drew none is given one at
random, and the roll is repeated until every line is carried by at least
`LINE_MIN_HARBOURS = 6` of the 36. Then `onChange` fires once so the file
has it. Rolling all 36 together is what makes the coverage guarantee
possible; rolling lazily per visit could not promise Trim exists anywhere.

### `shop.ts`

- The header prints the harbour name: `createShop` takes
  `harbour: () => Town | null` and reads it on `open()`.
- Upgrade rows are hidden when `stock.linesFor(name)` does not include their
  line. In their place one dim line reads `Not sold here. Known at: A, B`
  listing known harbours that carry it, or `Not sold here.` if none is
  known. Consumables and the backup cell are always shown.
- A **REPAIR** block above the tabs, always shown:
  `HULL 63%` · `[+10% — 100]` · `[FIX ALL — 400]`. Prices from
  `HULL_REPAIR_STEP = 10`, `HULL_REPAIR_PRICE = 100`,
  `fixAllPrice(percent) = ceil((100 − percent) / 10) * 100`. `+10%` calls
  `hull.repair(10)` (which caps at 100, so 95 → 100 for 100 gold: decision
  16's rounding). Both buttons disabled at 100 with title `Hull is sound`,
  and disabled when the purse is short with the usual `Needs N gold`.
- Buying repair while moored is allowed and simply stacks with the free
  2%/s; the shop does not need to know.

### `chart.ts`

`CHART_VERSION` goes to 2 and the encoding gains four seed bytes after the
version byte. `createChart(seed, saved)` discards a saved chart whose
version is not 2 or whose seed differs, and starts blank. A v1 chart is
therefore dropped on the first load after this lands, which is correct: it
charted a world that no longer exists.

### Tests (Tier 1)

`save.test.ts`: the three fields round-trip; each bad shape repairs to its
default; a v1 file without them loads with hull 100. `harbourstock.test.ts`:
a full table is kept verbatim; a missing name triggers a full re-roll; every
line is carried by ≥ 6 harbours over 1000 seeded rolls; no harbour has zero
lines. `knownharbours.test.ts`: idempotent add, change fires once.
`chart.test.ts`: a seed mismatch starts blank; a match restores;
`encode()` length grew by exactly 4 bytes before base64. `shop.test.ts`:
`fixAllPrice` at 100, 99, 91, 90, 1.

## Changes to existing modules, by file

| File | Stream | Change |
|---|---|---|
| `types.ts` | Step 0 | `Town.name/index`, `Towns.byName`, `Combatant.hitsToLose`, `HullState`, `UpgradeLine`, three `SaveData` fields |
| `harbournames.ts` | Step 0 | new, complete |
| `hull.ts` | Step 0 stub, B body | the sim |
| `terrain.ts` | A | polar islet, moat, fade |
| `towns.ts` | A | 36 exact, poles first, shoreline berth, names, `byName`, relaxed arc, seed parameter |
| `citylights.ts` | A | outposts deleted, towns fuller, seed from world |
| `globe.ts` | A | split into data and mesh halves |
| `worldgen.ts` | A | new: seed, checks, loop |
| `radar.ts` | A (one line), C | `dock` non-null; names, known harbours, hull glyph |
| `ship.ts` | B | `min(maxForward, speedCap)` |
| `energy.ts` | B | export `DOCK_NET_RATE` |
| `battle.ts`, `battleconstants.ts`, `battlecover.ts`, `battleui.ts` | B | per-combatant hits, card text, pips, result hull line |
| `fishcover.ts`, `fishing.ts` | B | `canFish` gate on START and AGAIN |
| `hud.ts` | C | hull block writer, berth name in the power tag |
| `docks.ts` | C | name sprites |
| `menu.ts` | C | HARBOURS page |
| `index.html` | C (telemetry, dock, radar, menu), D (shop) | markup |
| `style.css` | C, D | one appended section each |
| `save.ts` | D | three fields, three stores in `createRecords` |
| `chart.ts` | D | seed in the encoding |
| `shop.ts` | D | header name, per-harbour rows, REPAIR block |
| `harbourstock.ts`, `knownharbours.ts` | D | new |
| `main.ts` | integration | see below |
| `tests/smoke/*`, `tests/shots.mjs`, `tests/fixtures/*` | A | seed pin, golden regen |

## `main.ts`: the frame loop after integration

Startup, replacing `main.ts:148-180`:

```ts
const seedQuery = new URLSearchParams(location.search).get('seed');
const seedHint = seedQuery !== null && /^\d+$/.test(seedQuery) ? Number(seedQuery) >>> 0 : null;
await loading.step(0.20, 'CHARTING A NEW SEA');
const world = await generateWorld(seedHint, quality, (n, seed) => loading.step(0.20 + n * 0.02, `CHARTING A NEW SEA (${n})`));
const { terrain, data, seed } = world;
const globe = buildWorldMeshes(data, terrain, quality, waterPlugins);
const chart = createChart(seed, loadChart());
```

Hull query: `?hull=<1..100>` overrides `records.hull` for the session by
calling `records.hull.damage(100 - n)` once, before the first frame, and
suppressing that one `onChange`.

Mooring memory: in the sailing branch, `if (energy.state.mode === 'docked') records.known.add(towns.dockAt(ship.state.position)!.town.name)`.

The sailing branch of `frame()` gains, after `energy.update` and before
`ship.update`:

```ts
const wx = weather.state;
const weathered = wx.storm >= 0.5 || wx.rain >= 0.5 || wx.fog >= 0.5;
records.hull.update(dt, energy.state.mode === 'docked', weathered);
```

It is in the sailing branch and nowhere else: the frozen branch (menu,
shop, fishing cover, fishing session, battle cover) and the arena branch do
not reach it, which is decision 12 by construction rather than by a flag.

`onSunk`: `records.hull.damage(15)` before `energy.wreck()`.
`settleOutcome`: `records.hull.damage(outcome === 'loss' ? 15 : 5)` first,
then the existing gold and plant lines, then `battleUi.result({..., hull})`.
`onContact`: `playerHitsToLose = records.hull.state.hitsToLose`, passed to
the sim and the cover.

`createShop` gets `hull: records.hull`, `harbour: () => towns.dockAt(ship.state.position)?.town ?? null`,
`stock: records.stock`. `createRadar` gets `records.known.names` and
`records.hull`. `createHud`, `createFishCover`, `createFishing`,
`createShip` get `records.hull`. `createMenu` gets the harbours callback.

## Constants

| Name | Value | Where | Family |
|---|---|---|---|
| `HARBOUR_COUNT` | 36 | `harbournames.ts` | count |
| `CLUSTER_MIN_ARC` | 0.075 rad | `towns.ts` | world-scale |
| `BERTH_MAX_ARC` | 0.04 rad | `towns.ts` | world-scale |
| `BERTH_SHORE_MARGIN` | 0.012 rad | `towns.ts` | world-scale |
| `POLE_OFFSET_RAD` | 0.01 rad | `towns.ts` | world-scale |
| `POLE_BERTH_RAD` | 0.05 rad | `towns.ts` | world-scale |
| `POLE_LAND_RAD` / `POLE_MOAT_RAD` / `POLE_FADE_RAD` | 0.02 / 0.08 / 0.20 rad | `terrain.ts` | world-scale |
| `WORLD_ATTEMPTS` | 12 | `worldgen.ts` | count |
| `LAND_MIN` / `LAND_MAX` | calibrated by A | `worldgen.ts` | fraction |
| `HULL_WEAR` | 0.25 / 60 %/s | `hull.ts` | rate |
| `HULL_WEATHER_GAIN` | 2 | `hull.ts` | factor |
| `HULL_WEATHER_THRESHOLD` | 0.5 | `main.ts` | envelope |
| `HULL_REPAIR_RATE` | 2.0 %/s (= `DOCK_NET_RATE * 100`) | `hull.ts` | rate |
| `HULL_MIN` | 1 | `hull.ts` | percent |
| `HULL_CAP_WORN` / `FAILING` / `CRITICAL` | 10 / 5 / 1 | `hull.ts` | ship-scale, units/s |
| `HULL_WORN_BELOW` / `HULL_FAILING_BELOW` | 50 / 25 | `hull.ts` | percent |
| `HULL_BATTLE_WIN` / `DRAW` / `LOSS` / `MAELSTROM` | 5 / 5 / 15 / 15 | `main.ts` | percent |
| `HULL_REPAIR_STEP` / `HULL_REPAIR_PRICE` | 10 / 100 | `shop.ts` | percent / gold |
| `LINE_MIN_HARBOURS` | 6 | `harbourstock.ts` | count |
| `LABEL_FADE_NEAR` / `FAR` | 60 / 140 | `docks.ts` | ship-scale |
| `CHART_VERSION` | 2 | `chart.ts` | pipeline |

## Performance

- A rejected world costs one height map, two flood fills and a town search:
  about a second on the owner's machine, on the main thread, behind the
  loading bar. Twelve attempts is the ceiling, and the fallback seed ends it.
  The land mesh is never built for a rejected world (Trap 1).
- The hull sim is a handful of scalar operations per frame.
- 36 label sprites are 36 draws. If the Backquote overlay shows them, they
  merge into one `InstancedMesh` with a texture atlas; not before.
- The scope's name text is 36 `fillText` calls at most, only for icons
  already being drawn.

## Known artefacts, accepted

- A first load after this lands drops the old chart and the old towns. The
  gold, the book and the stock survive. There is no message about it.
- The polar dimple is visible from orbit as a round pit at each pole. It is
  where the fortress and the last outpost are; a player who zooms out will
  see two dots, which is the point.
- Berths at the shoreline sit in the surf band. `RING_LIFT` in `docks.ts`
  already clears the displaced sea; if the ring's inner edge shows land
  through it, `BERTH_SHORE_MARGIN` goes up before `RING_LIFT` does.
- With free repair at any berth the paid fix mostly matters mid-ocean, and
  100 gold a step is a convenience against a purse battles fill by the
  thousand. That is the price the owner set.

## Work split

**Step 0** (orchestrator, one commit): `types.ts`, `harbournames.ts`
complete, `hull.ts` stub, the defaulted parameters threaded through every
signature above, names dealt by placement order so the scope can show one.
`npm test` green. Nothing else changes.

Then four agents in parallel, each in its own worktree branched from Step 0,
files partitioned as the table above:

| Agent | Owns | Deliverable |
|---|---|---|
| A: world | `terrain.ts`, `towns.ts`, `citylights.ts`, `globe.ts`, `worldgen.ts`, `radar.ts` one line, fixtures, smoke, shots | 36 named harbours with shoreline berths, poles fixed, no outposts, a world drawn at random and rejected when bad, tests pinned to 1337 |
| B: hull | `hull.ts`, `ship.ts`, `energy.ts` export, `fishcover.ts`, `fishing.ts`, `battle*.ts` | The sim, the caps, the fishing gate, per-combatant hits, `?hull=` |
| C: instruments | `hud.ts`, `radar.ts` (rest), `docks.ts`, `menu.ts`, their `index.html` sections, a `style.css` section | The hull block, the berth name, the scope names and glyph, the world labels, the HARBOURS page |
| D: file and shop | `save.ts`, `chart.ts`, `shop.ts`, `harbourstock.ts`, `knownharbours.ts`, the SHOP section, a `style.css` section | Three saved fields, a seed-keyed chart, per-harbour upgrade rows, the REPAIR block |

Cross-stream dependencies, all at the edges:

- C and D build against the Step 0 `hull.ts` stub. Neither needs B to land
  to be shot; `?hull=` for real shots waits for B.
- C's scope needs `known` and D's `KnownHarbours`; Step 0 threads an empty
  `Set` so C compiles, and C shoots with a hand-filled set in the debug hook
  until D lands.
- D's shop header needs `Town.name`, which Step 0 provides on the OLD
  placement; correct names arrive with A.
- A regenerates `world-golden.json` once and owns the diff. No other stream
  touches fixtures.
- `index.html` and `style.css` are shared by C and D by **section**, named
  above. Neither edits the other's section, and each appends its CSS as a
  new block at the end of the file under its own banner comment.

**Integration** (orchestrator): merge A through D, wire `main.ts` per the
section above, run `npm run test:all` once, take the owner's shot set at
`?seed=1337`, at `?hull=49`, `?hull=24`, `?hull=1`, and at each pole
(`?seed=1337` and sail, or a `?spawn=` if A adds one), update
`docs/ARCHITECTURE.md` (module rows for `harbournames.ts`, `hull.ts`,
`worldgen.ts`, `harbourstock.ts`, `knownharbours.ts`; the frame loop block;
**Units, pinned** for `HullState.percent`, `speedCap` and the seed; a
**Harbours** section covering the three traps), update `README.md`'s
**Ports**, **The chandlery** and **Instruments** entries and add a **Hull**
entry, update `docs/TESTING.md` for the seed pin and the retest of the
"129 tests" figure, and bump the version.

## Verification, and the budget

`docs/TESTING.md`'s rule applies: under five minutes of testing across the
whole job, per stream.

- Tier 1 (`npm test`): every stream on every change. New files listed per
  stream above.
- Tier 2 (`npm run test:smoke`): once per stream at its end, once at
  integration. The smoke spec must pass at `?seed=1337`; A adds one case
  that `?seed=<a seed A has measured to fail>` rejects and the page still
  reaches READY on the fallback.
- Tier 3 (`npm run shots`): A at `?seed=1337` diffed by eye against `main`
  for the coastline outside the poles, then at each pole; C at each `?hull=`
  station and with the menu open on HARBOURS; D with the shop open at a
  harbour that lacks Trim. The orchestrator once at the end.
- A measures and records in `ARCHITECTURE.md`: the rejection rate over 50
  random seeds (target: under one in three rejected) and the land-fraction
  band that produced it.

## Out of scope

- Audio of any kind.
- Any service or price that differs between harbours beyond which upgrade
  lines are carried.
- A ship purchase, hull variety, or visible damage on the hull mesh.
- Saving the world, its seed, or the ship's position across a reload.
- Hull wear in the battle arena or during a fishing session.
- The AI raider having a hull of its own.
- Reworking the battle helm, the AI, or the loot; `docs/BATTLE_REWORK_PLAN.md` stays where it is.
- A seed entry field for players.

## Trade-offs accepted

- **Names by index, identity by name.** A save keys `knownHarbours` and
  `harbourStock` on the string, not the index, so a renamed entry in
  `HARBOUR_NAMES` reads as a new harbour. That is the right failure: a
  rename is a new place.
- **The world loop is synchronous.** A Worker would keep the tab responsive
  during rejections, and is the right next step, but it is a separate piece
  of work (`docs/ARCHITECTURE.md` has no Worker anywhere yet) and the loading
  bar already covers the wait.
- **The moat is a terrain edit, not a guarantee.** The poles are reachable
  in most worlds and rejected in the rest; the alternative, carving a
  channel to the nearest ocean, is a pathfinding job over the height map
  and is not worth it for two harbours.
- **Wear is real time, not sea miles.** A ship at anchor in the sun wears as
  fast as one under way. The owner chose the clock; a per-unit-travelled
  rate would be a one-line change in `hull.update` if that ever reads wrong.
