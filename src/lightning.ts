/**
 * lightning.ts — the bolt, for a flash that already exists.
 *
 * `weather.ts` has lit the sky on `flash` since the weather shipped, and
 * `sky.ts` and `clouds.ts` both read it: a strike brightens the dome and lifts
 * the cloud undersides toward white. What none of that has is anything to
 * LOOK at. A flash with no bolt reads as the exposure changing rather than as
 * lightning, and the player never finds out which way the storm is.
 *
 * So this module draws the one thing missing, and draws nothing else: it owns
 * no timing, no gate and no randomness of its own. `weather.flash` is the
 * envelope, `weather.flashSeed` is the shape and `weather.flashOrigin` is the
 * place -- all three fixed by `weather.ts` at the instant of the strike, which
 * is what makes a bolt survive a replay and photograph the same way twice.
 *
 * The geometry is rewritten ONCE PER STRIKE, not once per frame. A frame in
 * which a bolt is already lit costs one uniform write and one draw call; a
 * frame with no strike in it costs nothing at all, because the object hides
 * itself. That is the same bargain `rain.ts` makes and the reason both can sit
 * in the frame loop unguarded.
 *
 * Bolt geometry is ship-scale (docs/ARCHITECTURE.md, "World scale"): a bolt is
 * sized against the cloud base `clouds.ts` puts 4.8 units over the water, not
 * against `GLOBE_RADIUS`. Only WHERE it is hung is world-scale.
 */
import * as THREE from 'three';
import type { ShipState, WeatherState } from './types';
import { LAYER_DEFAULT } from './layers';
import { GLOBE_RADIUS } from './geo';
import { mulberry32 } from './towns';

export interface Lightning {
  object: THREE.Object3D;
  update(dt: number, ship: ShipState, weather: WeatherState): void;
}

/* ------------------------------------------------------------------ */
/* Tuning constants — all ship-scale                                    */
/* ------------------------------------------------------------------ */

/**
 * Where the bolt starts and stops, world units above the water.
 *
 * The top is `clouds.ts`'s own cloud base: SHELL_BASE is 1.024 of
 * GLOBE_RADIUS, which is 4.8 units up. A bolt that began above that would be
 * drawn in front of the deck it is supposed to be coming out of, and one that
 * began below it would hang in clear air. It is not imported from `clouds.ts`
 * because that constant is private to the deck's own shell arithmetic; it is
 * restated here, with this comment, so the two can be reconciled by eye.
 *
 * The foot stops a little above the water rather than at it. A bolt that
 * reached exactly 0 would z-fight the sea surface along its last segment, and
 * the last thing a strike should read as is a crack in the water.
 */
const BOLT_TOP = 4.8;
const BOLT_FOOT = 0.15;

/**
 * How many segments the trunk is cut into, and how far it may wander sideways
 * over its whole fall.
 *
 * 18 is enough for the trunk to change its mind four or five times, which is
 * what separates lightning from a crack. The wander is quoted as a fraction of
 * the drop: 0.28 of 4.65 units is about 1.3 units of lateral travel, roughly a
 * third of a hull length, which leans the bolt without letting it lie down.
 */
const TRUNK_STEPS = 18;
const TRUNK_WANDER = 0.28;

/**
 * How many strands the trunk is drawn with, and how far apart they sit.
 *
 * This is the one piece of cheating in the file and it is worth being plain
 * about: WebGL ignores `linewidth`, so every line in this renderer is one
 * pixel wide at every distance, and a one-pixel bolt reads as a scratch.
 * Three near-coincident strands, drawn ADDITIVELY, give both a width and a
 * hot core -- the middle is where all three overlap -- for a twentieth of the
 * cost of rebuilding the bolt as camera-facing quads.
 *
 * The spread is deliberately tiny. At the ship it is a couple of pixels of
 * thickness; at a cell on the horizon the three collapse into one line, which
 * is exactly right, because that is what distance does to a bolt.
 */
const TRUNK_STRANDS = 3;
const STRAND_SPREAD = 0.05;

/**
 * How many forks a bolt may carry, how far down the trunk they may leave from,
 * and how far they get.
 *
 * A fork is most of what makes a shape read as lightning rather than as a
 * lightning-shaped line, and real bolts fork low rather than at the cloud:
 * 0.35..0.8 of the way down keeps them out of the deck and off the water.
 * `BRANCH_STEPS` is short because a fork that ran as far as the trunk would be
 * a second trunk, and `BRANCH_FALL` stops it at a fraction of the remaining
 * drop so it dies in the air the way a fork does.
 */
