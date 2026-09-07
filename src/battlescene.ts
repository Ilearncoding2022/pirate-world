import {
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Object3D } from 'three';
import type { Quality } from './quality';
import type { PostFx } from './postfx';
import type { BattleState, Combatant } from './types';
import { NOISE_GLSL } from './noiseglsl';
import { FOG_GLSL } from './fogglsl';
import { fogUniforms } from './fog';
import { GLOBE_RADIUS } from './geo';
import { HULL_OFFSET } from './ship';

/**
 * battlescene.ts — the arena the fight happens in.
 *
 * A second `Scene`, rendered through the same `postFx` the world is: an empty
 * flat sea, one sun at the elevation the world had at the moment of contact,
 * a fixed camera, and the cannonballs. The world scene is left exactly as the
 * contact froze it and is never touched here.
 *
 * **This is not the globe water.** It must never import `water.ts` or
 * `waterpatch.ts`, and nothing here may be taken as a second opinion on what
 * the sea looks like: the ocean is a sphere with a depth ramp, a wake map, a
 * reflection cube and a displacement patch, and reproducing any of that for a
 * ninety-second fight on a flat plane would buy nothing and give the two
 * shaders a way to disagree. What this sea shares with that one is only the
 * palette and the aerial-perspective contract, both imported rather than
 * copied: `waterglsl.ts`'s deep colours, and `applyAerial` from `fogglsl.ts`
 * reading `fog.ts`'s uniforms, frozen at the values the world last wrote --
 * which is what makes the light in here the light out there.
 *
 * It borrows both hulls rather than owning them: `main.ts` reparents the
 * player's real hull and the AI's clone in on the way through the fade, and
 * takes the player's back on the way out. `aihulls.ts` takes its clone back
 * the first frame it needs it again, so `exit` reparents nothing.
 */

/* ------------------------------------------------------------------ */
/* The arena, and the camera on it                                     */
/* ------------------------------------------------------------------ */

/**
 * The sea plane, world units square, and the camera that looks at it.
 *
 * The whole frustum points below the horizontal -- the camera sits 26 up and
 * 34 back, so its top edge is still about 12 degrees down -- which means the
 * plane fills the frame and no sky is ever seen. 300 is what covers that at
 * any ordinary aspect ratio: the top edge of the frame meets the water about
 * 84 units beyond the centre, well inside the 150 half-extent, and the
 * corners of an ultra-wide window reach about 130.
 *
 * The camera does not orbit. At `ARENA_R0` (20) both hulls are inside the
 * frame with the player nearest; at `ARENA_R_MIN` (8) they fill its middle. A
 * camera turning with the player at seventeen degrees a second for a minute is
 * the kind of motion that makes people put the game down.
 */
const SEA_EXTENT = 300;
const CAMERA_FOV = 50;
const CAMERA_POSITION = new Vector3(0, 26, 34);

/**
 * Height of a hull's transform above the water, world units.
 *
 * The same `HULL_OFFSET` the globe mounts the player at, for the same reason:
 * the model inside carries `MODEL_MOUNT_Y`, which is authored to put the
 * hull's waterline on the sea when its parent sits exactly this far above it.
 * Sit the group on y = 0 instead and both boats ride half a hull too deep.
 */
const HULL_Y = HULL_OFFSET;

/**
 * The same authored bob `aihulls.ts` runs, in world units and radians per
 * second, and authored twice on purpose rather than shared: out here it
 * stands in for a wave field the arena does not have, and in there it stands
 * in for one the raider is not sampling. They answer to different things and
 * should be free to move apart.
 */
const BOB_AMPLITUDE = 0.08;
const BOB_RATE = 1.7;
/** Half a cycle between the two boats, so they never heave in step. */
const BOB_PHASE_STEP = Math.PI;

/* ------------------------------------------------------------------ */
/* Light                                                               */
/* ------------------------------------------------------------------ */

