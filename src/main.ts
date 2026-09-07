import * as THREE from 'three';
import './style.css';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import { createGlobe } from './globe';
import { createShip } from './ship';
import { createWake } from './wake';
import { createWaterWakePlugin } from './waterwake';
import { createFollowCamera } from './camera';
import { createControls } from './controls';
import { createHud } from './hud';
import { createRadar } from './radar';
import { createTimeDial } from './timedial';
import { createEnv } from './env';
import { createEnergy } from './energy';
import { createWind } from './wind';
import { createDocks } from './docks';
import { createPostFx } from './postfx';
import { createRecords } from './save';
import { createFishing } from './fishing';
import { createFishBook } from './fishbook';
import { createFishCover } from './fishcover';
import { createShop } from './shop';
import { createLoading } from './loading';
import { createQuality } from './quality';
import { createReflection } from './reflection';
import { createWaterReflectPlugin } from './waterreflect';
import type { ShipState } from './types';

/*
 * `?probe=wave` (Phase 1 stream B) is the only entry point into
 * `dev/probe.ts`, and this is the one guarded line that reaches it. The
 * import is dynamic and inside this branch specifically so a normal load
 * never fetches the probe module at all -- Vite code-splits it into its own
 * chunk, which an ordinary player's session never requests. Nothing else in
 * `main.ts` or `index.html` may reference a probe; the integration agent
 * greps for exactly that.
 */