const BRANCH_MAX = 2;
const BRANCH_STEPS = 6;
const BRANCH_HI = 0.35;
const BRANCH_LO = 0.8;
const BRANCH_FALL = 0.55;
const BRANCH_SPREAD = 0.9;

/**
 * How far from the ship a squall's bolt strikes, world units.
 *
 * Never at the hull: a bolt through the deck is a bolt the chase camera is
 * inside of, and it reads as a white bar rather than as lightning. 12 to 34 is
 * from just outside the rain box to a little past where the drops stop being
 * resolvable, which is the band where a bolt is both clearly elsewhere and
 * clearly close.
 */
const NEAR_MIN = 12;
const NEAR_MAX = 34;

/**
 * How far inside its own radius a cell's bolt strikes.
 *
 * A fraction, not a distance: a bolt from a 60-unit storm should be able to
 * land anywhere across it, and one from a small cell should not appear to
 * strike outside itself. Kept under the 0.55 core `weathercells.ts` holds at
 * full strength so the bolt lands in weather rather than on its skirt.
 */
const CELL_SPREAD = 0.5;

/**
 * How bright a bolt is at the peak of its flash, and the floor under the flash
 * that draws one at all.
 *
 * The bolt is ADDITIVE and it is the brightest thing in a storm, so it is
 * allowed past 1: a strike should clip, and the bloom the frame already runs
 * is what turns that clipping into a glare around the channel. The sky's own
 * FLASH_SKY is 0.35 by comparison, and it has the whole hemisphere to do it
 * over.
 *
 * The floor exists so the bolt leaves on the flash's first decay rather than
 * lingering as a grey thread through the tail of it. A visible bolt at 2% of
 * peak would be a wire.
 */
const BOLT_PEAK = 2.2;
const BOLT_VISIBLE = 0.06;

/**
 * A blue-white. Lightning is not the rain's grey and it is not white either:
 * the channel is hot enough to go blue at the edges, and an additive line
 * that starts at pure white has nowhere left to go.
 */
const BOLT_COLOR = new THREE.Color('#cfe4ff');

/** Segments the buffer is sized for: the strands' trunks plus every fork. */
const MAX_SEGMENTS = TRUNK_STRANDS * TRUNK_STEPS + BRANCH_MAX * BRANCH_STEPS;

/* ------------------------------------------------------------------ */
/* Bolt geometry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Write one bolt's vertices into `positions` and return how many segments it
 * used.
 *
 * PURE, apart from writing into the buffer it is handed: the same seed writes
 * the same numbers, which is the whole basis of the replay and screenshot
 * guarantees above, and is what `tests/unit/lightning.test.ts` pins.
 *
 * The bolt is built in a LOCAL frame -- origin on the water at the strike, +Y
 * up -- and the caller is what puts that frame somewhere on the globe. So
 * nothing in here knows about `GLOBE_RADIUS` or about where the ship is, and
 * a bolt over a cell 200 units away is built by exactly the same arithmetic as
 * one alongside the hull.
 *
 * Exported for the tests.
 */
