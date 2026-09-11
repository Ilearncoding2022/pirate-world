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
| `Space` (inside a berth's ring) | Make fast, or cast off again. While made fast the helm is locked |
| `Space` (inside a derelict's ring) | Put the towline on a dead hull. A berth always wins the key: inside both rings, `Space` moors |
| `T` / on-screen `[CAST OFF]` | Drop the tow where it floats. The key only exists while something is on the line |
| on-screen `[FISH]` | Open the fishing screen — start a session, or read the record. On the helm pad, beside THRUST |
| on-screen `[SHOP]` | Open the chandlery — only once you are moored. Under the telemetry panel, because it is a berth's key rather than the ship's |
| on-screen `[WORK]` | Open the harbour's contract board — only once you are moored. Beside `[SHOP]`, on the same terms: it is the berth's key, not the ship's |
| on-screen `[ANCHOR]` | Deploy a Sea Anchor — kills the ship's way fast, then holds it a few seconds. On the helm pad, under REVERSE |
| on-screen `[COIL]` | Engage an Overdrive Coil — 20 seconds at 16 knots, burning fuel hard the whole time. On the helm pad, over THRUST |
| `Space` / click / tap | Fire the harpoon, and tap to fight a big fish on the line |
| `Space` | Loose a harpoon at a shoal, while the hunt's bar is lit. The bar lights only when the marked shadow is between two and four hull lengths ahead AND within 30 degrees of the bow, so holding a target is steering. Sail over it and the bar goes out |
| `Space` / on-screen `[FIRE]` | Fire a broadside, in a battle. Up to three a second, and the locker never runs out |
| `W` / `S` (in a battle) | Speed up or drop back on the circle. There is no helm in a fight |
| `Esc` | Open the menu — and the controls guide inside it. Also ends a fishing session or closes any panel; it will not get you out of a battle |

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
  wind that raised it. The water is drawn four knots livelier than it actually
  blows — the 1-knot lull looks like a 5-knot breeze, 2 looks like 6 — so the
  sea is never a plate of glass. Only the look of it is shifted: the readouts,
  the arrow, the push on the hull and the set of the sails are all the true
  wind. The trade is at the top, where the sea reaches its full height at
  about 6 knots and a harder blow does not raise it further.
- **Lakes and inland seas.** Water is flood-filled from the spawn point at
  startup; anything the ship can never reach is shaded as still fresh water —
  green, glassy, a quarter of the sea's motion, and no surf.
- **Day and night.** The sun orbits every twenty minutes, sweeping a terminator
  across the globe. Day and dark are not halves of it. The world is a 200-unit
  ball, so the horizon you can actually SEE sits about 25 degrees below eye
  level, and the sun is over the water for the whole climb from there to
  overhead and back: **thirteen minutes of light to seven of dark** for a ship
  at anchor on the equator. Under way it is neither, because the sun is placed
  in world space and every surface works out day or night from where it
  actually is, so sailing east into the sunrise shortens your day and sailing
  west holds the sunset, the same way crossing time zones does. Light warms
  toward the horizon. Every day is now the same length and the sun always rises
  due east — the seasonal tilt that made no two days alike is set to zero, since
  a year ran inside six game days and a latitude could gain four hours of
  daylight overnight.
  **The game opens on the frame the sun's disc touches the water**, dead ahead
  of the bow, because at the noon it used to start on the sun was overhead and
  behind you — the one moment at which none of the sky can be seen.
- **A sun and a moon you can actually see.** Both are up there now, and the
  sun's disc is the same size the sea has always reflected it at, so the road
  of glints on the water leads to the thing casting it. The moon keeps its own
  orbit rather than sitting opposite the sun: it circles slightly slower, so
  the sun laps it once every eight days, it rises later each night, and some
  nights it is up in daylight and others it is gone by dark. Its phase is the
  real angle between the two, so a full moon is one that rises as the sun sets
  — and moonlight follows the phase, which means a new moon, or a moon below
  the horizon, is a genuinely darker night than the one before it. The world
  opens on a moon 80% lit and 38 degrees up, setting astern as the sun rises
  ahead. It carries a **halo** now, a silvery yellow-white a tenth as bright as
  the sun's — enough to read as a light source rather than a painted disc, and
  far enough under the bloom line that it can never be mistaken for a second
  sun. The halo follows the phase, so a thin crescent wears a thin ring. And
  now there is an **aurora on the rim** as well: a narrow band of the same
  silvery yellow standing just off the moon's own edge, brighter in some arcs
  than others and drifting slowly around the limb, so the moon has a moving
  edge rather than a drawn one. It follows the phase too — a full moon wears a
  complete ring, a crescent wears one on its lit horn, and a new moon wears
  none at all.
- **A sky, from the deck.** Blue overhead and pale at the horizon by day, warm
  along the whole limb at dawn and dusk, and a thin navy veil at night that the
  stars and the moon still show through. Zoom out and it thins away, because at
  that end of the wheel you are looking at a planet in space and there should
  not be a sky in front of it. The sea fades into whatever colour the sky above
  it currently is, so the horizon has no seam at sunrise.
- **Settlements** light up on the night side, clustered along coasts and
  lowlands, and fade out through dawn. Every cluster of lights is one of the
  thirty-six harbours — the lone outposts that used to be sprinkled between
  them are gone, because a light you cannot tie up at is a light that lies.
- **Weather.** A cloud deck that forms and dissipates over time, covering about
  a quarter of the sky and crawling past at a fifth of the ship's top speed. It
  is a stack of slices through one 3D field rather than a painted sphere, so
  the banks have flat bases, domed tops and real thickness at the horizon. How
  tall a bank builds varies from place to place, between two thirds and all of
  the deck's depth.
- **Storms and fog.** The sky is weather now, not decoration. Squalls roll off
  the wind's own gusts, and on top of them whole regional cells — storms and
  fog banks — drift across the globe on their own courses, born outside your
  scope so weather always arrives from somewhere rather than switching on
  around you. The panel gains a `SKY` row that names what you are in, and the
  scope draws the cells as marks you can steer around.
  A fog bank is a thing in the air rather than a grey filter over the sea: it
  is drawn as a stack of slices standing on the water, so it drifts past the
  bow with real depth, closes over the deck, and leaves the hull a silhouette
  rather than a tinted boat. Sail into a thick one and the horizon is simply
  gone. Fog is **three times thicker** than it was at every strength, which
  mostly shows in the weak ones: a bank that used to be a smudge on the
  horizon is now a bank, and one seen from outside reads as a wall of air
  sitting on the water rather than as a hazy patch of it. The thickest fog is
  the whiteout it always was, and still leaves you a hull to steer by.
  A storm is a power problem before it is a view: it takes **95% of your
  panels** and a fog bank takes half, so a tank that fills in three and a half
  minutes under a clear noon barely moves under a black sky, and the power
  panel says so in as many words — `IDLE - OVERCAST` rather than the
  `IDLE - SOLAR CHARGING` it would be lying with. Neither can strand you: a
  squall is over in half a minute and a cell drifts past in about forty
  seconds even if you sit still, against a hotel load that takes forty-two
  minutes to empty a full tank. A berth charges at the same rate whatever the
  sky is doing, which is what makes one worth running for.
  Dirty weather also brings company. Rough water is rolled about a quarter
  more often in a full storm, and **wandering** orange raiders nearly three
  times as often — but a red one, the sort that comes for you, is never made
  likelier by the sky. A storm makes the sea busier, not more hostile.
  A fight is fought in the weather you are actually in, and it keeps changing
  while you fight: the sun moves, a storm darkens the water, rain falls on you
  mid-duel. The one thing held back is visibility — fog and heavy rain are
  capped for the length of a fight, because a white-out over a twenty-unit
  ring hides the boat you are shooting at. That is a harder fight to see, not
  a harder fight.
- **Rain, and a bolt to go with the flash.** A storm you can see from the
  deck. Rain begins at a tenth of a storm's depth rather than a quarter, so
  ordinary weather is wet instead of only greying the sky, and it comes in
  **waves** rather than at one strength: a storm eases to a fifth of its rain
  for a stretch, hardens back to full, and eases again, each spell lasting
  anywhere from a second to half the weather that carries it. It is not only
  the drops. A lull in the rain hands you back part of your scope and the
  `SKY` row may drop from `STORM` to `RAIN` while the sky above is as black as
  it was — so a downpour is something you can wait out a little as well as
  sail out of. The curtain itself is drawn heavier — streaks nearly twice as long at nearly twice the alpha, over
  **eight times the drops**. It is sized to the CAMERA rather than to the ship:
  its width comes off the frustum, so it reaches the edges of the frame at
  every zoom and on any shape of window rather than standing on the boat as a
  column with dry sea around it; its depth reaches past the lens, so the
  foreground is rained on too; and its ceiling climbs as the camera climbs, so
  the height drops start falling from is never a line drawn across the sky.
  Sides, far edge and ceiling all dissolve, so there is nowhere the rain
  visibly begins or ends. Pull back far enough and it hands off to the darkened
  cloud deck and the haze, which is what a storm looks like from above.
  Lightning finally has something to look at. A strike draws a forked bolt from
  the cloud base down to just above the water — thrown 12 to 34 units clear of
  the hull when the squall is your own, or standing in the cell that is doing
  the striking when it is not — and it rides the same double pulse the sky
  does, so the channel dims and re-lights with the hemisphere rather than on a
  clock of its own. Its shape comes off the strike's own seed, so the same
  weather draws the same bolt down to the fork.
- **The chart.** The scope remembers. Everywhere you have sailed is charted
  and stays charted between sessions, on a 1024×512 bitmap of the globe kept
  in its own storage slot beside your save. What you have not visited is
  blank. How far you chart is your **visibility**, not your radar range, so a
  coast passed in thick fog is not charted at all and has to be passed again
  in clear air — which is the one lasting price fog asks.
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
- **Rough water.** Every second the sea rolls for trouble — five separate
  chances at a wave and one at a maelstrom. **Up to five crests can be running
  at once**, and a single second can raise all five, so a squall does not
  build, it arrives. In fair weather the water carries about three and a half
  crests and is full about a fifth of the time; in a full storm it is four and
  a half and full most of the time. That is what a storm buys — not angrier
  water, fuller water. **Waves run with the wind**, always, which is the whole
  reason to keep an eye on the arrow: they rise upwind of you and come down on
  the hull, so the wind tells you where to look and which way you will be
  thrown.
  **No two waves are the same.** Each one rolls its own front, twelve to
  twenty-four units of it; its own width across your track, two to twelve —
  two is a slap you are through before you have finished heeling, twelve is
  four hull lengths taking two full seconds to pass under you; its own height;
  and its own speed, two knots to nearly eleven. That last one is the number to
  read, because **the shove is the speed**: a slow wave nudges you, and the
  fastest in the sea throws you nine knots the way the water went. The fastest
  is also quicker than your own ten knots flat out, so the top of the sea
  cannot simply be outrun — it has to be steered around. Waves also **grow
  while they live**, gaining length and height off their own age, so a front
  worth dodging ten seconds ago is worth dodging harder now. You keep the helm
  the whole time; the crest is spent once it has hit you.
  **A wave breaks on the shore rather than being deleted by it.** Run a
  twenty-unit front onto a headland and the arm over the rock does not vanish
  between frames: it retreats down the crest line at about a hull length and a
  half a second, and the end that is being eaten SAGS as it goes, coming down
  toward nothing while the middle of the front still stands. A wave driven
  entirely aground grinds itself out of existence inside a second. Land is
  cover, and a wave you put an island between yourself and is a wave that
  arrives half as wide.
  **A maelstrom** is twenty units of funnel and four deep — a real hole in the
  sea, with a near rim, a shaded inner wall and a far wall that catches the
  light. It opens over three seconds and stays for thirty. Go into it and the
  helm is not yours any more: the hull spirals in for six seconds, sinks, and
  the screen goes black. You come back stopped, somewhere else entirely, with a
  quarter of the power you had — the backup cell, the gold and the fish book
  are untouched. All of it is real water, displaced in the same sea the ship
  rides, so a wave lifts the hull and the funnel tips it bow-down. A berth is
  immune to all of it, and the scope marks both in magenta while there is still
  time to steer around them. The rolls are seeded, so the same world throws up
  the same weather.
- **Raiders.** You are not alone out here. Every ten seconds the sea rolls for
  a boat, and the two colours are an order of magnitude apart: **24% for an
  orange one and 3.2% for a red**. An orange boat is weather — it is out there
  most of the time and you sail around it. A red one comes for you and ends in
  a fight unless you turn it, so it is an event, at roughly one every five
  minutes rather than one a minute. Only one of each colour is ever on the
  water, which is the real brake on the orange sort: what its odds actually buy
  is that the next one is up almost as soon as the last one has gone. There are two kinds. A **red** one spawns forty to sixty units
  off on any bearing, runs half again your top speed — fifteen knots to your ten,
  the same pace as the orange sort — and comes straight for you, and it has five
  to eight seconds to get there. What makes it dangerous is that it is aimed,
  not that it is quick. It still turns wider than you do, so it can still be
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
  yours and close theirs. `Space` fires **up to three times a second and never
  runs out**, and the ball only hits if the other boat is on the line when it
  gets there — so the limit on a broadside is the aim, not the ammunition.
  **Three hits lose it.** The other captain is reading you **two seconds
  late**, and telegraphs every shot before it goes: a warm light on the hull
  and a bar on the strip, lit a second and a half before the ball leaves, so a
  shot you see coming is one you can already be moving out from under — one
  tap of the throttle in that window and it lands on water you have left.
  Their helm is not flawless either; one decision in four is a coin flip
  rather than a solved course, so watch it long enough and it visibly picks
  the wrong way. And the sea is not still under either of you — because it is
  the same sea. **The fight happens on the world's own water**, under the
  world's own sky, with the clock still running. There is no
  cut to somewhere else and no arena sea pretending to be this one. The waves
  that roll through the ring are the ocean's own, rolling on from wherever the
  wind raised them, and one that crosses your hull shoves you off your line
  exactly as it would outside — so a front you can see coming is a front worth
  steering for. A maelstrom is the one thing barred from opening inside the
  ring: a duel should be decided by the duel, not by the hull being swallowed
  mid-broadside.
  The ring itself is not drawn. It is still there — both boats are held to it
  and it still closes — but it is a constraint you feel rather than a circle
  painted on the sea. If the sea where you were caught is too tight for a
  fight, the ring slides to the nearest water that will hold one rather than
  laying a duelling circle across a headland — and inshore it usually is too
  tight, because a ring wants a clear disc twenty-eight units across and most
  bays are narrower than that. There is no limit on how far it slides. It will
  cross an ocean to find sea room, and when it goes further than a ring's own
  width the card tells you so before the guns start, because a fight that opens
  on strange water with nothing said about it reads as a bug rather than as a
  chase. You are put back exactly where you were rammed when it is over, so the
  only thing the distance costs you is the view. **Three to six rafts of flotsam drift through**, no two the same
  size or the same speed, and they are the only obstacle now: one will swallow
  a ball that crosses it, and fouls whatever hull runs into it — half speed and
  a dead gun for a couple of seconds. As one is sunk or carried out the far
  side another comes along, so the water is never empty for long. The other
  captain does not see any of it and does nothing about it; it is shoved,
  blocked and fouled exactly as you are.
  Win and you take gold from a tiered purse: five hundred most of the time,
  twenty thousand once in a very long while. Lose and the main tank goes to
  zero, the backup cell is stripped to a tenth of a tank if it held more than a
  fifth and emptied if it did not, and ten percent of your gold goes with the
  boarding party, floored at five hundred and capped at ten thousand. Fight to
  a stand-off and it costs twenty-five points of the tank and a coin-toss of a
  thousand gold either way. In all three you come back to the exact spot and
  heading you were rammed at, stopped, with the other boat gone and half a
  minute before anything else comes looking.
- **Salvage.** Dirty weather leaves things floating. Every ten seconds the sea
  rolls for a raft of debris, and the odds are the sky's: half a percent in
  clear air, and three percent more for each of rain, storm and fog you are
  actually in, up to nine and a half. That is a raft every half hour on a clear
  day and one every two minutes in the worst weather the globe has — a **19:1**
  gradient, which is the whole point of it. Three can be adrift at once, each
  drifting downwind at a fifth of the wind's speed, each afloat for two minutes
  before it sinks unclaimed.
  You take one by **sailing into it**. There is no key and no ring: the scope
  marks it in brass — the purse's own colour, and the only mark on the
  instrument you are meant to steer toward rather than around — and the timber
  is a dark pile on the water you have to pick out yourself. A raft pays
  **100 to 1000 gold**, and one in twenty also carries something off the
  chandlery's shelf: half of those a backup cell, the rest an even split of
  harpoons, a Sea Anchor, an Overdrive Coil, a Chum Drum or Barbed Heads. A
  locker with no room does not waste the find — the item is sold on for its own
  shop price instead, and the notice says so.
  At the ceiling that is about 310 gold a minute, which is under a fishing
  session's rate and well under a won battle: salvage is a side income for
  sailing through weather you were going to sail through anyway, not a career.
- **Derelicts, and the tow.** On the same ten-second clock and the same weather
  sum, at a tenth of the odds, the sea rolls for a **dead hull**: grey, unlit,
  drifting where it was found, one in the world at a time and never expiring.
  That is one every eighty minutes of fair-weather sailing and one every five
  and a half minutes of the foulest. It carries the faintest of rim lights —
  a tenth of a raider's — because an unlit hull on dark water is otherwise
  unfindable, and the scope marks it in steel grey.
  Come alongside and a ring offers itself the way a berth's does: **press
  `Space`** and the towline goes on. A berth always wins that key, which is
  also how a tow is settled. Under tow the ship makes **three quarters of its
  top speed** — 7.5 knots on a bare hull, 9.75 with Trim III, and a quarter off
  whatever a worn hull was already capped at — and **burns twice as fast**. The
  wind is untouched, so a gale can still carry a towing ship faster than its own
  engine could.
  Those two rules together cost **1.54x the fuel per unit of distance**, which
  is the reason the cut is a quarter rather than a half: the burn goes as the
  square of the speed, so halving it would have quartered the propulsion draw
  and handed the doubling straight back — 1.11x, a cost no player would ever see
  on the panel, for twice as long at the helm.
  Each hull names **one harbour**, 120 to 350 units off, never the nearest, and
  the job strip carries it with a bearing and a range while you sail. There is
  **no deadline**; the clock a tow runs against is the tank. Deliver it and the
  berth pays **1200 to 2500 gold on the distance towed, and 8 reputation**.
  Moor anywhere else and nothing happens — being in the wrong place is not a
  mistake, it is the voyage not being over. `T` or `[CAST OFF]` drops it where
  it floats, and the line parts for good if the tank reaches zero or a maelstrom
  takes the ship, which is what makes the power bill a real risk rather than an
  accounting entry.
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
  **The panel says which of those is happening.** It names the cause in as many
  words — `UNDER WAY - BURN`, `IDLE - SOLAR CHARGING`, `IDLE - MOONGLASS`,
  `IDLE - NO SUN`, `BERTH - MAKE FAST`, `BERTH - CHARGING`, `ON BACKUP CELL`,
  `OVERDRIVE - 4x BURN`, `TANK FULL` — and colours itself by how much trouble
  you are in, which is a different question. The one that matters most is the
  pair at the bottom: a dead ship reads `NO POWER - ADRIFT` in flashing red,
  and the moment the panels start putting charge back it turns amber and reads
  `NO THRUST - RESTARTING`. The helm comes back at three percent, a few seconds
  later. It used to say EMPTY for both, which read as a plant that had failed
  rather than one already coming back.
- **Harbours.** There are **thirty-six**, exactly, and each one is a single
  place: a town, its lights, its beacon and its berth, under **a name**.
  Nothing is anonymous any more. The name is over the harbour in the world, on
  the scope beside its mark, in the power panel while you are alongside, and
  at the head of the chandlery. Two of the thirty-six never move: **Marine
  Stronghold** stands on an islet at the North Pole and **No Man's Land** at
  the South, in every world there will ever be. The berth is at the town's own
  shoreline now rather than out in a cove, so the ring and the lights read as
  one harbour instead of two things near each other. Each has a lit ring on the
  water under a beacon mast. Cross into the ring and the berth offers itself at
  once — there is no waiting. Then **press `Space` to make fast**: arriving is
  not the same thing as docking, and the key press is the whole rule. A notice at the foot of the screen carries the offer and, once you
  have taken it, the fact that the helm is locked and `Space` is the way out.
  Being made fast is what connects shore power, opens `[SHOP]`, mends the hull
  and shelters the ship, and it holds the hull dead still: no helm, no
  throttle, and nothing the wind or the sea can do about it. Shore
  power runs at five percent of the reserve a second, so twenty seconds
  alongside fills the tank from empty — ten times the best the sun ever
  manages, and it mends the hull at the same rate for nothing. Berths
  are plotted on the radar, so the scope is also the fuel map.
- **A new sea every time you open it.** The world is drawn from a fresh seed
  on every load: new coastlines, new islands, thirty-six harbours in new
  places. What survives is your gold, your fish book, your stock, your hull —
  and **the harbours you have moored at**, remembered by name. A harbour you
  have used once is named and plotted on the scope from the first frame of
  every later world, wherever it has ended up, and `Esc` → HARBOURS lists all
  thirty-six with a bearing and a distance to the ones you know and UNCHARTED
  beside the ones you do not. The chart of explored water does not survive,
  because it charted a coastline that no longer exists. A world that cannot
  fit thirty-six harbours, or that opens on land, is thrown away and another
  is drawn before you ever see it.
- **The bars tell you they are moving.** The tank, the bought cell and the
  hull each blink their topmost lit notch once every three seconds while they
  are draining — and the hull blinks it **twice a second** when weather is
  eating it at double rate, so you can see a squall start costing you without
  reading a word. Charging runs a light up the lit notches instead, one every
  half second. Whole bars flashing still means an emergency and nothing else.
- **The hull wears out.** A second reserve beside the power one, on the same
  panel and on the same severity colours: cyan while it is sound, ageing
  through amber to red. Every bar on that panel now says the same thing with
  colour — cyan is fine, amber is a warning, red is an emergency — so a low
  tank no longer looks like a worn hull. It falls a quarter of a percent a minute, twice that in
  a storm, a squall or a fog bank — the panel says `x2` when it is happening.
  A fight costs 5% won or drawn and **15% lost**, and a maelstrom costs the
  same 15%. Below **50%** the ship will not make more than 10 knots whatever
  you have bought — Trim and the Overdrive Coil are both simply overridden —
  below **25%** it is 5 knots and the fishing screen will not open, and at the
  1% floor it is 1 knot. It never sinks you and there is no game over: the
  hull is a cost, not a threat. A fight is dearer than the speed, though —
  three broadsides lose a battle at a sound hull, **two** below 50% and
  **one** below 25%, and the card tells you which before the guns start.
  Any berth mends it free at two percent a second; the chandlery will sell you
  ten percent for 100 gold when there is no berth to be had.
- **Contracts, and a reputation.** Every harbour posts work, and `[WORK]`
  alongside a berth opens its board under the harbour's own name. A posting is
  a **cargo run to a named harbour against a deadline** or a **survey** of a
  share of the world, and it pays gold and reputation. The board is **three
  postings, redrawn once a world day** — twenty real minutes — so a harbour you
  pass twice in an afternoon is offering the same work both times, and coming
  back tomorrow is what changes it. Some runs add a condition the sphere makes
  real rather than a number: *arrive in daylight* is a race against the
  terminator, and the board tells you how long the destination's dawn has left.
  Take one and it goes to the **job strip** at the top of the HUD, which names
  the destination, its bearing and range, and counts the deadline down as you
  sail; a survey counts the share of the world you have actually charted.
  **Reputation** is one number, floored at -100 with no ceiling: settling a
  contract pays it, missing or abandoning one costs five. You can hold **three
  at once**, so a board is a choice rather than a shopping list. Contracts in
  hand survive a reload, and `Esc` → CONTRACTS reads the board's held list from
  anywhere, which is the one part of this that does not need a berth.
- **Notices.** A one-line strip across the top of the screen, under the job
  strip, says what just happened — a contract taken, settled or run out — for
  four seconds of *world* time, so a notice raised as you open a panel is still there when you close
  it. One at a time, and the fifth in a row is dropped rather than queued.
- **The chandlery.** Alongside a berth, `[SHOP]` opens a panel headed with the
  harbour's name, a REPAIR block, and two tabs — NAVIGATION
  and FISHING. **Not every harbour sells everything**: the consumables and the
  backup cell are on every counter, but which of the four upgrade ladders a
  harbour carries is its own, fixed the first time you tie up there and
  remembered with the name. A ladder it does not stock says so and names the
  harbours you already know that do. A **backup cell** at 1000 gold holds half a tank and is only ever
  drawn on once the main reserve is flat — no berth and no sunrise will put it
  back, so it is a consumable wearing a battery's clothes. The ship stows **two**
  of them, bought one at a time at the same price, so a full backup is a whole
  tank's worth for 2000 gold. There is no bulk discount and no partial refill:
  a cell bought at 90% wastes the overflow, which is what stops the cheapest way
  to stay full being a purchase every time a berth goes past. **Five spare
  harpoons** at 500 gold go into a locker that holds a hundred; a session may
  reach ten of them, and only after its own ten are gone.
  The NAVIGATION tab also sells a **Sea Anchor** (400 gold, stows 5) — a
  one-press brake that kills the ship's way in about a second and holds it a
  few seconds more, which is enough to make a red boat's pure pursuit overshoot;
  an **Overdrive Coil** (800 gold, stows 3) — 20 seconds at 16 knots for a flat,
  heavy fuel bill, so outrunning a raider costs the fuel to get home; **Trim &
  Sheathing** (three tiers, 2000/4000/8000 gold) — raises top speed from 10 to
  13 knots, still short of either raider's 15; and a **Moonglass Array** (three
  tiers, 3000/6000/12000 gold) — a slow trickle of charge at anchor overnight,
  scaled by how full the moon is. The FISHING tab adds a **Chum Drum** (600
  gold, stows 5) and **Barbed Heads** (700 gold, stows 5), both armed on the
  fishing cover screen rather than sold as an immediate effect — the drum
  biases one session's spawns to tier 3 and up, the heads cut tension drain on
  the two hardest fish by 30% — plus an **Arc-Lamp Rig** (three tiers,
  2000/4000/8000 gold) that stretches a session from 30 seconds to 48, and an
  **Efficiency Governor** (three tiers, 2500/5000/9000 gold) that cuts a
  session's own price from half a tank toward a quarter. Every stock and every
  tier survives a reload.
- **Fishing.** Anywhere on the globe, docked or not, day or night: press
  `[FISH]` and the world stops behind a cover screen with two ways in —
  START FISHING, and the FISHING RECORD. The screen knows where you are: tied
  up at a berth it wears the harbour, and out at sea it wears the open water.
  If you have bought a Chum Drum or a Barbed Heads bundle, two toggles above
  START FISHING let you arm one or both for the session about to begin — armed
  and unused is not lost, it resets to off next visit. Start a session and the
  ship comes to a dead halt, the sea and the sky freeze behind a dimmed 9:16
  card, and you get the session's own clock (thirty seconds, or more with an
  Arc-Lamp Rig) and ten harpoon shots at five rows of fish. The harpoon swings
  under the boat and fires straight along whatever angle it is at, so the whole
  game is timing. The deeper the row the better the odds, and the two rarest
  tiers *fight* — the line runs a tension bar the whole way in and you have to
  tap to keep it from snapping. Twenty species in five tiers, each worth gold,
  each recorded in a fish book that shows a silhouette and `UNKNOWN` until you
  have landed one. The shallow water is thick — row 1 keeps a dozen fish alive
  and row 2 eight — and the top of the table is deliberately thin: a legendary
  is 2% of even the deepest row's spawns, an epic 9%. Gold and the book survive
  a reload. The session costs **half the reserve** by default, less with an
  Efficiency Governor, taken the moment it starts, and START FISHING is dead
  below that — though the record beside it never is, because a flat battery is
  exactly when you want to read it. The panels keep charging while you fish, at
  the elevation the sun was frozen at. There is no refund for quitting early.
