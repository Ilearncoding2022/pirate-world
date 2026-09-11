import {
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RingGeometry,
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
  crestFragment,
} from './battlewave';
import { CREST_MAX, FLOTSAM_COUNT_MAX } from './battlesea';
import { RAFT_NOMINAL_R, buildRaft } from './raftmesh';
import { SUN_APPEARS_SIN } from './horizon';
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
const CAMERA_FOV = 50;
/** Matches `camera.ts`'s chase camera, which frames this same globe. */
const CAMERA_FAR = 6000;
/*
 * 19 up and 52 back, where the arena used 26 and 34.
 *
 * The old pose was built for an opaque flat plane and does not survive
 * contact with a real ocean. Two things go wrong with it at once, and both
 * are geometry rather than shading:
 *
 * **No sky.** 26 up and 34 back is 37 degrees below horizontal, and the
 * vertical half-FOV is 25, so the top of the frame sits 12 degrees below the
 * horizontal. From 26 units up the horizon is only 8.5 degrees down, so it
 * falls ABOVE the top of the frame and never appears. What filled the top of
 * the picture instead was space past the planet's limb -- black with stars,
 * in the middle of the afternoon, over a lit sea.
 *
 * **No water.** Looking 37 degrees down is looking 53 degrees off the
 * surface normal, where the Fresnel term hands back almost no reflection and
 * the sea is drawn as what is under it. Over the shallow shelf a fight
 * usually finds, that is the sea floor, in hard polygonal facets. The old
 * arena's plane had nothing under it and could not show this.
 *
 * 19 and 52 is 20 degrees below horizontal. The top of the frame is then 5
 * degrees ABOVE the horizontal and the horizon is 10 degrees below it, so
 * about a third of the picture is sky and the sea is seen at a grazing angle
 * that reflects it -- which is the same arrangement `camera.ts` arrives at
 * for the chase view, and the reason the ocean reads as ocean there.
 *
 * The ring pays for it in foreshortening: 40 units across becomes about 14 of
 * frame height rather than 24. That is the honest trade and it is the right
 * way round -- a duel that reads as two ships on a sea beats a diagram of two
 * ships on a circle, and the circle is no longer drawn either.
 */
const CAMERA_POSITION = new Vector3(0, 19, 52);

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
const HORIZON_TINT = new Color('#ff7c3c');
const GOLDEN_TINT = new Color('#ffc27e');
const NOON_TINT = new Color('#fff4e4');

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
 * a ball meets a `strike` rather than a splash -- a raft got in the way.
 * Dimmer than the muzzle and shorter than the hit flash, on purpose: it
 * marks a SHOT EATEN, not a shot fired or a hull struck, and must not be
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
 * `CREST_LENGTH` is the GEOMETRY's length and no longer the wave's. A crest
 * now carries its own `length`, anywhere from a fifth of the arena to all of
 * it, and that is fed to the shader as `uHalfLength` -- the coordinate the
 * ridge profile tapers to nothing at. So the plane stays 60 units at all
 * times, comfortably longer than the widest wave the sim can roll, and the
 * part of it beyond the crest's own ends carries exactly zero height and
 * zero alpha. Scaling the mesh instead would have squeezed the foam noise
 * along with it and made a short crest a differently-textured wave rather
 * than a shorter one. `CREST_WIDTH`
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
 *
 * `alongX`/`alongZ` is the crest's own line -- `(travel.z, -travel.x)`, the
 * same formula `ArenaCrest` and `battlesea.ts` write out -- and it is where
 * `offset` is measured. It has to be the SAME perpendicular the sim chose or
 * a short crest would be drawn on the opposite side of the ring from the
 * hulls it shoves, which is why the formula is pinned in three places rather
 * than derived in one and trusted in the others. It is also the mesh's own
 * local +x after the yaw, so it is what `offset` slides the mesh along.
 */
const CREST_TRAVEL: Record<
  ArenaCrest['axis'],
  {
    readonly x: number;
    readonly z: number;
    readonly yaw: number;
    readonly alongX: number;
    readonly alongZ: number;
  }
