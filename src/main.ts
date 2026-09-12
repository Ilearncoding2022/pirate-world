import * as THREE from 'three';
import './style.css';
import { SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import { buildWorldMeshes } from './globe';
import { createShip } from './ship';
import { createWake } from './wake';
import { createWaterWakePlugin } from './waterwake';
import { createFollowCamera } from './camera';
import { createControls } from './controls';
import { createHud } from './hud';
import { createRadar } from './radar';
import { createTimeDial } from './timedial';
import { createEnv } from './env';
import { DAY_LENGTH, elapsedAtLocalTime } from './daynight';
import { createEnergy } from './energy';
import { createWind } from './wind';
import { createWeatherCells } from './weathercells';
import { createWeather } from './weather';
import type { WeatherPin } from './weather';
import { createRain } from './rain';
import { createLightning } from './lightning';
import { createChart } from './chart';
import { createDocks } from './docks';
import { createPostFx } from './postfx';
import { createRecords, loadChart, writeChart } from './save';
import { createFishing } from './fishing';
import { createFishBook } from './fishbook';
import { createFishCover } from './fishcover';
import { createShop } from './shop';
import { createLoading } from './loading';
import { createQuality } from './quality';
import { WORLD_ATTEMPTS, generateWorld } from './worldgen';
import { createReflection } from './reflection';
import { createWaterReflectPlugin } from './waterreflect';
import { createHazards, CREST_SPEED_REF } from './hazards';
import { createWaterHazardPlugin } from './waterhazard';
import { createBlackout } from './blackout';
import { createAiBoats } from './aiboats';
import { createAiHulls } from './aihulls';
import { createSalvage } from './salvage';
import { createDerelicts, HOOK_RADIUS, TOW_SPEED_SHARE } from './derelict';
import { createDerelictHull } from './derelicthull';
import { createSalvageRafts } from './salvagerafts';
import { ITEM_LABEL, TOW_REPUTATION, rollSalvage, towGold } from './salvagebounty';
import type { SalvageItem } from './salvagebounty';
import { createLeviathan, HUNT_TARGETS, SOUND_BELOW, damageAt } from './leviathan';
import { createShadowField } from './leviathanshadows';
import { createHuntDial } from './leviathandial';
// The hunt's phase 2 views. Every one of these is a stub in Step 0 and is
// filled in by its owning stream; the wiring below is final either way.
import { createLeviathanWaterPlugin } from './leviathanwater';
import { createHuntFx } from './huntfx';
import { createHuntReticle } from './huntreticle';
import { createHuntTells } from './hunttells';
import { createHuntPointer } from './huntpointer';
import { createHuntNumbers } from './huntnumbers';
import { createScreenFx } from './screenfx';
import { createAudio } from './audio';
import { createHuntAudio } from './huntaudio';
import { createBattleScene } from './battlescene';
import { createBattleSim } from './battle';
import { CALM, LIVE, ROUGH, SWAY_MAX, SWAY_MIN } from './battlesea';
import { createBattleUi } from './battleui';
import { createBattleCover } from './battlecover';
import { createMenu, formatBearing, formatDistance } from './menu';
import { createQuests, daylightLeft, formatSpan } from './quests';
import { createQuestCover } from './questcover';
import { createToast } from './toast';
import { QUEST_URGENT_BELOW } from './hud';
import type { TowLineInput } from './hud';
import { solarPhase } from './solartime';
import { lossGold, rollDrawGold, rollWinGold } from './bounty';
import { mulberry32 } from './towns';
import type {
  AiBoat,
  AiBoatKind,
  HuntCue,
  ActiveQuest,
  BattleOutcome,
  HazardKind,
  HuntEvent,
  PropulsionState,
  QuestOffer,
  ShipState,
  Hazard,
  WeatherState,
} from './types';
import type { QuestLineInput } from './hud';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { findRingCentre, RING_CLEARANCE, RING_DRIVEN_OFF } from './battlering';
import { HARBOUR_NAMES } from './harbournames';
import { OVERDRIVE_MAX_FORWARD } from './overdrive';

/*
 * `?probe=wave` and `?probe=hazard` are the only entry points into
 * `dev/probe.ts`, and this is the one guarded line that reaches either. The
 * import is dynamic and inside this branch specifically so a normal load
 * never fetches the probe module at all -- Vite code-splits it into its own
 * chunk, which an ordinary player's session never requests. Nothing else in
 * `main.ts` or `index.html` may reference a probe; the integration agent
 * greps for exactly that.
 *
 * `runProbe()` takes no argument: it reads the query itself and dispatches on
 * it, so the two harnesses -- the wave field's parity proof and the hazard
 * field's -- are one module with one entry point rather than two branches
 * spelled out here.
 */
const probeQuery = new URLSearchParams(window.location.search).get('probe');
if (probeQuery === 'wave' || probeQuery === 'hazard') {
  // The splash ships visible in the markup, so the probe -- which draws its
  // own canvas and has no world to build -- has to take it down itself.
  document.getElementById('loading')?.remove();
  void import('./dev/probe').then((probe) => probe.runProbe());
} else {
  void startGame();
}

/*
 * The bootstrap, in stages, behind the loading screen.
 *
 * It is `async` for one reason and it is not concurrency: building the world
 * is heavy SYNCHRONOUS work, and synchronous work does not let the browser
 * paint. Written straight through, the progress bar would jump from 0 to 100
 * on the frame everything finished and never once be seen. Every
 * `loading.step` below therefore waits for a paint and is called BEFORE the
 * stage it names -- the bar is a promise of what is about to happen, not a
 * report of what just did.
 *
 * The fractions are rough weights of wall-clock cost, measured by watching the
 * thing boot rather than derived: the globe and the 5 MB hull are most of it
 * and everything else is trimming. Only the hull reports real progress; see
 * `createShip`'s `onHullProgress`.
 */
/**
 * How deep the weather has to be before it doubles the hull's wear.
 *
 * Lives here rather than in `hull.ts` because it is a statement about
 * `WeatherState`, and `hull.ts` is handed the answer rather than the sky. Half
 * of any ONE envelope -- storm, rain or fog -- and never a sum of them: three
 * multiplying envelopes would put a ship at 8x in the one condition it already
 * cannot see out of. One threshold, one factor, and the panel says `x2`.
 */
const HULL_WEATHER_THRESHOLD = 0.5;

/* Scratch for `bearingTo`, module-scope so the menu's 36 rows allocate nothing. */
const _bearingNorth = new THREE.Vector3();
const _bearingEast = new THREE.Vector3();

/**
 * Great-circle bearing from the ship to `target`, radians, 0 = north and
 * clockwise positive -- `ShipState.heading`'s convention exactly.
 *
 * The frame is raised at the SHIP, not at the target, because a bearing is a
 * statement about which way to point the bow from here. It is the same
 * `atan2(east, north)` `ship.ts` and `wind.ts` already use to read a heading
 * off a vector, and it is derived on demand rather than stored for the reason
 * docs/ARCHITECTURE.md gives: an angle in a tangent frame is degenerate at the
 * poles, and two of the 36 harbours are AT the poles.
 */
function bearingTo(ship: ShipState, target: THREE.Vector3): number {
  tangentFrame(ship.position, _bearingNorth, _bearingEast);
  return Math.atan2(target.dot(_bearingEast), target.dot(_bearingNorth));
}

/**
 * What a fight and a funnel cost the hull, in whole percent.
 *
 * Five for a win or a draw and fifteen for a loss, and the maelstrom takes the
 * loss's figure. Against a free repair at any berth these are cheap; against a
 * quarter of a percent a minute of ordinary wear, one lost fight is an hour of
 * sailing. That is the intended shape -- the clock is what makes a harbour
 * worth calling at eventually, and a fight is what makes one worth running for
 * now.
 *
 * A draw pays the win's price rather than splitting the difference: a fight
 * that ended level still had three broadsides in it, and a third number here
 * would be a distinction no player could feel.
 */
const HULL_BATTLE_WIN = 5;
const HULL_BATTLE_LOSS = 15;
const HULL_MAELSTROM = HULL_BATTLE_LOSS;

async function startGame(): Promise<void> {
  const loading = createLoading();

  const host = document.getElementById('app');
  if (!host) throw new Error('#app host element not found in index.html');

  await loading.step(0.05, 'WAKING THE NAV CORE');

  // Resolved once, before anything below reads a row of its table -- see
  // quality.ts. `?quality=` beats a stored choice beats the 'high' default.
  const quality = createQuality();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x05080f, 1);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  await loading.step(0.12, 'SEEDING THE OCEAN');

  const env = createEnv();

  /*
   * `?clock=<hour>` -- start the world at a fixed local hour on the spawn
   * meridian instead of at daybreak. `?clock=13.5` is half past one in the
   * afternoon; out-of-range and unparseable values are ignored.
   *
   * The hour here is the GEOMETRIC one -- 0 is local midnight, 12 the sun at
   * its highest -- and it is deliberately the last hour left in the project.
   * The dial stopped reading hours because they could not be made to agree
   * with the horizon a player can see (`solartime.ts`), but pinning the sun
   * for a screenshot wants a uniform angle and nothing else, so this stayed.
   * Do not read a phase off it: at the equator `?clock=5` is already
   * daylight, because the disc clears the sea around 04:13 on this scale
   * and is not gone again until about 19:47.
   *
   * For looking at shading, not for playing. A day lasts DAY_LENGTH = 1200
   * seconds, so the sun moves a degree every three and a bit seconds and two
   * screenshots taken a minute apart are lit differently enough that a real
   * change to the water or the land cannot be told from the hour having
   * moved. `docs/TESTING.md` records the query pinned for the terrain, wave
   * and maelstrom work (`docs/TEXTURE_PLAN.md`).
   *
   * Read through URLSearchParams and never through `import.meta.env.MODE`, on
   * exactly the same terms as `?quality=` and `?hazard=`: `vite preview`
   * serves a genuine production build and this is meant to be used against
   * one. An ordinary player's session sets no query, so this never fires.
   */
  const clockQuery = new URLSearchParams(window.location.search).get('clock');
  if (clockQuery !== null) {
    const hour = Number(clockQuery);
    if (Number.isFinite(hour) && hour >= 0 && hour < 24) {
      env.elapsed = elapsedAtLocalTime(hour / 24);
    }
  }


  // The two things that add themselves to the water shader. Both are built
  // here rather than inside `globe.ts` because both need something that module
  // never sees: the wake plugin needs the ribbon it samples, and the
  // reflection cube needs the renderer and the top-level scene. Both must
  // exist before `createGlobe`, because a plugin can only be woven in while
  // the water shader is being assembled -- registering one afterwards would
  // mean recompiling it.
  //
  // `createReflection` returns a null texture on the low quality tier, and the
  // plugin list simply stays shorter: reflections are absent, never idle.
  const wake = createWake(quality.wakeMapSize);
  const reflection = createReflection(quality);

  // The third of them, and the one built with nothing in it. `hazards.ts`
  // needs `globe.heightMap`, `globe.waterBodies` and `globe.towns`, which do
  // not exist until `createGlobe` has run -- and a plugin cannot be registered
  // after that call. So the plugin is constructed empty here, woven into the
  // shader below, and handed the state it reads with `bind` once the sim
  // exists. Unbound it simply writes `uHazCount = 0` and the sea is the sea.
  const waterHazard = createWaterHazardPlugin();

  /*
   * The fourth, on exactly the same footing and for exactly the same reason:
   * `leviathan.ts` needs the three world maps that only exist after
   * `createGlobe`, and a plugin cannot be registered after that call. So this
   * is built empty here and handed the live hunt with `bind` once the sim
   * exists. Unbound it writes a count of zero and the sea is the sea.
   *
   * Registered on every tier, not just the two that use it: a plugin that came
   * and went with the quality row would change the water shader's source
   * between tiers, and `wave-parity.spec.ts` exists to prove that it does not.
   * The SPRITE tier is switched off at `createShadowField` instead, which is
   * where the choice can be made without recompiling anything.
   */
  const leviathanWater = createLeviathanWaterPlugin();

  const waterPlugins = [createWaterWakePlugin(wake), waterHazard, leviathanWater];
  if (reflection.texture) waterPlugins.push(createWaterReflectPlugin(reflection.texture));

  /*
   * The long synchronous stage, and now a LOOP around it.
   *
   * `generateWorld` rasterises a height map, culls the islets, floods the sea
   * and places the harbours, then measures the result; a world that fails is
   * thrown away and another seed is drawn. All of it is on the main thread and
   * nothing paints from here until it returns, which is why the bar was moved
   * and painted first -- and why `onAttempt` awaits a repaint before each try,
   * so a rejection is something the player watches happen rather than a freeze.
   *
   * The land MESH is deliberately outside the loop. It is the expensive half --
   * two million vertices on the high tier -- and a rejected world must never
   * pay for one. That is the whole reason `globe.ts` is split in two; see
   * docs/HARBOURS_PLAN.md, Trap 1.
   *
   * `?seed=` pins the world for the tests and the screenshot stations, and a
   * pinned seed that fails THROWS rather than quietly falling back, so a
   * fixture that has stopped being buildable is loud. That throw is caught
   * here: a player who pastes someone else's bad seed gets the ordinary random
   * world and a console warning, not a boot that stops at the splash.
   */
  const seedQuery = new URLSearchParams(window.location.search).get('seed');
  const seedHint = seedQuery !== null && /^\d+$/.test(seedQuery) ? Number(seedQuery) >>> 0 : null;

  await loading.step(0.20, 'CHARTING A NEW SEA');

  async function announce(n: number, seed: number): Promise<void> {
    // A tenth of the bar spread over the attempt budget, so a world that takes
    // three goes visibly creeps rather than sitting still. The label carries
    // the attempt number only after the first, because "(1)" on a world that
    // passes first time -- which is every world measured so far -- would
    // advertise a retry that never happened.
    const fraction = 0.20 + Math.min(n - 1, WORLD_ATTEMPTS) * (0.08 / WORLD_ATTEMPTS);
    void seed;
    await loading.step(fraction, n === 1 ? 'CHARTING A NEW SEA' : `CHARTING A NEW SEA (${n})`);
  }

  let world;
  try {
    world = await generateWorld(seedHint, quality, announce);
  } catch (error) {
    if (seedHint === null) throw error;
    console.warn(`main.ts: ${String(error)}; drawing a world at random instead.`);
    world = await generateWorld(null, quality, announce);
  }
  const { terrain, data: worldData, seed: worldSeed } = world;

  await loading.step(0.30, 'RAISING THE LAND');

  const globe = buildWorldMeshes(worldData, terrain, quality, waterPlugins);
  scene.add(globe.group);
  scene.add(wake.object);

  // Everything the player keeps across reloads, in one call. `createRecords` is
  // the single entry point for persistence precisely so that no caller can wire
  // half of it and end up with a wallet that saves and a fish book that does not.
  //
  // It comes before the power plant, because the plant is built around the
  // backup cell and the cell's charge is one of the things that survives a
  // reload -- and now before the SHIP as well, because the hull's durability
  // caps the ship's top speed and is loaded from the same file. It reads
  // nothing but `localStorage`, so it is free to sit this early.
  const records = createRecords();

  /*
   * `?hull=<1..100>` -- start with a worn hull, for the screenshot stations.
   *
   * Through `override` rather than `damage`, which is the whole reason that
   * method exists: `damage` notifies, and a notify writes the save, so a dev
   * query would permanently scuttle a real player's file the one time they
   * pasted it. This sets the number and tells nobody. Read through
   * URLSearchParams on exactly the terms `?quality=`, `?clock=` and `?hazard=`
   * are read on -- `vite preview` serves a genuine production build and this is
   * meant to be pointed at one.
   */
  const hullQuery = new URLSearchParams(window.location.search).get('hull');
  if (hullQuery !== null) {
    const percent = Number(hullQuery);
    if (Number.isFinite(percent) && percent >= 1 && percent <= 100) {
      records.hull.override(percent);
    }
  }

  await loading.step(0.5, 'LAUNCHING THE HULL');

  /*
   * The hull's own band of the bar, 0.56 to 0.88.
   *
   * The fetch starts inside `createShip` and runs while the stages below
   * build the rest of the game, so these readings arrive interleaved with
   * them. `loading.set` rather than `step` for that reason: this is not a
   * stage boundary and must not stop to wait for a paint.
   */
  const HULL_FROM = 0.56;
  const HULL_TO = 0.88;
  /*
   * `?spawn=<lat>,<lon>` -- start the ship somewhere other than the spawn.
   *
   * A dev query on exactly the terms `?quality=`, `?clock=` and `?hazard=` are
   * read on, and it exists because two of the 36 harbours are AT THE POLES and
   * there is otherwise no way to look at either without sailing 312 units to
   * get there. It is also the only way to photograph a harbour's name label,
   * whose fade is 140 units and whose nearest instance to the spawn is 95.
   *
   * No validation beyond the range and a comma: an unreachable spot is a
   * beached ship, which is a thing the game already handles and a thing the
   * person who typed the query can see for themselves.
   */
  const spawnQuery = new URLSearchParams(window.location.search).get('spawn');
  let spawnLat = SPAWN_LAT_DEG;
  let spawnLon = SPAWN_LON_DEG;
  if (spawnQuery !== null) {
    const [rawLat, rawLon] = spawnQuery.split(',');
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90) {
      spawnLat = lat;
      spawnLon = lon;
    }
  }

  const ship = createShip(
    terrain,
    {
      latDeg: spawnLat,
      lonDeg: spawnLon,
      headingDeg: 90,
    },
    renderer.capabilities.getMaxAnisotropy(),
    (fraction) => loading.set(HULL_FROM + (HULL_TO - HULL_FROM) * fraction),
    records.hull,
  );
  scene.add(ship.object);

  // Power plant. Built from the world's berths and the bought backup cell,
  // read by the ship (thrust gate), the HUD, the model's neon and the dock
  // rings.
  const energy = createEnergy(globe.towns, records.battery);

  // Weather. Reads the same height field the radar plots, so the sheltered water
  // on the scope is the sheltered water the ship finds.
  const wind = createWind(terrain, globe.heightMap);

  /*
   * The weather, in its two halves.
   *
   * `weathercells.ts` is the drifting population -- storms and fog banks with
   * a place, a size and a bearing, which the player can see coming and sail
   * around. `weather.ts` rolls squalls off the wind's own phases and combines
   * the two into the one `WeatherState` everything downstream reads.
   *
   * Both are built here, after the globe, because the cells probe the same
   * height field the wind and the scope do -- so a fog bank refused for being
   * over land is refused against the coastline the ship actually collides
   * with.
   *
   * `?weather=` pins the envelopes and switches the squall roll off, for
   * `npm run shots` and for the owner's eye. Cells keep running under a pin,
   * so `?weather=storm&cell=fog` is a bank seen from inside a storm. Read
   * through URLSearchParams on the same terms as `?quality=` and `?hazard=`.
   */
  const weatherCells = createWeatherCells(terrain, globe.heightMap);
  const weatherQuery = new URLSearchParams(window.location.search).get('weather');
  const WEATHER_PINS = ['clear', 'overcast', 'rain', 'storm', 'lightning', 'fog'];
  const weatherPin: WeatherPin | null = WEATHER_PINS.includes(weatherQuery ?? '')
    ? (weatherQuery as WeatherPin)
    : null;
  const weather = createWeather(undefined, weatherPin);

  /*
   * The chart: what the ship has seen, and therefore what the scope may draw.
   *
   * Loaded from its OWN storage key rather than from `SaveData` -- see
   * `save.ts`'s comment on `CHART_KEY` for why the two cadences cannot share
   * a file -- and persisted on its own throttle rather than on the records'
   * subscription, for the same reason. `pagehide` catches the last few
   * seconds a throttle would otherwise lose.
   */
  // The seed is `DEFAULT_SEED` only until `worldgen.ts` lands and the world is
  // drawn at random -- integration replaces this with the seed that world was
  // actually built from. It is passed rather than defaulted because a chart is
  // now keyed on its world; see `chart.ts` on why version 2 has a header.
  /*
   * The chart is keyed to the world it charted. A saved bitmap whose seed is
   * not this one is discarded and the scope starts blank, which is correct
   * rather than a loss: it recorded a coastline that no longer exists.
   */
  const chart = createChart(worldSeed, loadChart());
  chart.onChange(() => writeChart(chart.encode()));
  window.addEventListener('pagehide', () => writeChart(chart.encode()));

  /* ------------------------------------------------------------------ */
  /* Contracts                                                          */
  /* ------------------------------------------------------------------ */

  /*
   * The contract sim, built HERE and not in `createRecords`.
   *
   * It is the one record that needs the world: a delivery is resolved against
   * `globe.towns` by name, and a chart goal reads the bitmap created two lines
   * up. Neither exists when the save file is read, which is why `save.ts` hands
   * out the seed and the loaded contracts and takes the sim back through
   * `attachQuests` rather than owning it.
   *
   * Both dependencies are callbacks even though both values already exist at
   * this point. That is deliberate: `quests.ts` is the module every later phase
   * of this feature grows inside, and a callback is what keeps it honest about
   * the one fact that does not change here -- the world is redrawn on every
   * load and a harbour is a name, never a position.
   */
  const quests = createQuests({
    towns: () => globe.towns,
    chart: () => chart,
    known: records.known,
    wallet: records.wallet,
    reputation: records.reputation,
    seed: records.questSeed,
    saved: records.questsSaved,
  });
  // The save file's half of the deal. From here on every settlement writes.
  records.attachQuests(quests);

  /*
   * The notification strip, and the one line of wiring that makes contracts
   * audible at all.
   *
   * Without it a settled contract is a silent number change in a panel nobody
   * was looking at -- `docs/ROADMAP.md` makes the notification layer a
   * prerequisite for this feature for exactly that reason, and this is it.
   *
   * The severities are the three the strip has: `good` for money in,
   * `bad` for standing lost, `info` for everything that merely moved. A
   * completion names the purse because that is the number the player wants and
   * the GOLD row will not announce itself.
   */
  const toast = createToast();
  quests.on((event) => {
    switch (event.kind) {
      case 'accepted':
        toast.push(`CONTRACT TAKEN - ${event.quest.brief}`, 'info');
        break;
      case 'completed':
        toast.push(
          `CONTRACT PAID - ${event.gold} g, +${event.reputation} REP`,
          'good',
        );
        break;
      case 'failed':
        // The word, not the verdict: both cost the same, and telling a player
        // who just pressed ABANDON that they failed would read as the game
        // mislabelling their own choice. See `QuestEvent.reason`.
        toast.push(
          `CONTRACT ${event.reason === 'abandoned' ? 'ABANDONED' : 'LOST'} - -${event.reputation} REP`,
          'bad',
        );
        break;
      case 'progress':
        toast.push(`CHARTED ${Math.floor(event.fraction * 100)}%`, 'info');
        break;
    }
  });

  /**
   * Where a harbour is from here, or null if this world has no such place.
   *
   * The HARBOURS page's own two lines, factored out because the contract line,
   * the CONTRACTS page and the board all need the same answer and three copies
   * of a great-circle solve is three chances for one of them to disagree about
   * where Ionport is.
   *
   * Null rather than a zero fix for an absent harbour: contracts survive a
   * world being redrawn by NAME, so a target that does not exist in this world
   * is an ordinary reading and the views print UNCHARTED for it.
   */
  function harbourFix(name: string): { bearing: number; distance: number } | null {
    const town = globe.towns.byName(name);
    if (town === null) return null;
    return {
      bearing: bearingTo(ship.state, town.dir),
      distance: Math.acos(Math.min(1, ship.state.position.dot(town.dir))) * GLOBE_RADIUS,
    };
  }

  /**
   * What the sun is doing over an offer's target, as one line for its card.
   *
   * The single thing `questcover.ts` cannot work out for itself, and the reason
   * the day/night half of this design is legible at the moment of DECIDING
   * rather than only on arrival. Empty for an offer with no window, because a
   * line about the sky on a contract that does not care about the sky would
   * teach the player to stop reading it.
   *
   * Both branches are answered from `solartime.ts`, which is the same geometry
   * the day dial draws and the water shader crossfades on, so the card, the
   * dial and the sea cannot develop three opinions about whether it is night at
   * Ionport.
   */
  function skyNote(offer: QuestOffer): string {
    if (offer.window === 'ANY' || offer.target === null) return '';
    const town = globe.towns.byName(offer.target);
    if (town === null) return 'THAT HARBOUR IS NOT IN THIS SEA';
    const phase = solarPhase(town.dir, env.sunDirection);
    const wantDay = offer.window === 'DAYLIGHT';

    if (phase.polar) {
      // Above about 63 degrees the sun either never sets or never rises, so
      // there is no countdown to give -- only a fact.
      return phase.isDay === wantDay
        ? `${wantDay ? 'ENDLESS DAY' : 'ENDLESS NIGHT'} THERE`
        : `${wantDay ? 'POLAR NIGHT' : 'MIDNIGHT SUN'} THERE - THE WINDOW NEVER OPENS`;
    }

    const dayLeft = daylightLeft(town.dir, env.sunDirection);
    if (phase.isDay === wantDay) {
      // The window is open. What matters is how long it stays open, because
      // that is what the passage has to beat.
      const left = wantDay ? dayLeft : (1 - phase.progress) * (1 - phase.dayFraction) * DAY_LENGTH;
      return `${wantDay ? 'DAYLIGHT' : 'DARK'} THERE FOR ${formatSpan(left)}`;
    }
    // Shut. What matters is the wait, because the ship can be under way for it.
    const until = wantDay
      ? (1 - phase.progress) * (1 - phase.dayFraction) * DAY_LENGTH
      : dayLeft;
    return `${wantDay ? 'DAWN' : 'DUSK'} THERE IN ${formatSpan(until)}`;
  }

  /**
   * The one contract the HUD line carries, assembled for `hud.updateQuest`.
   *
   * Three can be in hand and only one fits on a line read while steering, so
   * this picks: the shortest clock first, and a goal with no clock only when
   * nothing is ticking. That ordering is the whole rule, and it is the right
   * one because a chart goal cannot be lost and a deadline can.
   */
  /**
   * The tow, as the job strip reads it, or null when nothing is on the line.
   *
   * `harbourFix` is the contract line's own helper, so the two lines cannot
   * develop two opinions of where a harbour is or how far off it lies.
   */
  function towLine(): TowLineInput | null {
    const live = derelicts.state.live;
    if (live === null || !live.towed) return null;
    const fix = harbourFix(live.bound);
    return { bound: live.bound, bearing: fix?.bearing ?? null, distance: fix?.distance ?? 0 };
  }

  function urgentQuest(): QuestLineInput | null {
    let pick: ActiveQuest | null = null;
    for (const quest of quests.active) {
      if (pick === null) {
        pick = quest;
        continue;
      }
      if (quest.remaining === null) continue;
      if (pick.remaining === null || quest.remaining < pick.remaining) pick = quest;
    }
    if (pick === null) return null;

    const berth = globe.towns.dockAt(ship.state.position)?.town ?? null;
    const town = pick.target === null ? null : globe.towns.byName(pick.target);
    const fix = pick.target === null ? null : harbourFix(pick.target);
    return {
      quest: pick,
      bearing: fix?.bearing ?? null,
      distance: fix?.distance ?? 0,
      // Asked at the TARGET's own direction, which is `solartime.ts`'s whole
      // point: a window is about the sky over the destination and never about
      // the sky over the ship.
      phaseOk:
        town === null ||
        pick.window === 'ANY' ||
        (pick.window === 'DAYLIGHT') === solarPhase(town.dir, env.sunDirection).isDay,
      atTarget:
        energy.state.mode === 'docked' && berth !== null && berth.name === pick.target,
      coverage: chart.coverage(),
    };
  }

  /*
   * Rough water: the strong waves that shove the hull and the maelstroms that
   * eat it. Built here because it needs the world -- the height field it
   * spawns over, the reachable-water mask that keeps a crest out of a lake,
   * and the berths it refuses to rise inside -- and all three arrive with
   * `createGlobe`.
   *
   * `onSunk` is declared below and hoisted into here. It is the one callback
   * in this file that rearranges the world rather than reporting on it, which
   * is why it is written out as a named function instead of inline.
   */
  const hazards = createHazards({
    terrain,
    heightMap: globe.heightMap,
    waterBodies: globe.waterBodies,
    towns: globe.towns,
    onSunk,
  });
  // The plugin's uniforms now have something to copy from. Everything the
  // shader draws of a hazard comes through this one call.
  waterHazard.bind(hazards.state);

  /*
   * The raiders. Built from the same four things `hazards.ts` is, and for the
   * same reasons: the height field they spawn over, the reachable-water mask
   * that keeps one out of a lake, and the berths they are not allowed to rise
   * inside.
   *
   * `onContact` is declared below and hoisted into here, exactly as `onSunk`
   * is above it. It is the other callback in this file that rearranges the
   * world rather than reporting on it, and it reaches every one of the battle
   * modules built further down; nothing calls it until the frame loop runs, by
   * which time all of them exist.
   */
  const aiBoats = createAiBoats({
    terrain,
    heightMap: globe.heightMap,
    waterBodies: globe.waterBodies,
    towns: globe.towns,
    onContact,
  });

  /*
   * The leviathan hunt: the sim, and nothing else yet.
   *
   * Built beside `aiBoats` because it is the same KIND of thing -- a seeded
   * roll that puts something on the water near the player and carries it by
   * parallel transport -- and `leviathan.ts` is cut from that module for
   * exactly that reason. The two views it drives are built further down, with
   * the rest of the scene and the rest of the HUD.
   *
   * It is handed the harpoon locker whole. That is the shared one, the same
   * store the fishing card draws its spares from: one press is one harpoon and
   * a hunt may take five, which is exactly one `HARPOON_BUNDLE`. A player who
   * spends a bundle on a hunt has spent it, and the choice at the chandlery is
   * the point rather than an oversight (docs/LEVIATHAN_PLAN.md, decision 5).
   *
   * `onHuntEvent` is declared below and hoisted into here, as `onContact` is
   * above it: it moves gold and raises notices, and neither the wallet nor the
   * strip is `leviathan.ts`'s business to know about.
   */
  const leviathan = createLeviathan({
    terrain,
    heightMap: globe.heightMap,
    waterBodies: globe.waterBodies,
    towns: globe.towns,
    harpoons: records.harpoons,
    onEvent: (event) => onHuntEvent(event),
    onCue: (cue) => onHuntCue(cue),
  });
  // The plugin's uniforms now have something to copy from, exactly as
  // `waterHazard.bind` above. `night` is read through a closure rather than
  // passed once, because it changes every frame and the plugin must not hold
  // a stale copy of a sky.
  leviathanWater.bind(leviathan.state, () => 1 - env.dayFactor);

  /**
   * One cue, handed to everyone who draws or sounds it.
   *
   * The whole fan-out, and the reason `HuntCue` exists as a second callback
   * rather than as four more fields on `HuntEvent`: six consumers read this
   * and none of them may ever be in a position to pay gold. `wallet.add` keeps
   * its three activities, and "where did that gold come from" stays
   * answerable by grep.
   *
   * Six calls and no registry. A registry would be a sixth thing to keep in
   * step for no gain at this size, and the order here is not significant —
   * every consumer reads the cue and none of them writes it.
   */
  function onHuntCue(cue: HuntCue): void {
    huntFx.cue(cue, ship.state);
    huntTells.cue(cue);
    screenFx.cue(cue);
    huntNumbers.cue(cue, view.camera, leviathan.state.streak);
    huntAudio.cue(cue);
    // The reticle takes only the one cue it has a use for. It reads `gate`
    // every frame for its colour, so an `armed` pulse is the single thing it
    // cannot get from the state alone.
    if (cue.kind === 'armed') huntReticle.pulse();
  }

  /**
   * What a hunt just did, in gold and in words.
   *
   * The ONLY place a hunt's gold moves, which keeps "where did that gold come
   * from" answerable by grep: `fishing.ts` pays a catch, the battle bounty is
   * paid at `onContinue`, and this pays a shoal. Three callers of
   * `wallet.add`, three activities, and no fourth.
   *
   * A `hit` is deliberately silent on the strip. Five notices in twenty
   * seconds would push everything else off it, and the dial is already showing
   * the damage as it lands -- the strip is for what a player would otherwise
   * miss, which is the purse and the reason the shoal left.
   */
  function onHuntEvent(event: HuntEvent): void {
    if (event.kind === 'hit') return;

    if (event.kind === 'dry') {
      // Said once per shoal, and only when an empty locker is the single
      // thing standing between the player and an armed dial. It names the
      // chandlery because a player who has never bought a bundle has no other
      // way to learn that this is what the bundle is for.
      toast.push('NO HARPOONS. BUY A BUNDLE AT ANY BERTH', 'bad');
      return;
    }

    if (event.gold > 0) records.wallet.add(event.gold);

    if (event.kind === 'settled') {
      toast.push(`SHOAL WORKED OUT  ${event.damage} DMG  +${event.gold} GOLD`, 'good');
      return;
    }
    /*
     * `sounded` is every other ending, and the `reason` is the only thing that
     * separates them. They cost exactly the same, so this is a WORD rather
     * than a rule -- `quests.ts` carries `expired` against `abandoned` for the
     * identical reason.
     *
     * A `pinprick` is the player's own doing and the animal's answer to it, so
     * it gets the animal's name and says what happened. Everything else is
     * passive -- a coast, a maelstrom, a fight, or simply sailing away -- and
     * gets the plain line, because telling a player who deliberately steered
     * off that the leviathan tired of them would be the game mislabelling
     * their own choice.
     *
     * A hunt that banked NOTHING and was merely lost says nothing at all. A
     * shoal drifting out of range without ever being fired at is one the
     * player never engaged, and the strip is for what they would otherwise
     * miss rather than for narrating the sea. A pinprick always speaks: they
     * pressed, and they are owed the reason it ended.
     */
    if (event.reason === 'pinprick') {
      const purse = event.gold > 0 ? `  +${event.gold} GOLD` : '';
      toast.push(`THE LEVIATHAN TIRED OF YOUR PINPRICKS AND SOUNDED${purse}`, 'bad');
      return;
    }
    if (event.gold > 0) toast.push(`SHOAL SCATTERED  +${event.gold} GOLD`, 'info');
  }

  /*
   * The salvage, built from the same four things the raiders and the hazards
   * are, and suppressed by the same verdict. It sits here rather than with the
   * scene modules because it is a SIM: `salvagerafts.ts`, built further down, is
   * what puts timber where this says.
   *
   * `onTake` is the whole of what a raft is worth, and it is wired straight
   * into the stores rather than raised as an event, because every one of them
   * already exists by now and nothing else in the game needs to know.
   */
  /**
   * The stream a raft's contents come off.
   *
   * Seeded and fixed, so a given world pays the same salvage twice -- the
   * argument `wind.ts` makes for WIND_SEED and `salvage.ts` for its own. It is
   * deliberately NOT `salvage.ts`'s stream: what floats and what is aboard are
   * two questions, and sharing one stream would make the contents of a raft
   * depend on how many rafts had been rolled before it.
   *
   * `bounty.ts` is handed `Math.random` for a battle purse instead, and the
   * difference is honest: a fight is an event the player walked into, and its
   * tiered purse is meant to be a gamble. A raft is part of the world.
   */
  const salvageHaulRng = mulberry32(0x5a1f60);

  /**
   * Whether a found consumable has anywhere to go.
   *
   * One place, so the grant below and the roll that decides what floated cannot
   * develop two opinions of a full locker -- which would silently drop the find.
   */
  function salvageRoom(item: SalvageItem): boolean {
    switch (item) {
      case 'cell':
        return !records.battery.isFull;
      case 'harpoons':
        return records.harpoons.canBuy;
      case 'anchor':
        return records.seaAnchor.canBuy;
      case 'overdrive':
        return records.overdrive.canBuy;
      case 'chum':
        return records.chumDrum.canBuy;
      case 'barbed':
        return records.barbedHeads.canBuy;
    }
  }

  /** Stows one found consumable. The mirror of `salvageRoom`, in the same order. */
  function salvageStow(item: SalvageItem): void {
    switch (item) {
      case 'cell':
        records.battery.charge();
        break;
      case 'harpoons':
        records.harpoons.buy();
        break;
      case 'anchor':
        records.seaAnchor.buy();
        break;
      case 'overdrive':
        records.overdrive.buy();
        break;
      case 'chum':
        records.chumDrum.buy();
        break;
      case 'barbed':
        records.barbedHeads.buy();
        break;
    }
  }

  /**
   * How many rafts have been taken this session.
   *
   * Published on the debug hook and read by nothing else. A headless look can
   * see a raft appear on its own, but "the payout fired" is not visible in a
   * screenshot -- and a notice strip that has already timed out is not evidence
   * either.
   */
  let salvageTaken = 0;

  const salvage = createSalvage({
    terrain,
    heightMap: globe.heightMap,
    waterBodies: globe.waterBodies,
    towns: globe.towns,
    onTake: () => {
      salvageTaken++;
      const haul = rollSalvage(salvageHaulRng, salvageRoom);
      records.wallet.add(haul.gold);
      if (haul.item !== null) salvageStow(haul.item);
      // Three shapes, and the third is the reason `soldOn` exists: a player
      // whose lockers are full is told their cell was sold on rather than
      // being handed a number with no story attached to it.
      const gold = `SALVAGE RECOVERED - ${haul.gold} g`;
      if (haul.item !== null) toast.push(`${gold} AND ${ITEM_LABEL[haul.item]}`, 'good');
      else if (haul.soldOn !== null) {
        toast.push(`${gold} - ${ITEM_LABEL[haul.soldOn]} SOLD ON, NO ROOM`, 'good');
      } else toast.push(gold, 'good');
    },
  });

  /*
   * The derelict, on the salvage's own four dependencies and its own rarer roll.
   *
   * It raises no callback at all, unlike every other sim in this file: a
   * derelict is hooked, released, lost and settled by acts this file already
   * knows about -- a key press, an empty tank, a maelstrom, a mooring -- so the
   * traffic runs the other way. See `derelict.ts`'s header.
   */
  const derelicts = createDerelicts({
    terrain,
    heightMap: globe.heightMap,
    waterBodies: globe.waterBodies,
    towns: globe.towns,
  });

  /** How many tows have been delivered this session. The debug hook's, and nothing else's. */
  let towsSettled = 0;

  /**
   * The tow is gone, for the one reason the caller names.
   *
   * Both callers are places that were already taking something away from the
   * player -- `energy.wreck()` inside a maelstrom, and the tank reaching zero --
   * so the notice is `bad` and says which, because a hull silently vanishing
   * from astern is the one thing here a player could read as a bug.
   */
  function loseTow(reason: 'power' | 'maelstrom'): void {
    const lost = derelicts.lose();
    if (lost === null) return;
    toast.push(
      reason === 'power'
        ? `THE TOWLINE PARTS - NO POWER - ${lost.bound.toUpperCase()} LOST`
        : `THE TOWLINE PARTS - ${lost.bound.toUpperCase()} LOST`,
      'bad',
    );
  }

  // The sheet a wreck happens behind. It owns nothing but its own element and
  // the promise that `onBlack` runs when the screen is actually opaque.
  const blackout = createBlackout();

  /**
   * A maelstrom has finished eating the hull.
   *
   * Fired once, from `hazards.ts`, on the frame the ship vanishes. The order
   * inside the fade is the whole point of the fade: the tank is docked
   * immediately, because the HUD is behind the black sheet and a bar that
   * halves itself in front of the player would read as a second, separate
   * event -- and everything that MOVES the ship happens inside `onBlack`, at
   * the one instant in the game the world may be rearranged unseen.
   *
   * `view.snap` is not optional. The chase camera damps at a rate, not over a
   * distance, so a hull teleported across the planet would be chased across it
   * for a second -- under a fade that is by then already lifting.
   *
   * `hazards.reset()` comes last: it is what clears the funnel and the `sunk`
   * phase, and running it before `place` would hand `ship.ts` a null drive
   * while the hull was still at the bottom of a hole.
   */
  function onSunk(): void {
    // The same fifteen points a lost fight costs, and deliberately the same:
    // going down a funnel and losing a battle are the two ways the sea takes a
    // real bite out of the boat, and a player should not have to learn two
    // numbers for it.
    records.hull.damage(HULL_MAELSTROM);
    energy.wreck();
    // Before the fade rather than inside it, with the tank and the hull: a hull
    // being carried to the far side of the world on the end of a line is not a
    // thing to draw, and the notice belongs with the two other costs of going
    // down a funnel rather than arriving on its own after the screen comes back.
    loseTow('maelstrom');
    blackout.run(() => {
      // The heading is cosmetic -- the ship is stopped and the player will
      // turn it before doing anything else -- so it is the one number here
      // that does not come off the sim's own seeded stream.
      ship.place(hazards.pickRespawn(), Math.random() * Math.PI * 2);
      view.snap(ship.state);
      hazards.reset();
    });
  }

  const docks = createDocks(globe.towns);
  scene.add(docks.object);

  const view = createFollowCamera(window.innerWidth / window.innerHeight);
  const controls = createControls();

  // The hull is still coming down the wire. Waited on here rather than left to
  // land mid-game so the first frame the player sees has a ship in it: the
  // stand-in was only ever cover for a load that nothing was hiding.
  //
  // It resolves either way -- `loadHull` catches its own failure and keeps the
  // stand-in -- so a missing model delays the boot by a request and no more.
  await loading.step(HULL_FROM, 'HOISTING THE RIGGING');
  await ship.ready;

  await loading.step(0.90, 'LIGHTING THE INSTRUMENTS');

  /*
   * Rain, at the ship.
   *
   * `quality.rainDrops` is 0 on the low tier, where the module is ABSENT
   * rather than idle -- the same convention `reflection.ts` follows for its
   * cube. A low-tier storm is a dark sky, a dimmed key light and thick haze,
   * which is most of a storm and none of the per-frame cost.
   */
  const rain = quality.rainDrops > 0 ? createRain(quality.rainDrops) : null;
  if (rain) scene.add(rain.object);

  /*
   * The bolt, on every tier including the one with no rain.
   *
   * Deliberately not gated on `quality.rainDrops`: a strike is under two
   * hundred vertices for a third of a second, so there is no tier at which
   * cutting it buys a frame, and a low-tier storm that flashes with nothing
   * to see in it is the weakest storm the game has.
   */
  const lightning = createLightning();
  scene.add(lightning.object);

  const hud = createHud(records.wallet, records.seaAnchor, records.overdrive, records.hull, globe.towns);
  const radar = createRadar(
    globe.heightMap,
    globe.waterBodies,
    terrain.seaLevel,
    globe.towns,
    records.known.names,
    records.hull,
  );
  const timeDialCanvas = document.getElementById('hud-timedial');
  const timeDial =
    timeDialCanvas instanceof HTMLCanvasElement ? createTimeDial(timeDialCanvas) : null;
  const postFx = createPostFx(renderer, quality);

  /* ------------------------------------------------------------------ */
  /* The battle                                                          */
  /* ------------------------------------------------------------------ */

  /*
   * The four pieces of a cannon fight: the hulls on the water, the arena they
   * are fought in, the ruleset, and the overlay it is fought through.
   *
   * `aiHulls` comes after `ship.ready` because it clones the loaded glTF; the
   * clone shares geometry with the player's hull and owns its own materials,
   * so the recolour and the rim patch can never reach the original. See **AI
   * boats and the battle** in docs/ARCHITECTURE.md.
   *
   * Both are handed `postFx` for its `adopt` and nothing else. Every stock
   * material either of them builds is built after the composer's first scene
   * walk, so without it the arena's cannonballs and a raider's recoloured neon
   * render unencoded and a stop too dark; this is the same call `main.ts`
   * already makes for the player's own hull. The two modules install their
   * shader patches BEFORE adopting, which is the ordering **Post-processing**
   * in docs/ARCHITECTURE.md exists to protect.
   */
  const aiHulls = createAiHulls(scene, () => ship.cloneHull(), postFx);
  // Beside the raider hulls and for the same reason: scene objects only, placed
  // from a sim that has already decided where everything is.
  const salvageRafts = createSalvageRafts(scene, postFx);
  const derelictHull = createDerelictHull(scene, () => ship.cloneHull(), postFx);

  /*
   * The shoal as things you can see, and the bar it is hunted through.
   *
   * `shadowField` is built here rather than beside the sim for `aiHulls`'s
   * reason: it needs `scene` and `postFx`, and both are the world's rather
   * than the hunt's. It builds two materials of its own after the composer's
   * one-time scene walk, so it takes the same `adopt` a raider's recoloured
   * neon does and for the identical reason.
   *
   * `huntDial` binds Space, and binds it LIVE: the key does something only
   * while `leviathan.state.armed` is true, which that module holds false while
   * docked, while suppressed and while the marked shadow is outside the bow's
   * arc. That is the same discipline **One owner for the Escape key** below
   * keeps -- the key belongs to whatever is currently showing the affordance
   * for it.
   *
   * It is not quite enough on its own, and `fireHarpoon` below is the rest of
   * it. Read that comment before touching either.
   */
  const shadowField = createShadowField(scene, postFx, quality.huntShadows);
  const huntDial = createHuntDial({ onFire: () => fireHarpoon() });

  /*
   * The hunt's six views. None of them knows another exists: the sim emits a
   * cue, `onHuntCue` above hands it to each in turn, and every one of these
   * draws or sounds what it is told and decides nothing.
   *
   * This is the `aiboats.ts`-to-`aihulls.ts` split the codebase already has,
   * extended to six consumers instead of one, and it is what keeps the whole
   * of the hunt testable under node with no DOM and no `three` scene.
   */
  const huntFx = createHuntFx(scene, postFx);
  const huntReticle = createHuntReticle(scene, postFx);
  const huntTells = createHuntTells(scene, postFx);
  const huntPointer = createHuntPointer();
  const huntNumbers = createHuntNumbers();
  const screenFx = createScreenFx(view);
  const audio = createAudio();
  const huntAudio = createHuntAudio(audio);

  /*
   * The unlock gesture.
   *
   * Browsers hand back an `AudioContext` stuck in `suspended` until a user
   * gesture has happened, and one created eagerly never recovers. So the
   * context is built lazily and this is what tells it a gesture occurred. Both
   * events, because a player may reach the game with either, and `once` on
   * each because after the first one there is nothing left to unlock.
   *
   * Deliberately NOT inside `controls.ts`: that module owns what the keys
   * MEAN, and this cares only that one was pressed.
   */
  const unlockAudio = (): void => audio.unlock();
  window.addEventListener('keydown', unlockAudio, { once: true });
  window.addEventListener('pointerdown', unlockAudio, { once: true });

  /*
   * The mute row. Reflects the persisted flag on load and writes it on change,
   * so the setting survives a reload — which is the whole reason a mute is
   * part of this deliverable rather than a follow-up.
   */
  const muteToggle = document.getElementById('menu-mute') as HTMLInputElement | null;
  if (muteToggle !== null) {
    muteToggle.checked = audio.muted;
    muteToggle.addEventListener('change', () => {
      audio.muted = muteToggle.checked;
      // Unmuting IS a gesture, so it is also a chance to start the context for
      // a player who muted before ever pressing a key.
      if (!audio.muted) audio.unlock();
    });
  }

  /**
   * A Space press from the hunt's bar, guarded.
   *
   * `leviathandial.ts` refuses unless its own `armed` flag is set, and that
   * flag is only ever written from the SAILING branch. Which is exactly the
   * hole: an overlay freezes the world without clearing it, so the bar goes on
   * showing the dial it was showing and a Space aimed at the fishing card
   * would otherwise reach `leviathan.fire()` too, spending a harpoon against a
   * frozen needle.
   *
   * So the guard lives here, where `main.ts` already owns the knowledge of who
   * has the screen, and it is the moor key's list exactly. The alternative --
   * ticking the dial inside the frozen branch to clear the flag -- would put a
   * sixth call in the pause contract's five to fix a bug that belongs to the
   * caller.
   */
  function fireHarpoon(): void {
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen) return;
    if (questCover.isOpen || menu.isOpen) return;
    if (battleUi.isOpen || battleCover.isOpen) return;
    if (hazards.state.phase !== 'free') return;
    leviathan.fire();
  }
  const battleScene = createBattleScene(quality, postFx);
  const battleUi = createBattleUi({ onContinue });
  /*
   * The beat between the ram and the arena.
   *
   * Built after `battleUi` and used before it: a contact opens THIS, and the
   * fight proper is opened by its `onReady` three seconds later. That ordering
   * is what keeps a Space pressed during the count from being spent on the
   * first frame of the fight -- `battleui.ts` latches its fire edge in `tap()`
   * and only drains it once the arena is up, so a fight that were open behind
   * this card would bank the press and shoot with it.
   */
  const battleCover = createBattleCover({ onReady: onCoverReady });

  /*
   * The Escape menu, and the controls guide inside it.
   *
   * `menu.ts` owns the Escape key outright -- opening as well as closing --
   * so the two halves of one keypress can never be split across two listeners
   * whose order decides what the player sees. What this file owns is whether
   * opening is ALLOWED, and that is the same question the [FISH] and [SHOP]
   * keys ask: nothing else may own the screen, no fight may be running or
   * about to, and the hull must not be in a funnel. The overlays are left out
   * of `canOpen` on purpose -- they close on their OWN Escape, and this menu
   * must not open behind the card the same press just dismissed.
   */
  const menu = createMenu({
    canOpen: () =>
      !fishing.isOpen &&
      !fishBook.isOpen &&
      !shop.isOpen &&
      !fishCover.isOpen &&
      !questCover.isOpen &&
      !battleUi.isOpen &&
      !battleCover.isOpen &&
      hazards.state.phase === 'free',
    // The halt every overlay makes, for the fishing card's reason: it is what
    // makes "the world resumes from rest" true of this screen too.
    onOpen: () => ship.halt(),
    /*
     * The HARBOURS page, filled on every open.
     *
     * Built here rather than in `menu.ts` because it is the one place that can
     * see all three of the towns, the ship and the save. The menu is handed
     * finished rows and never learns what a `Towns` or a `ShipState` is.
     *
     * Every one of the 36 names is listed, known or not, and the unknown ones
     * read UNCHARTED. That is the point of the page: a harbour remembered from
     * a previous world is a navigation target in this one from the first
     * frame, and the scope only reaches 50 units, so without this a remembered
     * name would be findable only by sailing over it.
     */
    harbours: () =>
      HARBOUR_NAMES.map((name) => {
        const town = globe.towns.byName(name);
        const known = records.known.names.has(name);
        if (town === null || !known) return { name, known: false, bearing: 0, distance: 0 };
        return {
          name,
          known: true,
          bearing: bearingTo(ship.state, town.dir),
          distance: Math.acos(Math.min(1, ship.state.position.dot(town.dir))) * GLOBE_RADIUS,
        };
      }),
    /*
     * The CONTRACTS page, filled on every open.
     *
     * Built here for the HARBOURS page's reason: this is the one place that can
     * see the contracts, the towns and the ship at once. `menu.ts` is handed
     * finished strings and never learns what a world second or an
     * `ActiveQuest` is.
     *
     * It lists what is IN HAND and never what is on offer. Offers live at the
     * berth that posts them, which is the whole point of a board -- a page that
     * let a player take work from the middle of an ocean would throw away the
     * one moment in the game where planning a passage is the obvious thing to
     * be doing.
     */
    contracts: () =>
      quests.active.map((quest) => {
        const fix = quest.target === null ? null : harbourFix(quest.target);
        return {
          brief: quest.brief,
          // Three states in one string, on the power tag's rule: a row missing
          // its fix must not be a row with an empty box where the fix goes.
          fix:
            quest.target === null
              ? ''
              : fix === null
                ? 'UNCHARTED'
                : `${formatBearing(fix.bearing)}  ${formatDistance(fix.distance)}`,
          remaining: quest.remaining === null ? '' : formatSpan(quest.remaining),
          urgent: quest.remaining !== null && quest.remaining < QUEST_URGENT_BELOW,
        };
      }),
    reputation: () => records.reputation.points,
  });

  /*
   * `?boat=red|orange`, `?battle=1` and `?calm=1`, the three battle dev
   * queries.
   *
   * Read through URLSearchParams and never through `import.meta.env.MODE`, on
   * exactly the same terms as `?quality=` and `?hazard=` above: `vite preview`
   * serves a genuine production build and all three of these are meant to be
   * used against one. An ordinary player's session sets no query, so nothing
   * below ever fires for them.
   *
   * The first two exist because the spawn is a 16%-and-24%-per-ten-seconds
   * draw. Waiting for one is a vigil rather than a test, and the budget in
   * docs/TESTING.md does not have a vigil in it. `?calm=1` exists for the
   * opposite reason: once a fight is up, the sea is three more seeded systems
   * on top of the gunner, and tuning the gunner against a hull that is also
   * being shoved, fouled and blocked is tuning it against noise. It switches
   * all three off — the same `CALM` every unit case that measures the gunner
   * is pinned against — so the fight can be watched, or fought, with nothing
   * moving the boats but the throttle.
   *
   * Read here, ahead of the fight it governs, because the very first
   * `battleSim` below is built on this same beat: both `createBattleSim`
   * call sites take whatever this resolves to, and there is only one of it to
   * keep in step.
   */
  const battleParams = new URLSearchParams(window.location.search);
  const boatQuery = battleParams.get('boat');
  let forcedBoat: AiBoatKind | null =
    boatQuery === 'red' || boatQuery === 'orange' ? boatQuery : null;
  /** `?battle=1`: an orange boat put ON the hull, so the fight starts at once. */
  let forcedBattle = battleParams.get('battle') === '1';
  /**
   * `?salvage=1` -- one raft 25 units ahead -- and `?salvage=take`, which puts
   * one ON the hull so it is collected at once.
   *
   * A raft is a 0.5% draw every ten seconds in clear air, about one every half
   * hour, so waiting for one is a vigil rather than a test: the same argument
   * `?hazard=` and `?cell=` are here on.
   *
   * The two values exist because they answer different questions, and the pair
   * is `?boat=`/`?battle=1` again. `1` is for LOOKING at one: 25 units ahead,
   * on the water, in frame. `take` is for the payout -- the wallet, the locker
   * and the notice -- which cannot be reached by sailing at the first one in a
   * headless browser: the wind carries the hull sideways several units a second
   * (`wind.ts`'s `across`), so a run that holds the throttle down passes a
   * dead-ahead raft about fifteen units off and nothing ever fires.
   */
  /**
   * `?derelict=1` -- one dead hull just outside its own hook ring -- and
   * `?derelict=hook`, which puts one INSIDE it so the offer is up at once.
   *
   * A derelict is a 0.2% draw every ten seconds in clear air, about one every
   * eighty minutes, which is well past a vigil. The pair is `?salvage=`'s
   * exactly, and the second value exists for the same reason that one's does:
   * the tow itself -- the line, the strip, the speed cut, the cast-off -- cannot
   * be reached by sailing at the first one in a headless browser, because the
   * wind carries the hull several units sideways (`wind.ts`'s `across`) and a
   * run that holds the throttle down passes a dead-ahead wreck a unit or two
   * outside its ring. A player steers; a screenshot cannot.
   */
  const derelictQuery = battleParams.get('derelict');
  let forcedDerelict: 'look' | 'hook' | null =
    derelictQuery === '1' ? 'look' : derelictQuery === 'hook' ? 'hook' : null;
  const salvageQuery = battleParams.get('salvage');
  let forcedSalvage: 'look' | 'take' | null =
    salvageQuery === '1' ? 'look' : salvageQuery === 'take' ? 'take' : null;
  /** Seconds of sailing before either fires. The same beat the forced hazard waits. */
  let boatCountdown = 3;
  /**
   * What sea a fight is fought on.
   *
   * `?calm=1` forces a flat one and `?rough=1` forces the crests, shoals and
   * flotsam; between them, the SKY decides. A fight begun in a storm gets
   * `ROUGH`, one begun in fair weather gets `CALM`, and that is the only way
   * the weather reaches the arena at all -- there is no rain in there, no
   * haze and no lightning, because the arena is a second scene with its own
   * flat sea nowhere on the globe.
   *
   * It is decided ONCE, at the moment the cover card opens, and held for the
   * length of the fight: `battleSeaFor` below is called from the one path
   * into a fight. Re-reading the weather mid-fight would let the sea change
   * under a gunner who has already aimed at it, and the world is frozen for
   * the whole three-second count anyway.
   *
   * `?rough=1` is new with the weather and exists for exactly one reason: the
   * shipping default used to be `ROUGH` unconditionally, so a tuning session
   * that wants the crests now has to ask for them rather than merely not ask
   * for calm.
   */
  const forcedCalm = battleParams.get('calm') === '1';
  const forcedRough = battleParams.get('rough') === '1';
  function battleSeaFor(): typeof CALM {
    if (forcedCalm) return CALM;
    if (forcedRough) return ROUGH;
    /*
     * LIVE rather than the old storm-gated choice between CALM and ROUGH.
     *
     * That gate existed to decide whether the ARENA should raise crests of
     * its own, and the question is gone: the fight is on the globe's water
     * now, so whether the sea under the ring is running is decided by the
     * weather actually running there, frame by frame, rather than sampled
     * once at contact and imitated. `?calm=1` and `?rough=1` still force the
     * two old seas, because the gunner's pinned comparison is measured on
     * them and that measurement has to stay reproducible.
     *
     * The flotsam is the reason this is LIVE and not CALM: rafts are debris
     * in the water rather than a claim about what the water is doing, and
     * they are what the withdrawn shoals were replaced by.
     */
    return LIVE;
  }

  /**
   * How far ahead `?boat=` puts its raider, world units.
   *
   * 45 is inside the scope's 50 and outside the red boat's own 40-to-60 spawn
   * band's lower half, so the mark is on the plot from the first frame and the
   * chase is still a chase. A boat spawned at its natural 60 would be
   * invisible until it had already closed most of the way, which is the
   * owner's intent in a real session and useless in a tuning one.
   */
  const BOAT_FORCE_DISTANCE = 45;

  /**
   * And how far ahead `?battle=1` puts its, world units.
   *
   * One unit: well inside `aiboats.ts`'s CONTACT_RADIUS, so the very next
   * `aiBoats.update` registers the touch and the arena comes up without a
   * chase in front of it. The fight is what this query is for.
   */
  const BATTLE_FORCE_DISTANCE = 1;

  /**
   * And how far ahead `?derelict=1` puts its hull, world units.
   *
   * Nine: just outside `derelict.ts`'s 5-unit hook ring, so the offer is not
   * already up on the first frame, and inside a second of sailing so the ring,
   * the notice and the tow can all be exercised without a voyage in front of
   * them.
   */
  const DERELICT_FORCE_DISTANCE = 9;

  /*
   * The fight in progress. Replaced wholesale at every contact rather than
   * reset, which is why `battle.ts` has no reset to call: one sim is built per
   * battle and thrown away with it, exactly as `fishing.ts` builds one sim per
   * session.
   *
   * It is created here rather than left null so the frame loop's battle branch
   * never has to test it. The branch is guarded by `battleUi.isOpen`, which is
   * false until a real fight starts, so this first one is only ever read by
   * the type checker.
   */
  let battleSim = createBattleSim(undefined, battleSeaFor());

  /** The boat a fight is being fought with, and its hull, for the fade home. */
  let contactBoat: AiBoat | null = null;
  let contactHull: THREE.Object3D | null = null;
  /*
   * Where the two hulls came from, captured on the way in and used on the way
   * out.
   *
   * The parent is READ rather than assumed. The player's hull is in `scene`,
   * and the clone is in a group `aihulls.ts` owns rather than in the scene at
   * all, so "put it back" cannot be written as `scene.add` twice. Asking the
   * object where it came from is the version that is right for both, and stays
   * right if either owner ever moves.
   */
  let playerHullHome: THREE.Object3D | null = null;
  let contactHullHome: THREE.Object3D | null = null;

  /**
   * True from the instant the arena's own scene is the one being rendered.
   *
   * False for the whole of the first fade and true for the whole of the
   * second, so the swap always happens under an opaque screen: on the way in
   * the world renders frozen under the sheet until `onBlack` flips this, and
   * on the way out the arena keeps rendering until `onBlack` flips it back.
   */
  let inArena = false;

  /**
   * Whether this fight's outcome has been rolled and paid.
   *
   * The roll happens the frame `outcome` first becomes non-null, NOT on
   * CONTINUE, because the card has to print the gold and the power the player
   * actually got. It is a latch rather than a test on `outcome` because
   * `battle.ts` keeps the boats circling after the fight is decided, so the
   * frame that ends it is followed by however many the player leaves the card
   * up for.
   */
  let outcomeSettled = false;

  /**
   * The sun's elevation at the ship, right now, as every shader in the world
   * measures it.
   *
   * Handed to the arena once, at the moment of contact, so a fight at dusk is
   * a dusk fight and one at midnight is two neon hulls on black water. It is
   * read at contact rather than each frame because `globe.update` does not run
   * during a battle: `env` is frozen with the rest of the world, exactly as it
   * is under the fishing card.
   */
  function solarElevation(): number {
    return ship.state.up.dot(env.sunDirection);
  }

  /**
   * A hull has touched the player's. Fired once, from `aiboats.ts`.
   *
   * The ram no longer opens the fight. It halts the ship and raises the cover
   * card, and the fight is opened three seconds later by `onCoverReady` when
   * the count runs out -- see `battlecover.ts` for why the beat is there.
   *
   * What is still true of this function is the thing that made it correct
   * before: the world stops synchronously, on the frame of the contact. It
   * stops by a different mechanism now. `battleUi.isOpen` used to be what
   * froze it; `battleCover.isOpen` is what freezes it here, and the frozen
   * branch of the frame loop tests for it beside the other four overlays. So
   * no frame ever sees a raider alongside a ship still making way, and no
   * second contact can land inside the count, because `aiBoats.update` is not
   * called at all while the world is frozen.
   */
  function onContact(boat: AiBoat): void {
    ship.halt();
    contactBoat = boat;
    /*
     * A fight ends a hunt, and pays what it banked.
     *
     * The battle branch runs the world -- wind, weather, hazards, the sun --
     * but it does not run `leviathan.update`, and it must not: the hull is
     * halted and `battle.ts` is steering it, so there is no helm to hold a
     * target with. Leaving the shoal frozen through ninety seconds of a
     * moving sea and handing it back would be the one object on the water
     * that did not live through the fight.
     *
     * An OVERLAY is the opposite case and is deliberately not handled here:
     * the frozen branch stops the whole world, the shoal with it, and the
     * player comes back to the sea exactly as they left it. That is the pause
     * contract doing its job rather than a hunt being spared.
     */
    leviathan.scatter();
    /*
     * Where the fight will be staged, decided HERE rather than three seconds
     * later when the fade puts it there.
     *
     * Two reasons, and the second is the one that moved it. The first is that
     * it costs nothing: the world is frozen from this frame, so the ship's
     * position cannot change between the ram and the fade and the search would
     * return the same answer either way. The second is that the CARD needs the
     * answer. A ring that has been driven a long way off owes the player a
     * sentence, and a sentence cannot be written by a screen that goes up
     * before the search that would justify it has run.
     */
    ringMoved = findRingCentre(
      globe.heightMap,
      terrain.seaLevel,
      ship.state.position,
      ringCentre,
    ).moved;
    /*
     * The player's threshold is read HERE, at the ram, and carried unchanged
     * through the card and into the sim.
     *
     * It has to be one reading rather than three lookups. The card promises a
     * number in words -- "two hits lose it" -- and the strip draws that many
     * pips, so if either re-read the hull they could disagree with the sim
     * that is actually counting. The hull cannot move during a fight in any
     * case (the arena branch never ticks it), which is what makes freezing it
     * at the ram honest rather than merely convenient.
     */
    battleCover.open(boat.kind, records.hull.state.hitsToLose, ringMoved > RING_DRIVEN_OFF);
  }

  /**
   * The count has run out. The fight the ram declared actually begins.
   *
   * This is the old `onContact` from `battleSim` down, unchanged, and the
   * order is still the fade's order: everything that can be seen happening
   * happens now, everything that rearranges the world waits for the screen to
   * be opaque. `battleUi.open` flips the frame loop from the frozen branch
   * onto the battle branch, synchronously, which is what stops the cover from
   * being ticked a second time by a frame that lands between here and the
   * fade.
   */
  function onCoverReady(): void {
    const boat = contactBoat;
    // Defensive, and cheap. Nothing can clear the boat between the ram and the
    // count -- the world is frozen for the whole of it -- but this function is
    // the one path into a fight and a fight with no foe would be a fight
    // against a null hull.
    if (boat === null) {
      battleCover.close();
      return;
    }
    // The same reading the card was opened with three seconds ago, not a
    // fresh one: nothing has ticked the hull in between, and taking it twice
    // would be two chances to disagree for no gain.
    const playerHits = records.hull.state.hitsToLose;
    battleSim = createBattleSim(undefined, battleSeaFor(), playerHits);
    outcomeSettled = false;
    battleUi.open(boat.kind, playerHits);
    blackout.run(() => {
      // The card comes down HERE, on a screen that is already opaque, for the
      // reason the instruments below it do: taking it away the instant the
      // count hit zero would show the player half a second of the world they
      // are about to leave, which reads as the fight having been called off.
      battleCover.close();
      contactHull = aiHulls.hullOf(boat);
      playerHullHome = ship.object.parent;
      contactHullHome = contactHull ? contactHull.parent : null;
      battleScene.enter(ship.object, contactHull, solarElevation());
      placeRing();
      // No funnel may open inside the ring for as long as the fight is up.
      // The clearance is the ring the fight OPENS on rather than the one it
      // is currently squeezed to, so a maelstrom cannot be raised into the
      // water the boats are about to be driven through either.
      hazards.barMaelstroms(ringCentre, RING_CLEARANCE);
      scene.add(battleScene.props);
      inArena = true;
      // With the arena. The world's instruments are hidden from here rather
      // than from `open()` so the change happens on a screen that is already
      // opaque: hiding them the moment the fight was declared would pop the
      // whole HUD out in front of a player who is still looking at the sea.
      // See the `body.in-battle` block in `style.css` for what goes and why.
      document.body.classList.add('in-battle');
    });
  }

  /*
   * Where the ring is, and the one transform that puts a flat arena on a
   * sphere.
   *
   * `battle.ts` does its arithmetic in metres east and metres north on a
   * plane, and it keeps doing exactly that: this is the only place the two
   * geometries meet. The props group is given the basis (east, up, north) at
   * the ring's centre, so a combatant at arena (x, z) lands at
   * `centre * R + east * x + north * z` and a prop at y = 0 lands at sea
   * level -- and the camera, which is a child of that group, is carried onto
   * the globe with everything it is framing.
   *
   * (east, up, north) is right-handed as `geo.ts` builds it -- `east` is
   * `cross(north, up)`, so `cross(east, up)` is `north` again -- which is
   * what stops the arena arriving mirrored, with every angle running the
   * wrong way round the circle.
   */
  const _ringUp = new THREE.Vector3();
  const _ringNorth = new THREE.Vector3();
  const _ringEast = new THREE.Vector3();
  const _ringOrigin = new THREE.Vector3();
  /** The ring's centre as a unit direction, live for as long as a fight is up. */
  const ringCentre = new THREE.Vector3(0, 0, 1);
  /**
   * World units the ring was slid off the contact to find open water, from
   * the same search that wrote `ringCentre`.
   *
   * Written at the ram and read once, on the next line, to decide whether the
   * cover card says anything about it. It is kept as state rather than passed
   * along because the search and the card are two different beats of the same
   * frame and the alternative is a second search.
   */
  let ringMoved = 0;

  /*
   * The open sea's shove, and the one place a real crest reaches into a fight.
   *
   * `hazards.ts` runs its crests through the ring like any other water -- the
   * ring is not shelter and is deliberately not made into any -- but a wave
   * the player can watch coming has to DO something when it arrives, or it is
   * scenery rolling through a duel. The rule is the one `battlesea.ts` always
   * used for its own crests, applied to the real ones: the frame a crest's
   * line crosses a hull, that hull is shoved along the crest's travel.
   *
   * Amplitude is mapped onto SWAY_MIN..SWAY_MAX off the crest's own SPEED
   * rather than passed through as a world height, and that is not a detail.
   * `battlesea.ts`'s keel clamp is written against one pulse peaking at
   * SWAY_MAX (6) inside a ring that floors at ARENA_R_MIN (8); handing it a
   * raw amplitude would invalidate that argument silently. Speed rather than
   * height because it is the same thing the open sea's own push is derived
   * from -- see PUSH_PEAK in `hazards.ts` -- so a wave that hits the hull
   * hard outside a fight hits it hard inside one.
   */
  /*
   * The fight's quality floor, which docs/ROADMAP.md states as a design rule
   * rather than as a nicety: "set a quality floor for step 1 (fog capped,
   * minimum ambient light) so a fight is never unreadable".
   *
   * The old arena did not need one. It passed `applyAerial` a weather of
   * zero and lit itself off a graded copy of the sun, so a fight was legible
   * by construction whatever the sky outside was doing -- and `battlescene.ts`
   * used to have to explain that a white-out over a twenty-unit ring hides
   * the target. Putting the fight in the live world hands all of that back:
   * the fog is the real fog now, and the reason it was excluded has not gone
   * away, it has become this function's job.
   *
   * A CAP and not a switch. Weather still reaches a fight -- a storm still
   * darkens the water, rain still falls, and a squall arriving mid-duel is
   * exactly the continuity this whole change is for -- it simply may not
   * close the visibility past the point where the other hull stops being a
   * target. The two ceilings are the readable half of each range.
   */
  const BATTLE_FOG_CAP = 0.35;
  const BATTLE_RAIN_CAP = 0.5;

  function battleWeather(wx: WeatherState): WeatherState {
    if (wx.fog <= BATTLE_FOG_CAP && wx.rain <= BATTLE_RAIN_CAP) return wx;
    return {
      ...wx,
      fog: Math.min(wx.fog, BATTLE_FOG_CAP),
      rain: Math.min(wx.rain, BATTLE_RAIN_CAP),
    };
  }

  const _shoveDir = new THREE.Vector3();
  /** Which crests have already shoved which hull, so none shoves twice. */
  const shoved = new WeakMap<Hazard, number>();
  const SHOVE_PLAYER = 1;
  const SHOVE_AI = 2;

  function crestShoves(hull: THREE.Object3D, which: 'player' | 'ai', bit: number): void {
    for (const h of hazards.state.live) {
      if (h.kind === 'maelstrom') continue;
      if (((shoved.get(h) ?? 0) & bit) !== 0) continue;
      // The hull's world position, as a unit direction, so the crest's own
      // frame can be measured against it exactly as `hazards.ts` does.
      hull.getWorldPosition(_shoveDir);
      _shoveDir.normalize();
      const u = _shoveDir.dot(h.east) * GLOBE_RADIUS;
      const v = _shoveDir.dot(h.north) * GLOBE_RADIUS;
      // Inside the crest's own footprint: along its length, and within the
      // half-width that `hazards.ts`'s own contact test uses.
      if (Math.abs(u) > h.extent || Math.abs(v) > h.halfWidth) continue;
      shoved.set(h, (shoved.get(h) ?? 0) | bit);
      // The crest's travel, brought into the arena plane: `north` is where it
      // is going, and the plane's axes are east and north at the ring.
      const x = h.north.dot(_ringEast);
      const z = h.north.dot(_ringNorth);
      const speed = Math.min(1, h.speed / CREST_SPEED_REF);
      battleSim.shove(which, x, z, SWAY_MIN + (SWAY_MAX - SWAY_MIN) * speed);
    }
  }

  function placeRing(): void {
    // `ringCentre` was chosen at the ram, by `onContact`, and this only lays
    // the arena on it. The search moved up there because the cover card has to
    // know how far the fight travelled; see the note on `ringMoved`.
    _ringUp.copy(ringCentre);
    tangentFrame(_ringUp, _ringNorth, _ringEast);
    const props = battleScene.props;
    // Written as a basis rather than through Euler angles or a lookAt: the
    // three columns ARE the mapping, and any other spelling of it is a place
    // for a handedness bug to hide.
    props.matrixAutoUpdate = false;
    props.matrix.makeBasis(_ringEast, _ringUp, _ringNorth);
    props.matrix.setPosition(
      _ringUp.x * GLOBE_RADIUS,
      _ringUp.y * GLOBE_RADIUS,
      _ringUp.z * GLOBE_RADIUS,
    );
    props.updateMatrixWorld(true);
    // The camera stands outside the props and is placed from the same frame.
    // See `battlescene.ts`'s note on why it is not simply parented in.
    _ringOrigin.copy(_ringUp).multiplyScalar(GLOBE_RADIUS);
    battleScene.placeCamera(_ringOrigin, _ringEast, _ringUp, _ringNorth);
  }

  /**
   * Pays the fight out, once, the frame it is decided.
   *
   * Every figure is moved HERE and the card is handed what was actually taken,
   * never what the table said: `wallet.lose` is best-effort by design, so a
   * defeat against an empty purse takes nothing and the card says so rather
   * than advertising a 500-gold loss the player never paid.
   *
   * `Math.random` rather than a seeded stream, on the same terms as the
   * respawn heading in `onSunk`: the world's weather and its raiders replay,
   * and what a fight happened to be worth does not.
   */
  function settleOutcome(outcome: BattleOutcome): void {
    /*
     * The hull first, before the gold and before the plant, so the card reads
     * a hull that has already moved -- the same ordering rule the rest of this
     * function already keeps for the purse.
     *
     * A loss costs three times a win, and a win costs anything at all, which
     * is the point: there is no free fight. Winning is cheaper than running,
     * losing is dear, and both are paid in the one currency a berth gives
     * back for nothing.
     */
    const hullCost = outcome === 'loss' ? HULL_BATTLE_LOSS : HULL_BATTLE_WIN;
    records.hull.damage(hullCost);

    let gold = 0;
    if (outcome === 'win') {
      gold = rollWinGold(Math.random);
      records.wallet.add(gold);
    } else if (outcome === 'loss') {
      energy.defeat();
      gold = -records.wallet.lose(lossGold(records.wallet.gold));
    } else {
      energy.stalemate();
      const swing = rollDrawGold(Math.random, records.wallet.gold);
      if (swing >= 0) {
        records.wallet.add(swing);
        gold = swing;
      } else {
        gold = -records.wallet.lose(-swing);
      }
    }
    // Last, so the card reads a wallet and a plant that have already moved.
    battleUi.result({ outcome, gold, reserve: energy.state.reserve, hull: hullCost });
  }

  /**
   * CONTINUE. The outcome is already paid; this only takes the player home.
   *
   * Both hulls go back to the parents they were taken from, the boat that
   * started the fight is removed (which is what starts the grace period, so
   * the other colour cannot ram a ship that has only just got the helm back),
   * and the overlay closes. All of it inside `onBlack`: the world and the
   * arena are two different scenes and the cut between them must never be
   * seen.
   */
  function onContinue(): void {
    blackout.run(() => {
      if (playerHullHome) playerHullHome.add(ship.object);
      if (contactHull && contactHullHome) contactHullHome.add(contactHull);
      scene.remove(battleScene.props);
      hazards.barMaelstroms(null, 0);
      battleScene.exit();
      if (contactBoat) aiBoats.remove(contactBoat);
      contactBoat = null;
      contactHull = null;
      playerHullHome = null;
      contactHullHome = null;
      battleUi.close();
      inArena = false;
      // And back, in the same breath and behind the same opaque screen.
      document.body.classList.remove('in-battle');
    });
  }

  // The two overlays. Neither is a scene: they own their own DOM over the frozen
  // frame, and the only thing this file does for them is stop the world.
  const fishing = createFishing({
    energy,
    wallet: records.wallet,
    book: records.book,
    harpoons: records.harpoons,
    governor: records.governor,
    arcLamp: records.arcLamp,
    chumDrum: records.chumDrum,
    barbedHeads: records.barbedHeads,
    onOpen: () => {
      // The hull stops before the first frozen frame runs. `open()` flips its
      // own flag and calls this synchronously inside the click, so no frame of
      // the loop ever sees an overlay up over a ship still making way.
      //
      // A ship that kept its way through a paused minute would have travelled
      // nowhere and would leap forward on the frame the card closes; halting on
      // open is what makes "the world resumes from rest" true rather than
      // merely intended.
      ship.halt();
    },
    onClose: () => {
      // Deliberately empty. `paused` is derived from the overlays each frame
      // rather than latched here -- see the frame loop -- so there is nothing to
      // unwind, and the hull is already stopped. The hook is kept because a
      // future thaw belongs at the moment of closing and not in the loop.
    },
  });

  const fishBook = createFishBook(records.book, records.wallet);

  /*
   * The activity's cover screen, and the only thing [FISH] opens now.
   *
   * Both callbacks are one line and both are deliberately here rather than
   * inside `fishcover.ts`: the cover knows it has two doors and nothing about
   * where either leads, which is what keeps it a screen instead of a second
   * place the overlays are coordinated.
   *
   * `onStart` hands back whether a session actually began. `fishing.open()`
   * re-tests the plant and can still refuse -- a disabled attribute is an
   * affordance, never a lock -- and the cover uses the answer to decide
   * whether to close, so a refusal leaves the player looking at the screen
   * they pressed rather than at the sea.
   *
   * `onRecord` does NOT close the cover. The record's overlay outranks it in
   * the stacking order, so it opens on top and closing it comes back here.
   */
  const fishCover = createFishCover({
    energy,
    governor: records.governor,
    chumDrum: records.chumDrum,
    barbedHeads: records.barbedHeads,
    onStart: (useChumDrum, useBarbedHeads) => fishing.open(useChumDrum, useBarbedHeads),
    onRecord: () => fishBook.open(),
    hull: records.hull,
    // Same halt, and the same reason, as the fishing card's own: the hull
    // stops before the first frozen frame runs, so the world resumes from
    // rest rather than leaping forward on the frame the screen closes.
    onOpen: () => ship.halt(),
  });
  // The chandlery. It knows what things cost and nothing about where the ship
  // is; the berth test is below, beside the other two overlays' guards.
  const shop = createShop({
    wallet: records.wallet,
    battery: records.battery,
    harpoons: records.harpoons,
    seaAnchor: records.seaAnchor,
    overdrive: records.overdrive,
    chumDrum: records.chumDrum,
    barbedHeads: records.barbedHeads,
    trim: records.trim,
    moonglass: records.moonglass,
    arcLamp: records.arcLamp,
    governor: records.governor,
    hull: records.hull,
    stock: records.stock,
    known: records.known,
    // Where the panel is, asked on every open. A callback rather than a value
    // for the pause contract's reason: a berth read once at construction would
    // be a lie by the second frame, and the whole point of the harbour name in
    // the head is that it names the one you are actually tied up at.
    harbour: () => globe.towns.dockAt(ship.state.position)?.town ?? null,
  });

  /*
   * The contract board. A cover screen of its own, opened by its own key.
   *
   * It is handed the sim, the standing, and three callbacks that answer
   * questions only this file can: where the ship is tied up, which world day it
   * is, and what the sun is doing over a target. Everything else on a card is
   * already inside the offer, which is what keeps a screen full of bearings and
   * deadlines from needing to know what a `Towns` is.
   */
  const questCover = createQuestCover({
    quests,
    reputation: records.reputation,
    // `energy.mode` is the project's single definition of docked, so the board's
    // heading and the power panel can never disagree about which harbour this
    // is. Read through `dockAt` for the NAME, as the shop's head is.
    berth: () =>
      energy.state.mode === 'docked'
        ? (globe.towns.dockAt(ship.state.position)?.town.name ?? null)
        : null,
    day: () => quests.day,
    sky: skyNote,
    // The halt every overlay makes, for the fishing card's reason: it is what
    // makes "the world resumes from rest" true of this screen too. The hull is
    // already stopped -- a berth is a two-second dwell -- so this is belt and
    // braces rather than a correction.
    onOpen: () => ship.halt(),
  });

  /*
   * `?quest=`, the contracts dev query. Null on every ordinary session.
   *
   * Read through URLSearchParams and never through `import.meta.env.MODE`, on
   * exactly the same terms as `?quality=`, `?hazard=` and the three battle
   * queries: `vite preview` serves a genuine production build and these are
   * meant to be used against one.
   *
   * Two forms, and both exist because the alternative is a vigil rather than a
   * test. A board turns over once per world day, which is twenty real minutes,
   * and a contract has to be accepted at a berth and settled at another one --
   * so looking at a day's postings, or driving a completion, would otherwise
   * mean sailing there first.
   *
   *   ?quest=board                 print every harbour's board for today
   *   ?quest=accept:<n>            take posting n at the nearest harbour
   *   ?quest=accept:<name>:<n>     take posting n at a named harbour
   *
   * A name may use underscores for spaces (`Marine_Stronghold`) and is matched
   * case-insensitively, because a query string carrying a literal space is a
   * thing only a browser's address bar forgives.
   *
   * It fires on the first frame rather than here: `quests.offers` cannot judge
   * a window until it has seen the sun, and the sun arrives with the first
   * `quests.update`.
   */
  const questQuery = new URLSearchParams(window.location.search).get('quest');
  let questDevPending = questQuery !== null;

  /** Resolves a `?quest=` harbour argument to a real name, or null. */
  function devHarbour(raw: string): string | null {
    const wanted = raw.replace(/_/g, ' ').trim().toLowerCase();
    return HARBOUR_NAMES.find((name) => name.toLowerCase() === wanted) ?? null;
  }

  /** The harbour nearest the ship, by great-circle arc. Null in a world with none. */
  function nearestHarbour(): string | null {
    let best: string | null = null;
    let bestDot = -2;
    for (const town of globe.towns.all) {
      const dot = town.dir.dot(ship.state.position);
      if (dot > bestDot) {
        bestDot = dot;
        best = town.name;
      }
    }
    return best;
  }

  function runQuestQuery(query: string): void {
    if (query === 'board') {
      for (const name of HARBOUR_NAMES) {
        const posted = quests.offers(name, quests.day);
        if (posted.length === 0) continue;
        console.info(
          `quest board day ${quests.day} — ${name}:\n` +
            posted
              .map((o) => `  [${o.tier}] ${o.brief} — ${o.gold} g, +${o.reputation} REP (${o.id})`)
              .join('\n'),
        );
      }
      return;
    }

    const parts = query.split(':');
    if (parts[0] !== 'accept' || parts.length < 2) {
      console.warn(`?quest=${query} is not a form this build knows; see main.ts`);
      return;
    }
    const harbour = parts.length >= 3 ? devHarbour(parts[1]) : nearestHarbour();
    const slot = Number(parts[parts.length - 1]);
    if (harbour === null || !Number.isInteger(slot) || slot < 0) {
      console.warn(`?quest=${query}: no such harbour, or no such slot`);
      return;
    }
    const posted = quests.offers(harbour, quests.day);
    const offer = posted[slot];
    if (offer === undefined) {
      console.warn(`?quest=${query}: ${harbour} posted ${posted.length} today`);
      return;
    }
    console.info(`?quest= accepted at ${harbour}: ${offer.brief}`);
    quests.accept(offer);
  }

  // hud.ts owns whether [FISH] looks pressable; this owns what pressing it does.
  // The overlay test is here and not in the HUD because the HUD does not know
  // the overlays exist, and `fishing.open()` re-tests the tank on its own
  // account -- a disabled attribute is an affordance, never a lock.
  document.getElementById('btn-fish')?.addEventListener('click', () => {
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen || questCover.isOpen) return;
    if (menu.isOpen) return;
    // Nor during a cannon fight. docs/BATTLE_PLAN.md argues this guard is not
    // needed, on the grounds that a fight opens synchronously from `onContact`
    // and no contact can happen under an overlay -- both true, and both about
    // the other direction. The battle overlay is a HUD over a live scene
    // rather than a card over a frozen one, so the telemetry panel and its two
    // keys are still on screen and still pressable underneath it; and the
    // battle branch is tested FIRST, so a cover screen opened over a fight
    // would never be ticked and never be closed. The same guard is on [SHOP].
    // The cover card as well as the fight itself. The count is three seconds
    // during which the world is frozen and `battleUi.isOpen` is still false,
    // so a guard on the fight alone would let [FISH] open a card over a ram
    // that has already landed -- and the battle branch, once it took over,
    // would never tick that card and never close it.
    if (battleUi.isOpen || battleCover.isOpen) return;
    // Not while a maelstrom has the hull. An overlay freezes the world, and
    // the hull in a spiral is not the player's to freeze: opening one mid-
    // capture would halt a ship that is being carried, and the wreck would
    // resume from wherever the card was closed. The same guard is on [SHOP].
    if (hazards.state.phase !== 'free') return;
    fishCover.open();
  });

  // The berth is re-tested here rather than trusted off the button, on the
  // same terms as [FISH]: `hud.ts` writes the disabled attribute as an
  // affordance and a disabled attribute is not a lock. `energy.mode` is the
  // project's one definition of docked, so this and the key agree by
  // construction.
  document.getElementById('btn-shop')?.addEventListener('click', () => {
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen || questCover.isOpen) return;
    if (menu.isOpen) return;
    if (battleUi.isOpen || battleCover.isOpen) return;
    if (hazards.state.phase !== 'free') return;
    if (energy.state.mode !== 'docked') return;
    // The hull is already stopped -- a berth is a two-second dwell -- but the
    // halt is what makes "the world resumes from rest" true of this overlay
    // as well as of the fishing card.
    ship.halt();
    shop.open();
  });

  /*
   * [WORK]. The berth is re-tested here rather than trusted off the button, on
   * exactly [SHOP]'s terms: `hud.ts` writes the disabled attribute as an
   * affordance and a disabled attribute is not a lock.
   *
   * The guard list is [SHOP]'s, entire. A board over a frozen world has the
   * same two ways of going wrong: a cover card raised over a ram that has
   * already landed would never be ticked and never closed, and a card opened
   * over a hull in a maelstrom would halt a ship that is being carried.
   */
  document.getElementById('btn-quests')?.addEventListener('click', () => {
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen || questCover.isOpen) {
      return;
    }
    if (menu.isOpen) return;
    if (battleUi.isOpen || battleCover.isOpen) return;
    if (hazards.state.phase !== 'free') return;
    if (energy.state.mode !== 'docked') return;
    ship.halt();
    questCover.open();
  });

  // ANCHOR and COIL: unlike [FISH] and [SHOP], neither opens an overlay --
  // both act on the world directly, so there is no `ship.halt()` and no
  // `onOpen`/`onClose` pair here. The guard is the same set of "the world is
  // not the player's right now" tests as the two above, minus the berth
  // test neither of these needs. `hud.ts` writes the disabled attribute as
  // an affordance; the stores' own `canDeploy`/`canEngage` are the lock.
  document.getElementById('btn-anchor')?.addEventListener('click', () => {
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen || questCover.isOpen) return;
    if (menu.isOpen) return;
    if (battleUi.isOpen || battleCover.isOpen) return;
    if (hazards.state.phase !== 'free') return;
    records.seaAnchor.deploy();
  });

  document.getElementById('btn-overdrive')?.addEventListener('click', () => {
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen || questCover.isOpen) return;
    if (menu.isOpen) return;
    if (battleUi.isOpen || battleCover.isOpen) return;
    if (hazards.state.phase !== 'free') return;
    records.overdrive.engage();
  });

  /*
   * The ship as the power plant sees it while the world is frozen: everything
   * true of the hull, with the engine at a dead stop.
   *
   * It is built once and refreshed in place, never reallocated -- this runs at
   * 60fps for as long as a card is open, and a fresh object per frame is a
   * garbage collector pause in the middle of a mini-game.
   *
   * Why a snapshot at all, when `ship.halt()` has already zeroed the speed: the
   * halt happens inside `open()`, and `open()` can be called from a pointer
   * event in the middle of a frame that has already billed the hull for its last
   * knot. Pinning the speed here means the purchase can never be charged at
   * travelling rates no matter where in the frame it lands. The vectors are
   * shared by reference rather than copied, so `position` and `up` -- the two
   * fields the solar and berth rules actually read -- stay live.
   */
  const restingShip: { -readonly [K in keyof ShipState]: ShipState[K] } = { ...ship.state };

  function restingSnapshot(): ShipState {
    Object.assign(restingShip, ship.state);
    restingShip.speed = 0;
    return restingShip;
  }

  // The composer patches a scene's materials once, on its first frame. The
  // hull is already aboard by now -- it was awaited above -- so this is a
  // plain call rather than the `ship.ready.then` it used to be. Without it the
  // model renders unencoded and a stop too dark.
  postFx.adopt(ship.object);

  function onResize(): void {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
    postFx.resize(window.innerWidth, window.innerHeight);
    view.resize(window.innerWidth / window.innerHeight);
    // The arena's camera is deliberately NOT resized here. It is alive only
    // under the battle branch, and `battlescene.ts` takes its own aspect off
    // the window inside its `update` for that reason: one owner, and no way
    // for this handler and that one to disagree about the framing.
  }
  window.addEventListener('resize', onResize);

  // Dev overlay (GPU ms / CPU ms / draw calls): off by default, toggled with
  // Backquote. The query itself has a real GPU cost, so postFx only issues it
  // while this is on; hud.ts owns the DOM row this feeds.
  let devTimingVisible = false;
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Backquote') {
      devTimingVisible = !devTimingVisible;
      postFx.setTimingEnabled(devTimingVisible);
      hud.setDevTimingVisible(devTimingVisible);
      return;
    }

    /*
     * Space: make fast to the berth, or cast off again.
     *
     * The guards are [FISH]'s and [SHOP]'s, for the same reasons written out
     * up there -- no overlay, no menu, no fight, no maelstrom -- with one of
     * its own on top: `battleui.ts` binds Space as FIRE, and a key that meant
     * two things at once would moor a ship in the middle of a broadside. The
     * battle guard already covers it, and this comment is why it may not be
     * dropped as redundant.
     *
     * `event.repeat` is refused because this is a TOGGLE. A held key repeats
     * at the OS rate, which would tie and cast off several times a second and
     * leave the state on whichever edge the player happened to let go on.
     *
     * `preventDefault` because Space scrolls the page, exactly as the arrow
     * keys do in `controls.ts`. It is called only once the key is known to be
     * ours to act on, so a Space aimed at a focused button in an overlay still
     * presses it.
     *
     * The eligibility test is NOT here. `energy.toggleMooring` refuses unless
     * the ring's dwell has run out and says so in its return, which keeps the
     * dwell clock and the lock that consumes it in one file -- this would
     * otherwise be a second opinion about what it means to have arrived.
     */
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen || questCover.isOpen) return;
    if (menu.isOpen) return;
    if (battleUi.isOpen || battleCover.isOpen) return;
    if (hazards.state.phase !== 'free') return;
    if (event.repeat) return;
    event.preventDefault();
    /*
     * The ladder, and the order is the rule.
     *
     * A BERTH WINS. A player standing in a harbour's ring with a derelict on
     * the line means to finish the job, and mooring is also what settles a tow
     * (see `settleTow` below, called off the mooring itself rather than from
     * here, because a berth can also be reached by drifting into one).
     *
     * A derelict's ring is only consulted when there is no berth under the
     * hull. `derelicts.hook` refuses unless its own `hookReady` is set, which
     * keeps the ring's verdict and the act that consumes it in one file --
     * exactly the split `energy.toggleMooring` keeps for the berth.
     *
     * Casting off is deliberately NOT here: a press that drops the hull you
     * have towed across a hemisphere may not share a key with the most-pressed
     * key on the helm. It is [CAST OFF] and `T`.
     */
    if (energy.state.berthReady) {
      // A ship carrying way into the ring is stopped by the mooring itself --
      // `ship.ts` writes a dead stop the moment `mode` reads docked -- so this
      // needs no `halt()` of its own the way [SHOP] does.
      energy.toggleMooring();
      return;
    }
    if (derelicts.hook()) {
      const live = derelicts.state.live;
      toast.push(`TOW MADE FAST - BOUND FOR ${live?.bound.toUpperCase() ?? ''}`, 'good');
    }
  });

  /**
   * Cast off by hand: the key and the button, one handler.
   *
   * The same guard ladder [ANCHOR] and [COIL] carry, for the same reason -- the
   * world is not the player's while a card is up -- minus the berth test, which
   * this does not need: dropping a tow alongside is a perfectly sensible thing
   * to want, and if the berth is the one it was bound for the mooring has
   * already settled it.
   */
  function castOff(): void {
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen || questCover.isOpen) return;
    if (menu.isOpen) return;
    if (battleUi.isOpen || battleCover.isOpen) return;
    if (hazards.state.phase !== 'free') return;
    const dropped = derelicts.release();
    if (dropped !== null) toast.push('TOW CAST OFF', 'info');
  }

  document.getElementById('btn-tow')?.addEventListener('click', castOff);

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyT') return;
    if (event.repeat) return;
    castOff();
  });

  /*
   * One frame's worth of work, thrown away, while the splash is still up.
   *
   * Materials in this engine compile on first draw, so without this the very
   * first frame the player sees is the frame every shader in the world is
   * handed to the driver -- a hitch of hundreds of milliseconds, arriving
   * exactly when they have just been told the game is ready. Paying for it
   * here is the whole reason a loading screen earns its place rather than
   * merely filling a wait.
   *
   * It is the frame loop's own sequence minus the ship's physics, so nothing
   * compiles here that would not have compiled there. The 16 ms it advances
   * the world by is a sixtieth of a second of drift and nothing else.
   */
  const WARM_DT = 1 / 60;
  view.update(WARM_DT, ship.state, controls.input);
  globe.update(
    WARM_DT,
    env,
    wind.state,
    weather.state,
    weatherCells.state,
    ship.state,
    view.camera,
  );
  postFx.render(WARM_DT, scene, view.camera);
  controls.endFrame();

  await loading.step(1, 'READY');
  await loading.done();

  /**
   * How much a full storm multiplies the hazard and raider spawn odds.
   *
   * 2, i.e. tripled odds at `storm = 1`. It lives here rather than in either
   * sim because both must read one number: a storm that raised the sea
   * without raising the chance of meeting a raider in it would be half a
   * system, and two constants would eventually become two different storms.
   *
   * What it buys differs sharply between the two, which is worth knowing
   * before moving it. `aiboats.ts` rolls once every ten seconds and is
   * nowhere near its one-of-each-kind cap, so tripled odds are worth about
   * 2.7x the encounters. `hazards.ts` rolls every second at odds that already
   * refill a free slot almost at once, so the same multiplier is worth about
   * 1.5x -- what limits the hazards is how long one LIVES, not how often one
   * is rolled for. Both are measured in their own unit tests.
   */
  const STORM_ODDS_GAIN = 2;

  /*
   * `?hazard=wave|maelstrom` -- one forced hazard, 25 units dead
   * ahead, three seconds after the first frame.
   *
   * A maelstrom is a 1% draw every ten seconds. Waiting for one is not a test,
   * it is a vigil, and this is the only way to see the whole event inside the
   * budget in docs/TESTING.md.
   *
   * Read through URLSearchParams and never through `import.meta.env.MODE`, on
   * exactly the same terms as `?quality=`: `vite preview` serves a genuine
   * production build, and this is meant to be used against one. An ordinary
   * player's session sets no query, so nothing below ever fires for them.
   */
  const hazardQuery = new URLSearchParams(window.location.search).get('hazard');
  let forcedHazard: HazardKind | null =
    hazardQuery === 'wave' || hazardQuery === 'maelstrom' || hazardQuery === 'maelstrom-now'
      ? hazardQuery === 'maelstrom-now'
        ? 'maelstrom'
        : hazardQuery
      : null;
  /**
   * `?hazard=maelstrom-now` -- the funnel opens ON the hull, so it swallows the
   * ship at once and the run is about what happens AFTERWARDS.
   *
   * The near half of the pair `?salvage=`, `?derelict=` and `?battle=1` all
   * carry, and it is here for the same reason theirs are. 25 units is dead
   * ahead but it still has to be SAILED to, and the browser tier runs on a
   * software rasteriser that advances the simulation at about a fiftieth of
   * wall clock: measured, a hull under full throttle covered four units in two
   * hundred seconds, which puts the funnel twenty minutes away. That is a vigil
   * again, which is the exact thing the comment above says this query exists to
   * end -- and the state worth photographing is not the funnel, it is the sea
   * the ship comes back to.
   */
  const forcedHazardOnHull = hazardQuery === 'maelstrom-now';
  /** Seconds of sailing before the forced hazard rises. Long enough to see the sea it rises out of. */
  let forceCountdown = 3;
  /**
   * How far ahead the forced hazard rises, world units.
   *
   * Half the scope's range, and comfortably inside the displacement patch's
   * fully-displaced middle (its skirt starts at 34), so the thing rises in
   * real water rather than on the flat sphere and is on the radar from the
   * first frame of it.
   */
  const FORCE_DISTANCE = 25;

  /**
   * And how far ahead `?hazard=maelstrom-now` opens its, world units.
   *
   * One, which is well inside the funnel's own capture radius, so the very next
   * `hazards.update` takes the hull. `BATTLE_FORCE_DISTANCE`'s trick, and the
   * same number.
   */
  const HAZARD_ON_HULL_DISTANCE = 1;

  /** Scratch for the debug hook's bearing to the marked shadow. Never allocated per frame. */
  const _markBearing = new THREE.Vector3();
  const _markStarboard = new THREE.Vector3();
  const _forceAxis = new THREE.Vector3();
  const _forceCentre = new THREE.Vector3();
  const _forceNorth = new THREE.Vector3();

  /**
   * Walks `distance` along the bow and points the result back at the ship.
   *
   * Shared by the forced hazard and both forced boats, because all three want
   * the same two things: a point a fixed distance dead ahead, and the tangent
   * at that point which faces the hull. Writing it twice would be two great-
   * circle steps free to disagree, which is the second-projection failure
   * `radar.ts` spends a paragraph designing out.
   *
   * Returns false when the frame is degenerate, in which case nothing is
   * forced this frame and the dev query simply does not fire.
   */
  function aimAtShip(distance: number): boolean {
    const pos = ship.state.position;
    const fwd = ship.state.forward;
    // A great-circle step along the bow, the same walk `ship.ts` makes: rotate
    // the position toward `forward` about their cross product.
    _forceAxis.crossVectors(pos, fwd);
    if (_forceAxis.lengthSq() < 1e-12) return false;
    _forceAxis.normalize();
    _forceCentre.copy(pos).applyAxisAngle(_forceAxis, distance / GLOBE_RADIUS).normalize();
    // `north` is the direction of travel, so pointing it back at the ship is
    // what makes a forced crest actually arrive: the tangent at the centre
    // that faces the hull, which is the ship's position with the centre's own
    // radial component taken out of it.
    _forceNorth.copy(pos).addScaledVector(_forceCentre, -pos.dot(_forceCentre));
    if (_forceNorth.lengthSq() < 1e-12) return false;
    _forceNorth.normalize();
    return true;
  }

  function releaseForcedHazard(kind: HazardKind): void {
    if (!aimAtShip(forcedHazardOnHull ? HAZARD_ON_HULL_DISTANCE : FORCE_DISTANCE)) return;
    hazards.force(kind, _forceCentre, _forceNorth);
  }

  /*
   * `?cell=storm|fog|lightning` -- one forced weather cell, sixty units dead
   * ahead, on the same three-second beat as `?hazard=`.
   *
   * Sixty rather than the hazard's twenty-five: a cell has a radius of 25 to
   * 60 and the point of the query is to photograph one from OUTSIDE, on the
   * horizon and on the scope, which is the half of the effect that cannot be
   * seen from inside it. Sailing forward for a few seconds then puts the ship
   * under it.
   *
   * `lightning` is a storm cell like any other -- every forced storm carries
   * lightning, since `weathercells.ts`'s `force` sets the flag -- and exists
   * as a separate word only so a shot can be named for what it is showing.
   */
  const cellQuery = new URLSearchParams(window.location.search).get('cell');
  let forcedCell: 'storm' | 'fog' | 'lightning' | null =
    cellQuery === 'storm' || cellQuery === 'fog' || cellQuery === 'lightning'
      ? cellQuery
      : null;
  let cellCountdown = 3;
  /** How far ahead a forced cell is raised, world units. See above. */
  const CELL_FORCE_DISTANCE = 60;

  function releaseForcedCell(kind: 'storm' | 'fog' | 'lightning'): void {
    if (!aimAtShip(CELL_FORCE_DISTANCE)) return;
    weatherCells.force(kind === 'fog' ? 'fog' : 'storm', _forceCentre, _forceNorth);
  }

  /**
   * How many times the ship has crossed INTO a cell this session.
   *
   * The measurement `CELL_TARGET` was chosen against: the encounter rate is a
   * closed-form function of the population and the bubble, and this is what
   * checks the arithmetic against a real course rather than a stationary
   * ship. Published on the debug hook; costs one boolean compare a frame.
   */
  let cellEncounters = 0;
  let inCell = false;

  /*
   * `?hunt=shoal` -- one forced shoal ahead of the bow, on the same
   * three-second beat as `?hazard=` and `?cell=`.
   *
   * A shoal is a 6% draw every ten seconds and has to clear a coast, a
   * reachability test and a 25-unit berth clearance before it lands, so
   * waiting for one is the vigil docs/TESTING.md's budget exists to forbid.
   *
   * Unlike those two it is a STANDING mode: see `HUNT_RELAY_SECONDS` below.
   *
   * `leviathan.force` does its own aiming rather than borrowing `aimAtShip`,
   * because the two want different things at the same point: a forced crest
   * needs a centre with a tangent pointing BACK at the hull so it arrives, and
   * a forced shoal needs the whole fourteen-shadow lay built about that
   * centre and cleared to its full radius. The distance it uses is
   * `SHOAL_SPAWN_MIN`, so the query puts the shoal exactly where a player
   * would have had to sail to find one -- and when that point is aground it
   * falls back to the ordinary compass search rather than laying one on a
   * beach, since a shoal that scatters on the next frame leaves nothing at
   * all to photograph.
   */
  const huntQuery = new URLSearchParams(window.location.search).get('hunt');
  /**
   * `?hunt=sound`, `?hunt=settle`, `?hunt=scatter` — force one ending.
   *
   * The three endings are three PICTURES as of phase 2, and the browser tier
   * cannot steer, so without these it cannot photograph any of them: reaching
   * `settled` needs five held presses and reaching `sounded` needs a
   * deliberately feeble one. Each lays an armed shoal and then ends it two
   * seconds later, which is long enough for the arrival to have played.
   *
   * The same affordance `?hunt=armed` already is, and the same reasoning: the
   * state under test cannot be reached by waiting.
   */
  const forcedEnding =
    huntQuery === 'sound' || huntQuery === 'settle' || huntQuery === 'scatter'
      ? huntQuery
      : null;
  const forcedHunt =
    huntQuery === 'shoal' ||
    huntQuery === 'armed' ||
    huntQuery === '1' ||
    forcedEnding !== null;
  /**
   * `?hunt=armed` lays the shoal INSIDE the gate with the mark on the bow.
   *
   * The armed state cannot be reached by waiting, only by steering, so the
   * browser tier cannot test the keystroke without sailing to it -- and a
   * scripted hull sails into headlands. This is the same affordance `?battle=1`
   * is for a fight, and it exists so the expensive tier has to prove only one
   * thing: that a Space press reaches the sim.
   *
   * `?hunt=shoal` still lays one out at `SHOAL_SPAWN_MIN`, which is the query
   * to use to LOOK at a shoal rather than to fire at one.
   */
  const forcedHuntArmed = huntQuery === 'armed' || forcedEnding !== null;
  /** Seconds until a forced ending fires, or null when none is queued. */
  let endingCountdown: number | null = null;
  /**
   * `?hunt=armed` stocks the locker, because otherwise it cannot possibly arm.
   *
   * A fresh save carries ZERO harpoons (`save.ts`, `EMPTY_SAVE`), and an empty
   * locker is one of the gate's conditions, so a new player meets a shoal and
   * the bar never lights: they get the `dry` notice pointing at the chandlery
   * instead. That is the shared-locker economy working as designed and it is
   * also, on a fresh save, invisible.
   *
   * The dev query's job is to set up the state under test, so it buys what the
   * hunt needs through the ordinary `HarpoonStore` rather than reaching past
   * it. Found by this exact query failing to arm in a browser while every unit
   * case passed, because every unit case hands the sim a stocked locker.
   */
  if (forcedHuntArmed) {
    while (records.harpoons.count < HUNT_TARGETS && records.harpoons.buy()) {
      /* buys one bundle a turn until the hunt's whole draw is covered */
    }
  }
  let huntCountdown = 3;
  /**
   * Seconds between re-lays while `?hunt=` is set, world units of frame time.
   *
   * The query is a STANDING mode and not a one-shot, which is the opposite of
   * `?hazard=` and `?cell=` and is a deliberate difference. A forced shoal is
   * laid at `SHOAL_SPAWN_MIN` heading back down the bow, so it closes, passes
   * a stationary hull and is past `DESPAWN_RANGE` about twenty-five SIMULATED
   * seconds later. On the software rasteriser the smoke tier runs at, twenty-
   * five simulated seconds is most of two minutes of wall clock -- so a
   * one-shot lays its shoal during the boot and has taken it away again before
   * anything gets to look at it, which is exactly what happened the first time
   * the smoke case asserted on it.
   *
   * So while the query is set there is always a shoal, or one is two seconds
   * away. Nothing about the roll, the grace or the placement changes; only how
   * often the dev hand reaches in.
   */
  const HUNT_RELAY_SECONDS = 2;

  const clock = new THREE.Clock();

  /**
   * Everything that stops a raider spawning, closing, or touching the hull.
   *
   * One verdict, computed here rather than inside `aiboats.ts`, because all
   * three of its terms are owned by other modules: `energy.ts` owns the
   * project's single definition of docked, `blackout.ts` owns whether a fade
   * is running, and `hazards.ts` owns whether a maelstrom has the hull. A sim
   * that re-derived any of them would be a second definition free to disagree.
   *
   * Overlays are not in it and do not need to be: the loop does not call
   * `aiBoats.update` under one at all.
   */
  /**
   * Pay for a tow, if the berth the ship has just made fast to is the one the
   * hull was bound for.
   *
   * Called every frame from the sailing branch rather than off the key press,
   * because `Space` is not the only way to be moored at a harbour -- a reload,
   * a `?spawn=` and a berth entered while already made fast all reach the same
   * state -- and because the test is cheap: two string reads and a comparison.
   *
   * Moor at the WRONG harbour and nothing happens at all. Being in the wrong
   * place is not a mistake that needs punishing; it is the voyage not being
   * over, and the strip is still saying where the hull is bound.
   */
  function settleTow(): void {
    const live = derelicts.state.live;
    if (live === null || !live.towed) return;
    if (energy.state.mode !== 'docked') return;
    const berth = globe.towns.dockAt(ship.state.position)?.town ?? null;
    if (berth === null || berth.name !== live.bound) return;

    const settled = derelicts.settle();
    if (settled === null) return;
    towsSettled++;
    const gold = towGold(settled.voyage);
    records.wallet.add(gold);
    records.reputation.award(TOW_REPUTATION);
    toast.push(
      `TOW DELIVERED - ${gold} g, +${TOW_REPUTATION} REP`,
      'good',
    );
  }

  function suppressed(): boolean {
    return energy.state.mode === 'docked' || blackout.active || hazards.state.phase !== 'free';
  }

  function frame(): void {
    const dt = Math.min(clock.getDelta(), 0.1);

    // Both deploy timers count down on the wall clock every frame this loop
    // runs at all, battle and frozen branches included -- a Sea Anchor's
    // three-second hold or an Overdrive Coil's twenty-second burn is a
    // promise about elapsed time, not about how the world happens to be
    // spending it, and gating the tick on which branch runs below would
    // let opening a menu pause a burn already under way for free.
    records.seaAnchor.tick(dt);
    records.overdrive.tick(dt);

    // Read once and threaded into every `energy.update` call below, battle
    // and frozen branches included: a Moonglass Array charges a hull at
    // anchor exactly as readily under an open shop as at sea, and an
    // Overdrive Coil already burning does not refund itself just because a
    // menu came up over it -- see the tick comment above for the same
    // argument about the timers these two numbers come from.
    const overdriveActive = records.overdrive.isActive;
    const moonNightFraction = records.moonglass.nightFraction;

    /*
     * The battle branch, tested BEFORE the overlay branch.
     *
     * A fight and a card can never be up together -- a contact halts the ship
     * and flips `battleUi.isOpen` synchronously, and no contact can happen
     * under an overlay because the sim does not run there -- so the order is
     * not a precedence rule. It is a statement about which of the two is the
     * more specific state, and it puts the branch that renders a DIFFERENT
     * SCENE first, where it cannot be reached by a reader who has already
     * satisfied themselves that the frozen branch renders the world.
     *
     * Derived from `isOpen` each frame rather than latched, exactly as the
     * overlays' freeze is: see **The pause contract** in docs/ARCHITECTURE.md.
     * `battleUi.isOpen` is a live getter for that reason.
     */
    if (battleUi.isOpen) {
      // The plant keeps running on a resting hull, for the fishing card's
      // reasons: the sun is still up, the ship may be at a berth, and a fight
      // is long enough that a tank frozen through one would be a lie about
      // where the power went.
      // The plant keeps running under a card, and keeps running in the
      // weather it was under when the card opened: `weather.update` is not
      // called on this branch, exactly as `wind.update` is not, so the sky
      // freezes with the rest of the world and a storm cannot quietly pass
      // while the player reads a menu.
      energy.update(dt, restingSnapshot(), env, overdriveActive, moonNightFraction, weather.state);

      /*
       * The world keeps running underneath the fight, which is the whole of
       * docs/ROADMAP.md step 1 and the reason any of this moved.
       *
       * These are the same calls, in the same order, that the sailing branch
       * makes: the cells before the wind because a squall floors it, the
       * weather after the wind because a squall is rolled off this frame's
       * phase, the hazards after the weather because their odds are this
       * frame's storm. A fight is now a place in the world rather than a
       * place instead of it -- the sun moves, the sky turns, the sea runs.
       *
       * Four things deliberately do NOT run here, and each is the pause
       * contract rather than an oversight. `ship.update`, because the hull is
       * halted and `battle.ts` is steering it. `records.hull.update` and
       * `quests.update`, which docs/ARCHITECTURE.md's pause contract puts in
       * the sailing branch alone, so a deadline cannot run out and a hull
       * cannot wear while the player is fighting rather than sailing. And
       * `aiBoats.update`, because the other raiders would otherwise close on
       * a ship that cannot steer, and `aiHulls.update` would take back the
       * very hull this fight has borrowed.
       */
      weatherCells.update(dt, ship.state, energy.state);
      wind.update(dt, ship.state, energy.state, weatherCells.state.stormAtShip);
      weather.update(dt, wind.state, weatherCells.state);
      hazards.update(
        dt,
        ship.state,
        energy.state,
        wind.state,
        1 + STORM_ODDS_GAIN * weather.state.storm,
      );

      // Only once the arena is actually on screen. Through the first fade the
      // world is still what is being drawn, and a fight that had started
      // behind it would be a second of shooting the player never saw.
      if (inArena) {
        battleSim.update(dt, battleUi.input(controls.input));
        // After the sim, so the hulls are where this tick put them before the
        // sea is asked whether a crest is over either of them.
        crestShoves(ship.object, 'player', SHOVE_PLAYER);
        if (contactHull) crestShoves(contactHull, 'ai', SHOVE_AI);
      }
      // The frame the fight is decided, and only that frame. The card prints
      // what was actually paid, so the money has to move before it is raised;
      // see `settleOutcome`.
      if (!outcomeSettled && battleSim.state.outcome !== null) {
        outcomeSettled = true;
        settleOutcome(battleSim.state.outcome);
      }
      // Both keep running after the outcome: `battle.ts` goes on circling the
      // boats and flying the balls, so the result card sits over a live scene
      // rather than over a freeze-frame.
      battleScene.update(dt, battleSim.state);
      battleUi.update(battleSim.state);
      hud.update(ship.state, energy.state, wind.state, weather.state);

      /*
       * The world's own draw, on the fight's camera.
       *
       * `globe.update` is what advances `env` -- the sun, the day factor, the
       * sky -- so it is what makes "the clock is still running" true on
       * screen rather than only in the sim. It is handed the FIGHT's camera
       * because it frames and sizes things against one, and last frame's
       * chase camera is not the one this frame is drawn through.
       */
      const battleWx = battleWeather(weather.state);
      globe.update(dt, env, wind.state, battleWx, weatherCells.state, ship.state, battleScene.camera);
      rain?.update(dt, ship.state, wind.state, battleWx, battleScene.camera);
      lightning.update(dt, ship.state, weather.state);
      // Before postFx.render, for the sailing branch's reason: it renders
      // into its own cube target and has to give the renderer back.
      reflection.update(dt, ship.state.position, renderer, scene);
      docks.update(dt, env, ship.state, energy.state, battleScene.camera);
      /*
       * The wake, which the sailing branch runs and this one used to skip.
       *
       * It is not decoration: `wakemap.ts` renders into a target the water
       * shader SAMPLES, so a branch that never ticks it leaves whatever the
       * hull last drew frozen into the sea for the length of the fight --
       * a stationary foam streak lying across the water beside the ring.
       *
       * The hull is halted, so what this actually does during a fight is let
       * the wake the player arrived on fade out properly, which is what the
       * water should look like once way is off the ship.
       */
      wake.update(dt, ship.state, env, renderer);
      timeDial?.update(ship.state, env);
      /*
       * One scene now, and that is the change.
       *
       * This used to render `battleScene.scene` -- a second Scene with its own
       * flat sea, its own sun and its own sky -- through a camera that lived
       * in it. The props hang in the WORLD scene now and the camera is a child
       * of them, so the fight is drawn on the globe's water, under the globe's
       * sky, in the globe's weather. `view.camera` still covers the first fade,
       * when the world is what is on screen and the ring is not yet placed.
       */
      postFx.render(dt, scene, inArena ? battleScene.camera : view.camera);
      // Not optional, and for the frozen branch's reason: `zoomDelta`
      // accumulates from the wheel whether anything reads it or not.
      controls.endFrame();

      requestAnimationFrame(frame);
      return;
    }

    // The world is frozen while either overlay is up. Derived from the overlays
    // themselves rather than latched at the call sites, because the fish book
    // closes on its own Escape key and its own close button and tells nobody: a
    // flag set where `open()` is called would strand the world stopped.
    // Hazards are not in the five calls below, deliberately: they are frozen
    // with the rest of the world, uniforms and all, so a crest bearing down on
    // the hull is exactly where it was when the card closes. The buttons that
    // open these overlays refuse to while `phase !== 'free'`, so no card can
    // be over a hull that is being carried.
    if (
      fishing.isOpen ||
      fishBook.isOpen ||
      shop.isOpen ||
      fishCover.isOpen ||
      questCover.isOpen ||
      battleCover.isOpen ||
      menu.isOpen
    ) {
      // The plant keeps running -- a session costs half the tank and the sun is
      // still up, so recharging through one is the point. It bills a resting
      // hull; see `restingSnapshot`. It also keeps the berth alive under the
      // shop: a chandlery that disconnected the ship the moment it opened
      // would make browsing cost the charge the visit was for.
      // The plant keeps running under a card, and keeps running in the
      // weather it was under when the card opened: `weather.update` is not
      // called on this branch, exactly as `wind.update` is not, so the sky
      // freezes with the rest of the world and a storm cannot quietly pass
      // while the player reads a menu.
      energy.update(dt, restingSnapshot(), env, overdriveActive, moonNightFraction, weather.state);
      if (fishing.isOpen) fishing.update(dt);
      // The plant is still running under the cover screen, so START FISHING
      // has to be re-read against it: a player who opens this at a berth on
      // 40% watches the button come alive without touching anything.
      if (fishCover.isOpen) fishCover.update();
      /*
       * The count into a fight -- the one thing in the frozen branch that
       * ADVANCES rather than merely repaints.
       *
       * Deliberately handed no `dt`. Everything else in this branch runs on
       * the frame loop's clock or on none at all, and this runs on the wall
       * clock instead, because three seconds on a card is a promise to the
       * player rather than a span of simulation: `dt` is capped at 100 ms, and
       * on a machine drawing this frozen frame at 4 fps that cap would stretch
       * the beat to seven and a half seconds. See MAX_TICK in
       * `battlecover.ts`, which is where the tab-throttling case the cap used
       * to cover is handled instead.
       */
      if (battleCover.isOpen) battleCover.update();
      hud.update(ship.state, energy.state, wind.state, weather.state);
      // Redrawn but not advanced: `env` is frozen with the rest of the world,
      // so this repaints the same reading. It has to run at all because the
      // canvas can still be resized behind the overlay, and a resized canvas
      // that is never drawn into is blank.
      timeDial?.update(ship.state, env);
      // A zero dt, so nothing animates, but the composer still redraws: the
      // frozen frame has to survive a window resize while the card is over it,
      // and a resized target that is never rendered into is a black screen.
      postFx.render(0, scene, view.camera);
      // Not optional. `zoomDelta` accumulates from the wheel whether or not
      // anything reads it, so a player scrolling under the card would bank a
      // minute of notches and dump the lot into the camera on the frame it
      // closes.
      controls.endFrame();

      requestAnimationFrame(frame);
      return;
    }

    // Power first, on last frame's speed: the ship must not spend energy it
    // turns out not to have. `globe.update` is what writes `env`, so the sun the
    // solar panels see is also one frame old -- 16 ms of a 10-minute day.
    /*
     * The towline, as it stood at the END of last frame.
     *
     * The plant runs before `derelicts.update` below, so the burn doubles one
     * frame after the hook goes on and stays doubled for one frame after it
     * comes off. That is 16 ms of a bill measured in minutes, and the
     * alternative -- moving the sim above the plant -- would cost the ordering
     * that actually matters: `hookReady` has to be written after this frame's
     * hazards so a maelstrom can suppress it, and the tow has to be placed
     * against a hull that has not moved yet.
     */
    energy.update(
      dt,
      ship.state,
      env,
      overdriveActive,
      moonNightFraction,
      weather.state,
      derelicts.state.live?.towed === true,
    );

    /*
     * The hull, immediately after the plant and for the same reason: it is a
     * reserve that moves with time and the weather, and it reads this frame's
     * docked verdict.
     *
     * This line is in the SAILING branch and nowhere else, which is the whole
     * of decision 12 in docs/HARBOURS_PLAN.md. The frozen branch above (the
     * menu, the shop, the fishing cover, a fishing session, the battle card)
     * and the arena branch both return before they reach it, so the hull
     * cannot wear while any of those own the screen. It is a property of where
     * the call sits rather than a flag `hull.ts` could be left stuck in.
     */
    const wx = weather.state;
    const weathered =
      wx.storm >= HULL_WEATHER_THRESHOLD ||
      wx.rain >= HULL_WEATHER_THRESHOLD ||
      wx.fog >= HULL_WEATHER_THRESHOLD;
    records.hull.update(dt, energy.state.mode === 'docked', weathered);

    /*
     * A harbour is remembered the moment the plant says the ship is alongside.
     *
     * `energy.state.mode === 'docked'` is this project's single definition of
     * moored -- `main.ts` already leans on it for the pause contract -- so
     * reading it here means the scope, the menu and the save can never
     * disagree with the power panel about whether a berth was reached.
     * `add` is idempotent and this runs every frame the ship sits still.
     */
    const berth =
      energy.state.mode === 'docked' ? globe.towns.dockAt(ship.state.position) : null;
    if (berth) records.known.add(berth.town.name);

    /*
     * Contracts, on the same beat and off the same verdict.
     *
     * Deliberately in the SAILING branch only, which is the whole of the pause
     * contract for this feature: the frozen branch (the menu, the shop, the
     * board, the fishing cover, a session, the battle card) and the arena
     * branch both return before they reach this line, so a deadline cannot run
     * out while an overlay owns the screen. That is a property of where the
     * call sits rather than a flag `quests.ts` could be left stuck in -- the
     * same argument that puts `records.hull.update` here and nowhere else.
     *
     * `env` is one frame old here, exactly as it is for `energy.update` above:
     * `globe.update` is what rewrites it and that runs at the foot of the
     * frame. Sixteen milliseconds of a twenty-minute day.
     */
    quests.update(dt, env.elapsed, env.sunDirection, berth?.town.name ?? null);
    // The strip runs on the same clock for the same reason: a notice raised as
    // a card opens must still be there when it closes.
    toast.update(dt);
    // `?quest=`, once, on the first sailing frame -- the first moment
    // `quests.offers` has a sun to judge a window against. False on every
    // ordinary session.
    if (questDevPending && questQuery !== null) {
      questDevPending = false;
      runQuestQuery(questQuery);
    }

    // Wind sits between the two: it needs this frame's docked verdict to know
    // whether the ship is in shelter, and the ship needs this frame's push.
    /*
     * The cells run BEFORE the wind, which is the one ordering constraint the
     * weather adds to this loop.
     *
     * A storm cell floors the wind's speed (`CELL_WIND_LIFT`), so the wind
     * has to read this frame's cell sample rather than last frame's -- the
     * same argument that already puts `wind.update` after `energy.update` for
     * the berth verdict it shelters behind.
     */
    weatherCells.update(dt, ship.state, energy.state);
    wind.update(dt, ship.state, energy.state, weatherCells.state.stormAtShip);
    /*
     * Then the weather itself: after the wind, because a squall is rolled off
     * this frame's phase, and before the hazards, because the storm
     * multiplier on their spawn rolls is this frame's storm.
     */
    weather.update(dt, wind.state, weatherCells.state);
    // One edge per entry, not per frame inside: what is being counted is how
    // often the player MEETS weather, which is the number the population was
    // sized against.
    const nowInCell =
      weatherCells.state.stormAtShip > 0.1 || weatherCells.state.fogAtShip > 0.1;
    if (nowInCell && !inCell) cellEncounters++;
    inCell = nowInCell;
    /*
     * What a storm does to the odds of meeting something.
     *
     * Computed here rather than inside either sim because both read the same
     * sky and must not develop two opinions of it -- the same argument
     * `suppressed()` below is computed here for.
     *
     * A word on what it actually buys, because "tripled" is only half true.
     * It triples the PROBABILITY in both. The raiders roll once every ten
     * seconds, nowhere near saturating their one-of-each-kind cap, and get
     * about 2.7x the encounters for it. The hazards roll every second at
     * odds that already refill a free slot almost immediately, so tripling
     * them buys about 1.5x. Both figures are measured in the unit tests.
     */
    const stormOdds = 1 + STORM_ODDS_GAIN * weather.state.storm;
    // `?cell=`, once, on the same beat as `?hazard=` and for the same reason:
    // a storm cell is a 0.6 draw every ten seconds against a bubble 250 units
    // across, so waiting for one to arrive at the ship is a vigil rather than
    // a test. Null on every ordinary session.
    if (forcedCell !== null) {
      cellCountdown -= dt;
      if (cellCountdown <= 0) {
        releaseForcedCell(forcedCell);
        forcedCell = null;
      }
    }
    // `?hunt=shoal`: a standing shoal rather than one shot. See
    // HUNT_RELAY_SECONDS. False on every ordinary session.
    if (forcedHunt && leviathan.state.phase === 'idle') {
      huntCountdown -= dt;
      if (huntCountdown <= 0) {
        leviathan.force(ship.state, forcedHuntArmed);
        huntCountdown = HUNT_RELAY_SECONDS;
        // Queued on the lay rather than on a wall clock, so the two seconds
        // are two seconds of the sim the picture is being taken of.
        if (forcedEnding !== null) endingCountdown = 2;
      }
    }

    /*
     * The forced ending, two simulated seconds after the shoal was laid.
     *
     * `scatter()` is the sim's own public way to end a hunt and is what a
     * wreck already calls, so `?hunt=scatter` needs nothing new. The other two
     * are reached through `fire()`, which is the honest route: a settled hunt
     * is five presses and a sounded one is a press under the threshold, and
     * forcing the STATE rather than the presses would photograph a picture the
     * game cannot actually produce.
     */
    if (endingCountdown !== null && leviathan.state.phase === 'drifting') {
      endingCountdown -= dt;
      if (endingCountdown <= 0) {
        endingCountdown = null;
        if (forcedEnding === 'scatter') {
          leviathan.scatter();
        } else if (forcedEnding === 'settle') {
          /*
           * Five banked targets, re-laying the animal on the bow between each.
           *
           * The re-lay is not a cheat around the gate, it is a substitute for
           * the HELM. After item 6 the mark walks up the body away from the
           * hull, so a stationary tier loses it after the first handoff; a
           * player would chase up the body and this cannot. Every press below
           * still has to arm, still has to wait out `ARM_UP`, and still has to
           * beat `SOUND_BELOW` or the hunt sounds instead — which is why it
           * waits for the needle rather than pressing on sight.
           */
          for (let target = 0; target < HUNT_TARGETS; target++) {
            if (leviathan.state.phase !== 'drifting') break;
            /*
             * Re-laid before EVERY press, including the first.
             *
             * The two seconds this waits after the shoal appears — which are
             * there so the arrival has played before the picture is taken —
             * are also two seconds of drift, and at four to six units a second
             * that is enough to carry the mark out of a twelve-unit gate. The
             * first press was failing for exactly that reason and the hunt was
             * then lost passively, which reaches the screen as `sounded` and
             * looks like a bug in the endings rather than a mark that drifted.
             */
            leviathan.force(ship.state, true, true);
            /*
             * Topped up before every press. The locker is SHARED with fishing
             * and a fresh save carries exactly one bundle — five spares, which
             * is exactly five presses with nothing spare for a refused one. A
             * single `dry` press here would leave the hunt unfinished and the
             * animal would then be lost passively, which photographs as
             * `sounded` and looks like a bug in the endings rather than an
             * empty locker.
             */
            while (records.harpoons.count < 1 && records.harpoons.buy()) {
              /* one bundle a turn until there is something to throw */
            }
            let banked = false;
            for (let i = 0; i < 4000 && !banked; i++) {
              if (leviathan.state.phase !== 'drifting') break;
              leviathan.update(1 / 240, ship.state, false);
              if (!leviathan.state.ready) continue;
              // Comfortably green, so no press here can ever be the one that
              // sounds the animal and turns this into the wrong picture.
              if (damageAt(leviathan.state.dial) <= 80) continue;
              banked = leviathan.fire() >= 0;
            }
          }
        } else if (forcedEnding === 'sound') {
          /*
           * A press feeble enough to sound the animal cannot be taken on
           * demand — the sweep has to have run past the centre and out to the
           * far red, which after `ARM_UP` is over a second away. So this runs
           * the sim until the needle is there and presses then, which is
           * exactly what a player would have to do.
           */
          for (let i = 0; i < 2000 && leviathan.state.phase === 'drifting'; i++) {
            leviathan.update(1 / 240, ship.state, false);
            const live = leviathan.state;
            if (live.ready && damageAt(live.dial) > 0 && damageAt(live.dial) < SOUND_BELOW) {
              leviathan.fire();
              break;
            }
          }
        }
      }
    }

    // `?hazard=`, once, three seconds in. Null on every ordinary session.
    if (forcedHazard !== null) {
      forceCountdown -= dt;
      if (forceCountdown <= 0) {
        releaseForcedHazard(forcedHazard);
        forcedHazard = null;
      }
    }
    // `?boat=` and `?battle=`, once, on the same beat. Both are false on every
    // ordinary session. They run before `aiBoats.update` so the boat they
    // force is transported and tested for contact on the very frame it lands,
    // which is what makes `?battle=1` open the arena rather than merely put a
    // hull on the water.
    if (forcedBoat !== null || forcedBattle || forcedSalvage !== null || forcedDerelict !== null) {
      boatCountdown -= dt;
      if (boatCountdown <= 0) {
        if (forcedBoat !== null && aimAtShip(BOAT_FORCE_DISTANCE)) {
          aiBoats.force(forcedBoat, _forceCentre, _forceNorth);
        }
        if (forcedBattle && aimAtShip(BATTLE_FORCE_DISTANCE)) {
          aiBoats.force('orange', _forceCentre, _forceNorth);
        }
        /*
         * `FORCE_DISTANCE` -- the forced hazard's 25 units -- rather than the
         * raider's 45: a raft is a thing to be steered at and then touched, so
         * it wants to be close enough to reach while still being visibly out
         * there. Nothing is aimed, so there is no chase to preserve.
         *
         * `take` puts it a unit off instead, which is `BATTLE_FORCE_DISTANCE`'s
         * own trick: well inside `salvage.ts`'s TAKE_RADIUS, so the very next
         * `salvage.update` collects it and the payout path runs without anybody
         * having to steer.
         */
        if (forcedSalvage !== null) {
          const reach = forcedSalvage === 'take' ? BATTLE_FORCE_DISTANCE : FORCE_DISTANCE;
          if (aimAtShip(reach)) salvage.force(_forceCentre);
        }
        // Nearer than the raft's 25: a derelict has to be come ALONGSIDE rather
        // than run over, so it is put just outside its own hook ring, close
        // enough that a look at it does not begin with a minute of steering --
        // or just inside it, for `hook`.
        if (forcedDerelict !== null) {
          const reach = forcedDerelict === 'hook' ? HOOK_RADIUS - 1 : DERELICT_FORCE_DISTANCE;
          if (aimAtShip(reach)) derelicts.force(_forceCentre);
        }
        forcedBoat = null;
        forcedBattle = false;
        forcedSalvage = null;
        forcedDerelict = null;
      }
    }
    // Hazards sit between the wind and the ship, for both of the wind's own
    // reasons: after the wind because a berth is shelter from rough water too
    // and `energy.ts` owns the one definition of docked, and before the ship
    // because the ship spends the push -- and obeys the drive -- this same
    // frame. The water plugin reads the same state inside `globe.update`
    // below, after the hull has ridden it, so the sea on the GPU and the sea
    // the hull just climbed are one frame's numbers.
    hazards.update(dt, ship.state, energy.state, wind.state, stormOdds);
    // Republished for `tests/shots.mjs`, which waits on an envelope rather
    // than on a clock -- see the field's own comment in `quality.ts`. The
    // hook only exists under `?quality=` or `?debug`, so this is a no-op in
    // an ordinary session and allocates nothing in one.
    if (window.__pirateWorld) {
      window.__pirateWorld.hazards = hazards.state.live.map((h) => ({
        kind: h.kind,
        envelope: h.envelope,
      }));
      // The hunt, on the same terms and for the same reason: a shoal cannot
      // be photographed on a timer, and one that scattered leaves nothing on
      // the water to say so. `markRange` and `markOffBow` are the two numbers
      // the arc gate is made of, published so a shot can be taken at the
      // moment the dial arms rather than a second either side of it.
      {
        const mark = leviathan.state.shadows.find((s) => s.marked) ?? null;
        let markRange = -1;
        let markOffBow = -1;
        if (mark !== null) {
          const pos = ship.state.position;
          markRange = Math.acos(Math.max(-1, Math.min(1, pos.dot(mark.position)))) * GLOBE_RADIUS;
          _markBearing.copy(mark.position).addScaledVector(pos, -mark.position.dot(pos));
          if (_markBearing.lengthSq() > 1e-12) {
            _markBearing.normalize();
            // Signed, and signed off the STARBOARD vector rather than off a
            // bearing subtraction: negative is to port, positive to
            // starboard, and it means the same thing at a pole as at the
            // equator. A shot that has to steer onto the mark needs to know
            // which way, and an unsigned angle makes that a coin toss.
            const cos = Math.max(-1, Math.min(1, ship.state.forward.dot(_markBearing)));
            _markStarboard.crossVectors(ship.state.forward, pos);
            const sense = _markStarboard.dot(_markBearing) >= 0 ? 1 : -1;
            markOffBow = (sense * Math.acos(cos) * 180) / Math.PI;
          }
        }
        window.__pirateWorld.hunt = {
          phase: leviathan.state.phase,
          shadows: leviathan.state.shadows.length,
          armed: leviathan.state.armed,
          dial: leviathan.state.dial,
          target: leviathan.state.target,
          banked: leviathan.state.banked,
          markRange,
          markOffBow,
          sprites: shadowField.visible,
          /*
           * Phase 2's rows. `gate` and `ready` are here because the browser
           * tier cannot steer and therefore cannot otherwise tell a dark bar
           * apart from a bar that is merely still charging — and after item 3
           * those are two different states with two different fixes.
           *
           * `shadowPath` closes the gap `sprites` alone leaves: a count of
           * zero means "the sprite pool drew nothing", which is a BUG on the
           * sprite tier and the correct answer on the shader tier. Reporting
           * which renderer was asked to draw is what separates them.
           */
          gate: leviathan.state.gate,
          ready: leviathan.state.ready,
          level: leviathan.state.level,
          multiplier: leviathan.state.multiplier,
          ending: leviathan.state.ending,
          mark: leviathan.state.mark,
          shadowPath: quality.huntShadows,
          effects: huntFx.live,
        };
      }
      window.__pirateWorld.salvage = {
        rafts: salvage.state.live.map((raft) => ({
          distance:
            Math.acos(Math.max(-1, Math.min(1, raft.position.dot(ship.state.position)))) *
            GLOBE_RADIUS,
          envelope: raft.envelope,
        })),
        taken: salvageTaken,
      };
      window.__pirateWorld.derelict = {
        distance:
          derelicts.state.live === null
            ? -1
            : Math.acos(
                Math.max(-1, Math.min(1, derelicts.state.live.position.dot(ship.state.position))),
              ) * GLOBE_RADIUS,
        towed: derelicts.state.live?.towed === true,
        hookReady: derelicts.state.hookReady,
        bound: derelicts.state.live?.bound ?? null,
        settled: towsSettled,
      };
      window.__pirateWorld.weather = {
        kind: weather.state.kind,
        storm: weather.state.storm,
        fog: weather.state.fog,
        rain: weather.state.rain,
        // Published for the same reason as the rest: a shot of lightning has
        // to wait for a strike rather than for a clock, because a bolt is lit
        // for a third of a second every several seconds and a screenshot
        // taken on a timer will almost always miss it.
        flash: weather.state.flash,
        visibility: weather.state.visibility,
        encounters: cellEncounters,
        cells: weatherCells.state.live.map((c) => ({
          kind: c.kind,
          radius: c.radius,
          strength: c.strength,
          distance:
            Math.acos(Math.max(-1, Math.min(1, c.centre.dot(ship.state.position)))) * GLOBE_RADIUS,
        })),
      };
    }
    // Raiders sit between the hazards and the ship, and both sides of that are
    // load bearing. After the hazards because a boat is suppressed while a
    // maelstrom has the hull and it needs this frame's phase to know it.
    // Before the ship because a contact has to halt the hull the same frame it
    // happens: `onContact` calls `ship.halt()` and flips the overlay, and the
    // `ship.update` below then runs on a hull that is already stopped.
    aiBoats.update(dt, ship.state, energy.state, hazards.state, suppressed(), stormOdds);

    /*
     * The hunt, and it is on THIS branch and no other.
     *
     * Immediately after the raiders and before the ship, for `aiBoats`'s own
     * reason turned round: it reads last frame's `ship.state` for the range
     * and arc gate, and it has to read the hull where the PLAYER saw it when
     * they pressed. Moving this below `ship.update` would arm the dial against
     * a bow that had already turned under the keystroke.
     *
     * The same `suppressed()` verdict the raiders get -- docked, mid-blackout,
     * or in a maelstrom. It blocks the roll, it holds the dial dark, and it
     * scatters a hunt already under way, paying what was banked: a hull in a
     * spiral is not one the player is steering, and a maelstrom that silently
     * swallowed a worked shoal would be the game taking back gold it had
     * already shown.
     *
     * Nothing equivalent goes in the frozen branch or the battle branch, and
     * that is the pause contract holding rather than an oversight: an overlay
     * opening over a hunt, or a fight starting in the middle of one, ends it
     * through this same path.
     */
    leviathan.update(dt, ship.state, suppressed());

    // Beside the raiders, on the same verdict, and before the ship for the
    // mirror of the raiders' reason: a raft reached this frame pays this frame,
    // and the notice it raises belongs to the frame the timber went under the
    // bow rather than the one after it.
    salvage.update(dt, ship.state, wind.state, suppressed(), weather.state);
    // With the salvage, on the same verdict. Before the ship because the hook
    // ring's offer has to be true on the frame the player's `Space` is read,
    // and because a towed hull is placed against the ship's position either
    // way -- see `derelict.ts`'s `tow`.
    derelicts.update(dt, ship.state, wind.state, suppressed(), weather.state);
    // The two ways a tow ends that are not the player's doing. The maelstrom's
    // half lives in `onSunk`; this is the tank, tested every frame because it
    // can be reached by burning as easily as by losing a fight.
    if (energy.state.level <= 0) loseTow('power');
    settleTow();
    // The Navigation offers' one read this frame: the higher of Trim &
    // Sheathing's tier and an Overdrive Coil's burn speed -- never their sum,
    // see `types.ts`'s `PropulsionState` -- and whether a Sea Anchor is still
    // in its kill-and-hold window.
    const towing = derelicts.state.live?.towed === true;
    const propulsion: PropulsionState = {
      maxForward: overdriveActive ? OVERDRIVE_MAX_FORWARD : records.trim.maxForward,
      anchored: records.seaAnchor.isDeployed,
      /*
       * A tow is a LOAD, not a purchase, which is why it is a separate field
       * rather than a smaller `maxForward` from here.
       *
       * `ship.ts` takes `min(maxForward, hull.speedCap)` and applies this to
       * the RESULT. Folded into `maxForward` it would join that `min` instead,
       * and a hull worn below 25% -- capped at 5 kn -- would tow at 5 and feel
       * no penalty at all, in exactly the state it should hurt most.
       * docs/HARBOURS_PLAN.md's decision 14 is about what a player BOUGHT being
       * overridden by a worn hull; a dead ship on the end of a rope is not
       * something they bought.
       */
      towFactor: towing ? TOW_SPEED_SHARE : 1,
    };
    ship.update(
      dt,
      controls.input,
      energy.state,
      wind.state,
      globe.waveOffsets,
      hazards.state,
      propulsion,
    );
    view.update(dt, ship.state, controls.input);
    // After the ship and before `globe.update`: this only places and lights
    // meshes from the state the sim wrote above, and nothing reads them until
    // the render at the foot of the frame.
    aiHulls.update(dt, aiBoats.state);
    salvageRafts.update(dt, salvage.state);
    derelictHull.update(dt, derelicts.state);
    // Beside the hulls, on the same terms and for the same reason: it places
    // sprites from a state already written and nothing reads them until the
    // render at the foot of the frame.
    shadowField.update(dt, leviathan.state);
    // Beside the shadows, on the same terms: both only PLACE things, and the
    // camera has already moved this frame, so the reticle lands on the water
    // where the player is about to see it rather than one frame behind.
    huntReticle.update(dt, leviathan.state, ship.state);
    huntFx.update(dt, leviathan.state, ship.state);
    huntTells.update(dt, leviathan.state, 1 - env.dayFactor);
    // The bar is a HUD element rather than a scene object, so it could sit
    // anywhere below the sim; it is here so that everything the hunt touches
    // in a frame reads as one block.
    huntDial.update(leviathan.state);
    // After the dial, because these three read the camera that `view.update`
    // settled above and project through it. A HUD element that projected
    // against last frame's camera would lag the thing it is pointing at by
    // exactly the amount the player was turning.
    huntPointer.update(leviathan.state, view.camera, ship.state);
    huntNumbers.update(dt);
    screenFx.update(dt, leviathan.state);
    huntAudio.update(dt, leviathan.state);
    globe.update(
      dt,
      env,
      wind.state,
      weather.state,
      weatherCells.state,
      ship.state,
      view.camera,
    );
    // After `globe.update`: the box hangs on the hull the camera has just
    // been framed against, and nothing reads it until the render. The camera
    // is not a courtesy — the box is SIZED off its distance, so it has to be
    // this frame's camera and not last frame's.
    rain?.update(dt, ship.state, wind.state, weather.state, view.camera);
    // Alongside the rain and for the same reason: it hangs on the hull the
    // camera has just been framed against, and nothing reads it until the
    // render at the foot of the frame.
    lightning.update(dt, ship.state, weather.state);
    // Before postFx.render: it renders straight into its own cube target and
    // must restore the renderer's target before the visible frame draws, or
    // the game renders into its own reflection cube and the canvas goes black.
    reflection.update(dt, ship.state.position, renderer, scene);
    // The camera, because the harbour labels fade from the LENS and not from
    // the boat: the chase camera runs 23 to 211 units back, so a fade
    // measured at the hull would switch a name off while it was still a
    // legible mark on screen. Labels ship invisible, so omitting this would
    // silently draw none of them at all.
    docks.update(dt, env, ship.state, energy.state, view.camera);
    wake.update(dt, ship.state, env, renderer);
    hud.update(ship.state, energy.state, wind.state, weather.state);
    /*
     * The contract line, after the HUD's own sweep and for the same reason the
     * dial comes after `globe.update`: it reads `env.sunDirection` to decide
     * whether a window is open at the target, and reading it earlier in the
     * frame would put the line one frame behind the sky it describes.
     *
     * In the sailing branch only. The frozen branch has nothing to redraw here
     * -- the clocks are world time and the world is stopped, so the text on the
     * element is already right -- which is the one place this differs from the
     * time dial, whose canvas can be resized behind an overlay and come back
     * blank.
     */
    hud.updateQuest(urgentQuest(), towLine());
    hud.updateTow(towing);
    radar.update(
      dt,
      ship.state,
      wind.state,
      hazards.state,
      aiBoats.state,
      weather.state,
      weatherCells.state,
      chart,
      leviathan.state,
      salvage.state,
      derelicts.state,
    );
    // After globe.update, which is what writes `env.sunDirection`. Reading it
    // before would put the dial a frame behind the sky it is describing.
    timeDial?.update(ship.state, env);

    postFx.render(dt, scene, view.camera);
    // Reads postFx's rolling means straight back off the frame that just
    // rendered. Cheap to call every frame -- hud.ts's write-through cache is
    // what actually costs nothing while the row is hidden.
    if (devTimingVisible) hud.updateDevTiming(postFx.getStats());
    controls.endFrame();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
