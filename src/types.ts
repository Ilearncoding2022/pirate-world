import type { Vector3 } from 'three';

/** Unified input snapshot. Written by controls.ts, read by ship.ts and camera.ts. */
export interface InputState {
  /** W / ArrowUp / on-screen up button held */
  forward: boolean;
  /** S / ArrowDown / on-screen down button held */
  backward: boolean;
  /** A / ArrowLeft / on-screen left button held */
  left: boolean;
  /** D / ArrowRight / on-screen right button held */
  right: boolean;
  /**
   * Accumulated mouse-wheel scroll since the last frame, in NOTCHES:
   * 1.0 is roughly one detent of a standard mouse wheel (~100px of deltaY).
   * Positive = wheel down = zoom out. Consumers use this value as-is; do not
   * rescale it. Reset to 0 by controls.endFrame(), which main.ts calls at the
   * end of every frame.
   */
  zoomDelta: number;
}

/** Procedural terrain query. Implemented in terrain.ts, used by globe.ts (visuals) and ship.ts (collision). */
export interface Terrain {
  /**
   * Terrain height at a unit direction vector. Roughly in [-1, 1].
   * Values above SEA_LEVEL are land. Deterministic for a given seed.
   */
  heightAt(dir: Vector3): number;
  /**
   * True if the given unit direction is on land.
   *
   * This is the ship's collision test, and it is deliberately NOT
   * `heightAt(dir) > seaLevel` once the world is assembled: `globe.ts` installs
   * the culled height map as a land mask, so the hull agrees with what is
   * actually drawn instead of with the raw noise field. The difference is every
   * islet `islets.ts` sank -- land the player cannot see and must not hit.
   */
  isLand(dir: Vector3): boolean;
  /** Convenience wrapper around isLand using degrees. */
  isLandLatLon(latDeg: number, lonDeg: number): boolean;
  /**
   * Point `isLand` at a rasterised height field instead of the noise.
   *
   * Called once, by `globe.ts`, after the map has been built and culled.
   * Passing the map's own `sample` is what makes collision, the land mesh and
   * the water shader three readings of one field rather than two.
   */
  useLandMask(sample: (dir: Vector3) => number): void;
  /** The height threshold that separates water from land. */
  readonly seaLevel: number;
}

/* ------------------------------------------------------------------ */
/* Settlements and their docks                                         */
/* ------------------------------------------------------------------ */

/**
 * A settlement. Placed once at startup by `towns.ts`, which owns the only
 * copy: `citylights.ts` lights them, `docks.ts` draws their charging zones and
 * `radar.ts` plots them, all from this same list. Nothing here changes after
 * construction.
 */
export interface Town {
  /** Unit direction from the globe centre to the town centre. */
  readonly dir: Vector3;
  /** Terrain height at `dir`, on `heightMap.sample`'s scale. */
  readonly height: number;
  /** Fraction of a probe ring around the centre that is open water, in [0, 1]. */
  readonly coast: number;
  /** Null for a landlocked town, or one whose only water the ship cannot reach. */
  readonly dock: Dock | null;
}

/** A charging berth on reachable water beside a town. */
export interface Dock {
  /** Unit direction to the centre of the charging zone, over open water. */
  readonly dir: Vector3;
  /** Radius of the zone as a great-circle distance in world units. */
  readonly radius: number;
  /** The town this berth serves. */
  readonly town: Town;
}

/** The world's settlements, built once by `towns.ts`. */
export interface Towns {
  readonly all: readonly Town[];
  /** Just the towns that have a berth, which is the subset the ship cares about. */
  readonly docks: readonly Dock[];
  /**
   * The berth whose zone contains `dir`, or null. Zones never overlap, so the
   * first hit is the only hit.
   */
  dockAt(dir: Vector3): Dock | null;
}

/* ------------------------------------------------------------------ */
/* Ship energy                                                         */
/* ------------------------------------------------------------------ */