- **The leviathan hunt.** The one activity that does not stop the world. Sail
  open water and a shoal of shadows may resolve out of it, thirty to
  forty-five units off, inside the scope's range, so you see the marks before
  you see the water. They drift at four knots on one heading and turn, up to
  sixty degrees either way, every five to ten seconds. One shadow at a time
  wears a cyan ring, and a bar at the bottom of the screen lights **only** when
  that one is between two and four hull lengths ahead of you and within thirty
  degrees of the bow. Overshoot it and the bar goes out: a harpoon is thrown at
  water ahead of the ship, not at water under it. Nothing is paused: the wind still blows, the sun still crosses, raiders
  still close, and you are steering the whole time. That is the point of it:
  it is the only thing in this game played with the actual helm.
  When the bar lights, a needle sweeps it on a two-second sine, red through
  yellow to green and back, and `Space` looses a harpoon worth what the needle
  was on: 100 dead centre, nothing at either end. Five targets, banked, and
  the shoal pays ten gold a point. But a press worth under 10, the outer tenth
  of the bar at either end, is too feeble to hold the animal: it sounds, the
  hunt is over, and you keep only what you had banked. Five is a ceiling, not a
  promise. The last target is the one exception, since a hunt with four in the
  bank is finished whatever the fifth is worth.
  Harpoons come out of the **same locker the fishing card draws from**, one per
  press, five per hunt, which is exactly one bundle. A new captain starts with
  one bundle aboard, so the first hunt is free; after that an empty locker
  means the bar never lights, and the strip says so. A full hunt is 500 damage
  and 5,000 gold. A maelstrom, a fight, or simply sailing seventy units away all end a
  hunt the same way, paying what it had earned.
