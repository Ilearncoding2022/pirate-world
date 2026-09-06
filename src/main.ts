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

const ship = createShip(terrain, {
  latDeg: SPAWN_LAT_DEG,
  lonDeg: SPAWN_LON_DEG,
  headingDeg: 90,
});
scene.add(ship.object);

const wake = createWake();
scene.add(wake.object);

const view = createFollowCamera(window.innerWidth / window.innerHeight);
const controls = createControls();
const hud = createHud();
const radar = createRadar(globe.heightMap, globe.waterBodies, terrain.seaLevel);
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

  ship.update(dt, controls.input);
  view.update(dt, ship.state, controls.input);
  globe.update(dt, env);
  wake.update(dt, ship.state, env);
  hud.update(ship.state);
  radar.update(dt, ship.state);

  postFx.render(dt, scene, view.camera);
  controls.endFrame();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