export function buildBolt(positions: Float32Array, seed: number): number {
  const rng = mulberry32(seed);
  const drop = BOLT_TOP - BOLT_FOOT;
  const step = drop / TRUNK_STEPS;

  // ---- The trunk's own path, walked once -------------------------------
  //
  // A random walk with the step scaled by the drop, rather than a midpoint
  // displacement: a walk is what gives lightning its characteristic run of
  // short straight sections in one direction before it turns, and a midpoint
  // subdivision gives a shape that is self-similar and therefore too tidy.
  const trunkX = new Float32Array(TRUNK_STEPS + 1);
  const trunkZ = new Float32Array(TRUNK_STEPS + 1);
  const wander = (TRUNK_WANDER * drop) / TRUNK_STEPS;
  let x = 0;
  let z = 0;
  for (let i = 0; i <= TRUNK_STEPS; i++) {
    trunkX[i] = x;
    trunkZ[i] = z;
    x += (rng() * 2 - 1) * wander;
    z += (rng() * 2 - 1) * wander;
  }

  let segment = 0;

  /** One segment, from (ax, ay, az) to (bx, by, bz). */
  function push(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): void {
    if (segment >= MAX_SEGMENTS) return;
    const o = segment * 6;
    positions[o] = ax;
    positions[o + 1] = ay;
    positions[o + 2] = az;
    positions[o + 3] = bx;
    positions[o + 4] = by;
    positions[o + 5] = bz;
    segment++;
  }

  // ---- The strands ------------------------------------------------------
  //
  // The same path, drawn `TRUNK_STRANDS` times with a small fixed offset per
  // strand. Fixed and not re-rolled: three independent walks would be three
  // bolts, and what is wanted is one bolt with a thickness.
  for (let s = 0; s < TRUNK_STRANDS; s++) {
    // Spread the strands around the axis rather than along one line, so the
    // bolt has a width from every bearing the camera can take.
    const angle = (s / TRUNK_STRANDS) * Math.PI * 2;
    const ox = s === 0 ? 0 : Math.cos(angle) * STRAND_SPREAD;
    const oz = s === 0 ? 0 : Math.sin(angle) * STRAND_SPREAD;
    for (let i = 0; i < TRUNK_STEPS; i++) {
      const ay = BOLT_TOP - i * step;
      push(
        trunkX[i] + ox,
        ay,
        trunkZ[i] + oz,
        trunkX[i + 1] + ox,
        ay - step,
        trunkZ[i + 1] + oz,
      );
    }
  }

  // ---- The forks --------------------------------------------------------
  const branches = rng() < 0.35 ? 1 : BRANCH_MAX;
  for (let b = 0; b < branches; b++) {
    const at = Math.min(
      TRUNK_STEPS - 1,
      Math.floor((BRANCH_HI + rng() * (BRANCH_LO - BRANCH_HI)) * TRUNK_STEPS),
    );
    let bx = trunkX[at];
    let bz = trunkZ[at];
    let by = BOLT_TOP - at * step;
    // A fork leaves in one direction and keeps going that way, wandering
    // around it. A fork that re-rolled its bearing every step would curl back
    // into the trunk it just left.
    const bearing = rng() * Math.PI * 2;
    const dx = Math.cos(bearing);
    const dz = Math.sin(bearing);
    const bstep = ((by - BOLT_FOOT) * BRANCH_FALL) / BRANCH_STEPS;
    const spread = bstep * BRANCH_SPREAD;
    for (let i = 0; i < BRANCH_STEPS; i++) {
      const nx = bx + dx * spread + (rng() * 2 - 1) * spread * 0.5;
      const nz = bz + dz * spread + (rng() * 2 - 1) * spread * 0.5;
      const ny = by - bstep;
      push(bx, by, bz, nx, ny, nz);
      bx = nx;
      by = ny;
      bz = nz;
    }
  }

  // Anything the bolt did not use is collapsed to a degenerate segment at the
  // origin rather than left holding last strike's vertices. `setDrawRange`
  // below means the GPU never sees these, but a stale tail in the buffer is
  // the kind of thing that surfaces the one time the draw range is wrong.
  for (let i = segment; i < MAX_SEGMENTS; i++) {
    const o = i * 6;
    for (let k = 0; k < 6; k++) positions[o + k] = 0;
  }

  return segment;
}

/* ------------------------------------------------------------------ */
/* The module                                                          */
/* ------------------------------------------------------------------ */

/**
 * The lightning.
 *
 * Built unconditionally, on every quality tier including `low`. Unlike the
 * rain -- which is thousands of vertices every frame it falls, and which the
 * low tier therefore does without -- a bolt is under two hundred vertices for
 * a third of a second every few storms, so there is no tier at which cutting
 * it buys anything worth the storm it takes away.
 */
