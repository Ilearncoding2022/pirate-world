# Pirate World

A fantasy techno-punk pirate ship navigation game on a procedurally generated 3D globe.

## Run it

```
npm install
npm run dev
```

Then open the URL Vite prints (http://localhost:5173 by default).

The first thing you see is a loading screen with a real progress bar behind
it: the world is raised, the hull is fetched — that stage reports actual
bytes — and one frame is rendered and thrown away to compile the shaders, so
the first frame you are handed does not stutter.

## Controls

| Input | Action |
|---|---|
| `W` / `↑` / on-screen ▲ | Thrust forward |
| `S` / `↓` / on-screen ▼ | Reverse |
| `A` / `←` / on-screen ◀ | Turn to port |
| `D` / `→` / on-screen ▶ | Turn to starboard |
| Mouse wheel | Zoom the follow camera |
| on-screen `[FISH]` | Open the fishing screen — start a session, or read the record |
| on-screen `[SHOP]` | Open the chandlery — only alongside a berth |
| `Space` / click / tap | Fire the harpoon, and tap to fight a big fish on the line |
| `Esc` | End a fishing session, or close any panel |

The ship cannot sail onto land. Running at a coastline stops the ship; turn away to get free.

## The world

Everything but the ship is generated at runtime, and the ship is not modelled
by hand either: `assets/pirateship_beginner.glb` is built by
`tools/build_ship.py` under headless Blender, from the concept art beside it.

- **Terrain.** Seeded 3D simplex noise with domain warping, so continents have
  irregular coastlines rather than blobby edges. A quarter of the sphere is
  land and three quarters is water. The spawn point is guaranteed open ocean.
  The globe is 200 units across the radius against a 3-unit hull, so a full
  circumnavigation at the ship's 10-knot maximum takes about two minutes.
- **No islands you cannot see.** Anything smaller than a disc 5.6 units across
  — a little under two ship lengths — is sunk before the world is handed over.
  The sea used to be full of specks a fraction of the hull wide, too small to
  see against the water and too small to steer around, and the ship stopped
  dead on every one of them. 160 of the world's 253 islands went; they were
  worth 0.6% of its land.
- **Land and water are separate meshes.** Land is an icosphere with every
  fully-submerged face removed and the rest displaced outward. Water is one
  smooth sphere beneath it. Coastal detail is computed per pixel from a shared
  height texture rather than from geometry, and so is the land's own shading:
  rock on the steep faces, wet sand at the waterline, and an occlusion and
  horizon bake that lets the hills shadow themselves as the sun moves.
- **Animated ocean** with drifting wave layers, sun glint, depth-graded colour
  and breaking surf along the coasts. Near the ship the surface is genuinely
  displaced rather than shaded to look that way, and the hull heaves, pitches
  and rolls on that same field, so the boat rides the water you can see. The
  sky, the harbour beacons and the ship's own neon show up in it. The sea runs with the weather: the wave
  layers drift the way the wind is blowing, and their height goes as the
  *square* of its speed, so a gale is four times the sea of half a gale and
  not twice it. A calm keeps a residue of both, because swell outlives the
  wind that raised it.
- **Lakes and inland seas.** Water is flood-filled from the spawn point at
  startup; anything the ship can never reach is shaded as still fresh water —
  green, glassy, a quarter of the sea's motion, and no surf.
- **Day and night.** The sun orbits every twenty minutes on a slowly drifting
  tilt — ten minutes of daylight and ten of dark for a ship at anchor on the
  equator — sweeping a terminator across the globe. Under way it is not twenty
  minutes: the sun is placed in world space and every surface works out day or
  night from where it actually is, so sailing east into the sunrise shortens
  your day and sailing west holds the sunset, the same way crossing time zones
  does. Light warms toward the horizon.
- **Settlements** light up on the night side, clustered along coasts and
  lowlands, and fade out through dawn.
- **Weather.** A cloud deck that forms and dissipates over time, covering about
  a quarter of the sky and crawling past at a fifth of the ship's top speed. It
  is a stack of slices through one 3D field rather than a painted sphere, so
  the banks have flat bases, domed tops and real thickness at the horizon. How
  tall a bank builds varies from place to place, between two thirds and all of
  the deck's depth.
- **Wind.** It never stops. Gusts blow up on a random bearing and hold for five
  to thirty seconds, and between them the wind falls away to a lull of a knot
  rather than to nothing — a lull that draws its own fresh bearing, so the
  weather comes round while it is quiet instead of only ever changing on the
  way up. There is no CALM on the panel any more, because there is no calm:
  the arrow always points at something. It is a real push, not a number: just
  over a third of the wind's speed is added to your own, so 8 knots of engine
  under a 10 knot tailwind makes 11.5 over the ground — and a beam wind carries
  you sideways off your course while the bow holds its heading. The open ocean
  blows twice as hard as the shoreline, building over the first 40 units
  offshore, so hugging the coast is shelter and standing out to sea is a
  gamble. A berth is still dead calm, and it is now the only place that is. It
  raises the sea as well as pushing the hull, so the water tells you what the
  weather is doing before the panel does. The weather is seeded, so the same
  world always blows the same way.
- **Rough water.** Every five seconds the sea rolls for trouble. A strong wave
  rises a fifth of the time, a great wave a tenth, and a maelstrom one time in
  fifty — four times the weather this shipped with, and the wait for a
  maelstrom is down from a thousand seconds of sailing to two hundred and
  fifty. **Waves run with the wind**, always, which is the whole reason to keep
  an eye on the arrow: they rise upwind of you and come down on the hull, so
  the wind tells you where to look and which way you will be thrown. A wave is
  a crest twenty units long travelling at 6 knots, steep on the face and long
  in the back: take it on the bow and it shoves you the way the water
  went — five knots for a strong one, ten for a great one, over the three or
  five seconds it breaks up against you, which is thirty units of the scope for
  the big one. You keep the helm the whole time; the crest is spent once it has
  hit you, and one that misses lives ten seconds and fades. A maelstrom is
  twenty units of funnel that opens over three seconds and stays for thirty. Go
  into it and the helm is not yours any more: the hull spirals in for six
  seconds, sinks, and the screen goes black. You come back stopped, somewhere
  else entirely, with a quarter of the power you had — the backup cell, the
  gold and the fish book are untouched. All of it is real water, displaced in
  the same sea the ship rides, so a wave lifts the hull and the funnel tips it
  bow-down. A berth is immune to all of it, and the scope marks both in magenta
  while there is still time to steer around them. The rolls are seeded, so the
  same world throws up the same weather.
- **Ship wake** that follows the curve of the planet and fades behind you. It
  is drawn into the water rather than laid on top of it, so it tilts the
  surface and raises its own foam, and the foam sits still in the sea instead
  of sliding along with the boat.
- **The ship**: a glTF hull with textured planking, brass rails, rigging and
  neon thruster pods, floated at its designed waterline. The Jolly Roger
  streams down the apparent wind and the mainsail fills when a following
  breeze outruns you, the lamps breathe out of step with each other, and the
  thrusters flare on the throttle.
- **Power, not fuel tanks.** The ship runs on a reserve that burns with the
  *square* of your speed, so half throttle costs a quarter as much and cruising
  slowly is a real strategy: 90 seconds flat out, or five and a half minutes
  at 5 knots.
  Stop in daylight and the panels charge you back at a rate that follows the
  sun's height in the sky: half a percent of the reserve per second with the
  sun overhead, which is three and a half minutes from empty, stretching past
  seven at a low sun and going negative after dark. Run dry and you keep the
  helm but lose the engines, drifting until the sun comes up.
- **Ports.** Every one of the world's 57 settlements is a port — a town that
  could not find water the ship can reach is never founded — so a settlement on
  the scope is always somewhere you can charge. Each has a lit ring on the
  water under a beacon mast. Stay inside the ring for two seconds and you are
  moored; drive through it and you are not, which is the whole rule. Shore
  power runs at two percent of the reserve a second, so fifty seconds alongside
  fills the tank from empty — four times the best the sun ever manages. Berths
  are plotted on the radar, so the scope is also the fuel map.
- **The chandlery.** Alongside a berth, `[SHOP]` sells the two things gold is
  for. A **backup cell** at 1000 gold holds half a tank and is only ever drawn
  on once the main reserve is flat — no berth and no sunrise will put it back,
  so it is a consumable wearing a battery's clothes. **Five spare harpoons** at
  500 gold go into a locker that holds a hundred; a session may reach ten of
  them, and only after its own ten are gone. Both survive a reload.
- **Fishing.** Anywhere on the globe, docked or not, day or night: press
  `[FISH]` and the world stops behind a cover screen with two ways in —
  START FISHING, and the FISHING RECORD.
  Start a session and The ship comes to a dead halt, the sea and the
  sky freeze behind a dimmed 9:16 card, and you get thirty seconds and ten
  harpoon shots at five rows of fish. The harpoon swings under the boat and
  fires straight along whatever angle it is at, so the whole game is timing.
  The deeper the row the better the odds, and the two rarest tiers *fight* —
  the line runs a tension bar the whole way in and you have to tap to keep it
  from snapping. Twenty species in five tiers, each worth gold, each recorded
  in a fish book that shows a silhouette and `UNKNOWN` until you have landed
  one. The shallow water is thick — row 1 keeps a dozen fish alive and row 2
  eight — and the top of the table is deliberately thin: a legendary is 2% of
  even the deepest row's spawns, an epic 9%. Gold and the book survive a reload.
  The session costs **half the reserve**, taken the moment it starts, and
  START FISHING is dead below that — though the record beside it never is,
  because a flat battery is exactly when you want to read it. The panels keep
  charging while you fish, at the elevation the sun was frozen at. There is no refund for quitting early.
- **Instruments.** A bow-up radar plots the coastline, open sea and lakes for
  50 units in every direction, drawn on the CPU from the same height field the
  world is built from. Under it, a dial shows where the ship stands in its own
  solar day: noon at the top, the lit arc the hours the sun is above the
  horizon. It is not a clock the ship carries. Run east and the marker visibly
  drives round it; run west and it stalls. N, E, S and W ride the scope's rim
  and turn with the bow, so reading `E` off the right-hand rim tells you east
  is to starboard; north keeps a blue arrow and a letter twice the size of its
  neighbours. Latitude, longitude and heading sit above the glass in three
  matching blocks; the
  wind rides the rim as a warm arrow, signed on its tail with the same gust
  glyph the speed readout uses, so the two marks are legibly one subject.
  Speeds are whole knots — the tenth only ever flickered, and every readout on
  the panel is spelled out: SPEED, WIND, POWER. The rose that used to sit in
  the middle of the helm pad is gone — at hub size its graduations fell below a
  pixel — and the scope's rim carries the direction instead. The purse rides
  the telemetry panel in brass, the one warm figure on a cold instrument.

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

## Test

```
npm test          # unit tier, ~2s — run this constantly
npm run test:all  # build + unit + browser tier, ~50s
npm run shots     # screenshots only, against a preview server you leave running
```

Read [docs/TESTING.md](docs/TESTING.md) before adding a test or running one in
a loop. It sets a budget — under five minutes of testing for a routine feature
build, in total across the job rather than per run — and explains which tier a
given check belongs in. No test here asserts on how anything looks; that is
what the screenshots are for.

There is a quality switch for slower machines: append `?quality=low` (or
`medium`, or `high`) to the URL. Backquote toggles a GPU/CPU timing overlay.
