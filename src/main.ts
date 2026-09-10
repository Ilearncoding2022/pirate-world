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
import { createHazards } from './hazards';
import { createWaterHazardPlugin } from './waterhazard';
import { createBlackout } from './blackout';
import { createAiBoats } from './aiboats';
import { createAiHulls } from './aihulls';
import { createBattleScene } from './battlescene';
import { createBattleSim } from './battle';
import { CALM, ROUGH } from './battlesea';
import { createBattleUi } from './battleui';
import { createBattleCover } from './battlecover';
import { createMenu, formatBearing, formatDistance } from './menu';
import { createQuests, daylightLeft, formatSpan } from './quests';
import { createQuestCover } from './questcover';
import { createToast } from './toast';
import { QUEST_URGENT_BELOW } from './hud';
import { solarPhase } from './solartime';
import { lossGold, rollDrawGold, rollWinGold } from './bounty';
import type {
  AiBoat,
  AiBoatKind,
  ActiveQuest,
  BattleOutcome,
  HazardKind,
  PropulsionState,
  QuestOffer,
  ShipState,
} from './types';
import type { QuestLineInput } from './hud';
import { GLOBE_RADIUS, tangentFrame } from './geo';
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

  const waterPlugins = [createWaterWakePlugin(wake), waterHazard];
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
  /**
   * How much storm makes a fight rough.
   *
   * Half. Above it the sea outside is visibly running and a flat arena would
   * read as a different ocean; below it the crests would be arriving out of a
   * sky that has not earned them.
   */
  const BATTLE_STORM_GATE = 0.5;
  function battleSeaFor(): typeof CALM {
    if (forcedCalm) return CALM;
    if (forcedRough) return ROUGH;
    return weather.state.storm > BATTLE_STORM_GATE ? ROUGH : CALM;
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
    battleCover.open(boat.kind, records.hull.state.hitsToLose);
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
      inArena = true;
      // With the arena. The world's instruments are hidden from here rather
      // than from `open()` so the change happens on a screen that is already
      // opaque: hiding them the moment the fight was declared would pop the
      // whole HUD out in front of a player who is still looking at the sea.
      // See the `body.in-battle` block in `style.css` for what goes and why.
      document.body.classList.add('in-battle');
    });
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
    // A ship carrying way into the ring is stopped by the mooring itself --
    // `ship.ts` writes a dead stop the moment `mode` reads docked -- so this
    // needs no `halt()` of its own the way [SHOP] does.
    energy.toggleMooring();
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
    hazardQuery === 'wave' || hazardQuery === 'maelstrom'
      ? hazardQuery
      : null;
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
    if (!aimAtShip(FORCE_DISTANCE)) return;
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
      // Only once the arena is actually on screen. Through the first fade the
      // world is still what is being drawn, and a fight that had started
      // behind it would be a second of shooting the player never saw.
      if (inArena) battleSim.update(dt, battleUi.input(controls.input));
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
      // Redrawn but not advanced, for the frozen branch's reason: `env` is not
      // rewritten during a fight, so this repaints the same reading, and a
      // canvas resized behind the overlay that is never drawn into is blank.
      timeDial?.update(ship.state, env);
      // The one thing this branch cannot share with the frozen one. That
      // branch renders the world at dt 0 to hold a still frame; this renders a
      // different scene through a different camera, and it renders it LIVE --
      // the arena is the game while it is up.
      postFx.render(
        dt,
        inArena ? battleScene.scene : scene,
        inArena ? battleScene.camera : view.camera,
      );
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
    energy.update(dt, ship.state, env, overdriveActive, moonNightFraction, weather.state);

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
    if (forcedBoat !== null || forcedBattle) {
      boatCountdown -= dt;
      if (boatCountdown <= 0) {
        if (forcedBoat !== null && aimAtShip(BOAT_FORCE_DISTANCE)) {
          aiBoats.force(forcedBoat, _forceCentre, _forceNorth);
        }
        if (forcedBattle && aimAtShip(BATTLE_FORCE_DISTANCE)) {
          aiBoats.force('orange', _forceCentre, _forceNorth);
        }
        forcedBoat = null;
        forcedBattle = false;
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
    // The Navigation offers' one read this frame: the higher of Trim &
    // Sheathing's tier and an Overdrive Coil's burn speed -- never their sum,
    // see `types.ts`'s `PropulsionState` -- and whether a Sea Anchor is still
    // in its kill-and-hold window.
    const propulsion: PropulsionState = {
      maxForward: overdriveActive ? OVERDRIVE_MAX_FORWARD : records.trim.maxForward,
      anchored: records.seaAnchor.isDeployed,
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
    hud.updateQuest(urgentQuest());
    radar.update(
      dt,
      ship.state,
      wind.state,
      hazards.state,
      aiBoats.state,
      weather.state,
      weatherCells.state,
      chart,
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