export function createLightning(): Lightning {
  const object = new THREE.Group();
  object.name = 'lightning';

  const positions = new Float32Array(MAX_SEGMENTS * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, 0);

  const material = new THREE.MeshBasicMaterial({
    color: BOLT_COLOR.clone(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  const bolt = new THREE.LineSegments(geometry, material);
  bolt.name = 'lightning-bolt';
  // The bolt is placed by the group and built around the group's own origin,
  // and a strike near the ship can extend a couple of hull lengths from it, so
  // the automatic bounding sphere would be right -- but it is recomputed only
  // when asked, and this geometry changes shape mid-frame. Culling it by hand
  // is one boolean against a sphere that would otherwise have to be rebuilt on
  // every strike.
  bolt.frustumCulled = false;
  // LAYER_DEFAULT only, for the reason `rain.ts` records at the same line: the
  // reflection camera sits at the ship's own waterline, and a bolt drawn into
  // that cube would appear as a bright bar in the water under the hull.
  bolt.layers.set(LAYER_DEFAULT);
  object.add(bolt);

  /** Scratch, so `update` allocates nothing. */
  const _up = new THREE.Vector3();
  const _east = new THREE.Vector3();
  const _north = new THREE.Vector3();
  const _matrix = new THREE.Matrix4();

  /**
   * A right-handed basis at `dir`, left in `_east`, `_up`, `_north`.
   *
   * The handedness is the whole point and is worth stating, because getting it
   * wrong does not throw and does not look like an orientation bug: a basis
   * whose determinant is -1 is a REFLECTION, `setFromRotationMatrix` is only
   * defined for a rotation, and the bolt it produced came out lying flat on
   * the water rather than standing in the air. `_east` cross `_up` is `_north`,
   * in that order, which is what makes `makeBasis(_east, _up, _north)` a
   * rotation.
   */
  function tangentAt(dir: THREE.Vector3): void {
    _up.copy(dir).normalize();
    // Any vector not parallel to the local vertical will do to start from.
    _east.set(0, 1, 0).cross(_up);
    if (_east.lengthSq() < 1e-8) _east.set(1, 0, 0).cross(_up);
    _east.normalize();
    _north.crossVectors(_east, _up).normalize();
  }

  /** The seed the live geometry was built from. 0 when there is none. */
  let builtSeed = 0;

  /**
   * Where the live bolt stands, as a unit direction, and how far its own
   * frame is offset within that. Held rather than recomputed, so the bolt
   * cannot wander over the life of a flash.
   */
  const _stand = new THREE.Vector3();

  function update(_dt: number, ship: ShipState, weather: WeatherState): void {
    const flash = weather.flash;
    bolt.visible = flash > BOLT_VISIBLE && weather.flashSeed !== 0;
    if (!bolt.visible) {
      // A retired strike takes its geometry with it, so the next one cannot
      // reuse a shape by accident if `weather.ts` ever repeats a seed.
      builtSeed = 0;
      return;
    }

    if (weather.flashSeed !== builtSeed) {
      builtSeed = weather.flashSeed;
      const segments = buildBolt(positions, builtSeed);
      geometry.attributes.position.needsUpdate = true;
      geometry.setDrawRange(0, segments * 2);

      // ---- Where it stands, decided once, on the strike's own seed --------
      //
      // A second stream off the same seed, so the place is as reproducible as
      // the shape and neither costs `weather.ts` a draw.
      const place = mulberry32(builtSeed ^ 0x9e3779b9);
      const origin = weather.flashOrigin;
      _stand.copy(origin ?? ship.position).normalize();
      // A squall's bolt is thrown clear of the hull; a cell's is scattered
      // inside the cell it belongs to. Both are an offset along the local
      // tangent, so both work anywhere on the globe.
      const bearing = place() * Math.PI * 2;
      const reach = origin
        ? // A cell's own radius is not published on `WeatherState`, and
          // reaching into `CellsState` for it would give this module a second
          // opinion about which cell is striking. NEAR_MAX is a good stand-in:
          // it is inside the smallest storm this world makes, so the bolt
          // lands in the cell whichever cell it is.
          NEAR_MAX * CELL_SPREAD * Math.sqrt(place())
        : NEAR_MIN + place() * (NEAR_MAX - NEAR_MIN);
      // Any tangent basis will do -- the offset's bearing is random within it
      // -- so this takes the cheapest one rather than parallel-transporting a
      // frame nothing else here reads.
      tangentAt(_stand);
      _stand
        .addScaledVector(_east, (Math.cos(bearing) * reach) / GLOBE_RADIUS)
        .addScaledVector(_north, (Math.sin(bearing) * reach) / GLOBE_RADIUS)
        .normalize();

      // The bolt's own frame: +Y along the local vertical at the strike, so
      // "down" means down wherever on the globe it lands.
      tangentAt(_stand);
      _matrix.makeBasis(_east, _up, _north);
      object.quaternion.setFromRotationMatrix(_matrix);
      // `_stand` is a unit DIRECTION, like every other follower's, so it has
      // to be pushed out to the water to become a position.
      object.position.copy(_stand).multiplyScalar(GLOBE_RADIUS);
    }

    // The only per-frame work: the bolt rides the flash's own double-pulse
    // envelope, so the channel dims and re-lights with the sky rather than on
    // a clock of its own.
    material.opacity = Math.min(1, flash * BOLT_PEAK);
  }

  return { object, update };
}

/* Exported for the tests. */
export { MAX_SEGMENTS, BOLT_TOP, BOLT_FOOT, TRUNK_STEPS, TRUNK_STRANDS };
