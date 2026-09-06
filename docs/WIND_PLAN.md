# Wind system — implementation plan

Status: **implemented**, and landed on `main`.

This document is kept as the record of what was approved. It is deliberately
NOT updated to follow later tuning — `docs/ARCHITECTURE.md` is the current
truth. Three of its decisions have since been changed by the owner:

- the push coefficient is **0.35**, not 0.75, so 8 kn of engine under a 10 kn
  tailwind makes **11.5 kn**, not 15.5, and ground speed tops out near 20.6
  rather than ~32;
- `MAX_FORWARD` is **15 kn**, not 20;
- the hull is drawn at **0.65** scale.

Two claims below were also wrong when they were written, and are worth knowing
before trusting the rest:

- the **8 kn shoreline cap is unreachable**. The innermost probe ring is 5
  world units, so the ramp floors at `8 + 8 × (5/40)` = **9.0 kn**. The two
  decisions are in tension; the code implements both as written.
- the flag **did not** previously stream astern. It leaned toward the bow,
  because the model was authored around a permanent following wind, so the
  apparent-wind flag is a visible change rather than a preserved one.

This document is the complete brief. An implementing agent should not need the
conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**Units, pinned**, **Ship dynamics**, **Frame loop** and **Ship energy** — this
plan follows the conventions recorded there and adds to them.

## Decisions already made

These were settled with the project owner. Do not re-litigate them; if one turns
out to be unworkable, say so and stop rather than substituting another.

| Question | Decision |
|---|---|
| Push formula | `boat + 0.75 x wind`. A ship making 8 kn with a 10 kn tailwind makes **15.5 kn** over the ground. |
| Ceiling | None beyond physics. Engine speed still clamps at `MAX_FORWARD` (20 kn); ground speed may reach ~32 kn. |
| Crosswind | **Real drift.** Wind is a velocity added to the ship's own, so a beam wind moves the hull sideways off its course. No weathervaning: the bow never turns on its own. |
| Strength | 8 kn cap at the shoreline, 16 kn cap in open ocean (exactly double). |
| Coast metric | Smooth linear ramp between the two caps over the first 40 world units offshore. |
| Docked immunity | Wind is zero exactly while `energy.state.mode === 'docked'` (inside a berth ring **and** slow enough to connect). One shared definition. |
| Event shape | Ramped events with calms between them, fresh random bearing each time. |
| Feedback | All four: HUD wind row, HUD ground-speed breakdown, radar wind arrow, sail and flag react. |

## 1. `src/wind.ts` — the new module

Owns one `WindState`, **mutated in place for the life of the run**, exactly as
`energy.ts` owns `EnergyState`. The HUD, the radar, `shipfx.ts` and `ship.ts`
all hold that same reference; handing out a copy would leave them reading a wind
that had stopped moving. Signature mirrors the other systems:

```ts
export function createWind(terrain: Terrain, heightMap: HeightMap, seed?: number): Wind;
// Wind = { readonly state: WindState; update(dt, ship, energy): void }
```

### State machine

Two phases, alternating forever:

- **Calm**, 3 to 15 s, wind speed 0.
- **Event**, 5 to 30 s, one fixed compass bearing drawn uniformly in [0, 2*PI).

Speed during an event is `envelope * gust * cap`:

- **envelope** — fades 0 to 1 over `FADE = 2 s` at the start and back to 0 at the
  end. The fade must be clamped to a quarter of the event's own duration, or a
  5 s event spends 4 of its 5 seconds fading and never reaches its cap.
- **gust** — smoothed 1D noise over `elapsed`, remapped from [-1, 1] into
  `[GUST_FLOOR, 1]` with `GUST_FLOOR = 0.55`, so speed varies throughout the
  event without the wind dying in the middle of it. Use the `simplex-noise`
  package already in `package.json`; do not add a dependency.
- **cap** — see the coast ramp below.

Randomness comes from a seeded PRNG in the same style as `towns.ts`, so a given
world seed replays the same weather. Draw every random number from that one
stream.

### Coast ramp

The cap is `lerp(COAST_CAP, OCEAN_CAP, clamp(coastDistance / OPEN_SEA_DISTANCE, 0, 1))`.

