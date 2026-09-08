import {
  BoxGeometry,
  Color,
  CylinderGeometry,
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
import type { ArenaCrest, BattleState, Combatant } from './types';
import { fogUniforms } from './fog';
import { CREST_BACK_RATIO, CREST_FRONT_RATIO } from './hazardfield';
import {
  ARENA_CREST_HEIGHT,
  CREST_GRID,
  CREST_VERTEX,
  SEA_VERTEX,
  crestFragment,
  seaFragment,
} from './battlewave';
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

/*
 * The arena's water is `battlewave.ts`'s now, and so is the wall of it that
 * crosses the ring.
 *
 * What used to live here was two octaves of plain `snoise` on a flat plane,
 * with its own wavelengths written down beside a note saying nothing may come
 * to depend on them staying equal to the globe's. That note has been overruled
 * deliberately: the arena sea read as an older draft of the game's sea,
 * because it was one, and the fix is for the two to compile the same field
 * rather than to keep two descriptions of it in step by hand. See that file's
 * module comment for exactly what is shared and what is still the sphere's
 * own business.
 *
 * The palette below stays here because it is what this module hands the
 * shader; the deep and ocean bands are `water.ts`'s, so both seas are the
 * same colour before either is lit.
 */

/**
 * Deep-water colours, taken from `water.ts`'s own ocean and deep bands so the
 * arena's sea is the same sea, and the sky and horizon tints its Fresnel term
 * leans on. `SEA_SHALLOW` and `SEA_FOAM` are that file's own two as well, and
 * are here for the crest alone: the thickness tint is authored as a fraction
 * of the ocean's luminous teal and the froth as the ocean's white. Hexes, so
 * they decode from sRGB to linear on the way in exactly as they do there.
 */
const SEA_OCEAN = '#04243a';
const SEA_DEEP = '#02101c';
const SEA_SKY = '#3d74b4';
const SEA_HORIZON = '#7ba4d4';
const SEA_SHALLOW = '#1fd0b4';
const SEA_FOAM = '#e8fbff';

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
 * Pale spray-and-foam colour, shared by everything in the arena that is
 * water thrown into the air rather than water lying flat: a splash ring, the
 * crest's own translucent sheet, the foam a shoal wears at its waterline,
 * and the brief flash a ball's `strike` throws when the sea eats it instead
 * of the arena's floor. One constant rather than four copies of the same
 * hex, so the family reads as one thing even though it is drawn four
 * different ways.
 */
const SPRAY_COLOR = '#dff3ff';

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

/**
 * A brief, dim, spray-coloured pop from the flash pool, thrown at the point
 * a ball meets a `strike` rather than a splash -- an obstacle or the raft.
 * Dimmer than the muzzle and shorter than the hit flash, on purpose: it
 * marks a ROUND LOST, not a shot fired or a hull struck, and must not be
 * mistaken for either at a glance. `MAX_FLASHES` is not raised for it; a
 * strike shares the same three-light pool the muzzle and the hit already
 * round-robin through.
 */
const STRIKE_LIFE = 0.12;
const STRIKE_INTENSITY = 26;

/**
 * The fuse -- decision 4's telegraph, lit by `state.fuse` and nothing else.
 *
 * A fourth `PointLight`, allocated once here alongside the flash pool rather
 * than pulled from it: the flashes are a pop that decays on its own clock,
 * the fuse is a level that tracks `state.fuse` every frame for as long as it
 * is live, and folding the two into one pool would mean fighting the decay
 * loop above for the light every tick a shot is building. `FUSE_SPAN` is a
 * second reading of `battleai.ts`'s `AI_FUSE` (1.5 s), copied rather than
 * imported for the same reason `KEY_LOW`/`KEY_HIGH` above copy
 * `daynight.ts`'s grading instead of reaching for it: nothing here may take
 * a dependency on the gunner, and if the two ever drift apart the ramp is
 * simply timed a little off rather than pulling the whole sim in.
 *
 * `FUSE_LOW` has to be bright enough to be unmistakable the instant the fuse
 * lights -- a second and a half is the player's whole window to notice it --
 * so it sits well above a level that could be missed against the sea, and
 * `FUSE_HIGH` climbs past it non-linearly (the ramp is squared, not linear)
 * so the last quarter-second before the shot reads as visibly hotter than
 * the second and a half of build-up before it, which is what decision 4
 * asks the light to do. It shares `MUZZLE_COLOR`: the telegraph and the shot
 * it leads into are one warm light warming up, not two different colours.
 */
const FUSE_SPAN = 1.5;
const FUSE_LOW = 4;
const FUSE_HIGH = 48;

/**
 * The crest: how long and how deep it is drawn, and how hard it shoves a
 * hull's bob when it passes one.
 *
 * `CREST_LENGTH` has to read as a wave crossing the whole arena, and the
 * ring is 40 units across at its widest, so 60 clears that with margin at
 * either end and never shows a hard tip at the frame's edge. `CREST_WIDTH`
 * is about a hull length, and it is now doing THREE jobs rather than two: it
 * is the distance `update` uses to decide when a hull is "under" the crest
 * for the heave and roll below, and it is also the half-width the wave is
 * actually built on -- `battlewave.ts` raises `hazardfield.ts`'s own crest
 * profile against it, so the wall of water the player sees is the wall the
 * hull is being rocked by rather than a sheet drawn near one.
 *
 * `CREST_OPACITY` is gone with the quad it belonged to. That quad was a flat
 * translucent sheet laid on the water, and the note here used to argue that
 * a faint sheet reads as a disturbance of the sea rather than as geometry
 * sitting on it. It does -- but only because it has no shape to give away.
 * A crest with a front face, a lip that breaks and a back it lets down over
 * does not need to hide, so the wave is drawn solid and it is the profile's
 * own skirt, not an opacity, that fades it into the sea it stands in.
 *
 * `CREST_HEAVE` and `CREST_ROLL` are on top of the ordinary bob and are
 * shaped, not flat: both are driven by the hull's signed distance from the
 * crest's line divided by `CREST_WIDTH` (`-1` to `+1` while the crest is
 * within reach, zero outside it). The heave is a hump, `1 - prox²`, so the
 * hull lifts as the crest arrives and settles as it leaves. The roll is an
 * odd function of the same term, `prox * (1 - |prox|)`, so the hull banks
 * one way as the crest approaches and the other as it recedes, zero exactly
 * under it and zero once it is gone -- a wave passing under a hull rocks it
 * both ways, not just once. `CREST_ROLL` is applied as `rotation.z` in
 * `placeHull`, which -- because `rotation.y` (the yaw) is composed after it
 * there -- rolls the hull about its own bow-to-stern axis regardless of
 * which way that axis currently points on the ring, exactly as decision 5
 * asks: the shove reads as the wave that caused it, not as the hull
 * glitching sideways.
 */
const CREST_LENGTH = 60;
const CREST_WIDTH = 3;
const CREST_HEAVE = 0.35;
const CREST_ROLL = 0.2;

/**
 * Where each of `battlesea.ts`'s four crest axes points, and the yaw that
 * takes the crest mesh's own frame onto it.
 *
 * The unit vector is that file's `AXIS_VECTOR` -- north is +z, south -z, east
 * +x, west -x -- and it is authored twice on purpose rather than imported: it
 * is pinned by `ArenaCrest`'s own doc comment, and the two files are meant to
 * be checkable against those words separately. The yaw is the rotation about
 * Y that sends the mesh's local +z (the way the wave travels, and the axis
 * the asymmetric profile is written about) onto that vector, so a rotation of
 * theta sends local +z to (sin theta, 0, cos theta).
 */
const CREST_TRAVEL: Record<
  ArenaCrest['axis'],
  { readonly x: number; readonly z: number; readonly yaw: number }
> = {
  north: { x: 0, z: 1, yaw: 0 },
  south: { x: 0, z: -1, yaw: Math.PI },
  east: { x: 1, z: 0, yaw: Math.PI / 2 },
  west: { x: -1, z: 0, yaw: -Math.PI / 2 },
};

/**
 * The crest's footprint across its own travel line, as multiples of
 * `CREST_WIDTH`: `hazardfield.ts`'s front and back ratios, which are what
 * make a wave a steep face with a long back rather than a symmetric hump.
 *
 * Imported rather than written down, because the geometry has to be exactly
 * as wide as the profile the vertex shader raises on it: a plane cut short of
 * the back ratio would clip the wave's own tail off square.
 */
const CREST_FOOTPRINT_FRONT = CREST_FRONT_RATIO;
const CREST_FOOTPRINT_BACK = CREST_BACK_RATIO;

/**
 * How far to the side a fouled hull lists, radians.
 *
 * A flat tilt for as long as `Combatant.fouled` is positive -- "a few
 * degrees", not a wobble of its own, so a fouled hull reads as sitting
 * awkwardly in the raft it just ran into rather than animating. Applied the
 * same way `CREST_ROLL` is, as `rotation.z` ahead of the yaw in `placeHull`,
 * so it is always a list to the hull's own side and not to a fixed compass
 * point.
 */
const FOULED_LIST = 0.1;

/**
 * The pool of shoals and wrecks: how many slots, and the shapes both kinds
 * are built from.
 *
 * Three slots because decision 6 rolls one to three obstacles a fight and
 * nothing here may allocate on demand; a slot past `state.obstacles.length`
 * is simply hidden. Both a shoal and a wreck live in every slot from
 * construction on and only one is ever shown, so choosing which an
 * obstacle is costs a visibility flag, not a mesh.
 *
 * Every size below is authored at `radius = 1` and the whole slot is
 * uniformly scaled by the obstacle's own `radius` (1.0 to 1.5) at
 * placement, so a bigger obstacle is a bigger version of the same shape
 * rather than a different one.
 *
 * The shoal is a flattened sphere sunk mostly below the water --
 * `OBSTACLE_SHOAL_FLATTEN` squashes it to under a third of its own radius
 * tall, and `OBSTACLE_SHOAL_SINK` drops its centre far enough that only
 * about a sixth of that flattened height (0.05 of 0.32) still pokes above
 * the surface -- with a ring of foam sitting right at the waterline,
 * `OBSTACLE_FOAM_SCALE` sized a little past the mound's own footprint so the
 * foam reads as surf breaking on it rather than a halo floating over it.
 *
 * The wreck is a broken box hull, sized against the 3.1-unit hull like
 * everything else in this file -- `WRECK_LENGTH` at radius 1 is a little
 * over half a hull length, so the biggest rolled wreck (radius 1.5) is
 * close to a full hull's worth of broken timber -- heeled onto its side by
 * `ArenaObstacle.yaw`, with a short stub of mast, `WRECK_MAST_HEIGHT` tall,
 * planted toward one end and fixed at `WRECK_MAST_TILT` off true, since a
 * mast still standing straight on a hull lying on its side would read as
 * wrong rather than as wrecked.
 */
const OBSTACLE_SLOTS = 3;
const OBSTACLE_SHOAL_FLATTEN = 0.32;
const OBSTACLE_SHOAL_SINK = 0.27;
const OBSTACLE_FOAM_SCALE = 1.15;
const OBSTACLE_FOAM_OPACITY = 0.55;
const WRECK_LENGTH = 1.9;
const WRECK_HEIGHT = 0.42;
const WRECK_WIDTH = 0.5;
const WRECK_MAST_RADIUS = 0.05;
const WRECK_MAST_HEIGHT = 0.9;
const WRECK_MAST_OFFSET_X = 0.5;
const WRECK_MAST_OFFSET_Y = 0.55;
const WRECK_MAST_TILT = 0.35;
/** Murky rock-and-mud colour for the shoal's mound. Dark, and never the wreck's wood. */
const SHOAL_COLOR = '#2c2620';
/** Dark weathered-wood colour shared by the wreck's hull, its mast stub, and the raft's own debris -- all three are lost timber, not three different materials. */
const HAZARD_COLOR = '#181410';

/**
 * The raft's own small cluster of debris, one box per entry: its offset
 * from the raft's centre and height above the water, its half-extents, and
 * a fixed tilt and heading baked in at construction so no two pieces read
 * as the same crate. Four pieces, kept within a unit or so of the centre --
 * well inside `battlesea.ts`'s own `FLOTSAM_RADIUS` (1.2), copied here only
 * as a comment -- so the pile never reads bigger than the hazard it actually
 * is. Placement itself is one line: the whole group moves to
 * `state.flotsam.x`/`z` and every box keeps the offset it was built with.
 */
const RAFT_PIECES: ReadonlyArray<{
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly tilt: number;
  readonly yaw: number;
}> = [
  { x: 0, z: 0.05, y: 0.08, w: 0.7, h: 0.22, d: 0.5, tilt: 0.08, yaw: 0.3 },
  { x: 0.55, z: 0.3, y: 0.05, w: 0.4, h: 0.16, d: 0.9, tilt: -0.15, yaw: 1.1 },
  { x: -0.5, z: 0.35, y: 0.1, w: 0.5, h: 0.18, d: 0.35, tilt: 0.22, yaw: -0.6 },
  { x: -0.15, z: -0.55, y: 0.04, w: 0.35, h: 0.14, d: 0.6, tilt: -0.1, yaw: 2.0 },
];

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
    uShallow: { value: new Color(SEA_SHALLOW) },
    uFoam: { value: new Color(SEA_FOAM) },
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
      color: SPRAY_COLOR,
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

  /* ---- the fuse ---- */

  // Its own light, not drawn from `flashes`: a flash decays on a clock that
  // starts when it pops, the fuse instead tracks a *level* -- `state.fuse`
  // -- for as long as it is live, and the two update passes below must not
  // fight each other over one light.
  const fuseLight = new PointLight(MUZZLE_COLOR, 0, FLASH_DISTANCE, 2);
  fuseLight.name = 'arena-fuse';
  root.add(fuseLight);

  /* ---- the crest ---- */

  /*
   * A real wall of water, on `hazardfield.ts`'s own profile: see
   * `battlewave.ts` for what is shared with the open sea and why.
   *
   * The grid is authored in the crest's OWN frame -- x along the front, z
   * across it and positive the way the wave travels -- and the whole mesh is
   * then yawed onto whichever of the four axes the sim rolled. That is what
   * lets the vertex shader raise the profile straight out of `position.xz`
   * with nothing to un-rotate, and it replaces the old quad's trick of
   * swapping its own scale for an east/west crest.
   *
   * The plane is `PlaneGeometry`'s usual XY, rotated onto XZ ONCE here rather
   * than by a transform on the mesh, because the mesh's transform is spoken
   * for by that yaw.
   */
  const crestGeometry = new PlaneGeometry(
    CREST_LENGTH,
    CREST_WIDTH * (CREST_FOOTPRINT_BACK + CREST_FOOTPRINT_FRONT),
    CREST_GRID.along,
    CREST_GRID.across,
  );
  crestGeometry.rotateX(-Math.PI / 2);
  // The footprint is asymmetric -- a short steep front and a long back -- so
  // its middle is not the crest line. Sliding the geometry puts z = 0 on the
  // crest itself, which is the coordinate `battlesea.ts` reports as `at` and
  // the one the profile is written about.
  crestGeometry.translate(
    0,
    0,
    (CREST_WIDTH * (CREST_FOOTPRINT_FRONT - CREST_FOOTPRINT_BACK)) / 2,
  );

  const crestUniforms = {
    ...seaUniforms,
    uCrestHeight: { value: ARENA_CREST_HEIGHT },
    uHalfLength: { value: CREST_LENGTH / 2 },
    uHalfWidth: { value: CREST_WIDTH },
    uCrestAlong: { value: new Vector3(1, 0, 0) },
    uCrestAcross: { value: new Vector3(0, 0, 1) },
  };

  const crest = new Mesh(
    crestGeometry,
    new ShaderMaterial({
      uniforms: crestUniforms,
      vertexShader: CREST_VERTEX,
      fragmentShader: crestFragment(quality.waveChop),
      // Transparent for its skirt alone: the body of the wave is solid and
      // has to occlude a hull on the far side of it, which is the whole
      // point of a wall of water. Depth is tested so a nearer hull covers it
      // and not written so its own faded edge cannot punch a hole in one.
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    }),
  );
  crest.name = 'arena-crest';
  crest.position.y = SPLASH_Y;
  crest.visible = false;
  // It is 60 units long and crosses the whole ring; the corners of the grid
  // leave the frustum constantly while the middle of the wave is dead centre.
  crest.frustumCulled = false;
  root.add(crest);

  /* ---- the obstacles: a pool of three, each a shoal and a wreck in one ---- */

  interface ObstacleSlot {
    readonly group: Group;
    readonly shoal: Group;
    readonly wreck: Group;
  }

  const shoalMoundGeometry = new SphereGeometry(1, 16, 10);
  const shoalMoundMaterial = new MeshStandardMaterial({ color: SHOAL_COLOR, roughness: 0.95, metalness: 0 });
  const shoalFoamMaterial = new MeshBasicMaterial({
    color: SPRAY_COLOR,
    transparent: true,
    opacity: OBSTACLE_FOAM_OPACITY,
    depthWrite: false,
    side: DoubleSide,
  });
  const wreckHullGeometry = new BoxGeometry(WRECK_LENGTH, WRECK_HEIGHT, WRECK_WIDTH);
  const wreckMastGeometry = new CylinderGeometry(WRECK_MAST_RADIUS * 0.6, WRECK_MAST_RADIUS, WRECK_MAST_HEIGHT, 6);
  const wreckMaterial = new MeshStandardMaterial({ color: HAZARD_COLOR, roughness: 0.9, metalness: 0.05 });

  const obstacleSlots: ObstacleSlot[] = [];
  for (let i = 0; i < OBSTACLE_SLOTS; i++) {
    const group = new Group();
    group.name = `arena-obstacle-${i}`;
    group.visible = false;

    const shoal = new Group();
    shoal.name = `arena-obstacle-${i}-shoal`;
    const mound = new Mesh(shoalMoundGeometry, shoalMoundMaterial);
    mound.scale.y = OBSTACLE_SHOAL_FLATTEN;
    mound.position.y = -OBSTACLE_SHOAL_SINK;
    shoal.add(mound);
    // The same ring geometry the splashes use, at a fixed size rather than
    // an animated one: this foam does not grow or fade, it just sits at
    // the shoal's own waterline for as long as the shoal exists.
    const foam = new Mesh(ringGeometry, shoalFoamMaterial);
    foam.rotation.x = -Math.PI / 2;
    foam.position.y = SPLASH_Y;
    foam.scale.setScalar(OBSTACLE_FOAM_SCALE);
    shoal.add(foam);
    group.add(shoal);

    const wreck = new Group();
    wreck.name = `arena-obstacle-${i}-wreck`;
    // A fixed heading per slot, purely so three wrecks rolled into one
    // fight do not all point the same way. There is no compass data for a
    // wreck, only the heel `ArenaObstacle.yaw` supplies, which `update`
    // writes to `wreck.rotation.x` every frame instead of here.
    wreck.rotation.y = (i * Math.PI * 2) / OBSTACLE_SLOTS;
    const hull = new Mesh(wreckHullGeometry, wreckMaterial);
    wreck.add(hull);
    const mast = new Mesh(wreckMastGeometry, wreckMaterial);
    mast.position.set(WRECK_MAST_OFFSET_X, WRECK_MAST_OFFSET_Y, 0);
    mast.rotation.z = WRECK_MAST_TILT;
    wreck.add(mast);
    group.add(wreck);

    root.add(group);
    obstacleSlots.push({ group, shoal, wreck });
  }

  /* ---- the raft ---- */

  const raftGeometry = new BoxGeometry(1, 1, 1);
  const raftMaterial = new MeshStandardMaterial({ color: HAZARD_COLOR, roughness: 0.85, metalness: 0 });
  const raft = new Group();
  raft.name = 'arena-raft';
  raft.visible = false;
  for (const piece of RAFT_PIECES) {
    const box = new Mesh(raftGeometry, raftMaterial);
    box.scale.set(piece.w, piece.h, piece.d);
    box.position.set(piece.x, piece.y, piece.z);
    box.rotation.set(piece.tilt, piece.yaw, 0);
    raft.add(box);
  }
  root.add(raft);

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
    fuseLight.intensity = 0;
    crest.visible = false;
    raft.visible = false;
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
   *
   * `roll` is `FOULED_LIST` and/or `CREST_ROLL`'s pull, already summed by
   * the caller, and `heave` is `CREST_HEAVE`'s: both land on top of the
   * ordinary bob rather than replacing it. `roll` is set as `rotation.z`
   * BEFORE `rotation.y` is composed on the line below -- Three's default
   * Euler order applies `z` first -- so it is always a list to the hull's
   * own bow-to-stern side, not to a fixed compass point that would swing
   * with the hull as it goes round the ring.
   */
  function placeHull(hull: Object3D, boat: Combatant, phase: number, roll: number, heave: number): void {
    hull.position.set(
      boat.x,
      HULL_Y + BOB_AMPLITUDE * Math.sin(elapsed * BOB_RATE + phase) + heave,
      boat.z,
    );
    hull.rotation.set(0, Math.PI - boat.angle, roll);
  }

  /**
   * A hull's signed distance from the crest's line, divided by
   * `CREST_WIDTH`: `-1` as the crest arrives, `0` exactly under it, `+1` as
   * it recedes, clamped to that range outside it so the heave and roll it
   * drives are exactly zero once the crest is out of reach. Reads the
   * `ArenaCrest` convention pinned in `types.ts`: `axis` is both the
   * direction of travel and the coordinate it is measured along, and `at`
   * is signed onto the world by that axis (`north`/`east` positive,
   * `south`/`west` negative).
   */
  function crestProximity(crest: ArenaCrest, x: number, z: number): number {
    const sign = crest.axis === 'north' || crest.axis === 'east' ? 1 : -1;
    const along = crest.axis === 'north' || crest.axis === 'south' ? z : x;
    return Math.min(1, Math.max(-1, (along - sign * crest.at) / CREST_WIDTH));
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

      // Fouled listing and the crest's heave-and-roll, summed per hull
      // before `placeHull` ever runs: both are "on top of the existing
      // bob", not a replacement for it.
      let playerRoll = state.player.fouled > 0 ? FOULED_LIST : 0;
      let playerHeave = 0;
      let aiRoll = state.ai.fouled > 0 ? FOULED_LIST : 0;
      let aiHeave = 0;
      if (state.crest !== null) {
        const pProx = crestProximity(state.crest, state.player.x, state.player.z);
        playerHeave += CREST_HEAVE * (1 - pProx * pProx);
        playerRoll += CREST_ROLL * pProx * (1 - Math.abs(pProx));
        const aProx = crestProximity(state.crest, state.ai.x, state.ai.z);
        aiHeave += CREST_HEAVE * (1 - aProx * aProx);
        aiRoll += CREST_ROLL * aProx * (1 - Math.abs(aProx));
      }
      if (playerHull !== null) placeHull(playerHull, state.player, 0, playerRoll, playerHeave);
      if (aiHull !== null) placeHull(aiHull, state.ai, BOB_PHASE_STEP, aiRoll, aiHeave);

      // The fuse: read `state.fuse` and nothing else. No clock of its own --
      // if the AI never commits, this light never lifts off zero.
      if (state.fuse === null) {
        fuseLight.intensity = 0;
      } else {
        fuseLight.position.set(state.ai.x, FLASH_Y, state.ai.z);
        // Eased quadratically rather than linearly: see FUSE_HIGH's own
        // comment for why the last instant has to outrun the build-up.
        const t = 1 - Math.min(1, Math.max(0, state.fuse / FUSE_SPAN));
        fuseLight.intensity = FUSE_LOW + (FUSE_HIGH - FUSE_LOW) * t * t;
      }

      // The crest: a wall of water yawed onto its own axis, hidden while
      // nothing is rolling.
      if (state.crest === null) {
        crest.visible = false;
      } else {
        const travel = CREST_TRAVEL[state.crest.axis];
        crest.visible = true;
        // `at` is the crest's coordinate along its own travel direction, so
        // the centre of the wave is that far out along it and nowhere else.
        crest.position.x = travel.x * state.crest.at;
        crest.position.z = travel.z * state.crest.at;
        crest.rotation.y = travel.yaw;
        // The same frame, in world space, for the fragment shader: it has to
        // turn the profile's local gradient into a world horizontal and has
        // no model matrix of its own to do it with. Rotating about Y by
        // `yaw` sends local +z to `travel` and local +x to its starboard,
        // which is the pair written out here.
        crestUniforms.uCrestAcross.value.set(travel.x, 0, travel.z);
        crestUniforms.uCrestAlong.value.set(travel.z, 0, -travel.x);
      }

      // The obstacles: rolled once at the sim's construction and never
      // moved again, so this is three cheap writes a frame rather than
      // three meshes built the moment the fight learns where they are.
      for (let i = 0; i < obstacleSlots.length; i++) {
        const obstacle = state.obstacles[i];
        const slot = obstacleSlots[i];
        if (obstacle === undefined) {
          slot.group.visible = false;
          continue;
        }
        slot.group.visible = true;
        slot.group.position.set(obstacle.x, 0, obstacle.z);
        slot.group.scale.setScalar(obstacle.radius);
        const isWreck = obstacle.kind === 'wreck';
        slot.wreck.visible = isWreck;
        slot.shoal.visible = !isWreck;
        if (isWreck) slot.wreck.rotation.x = obstacle.yaw;
      }

      // The raft: one cluster, hidden while there is none.
      if (state.flotsam === null) {
        raft.visible = false;
      } else {
        raft.visible = true;
        raft.position.set(state.flotsam.x, 0, state.flotsam.z);
      }

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
        } else if (event.kind === 'splash' || event.kind === 'strike') {
          const splash = splashes[nextSplash];
          nextSplash = (nextSplash + 1) % splashes.length;
          splash.age = 0;
          splash.mesh.position.set(event.x, SPLASH_Y, event.z);
          splash.mesh.scale.set(SPLASH_R0, SPLASH_R0, 1);
          splash.material.opacity = 1;
          splash.mesh.visible = true;
          // A strike is a ball the sea ate -- an obstacle or the raft --
          // rather than one that simply fell short. Same ring, plus a
          // brief spray-coloured pop so the two are told apart at a glance
          // instead of only by counting rounds left in the locker.
          if (event.kind === 'strike') pop(event.x, event.z, SPRAY_COLOR, STRIKE_INTENSITY, STRIKE_LIFE);
        }
        // 'aim' needs nothing here: the fuse light above already reads
        // `state.fuse` directly. 'foul' needs nothing beyond the raft
        // vanishing, which `state.flotsam` becoming null already shows.
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