const probeQuery = new URLSearchParams(window.location.search).get('probe');
if (probeQuery === 'wave') {
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
  const terrain = createTerrain(DEFAULT_SEED);

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

  const waterPlugins = [createWaterWakePlugin(wake)];
  if (reflection.texture) waterPlugins.push(createWaterReflectPlugin(reflection.texture));

  // The long synchronous stage: the height map is rasterised, the islets are
  // culled, the land mask is installed and the towns are placed, all on the
  // main thread. Nothing paints from here until it returns, which is exactly
  // why the bar was moved and painted first.
  await loading.step(0.20, 'RAISING THE LAND');

  const globe = createGlobe(terrain, quality, waterPlugins);
  scene.add(globe.group);
  scene.add(wake.object);

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
  const ship = createShip(
    terrain,
    {
      latDeg: SPAWN_LAT_DEG,
      lonDeg: SPAWN_LON_DEG,
      headingDeg: 90,
    },
    renderer.capabilities.getMaxAnisotropy(),
    (fraction) => loading.set(HULL_FROM + (HULL_TO - HULL_FROM) * fraction),
  );
  scene.add(ship.object);

  // Everything the player keeps across reloads, in one call. `createRecords` is
  // the single entry point for persistence precisely so that no caller can wire
  // half of it and end up with a wallet that saves and a fish book that does not.
  //
  // It comes before the power plant now, because the plant is built around the
  // backup cell and the cell's charge is one of the things that survives a
  // reload.
  const records = createRecords();

  // Power plant. Built from the world's berths and the bought backup cell,
  // read by the ship (thrust gate), the HUD, the model's neon and the dock
  // rings.
  const energy = createEnergy(globe.towns, records.battery);

  // Weather. Reads the same height field the radar plots, so the sheltered water
  // on the scope is the sheltered water the ship finds.
  const wind = createWind(terrain, globe.heightMap);

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

  const hud = createHud(records.wallet);
  const radar = createRadar(globe.heightMap, globe.waterBodies, terrain.seaLevel, globe.towns);
  const timeDialCanvas = document.getElementById('hud-timedial');
  const timeDial =
    timeDialCanvas instanceof HTMLCanvasElement ? createTimeDial(timeDialCanvas) : null;
  const postFx = createPostFx(renderer, quality);

  // The two overlays. Neither is a scene: they own their own DOM over the frozen
  // frame, and the only thing this file does for them is stop the world.
  const fishing = createFishing({
    energy,
    wallet: records.wallet,
    book: records.book,
    harpoons: records.harpoons,
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
    onStart: () => fishing.open(),
    onRecord: () => fishBook.open(),
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
  });

  // hud.ts owns whether [FISH] looks pressable; this owns what pressing it does.
  // The overlay test is here and not in the HUD because the HUD does not know
  // the overlays exist, and `fishing.open()` re-tests the tank on its own
  // account -- a disabled attribute is an affordance, never a lock.
  document.getElementById('btn-fish')?.addEventListener('click', () => {
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen) return;
    fishCover.open();
  });

  // The berth is re-tested here rather than trusted off the button, on the
  // same terms as [FISH]: `hud.ts` writes the disabled attribute as an
  // affordance and a disabled attribute is not a lock. `energy.mode` is the
  // project's one definition of docked, so this and the key agree by
  // construction.
  document.getElementById('btn-shop')?.addEventListener('click', () => {
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen) return;
    if (energy.state.mode !== 'docked') return;
    // The hull is already stopped -- a berth is a two-second dwell -- but the
    // halt is what makes "the world resumes from rest" true of this overlay
    // as well as of the fishing card.
    ship.halt();
    shop.open();
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
  }
  window.addEventListener('resize', onResize);

  // Dev overlay (GPU ms / CPU ms / draw calls): off by default, toggled with
  // Backquote. The query itself has a real GPU cost, so postFx only issues it
  // while this is on; hud.ts owns the DOM row this feeds.
  let devTimingVisible = false;
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Backquote') return;
    devTimingVisible = !devTimingVisible;
    postFx.setTimingEnabled(devTimingVisible);
    hud.setDevTimingVisible(devTimingVisible);
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
  globe.update(WARM_DT, env, wind.state, ship.state, view.camera);
  postFx.render(WARM_DT, scene, view.camera);
  controls.endFrame();

  await loading.step(1, 'READY');
  await loading.done();

  const clock = new THREE.Clock();

  function frame(): void {
    const dt = Math.min(clock.getDelta(), 0.1);

    // The world is frozen while either overlay is up. Derived from the overlays
    // themselves rather than latched at the call sites, because the fish book
    // closes on its own Escape key and its own close button and tells nobody: a
    // flag set where `open()` is called would strand the world stopped.
    if (fishing.isOpen || fishBook.isOpen || shop.isOpen || fishCover.isOpen) {
      // The plant keeps running -- a session costs half the tank and the sun is
      // still up, so recharging through one is the point. It bills a resting
      // hull; see `restingSnapshot`. It also keeps the berth alive under the
      // shop: a chandlery that disconnected the ship the moment it opened
      // would make browsing cost the charge the visit was for.
      energy.update(dt, restingSnapshot(), env);
      if (fishing.isOpen) fishing.update(dt);
      // The plant is still running under the cover screen, so START FISHING
      // has to be re-read against it: a player who opens this at a berth on
      // 40% watches the button come alive without touching anything.
      if (fishCover.isOpen) fishCover.update();
      hud.update(ship.state, energy.state, wind.state);
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
    energy.update(dt, ship.state, env);
    // Wind sits between the two: it needs this frame's docked verdict to know
    // whether the ship is in shelter, and the ship needs this frame's push.
    wind.update(dt, ship.state, energy.state);
    ship.update(dt, controls.input, energy.state, wind.state, globe.waveOffsets);
    view.update(dt, ship.state, controls.input);
    globe.update(dt, env, wind.state, ship.state, view.camera);
    // Before postFx.render: it renders straight into its own cube target and
    // must restore the renderer's target before the visible frame draws, or
    // the game renders into its own reflection cube and the canvas goes black.
    reflection.update(dt, ship.state.position, renderer, scene);
    docks.update(dt, env, ship.state, energy.state);
    wake.update(dt, ship.state, env, renderer);
    hud.update(ship.state, energy.state, wind.state);
    radar.update(dt, ship.state, wind.state);
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
