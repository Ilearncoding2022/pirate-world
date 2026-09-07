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
  void import('./dev/probe').then((probe) => probe.runProbe());
} else {
  startGame();
}

function startGame(): void {
  const host = document.getElementById('app');
  if (!host) throw new Error('#app host element not found in index.html');

  // Resolved once, before anything below reads a row of its table -- see
  // quality.ts. `?quality=` beats a stored choice beats the 'high' default.
  const quality = createQuality();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x05080f, 1);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

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

  const globe = createGlobe(terrain, quality, waterPlugins);
  scene.add(globe.group);
  scene.add(wake.object);

  const ship = createShip(
    terrain,
    {
      latDeg: SPAWN_LAT_DEG,
      lonDeg: SPAWN_LON_DEG,
      headingDeg: 90,
    },
    renderer.capabilities.getMaxAnisotropy(),
  );
  scene.add(ship.object);

  // Power plant. Built from the world's berths, read by the ship (thrust gate),
  // the HUD, the model's neon and the dock rings.
  const energy = createEnergy(globe.towns);

  // Weather. Reads the same height field the radar plots, so the sheltered water
  // on the scope is the sheltered water the ship finds.
  const wind = createWind(terrain, globe.heightMap);

  const docks = createDocks(globe.towns);
  scene.add(docks.object);

  const view = createFollowCamera(window.innerWidth / window.innerHeight);
  const controls = createControls();

  // Everything the player keeps across reloads, in one call. `createRecords` is
  // the single entry point for persistence precisely so that no caller can wire
  // half of it and end up with a wallet that saves and a fish book that does not.
  const records = createRecords();

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

  // hud.ts owns whether [FISH] looks pressable; this owns what pressing it does.
  // The overlay test is here and not in the HUD because the HUD does not know
  // the overlays exist, and `fishing.open()` re-tests the tank on its own
  // account -- a disabled attribute is an affordance, never a lock.
  document.getElementById('btn-fish')?.addEventListener('click', () => {
    if (fishing.isOpen || fishBook.isOpen) return;
    fishing.open();
  });

  document.getElementById('btn-fishbook')?.addEventListener('click', () => {
    if (fishing.isOpen || fishBook.isOpen) return;
    fishBook.open();
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

  // The composer patches a scene's materials once, on its first frame. The glTF
  // hull arrives after that, so it has to be handed over explicitly or it renders
  // unencoded and a stop too dark.
  void ship.ready.then(() => postFx.adopt(ship.object));

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

  const clock = new THREE.Clock();

  function frame(): void {
    const dt = Math.min(clock.getDelta(), 0.1);

    // The world is frozen while either overlay is up. Derived from the overlays
    // themselves rather than latched at the call sites, because the fish book
    // closes on its own Escape key and its own close button and tells nobody: a
    // flag set where `open()` is called would strand the world stopped.
    if (fishing.isOpen || fishBook.isOpen) {
      // The plant keeps running -- a session costs half the tank and the sun is
      // still up, so recharging through one is the point. It bills a resting
      // hull; see `restingSnapshot`.
      energy.update(dt, restingSnapshot(), env);
      if (fishing.isOpen) fishing.update(dt);
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