/*
 * A second reading of `daynight.ts`'s key and hemisphere grading. Those
 * constants are private to that module and the arena is not on the globe, so
 * there is no shared vector to drive both rigs from the way the world drives
 * its shaders and its lights from one `env.sunDirection`. The numbers are
 * copied deliberately and are the whole point of `enter`'s `sunElevation`
 * argument: a fight at dusk has to be lit like the dusk it interrupted, or
 * the fade into the arena reads as a cut to a different time of day.
 */
const KEY_LOW = 1.15;
const KEY_HIGH = 2.05;
const HORIZON_TINT = new Color('#ff7c3c');
const GOLDEN_TINT = new Color('#ffc27e');
const NOON_TINT = new Color('#fff4e4');
const SKY_NIGHT = new Color('#24365c');
const SKY_DAY = new Color('#bfe4ff');
const GROUND_NIGHT = new Color('#0c1017');
const GROUND_DAY = new Color('#4a4030');
const HEMI_NIGHT = 0.16;
const HEMI_DAY = 0.34;

/**
 * Where the key comes from, horizontally: up and to the left of the camera,
 * which is the one-key-from-upper-left staging ART-DIRECTION.md §1 asks every
 * asset in this project to be lit by. Only its elevation is read off the
 * world; the bearing is the arena's own, because a fight staged with the sun
 * behind the frame would put both hulls in silhouette at exactly the moment
 * the player has to read them.
 */
const KEY_AZIMUTH = new Vector3(-0.72, 0, 0.69).normalize();

/* ------------------------------------------------------------------ */
/* The sea shader                                                      */
/* ------------------------------------------------------------------ */

/**
 * The two octaves, as world-unit wavelengths and the world units per second
 * they drift at.
 *
 * Sized against the hull (about 3.1 units long), like every other ship-scale
 * constant: a 22-unit swell is seven hull lengths and a 5.9-unit wave is
 * about two, which are the numbers `waveconstants.ts` authors the real sea's
 * first two layers at. Written here rather than imported from that file
 * because these drive a normal on a flat plane, not a height field the hull
 * is riding, and nothing may come to depend on the two staying equal.
 */
const SWELL_WAVELENGTH = 22;
const SWELL_DRIFT = 0.85;
const SWELL_AMPLITUDE = 0.3;
const WAVE_WAVELENGTH = 5.9;
const WAVE_DRIFT = 1.6;
const WAVE_AMPLITUDE = 0.1;

/**
 * Finite-difference step for the normal, world units, and the factor the
 * slope it measures is exaggerated by.
 *
 * A tenth of the fine octave's wavelength: small enough to read that octave's
 * slope, large enough that two nearly equal noise samples do not cancel into
 * noise of their own. The exaggeration is there because these amplitudes are
 * a fraction of a unit over wavelengths of tens of units, so the true surface
 * is almost flat and would take no glint at all; the same trick `water.ts`
 * plays with its own `uWaveStrength`.
 */
const NORMAL_STEP = 0.6;
/*
 * Three was too much, measured by eye against `?battle=1`: at that
 * exaggeration the fine octave's slopes are steep enough that the glint lobe
 * lands on scattered single facets rather than on runs of them, and the sea
 * reads as static. Read this together with SPEC_POWER above -- they are one
 * decision written as two numbers, and moving either alone brings the specks
 * back.
 */
const NORMAL_STRENGTH = 1.7;

/**
 * Deep-water colours, taken from `water.ts`'s own ocean and deep bands so the
 * arena's sea is the same sea, and the sky and horizon tints its Fresnel term
 * leans on. Hexes, so they decode from sRGB to linear on the way in exactly
 * as they do there.
 */
const SEA_OCEAN = '#04243a';
const SEA_DEEP = '#02101c';
const SEA_SKY = '#3d74b4';
const SEA_HORIZON = '#7ba4d4';

