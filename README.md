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
| `Space` / on-screen `[FIRE]` | Fire a broadside, in a battle. One a second, ten rounds |
| `W` / `S` (in a battle) | Speed up or drop back on the circle. There is no helm in a fight |
| `Esc` | End a fishing session, or close any panel. It will not get you out of a battle |

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
- **Rough water.** Every second the sea rolls for trouble. A strong wave rises
  a fifth of the time, a great wave a tenth, and a maelstrom one time in fifty.
  Only one of each is ever on the water at once, so what a roll a second buys
  is that the next one is up almost as soon as the last one has gone: the sea
  is nearly always running something, and the wait for a maelstrom is under a
  minute. **Waves run with the wind**, always, which is the whole reason to keep
  an eye on the arrow: they rise upwind of you and come down on the hull, so
  the wind tells you where to look and which way you will be thrown. A wave is
  a crest twenty units long travelling at 6 knots, steep on the face and long
  in the back: take it on the bow and it shoves you the way the water
  went — five knots for a strong one, ten for a great one, over the three or
  five seconds it breaks up against you, which is thirty units of the scope for
  the big one. You keep the helm the whole time; the crest is spent once it has
  hit you, and one that misses lives ten seconds and fades. **A wave breaks on
  the shore the instant it reaches it** — and only the part of it that got
  there: run a twenty-unit front onto a headland and the arm over the rock is
  gone at once while the rest keeps coming, shortening as it goes, until there
  is nothing of it left. Land is cover, and a wave you put an island between
  yourself and is a wave that arrives half as wide. A maelstrom is
  twenty units of funnel that opens over three seconds and stays for thirty. Go
  into it and the helm is not yours any more: the hull spirals in for six
  seconds, sinks, and the screen goes black. You come back stopped, somewhere
  else entirely, with a quarter of the power you had — the backup cell, the
  gold and the fish book are untouched. All of it is real water, displaced in
  the same sea the ship rides, so a wave lifts the hull and the funnel tips it
  bow-down. A berth is immune to all of it, and the scope marks both in magenta
  while there is still time to steer around them. The rolls are seeded, so the
  same world throws up the same weather.
- **Raiders.** You are not alone out here, and not by a small margin. Every ten
  seconds the sea rolls for a boat — 16% for a red one and 24% for an orange —
  so meeting one is the normal condition of being at sea rather than an event.
  Only one of each colour is ever on the water, which is the real brake on it:
  what the odds actually buy is that the next one is up almost as soon as the
  last one has gone. There are two kinds. A **red** one spawns forty to sixty units
  off on any bearing, runs at twice your top speed and comes straight for you,
  and it has five to eight seconds to get there. It turns wide, so it can be
  shaken: put the helm hard over across its bow and it will overshoot, and when
  its clock runs out its light turns orange and it wanders off on a straight
  line like the other sort. An **orange** one never chases at all. It picks a
  track and runs it for five to eight seconds, and half the time that track is
  aimed somewhere near where you are going to be, so it is dangerous by
  coincidence rather than by intent. Both are plotted on the scope in their own
  colour while they are inside its range, and both are lit up in it: a Fresnel
  glow around the whole silhouette, so at sixty units you can see which one is
  coming before you can see what it is.
  Touch either hull, either way round, and there is a cannon fight. The world
  stops where it stands and a card comes up naming who rammed you, in their
  colour, with the rules of the fight in one sentence and three seconds on the
  clock to read them — a fight you can lose a tank and a tenth of your purse to
  is not a thing to be dropped into cold. Then the screen fades and the two
  boats come up circling on a ring of open ocean that closes in as it goes. You cannot steer. `W` and `S`
  speed you up and slow you down on the circle, and that is the whole helm,
  because the guns fire **straight out of the inboard beam**: the ring is what
  makes the firing windows, and pulling ahead or dropping back is how you open
  yours and close theirs. `Space` fires, one round a second, ten rounds, and
  the ball only hits if the other boat is on the line when it gets there.
  **Three hits lose it.** The other captain shoots the same way you do, with a
  reaction and a wobble, so their misses come out of the same geometry as
  yours and you can dodge a ball already in the air by changing speed.
  Win and you take gold from a tiered purse: five hundred most of the time,
  twenty thousand once in a very long while. Lose and the main tank goes to
  zero, the backup cell is stripped to a tenth of a tank if it held more than a
  fifth and emptied if it did not, and ten percent of your gold goes with the
  boarding party, floored at five hundred and capped at ten thousand. Fight to
  a stand-off and it costs twenty-five points of the tank and a coin-toss of a
  thousand gold either way. In all three you come back to the exact spot and
  heading you were rammed at, stopped, with the other boat gone and half a
  minute before anything else comes looking.
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
  START FISHING, and the FISHING RECORD. The screen knows where you are: tied
  up at a berth it wears the harbour, and out at sea it wears the open water.
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
  The CONTROLS card sits beside the telemetry panel, and the helm keys have the
  bottom-left corner to themselves: a corner is a thumb's reach on a phone
  without the hand leaving the edge, and it hands the middle of the bottom edge
  back to the water you are steering over. The pad is a T rather than a cross —
  THRUST alone above PORT, REVERSE and STARBOARD — with thrust and reverse
  close enough to rock a thumb between, because they are the two ends of one
  axis rather than two directions.

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
