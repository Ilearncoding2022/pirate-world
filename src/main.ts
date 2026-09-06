import * as THREE from 'three';
import './style.css';
import { createTerrain, DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import { createGlobe } from './globe';
import { createShip } from './ship';
import { createWake } from './wake';
import { createFollowCamera } from './camera';
import { createControls } from './controls';
import { createHud } from './hud';
import { createRadar } from './radar';
import { createEnv } from './env';
import { createEnergy } from './energy';
import { createWind } from './wind';
import { createDocks } from './docks';
import { createPostFx } from './postfx';

const host = document.getElementById('app');
if (!host) throw new Error('#app host element not found in index.html');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x05080f, 1);
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const env = createEnv();
const terrain = createTerrain(DEFAULT_SEED);
const globe = createGlobe(terrain);
scene.add(globe.group);

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

const wake = createWake();
scene.add(wake.object);

const view = createFollowCamera(window.innerWidth / window.innerHeight);
const controls = createControls();
const hud = createHud();
const radar = createRadar(globe.heightMap, globe.waterBodies, terrain.seaLevel, globe.towns);
const postFx = createPostFx(renderer);

// The composer patches a scene's materials once, on its first frame. The glTF
// hull arrives after that, so it has to be handed over explicitly or it renders
// unencoded and a stop too dark.
void ship.ready.then(() => postFx.adopt(ship.object));

function onResize(): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  postFx.resize(window.innerWidth, window.innerHeight);
  view.resize(window.innerWidth / window.innerHeight);
}
window.addEventListener('resize', onResize);

const clock = new THREE.Clock();

function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.1);

  // Power first, on last frame's speed: the ship must not spend energy it
  // turns out not to have. `globe.update` is what writes `env`, so the sun the
  // solar panels see is also one frame old -- 16 ms of a 30-minute day.
  energy.update(dt, ship.state, env);
  // Wind sits between the two: it needs this frame's docked verdict to know
  // whether the ship is in shelter, and the ship needs this frame's push.
  wind.update(dt, ship.state, energy.state);
  ship.update(dt, controls.input, energy.state, wind.state);
  view.update(dt, ship.state, controls.input);
  globe.update(dt, env, wind.state);
  docks.update(dt, env, ship.state, energy.state);
  wake.update(dt, ship.state, env);
  hud.update(ship.state, energy.state, wind.state);
  radar.update(dt, ship.state, wind.state);

  postFx.render(dt, scene, view.camera);
  controls.endFrame();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
