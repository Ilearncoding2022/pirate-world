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

Everything is generated at runtime. There are no art assets in this repository.

- **Terrain.** Seeded 3D simplex noise with domain warping, so continents have
  irregular coastlines rather than blobby edges. About a third of the sphere is
  land. The spawn point is guaranteed open ocean.
- **Land and water are separate meshes.** Land is an icosphere with every
  fully-submerged face removed and the rest displaced outward. Water is one
  smooth sphere beneath it. Coastal detail is computed per pixel from a shared
  height texture rather than from geometry.
- **Animated ocean** with drifting wave layers, sun glint, depth-graded colour
  and breaking surf along the coasts.
- **Day and night.** The sun orbits once every four minutes on a slowly drifting
  tilt, sweeping a terminator across the globe. Light warms toward the horizon.
- **Settlements** light up on the night side, clustered along coasts and
  lowlands, and fade out through dawn.
- **Weather.** A drifting cloud layer that forms and dissipates over time.
- **Ship wake** that follows the curve of the planet and fades behind you.

## Structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module ownership, the
coordinate conventions, the pinned units, and the frame-loop contract. Read it
before changing anything that crosses a module boundary.

## Build

```
npm run build     # type-check + production bundle into dist/
npm run preview   # serve the production build
```
