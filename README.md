# Pirate World

A fantasy techno-punk pirate ship navigation game on a 3D globe. MVP.

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

## What's in the MVP

- Procedurally generated globe: noise-driven continents, shallow-water shelves, neon lat/long grid, atmospheric rim glow, starfield.
- Placeholder pirate ship built from primitives, with a follow camera that keeps the horizon curve in view.
- Heads-up display: compass with heading, speed, and latitude/longitude.

## Structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module ownership, the coordinate conventions, and the frame-loop contract.

## Build

```
npm run build     # type-check + production bundle into dist/
npm run preview   # serve the production build
```
