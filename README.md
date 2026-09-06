# Pirate World

A fantasy techno-punk pirate ship navigation game on a procedurally generated 3D globe.

## Run it

```
npm install
npm run dev
```

Then open the URL Vite prints (http://localhost:5173 by default).

## Controls

| Input | Action |
|---|---|
| `W` / `↑` / on-screen ▲ | Thrust forward |
| `S` / `↓` / on-screen ▼ | Reverse |
| `A` / `←` / on-screen ◀ | Turn to port |
| `D` / `→` / on-screen ▶ | Turn to starboard |
| Mouse wheel | Zoom the follow camera |

The ship cannot sail onto land. Running at a coastline stops the ship; turn away to get free.

## The world

Everything but the ship is generated at runtime, and the ship is not modelled
by hand either: `assets/pirateship_beginner.glb` is built by
`tools/build_ship.py` under headless Blender, from the concept art beside it.

- **Terrain.** Seeded 3D simplex noise with domain warping, so continents have
  irregular coastlines rather than blobby edges. About a third of the sphere is
  land. The spawn point is guaranteed open ocean. The globe is 200 units across
  the radius against a 5-unit hull, so a full circumnavigation at the ship's
  20-knot maximum takes just over a minute.
- **Land and water are separate meshes.** Land is an icosphere with every
  fully-submerged face removed and the rest displaced outward. Water is one
  smooth sphere beneath it. Coastal detail is computed per pixel from a shared
  height texture rather than from geometry.
- **Animated ocean** with drifting wave layers, sun glint, depth-graded colour
  and breaking surf along the coasts.
- **Lakes and inland seas.** Water is flood-filled from the spawn point at
  startup; anything the ship can never reach is shaded as still fresh water —
  green, glassy, a quarter of the sea's motion, and no surf.
- **Day and night.** The sun orbits once an hour on a slowly drifting tilt —
  thirty minutes of daylight and thirty of dark for a ship at anchor on the
  equator — sweeping a terminator across the globe. Under way it is not an
  hour: the sun is placed in world space and every surface works out day or
  night from where it actually is, so sailing east into the sunrise shortens
  your day and sailing west holds the sunset, the same way crossing time zones
  does. Light warms toward the horizon.
- **Settlements** light up on the night side, clustered along coasts and
  lowlands, and fade out through dawn.
- **Weather.** A cloud deck that forms and dissipates over time, covering about
  a quarter of the sky and crawling past at a tenth of the ship's top speed. It
  is a stack of slices through one 3D field rather than a painted sphere, so
  the banks have flat bases, domed tops and real thickness at the horizon. How
  tall a bank builds varies from place to place, between two thirds and all of
  the deck's depth.
- **Ship wake** that follows the curve of the planet and fades behind you.
- **The ship**: a glTF hull with planked topsides, brass rails, rigging and
  neon thruster pods, floated at its designed waterline.
- **Instruments.** A bow-up radar plots the coastline, open sea and lakes for
  100 units in every direction, drawn on the CPU from the same height field the
  world is built from. The compass sits in the middle of the helm pad.

## Structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module ownership, the
coordinate conventions, the pinned units, and the frame-loop contract. Read it
before changing anything that crosses a module boundary — and read **World
scale** before touching `GLOBE_RADIUS`, because half the constants in the
project are written relative to it and half are deliberately not.

## Build

```
npm run build     # type-check + production bundle into dist/
npm run preview   # serve the production build
```