/**
 * What the power plant is doing, for the HUD to label and colour.
 *
 * `empty` outranks the rest: it holds until the plant has recovered past the
 * restart threshold, so the tag does not flicker between EMPTY and SOLAR while
 * the panels trickle the first percent back in. It now means BOTH tanks are
 * dry — a ship coasting on its backup cell is very much still under way.
 *
 * `reserve` is that state: the main tank is empty and the frame's draw came
 * out of the bought cell. It sits between `docked` and `solar` in the ranking
 * because it is the one reading a player must not miss — the charge going down
 * is the one that no berth and no sunrise will put back.
 */
export type EnergyMode = 'docked' | 'solar' | 'drain' | 'empty' | 'reserve';

/** Read-only view of the ship's power, produced by `energy.ts`. */
export interface EnergyState {
  /** Charge in [0, 1]. The HUD is the only thing that turns this into a percentage. */
  readonly level: number;
  /**
   * Charge in the bought backup cell, in the SAME main-tank fractions as
   * `level`, in [0, BATTERY_CAPACITY]. Zero for a ship that has never bought
   * one, which is every ship until it visits a shop.
   *
   * It is a mirror of `battery.ts`, republished here so that everything which
   * reads the plant reads it from one state object. Nothing writes it through
   * this surface.
   */
  readonly reserve: number;
  /**
   * Net change in TOTAL charge per second — main tank plus backup cell.
   *
   * The total rather than `level` alone, because once the main tank is on the
   * floor `level` stops moving while the ship is still visibly burning, and a
   * rate of +0.00 %/s beside a hull under full throttle is the panel lying.
   */
  readonly rate: number;
  readonly mode: EnergyMode;
  /** The berth currently charging the ship, or null. */
  readonly dock: Dock | null;
  /**
   * False once BOTH tanks have run dry, until the plant has recovered past the
   * restart threshold. `ship.ts` refuses thrust while this is false; steering,
   * drag and the sea keep working, so the ship coasts and drifts rather than
   * freezing.
   */
  readonly canThrust: boolean;
}

/* ------------------------------------------------------------------ */
/* Wind                                                                */
/* ------------------------------------------------------------------ */

/**
 * Read-only view of the weather, produced by `wind.ts`.
 *
 * Two halves, and they are not the same thing. `speed` and `bearing` are the
 * TRUE wind -- what the world is doing, what the radar draws and the HUD
 * prints. `along` and `across` are what that wind has actually managed to do
 * to this hull: quantised to eight sectors, scaled by the grip factor and
 * eased, so they lag the true wind by a fraction of a second and are the only
 * pair `ship.ts` may move on.
 */
export interface WindState {
  /** True wind speed, world units/s. Exactly 0 during a calm. */
  readonly speed: number;
  /**
   * The compass bearing the wind is travelling TOWARD, radians, 0 = north and
   * clockwise positive -- the same convention as `ShipState.heading`, so the
   * two can be subtracted directly. Holds its last value through a calm.
   *
   * A READING, derived each frame from `direction`, and not what the wind is
   * kept as. It used to be the other way round, and near a pole that put the
   * weather in a frame that spins: see `direction`.
   */
  readonly bearing: number;
  /**
   * `bearing` as a unit vector in WORLD space -- the direction the wind
   * travels, in the tangent plane at the ship.
   *
   * This is what the wind IS. An event is authored as a bearing and resolved
   * into this vector once; from then on it is carried across the ship's own
   * motion by parallel transport, and `bearing` is read back off it.
   *
   * The order matters at the poles. A bearing is an angle in the tangent frame
   * at one point, and that frame spins arbitrarily fast where the meridians
   * converge -- so a wind held as a bearing swung round the compass in a few
   * metres of travel, shoving the hull in a circle. Held as a vector it simply
   * blows the way it was blowing. Holds its last value through a calm, as
   * `bearing` does.
   */
  readonly direction: Vector3;
  /** The strength ceiling in force at the ship right now, world units/s. */
  readonly cap: number;
  /** Eased push along the ship's forward axis, world units/s. */
  readonly along: number;
  /** Eased push along the ship's starboard axis, world units/s. */
  readonly across: number;
}

