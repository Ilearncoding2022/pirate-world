/**
 * hazards.ts — the rough water: strong waves that shove the hull, and
 * maelstroms that eat it.
 *
 * Owns one `HazardState`, **mutated in place for the life of the run**,
 * exactly as `energy.ts` owns its tank and `wind.ts` its weather. The water
 * shader, the displacement patch, the hull and the scope all hold that same
 * reference; handing out a copy would leave them reading a sea that had
 * stopped moving.
 *
 * DOM-free and scene-free by design: this module moves numbers and vectors,
 * which is what makes the whole rule set testable in the two-second tier.
 * `hazardfield.ts` owns what a hazard LOOKS like; this owns when one rises,
 * where it goes, and what it does to the ship.
 *
 * The brief is docs/HAZARDS_PLAN.md. Read it before retuning anything here.
 *
 * Two geometry rules run through the whole file and neither is optional:
 *
 *   - **Nothing is kept as a compass bearing.** A hazard is a centre and a
 *     pair of tangent vectors, carried across its own travel by parallel
 *     transport, exactly as `ship.ts` carries the bow and `wind.ts` carries
 *     the wind. A bearing lives in the tangent frame at one point, and that
 *     frame spins arbitrarily fast near a pole — which is the bug that made
 *     the hull twist on the spot up there. `tangentFrame` is built fresh at
 *     the point of use and never held.
 *   - **`north` is the direction of travel, `east` is the crest's long axis.**
 *     `east = normalize(cross(north, centre))`, `extent` is measured along
 *     `east` and `halfWidth` along `north`. Swap those two and a 20-unit wall
 *     of water becomes a 5-unit stub.
 *
 * A crest's `centre` and `extent` are both live: land eats a wave from the
 * end that met it (`clipToWater`), which shortens `extent` and slides
 * `centre` onto the middle of what survives. Nothing downstream needs to know
 * — the shader, the CPU port the hull rides, the contact test and the scope
 * all read the pair — but nothing may cache either of them across a frame.
 */