> = {
  north: { x: 0, z: 1, yaw: 0, alongX: 1, alongZ: 0 },
  south: { x: 0, z: -1, yaw: Math.PI, alongX: -1, alongZ: 0 },
  east: { x: 1, z: 0, yaw: Math.PI / 2, alongX: 0, alongZ: -1 },
  west: { x: -1, z: 0, yaw: -Math.PI / 2, alongX: 0, alongZ: 1 },
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

/*
 * The rafts' own art -- the four boxes, the radius they are authored against
 * and the weathered-timber colour -- lives in `raftmesh.ts` now, because the
 * open ocean floats the same pile for salvage (`salvagerafts.ts`). It moved
 * unchanged; an arena raft is the object it always was.
 */

export interface BattleScene {
  /**
   * Everything the fight draws, in FLAT ARENA COORDINATES: metres east in x,
   * metres north in z, up in y, centred on the ring.
   *
   * `main.ts` adds this to the world scene and gives it the one transform
   * that puts the arena's plane on the globe's tangent plane at the ring --
   * which is the whole of how a fight in flat metres happens on a sphere. No
   * prop in this module knows the difference, and `battle.ts` still does its
   * arithmetic in the plane it was written for.
   */
  readonly props: Group;
  /**
   * The fight's camera. Stands on its own in world space -- see `placeCamera`.
   */
  readonly camera: PerspectiveCamera;
  /**
   * Put the camera on the ring, given the ring's centre in world space and
   * its tangent basis. Called once when a fight opens; the shot is fixed, so
   * there is nothing to update per frame.
   */
  placeCamera(origin: Vector3, east: Vector3, up: Vector3, north: Vector3): void;
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
  // Everything this module owns hangs off one group, so `adopt` is one call
  // and the two borrowed hulls -- which are adopted by whoever owns them --
  // are plainly not part of it. It is also the seam the whole fight now hangs
  // on: `main.ts` puts this group on the globe and nothing inside it has to
  // learn that it moved.
  const root = new Group();
  root.name = 'arena-props';

  /*
   * The depth range is the WORLD camera's, not the arena's old one.
   *
   * 2000 was ample for a fight in an empty room: the whole scene was a
   * 300-unit plane and a handful of props, and nothing could ever be further
   * away than the plane's own corner. Pointed at the globe it clips -- the sky
   * dome, the cloud deck and the far limb all sit past it, and what that looks
   * like is the sky ending in a hard band above the horizon.
   *
   * `camera.ts` uses 0.1 to 6000 for the same globe, so this uses 0.1 to 6000.
   * The near plane matters more than the far one for depth precision and is
   * identical, so nothing about the water/land seam changes with it.
   */
  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, CAMERA_FAR);
  /*
   * NOT a child of `props`, and that is load-bearing rather than a style
   * choice.
   *
   * Parenting it there is the obvious thing to do -- the props already carry
   * the transform that lays the arena on the globe, so a camera inside them
   * is placed for free and the fixed shot survives the move with no
   * arithmetic. It was written that way first, and the world rendered WRONG
   * through it: no sky at all, a black starfield over a lit afternoon sea,
   * and water so transparent the sea floor showed through it in facets.
   *
   * It was isolated by elimination. Pose, field of view, aspect, near and far
   * planes, layer masks, frustum test, and the sky dome's own visibility and
   * day factor were all confirmed identical to the chase camera's, on a live
   * frame, through the debug hook. Rendering the SAME pose through an
   * unparented camera then drew the world correctly. Parenting is the only
   * variable left standing.
   *
   * So the camera is placed explicitly instead. `placeCamera` does the same
   * arithmetic the transform would have -- it is four lines -- and an
   * unparented camera is what every other camera in this project is.
   */
  camera.position.copy(CAMERA_POSITION);
  camera.lookAt(0, 0, 0);

  /*
   * There are no lights and no sea in here any more, and their absence is the
   * point of this whole file's change.
   *
   * The arena used to be a second world: its own flat sea, its own key light
   * and hemisphere rigged to imitate the elevation the world had at contact,
   * and its own sky-coloured background. All of it existed to reproduce, for
   * ninety seconds, a sea and a sky the game already had running -- and the
   * module comment used to have to insist that none of it was a second
   * opinion about what the ocean looks like.
   *
   * It is not a second world now. The props hang in the world scene, over the
   * globe's own water, under the globe's own sun and weather, so the light in
   * here IS the light out there rather than a graded copy of it. See
   * docs/ROADMAP.md, "The fight, in the live world".
   */

  /* ---- the sea: none. The globe's own water is under the ring now. ---- */

  /*
   * The palette block the arena's sea plane used to own, kept because the
   * crest meshes below still shade against it.
   *
   * Those crests are DORMANT in a live-world fight -- `main.ts` builds every
   * fight with `waves: false` now, because the sea under the ring is the
   * game's own and a second set of flat crest meshes drawn over real water
   * would be two seas disagreeing in the same twenty metres. The meshes and
   * this block are left standing rather than deleted: docs/ROADMAP.md stages
   * that deletion at step 3, once the fight has been played in the live world
   * and the ring itself is up for discussion, and a dormant path is cheaper
   * to delete later than to reconstruct.
   */
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
    ...fogUniforms,
  };

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
  /*
   * The ring is NOT drawn, and that is the owner's call (2026-09-10) rather
   * than an omission.
   *
   * It briefly was. The argument for drawing it was that on an empty plane
   * the circle read plainly off the two hulls' motion, and over a real
   * coastline it no longer did. The argument against, once it was on screen,
   * is the stronger one: a hard orange annulus a hundred and sixty units
   * across, laid flat over the globe's own water, is the most conspicuous
   * thing in the frame and it reads as a piece of interface dropped onto the
   * sea rather than as anything in the world -- which is the exact continuity
   * this whole move was made to buy back.
   *
   * The ring itself is untouched. `battle.ts` still holds both boats to it
   * and still closes it at ARENA_SHRINK; the constraint is exactly as real as
   * it was. Only the annulus is gone. If it needs to come back it should come
   * back as something the sea could plausibly contain -- a band of chop, a
   * line of foam -- and not as a drawn circle.
   */

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

  /*
   * One slot per crest the sim may run, built up front. Each carries its own
   * uniforms because each is a different wave: its own length, its own place
   * on its own line, its own axis. The `seaUniforms` spread shares the
   * OBJECTS behind time, light and fog, so those still move for every slot
   * from one write a frame, and only the four crest-specific ones are
   * per-slot.
   *
   * The geometry is shared. It is the same 60-unit plane in every slot and
   * nothing about a crest's own dimensions is baked into it -- see
   * CREST_LENGTH on why the wave's length is a uniform rather than a scale.
   */
  interface CrestSlot {
    readonly mesh: Mesh;
    readonly uniforms: {
      uHalfLength: { value: number };
      uCrestAlong: { value: Vector3 };
      uCrestAcross: { value: Vector3 };
    };
  }

  const crestSlots: CrestSlot[] = [];
  for (let i = 0; i < CREST_MAX; i++) {
    const uniforms = {
      ...seaUniforms,
      uCrestHeight: { value: ARENA_CREST_HEIGHT },
      uHalfLength: { value: CREST_LENGTH / 2 },
      uHalfWidth: { value: CREST_WIDTH },
      uCrestAlong: { value: new Vector3(1, 0, 0) },
      uCrestAcross: { value: new Vector3(0, 0, 1) },
    };
    const mesh = new Mesh(
      crestGeometry,
      new ShaderMaterial({
        uniforms,
        vertexShader: CREST_VERTEX,
        fragmentShader: crestFragment(quality.waveChop),
        // Transparent for its skirt alone: the body of the wave is solid and
        // has to occlude a hull on the far side of it, which is the whole
        // point of a wall of water. Depth is tested so a nearer hull covers
        // it and not written so its own faded edge cannot punch a hole in
        // one -- which also lets two crests overlap without either one
        // carving a hole in the other.
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    mesh.name = `arena-crest-${i}`;
    mesh.position.y = SPLASH_Y;
    mesh.visible = false;
    // The plane is 60 units long; its corners leave the frustum constantly
    // while the middle of the wave is dead centre.
    mesh.frustumCulled = false;
    root.add(mesh);
    crestSlots.push({ mesh, uniforms });
  }

  /* ---- the rafts: one pool slot per raft the sim may float ---- */

  /*
   * `FLOTSAM_COUNT_MAX` slots, because that is the most the sim can ever roll
   * and nothing in this file may allocate on demand: a slot past
   * `state.flotsam.length` is simply hidden, exactly as the pool of shoals
   * this replaces did.
   *
   * Each slot is turned to its own fixed heading at construction. The sim has
   * no bearing for a raft -- a floating pile of timber has no bow -- so this
   * is here only so that six rafts on the water are not six copies of one
   * silhouette. Scale is the one thing `update` writes, off the raft's own
   * rolled radius.
   */
  const raftSlots: Group[] = [];
  for (let i = 0; i < FLOTSAM_COUNT_MAX; i++) {
    const raft = buildRaft(`arena-raft-${i}`, (i * Math.PI * 2) / FLOTSAM_COUNT_MAX);
    root.add(raft);
    raftSlots.push(raft);
  }

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
    for (const slot of crestSlots) slot.mesh.visible = false;
    for (const raft of raftSlots) raft.visible = false;
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
   * A hull's signed distance from one crest's line, divided by `CREST_WIDTH`:
   * `-1` as the crest arrives, `0` exactly under it, `+1` as it recedes,
   * clamped to that range outside it so the heave and roll it drives are
   * exactly zero once the crest is out of reach. Reads the `ArenaCrest`
   * convention pinned in `types.ts`: `axis` is both the direction of travel
   * and the coordinate it is measured along, and `at` is signed onto the
   * world by that axis (`north`/`east` positive, `south`/`west` negative).
   *
   * Returns `null` for a hull past the ENDS of the crest. A short wave rocks
   * only what it actually passes over, which is the same test `battlesea.ts`
   * shoves on -- run here against the hull's drawn position rather than its
   * track, because this is what the eye is checking against the picture.
   */
  function crestProximity(crest: ArenaCrest, x: number, z: number): number | null {
    const travel = CREST_TRAVEL[crest.axis];
    const across = x * travel.alongX + z * travel.alongZ;
    if (Math.abs(across - crest.offset) > crest.length / 2) return null;
    const along = x * travel.x + z * travel.z;
    return Math.min(1, Math.max(-1, (along - crest.at) / CREST_WIDTH));
  }

  /**
   * The crest a hull is most under, as a proximity, or `null` under none.
   *
   * The NEAREST and not the sum. Three crests overlapping one hull would lift
   * it by three heaves and bank it by three rolls, which is a hull launched
   * out of the water rather than a sea running -- and it would disagree with
   * the sim, which also hands a hull one shove at a time however many waves
   * are running. So the picture and the physics both pick a single wave.
   */
  function nearestCrest(state: BattleState, x: number, z: number): number | null {
    let best: number | null = null;
    for (const crest of state.crests) {
      const prox = crestProximity(crest, x, z);
      if (prox !== null && (best === null || Math.abs(prox) < Math.abs(best))) best = prox;
    }
    return best;
  }

  return {
    props: root,
    camera,

    placeCamera(origin: Vector3, east: Vector3, up: Vector3, north: Vector3): void {
      camera.position
        .copy(origin)
        .addScaledVector(east, CAMERA_POSITION.x)
        .addScaledVector(up, CAMERA_POSITION.y)
        .addScaledVector(north, CAMERA_POSITION.z);
      // `up` first, or `lookAt` rolls the shot: on a globe the world's +Y is
      // not the local vertical, and a camera that took Three's default would
      // sit level only at one point on the planet.
      camera.up.copy(up);
      camera.lookAt(origin);
      camera.updateMatrixWorld(true);
    },

    enter(player: Object3D, ai: Object3D | null, sunElevation: number): void {
      playerHull = player;
      aiHull = ai;
      elapsed = 0;
      // Into the PROPS, so both hulls ride the same transform onto the globe
      // as the ring they are circling inside.
      root.add(player);
      if (ai !== null) root.add(ai);

      /*
       * The sine of the sun's elevation at the ship, graded exactly as
       * `daynight.ts` grades its own rig: the day term over the terminator
       * band, the key dimmed as the sun drops toward thicker air.
       *
       * Every ramp starts at `SUN_APPEARS_SIN` rather than at zero, and the
       * arena has to copy that even though it is a flat sea with a horizon of
       * its own. The elevation handed in is the WORLD's, measured against the
       * world's drawn horizon, and a fight entered at daybreak has to be lit
       * like the daybreak it interrupted. Grading it from eye level here would
       * put the arena a quarter of a sky earlier in the day than the sea the
       * player was just looking at.
       */
      const elevation = Math.min(1, Math.max(-1, sunElevation));
      const dayFactor = smoothstep(SUN_APPEARS_SIN, 0.22, elevation);

      const sunColor = HORIZON_TINT.clone()
        .lerp(GOLDEN_TINT, smoothstep(SUN_APPEARS_SIN, 0.0, elevation))
        .lerp(NOON_TINT, smoothstep(0.16, 0.46, elevation));

      // Elevation off the world, bearing off the arena. `KEY_AZIMUTH` is
      // horizontal and unit, so this stays unit for any elevation.
      const direction = new Vector3()
        .copy(KEY_AZIMUTH)
        .multiplyScalar(Math.sqrt(Math.max(0, 1 - elevation * elevation)))
        .setY(elevation);

      // No key and no hemisphere to write any more: the world's own rig is
      // lighting these props, which is the entire point of the move. What the
      // grading is still used for is the dormant crest palette below, and a
      // fight that ever re-enables those wants them lit like the sky it is
      // under rather than like noon.
      seaUniforms.uSunDirection.value.copy(direction);
      seaUniforms.uSunColor.value.copy(sunColor);
      seaUniforms.uDayFactor.value = dayFactor;
      seaUniforms.uTime.value = 0;

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
      const pProx = nearestCrest(state, state.player.x, state.player.z);
      if (pProx !== null) {
        playerHeave += CREST_HEAVE * (1 - pProx * pProx);
        playerRoll += CREST_ROLL * pProx * (1 - Math.abs(pProx));
      }
      const aProx = nearestCrest(state, state.ai.x, state.ai.z);
      if (aProx !== null) {
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

      // The crests: each a wall of water yawed onto its own axis and slid
      // along its own line, with its own length handed to the shader. Slots
      // past the count are hidden rather than moved out of sight.
      for (let i = 0; i < crestSlots.length; i++) {
        const slot = crestSlots[i];
        const crest = state.crests[i];
        if (crest === undefined) {
          slot.mesh.visible = false;
          continue;
        }
        const travel = CREST_TRAVEL[crest.axis];
        slot.mesh.visible = true;
        // `at` is the crest's coordinate along its own travel direction and
        // `offset` its place along the line it lies on, so the centre of the
        // wave is the sum of the two and nowhere else.
        slot.mesh.position.x = travel.x * crest.at + travel.alongX * crest.offset;
        slot.mesh.position.z = travel.z * crest.at + travel.alongZ * crest.offset;
        slot.mesh.rotation.y = travel.yaw;
        // Half the wave's own length, which is where the ridge profile
        // tapers to nothing: this is what makes a short crest short. The
        // geometry never changes -- see CREST_LENGTH.
        slot.uniforms.uHalfLength.value = crest.length / 2;
        // The same frame, in world space, for the fragment shader: it has to
        // turn the profile's local gradient into a world horizontal and has
        // no model matrix of its own to do it with. Rotating about Y by
        // `yaw` sends local +z to `travel` and local +x to its starboard,
        // which is the pair written out here.
        slot.uniforms.uCrestAcross.value.set(travel.x, 0, travel.z);
        slot.uniforms.uCrestAlong.value.set(travel.z, 0, -travel.x);
      }

      // The rafts: a position and a scale each, and the slots past the
      // fleet's own count hidden.
      for (let i = 0; i < raftSlots.length; i++) {
        const raft = raftSlots[i];
        const piece = state.flotsam[i];
        if (piece === undefined) {
          raft.visible = false;
          continue;
        }
        raft.visible = true;
        raft.position.set(piece.x, 0, piece.z);
        raft.scale.setScalar(piece.radius / RAFT_NOMINAL_R);
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
          // A strike is a ball the sea ate -- a raft got in the way --
          // rather than one that simply fell short. Same ring, plus a
          // brief spray-coloured pop so the two are told apart at a glance
          // rather than by watching which way the ball was going.
          if (event.kind === 'strike') pop(event.x, event.z, SPRAY_COLOR, STRIKE_INTENSITY, STRIKE_LIFE);
        }
        // 'aim' needs nothing here: the fuse light above already reads
        // `state.fuse` directly. 'foul' needs nothing beyond the raft
        // vanishing, which its slot dropping out of `state.flotsam` shows.
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