/* ------------------------------------------------------------------ */
/* Hazards — strong waves and maelstroms                               */
/* ------------------------------------------------------------------ */

/**
 * What kind of rough water this is. Three kinds, one live instance of each at
 * most, drawn on their own odds — see `hazards.ts`.
 */
export type HazardKind = 'wave' | 'greatwave' | 'maelstrom';

/**
 * One piece of rough water on the sea, owned by `hazards.ts` and mutated in
 * place for as long as it lives.
 *
 * It is read by three consumers that must agree about it to the pixel: the
 * water shader (through `waterhazard.ts`'s uniforms), the displacement patch's
 * vertex shader, and `hazardfield.ts`'s CPU port that the hull rides. See
 * docs/HAZARDS_PLAN.md — the whole field is polynomial so those three can
 * never numerically drift apart.
 */
export interface Hazard {
  readonly kind: HazardKind;
  /**
   * Unit direction of the centre. Mutated in place as a crest travels, so
   * hold the Hazard rather than copying this out.
   */
  readonly centre: Vector3;
  /** Unit tangent ACROSS the travel line — the crest's own long axis. */
  readonly east: Vector3;
  /**
   * Unit tangent ALONG the travel line: the direction a crest is moving, and
   * therefore the direction it shoves the hull.
   */
  readonly north: Vector3;
  /** Half-length (crest) or radius (maelstrom) at full size, world units. */
  readonly extent: number;
  /** Half-width of a crest, world units. 0 for a maelstrom. */
  readonly halfWidth: number;
  /**
   * Signed peak height, world units: positive for a crest, the funnel depth
   * for a maelstrom. NOT scaled by the wind — the weather raises the ordinary
   * sea, a hazard is its own weather.
   */
  readonly amplitude: number;
  /**
   * Rise/hold/fade times the distance fade, 0..1. The one number that reaches
   * the shader, so a hazard leaving the displacement patch dissolves rather
   * than painting a stripe on the undisplaced sphere.
   */
  readonly envelope: number;
  /** Size envelope: a maelstrom's radius is `extent * size`. Always 1 for a crest. */
  readonly size: number;
  /** Seconds since it rose. */
  readonly age: number;
  /** True once the hull has taken this crest's push, so it is dissipating. */
  readonly consumed: boolean;
}

/**
 * Where a captured hull is being carried, and how deep it has gone.
 *
 * Non-null exactly while `HazardState.phase !== 'free'`. `ship.ts` obeys it
 * INSTEAD of its own physics: the helm and the throttle are ignored, and the
 * hull is placed here.
 */
export interface HazardDrive {
  /** Unit direction the hull is placed at this frame. */
  readonly position: Vector3;
  /** Unit tangent the bow is turned to — the direction of the spiral's motion. */
  readonly forward: Vector3;
  /** How far the hull is drawn BELOW its waterline, world units. */
  readonly sink: number;
}

/**
 * The rough water, as everything downstream sees it. One object, mutated in
 * place for the life of the run, exactly as `energy.ts` owns its tank and
 * `wind.ts` its weather. Holding a copy would leave a reader looking at a sea
 * that had stopped moving.
 */
export interface HazardState {
  /** Live hazards, at most one of each kind. */
  readonly live: readonly Hazard[];
  /**
   * Eased push along the ship's forward axis, world units/s — the same frame
   * and the same units as `WindState.along`, and spent the same way.
   */
  readonly along: number;
  /** Push along the ship's starboard axis, world units/s. */
  readonly across: number;
  /** `free` until a maelstrom takes the ship; then `spiral`, then `sunk`. */
  readonly phase: 'free' | 'spiral' | 'sunk';
  /** Non-null exactly while `phase !== 'free'`. See HazardDrive. */
  readonly drive: HazardDrive | null;
}