/**
 * Blinn-Phong glint.
 *
 * `water.ts` runs a highlight three times tighter than this and it is right to
 * there, because the sea it runs it on is displaced geometry lit across a
 * whole planet: the exponent picks out a glitter path and everything either
 * side of it stays dark. Here the surface is one flat plane whose normal is
 * exaggerated by NORMAL_STRENGTH, so an exponent that tight lights only the
 * few facets that happen to align exactly and the sea comes out as white
 * static -- thousands of isolated specks, no path through them. Broadening the
 * lobe is what turns those specks back into water: the same total light, spread
 * over the crests around each one instead of stopping at its edge.
 *
 * Tuned by eye against `?battle=1`, which is the only way this can be tuned;
 * no test in this project asserts on how anything looks.
 */
const SPEC_POWER = 110;
const SPEC_STRENGTH = 0.6;

const SEA_VERTEX = [
  'varying vec3 vWorldPos;',
  'void main() {',
  '  vec4 world = modelMatrix * vec4(position, 1.0);',
  '  vWorldPos = world.xyz;',
  '  gl_Position = projectionMatrix * viewMatrix * world;',
  '}',
].join('\n');

/**
 * @param fine whether the second octave is compiled in at all, from
 *   `quality.waveChop` -- the same field, and the same judgement, that
 *   decides whether the globe's own fine octave runs. On the low tier the
 *   arena sea keeps its swell and loses its texture, which is the cheapest
 *   thing here worth losing.
 */
