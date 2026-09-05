# Pirate World — MVP architecture

Vite + Three.js + TypeScript. No external assets; everything is procedural.

## Conventions (see src/geo.ts)
- `GLOBE_RADIUS = 100`. Ship sits at `position * GLOBE_RADIUS` (plus a tiny float offset).
- +Y is the north pole. lon 0 = +Z, lon +90 = +X. Use `latLonToDir` / `dirToLatLon`.
- Heading: radians, 0 = north, clockwise positive (east = PI/2). Use `headingToForward`.
- Tangent frame at a point: `tangentFrame(up)` gives `north` and `east`.

## Module ownership and public API

| File | Exports | Depends on |
|---|---|---|
| `src/geo.ts` | `GLOBE_RADIUS`, `latLonToDir`, `dirToLatLon`, `tangentFrame`, `headingToForward`, `normalizeHeadingDeg` | three |
| `src/types.ts` | `InputState`, `Terrain`, `ShipState` interfaces | three (types only) |
| `src/terrain.ts` | `createTerrain(seed?: number): Terrain` | simplex-noise, geo |
| `src/globe.ts` | `createGlobe(terrain: Terrain): { group: THREE.Group; update(dt: number): void }` — group contains the globe mesh, grid lines, atmosphere, starfield, and all scene lights | terrain, geo |
| `src/ship.ts` | `createShip(terrain: Terrain, start?: { latDeg: number; lonDeg: number; headingDeg?: number }): { object: THREE.Object3D; state: ShipState; update(dt: number, input: InputState): void }` | types, geo |
| `src/camera.ts` | `createFollowCamera(aspect: number): { camera: THREE.PerspectiveCamera; update(dt: number, ship: ShipState, input: InputState): void; resize(aspect: number): void }` | types, geo |
| `src/controls.ts` | `createControls(): { input: InputState; endFrame(): void; dispose(): void }` — binds keyboard, wheel, and the on-screen buttons | types |
| `src/hud.ts` | `createHud(): { update(ship: ShipState): void }` | types |
| `index.html`, `src/style.css` | `#app` canvas host, `#btn-up #btn-down #btn-left #btn-right`, `#hud-heading #hud-compass-needle #hud-speed #hud-lat #hud-lon` | — |
| `src/main.ts` | bootstraps everything, runs the loop: `controls -> ship.update -> camera.update -> globe.update -> hud.update -> render -> controls.endFrame()` | all |

## Frame loop contract
- `dt` is seconds, clamped to <= 0.1.
- `ship.update` must check `terrain.isLand` at the proposed next position and refuse to move onto land (speed drops to 0).
- `camera.update` consumes `input.zoomDelta`; `controls.endFrame()` resets it afterward.

## TypeScript constraints (tsconfig)
- `verbatimModuleSyntax`: use `import type { X }` for type-only imports.
- `erasableSyntaxOnly`: no `enum`, no constructor parameter properties, no namespaces.
- `noUnusedLocals` / `noUnusedParameters` are errors.
