import * as THREE from 'three';
import './style.css';
import { createTerrain, DEFAULT_SEED } from './terrain';
import { createGlobe } from './globe';
import { createShip } from './ship';
import { createFollowCamera } from './camera';
import { createControls } from './controls';
import { createHud } from './hud';

const host = document.getElementById('app');
if (!host) throw new Error('#app host element not found in index.html');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x05080f, 1);
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const terrain = createTerrain(DEFAULT_SEED);
const globe = createGlobe(terrain);
scene.add(globe.group);

const ship = createShip(terrain, { latDeg: 0, lonDeg: 0, headingDeg: 90 });
scene.add(ship.object);

const view = createFollowCamera(window.innerWidth / window.innerHeight);
const controls = createControls();
const hud = createHud();

function onResize(): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  view.resize(window.innerWidth / window.innerHeight);
}
window.addEventListener('resize', onResize);

const clock = new THREE.Clock();

function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.1);

  ship.update(dt, controls.input);
  view.update(dt, ship.state, controls.input);
  globe.update(dt);
  hud.update(ship.state);

  renderer.render(scene, view.camera);
  controls.endFrame();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