function seaFragment(fine: boolean): string {
  const swellFreq = ((Math.PI * 2) / SWELL_WAVELENGTH).toFixed(6);
  const waveFreq = ((Math.PI * 2) / WAVE_WAVELENGTH).toFixed(6);
  return [
    'uniform float uTime;',
    'uniform float uDayFactor;',
    'uniform vec3 uSunDirection;',
    'uniform vec3 uSunColor;',
    'uniform vec3 uOcean;',
    'uniform vec3 uDeep;',
    'uniform vec3 uSky;',
    'uniform vec3 uHorizon;',
    'varying vec3 vWorldPos;',
    NOISE_GLSL,
    // Declares uFogColorDay, uFogColorNight and uFogDensity itself; they are
    // merged into this material's uniforms from `fog.ts` below and must not
    // be declared a second time here.
    FOG_GLSL,
    `const float SWELL_FREQ = ${swellFreq};`,
    `const float SWELL_DRIFT = ${SWELL_DRIFT.toFixed(3)};`,
    `const float SWELL_AMPLITUDE = ${SWELL_AMPLITUDE.toFixed(3)};`,
    `const float WAVE_FREQ = ${waveFreq};`,
    `const float WAVE_DRIFT = ${WAVE_DRIFT.toFixed(3)};`,
    `const float WAVE_AMPLITUDE = ${WAVE_AMPLITUDE.toFixed(3)};`,
    `const float NORMAL_STEP = ${NORMAL_STEP.toFixed(3)};`,
    `const float NORMAL_STRENGTH = ${NORMAL_STRENGTH.toFixed(3)};`,
    `const float SPEC_POWER = ${SPEC_POWER.toFixed(1)};`,
    `const float SPEC_STRENGTH = ${SPEC_STRENGTH.toFixed(3)};`,
    // The arena is flat and centred on the world origin, so a point on it has
    // no local vertical of its own; `applyAerial` derives one from the
    // position it is handed. Lifting both the shaded point and the camera by
    // GLOBE_RADIUS puts them where the same pair would sit on the globe, so
    // the grazing-angle and camera-altitude terms in that contract mean here
    // exactly what they mean out there instead of reading a horizontal
    // "up" off a plane through the origin.
    `const vec3 ARENA_LIFT = vec3(0.0, ${GLOBE_RADIUS.toFixed(1)}, 0.0);`,
    '// Two scrolling octaves, each drifting along its own bearing and',
    '// evolving slowly on the third noise axis, so the field never reads as',
    '// one pattern sliding across the frame.',
    'float seaHeight(vec2 p) {',
    '  float h = snoise(vec3(p * SWELL_FREQ + vec2(SWELL_DRIFT, 0.42 * SWELL_DRIFT) * uTime * SWELL_FREQ, uTime * 0.05)) * SWELL_AMPLITUDE;',
    ...(fine
      ? [
          '  h += snoise(vec3(p * WAVE_FREQ + vec2(-0.36 * WAVE_DRIFT, WAVE_DRIFT) * uTime * WAVE_FREQ, uTime * 0.13)) * WAVE_AMPLITUDE;',
        ]
      : []),
    '  return h;',
    '}',
    'void main() {',
    '  vec2 p = vWorldPos.xz;',
    '  float h = seaHeight(p);',
    '  float hx = seaHeight(p + vec2(NORMAL_STEP, 0.0));',
    '  float hz = seaHeight(p + vec2(0.0, NORMAL_STEP));',
    '  vec3 N = normalize(vec3((h - hx) * NORMAL_STRENGTH / NORMAL_STEP, 1.0, (h - hz) * NORMAL_STRENGTH / NORMAL_STEP));',
    '  vec3 sun = normalize(uSunDirection);',
    '  vec3 view = normalize(cameraPosition - vWorldPos);',
    '  // Crests a shade lighter than troughs. The real sea gets this from its',
    '  // depth ramp; a flat arena floor has one depth, so the height field is',
    '  // the only thing left to key it to.',
    '  vec3 base = mix(uDeep, uOcean, clamp(0.5 + h * 1.4, 0.0, 1.0));',
    '  float ndl = max(dot(N, sun), 0.0);',
    '  vec3 col = base * (0.22 + 0.95 * ndl * uDayFactor);',
    '  // Sky in the shallow angles, which is what stops the far water going',
    '  // black at night and flat at noon. Faded with the day, since there is',
    '  // no sky shell over this scene to be reflecting after dark.',
    '  float fres = pow(1.0 - clamp(dot(N, view), 0.0, 1.0), 5.0);',
    '  col = mix(col, mix(uSky, uHorizon, fres) * (0.18 + 0.82 * uDayFactor), fres * 0.55);',
    '  vec3 halfway = normalize(sun + view);',
    '  col += uSunColor * (SPEC_STRENGTH * pow(max(dot(N, halfway), 0.0), SPEC_POWER) * uDayFactor);',
    '  col = applyAerial(col, vWorldPos + ARENA_LIFT, cameraPosition + ARENA_LIFT, sun, uDayFactor);',
    '  // A hand-written ShaderMaterial, so `postfx.ts` leaves it out of the',
    '  // self-encode patch and it does the linear to sRGB step itself, exactly',
    '  // as `water.ts` and `docks.ts` do on their last line.',
    '  gl_FragColor = vec4(pow(col, vec3(0.4545454545)), 1.0);',
    '}',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Cannonballs, flashes and splashes                                   */
/* ------------------------------------------------------------------ */

/**
 * Cannonball meshes held in the pool, and the size and height one is drawn
 * at.
 *
 * A side fires at most once a second and a ball lives four, so five in the
 * air per side is the ceiling the sim can actually reach; twelve carries
 * that with room over. All of them are built at construction, not on demand,
 * for two reasons: a mesh added later misses `postFx.adopt`'s one walk, and a
 * material compiled mid-fight is a hitch on the frame a shot is fired.
 *
 * 0.22 units is about a fourteenth of a hull length -- oversized for a real
 * gun and the right size to follow across twenty units of water.
 */
const MAX_BALLS = 12;
const BALL_RADIUS = 0.22;
/** Just above the gunwale, so a ball leaves the ship's side rather than its keel. */
const BALL_HEIGHT = 0.6;

/**
 * Splash rings in the pool, their life in seconds, and the radii they grow
 * between.
 *
 * Six is two full seconds of splashes at the fastest either side can fire.
 * They are drawn flat on the water a hair above it, so they read as a
 * disturbance of the surface rather than as an object floating on it.
 */
const MAX_SPLASHES = 6;
const SPLASH_LIFE = 0.7;
const SPLASH_R0 = 0.35;
const SPLASH_R1 = 1.8;
const SPLASH_Y = 0.05;

/**
 * Point lights kept for the muzzle flash and the hit flash, and how long each
 * burns.
 *
 * Three, allocated once and never added or removed: a light arriving in a
 * scene changes the lighting hash and recompiles every standard material
 * under it, which on a hull of two dozen materials is a stall in the middle
 * of a gunfight. They idle at zero intensity instead.
 *
 * 0.12 s for the muzzle is about seven frames: long enough to be seen, short
 * enough to read as a bang. The hit flash is held a little longer because it
 * is the only confirmation on the scene itself that a ball landed, and it is
 * hot red rather than warm so it cannot be mistaken for a shot going out.
 */
const MAX_FLASHES = 3;
const MUZZLE_LIFE = 0.12;
const MUZZLE_INTENSITY = 40;
const MUZZLE_COLOR = '#ffd9a0';
const HIT_LIFE = 0.18;
const HIT_INTENSITY = 55;
const HIT_COLOR = '#ff5a3c';
/** Fall-off distance of both flashes, world units. About three hull lengths. */
const FLASH_DISTANCE = 14;
/** Height a flash sits at: the gun deck, the same line the balls leave on. */
const FLASH_Y = 0.9;

export interface BattleScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Takes both hulls in. `sunElevation` is `dot(ship.up, env.sunDirection)` at contact. */
  enter(playerHull: Object3D, aiHull: Object3D | null, sunElevation: number): void;
  update(dt: number, state: BattleState): void;
  /** Clears the balls and the flashes. The hulls are `main.ts`'s to move back. */
  exit(): void;
}

/** Three's own `smoothstep`, on the CPU, for the two light ramps below. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * @param quality read for `waveChop` only: the arena's fine sea octave is
 *   compiled in on the same tiers the globe's is. Nothing else here has a
 *   quality row -- the arena is one plane, two hulls and a handful of
 *   spheres, and is cheaper than the world it replaces.
 * @param postFx optional, and only for `adopt`. Every stock material in here
 *   is built at construction, so one walk covers the lot; without it the
 *   cannonballs and their splashes render a stop dark. See
 *   **Post-processing** in docs/ARCHITECTURE.md.
 */
export function createBattleScene(quality: Quality, postFx?: Pick<PostFx, 'adopt'>): BattleScene {
  const scene = new Scene();
  scene.name = 'arena';

  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 2000);
  camera.position.copy(CAMERA_POSITION);
  camera.lookAt(0, 0, 0);

  // Everything this module owns hangs off one group, so `adopt` is one call
  // and the two borrowed hulls -- which are adopted by whoever owns them --
  // are plainly not part of it.
  const root = new Group();
  root.name = 'arena-props';
  scene.add(root);

  /* ---- lights ---- */

  const hemi = new HemisphereLight(SKY_DAY.getHex(), GROUND_DAY.getHex(), HEMI_DAY);
  hemi.name = 'arena-hemi';
  root.add(hemi);

  const key = new DirectionalLight(NOON_TINT.getHex(), KEY_HIGH);
  key.name = 'arena-key';
  root.add(key);

  /* ---- the sea ---- */

  const seaUniforms = {
    uTime: { value: 0 },
    uDayFactor: { value: 1 },
    uSunDirection: { value: new Vector3(0, 1, 0) },
    uSunColor: { value: new Color(NOON_TINT) },
    uOcean: { value: new Color(SEA_OCEAN) },
    uDeep: { value: new Color(SEA_DEEP) },
    uSky: { value: new Color(SEA_SKY) },
    uHorizon: { value: new Color(SEA_HORIZON) },
    // One shared object, owned by `fog.ts` and last written by the world's
    // own `globe.update` before the contact froze it. Nothing in the battle
    // branch updates it, which is exactly right: the weather the fight is
    // fought in is the weather it interrupted.
    ...fogUniforms,
  };

  // One quad. Every wave in here is a per-pixel normal, so there is nothing
  // for a subdivided plane to displace and no reason to pay for its vertices.
  const sea = new Mesh(
    new PlaneGeometry(SEA_EXTENT, SEA_EXTENT, 1, 1),
    new ShaderMaterial({
      uniforms: seaUniforms,
      vertexShader: SEA_VERTEX,
      fragmentShader: seaFragment(quality.waveChop),
    }),
  );
  sea.name = 'arena-sea';
  sea.rotation.x = -Math.PI / 2;
  // It is the floor of everything and is drawn first; nothing here is ever
  // outside it, so the frustum test is pure cost.
  sea.frustumCulled = false;
  root.add(sea);

  /* ---- cannonballs ---- */

  const ballGeometry = new SphereGeometry(BALL_RADIUS, 12, 8);
  const balls: Mesh[] = [];
  for (let i = 0; i < MAX_BALLS; i++) {
    // A dim warm emissive on a nearly black body: iron in the dark, and just
    // over the bloom's threshold so the ball keeps a halo against a night sea
    // where nothing else would separate it from the water.
    const ball = new Mesh(
      ballGeometry,
      new MeshStandardMaterial({
        color: '#15100c',
        emissive: new Color('#ffb45a'),
        emissiveIntensity: 1.2,
        roughness: 0.55,
        metalness: 0.3,
      }),
    );
    ball.name = `arena-ball-${i}`;
    ball.visible = false;
    balls.push(ball);
    root.add(ball);
  }

  /* ---- splashes ---- */

  interface Splash {
    readonly mesh: Mesh;
    readonly material: MeshBasicMaterial;
    /** Seconds since it was struck, or SPLASH_LIFE once it is spent. */
    age: number;
  }

  // Authored at unit radius and scaled, so one geometry serves every ring at
  // every point in its life.
  const ringGeometry = new RingGeometry(0.82, 1, 28);
  const splashes: Splash[] = [];
  for (let i = 0; i < MAX_SPLASHES; i++) {
    const material = new MeshBasicMaterial({
      color: '#dff3ff',
      transparent: true,
      opacity: 0,
      // Flat on the water and fading: writing depth would let a ring occlude
      // the hull behind it through its own transparent middle.
      depthWrite: false,
      side: DoubleSide,
    });
    const mesh = new Mesh(ringGeometry, material);
    mesh.name = `arena-splash-${i}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = SPLASH_Y;
    mesh.visible = false;
    splashes.push({ mesh, material, age: SPLASH_LIFE });
    root.add(mesh);
  }
  let nextSplash = 0;

  /* ---- flashes ---- */

  interface Flash {
    readonly light: PointLight;
    /** Seconds left, and the life it started with, so the decay is one divide. */
    life: number;
    span: number;
    peak: number;
  }

  const flashes: Flash[] = [];
  for (let i = 0; i < MAX_FLASHES; i++) {
    const light = new PointLight(MUZZLE_COLOR, 0, FLASH_DISTANCE, 2);
    light.name = `arena-flash-${i}`;
    flashes.push({ light, life: 0, span: MUZZLE_LIFE, peak: MUZZLE_INTENSITY });
    root.add(light);
  }
  let nextFlash = 0;

  /** Every transient in the arena, back to nothing. Both ends of a fight. */
  function resetTransient(): void {
    for (const ball of balls) ball.visible = false;
    for (const splash of splashes) {
      splash.age = SPLASH_LIFE;
      splash.material.opacity = 0;
      splash.mesh.visible = false;
    }
    for (const flash of flashes) {
      flash.life = 0;
      flash.light.intensity = 0;
    }
  }

  function pop(x: number, z: number, colour: string, peak: number, span: number): void {
    const flash = flashes[nextFlash];
    nextFlash = (nextFlash + 1) % flashes.length;
    flash.light.color.set(colour);
    flash.light.position.set(x, FLASH_Y, z);
    flash.life = span;
    flash.span = span;
    flash.peak = peak;
    // Lit here rather than left to the decay pass, which has already run for
    // this frame by the time an event is read: a gun that goes off in the
    // dark and lights up a frame later reads as a missed frame.
    flash.light.intensity = peak;
  }

  postFx?.adopt(root);

  /* ---- state held between frames ---- */

  let playerHull: Object3D | null = null;
  let aiHull: Object3D | null = null;
  let elapsed = 0;
  let aspect = 0;

  /**
   * Bow along the tangent at `angle`, hull at `x`/`z`.
   *
   * The bow is read off `angle` rather than off `Combatant.heading`, and that
   * is deliberate: both boats travel counter-clockwise on a circle whose
   * position is `(radius cos angle, radius sin angle)`, so the tangent is
   * `(-sin angle, cos angle)` and the bow drawn from it cannot disagree with
   * the position it is drawn at. `heading` is `battle.ts`'s reading of that
   * same tangent on the compass convention `ShipState.heading` uses, which is
   * the UI's business and not the scene's.
   *
   * The model's own bow is local -Z (see `ship.ts`'s `applyTransform`), and
   * the yaw that carries -Z onto that tangent is `PI - angle`.
   */
  function placeHull(hull: Object3D, boat: Combatant, phase: number): void {
    hull.position.set(
      boat.x,
      HULL_Y + BOB_AMPLITUDE * Math.sin(elapsed * BOB_RATE + phase),
      boat.z,
    );
    hull.rotation.set(0, Math.PI - boat.angle, 0);
  }

  return {
    scene,
    camera,

    enter(player: Object3D, ai: Object3D | null, sunElevation: number): void {
      playerHull = player;
      aiHull = ai;
      elapsed = 0;
      scene.add(player);
      if (ai !== null) scene.add(ai);

      // The sine of the sun's elevation at the ship, graded exactly as
      // `daynight.ts` grades its own rig: the day term over the terminator
      // band, the key dimmed as the sun drops toward thicker air.
      const elevation = Math.min(1, Math.max(-1, sunElevation));
      const dayFactor = smoothstep(-0.2, 0.22, elevation);
      const height = smoothstep(0, 0.42, elevation);

      const sunColor = HORIZON_TINT.clone()
        .lerp(GOLDEN_TINT, smoothstep(-0.02, 0.16, elevation))
        .lerp(NOON_TINT, smoothstep(0.16, 0.46, elevation));

      // Elevation off the world, bearing off the arena. `KEY_AZIMUTH` is
      // horizontal and unit, so this stays unit for any elevation.
      const direction = new Vector3()
        .copy(KEY_AZIMUTH)
        .multiplyScalar(Math.sqrt(Math.max(0, 1 - elevation * elevation)))
        .setY(elevation);

      key.position.copy(direction).multiplyScalar(GLOBE_RADIUS);
      key.color.copy(sunColor);
      key.intensity = KEY_LOW + (KEY_HIGH - KEY_LOW) * height;

      hemi.intensity = HEMI_NIGHT + (HEMI_DAY - HEMI_NIGHT) * dayFactor;
      hemi.color.copy(SKY_NIGHT).lerp(SKY_DAY, dayFactor);
      hemi.groundColor.copy(GROUND_NIGHT).lerp(GROUND_DAY, dayFactor);

      seaUniforms.uSunDirection.value.copy(direction);
      seaUniforms.uSunColor.value.copy(sunColor);
      seaUniforms.uDayFactor.value = dayFactor;
      seaUniforms.uTime.value = 0;

      // The world's own haze colour, and the reason nothing but a sliver of
      // it is ever seen: the frustum points below the horizontal, so the sea
      // fills the frame at any ordinary aspect. It is encoded here because
      // the clear is not a material and nothing downstream converts it --
      // `postfx.ts`'s final blit is a plain copy and only materials
      // self-encode -- so a linear colour would clear a stop too dark.
      const background = new Color()
        .copy(fogUniforms.uFogColorNight.value)
        .lerp(fogUniforms.uFogColorDay.value, dayFactor)
        .convertLinearToSRGB();
      scene.background = background;

      // Last fight's balls, rings and flashes, in case `exit` was never
      // reached: a fight always starts on an empty sea.
      resetTransient();
    },

    update(dt: number, state: BattleState): void {
      elapsed += dt;
      seaUniforms.uTime.value = elapsed;

      // The arena camera is only alive under the battle branch and `main.ts`'s
      // resize handler knows nothing about it, so it takes its own aspect from
      // the window here. Guarded for Node, where this module is importable but
      // never drawn, and written only when it actually changes: assigning
      // `aspect` alone does nothing until the projection matrix is rebuilt.
      if (typeof window !== 'undefined' && window.innerHeight > 0) {
        const next = window.innerWidth / window.innerHeight;
        if (next !== aspect) {
          aspect = next;
          camera.aspect = next;
          camera.updateProjectionMatrix();
        }
      }

      if (playerHull !== null) placeHull(playerHull, state.player, 0);
      if (aiHull !== null) placeHull(aiHull, state.ai, BOB_PHASE_STEP);

      for (let i = 0; i < balls.length; i++) {
        const ball = state.balls[i];
        // More balls in the air than the pool holds cannot happen at the sim's
        // own cooldown and life; if it ever does, the extra ones are simply
        // not drawn rather than allocated for mid-fight.
        if (ball === undefined) {
          balls[i].visible = false;
          continue;
        }
        balls[i].position.set(ball.x, BALL_HEIGHT, ball.z);
        balls[i].visible = true;
      }

      for (const splash of splashes) {
        if (splash.age >= SPLASH_LIFE) continue;
        splash.age += dt;
        const t = Math.min(1, splash.age / SPLASH_LIFE);
        const radius = SPLASH_R0 + (SPLASH_R1 - SPLASH_R0) * t;
        splash.mesh.scale.set(radius, radius, 1);
        // Fading as it grows, on the square so most of the ring's life is
        // spent nearly gone rather than nearly solid.
        splash.material.opacity = (1 - t) * (1 - t);
        splash.mesh.visible = t < 1;
      }

      for (const flash of flashes) {
        if (flash.life <= 0) continue;
        flash.life -= dt;
        flash.light.intensity = flash.life > 0 ? flash.peak * (flash.life / flash.span) : 0;
      }

      // This tick's events only: `battle.ts` rebuilds the list every update,
      // so nothing here has to remember what it has already reacted to.
      for (const event of state.events) {
        if (event.kind === 'fire') {
          pop(event.x, event.z, MUZZLE_COLOR, MUZZLE_INTENSITY, MUZZLE_LIFE);
        } else if (event.kind === 'hit') {
          // The scene's own answer to a hit on either hull. The player's own
          // hits also get a screen-edge vignette from `battleui.ts`, which is
          // the half of this that cannot be done in world space.
          pop(event.x, event.z, HIT_COLOR, HIT_INTENSITY, HIT_LIFE);
        } else {
          const splash = splashes[nextSplash];
          nextSplash = (nextSplash + 1) % splashes.length;
          splash.age = 0;
          splash.mesh.position.set(event.x, SPLASH_Y, event.z);
          splash.mesh.scale.set(SPLASH_R0, SPLASH_R0, 1);
          splash.material.opacity = 1;
          splash.mesh.visible = true;
        }
      }
    },

    exit(): void {
      // The transient half of the arena only. Both hulls stay exactly where
      // they are: `main.ts` moves the player's back inside the fade, and
      // `aihulls.ts` takes its clone back the first frame it places it again.
      // The two references are dropped so a frame that arrives between fights
      // cannot move a hull that is no longer in here.
      playerHull = null;
      aiHull = null;
      resetTransient();
    },
  };
}
