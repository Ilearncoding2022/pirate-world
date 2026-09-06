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
| on-screen `[FISH]` | Start a fishing session — costs half the reserve |
| on-screen `[FISH BOOK]` | Open the record of every species |
| `Space` / click / tap | Fire the harpoon, and tap to fight a big fish on the line |
| `Esc` | End a fishing session, or close the fish book |

The ship cannot sail onto land. Running at a coastline stops the ship; turn away to get free.

## The world

Everything but the ship is generated at runtime, and the ship is not modelled
by hand either: `assets/pirateship_beginner.glb` is built by
`tools/build_ship.py` under headless Blender, from the concept art beside it.

- **Terrain.** Seeded 3D simplex noise with domain warping, so continents have
  irregular coastlines rather than blobby edges. A quarter of the sphere is
  land and three quarters is water. The spawn point is guaranteed open ocean.
  The globe is 200 units across the radius against a 3-unit hull, so a full
  circumnavigation at the ship's 15-knot maximum takes about 84 seconds.
- **No islands you cannot see.** Anything smaller than a disc 5.6 units across
  — a little under two ship lengths — is sunk before the world is handed over.
  The sea used to be full of specks a fraction of the hull wide, too small to
  see against the water and too small to steer around, and the ship stopped
  dead on every one of them. 160 of the world's 253 islands went; they were
  worth 0.6% of its land.
- **Land and water are separate meshes.** Land is an icosphere with every
  fully-submerged face removed and the rest displaced outward. Water is one
  smooth sphere beneath it. Coastal detail is computed per pixel from a shared
  height texture rather than from geometry.
- **Animated ocean** with drifting wave layers, sun glint, depth-graded colour
  and breaking surf along the coasts. The sea runs with the weather: the wave
  layers drift the way the wind is blowing, and their height goes as the
  *square* of its speed, so a gale is four times the sea of half a gale and
  not twice it. A calm keeps a residue of both, because swell outlives the
  wind that raised it.
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
- **Wind.** Gusts blow up on a random bearing, hold for five to thirty seconds
  and drop away again, with calms between them. It is a real push, not a
  number: just over a third of the wind's speed is added to your own, so 8
  knots of engine under a 10 knot tailwind makes 11.5 over the ground — and a beam
  wind carries you sideways off your course while the bow holds its heading.
  The open ocean blows twice as hard as the shoreline, building over the first
  40 units offshore, so hugging the coast is shelter and standing out to sea is
  a gamble. A berth is dead calm. It raises the sea as well as pushing the
  hull, so the water tells you what the weather is doing before the panel does.
  The weather is seeded, so the same world always blows the same way.
- **Ship wake** that follows the curve of the planet and fades behind you.
- **The ship**: a glTF hull with textured planking, brass rails, rigging and
  neon thruster pods, floated at its designed waterline. The Jolly Roger
  streams down the apparent wind and the mainsail fills when a following
  breeze outruns you, the lamps breathe out of step with each other, and the
  thrusters flare on the throttle.
- **Power, not fuel tanks.** The ship runs on a reserve that burns with the
  *square* of your speed, so half throttle costs a quarter as much and cruising
  slowly is a real strategy: 90 seconds flat out, or ten and a half minutes at
  5 knots.
  Stop in daylight and the panels charge you back at a rate that follows the
  sun's height in the sky — nothing at night, three minutes from empty at
  noon, and better than six at a low sun. Run dry and you keep the helm but
  lose the engines, drifting until the sun comes up.
- **Ports.** Every one of the world's 57 settlements is a port — a town that
  could not find water the ship can reach is never founded — so a settlement on
  the scope is always somewhere you can charge. Each has a lit ring on the
  water under a beacon mast. Stay inside the ring for two seconds and you are
  moored; drive through it and you are not, which is the whole rule. Forty
  seconds alongside fills the tank from empty. Berths are plotted on the radar,
  so the scope is also the fuel map.
- **Fishing.** Anywhere on the globe, docked or not, day or night: press
  `[FISH]` and the world stops. The ship comes to a dead halt, the sea and the
  sky freeze behind a dimmed 9:16 card, and you get thirty seconds and ten
  harpoon shots at five rows of fish. The harpoon swings under the boat and
  fires straight along whatever angle it is at, so the whole game is timing.
  The deeper the row the better the odds, and the two rarest tiers *fight* —
  the line runs a tension bar the whole way in and you have to tap to keep it
  from snapping. Twenty species in five tiers, each worth gold, each recorded
  in a fish book that shows a silhouette and `UNKNOWN` until you have landed
  one. Gold and the book survive a reload.
  The session costs **half the reserve**, taken the moment it starts, and the
  button is dead below that — but the panels keep charging while you fish, at
  the elevation the sun was frozen at. There is no refund for quitting early.
- **Instruments.** A bow-up radar plots the coastline, open sea and lakes for
  100 units in every direction, drawn on the CPU from the same height field the
  world is built from. Latitude, longitude and heading sit above the glass; the
  wind rides the rim as a warm arrow, signed on its tail with the same gust
  glyph the speed readout uses, so the two marks are legibly one subject.
  Speeds are whole knots — the tenth only ever flickered. The compass sits in
  the middle of the helm pad, and the purse rides the telemetry panel in brass,
  the one warm figure on a cold instrument.

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