/** Read-only view of the ship, produced by ship.ts, consumed by camera.ts and hud.ts. */
export interface ShipState {
  /** Unit vector from globe center to the ship. World position = position * GLOBE_RADIUS. */
  readonly position: Vector3;
  /** Local up = position (unit). */
  readonly up: Vector3;
  /**
   * Unit forward direction, tangent to the sphere. Where the bow points.
   *
   * This is the ship's orientation, not a value computed from one. The helm
   * turns it about `up` and each step of travel carries it by parallel
   * transport, so a ship with its helm amidships runs a great circle and never
   * needs a compass frame to know where it is pointing. Prefer it to `heading`
   * for anything geometric; `wake.ts`, `camera.ts` and `radar.ts` all do.
   */
  readonly forward: Vector3;
  /**
   * Heading in radians, 0 = north, clockwise positive (east = PI/2).
   *
   * A READING taken off `forward` each frame, for the compass, the HUD and the
   * scope. It is meaningless at the poles, where the tangent frame is
   * arbitrary and this number spins -- which is what a real compass does
   * there, and is now only cosmetic. It was once the stored truth, and the
   * hull spun with it.
   */
  readonly heading: number;
  /** Heading in degrees, normalized to [0, 360). */
  readonly headingDeg: number;
  /**
   * Signed ENGINE speed in world units per second. Negative = reversing.
   *
   * What the propulsion is making, along `forward` and nothing else. The wind
   * never touches it, which is why the burn in `energy.ts`, the turn rate, the
   * bob, the sway, the bank and the MAX_FORWARD clamp all still read it. For
   * how fast the hull is actually crossing the water, see `groundSpeed`.
   */
  readonly speed: number;
  /**
   * Signed magnitude of `velocity`, world units per second: engine plus wind,
   * which is what a player watching the sea go past actually sees.
   *
   * Signed by the forward component, so reversing reads negative -- but a ship
   * making leeway with no way on reads positive rather than zero, because it
   * is unmistakably moving.
   */
  readonly groundSpeed: number;
  /**
   * Ground velocity, a tangent vector in world units per second. The direction
   * the hull is really travelling, which under a beam wind is not `forward`.
   */
  readonly velocity: Vector3;
  readonly latDeg: number;
  readonly lonDeg: number;
}

/* ------------------------------------------------------------------ */
/* Fishing — species                                                   */
/* ------------------------------------------------------------------ */

/**
 * Rarity band, 1 (common) to 5 (legendary).
 *
 * A union rather than an enum: `erasableSyntaxOnly` forbids enums, and the
 * literal type is what lets `ROW_ODDS` be indexed exhaustively.
 */
export type Tier = 1 | 2 | 3 | 4 | 5;

/**
 * How a species is drawn. The one seam between the ruleset and the art.
 *
 * `fishrender.ts` is the only module that reads this, so replacing emoji with
 * generated PNGs later is a change to `species.ts` and nothing else. `image`
 * is optional precisely so that swap can happen one species at a time.
 */
export interface SpeciesArt {
  readonly emoji: string;
  /** CSS colour for the glow behind the sprite; carries the tier read. */
  readonly tint: string;
  /** Future: a path under /public, drawn instead of the emoji when present. */
  readonly image?: string;
}

/** One catchable species. Immutable data, defined once in `species.ts`. */
export interface Species {
  /** kebab-case and STABLE: it is the key the Fish Book is saved under. */
  readonly id: string;
  readonly name: string;
  readonly tier: Tier;
  /** Multiplier on the base fish length. */
  readonly size: number;
  /** Multiplier on the row's base speed. */
  readonly speed: number;
  /** Gold paid per catch. */
  readonly gold: number;
  readonly art: SpeciesArt;
}

/* ------------------------------------------------------------------ */
/* Fishing — simulation                                                */
/* ------------------------------------------------------------------ */

/**
 * What the harpoon is doing.
 *
 * `reeling` covers both the quiet haul of a small fish and the struggle of a
 * big one; `HarpoonState.struggling` is what separates them, because the
 * difference is whether the player has to do anything and not what the rope
 * is doing.
 */
export type HarpoonPhase = 'swinging' | 'flying' | 'reeling' | 'retracting';

/**
 * One fish in the water, in CARD UNITS (see `docs/FISHING_PLAN.md`).
 *
 * x runs [0, 1] across the card and y runs [0, 1.778] down from its top. The
 * simulation knows nothing about pixels; the renderer scales.
 */
