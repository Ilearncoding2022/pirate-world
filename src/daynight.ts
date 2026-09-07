import * as THREE from 'three';
import type { WorldEnv } from './env';
import { GLOBE_RADIUS } from './geo';

export interface DayNight {
  /** Lights and any sun-following objects. Added to the world group. */
  group: THREE.Group;
  /** Advances time and rewrites `env` in place. Called before every consumer. */
  update(dt: number, env: WorldEnv): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * Real seconds for one full orbit of the sun around the globe.
 *
 * Twenty minutes: ten of day and ten of night, for a ship sitting still on the
 * equator. Away from the equator the split is uneven and drifts with the
 * season, exactly as it does on Earth, because the sun's latitude wanders --
 * see AXIAL_TILT below.
 *
 * A moving ship gets a different day entirely, and gets it for free. The sun
 * is placed in world space from elapsed time alone, and every shader decides
 * day or night from `dot(surface normal, sunDirection)` at the point being
 * drawn, so local time is a property of *where the ship is*, not of a clock it
 * carries. Sail east, into the sunrise, and dawn arrives sooner; sail west and
 * you chase the sunset and hold it. That is cross-timezone travel, falling out
 * of the geometry rather than being modelled.
 *
 * One caveat worth knowing before retuning this. The terminator sweeps the
 * ground at 2*PI*GLOBE_RADIUS / DAY_LENGTH, which at 1200 s is 1.05 world
 * units a second against the ship's 10. The ship is about ten times faster
 * than the sun -- the reverse of Earth, where the ground beats a ship roughly
 * forty to one. Cutting the day from an hour to twenty minutes and the hull
 * from 15 kn to 10 has narrowed that gap from sixty to one: running west at
 * speed still stretches the day a long way, but it no longer stops the sun
 * outright the way it used to, and running east now compresses the twenty
 * minutes to about two rather than collapsing the hour into one. Only three
 * things move the ratio: the day's length, the ship's speed, or a larger
 * GLOBE_RADIUS, which slows the ship in degrees without slowing the sun.
 */
const DAY_LENGTH = 1200;

/**
 * Days in one seasonal cycle. The subsolar latitude drifts on this much slower
 * beat, so the terminator runs tilted and its tilt keeps changing. Without it
 * the sun would track dead along the equator and read as a machine.
 */
const SEASON_DAYS = 6;
/** Peak subsolar latitude, radians (~23.5 degrees, Earth's axial tilt). */
const AXIAL_TILT = 0.41;
/** Season phase at t = 0, so the world never opens on a flat equatorial sun. */
const SEASON_PHASE = 0.95;

/** How far out the key light sits. Directional, so only the direction matters. */
const SUN_DISTANCE = GLOBE_RADIUS * 6;

/* Sun tint ramp, from a sun on the horizon up to a sun overhead. */
const HORIZON_TINT = new THREE.Color('#ff7c3c');
const GOLDEN_TINT = new THREE.Color('#ffc27e');
const NOON_TINT = new THREE.Color('#fff4e4');

/* Key light. Graded down as the sun drops, standing in for air extinction. */
const KEY_LOW = 1.15;
const KEY_HIGH = 2.05;

/*
 * Sky/ground bounce. This one is global -- it hits the night hemisphere as
 * hard as the day one -- so the swing is deliberately small. All the real
 * day/night contrast comes from the key light, which by construction only
 * reaches the hemisphere it faces.
 */
const SKY_NIGHT = new THREE.Color('#24365c');
const SKY_DAY = new THREE.Color('#bfe4ff');
const GROUND_NIGHT = new THREE.Color('#0c1017');
const GROUND_DAY = new THREE.Color('#4a4030');
const HEMI_NIGHT = 0.16;
const HEMI_DAY = 0.34;

/*
 * Moonlight: a cool fill aimed from roughly opposite the sun, so it lands only
 * on the night hemisphere and gives the dark terrain some shape. Tilted north
 * of the true antisolar point so it does not read as a mirrored sun.
 */
const MOON_TINT = new THREE.Color('#93b4ec');
const MOON_INTENSITY = 0.3;
const MOON_TILT = 0.5;

/** Floor light, so no part of the world is ever pure black. */
const AMBIENT_TINT = new THREE.Color('#54637d');
const AMBIENT_INTENSITY = 0.1;

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** Sub-camera direction used until the first frame reports a camera. */
const DEFAULT_VIEW_DIR = new THREE.Vector3(0, 0, 1);

const _viewDir = new THREE.Vector3();
const _moonDir = new THREE.Vector3();

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Zero-cost probe whose only job is to report where the camera is.
 *
 * `WorldEnv.dayFactor` is defined as how lit the *sub-camera* side of the
 * planet is, but `update(dt, env)` is never handed a camera. `onBeforeRender`
 * is, and it fires for any renderable object in the graph, so a single-vertex
 * Points whose vertex is pushed outside the clip volume -- writing neither
 * colour nor depth -- reports the camera for free. If it never fires,
 * `dayFactor` simply falls back to the lon-0 reference direction.
 */
function buildCameraProbe(onCamera: (camera: THREE.Camera) => void): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));

  const material = new THREE.ShaderMaterial({
    vertexShader: [
      'void main() {',
      '  gl_PointSize = 0.0;',
      '  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
      '}',
    ].join('\n'),
    fragmentShader: ['void main() {', '  gl_FragColor = vec4(0.0);', '}'].join('\n'),
    depthTest: false,
    depthWrite: false,
    colorWrite: false,
  });

  const probe = new THREE.Points(geometry, material);
  probe.name = 'camera-probe';
  probe.frustumCulled = false;
  probe.renderOrder = -1000;
  probe.onBeforeRender = (_renderer, _scene, camera): void => {
    onCamera(camera);
  };
  return probe;
}