import { Vector3 } from 'three';
import type {
  EnergyState,
  HazardKind,
  HazardState,
  ShipState,
  Terrain,
  Towns,
  WindState,
} from './types';
import type { HeightMap } from './heightmap';
import type { WaterBodies } from './waterbodies';
import { GLOBE_RADIUS, latLonToDir, tangentFrame } from './geo';
import { mulberry32, randomDirection } from './towns';
import { SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import {
  CREST_HALF_LENGTH,
  CREST_HALF_WIDTH,
  CREST_HEIGHT,
  FUNNEL_DEPTH,
  GREAT_CREST_HEIGHT,
  MAELSTROM_RADIUS,
  MAX_HAZARDS,
} from './hazardfield';

export interface HazardsDeps {
  readonly terrain: Terrain;
  readonly heightMap: HeightMap;
  readonly waterBodies: WaterBodies;
  readonly towns: Towns;
  /**
   * Fixed by default, so a given world rolls the same weather — the same
   * argument `wind.ts` makes for WIND_SEED. Reproducible hazards are worth
   * more than novelty here: tuning a spiral and chasing a push bug both need
   * the same maelstrom to come back on the next run.
   */
  readonly seed?: number;
  /**
   * Fired once, on the frame the hull vanishes into a funnel. `main.ts` runs
   * the wreck from here: the power is cut, the screen goes black, the ship is
   * placed somewhere else, and this module is reset.
   */
  readonly onSunk: () => void;
}

export interface Hazards {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: HazardState;
  /**
   * Runs after `wind.update` and before `ship.update`. After the wind for two
   * reasons now: it needs this frame's docked verdict — `energy.ts` owns the
   * one definition of berthed and a berth is shelter from rough water too —
   * and a crest is raised upwind and travels with the weather, so it needs
   * this frame's wind rather than last frame's. Before the ship because the
   * ship spends the push, and obeys the drive, this same frame.
   */
  /**
   * `stormOdds` multiplies each kind's spawn probability. 1 in fair weather,
   * up to `1 + STORM_ODDS_GAIN` in a full storm, computed once in `main.ts`
   * so the hazards and the raiders cannot end up on two different readings of
   * the same sky.
   *
   * It multiplies the COMPARISON and nothing else. The draw itself stays
   * unconditional -- see the note on `ROLL_ORDER` -- so a stormy run and a
   * clear one consume the same numbers in the same order, and the seeded
   * stream still replays.
   */
  update(
    dt: number,
    ship: ShipState,
    energy: EnergyState,
    wind: WindState,
    stormOdds?: number,
  ): void;
  /** Clears every hazard and returns to `free`. Called while the screen is black. */
  reset(): void;
  /** Raises one hazard now, at `centre`, travelling `north`. Tests and `?hazard=` only. */
  force(kind: HazardKind, centre: Vector3, north: Vector3): void;
  /** A random point of reachable open ocean, clear of land and of every berth. */
  pickRespawn(): Vector3;
}

/* ------------------------------------------------------------------ */
/* Tuning constants                                                    */
/* ------------------------------------------------------------------ */

/**
 * Seconds between rolls, and the odds each kind is drawn at on a roll.
 *
 * Read them together: they are one rate, expressed as a cadence and three
 * chances. The period is the tick BOTH kinds are drawn on — there is one
 * timer, not one per kind — so moving it moves all three frequencies
 * together, which is usually not what you wanted; move a single probability
 * instead.
 *
 * At one roll a second the nominal waits are a strong wave every 5 s, a great
 * wave every 10 and a maelstrom every 50 s of sailing. Those are ceilings
 * rather than rates: only one hazard of each kind is ever on the water (see
 * ROLL_ORDER), a crest lives up to CREST_LIFE = 10 s and a funnel up to
 * MAELSTROM_LIFE + 2 * MAELSTROM_GROW = 36, so what a second-by-second roll
 * actually buys is that the next one rises very soon after the last one dies,
 * not three hazards deep. The sea is close to always running, and a maelstrom
 * is a thing a player meets rather than a thing they have to be told exists.
 *
 * Note the odds are per roll and per KIND: a kind that is already on the
 * water is drawn for and skipped, so the actual rate is well under these
 * numbers once the sea is busy enough to be holding one of each.
 */
export const ROLL_PERIOD = 1;
const P_WAVE = 0.2;
const P_GREATWAVE = 0.1;
const P_MAELSTROM = 0.02;

/**
 * The fixed order the three kinds are drawn in, every roll, for every kind,
 * live or not.
 *
 * The order is what makes the stream reproducible: a run replays its own
 * weather only if the same draws come off `rng` in the same sequence, and
 * skipping the draw for a kind that happens to be live would let what is on
 * the water reorder the stream behind it. So the number is always taken; only
 * the acting on it is conditional. See `roll`.
 */
const ROLL_ORDER: readonly HazardKind[] = ['wave', 'greatwave', 'maelstrom'];
const ROLL_ODDS: Record<HazardKind, number> = {
  wave: P_WAVE,
  greatwave: P_GREATWAVE,
  maelstrom: P_MAELSTROM,
};

/**
 * How far off the ship a hazard rises, world units.
 *
 * The near end is beyond the hull's own stopping distance and outside the
 * chase camera's usual framing, so nothing ever simply appears on top of the
 * player; the far end is inside the 38-unit distance fade below, so a hazard
 * is born already visible rather than materialising out of nothing when the
 * ship closes on it. Both ends are well inside the scope's 50-unit range: a
 * player watching the radar always gets the warning.
 */
const SPAWN_MIN = 18;
const SPAWN_MAX = 30;

/**
 * Three spawns in four land within 60 degrees of UPWIND; the fourth goes
 * anywhere on the compass.
 *
 * This used to be biased toward the bow, and it had to change when the crests
 * stopped being aimed. A wave now runs with the wind and only with the wind
 * (see `crestHeading`), so where it is born is the only thing left that
 * decides whether it ever reaches the ship: raised upwind it comes down onto
 * the hull, raised downwind it leaves at 6 units/s and is never seen again.
 * Upwind is therefore the same decision the bow bias used to be, made in the
 * one frame that still means anything.
 *
 * The one draw in four that ignores the wind is kept for the reason it always
 * was: it stops the sea from feeling aimed. Some of it is simply there, and
 * some of it is water the player is sailing away from.
 */
const UPWIND_SHARE = 0.75;
const UPWIND_HALF_ARC = Math.PI / 3;

/**
 * Clearance a hazard's centre keeps from a berth, on top of that berth's own
 * radius and the hazard's extent, world units.
 *
 * A berth is shelter — `energy.ts` says a docked ship is neither pushed nor
 * captured — so a hazard whose footprint reached into a charging zone would
 * be a wall of water the player could see and sail straight through. The
 * margin is on top of `extent` so it is the hazard's *edge* that is kept out,
 * not its centre.
 */
const BERTH_MARGIN = 4;

/**
 * Placement attempts per kind per roll, then give up until the next roll.
 *
 * Every attempt costs a handful of height-map reads. Near a crowded coast
 * most of them fail, and 24 is enough that open water almost always finds a
 * spot on the first two or three while a ship deep in an archipelago simply
 * gets quieter weather — which is the right answer there anyway.
 */
const SPAWN_TRIES = 24;

/**
 * How fast a crest travels, world units/s, and how long it lives.
 *
 * 6 is slower than the hull's 10, so a wave can always be outrun downwind and
 * never quite dodged by acceleration alone. Over its 10 s life it covers 60
 * units, which is comfortably past the distance fade in every direction: a
 * crest that misses is gone rather than loitering at the edge of the patch.
 */
const CREST_SPEED = 6;
const CREST_LIFE = 10;

/**
 * Seconds a crest spends rising, and seconds it spends fading out at the end
 * of an untouched life.
 *
 * The rise is short because a wave that grows slowly reads as the sea level
 * changing rather than as a wave arriving. The fade is longer than the rise
 * for the opposite reason: something that vanished in a frame would look like
 * a dropped draw call.
 */
const CREST_RISE = 1;
const CREST_FADE = 1.5;

/**
 * The coast clip: how many intervals the crest line is probed on, how many
 * bisection steps place each surviving end on the waterline, and the shortest
 * half-length left worth drawing, world units.
 *
 * **A crest that meets land loses the part that met it, not the whole wave.**
 * Every frame the surviving stretch is re-measured along `east` and the
 * hazard's `centre` and `extent` are moved onto it, so a 20-unit front running
 * onto a headland is a shortening wall of water beside the rock rather than a
 * wave that either climbs the beach or vanishes off open sea a moment before
 * it arrives. There is no fade on the lost part: it is gone the frame the
 * water under it turns to land, which is what "breaks on the shore" looks like
 * from the deck.
 *
 * 24 intervals over a 20-unit front is a probe every 0.83 units, which is
 * about the height map's own texel at the equator (2048 texels round a 1257-
 * unit globe), so a finer grid would only resample the same bilinear ramp. It
 * does mean an islet under ~1.7 units across can fall between two probes and
 * be passed over; `islets.ts` culls land that small anyway, and a wave that
 * ignored a rock the size of the hull is a cheaper wrong answer than 40 probes
 * a frame. The 5 bisection steps then place the end itself to 0.03 units, so
 * the shortening is smooth in time rather than stepping a probe at a time.
 *
 * MIN_EXTENT is a quarter of the hull: below it there is no wave left to draw
 * or to be hit by, and the hazard is dropped outright.
 */
const COAST_INTERVALS = 24;
const COAST_REFINE = 5;
const CREST_MIN_EXTENT = 0.75;

/**
 * Seconds a crest takes to dissipate once it has hit the hull, and the peak
 * of the shove it delivers over those seconds, world units/s.
 *
 * The two are one number each way round: the hump is a half-sine, so the
 * distance carried is `2/PI * PEAK * DISSIPATE`. Three seconds at 5 carries
 * the hull about 9.5 units — three hull lengths, felt but recoverable. Five
 * seconds at 10 carries it about 32, a third of the scope, which is a great
 * wave taking the ship somewhere it did not choose to go.
 *
 * Keyed by the two crest kinds only. A maelstrom does not push; it takes.
 */
export const DISSIPATE: Record<'wave' | 'greatwave', number> = { wave: 3, greatwave: 5 };
export const PUSH_PEAK: Record<'wave' | 'greatwave', number> = { wave: 5, greatwave: 10 };

/**
 * How far past the hull's own footprint a crest counts as touching it, world
 * units.
 *
 * Half a hull. The contact test is against a point — the ship is a single
 * direction on the sphere — so without this a wave would have to hit the
 * ship's exact centre, and a 3.1-unit hull would visibly take a crest across
 * the bow and shrug it off.
 */
const HULL_REACH = 1.0;

/**
 * Seconds a maelstrom takes to grow to full size, and seconds it holds there
 * before shrinking away over the same interval.
 *
 * Three seconds of growth is the player's warning: a funnel that opened
 * instantly under the hull would be unavoidable rather than difficult. Thirty
 * seconds of hold is long enough to be a hazard to navigate around and short
 * enough that a player who backs off has genuinely escaped it.
 *
 * The hold is extended indefinitely while a ship is inside it — a maelstrom
 * that has caught something stays until it has eaten it — and `reset()` is
 * what finally removes it.
 */
const MAELSTROM_GROW = 3;
const MAELSTROM_LIFE = 30;

/**
 * The spiral: seconds from capture to the hull vanishing, turns made in that
 * time, and how far below the waterline the hull is drawn at the end, world
 * units.
 *
 * Six seconds is the length of the cutscene the player did not ask for, so it
 * is as short as it can be while still reading as being dragged under rather
 * than teleported. Two and a half turns at an accelerating rate is what makes
 * it look like a drain and not a landing approach. SINK_DEPTH is comfortably
 * more than the hull's draught plus its freeboard, so nothing is left poking
 * out of the water on the frame `onSunk` fires.
 */
export const SPIRAL_SECONDS = 6;
const SPIRAL_TURNS = 2.5;
const SINK_DEPTH = 2.5;
/** Fraction of the spiral that passes before the hull starts going under. */
const SINK_START = 0.6;

/**
 * Distance fade: a hazard is at full strength within FADE_NEAR of the ship
 * and gone beyond FADE_FAR, world units.
 *
 * This is not decoration and it is not an art choice. The displacement patch
 * is 80 units square and skirts its own displacement to zero from 34 units
 * out; the sphere behind it is undisplaced. A hazard still at strength when
 * it leaves the patch would go on tilting the normal and foaming on flat
 * water — a painted stripe on the sea. So the envelope every consumer reads
 * carries this fade baked into it, and it is recomputed every frame because
 * the ship moves even when the hazard does not.
 */
const FADE_NEAR = 32;
const FADE_FAR = 38;

/**
 * How much open water a respawn point needs around it, world units, probed on
 * eight bearings.
 *
 * The ship reappears stopped and on a random heading, so it may be pointing
 * at whatever is nearest. Six units is about two hull lengths of sea in every
 * direction — enough that the first thing a player does after a wreck is not
 * run aground on a beach they were dropped against.
 */
export const RESPAWN_CLEARANCE = 6;
const RESPAWN_BEARINGS = 8;
/** Draws before `pickRespawn` gives up and returns the world's spawn point. */
const RESPAWN_TRIES = 500;

/**
 * Weather seed. Fixed by default, so a given world always rolls the same
 * rough water — the same argument `wind.ts` makes for WIND_SEED.
 */
const HAZARD_SEED = 0x5ea0bb;

const TWO_PI = Math.PI * 2;
/** World units to radians of arc on this globe. */
const ARC = 1 / GLOBE_RADIUS;

/* ------------------------------------------------------------------ */
/* Module-scope scratch (no per-frame allocation in the hot path)      */
/* ------------------------------------------------------------------ */

const _north = new Vector3();
const _east = new Vector3();
const _axis = new Vector3();
const _bearingDir = new Vector3();
const _prevCentre = new Vector3();
const _probe = new Vector3();
const _starboard = new Vector3();
const _pushDir = new Vector3();
const _radial = new Vector3();
const _prevDrivePos = new Vector3();
const _candidate = new Vector3();
const _footprint = new Vector3();

/** Clamp to [0, 1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The usual cubic ease, on an already-unclamped argument. */
function smoothstep01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * Rotate `from` by `angle` toward the tangent direction `dir`, about their
 * cross product — the same great-circle step `ship.ts` walks in `stepAlong`
 * and `wind.ts` in its coast probe. Returns false, writing nothing, when the
 * two are parallel and no axis exists.
 */
function stepAlong(out: Vector3, from: Vector3, dir: Vector3, angle: number): boolean {
  _axis.crossVectors(from, dir);
  if (_axis.lengthSq() < 1e-12) return false;
  _axis.normalize();
  out.copy(from).applyAxisAngle(_axis, angle).normalize();
  return true;
}

/** Great-circle distance between two unit directions, world units. */
function arcDistance(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * GLOBE_RADIUS;
}

/* ------------------------------------------------------------------ */
/* Hazards                                                             */
/* ------------------------------------------------------------------ */

/** Internal, mutable mirror of the read-only Hazard surface, plus its bookkeeping. */
interface MutableHazard {
  kind: HazardKind;
  centre: Vector3;
  east: Vector3;
  north: Vector3;
  extent: number;
  halfWidth: number;
  amplitude: number;
  envelope: number;
  size: number;
  age: number;
  consumed: boolean;
  /** The age at which it was consumed; -1 while it is still travelling. */
  consumedAt: number;
  /**
   * Whether being consumed carries a push. Only the hull consumes a crest
   * now, so this is true wherever `consumed` is — it is kept as its own flag
   * because the two are separate facts and a future consumer (a crest broken
   * on a reef, say) would be the case that separates them again. The coast no
   * longer uses either: land cuts the wave back rather than consuming it, see
   * `clipToWater`.
   */
  pushing: boolean;
}

/** Internal, mutable mirror of the read-only HazardDrive surface. */
interface MutableDrive {
  position: Vector3;
  forward: Vector3;
  sink: number;
}

/** Internal, mutable mirror of the read-only HazardState surface. */
interface MutableHazardState {
  live: MutableHazard[];
  along: number;
  across: number;
  phase: 'free' | 'spiral' | 'sunk';
  drive: MutableDrive | null;
}

export function createHazards(deps: HazardsDeps): Hazards {
  const { terrain, heightMap, waterBodies, towns, onSunk } = deps;
  const rng = mulberry32(deps.seed ?? HAZARD_SEED);

  const state: MutableHazardState = {
    live: [],
    along: 0,
    across: 0,
    phase: 'free',
    drive: null,
  };

  /**
   * Allocated once and handed out by reference, like everything else here:
   * `ship.ts` reads it every frame while the hull is being driven, and a
   * fresh object per frame would be sixty allocations a second for a thing
   * that is only ever three numbers.
   */
  const drive: MutableDrive = { position: new Vector3(), forward: new Vector3(), sink: 0 };

  let rollTimer = 0;
  /** The maelstrom that has the ship, while `phase !== 'free'`. */
  let captor: MutableHazard | null = null;
  let spiralTime = 0;
  let spiralR0 = 0;
  let spiralTheta0 = 0;
  let sunkFired = false;

  /* ---- The world's opinion of a point -------------------------------- */

  /*
   * Both questions are asked of the same rasterised height field the water
   * shader and the scope read, never of `terrain.heightAt`. Three readings of
   * one field can never disagree about where the shoreline is, which is the
   * reason `globe.ts` installs the map as the ship's land mask in the first
   * place.
   */
  function isOpenWater(dir: Vector3): boolean {
    return heightMap.sample(dir) < terrain.seaLevel && waterBodies.sample(dir) < 0.5;
  }

  /** True if any berth's centre is within `clearance` world units of `dir`. */
  function nearBerth(dir: Vector3, clearance: number): boolean {
    const all = towns.all;
    for (let i = 0; i < all.length; i++) {
      const dock = all[i].dock;
      if (dock === null) continue;
      if (arcDistance(dir, dock.dir) < clearance) return true;
    }
    return false;
  }

  /* ---- Building one ------------------------------------------------- */

  function extentOf(kind: HazardKind): number {
    return kind === 'maelstrom' ? MAELSTROM_RADIUS : CREST_HALF_LENGTH;
  }

  /**
   * The profile's scale in world units, and it is POSITIVE for every kind --
   * a maelstrom's is the funnel's DEPTH, not a signed height.
   *
   * The minus sign lives inside `hazardfield.ts`'s profile, so that the rim
   * can be a positive fraction of the same number. Handing a negative one
   * over raises a mountain where the hole belongs, and does it identically on
   * the GPU and the CPU -- so the parity probe still agrees to the pixel, the
   * unit tests on both sides still pass, and the only thing that is wrong is
   * the sea. See `hazardStrength`, which is the other half of this contract.
   */
  function amplitudeOf(kind: HazardKind): number {
    if (kind === 'maelstrom') return FUNNEL_DEPTH;
    return kind === 'greatwave' ? GREAT_CREST_HEIGHT : CREST_HEIGHT;
  }

  /**
   * Raise a hazard at `centre` travelling toward `north`, and file it.
   *
   * `east` is rebuilt from `north` rather than passed in, so the pair can
   * never be handed over inconsistent: `east = normalize(cross(north,
   * centre))` is the one definition, here and in the transport below.
   */
  function build(kind: HazardKind, centre: Vector3, north: Vector3): MutableHazard {
    const c = centre.clone().normalize();
    const n = north.clone();
    // Project the requested heading onto the tangent plane at the centre; a
    // caller (`force`, the dev query) may hand over anything.
    n.addScaledVector(c, -n.dot(c));
    if (n.lengthSq() < 1e-12) tangentFrame(c, n, _east);
    n.normalize();
    const e = new Vector3().crossVectors(n, c).normalize();

    const hazard: MutableHazard = {
      kind,
      centre: c,
      east: e,
      north: n,
      extent: extentOf(kind),
      halfWidth: kind === 'maelstrom' ? 0 : CREST_HALF_WIDTH,
      amplitude: amplitudeOf(kind),
      envelope: 0,
      size: kind === 'maelstrom' ? 0 : 1,
      age: 0,
      consumed: false,
      consumedAt: -1,
      pushing: false,
    };
    // One of each kind, so a second of the same kind replaces the first
    // rather than quietly pushing the count past MAX_HAZARDS.
    for (let i = state.live.length - 1; i >= 0; i--) {
      if (state.live[i].kind === kind) state.live.splice(i, 1);
    }
    state.live.push(hazard);
    return hazard;
  }

  function liveOf(kind: HazardKind): MutableHazard | null {
    for (let i = 0; i < state.live.length; i++) {
      if (state.live[i].kind === kind) return state.live[i];
    }
    return null;
  }

  /* ---- Spawning ----------------------------------------------------- */

  /**
   * The heading a crest travels on: the wind's, resolved at the crest's own
   * centre. Written into `_north`, with `_east` rebuilt to match.
   *
   * Waves go where the weather goes. That is the whole rule, and it replaces
   * a crest that used to be aimed at where the ship would be in four seconds:
   * the sea is not hunting anybody, and a player who can read the wind can
   * now read the water as well, which is worth more than a hazard that
   * quietly followed them.
   *
   * `wind.direction` is a world vector in the tangent plane at the SHIP (see
   * `WindState.direction` on why it is kept as a vector and not a bearing).
   * The crest is up to 30 units away, where that plane is a fraction of a
   * degree off, so it is projected onto the tangent plane at `centre` and
   * renormalised rather than used as it stands. Falls back to any frame at
   * all in the degenerate case, which needs the wind to be pointing straight
   * up out of the sea.
   */
  function crestHeading(centre: Vector3, wind: WindState): void {
    _north.copy(wind.direction);
    _north.addScaledVector(centre, -_north.dot(centre));
    if (_north.lengthSq() < 1e-12) {
      tangentFrame(centre, _north, _east);
      return;
    }
    _north.normalize();
    _east.crossVectors(_north, centre).normalize();
  }

  /**
   * Try to place one hazard of `kind`. Returns whether it was placed.
   *
   * The plan lists the acceptance tests before the choice of heading, but a
   * crest's footprint is measured along `east`, which only exists once
   * `north` does — so the heading is drawn first and the footprint tested
   * against the frame it produced. Same tests, same points, in the only order
   * that can actually evaluate them.
   */
  function trySpawn(kind: HazardKind, ship: ShipState, wind: WindState): boolean {
    if (state.live.length >= MAX_HAZARDS) return false;
    const extent = extentOf(kind);

    for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
      const d = SPAWN_MIN + rng() * (SPAWN_MAX - SPAWN_MIN);
      const upwind = rng() < UPWIND_SHARE;
      const offset = upwind ? (rng() * 2 - 1) * UPWIND_HALF_ARC : rng() * TWO_PI;

      /*
       * The bearing is resolved by turning a VECTOR about the ship's own up,
       * never by adding an offset to a compass bearing and rebuilding it in a
       * tangent frame. Algebraically the same wherever a frame exists, and
       * unlike the addition it still means "60 degrees off upwind" where one
       * does not. The uniform draw needs no frame either: any rotation through
       * a full turn covers the compass.
       *
       * The vector turned is the wind REVERSED -- `wind.direction` is where
       * the air is going, so its negation is where it is coming from, and
       * that is where the water the ship is about to meet has to be born.
       * `wind.ts` floors the weather at LULL_SPEED so there is always a
       * direction to read; the bow is the fallback only in the degenerate
       * case where the wind vector has collapsed onto the local up.
       */
      _bearingDir.copy(wind.direction).negate();
      _bearingDir.addScaledVector(ship.position, -_bearingDir.dot(ship.position));
      if (_bearingDir.lengthSq() < 1e-12) _bearingDir.copy(ship.forward);
      _bearingDir.applyAxisAngle(ship.up, offset);
      _bearingDir.addScaledVector(ship.position, -_bearingDir.dot(ship.position));
      if (_bearingDir.lengthSq() < 1e-12) continue;
      _bearingDir.normalize();
      if (!stepAlong(_candidate, ship.position, _bearingDir, d * ARC)) continue;

      // The centre first: the cheapest test, and the one that rejects most.
      if (!isOpenWater(_candidate)) continue;
      if (nearBerth(_candidate, extent + BERTH_MARGIN + largestBerthRadius())) continue;

      // The heading, and with it the frame the footprint is measured in.
      if (kind === 'maelstrom') {
        tangentFrame(_candidate, _north, _east);
      } else {
        crestHeading(_candidate, wind);
      }

      // The footprint: a crest's two ends, a maelstrom's four compass points.
      let clear = true;
      for (let i = 0; i < 4; i++) {
        if (kind !== 'maelstrom' && i >= 2) break;
        const along = i < 2 ? _east : _north;
        const sign = i % 2 === 0 ? 1 : -1;
        _footprint.copy(along).multiplyScalar(sign);
        if (!stepAlong(_probe, _candidate, _footprint, extent * ARC)) continue;
        if (!isOpenWater(_probe)) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;

      build(kind, _candidate, _north);
      return true;
    }
    return false;
  }

  /**
   * The widest berth in the world, cached once.
   *
   * The plan's clearance is `DOCK_RADIUS + extent + BERTH_MARGIN`, and
   * `DOCK_RADIUS` is private to `towns.ts` — it reaches this module only as
   * `Dock.radius`. Taking the largest rather than each berth's own keeps the
   * test one comparison per berth and errs outward, which is the safe side of
   * a rule about not putting a wall of water in a charging zone.
   */
  let berthRadius = -1;
  function largestBerthRadius(): number {
    if (berthRadius >= 0) return berthRadius;
    berthRadius = 0;
    for (const town of towns.all) {
      if (town.dock !== null && town.dock.radius > berthRadius) berthRadius = town.dock.radius;
    }
    return berthRadius;
  }

  /**
   * One roll: a draw for every kind, in a fixed order, live or not.
   *
   * The unconditional draw is the whole point — see ROLL_ORDER.
   */
  function roll(ship: ShipState, wind: WindState, stormOdds: number): void {
    for (const kind of ROLL_ORDER) {
      const draw = rng();
      if (liveOf(kind) !== null) continue;
      if (draw < ROLL_ODDS[kind] * stormOdds) trySpawn(kind, ship, wind);
    }
  }

  /* ---- Envelopes ----------------------------------------------------- */

  /** 1 within FADE_NEAR of the ship, 0 beyond FADE_FAR. See the constants. */
  function distanceFade(ship: ShipState, centre: Vector3): number {
    const d = arcDistance(ship.position, centre);
    return 1 - smoothstep01((d - FADE_NEAR) / (FADE_FAR - FADE_NEAR));
  }

  /**
   * Advance one hazard's shape envelope and size, and say whether it is over.
   *
   * The rise/hold/fade shape and the distance fade are multiplied together
   * into the single `envelope` all three consumers read, so a hazard that
   * outruns the displacement patch dissolves instead of painting a stripe on
   * the sphere behind it.
   */
  function shapeEnvelope(h: MutableHazard, ship: ShipState): boolean {
    if (h.kind === 'maelstrom') {
      let g: number;
      if (h.age < MAELSTROM_GROW) {
        g = smoothstep01(h.age / MAELSTROM_GROW);
      } else if (h.age < MAELSTROM_LIFE || state.phase !== 'free') {
        // A funnel with a ship in it does not expire; `reset()` removes it.
        g = 1;
      } else {
        const t = h.age - MAELSTROM_LIFE;
        if (t >= MAELSTROM_GROW) return true;
        g = 1 - smoothstep01(t / MAELSTROM_GROW);
      }
      h.size = g;
      h.envelope = g * distanceFade(ship, h.centre);
      return false;
    }

    const rise = smoothstep01(h.age / CREST_RISE);
    let fall: number;
    if (h.consumed) {
      const t = h.age - h.consumedAt;
      const span = DISSIPATE[h.kind === 'greatwave' ? 'greatwave' : 'wave'];
      if (t >= span) return true;
      fall = 1 - smoothstep01(t / span);
    } else {
      if (h.age >= CREST_LIFE) return true;
      fall = smoothstep01((CREST_LIFE - h.age) / CREST_FADE);
    }
    h.size = 1;
    h.envelope = rise * fall * distanceFade(ship, h.centre);
    return false;
  }

  /* ---- Transport ----------------------------------------------------- */

  /**
   * Carry a crest one step along its own travel line.
   *
   * The step is a great-circle rotation and `north` is carried by exactly
   * that same rotation — parallel transport, `ship.ts`'s way with the bow.
   * The `reframe` afterwards is not decoration: each step leaves `north` a
   * rounding error out of the tangent plane, and over a 60-unit life those
   * errors accumulate into a crest that is no longer flat on the sea.
   */
  function transport(h: MutableHazard, dt: number): void {
    _prevCentre.copy(h.centre);
    if (!stepAlong(h.centre, h.centre, h.north, CREST_SPEED * dt * ARC)) return;

    _axis.crossVectors(_prevCentre, h.centre);
    const sin = _axis.length();
    if (sin > 1e-12) {
      _axis.multiplyScalar(1 / sin);
      const cos = Math.max(-1, Math.min(1, _prevCentre.dot(h.centre)));
      h.north.applyAxisAngle(_axis, Math.atan2(sin, cos));
    }
    reframe(h);
  }

  /**
   * Re-orthonormalise a crest's frame after its centre has been moved, and
   * rebuild `east` from the corrected `north`.
   *
   * Shared by `transport` (which moves the centre along `north`) and
   * `shiftAlongEast` (which moves it along `east`); both leave `north` a
   * rounding error out of the new tangent plane, and over a 60-unit life
   * those errors accumulate into a crest that is no longer flat on the sea.
   */
  function reframe(h: MutableHazard): void {
    h.north.addScaledVector(h.centre, -h.north.dot(h.centre));
    if (h.north.lengthSq() > 1e-12) h.north.normalize();
    else tangentFrame(h.centre, h.north, _east);
    h.east.crossVectors(h.north, h.centre).normalize();
  }

  /**
   * Slide a crest's centre `offset` world units along its own long axis.
   *
   * This is how the coast clip re-centres a wave on what is left of it: the
   * profile in `hazardfield.ts` is symmetric about `centre` and measured out
   * to `extent`, so a crest that has lost one end has to move onto the middle
   * of the other rather than grow an offset the shader has no uniform for.
   * Everything downstream — the shader, the CPU port the hull rides, the
   * contact test, the scope's bar — then follows from `centre` and `extent`
   * with no further change.
   *
   * The rotation is about `north` (the axis `stepAlong` builds is
   * `centre x east`, which is `north` by construction), so the travel
   * direction is untouched and only the frame needs tidying afterwards.
   */
  function shiftAlongEast(h: MutableHazard, offset: number): void {
    if (offset === 0) return;
    if (!stepAlong(h.centre, h.centre, h.east, offset * ARC)) return;
    reframe(h);
  }

  /** True where the crest line at `offset` world units along `east` is dry. */
  function landAlongCrest(h: MutableHazard, offset: number): boolean {
    if (!stepAlong(_probe, h.centre, h.east, offset * ARC)) _probe.copy(h.centre);
    return heightMap.sample(_probe) > terrain.seaLevel;
  }

  /**
   * Bisect between a dry offset and a wet one, and return the wettest bound
   * it is sure of.
   *
   * Conservative by construction: the value returned has been sampled as
   * water, so the surviving span never reaches past the waterline onto the
   * beach even when the bisection runs out of steps.
   */
  function waterline(h: MutableHazard, dry: number, wet: number): number {
    for (let k = 0; k < COAST_REFINE; k++) {
      const mid = (dry + wet) / 2;
      if (landAlongCrest(h, mid)) dry = mid;
      else wet = mid;
    }
    return wet;
  }

  /**
   * Cut a crest back to the longest stretch of open water it still covers,
   * and say whether anything is left of it.
   *
   * Called every frame a crest travels, so the wave breaks up as it meets the
   * shore rather than at some threshold moment. Three properties are worth
   * keeping if this is ever rewritten:
   *
   *   - **It only ever shrinks.** The probe runs between the crest's CURRENT
   *     ends, so a wave that has broken cannot grow its lost end back when it
   *     travels clear of the rock again — which is both what water does and
   *     what stops the clip from oscillating on a bilinear waterline.
   *   - **The longest run wins.** A wave cut in two by an islet keeps the
   *     bigger half. One hazard is one span in the shader's uniforms, so the
   *     alternative to choosing is drawing a wall of water across the rock.
   *   - **The line is the whole test.** The crest has depth (`halfWidth`, 2.5
   *     units) but only its own centre line is probed, so a wave's face may
   *     overlap a beach for a fraction of a second before the line does. A
   *     second row of probes would double the cost to move the moment of
   *     breaking by about 0.4 s at CREST_SPEED.
   */
  function clipToWater(h: MutableHazard): boolean {
    const half = h.extent;
    if (half <= 0) return false;
    const n = COAST_INTERVALS;
    const stride = (2 * half) / n;

    // The longest run of consecutive wet probes, as an index pair.
    let bestFrom = -1;
    let bestTo = -1;
    let runFrom = -1;
    for (let i = 0; i <= n; i++) {
      if (landAlongCrest(h, -half + stride * i)) {
        runFrom = -1;
        continue;
      }
      if (runFrom < 0) runFrom = i;
      if (bestFrom < 0 || i - runFrom > bestTo - bestFrom) {
        bestFrom = runFrom;
        bestTo = i;
      }
    }
    // Every probe dry: the whole front is on the beach, and it goes now.
    if (bestFrom < 0) return false;
    // Every probe wet, ends included: open water, and nothing to re-measure.
    if (bestFrom === 0 && bestTo === n) return true;

    const from =
      bestFrom === 0
        ? -half
        : waterline(h, -half + stride * (bestFrom - 1), -half + stride * bestFrom);
    const to =
      bestTo === n ? half : waterline(h, -half + stride * (bestTo + 1), -half + stride * bestTo);

    const extent = (to - from) / 2;
    if (extent < CREST_MIN_EXTENT) return false;
    shiftAlongEast(h, (from + to) / 2);
    h.extent = extent;
    return true;
  }

  /* ---- The spiral ---------------------------------------------------- */

  function beginSpiral(h: MutableHazard, ship: ShipState, distance: number): void {
    state.phase = 'spiral';
    captor = h;
    spiralTime = 0;
    spiralR0 = distance;
    spiralTheta0 = Math.atan2(ship.position.dot(h.north), ship.position.dot(h.east));
    drive.position.copy(ship.position);
    drive.forward.copy(ship.forward);
    drive.sink = 0;
    state.drive = drive;
    state.along = 0;
    state.across = 0;
  }

  /**
   * One frame of being eaten.
   *
   * `r` reaches zero exactly at `s = 1` and `drive.position` is a great-circle
   * step of `r` from the funnel's centre, so the hull is never outside the
   * radius it was caught at and the position is a unit vector on every frame
   * of it — which `ship.ts` copies straight into its own state without
   * checking. The bow is taken from the direction it actually moved rather
   * than from the spiral's algebra, so it always points along the track.
   */
  function advanceSpiral(dt: number): void {
    const h = captor;
    if (h === null) return;
    spiralTime += dt;
    const s = clamp01(spiralTime / SPIRAL_SECONDS);

    const k = 1 - s;
    const r = spiralR0 * k * Math.sqrt(k);
    const theta = spiralTheta0 + TWO_PI * SPIRAL_TURNS * ((s + s * s) / 2);

    _prevDrivePos.copy(drive.position);
    _radial.copy(h.east).multiplyScalar(Math.cos(theta)).addScaledVector(h.north, Math.sin(theta));
    if (r < 1e-6 || _radial.lengthSq() < 1e-12 || !stepAlong(drive.position, h.centre, _radial, r * ARC)) {
      drive.position.copy(h.centre);
    }

    // The bow follows the track: the tangent-plane difference between where
    // the hull is and where it was. Degenerate on the frame it stops moving,
    // and there the last heading is the right one to keep.
    _pushDir.copy(drive.position).sub(_prevDrivePos);
    _pushDir.addScaledVector(drive.position, -_pushDir.dot(drive.position));
    if (_pushDir.lengthSq() > 1e-12) drive.forward.copy(_pushDir).normalize();

    drive.sink = SINK_DEPTH * smoothstep01((s - SINK_START) / (1 - SINK_START));

    if (s >= 1) {
      state.phase = 'sunk';
      drive.position.copy(h.centre);
      drive.sink = SINK_DEPTH;
      if (!sunkFired) {
        sunkFired = true;
        onSunk();
      }
    }
  }

  /* ---- The frame ----------------------------------------------------- */

  function update(
    dt: number,
    ship: ShipState,
    energy: EnergyState,
    wind: WindState,
    stormOdds = 1,
  ): void {
    // A frame that advanced no time raises no water. Returning leaves the
    // last true state standing rather than rewriting it with a stale zero.
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    const docked = energy.mode === 'docked';

    // ---- Roll -------------------------------------------------------
    rollTimer += dt;
    while (rollTimer >= ROLL_PERIOD) {
      rollTimer -= ROLL_PERIOD;
      roll(ship, wind, stormOdds);
    }

    // ---- Age, travel, and the coast ---------------------------------
    // Backwards, because a crest with no open water left under it is dropped
    // here and now: the part of a wave that meets land is gone on the frame
    // it meets it, with no dissipation to fade out through, so a front that
    // has lost every part of itself has nothing left to remove later.
    for (let i = state.live.length - 1; i >= 0; i--) {
      const h = state.live[i];
      h.age += dt;
      if (h.kind === 'maelstrom') continue;
      transport(h, dt);
      if (!clipToWater(h)) state.live.splice(i, 1);
    }

    // ---- Contact ----------------------------------------------------
    // A berth is shelter and a hull already in a funnel is not the player's
    // to shove, so neither state takes a crest at all: the wave passes over
    // and lives out its own life.
    if (!docked && state.phase === 'free') {
      for (let i = 0; i < state.live.length; i++) {
        const h = state.live[i];
        if (h.kind === 'maelstrom' || h.consumed) continue;
        // Dot products are the small-angle approximation, so they are only a
        // position on the near side of the sphere; on the far side both come
        // back near zero and every point would read as a hit.
        if (ship.position.dot(h.centre) <= 0) continue;
        // Local coordinates are dot products, never angles: `u` across the
        // travel line, `v` along it, direction units scaled to world units.
        const u = ship.position.dot(h.east) * GLOBE_RADIUS;
        const v = ship.position.dot(h.north) * GLOBE_RADIUS;
        if (Math.abs(u) < h.extent + HULL_REACH && Math.abs(v) < h.halfWidth + HULL_REACH) {
          h.consumed = true;
          h.consumedAt = h.age;
          h.pushing = true;
        }
      }
    }

    // ---- Envelopes, and what is over --------------------------------
    for (let i = state.live.length - 1; i >= 0; i--) {
      if (shapeEnvelope(state.live[i], ship)) state.live.splice(i, 1);
    }

    // ---- Push -------------------------------------------------------
    /*
     * A half-sine hump, resolved onto the hull by two dot products and
     * nothing else. No eight-sector table and no easing: unlike the wind,
     * whose table steps as the bow crosses a boundary and therefore needs
     * smoothing, this is already smooth in time by construction, and it is
     * meant to shove the hull the way the water went rather than on a point
     * of sail.
     */
    let along = 0;
    let across = 0;
    if (!docked) {
      _starboard.crossVectors(ship.forward, ship.up);
      if (_starboard.lengthSq() > 1e-12) _starboard.normalize();
      for (let i = 0; i < state.live.length; i++) {
        const h = state.live[i];
        if (!h.consumed || !h.pushing || h.kind === 'maelstrom') continue;
        const span = DISSIPATE[h.kind === 'greatwave' ? 'greatwave' : 'wave'];
        const peak = PUSH_PEAK[h.kind === 'greatwave' ? 'greatwave' : 'wave'];
        const t = h.age - h.consumedAt;
        const p = peak * Math.sin((Math.PI * t) / span);
        // The crest's travel direction, brought onto the plane the hull
        // actually moves in; a few units away that is a rotation of a degree
        // or two, but it is what keeps the pair a true resolution of one
        // vector rather than two loosely related numbers.
        _pushDir.copy(h.north).addScaledVector(ship.position, -h.north.dot(ship.position));
        if (_pushDir.lengthSq() < 1e-12) continue;
        _pushDir.normalize();
        along += p * _pushDir.dot(ship.forward);
        across += p * _pushDir.dot(_starboard);
      }
    }
    state.along = along;
    state.across = across;

    // ---- Capture, and the spiral ------------------------------------
    if (state.phase === 'free') {
      if (!docked) {
        for (let i = 0; i < state.live.length; i++) {
          const h = state.live[i];
          if (h.kind !== 'maelstrom' || h.size <= 0) continue;
          const d = arcDistance(ship.position, h.centre);
          if (d < h.extent * h.size + HULL_REACH) {
            beginSpiral(h, ship, d);
            break;
          }
        }
      }
    } else if (state.phase === 'spiral') {
      advanceSpiral(dt);
    }
  }

  function reset(): void {
    state.live.length = 0;
    state.along = 0;
    state.across = 0;
    state.phase = 'free';
    state.drive = null;
    captor = null;
    spiralTime = 0;
    sunkFired = false;
    // The roll timer goes back to zero too: a player who has just watched
    // their ship sink gets the full ten seconds somewhere else before the
    // sea starts drawing again.
    rollTimer = 0;
  }

  function force(kind: HazardKind, centre: Vector3, north: Vector3): void {
    build(kind, centre, north);
  }

  /**
   * A random point of reachable open ocean, clear of land and of every berth.
   *
   * Pure, apart from the seeded stream it draws from, and deliberately not a
   * frame-loop function: it runs once, behind a black screen, and can afford
   * five hundred tries and a ring probe on each. The fallback is the world's
   * own spawn point, which `terrain.ts` guarantees is open ocean — so this
   * always returns somewhere the ship can float, even on a world with no
   * ocean left to find.
   */
  function pickRespawn(): Vector3 {
    const out = new Vector3();
    for (let attempt = 0; attempt < RESPAWN_TRIES; attempt++) {
      randomDirection(rng, out).normalize();
      if (!isOpenWater(out)) continue;
      if (nearBerth(out, 2 * largestBerthRadius())) continue;

      // One ring of eight bearings, the same probe `wind.ts` walks for its
      // coast distance, so the ship is dropped in water that is open in every
      // direction rather than in a channel it happens to be pointing out of.
      tangentFrame(out, _north, _east);
      let clear = true;
      for (let b = 0; b < RESPAWN_BEARINGS; b++) {
        const theta = (b / RESPAWN_BEARINGS) * TWO_PI;
        _bearingDir
          .copy(_north)
          .multiplyScalar(Math.cos(theta))
          .addScaledVector(_east, Math.sin(theta));
        if (!stepAlong(_probe, out, _bearingDir, RESPAWN_CLEARANCE * ARC)) continue;
        if (!isOpenWater(_probe)) {
          clear = false;
          break;
        }
      }
      if (clear) return out;
    }
    return latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG).normalize();
  }

  return { state: state as HazardState, update, reset, force, pickRespawn };
}