export interface FishState {
  readonly species: Species;
  /** 0..4, shallowest first. */
  readonly row: number;
  readonly x: number;
  readonly y: number;
  /** +1 travelling right, -1 travelling left. */
  readonly dir: 1 | -1;
  readonly hooked: boolean;
}

export interface HarpoonState {
  readonly phase: HarpoonPhase;
  /** Radians from straight down; positive swings toward +x. */
  readonly angle: number;
  readonly tipX: number;
  readonly tipY: number;
  readonly hooked: FishState | null;
  readonly struggling: boolean;
  /** [0, 1]. Meaningful only while `struggling`; the line snaps at 0. */
  readonly tension: number;
}

/**
 * Something that happened during one `update`.
 *
 * The sim raises these rather than calling back, so the ruleset stays free of
 * the DOM: `fishing.ts` banks the gold and writes the save, `fishrender.ts`
 * floats the "+N" — from the same list, without either knowing about the other.
 */
export type FishingEvent =
  | { kind: 'fired'; shotsLeft: number; extraLeft: number }
  | { kind: 'hooked'; fish: FishState }
  | { kind: 'caught'; species: Species; gold: number; x: number; y: number }
  | { kind: 'escaped'; species: Species }
  | { kind: 'missed' }
  | { kind: 'ended'; reason: 'time' | 'shots' | 'abort' };

/** Read-only view of one fishing session, produced by `fishsim.ts`. */
export interface FishingState {
  /** Seconds, counting 30 down to 0. */
  readonly timeLeft: number;
  /** Harpoons left off the session's own ten, counting down to 0. */
  readonly shotsLeft: number;
  /**
   * Spares left of the ones this session was granted out of the locker,
   * counting down to 0. Zero for a player who has bought none.
   *
   * A strictly second budget: `shotsLeft` is spent first and to the last one,
   * and only then does a shot come out of here. That order is the whole rule
   * the locker is sold under — see `harpoons.ts`.
   */
  readonly extraLeft: number;
  readonly fish: readonly FishState[];
  readonly harpoon: HarpoonState;
  /** This session's catches, in the order they were landed. */
  readonly caught: readonly Species[];
  /** This session's gold. The wallet holds the running total. */
  readonly goldEarned: number;
  readonly over: boolean;
  /**
   * Raised since the last `update`, which clears the list at its top. Read it
   * in the same frame or lose it.
   */
  readonly events: readonly FishingEvent[];
}

export interface FishingInput {
  /**
   * True on the frame the player pressed — click, tap or Space. Fires the
   * harpoon while swinging, and is one tap of the struggle while reeling.
   * Key repeat must not set it; see `docs/FISHING_PLAN.md`.
   */
  readonly press: boolean;
}

/* ------------------------------------------------------------------ */
/* Fishing — persistence                                               */
/* ------------------------------------------------------------------ */

/**
 * Everything that survives a reload. One versioned object under one key.
 *
 * `fishBook` is keyed by `Species.id` and holds times caught; a species absent
 * from it has never been caught. Unknown ids are KEPT on load rather than
 * pruned, so renaming a species does not silently erase a player's history.
 */
export interface SaveData {
  readonly version: 1;
  readonly gold: number;
  readonly fishBook: Readonly<Record<string, number>>;
  /**
   * Charge in the backup cell as WHOLE PERCENT of a main tank, 0-50.
   *
   * Percent rather than the fraction the sim uses, so the file stays whole
   * numbers throughout and a cell bleeding away under a burn rewrites the save
   * about once a second instead of sixty times. `battery.ts` owns the
   * conversion and the rounding, which is downward — a reload never hands back
   * more charge than was aboard.
   */
  readonly reserve: number;
  /** Spare harpoons in the locker, 0-100. */
  readonly harpoons: number;
}

/* ------------------------------------------------------------------ */
/* AI boats and the cannon battle                                      */
/* ------------------------------------------------------------------ */