`coastDistance` is estimated on the CPU from the shared height map — the same
field `radar.ts` rasterises, so the wind and the scope can never disagree about
where the land is. Probe 16 bearings around the ship at 5, 10, 20, 30 and 40
world units (great-circle steps, same maths as `ship.ts`'s `stepAlong`), take the
nearest ring that reports land, and call it 40+ if none do. That is 80 array
reads. Run it at `PROBE_HZ = 4`, not every frame, and smooth the result toward
the new reading with a time constant of about 1 s so a probe flipping between
rings never steps the wind's strength.

The cap is re-evaluated continuously, not locked at the start of an event: the
ship can cross 200 units during a 30 s gust.

### Constants

Author them at the top of the file with the reasoning beside each, in the house
style of `energy.ts`.

| Constant | Value |
|---|---|
| `COAST_CAP` / `OCEAN_CAP` | 8 / 16 world units per second |
| `OPEN_SEA_DISTANCE` | 40 world units |
| `EVENT_MIN` / `EVENT_MAX` | 5 / 30 s |
| `CALM_MIN` / `CALM_MAX` | 3 / 15 s |
| `FADE` | 2 s (clamped to a quarter of the event) |
| `GUST_FLOOR` | 0.55 |
| `WIND_GRIP` | 0.75 |
| `PUSH_TAU` | 0.3 s |
| `PROBE_HZ` | 4 |

## 2. The 8-sector push

The whole point of the sector table is that the interaction is **not** computed
to the exact degree. Take `relative = windBearing - ship.heading`, normalise into
[0, 2*PI), quantise to the nearest 45 degrees, and index a fixed table of
along/across pairs in the ship's own frame:

| Sector (relative bearing of the wind's travel) | along (forward) | across (starboard) |
|---|---|---|
| 0 deg — dead astern, blowing forward | +1 | 0 |
| 45 / 315 | +0.707 | +0.707 / -0.707 |
| 90 / 270 — beam | 0 | +1 / -1 |
| 135 / 225 | -0.707 | +0.707 / -0.707 |
| 180 — dead ahead, blowing back | -1 | 0 |

Push velocity is `WIND_GRIP * windSpeed * (along, across)`. That reproduces the
owner's worked example: 8 kn engine + 0.75 * 10 kn tailwind = 15.5 kn.

**Ease the applied vector** toward the table value with `PUSH_TAU = 0.3 s`
(`1 - exp(-dt / PUSH_TAU)`, the damping form already used for `bankRoll` in
`ship.ts`). Without it, crossing a sector boundary at 16 kn jumps the push by
3.5 kn in a single frame and the hull visibly snaps sideways. The consequence,
which is intended: during a transition the push is briefly not exactly one of the
eight table values.

While `energy.state.mode === 'docked'`, the target push is zero, so the ease also
gives a berth a half-second of shelter rather than a hard cut.

## 3. `src/ship.ts` — move along a velocity, not a heading

This is the largest part of the change and the one to be most careful with.

Today the ship steps along `state.forward` by `speed * dt / GLOBE_RADIUS`. It
must now step along a **ground velocity**: `forward * engineSpeed` plus the eased
push resolved onto `forward` and `starboard`.

- `state.speed` keeps meaning **engine speed** and nothing else. Burn, turn rate,
  bob, sway, bank and the `MAX_FORWARD` clamp all stay on it, unchanged.
- Add `groundSpeed` (signed magnitude of the ground velocity along its own
  direction of travel) and a tangent `velocity: Vector3` to `ShipState` in
  `types.ts`, both read-only on that surface.
- The great-circle step and the `LOOKAHEAD` probe run along the **combined**
  direction, not along `forward`.
- **Collision fallback.** If the combined step is blocked by land, retry the
  engine-only step. A beam wind pinning the hull against a coast must not also
  stop it sailing along that coast. Only when both are blocked does
  `state.speed` go to 0, exactly as beaching does today.
- The `STOP_EPSILON` dead-stop snap stays on engine speed. Read the comment
  above it in `ship.ts` before touching that test — it is load bearing for the
  solar panels.

## 4. `src/energy.ts` — one tweak, and its reason

`DOCK_SPEED_LIMIT` currently tests engine speed. It must test **ground speed**,
or a ship drifting downwind through a ring at 12 kn with its engines off would
read as stopped, connect, and become wind-immune instantly.

Everything else in `energy.ts` stays on engine speed:

- the quadratic burn, because the engines are what draw power;
- the solar test `ship.speed === 0`, so a dead ship drifting downwind still
  charges — which is the whole point of running out of power in a wind.

Document that split in the file. Two speeds means two definitions, and the next
reader needs to know which is which.

## 5. `src/main.ts` — frame order

```
energy.update(dt, shipState, env)
wind.update(dt, shipState, energyState)   // NEW: after energy, before ship
ship.update(dt, input, energyState, windState)
...
hud.update(shipState, energyState, windState)
radar.update(dt, shipState, windState)
```

Wind runs after energy because it needs this frame's `docked` verdict, and
before the ship because the ship consumes the push. Energy therefore still bills
last frame's speed, as `docs/ARCHITECTURE.md` requires.

## 6. Feedback — all four

- **HUD wind row** (`index.html`, `style.css`, `hud.ts`): a `WND` readout in the
  telemetry panel, an arrow rotated to the wind's bearing **relative to the bow**
  (matching the bow-up scope) plus its speed in kn, or `CALM` when there is no
  wind. Every element goes through the existing write-through cache helpers —
  `textWriter`, `transformWriter` — so a steady wind costs no DOM writes.
- **Ground speed breakdown**: the `SPD` row shows ground speed with the wind's
  signed contribution, e.g. `15.5 kn +7.5`. This is what makes the 0.75 rule
  legible to the player.
- **Radar arrow** (`radar.ts`): a small arrow at the rim on the wind's true
  bearing, length scaled by `speed / OCEAN_CAP`. Draw it in the **overlay** pass
  using the live frame, like the north mark — it is not attached to terrain, so
  the stale-raster-frame rule in `docs/ARCHITECTURE.md` does not apply to it.
- **Sail and flag** (`shipfx.ts`): the flag streams along the **apparent** wind
  (true wind minus the ship's own motion), so a 20 kn ship in a calm still
  streams its flag astern exactly as it does today. The sail's belly adds the
  tailwind component on top of the existing speed term. The model only bellies
  the sail one way, so beam and head winds show on the flag, not on the sail —
  do not try to make the sail belly sideways.

## 7. Docs

- `docs/ARCHITECTURE.md`: a **Wind** section covering the state machine, the
  sector table, the engine-vs-ground speed split and why the berth test moved;
  a `wind.ts` row in the module ownership table; the new frame-loop lines.
- `README.md`: a bullet in the world list.

## 8. Verification

The repo has no test runner, so:

1. `npm run build` (this is `tsc` plus the Vite bundle) must pass clean.
   `noUnusedLocals` and `noUnusedParameters` are errors here.
2. A scratch check of the sector table and the 15.5 kn worked example.
3. `npm run dev` under Playwright (Chromium is pre-installed; do not run
   `playwright install`), then screenshot the HUD, the radar arrow and the flag
   mid-event, once near a coast and once in open ocean, to confirm the 8 and 16
   kn caps are actually reached.

## 9. Order of work

types -> wind.ts -> ship.ts movement -> energy.ts berth test -> main.ts loop ->
HUD and CSS -> radar -> shipfx -> docs -> verification -> one commit on
`claude/wind-system-clarification-97hqa1`.

## Trade-offs accepted

- **Separate module, in-place state.** Matches the energy pattern and is easy to
  disable; costs a fourth consumer of `ShipState` and one more frame-loop line
  whose order matters.
- **Velocity-based movement.** Buys real sideways drift and keeps the coast logic
  in one place; it is the largest diff, and `wake.ts` follows the hull's path, so
  a beam-wind drift will produce a slightly crabbed wake. Check it and adjust
  `wake.ts` only if it reads as a bug.
- **Sector table with easing.** Exactly the 8-way simplification asked for and
  trivially tunable; the eased vector is briefly off-table while crossing a
  boundary.
- **Burn on engine speed, berth test on ground speed.** Tailwinds extend range,
  which makes wind strategic, and rings cannot be gamed by drifting through;
  the price is two speed definitions in one file.
- **CPU coast probe at 4 Hz.** 80 array reads a quarter-second, no GPU work,
  shares the radar's height field; an islet smaller than the 5-unit inner ring
  can be missed for a beat, which the smoothing hides.
- **Seeded randomness.** Reproducible for tuning and bug reports; every player on
  the default seed gets the same weather schedule.