- **Instruments.** A bow-up radar plots the coastline, open sea and lakes for
  50 units in every direction, drawn on the CPU from the same height field the
  world is built from. Under it, a dial shows where the ship stands in its own
  solar day: noon at the top, the lit arc the stretch the sun is above the
  horizon. It is not a clock the ship carries, and it no longer pretends to be
  one: it reads `DAY 42%` — how far through the current phase you are — rather
  than an hour. An hour would have had to lie, because the visible day is
  longer than the dark, so a dial that called the sunrise six would have run
  its daylight hours at nearly twice the length of its night ones. Run east and
  the marker visibly drives round it; run west and it stalls. N, E, S and W
  ride the scope's rim and turn with the bow, so reading `E` off the right-hand rim tells you east
  is to starboard; north keeps a blue arrow and a letter twice the size of its
  neighbours. Heading, latitude and longitude stand in a column beside the
  glass, heading first and largest — it is the one number you steer by. The
  day/night dial sits under the plot and shares its left edge, with the wind and
  the sky beside it: that ring is what the sky is doing to the light, and those
  two are what it is doing to the water. The
  wind rides the rim as a warm arrow, signed on its tail with the same gust
  glyph the speed readout uses, so the two marks are legibly one subject.
  Speeds are whole knots — the tenth only ever flickered, and every readout on
  the panel is spelled out: SPEED, POWER, HULL. The telemetry panel keeps the
  ship's own instruments and the scope keeps the world's. The rose that used to sit in
  the middle of the helm pad is gone — at hub size its graduations fell below a
  pixel — and the scope's rim carries the direction instead. The purse rides
  the telemetry panel in brass, the one warm figure on a cold instrument.
  The controls guide is behind `Esc` now, as a page of the menu, rather than a
  half-size card pinned to a corner of the HUD — it was too small to read where
  it stood, and below 560 pixels of window height it was not drawn at all. The
  helm keys have the bottom-left corner to themselves: a corner is a thumb's reach on a phone
  without the hand leaving the edge, and it hands the middle of the bottom edge
  back to the water you are steering over. The pad is a T rather than a cross —
  THRUST alone above PORT, REVERSE and STARBOARD — with thrust and reverse
  close enough to rock a thumb between, because they are the two ends of one
  axis rather than two directions.

## Structure

See [docs/ROADMAP.md](docs/ROADMAP.md) for where the project stands, what the
last release changed, and what is worth building next — it is the handoff
document, and it names the check behind every claim in it.

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