/**
 * Which of the two raiders this is. Red hunts the player; orange runs a fixed
 * straight track and is only dangerous if the two happen to meet.
 *
 * The kind is MUTABLE over a boat's life: a red boat whose pursuit clock runs
 * out becomes an orange one rather than vanishing, which is the whole reason
 * this is one type and not two. See docs/BATTLE_PLAN.md.
 */
export type AiBoatKind = 'red' | 'orange';

/** `pursue` is red-only. Every orange boat, converted or spawned, is `wander`. */
export type AiBoatPhase = 'pursue' | 'wander';

/**
 * One AI boat on the sea, owned by `aiboats.ts` and mutated in place for as
 * long as it lives. Hold the object, never a copy of its vectors.
 */
export interface AiBoat {
  readonly kind: AiBoatKind;
  readonly phase: AiBoatPhase;
  /** Unit direction of the hull's centre. */
  readonly position: Vector3;
  /** Unit tangent: the direction it is travelling, which is also where its bow points. */
  readonly forward: Vector3;
  /** World units per second — the same unit `hud.ts` prints as a knot. */
  readonly speed: number;
  /** Seconds left in the current phase: the pursuit clock, or the straight run. */
  readonly clock: number;
  /**
   * Fade in and out, 0..1. Drives the neon and the rim glow, so a boat arrives
   * and leaves as a light coming up and going down rather than as a hull
   * appearing out of nothing.
   */
  readonly envelope: number;
}

/**
 * The raiders as everything downstream sees them. One object, mutated in place
 * for the life of the run, exactly as `HazardState` and `WindState` are.
 */
export interface AiBoatState {
  /** Live boats, at most one of each kind. */
  readonly live: readonly AiBoat[];
  /** Seconds of spawn-and-contact suppression left after a fight. */
  readonly grace: number;
}

/**
 * One side of a battle, in the arena's flat world units.
 *
 * The arena is NOT on the globe: `x` and `z` are plain metres about its own
 * centre, `angle` is the position on the circle both boats travel, and
 * `heading` is tangent to it. See docs/BATTLE_PLAN.md.
 */
export interface Combatant {
  /** Radians about the arena centre, counter-clockwise positive. */
  readonly angle: number;
  readonly x: number;
  readonly z: number;
  /** Radians, direction of travel, on the same convention as ShipState.heading. */
  readonly heading: number;
  /** Rounds left in the locker, ROUNDS down to 0. */
  readonly rounds: number;
  /** Hits taken, 0 up to HITS_TO_LOSE. */
  readonly hits: number;
  /** Seconds until this side may fire again. */
  readonly cooldown: number;
}

/** One cannonball in flight. Straight line, no drop, no drag. */
export interface Cannonball {
  readonly owner: 'player' | 'ai';
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
  readonly age: number;
}

/** Something that happened this tick, for the scene and the UI to react to. */
export interface BattleEvent {
  readonly kind: 'fire' | 'hit' | 'splash';
  readonly owner: 'player' | 'ai';
  /** Where it happened, arena units. For a hit, the hull that took it. */
  readonly x: number;
  readonly z: number;
}

/** Who won. Set once, and the fight is over the moment it is not null. */
export type BattleOutcome = 'win' | 'loss' | 'draw';

/** The fight, mutated in place by `battle.ts` for the length of one battle. */
export interface BattleState {
  /** Radius of the circle both boats travel, arena units. Shrinks as they close. */
  readonly radius: number;
  readonly player: Combatant;
  readonly ai: Combatant;
  readonly balls: readonly Cannonball[];
  /** Seconds since the fight began. */
  readonly elapsed: number;
  readonly outcome: BattleOutcome | null;
  /** THIS TICK's events only. Rebuilt every update; never accumulate it. */
  readonly events: readonly BattleEvent[];
}

/** What the player is asking for this tick. Written by `battleui.ts`. */
export interface BattleInput {
  /** Edge-triggered: true for exactly the one tick a press lands on. */
  readonly fire: boolean;
  /** W or the on-screen up key: go faster round the circle. */
  readonly faster: boolean;
  /** S or the on-screen down key: drop back. */
  readonly slower: boolean;
}