/**
 * The sun cycle, and the sole writer of `WorldEnv`.
 *
 * The sun orbits the globe once every `DAY_LENGTH` seconds, sweeping a
 * terminator across the surface, while its latitude drifts on a slower
 * seasonal beat so the terminator stays tilted and never repeats exactly.
 *
 * `env.sunDirection` and the `DirectionalLight` are driven from the same
 * vector, so the hemisphere lit by the rig is exactly the one every shader
 * derives from `env`. Letting those two disagree breaks the whole world.
 */
export function createDayNight(): DayNight {
  const group = new THREE.Group();
  group.name = 'daynight';

  const hemi = new THREE.HemisphereLight(SKY_DAY.getHex(), GROUND_DAY.getHex(), HEMI_DAY);
  hemi.name = 'hemi-light';
  group.add(hemi);

  const ambient = new THREE.AmbientLight(AMBIENT_TINT.getHex(), AMBIENT_INTENSITY);
  ambient.name = 'ambient-floor';
  group.add(ambient);

  const sun = new THREE.DirectionalLight(NOON_TINT.getHex(), KEY_HIGH);
  sun.name = 'sun';
  group.add(sun);

  const moon = new THREE.DirectionalLight(MOON_TINT.getHex(), MOON_INTENSITY);
  moon.name = 'moon-fill';
  group.add(moon);

  // Sub-camera direction, refreshed once per frame by the probe.
  const viewDir = DEFAULT_VIEW_DIR.clone();
  group.add(
    buildCameraProbe((camera) => {
      if (camera.position.lengthSq() > 1e-8) viewDir.copy(camera.position).normalize();
    }),
  );

  function update(dt: number, env: WorldEnv): void {
    if (!(dt > 0)) dt = 0;
    env.elapsed += dt;

    // ---- Where the sun is --------------------------------------------
    // timeOfDay 0 puts the sun over lon 0 (see env.ts). Longitude decreases
    // with time so the sun tracks westward and therefore rises in the east.
    let tod = (env.elapsed / DAY_LENGTH) % 1;
    if (tod < 0) tod += 1;
    env.timeOfDay = tod;

    const sunLon = -tod * Math.PI * 2;
    const season = (env.elapsed / (DAY_LENGTH * SEASON_DAYS)) * Math.PI * 2 + SEASON_PHASE;
    const declination = Math.sin(season) * AXIAL_TILT;
    const cosDec = Math.cos(declination);

    // Mutated in place: consumers hold this reference.
    env.sunDirection.set(
      cosDec * Math.sin(sunLon),
      Math.sin(declination),
      cosDec * Math.cos(sunLon),
    );

    // ---- How lit the side of the planet we are looking at is ----------
    _viewDir.copy(viewDir);
    if (_viewDir.lengthSq() < 1e-8) _viewDir.copy(DEFAULT_VIEW_DIR);
    // Sine of the sun's elevation above the horizon at the sub-camera point.
    const elevation = env.sunDirection.dot(_viewDir);
    env.dayFactor = smoothstep(-0.2, 0.22, elevation);

    // ---- Sun tint -----------------------------------------------------
    // Deep orange with the sun on the horizon, through gold, to a neutral
    // warm white overhead. Below the horizon it holds at the horizon tint:
    // the only part of the lit hemisphere still visible from a night-side
    // camera is the sliver either side of the terminator, which is warm.
    const low = smoothstep(-0.02, 0.16, elevation);
    const high = smoothstep(0.16, 0.46, elevation);
    env.sunColor.copy(HORIZON_TINT).lerp(GOLDEN_TINT, low).lerp(NOON_TINT, high);

    // ---- Drive the rig from exactly the same vector --------------------
    sun.position.copy(env.sunDirection).multiplyScalar(SUN_DISTANCE);
    sun.color.copy(env.sunColor);
    // Thicker air near the horizon: dim the key as the sun drops.
    sun.intensity = KEY_LOW + (KEY_HIGH - KEY_LOW) * smoothstep(0.0, 0.42, elevation);

    // Opposite the sun, lifted toward the pole so the fill is not a mirror.
    _moonDir
      .copy(env.sunDirection)
      .multiplyScalar(-1)
      .addScaledVector(WORLD_UP, MOON_TILT)
      .normalize();
    moon.position.copy(_moonDir).multiplyScalar(SUN_DISTANCE);

    hemi.intensity = HEMI_NIGHT + (HEMI_DAY - HEMI_NIGHT) * env.dayFactor;
    hemi.color.copy(SKY_NIGHT).lerp(SKY_DAY, env.dayFactor);
    hemi.groundColor.copy(GROUND_NIGHT).lerp(GROUND_DAY, env.dayFactor);
  }

  return { group, update };
}
