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
  /**
   * The berth. Never null once Stream A has landed — a candidate that cannot
   * find water is not founded — but kept nullable through Step 0 so
   * `radar.ts`'s existing `if (town.dock)` keeps compiling.
   */
  readonly dock: Dock | null;
  /**
   * Display name, from `HARBOUR_NAMES`. Unique across `Towns.all`.
   *
   * This is the harbour's IDENTITY: the world is redrawn on every load, so
   * the ground under a harbour is not durable and the save keys on this
   * string. See `harbournames.ts`.
   */
  readonly name: string;
  /**
   * Position in `HARBOUR_NAMES`. 0 is the North Pole and 1 the South Pole.
   *
   * How names are DEALT OUT, never what a harbour is: nothing persists an
   * index, because index 7 is a different island in every world.
   */
  readonly index: number;
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
  /**
   * The town called `name`, or null.
   *
   * The lookup the save file needs: `knownHarbours` holds names, and the
   * scope and the menu have to turn one back into a position in whatever
   * world is currently up.
   */
  byName(name: string): Town | null;
}

/* ------------------------------------------------------------------ */
/* Ship energy                                                         */
/* ------------------------------------------------------------------ */

/**
 * What the power plant is doing, for the HUD to label and colour.
 *
 * Eleven names for what used to be five, because each of the five was covering
 * situations a player has to tell apart. `drain` was both a hull under full
 * throttle at 1.1 %/s and a hull at rest after dark paying only the hotel
 * load at 0.04 %/s. `empty` was both a ship adrift in the dark and a ship
 * whose panels are already climbing back through the first percent — and that
 * one was not merely coarse, it was a lie: the tag read EMPTY beside a
 * positive rate, which is a plant that has failed rather than one restarting.
 *
 * These name the CAUSE and nothing else. How alarming any of them is belongs
 * to `hud.ts`, which derives its colour from `level`, `rate` and `canThrust`
 * instead. One enum trying to carry both jobs is what forced `low` to exist as
 * a HUD-only sixth state and left `reserve` — the one reading that cannot be
 * undone — sharing the neutral colour of a healthy ship under way.
 *
 * The order they are decided in is a precedence ladder, not a list, and two
 * rungs of it are load-bearing:
 *
 *   - `dead` and `restart` outrank everything, a berth included: while the
 *     first percent trickles back the plant is still refusing thrust, and
 *     that is the one thing the player needs to know.
 *   - `docked` is the project's single definition of "at a berth" — the shop
 *     gate, the wind's shelter, the hazard suppression and the dock glow all
 *     test it — so no state may shadow it while the ship is connected. A full
 *     tank at a berth is still `docked`; saying TANK FULL is the HUD's job.
 */
export type EnergyMode =
  /** Both tanks dry, nothing coming in. No thrust: the ship drifts. */
  | 'dead'
  /** Both tanks dry but climbing again. Still no thrust — see RESTART_LEVEL. */
  | 'restart'
  /**
   * Made fast to a berth: shore power connected, and the helm locked.
   *
   * The one definition of "at a berth", and since 2026-09-09 it is a state the
   * player ENTERS rather than one that happens to them. The ring's dwell makes
   * the ship eligible -- see `EnergyState.berthReady` -- and Space makes it
   * fast. Nothing here connects on its own any more, because a berth now takes
   * the helm away and no instrument may do that without being asked.
   */
  | 'docked'
  /**
   * Inside a berth's ring and not made fast.
   *
   * Covers both halves of an approach: the two seconds of dwell, and the wait
   * for the helm to press Space afterwards. `EnergyState.berthReady` is what
   * separates them, and the HUD tag reads them differently.
   */
  | 'mooring'
  /** Main tank on the floor; this frame's shortfall came out of the cell. */
  | 'reserve'
  /** An Overdrive Coil burning its flat multiple of the full-speed draw. */
  | 'overdrive'
  /** Under way on the engine, paying the speed-squared propulsion draw. */
  | 'burn'
  /** At rest with the sun on the panels. */
  | 'solar'
  /**
   * At rest with the sun up and the weather taking most of what it is worth.
   *
   * The eleventh rung, added with the weather. A storm leaves 5% of a clear
   * noon and a fog bank half, and without this the panel would read SOLAR
   * CHARGING beside a rate near zero -- the same class of lie `restart` and
   * `moon` were added to remove. It is a threshold on the share the weather
   * LEAVES rather than on the rate itself, because a low sun in clear air is
   * a small rate too and that one is honestly solar.
   */
  | 'overcast'
  /** At rest after dark, charging off a Moonglass Array. */
  | 'moon'
  /** At rest with nothing coming in: the hotel load, and only that. */
  | 'hotel';

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
  /** The berth currently charging the ship, or null. Null until made fast. */
  readonly dock: Dock | null;
  /**
   * Inside a berth's ring with the dwell clock run out: the ship MAY be made
   * fast, and is not.
   *
   * The half-state the Space lock created. It stays true while the ship is
   * moored as well -- it is a fact about where the hull is, not about what the
   * helm has done with it -- so read it with `mode === 'docked'` to tell the
   * two apart. The HUD's mooring toast is driven off exactly that pair.
   */
  readonly berthReady: boolean;
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
  /**
   * Which half of the cycle the wind is in. A LULL is never a calm — the
   * speed is floored at `LULL_SPEED` — it is simply the quiet phase between
   * two events.
   */
  readonly phase: 'lull' | 'event';
  /** Seconds into the current phase. */
  readonly phaseTime: number;
  /** How long the current phase lasts, seconds. */
  readonly phaseDuration: number;
  /**
   * Steps by one at every phase change, starting at 0.
   *
   * `weather.ts` rolls on the STEP rather than on the phase name, so a
   * consumer that misses a frame still rolls exactly once per phase and one
   * that runs twice in a phase rolls not at all. It is a counter and not a
   * flag for that reason.
   */
  readonly phaseIndex: number;
  /**
   * The event's own rise-and-fall ramp, 0..1, and exactly 0 through every
   * lull.
   *
   * This is the shape `wind.ts` already multiplies its cap by. The weather
   * rides it rather than deriving a second envelope from `speed`, so a squall
   * and the gale that carries it peak together and stop together whatever the
   * coast has done to the cap in between.
   */
  readonly envelope: number;
}

/* ------------------------------------------------------------------ */
/* Weather — cells, squalls, and the one state everything downstream reads */
/* ------------------------------------------------------------------ */

/**
 * What a weather cell carries. Two kinds and no more: a storm is dark, wet
 * and windy, a fog bank is none of those and simply takes the horizon away.
 */
export type CellKind = 'storm' | 'fog';

/**
 * One region of weather drifting over the globe, owned by `weathercells.ts`
 * and mutated in place for as long as it lives.
 *
 * Deliberately the same skeleton as a `Hazard`: a unit centre and a unit
 * travel tangent, both carried by parallel transport rather than held as a
 * compass bearing, for the reason `WindState.direction` records — an angle in
 * a tangent frame spins where the meridians converge and the thing holding it
 * wanders. A cell is bigger and slower than a hazard and shades rather than
 * displaces, but it is moved by exactly the same arithmetic.
 */
export interface WeatherCell {
  readonly kind: CellKind;
  /** Unit direction of the centre. Mutated in place as the cell drifts. */
  readonly centre: Vector3;
  /** Unit tangent at `centre`: the way it is drifting. */
  readonly north: Vector3;
  /** Radius at full strength, world units. Fixed for the cell's life. */
  readonly radius: number;
  /** Lifecycle envelope, 0..1: grows in, holds, fades out. */
  readonly strength: number;
  /** Storm cells only. A fog cell is never lit from inside. */
  readonly lightning: boolean;
  /** Seconds since it formed. */
  readonly age: number;
  /** How long it lives in total, seconds. */
  readonly life: number;
}

/**
 * The cell population, as everything downstream sees it. One object, mutated
 * in place for the life of the run, exactly as `HazardState` and `WindState`
 * are.
 *
 * The three `AtShip` numbers are sampled ANALYTICALLY from `live`, never read
 * back off `weathermap.ts`'s texture. The map is 2.45 world units per texel
 * and a frame stale; these are exact and this frame's. Every rule that
 * decides a number — the envelopes, the visibility, the wind's floor, the
 * chart's stamp — reads these. Only the sky reads the map.
 */
export interface CellsState {
  readonly live: readonly WeatherCell[];
  /** Strongest storm contribution at the ship, 0..1. */
  readonly stormAtShip: number;
  /** Strongest fog contribution at the ship, 0..1. */
  readonly fogAtShip: number;
  /** True when the strongest storm at the ship is one that carries lightning. */
  readonly lightningAtShip: boolean;
  /**
   * The cell that produced `stormAtShip`, or null when no storm reaches the
   * ship at all.
   *
   * The same winner the three numbers above are read off, published rather
   * than re-derived: `weather.ts` needs the striking cell's CENTRE to place a
   * bolt, and a second pass over `live` to find it could disagree with this
   * one about which cell won a tie.
   */
  readonly stormCellAtShip: WeatherCell | null;
}

/** The label the HUD prints. Derived; nothing else may branch on it. */
export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'storm' | 'fog';

/**
 * The weather at the ship, produced by `weather.ts` and read by everything
 * else — the sky, the lights, the haze, the rain, the plant, the spawn rolls,
 * the scope.
 *
 * It is the ONE place the two sources meet. A squall (rolled off the wind's
 * phases) and a cell (drifting over the globe) are combined here by `max`
 * before any smoothing, so nothing downstream can tell them apart or has to.
 *
 * Every envelope is 0..1 and **zero means the game as it shipped**: at
 * all-zero the sky, the sea, the lights and the scope are bit-for-bit what
 * they were before any of this existed. That is a hard contract, not an
 * aspiration — see docs/WEATHER_PLAN.md, Trap 2.
 */
export interface WeatherState {
  readonly kind: WeatherKind;
  /** Cloud build-up, 0..1. Every event greys the sky a little; a storm blackens it. */
  readonly cover: number;
  /** Rain density, 0..1. */
  readonly rain: number;
  /** Storm darkness, 0..1. Dims the key light, the sky and the solar panels. */
  readonly storm: number;
  /** Sea fog, 0..1. */
  readonly fog: number;
  /**
   * Lightning, 0..1. Non-zero for a few hundred milliseconds at a time, in
   * bursts of two or three pulses. Additive wherever it is used, so it reads
   * at night.
   */
  readonly flash: number;
  /**
   * True when the live flash belongs to a SQUALL rather than to a cell.
   *
   * A squall has no place -- it is wherever the ship is -- so its lightning
   * lights the whole cloud deck. A cell's lightning lights only its own
   * cloud, which `weathermap.ts` marks in the map's blue channel. Without
   * this distinction one of the two is always wrong: either a strike inside a
   * storm on the horizon flashes the clear sky overhead, or a squall's strike
   * lights nothing at all because no cell claimed it.
   */
  readonly flashLocal: boolean;
  /**
   * Where the live flash is, as a unit direction, or null when it is at the
   * ship.
   *
   * Recorded once at the moment of the strike, exactly as `flashLocal` is and
   * for the same reason: a cell that drifts or retires part-way through a
   * flash's own decay must not drag the bolt across the sky with it. Null
   * whenever `flashLocal` is true -- a squall has no place, so the bolt is
   * hung on the ship.
   *
   * `lightning.ts` is the only reader. The sky and the cloud deck light the
   * whole hemisphere from `flash` and do not need to know where it came from.
   */
  readonly flashOrigin: Vector3 | null;
  /**
   * The seed the live flash's bolt geometry is built from.
   *
   * Drawn from `weather.ts`'s own stream at the moment of the strike, so a
   * replay that agrees about the weather agrees about the shape of the bolt,
   * and `?weather=lightning` photographs the same bolt every time. 0 when no
   * strike is live.
   */
  readonly flashSeed: number;
  /**
   * How far the ship can see, world units, in [VIS_MIN, RADAR_RANGE].
   *
   * The one number the weather and the chart meet at: the scope masks itself
   * beyond it, and the chart is stamped with exactly the disc the scope could
   * see. Clear weather is `RADAR_RANGE` exactly.
   */
  readonly visibility: number;
}

/* ------------------------------------------------------------------ */
/* Hazards — strong waves and maelstroms                               */
/* ------------------------------------------------------------------ */

/**
 * What kind of rough water this is.
 *
 * Two kinds now, not three. `wave` and `greatwave` used to be the same
 * geometry drawn at two fixed strengths, and every property that separated
 * them -- height, push, dissipation -- is now rolled per wave off a
 * continuous range, so a second kind carrying nothing but a second pair of
 * constants had stopped being a distinction. What was the great wave is the
 * top of the `wave` range: see CREST_HEIGHT_MAX and CREST_SPEED_MAX.
 *
 * The live budget is per kind and no longer one each: `hazards.ts` runs up to
 * MAX_WAVES crests and at most one maelstrom.
 */
export type HazardKind = 'wave' | 'maelstrom';

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
  /**
   * Half-length (crest) or radius (maelstrom) at full size, world units.
   *
   * LIVE on a crest in two ways now: it grows with the wave's age (see
   * `Hazard.speed`'s neighbours in `hazards.ts` -- LENGTH_GROWTH) and land
   * eats it back down again. Never cache it across a frame.
   */
  readonly extent: number;
  /** Half-width of a crest, world units. 0 for a maelstrom. */
  readonly halfWidth: number;
  /**
   * How far the crest's ends trail behind its centre, as a fraction of
   * `extent`. 0 is a straight wall of water; 0.35 is a pronounced arc with
   * the middle of the front arriving first. 0 for a maelstrom.
   *
   * Read by `hazardfield.ts` (both ports), by the art in `waterhazard.ts`,
   * by the contact test and by the scope, all through the same one
   * displacement of the along-travel coordinate -- see `hazBowV`.
   */
  readonly bow: number;
  /**
   * How far each END of this crest has been broken by the coast, 0..1, for
   * the -east end and the +east end in that order. 0 on open water and on
   * every maelstrom.
   *
   * A crest that runs onto a headland loses the stretch that met it, and the
   * loss used to be the whole story: the surviving span was re-measured and
   * the profile re-fitted to it, at full height right up to its new end. So a
   * wave broken by a rock still stood a clean two metres tall against the
   * rock. These two numbers are what let the broken end SAG -- read by both
   * ports of `hazardHeight` as a taper on the ridge, and by nothing else.
   *
   * They rise while an end is actively being eaten and decay back to zero
   * when it is not, so a front that clipped an islet and sailed on reforms,
   * and a front grinding along a beach stays broken for as long as it does.
   */
  readonly breakNeg: number;
  readonly breakPos: number;
  /**
   * How fast a crest travels, world units/s -- which is knots, since the
   * hull's 10 world units/s is what the HUD reads out as 10 kn. 0 for a
   * maelstrom, which does not travel.
   *
   * Rolled per wave between CREST_SPEED_MIN and CREST_SPEED_MAX, and it is
   * the one number the wave's push strength is derived from: see PUSH_PEAK.
   */
  readonly speed: number;
  /**
   * Signed peak height, world units: positive for a crest, the funnel depth
   * for a maelstrom. NOT scaled by the wind — the weather raises the ordinary
   * sea, a hazard is its own weather.
   *
   * LIVE on a crest: rolled at spawn between CREST_HEIGHT_MIN and
   * CREST_HEIGHT_MAX_START, then grown with age and capped at
   * CREST_HEIGHT_MAX. Fixed for the life of a maelstrom.
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

/**
 * The hull's propulsion for one frame, as the chandlery's Navigation offers
 * change it. Optional everywhere it is threaded through — a caller that never
 * builds one gets exactly the ship the game shipped with.
 *
 * `trim.ts` and `overdrive.ts` are the two writers `main.ts` reads to build
 * this each frame: `maxForward` is the higher of the ship's Trim & Sheathing
 * tier and, while the Overdrive Coil is burning, `OVERDRIVE_MAX_FORWARD` —
 * never the sum of both, because the coil is a sprint on top of the hull the
 * player already has, not a stack of upgrades. `anchored` is `seaanchor.ts`'s
 * `isDeployed` and nothing else.
 */
export interface PropulsionState {
  /** Effective top speed this frame, world units/s. See the file comment above. */
  readonly maxForward: number;
  /** True for the whole kill-and-hold window of a deployed Sea Anchor. */
  readonly anchored: boolean;
  /**
   * What a tow leaves of the top speed: `TOW_SPEED_SHARE` while a derelict is
   * on the line, and 1 otherwise. Absent means 1, so every existing caller and
   * every test that builds this by hand is unchanged.
   *
   * **A separate field rather than a smaller `maxForward`, and that is a rule
   * rather than plumbing.** `maxForward` is what the player BOUGHT — Trim's
   * tier, or an Overdrive Coil's burn — and `ship.ts` takes the min of it and
   * the worn hull's `speedCap`, which is docs/HARBOURS_PLAN.md's decision 14: a
   * worn hull switches the Navigation shelf off. A tow is not a purchase, it is
   * a LOAD, so it multiplies the result of that min instead of joining it.
   * Folded into `maxForward` it would vanish in exactly the state it should
   * hurt most: a hull worn below 25% is capped at 5 kn, and `min(0.75 * 10, 5)`
   * is 5 — a free tow for the most broken ship in the game.
   */
  readonly towFactor?: number;
}

/* ------------------------------------------------------------------ */
/* Hull durability                                                     */
/* ------------------------------------------------------------------ */

/**
 * What the hull is doing, for the HUD to label.
 *
 * A CAUSE, not a severity: the severity is the percent, and `hud.ts` colours
 * on that. The same split the power panel makes between its `pwr--*` modifier
 * and its ten tags, and for the same reason — a worn hull being repaired and
 * a worn hull wearing further are the same colour and different situations.
 */
export type HullMode = 'full' | 'wearing' | 'weathering' | 'repairing';

/**
 * The hull as everything downstream sees it, produced by `hull.ts`.
 *
 * Every field but `percent` is DERIVED from it on read and never stored, so
 * there is exactly one number in the sim and no way for the cap, the fishing
 * gate and the battle threshold to disagree about it.
 */
export interface HullState {
  /**
   * Durability in WHOLE percent, [1, 100].
   *
   * Whole, on the same terms as `SaveData.reserve`: the sim keeps a float and
   * rounds here, so a hull wearing at 0.25 %/min writes the save every four
   * minutes rather than every frame.
   */
  readonly percent: number;
  /**
   * Top speed the hull allows, world units per second — the same unit
   * `MAX_FORWARD` and `PropulsionState.maxForward` are in.
   *
   * `Infinity` at 50% and above, which is what lets `ship.ts` write a plain
   * `Math.min(propulsion.maxForward, speedCap)` and have a sound hull change
   * nothing at all. A finite value up there would silently cap Trim and
   * Overdrive.
   */
  readonly speedCap: number;
  /** False below 25%: the fishing screen's START and AGAIN are dead. */
  readonly canFish: boolean;
  /**
   * Broadsides this hull can take in a fight before it loses: 3, 2 or 1.
   *
   * Read once at the moment a fight starts and frozen for its length — a hull
   * does not wear inside the arena, so this cannot move mid-battle.
   */
  readonly hitsToLose: number;
  readonly mode: HullMode;
  /** Signed, percent per SECOND. `hud.ts` prints wear per minute and repair per second. */
  readonly rate: number;
}

/* ------------------------------------------------------------------ */
/* The chandlery's four durable ladders                                */
/* ------------------------------------------------------------------ */

/**
 * One of the four upgrade ladders, as a harbour's stock list names it.
 *
 * Consumables are sold everywhere and are not in this union; only the four
 * durables vary from harbour to harbour. See `harbourstock.ts`.
 */
export type UpgradeLine = 'trim' | 'moonglass' | 'arclamp' | 'governor';

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
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

/**
 * What a harbour can ask for. See `docs/QUESTS_PLAN.md`.
 *
 * Four kinds, and only the first two are generated in Phase 1. `EXPEDITION`
 * and `SURVEY` are in the union from the start so the save loader accepts a
 * file written by a later build and the HUD formatter has a branch for them
 * rather than a default that prints something wrong. `quests.ts` simply never
 * draws either until Phase 2 turns it on.
 *
 * - `DELIVERY` — moor at a named harbour, inside a deadline, optionally while
 *   it is daylight or night THERE.
 * - `CHART`    — reveal a fraction of this world. No deadline, no target.
 * - `EXPEDITION` (Phase 2) — reach a pole harbour and return to the issuer.
 * - `SURVEY` (Phase 2) — moor at a harbour never moored at before.
 */
export type QuestKind = 'DELIVERY' | 'CHART' | 'EXPEDITION' | 'SURVEY';

/**
 * When a `DELIVERY` may complete, measured AT THE TARGET and never at the
 * ship.
 *
 * This is the whole of "driven by day/night": the ship is about ten times
 * faster than the terminator (`daynight.ts`), so a window at a harbour half a
 * world away is a navigation problem rather than a wait. `ANY` is the default
 * and the commonest draw.
 */
export type QuestWindow = 'ANY' | 'DAYLIGHT' | 'NIGHT';

/**
 * Difficulty, 1 to 3. For a `DELIVERY` it is the great-circle arc band from
 * the issuer; for a `CHART` goal it is which coverage target. It indexes the
 * purse, the deadline and the reputation tables in `questconstants.ts`, so it
 * is the one number that has to be right.
 */
export type QuestTier = 1 | 2 | 3;

/** One posting on a harbour's board. Immutable; `accept` copies it. */
export interface QuestOffer {
  /**
   * Stable for as long as the posting is. Built from the kind, the issuer, the
   * world day and the slot, so reopening the board inside one world day shows
   * the same three and `accept` can refuse a duplicate by identity — see
   * `quests.ts` on why the board is derived rather than saved.
   */
  readonly id: string;
  readonly kind: QuestKind;
  readonly tier: QuestTier;
  /** Harbour name that issued it. */
  readonly issuer: string;
  /** Harbour name to reach, or null for a goal with no destination. */
  readonly target: string | null;
  readonly window: QuestWindow;
  /**
   * World seconds allowed from acceptance, or null for a goal with no
   * deadline. World seconds, never wall-clock: the clock stops when the world
   * stops, which is what keeps a contract from expiring under the fishing
   * card.
   */
  readonly duration: number | null;
  /** `CHART`: the coverage fraction to reach, in [0, 1]. Null otherwise. */
  readonly coverage: number | null;
  readonly gold: number;
  /** Reputation earned on completion. Failure costs `REPUTATION_FAIL`, flat. */
  readonly reputation: number;
  /** One line for the card and the menu page, formatted by `quests.ts`. */
  readonly brief: string;
}

/** An accepted contract. The only mutable field is the clock. */
export interface ActiveQuest extends QuestOffer {
  /** World seconds left, or null for a goal with no deadline. Persisted. */
  remaining: number | null;
}

/**
 * What `quests.ts` announces. The notification strip and the save file are
 * its two subscribers, and neither may change anything in response.
 *
 * `quest` is the contract as it was at the moment of the event, which for
 * `completed` and `failed` is a contract that is no longer active.
 */
export type QuestEvent =
  | { readonly kind: 'accepted'; readonly quest: ActiveQuest }
  | {
      readonly kind: 'completed';
      readonly quest: ActiveQuest;
      readonly gold: number;
      readonly reputation: number;
    }
  | {
      readonly kind: 'failed';
      readonly quest: ActiveQuest;
      readonly reputation: number;
      /**
       * Why it ended. `expired` is a deadline that ran out; `abandoned` is the
       * player dropping it from the board.
       *
       * The two cost exactly the same — `REPUTATION_FAIL`, flat — so this is
       * not a rule, it is a WORD: the strip has to be able to say ABANDONED
       * rather than FAILED, because a player who just pressed the button knows
       * perfectly well what happened and being told they failed would read as
       * the game mislabelling their own choice.
       */
      readonly reason: 'expired' | 'abandoned';
    }
  /** A `CHART` goal crossing a whole `CHART_PROGRESS_STEP` of its target. */
  | { readonly kind: 'progress'; readonly quest: ActiveQuest; readonly fraction: number };

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
  /** Sea Anchors stowed, 0-`SEA_ANCHOR_STORE_MAX`. Absent means 0. */
  readonly seaAnchors: number;
  /** Overdrive Coils stowed, 0-`OVERDRIVE_STORE_MAX`. Absent means 0. */
  readonly overdriveCoils: number;
  /** Chum Drums stowed, 0-`CHUM_DRUM_STORE_MAX`. Absent means 0. */
  readonly chumDrums: number;
  /** Barbed Heads bundles stowed, 0-`BARBED_HEADS_STORE_MAX`. Absent means 0. */
  readonly barbedHeads: number;
  /** Trim & Sheathing tier bought, 0-`TRIM_TIER_MAX`. Absent means Mk 0. */
  readonly trimTier: number;
  /** Moonglass Array tier bought, 0-`MOONGLASS_TIER_MAX`. Absent means Mk 0. */
  readonly moonglassTier: number;
  /** Arc-Lamp Rig tier bought, 0-`ARC_LAMP_TIER_MAX`. Absent means Mk 0. */
  readonly arcLampTier: number;
  /** Efficiency Governor tier bought, 0-`GOVERNOR_TIER_MAX`. Absent means Mk 0. */
  readonly governorTier: number;
  /**
   * Hull durability in whole percent, [1, 100]. Absent or unreadable means
   * 100 — a save written before the hull existed is a ship that has never
   * worn, which is the truth about it.
   */
  readonly hull: number;
  /**
   * Harbour names the ship has moored at, in first-visit order.
   *
   * The one thing that survives a world being redrawn. Unknown names are
   * KEPT rather than dropped, on exactly the terms `fishBook` keeps unknown
   * species ids: a save from a later build with a longer name table must
   * survive a round trip through this one.
   */
  readonly knownHarbours: readonly string[];
  /**
   * Name → the upgrade ladders that harbour sells.
   *
   * Rolled once for all 36 and written here, so a remembered harbour keeps
   * the stock it had. Absent means the whole table is re-rolled at boot —
   * see `harbourstock.ts`.
   */
  readonly harbourStock: Readonly<Record<string, readonly UpgradeLine[]>>;
  /**
   * Standing with the harbours. An integer, floored at `REPUTATION_FLOOR` and
   * with no ceiling. Absent means 0, which is where a new captain starts.
   *
   * It buys nothing yet. `docs/QUESTS_PLAN.md` Phase 2 owns what it will buy;
   * Phase 1 only earns it, spends it and keeps it.
   */
  readonly reputation: number;
  /**
   * The seed the contract boards are drawn from. A uint32, drawn once on the
   * first run and never changed.
   *
   * It is saved rather than re-drawn because a board is derived from
   * `(questSeed, harbour name, world day)` instead of being written to disk:
   * re-drawing the seed on every load would reshuffle every harbour's board
   * on every reload, and "this harbour had a pole run yesterday" would mean
   * nothing. Absent means a fresh draw, which is right for a save written
   * before contracts existed.
   */
  readonly questSeed: number;
  /**
   * Contracts in hand, with their clocks.
   *
   * Entries survive a world being redrawn, by harbour NAME, exactly as
   * `knownHarbours` does: the target is re-resolved through `Towns.byName` in
   * whatever world comes up, so the bearing and the distance change and the
   * deadline does not. A `CHART` goal is the one kind dropped on load, because
   * the sea it measured is gone — see `docs/QUESTS_PLAN.md`, interpretation 4.
   */
  readonly quests: readonly ActiveQuest[];
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

/* ------------------------------------------------------------------ */
/* The leviathan hunt                                                   */
/* ------------------------------------------------------------------ */

/**
 * Where a hunt is. See docs/LEVIATHAN_PLAN.md.
 *
 * `idle` is no shoal on the water, `drifting` is a live one, and `settling`
 * is the fade after a shoal has scattered or the last target has been banked.
 * The purse is paid on the transition INTO `settling`, never during it, so a
 * fade that is cut short by a reload cannot pay twice.
 */
export type HuntPhase = 'idle' | 'drifting' | 'settling';

/** One shadow in the water. */
export interface Shadow {
  /** Unit direction of the shadow's centre. */
  readonly position: Vector3;
  /**
   * Unit tangent: the direction it is travelling.
   *
   * Tangent at ITS OWN position, not at the shoal's centre. Every shadow
   * transports itself, so a shoal nine units wide does not accumulate the
   * two and a half degrees that sharing one tangent would cost it.
   */
  readonly forward: Vector3;
  /** Whether this is the one the dial will arm against. Exactly one at a time. */
  readonly marked: boolean;
  /** Fade in and out, 0..1. Drives the sprite's opacity and the scope's alpha. */
  readonly envelope: number;
  /**
   * Position in the body. 0 is the head. Stable for the shoal's life.
   *
   * The shoal is one chained animal rather than fourteen drifters: segment `i`
   * follows the point `BODY_SPACING` behind segment `i - 1`. See
   * docs/LEVIATHAN_PHASE2_PLAN.md item 1, which reverses the MVP's
   * interpretation 1.
   */
  readonly rank: number;
  /**
   * 0 deep, 1 breaching.
   *
   * Drives the water term's darkening strength, the sprite's scale and edge
   * sharpness, and the foam ring on the mark. One number, three renderers, so
   * a surfacing animal cannot look surfaced on one tier and sunk on another.
   */
  readonly surfacing: number;
  /**
   * Signed roll, negative to port.
   *
   * Ramps over `TURN_TELEGRAPH` BEFORE the heading moves and decays after it.
   * This is the whole visible content of item 7: a player who cannot see a
   * turn coming cannot lead the body, and leading it is the skill.
   */
  readonly bank: number;
  /** 0..1, spikes on a strike and decays. The bolt's visible urgency. */
  readonly burst: number;
  /**
   * A fixed per-shadow phase, drawn once at spawn.
   *
   * The swim wiggle's offset, so no two segments beat in step. Drawn from the
   * sim's seeded stream, never from `Math.random`, or two runs on one seed
   * would not draw the same animal.
   */
  readonly wobble: number;
}

/**
 * Which of the gate's conditions is failing, in priority order.
 *
 * `'ok'` is the armed case. The rest name the ONE thing standing between the
 * player and a live dial, and the order is the order they are reported in when
 * more than one is true at once: the reticle colours by it and the dial's hint
 * says it in words.
 *
 * The order is the teaching progression rather than the tidy one. A player
 * sails closer (`far`), then points the bow (`arc`), then backs off if they
 * have overshot into the flee radius (`close`). `dry` sits last because an
 * empty locker already gets its own toast from `main.ts`'s `onHuntEvent`, so
 * surfacing it in the bar as well is a second telling rather than a first.
 *
 * `suppressed` is docked, mid-blackout or in a maelstrom, and is the one entry
 * the player cannot act on, which is why it sorts below everything they can.
 */
export type HuntGate = 'ok' | 'far' | 'arc' | 'close' | 'dry' | 'suppressed';

/**
 * The hunt as everything downstream sees it. One object, mutated in place for
 * the life of the run, exactly as `AiBoatState` and `HazardState` are.
 */
export interface HuntState {
  readonly phase: HuntPhase;
  /** Live shadows. Empty while `idle`. */
  readonly shadows: readonly Shadow[];
  /** Targets banked so far, 0..HUNT_TARGETS. */
  readonly target: number;
  /** Damage banked so far, 0..100 * HUNT_TARGETS. */
  readonly banked: number;
  /**
   * Whether the dial is armed THIS frame.
   *
   * True only when the marked shadow is inside harpoon range AND inside the
   * bow's arc AND the locker has a spare AND nothing is suppressing the hunt.
   * It is the whole of the pursuit: see docs/LEVIATHAN_PLAN.md, decision 3.
   */
  readonly armed: boolean;
  /** Dial position in [-1, 1]. Zero, and meaningless, while `armed` is false. */
  readonly dial: number;
  /** Seconds of spawn suppression left after a hunt settles. */
  readonly grace: number;

  /* ---- Phase 2: the picture, and why the bar is dark ---------------- */

  /**
   * WHICH of the five conditions is failing.
   *
   * The single biggest onboarding fix in phase 2. `armed` says the dial is
   * dead; this says why, and the reticle and the dial's hint both read it so
   * the two can never disagree.
   */
  readonly gate: HuntGate;
  /**
   * False during the arm-up. `armed && ready` is what a press needs.
   *
   * The sweep now starts at the red edge and charges for `ARM_UP` before it
   * will take a press, which is what removes the MVP's mash exploit: tapping
   * Space on the arming frame used to be worth very nearly 100.
   */
  readonly ready: boolean;
  /** 0 with the mark dead ahead, 1 at the arc's edge. The needle's rate input. */
  readonly centring: number;
  /** The sweep rate actually in use this frame, published so the HUD can show it. */
  readonly sweepRate: number;
  /**
   * 0..4, the index into the escalation tables.
   *
   * `target` counts banked targets and reaches `HUNT_TARGETS`; this clamps one
   * below it, because the fifth bank ends the hunt and there is no sixth row
   * in `LEVEL_SPEED`, `LEVEL_HOLD` or `LEVEL_MULTIPLIER` for it to index.
   */
  readonly level: number;
  /** Consecutive presses in the green band. Drives the streak counter. */
  readonly streak: number;
  /** `LEVEL_MULTIPLIER[level]`, published so the dial can print it. */
  readonly multiplier: number;
  /** Seconds until the next heading change; negative while turning. */
  readonly turnIn: number;
  /** 0..1 progress of the mark's walk up one segment. */
  readonly handoff: number;
  /** The rank the mark is leaving. Meaningless while `handoff` is 0. */
  readonly handoffFrom: number;
  /** The rank the mark is walking to. Meaningless while `handoff` is 0. */
  readonly handoffTo: number;
  /** 0..1, the shoal-wide flee response to a hull or a strike. */
  readonly bolt: number;
  /**
   * How a hunt ended, set once on the transition into `settling`.
   *
   * Null everywhere else. A word on the existing phase rather than a fourth
   * `HuntPhase`, because a fourth phase would be a fourth branch in every
   * consumer for something that is already a word. Everything that draws an
   * ending reads this and the per-ending fade in `ENDING_FADE`.
   */
  readonly ending: HuntEnding | null;
  /** The marked segment's `rank`, so six consumers do not each scan the array. */
  readonly mark: number;
}

/** How a hunt ended. Three endings, three pictures, three fade lengths. */
export type HuntEnding = 'sounded' | 'scattered' | 'settled';

/**
 * One thing that just happened, for the views to draw and sound.
 *
 * Separate from `HuntEvent` on purpose, and the separation is load-bearing.
 * `HuntEvent` is money and the notification strip and has exactly one
 * consumer; a cue is pictures and sounds and has six. Folding them together
 * would put `wallet.add` behind a switch that six view modules also read, and
 * the first bug from that is a splash ring able to pay gold.
 *
 * A value object with no methods and no identity: a consumer that wants to
 * remember one copies what it needs out of it.
 */
export interface HuntCue {
  readonly kind: HuntCueKind;
  /** Unit direction. Present on `strike`, `spout` and `dive`. */
  readonly position?: Vector3;
  /** Present on `strike`. */
  readonly damage?: number;
  /**
   * The sim's own reading of its ramp. Present on `strike`.
   *
   * Published rather than recomputed so five consumers cannot each get the
   * thresholds wrong, which is the same reason `SOUND_BELOW` is exported
   * rather than restated in the dial.
   */
  readonly band?: HuntBand;
  /** Which way the head is about to turn. Present on `turn`. */
  readonly sign?: number;
}

export type HuntCueKind =
  | 'spawn'
  | 'armed'
  | 'disarmed'
  | 'turn'
  | 'handoff'
  | 'strike'
  | 'spout'
  | 'dive'
  | 'settled';

export type HuntBand = 'green' | 'yellow' | 'red';

/**
 * What just happened, for `main.ts` to pay and announce.
 *
 * `hit` is one harpoon landing and carries no gold: the purse settles once, at
 * the end, so a hunt cannot pay twice for the same damage.
 */
export type HuntEventKind = 'hit' | 'sounded' | 'settled' | 'dry';

export interface HuntEvent {
  readonly kind: HuntEventKind;
  /** Damage on a `hit`; the hunt's total on `sounded` and `settled`; 0 on `dry`. */
  readonly damage: number;
  /** Gold earned. Zero on a `hit` and on a `dry`. */
  readonly gold: number;
  /**
   * Why a `sounded` hunt ended. Absent on every other kind.
   *
   * `pinprick` is a press too feeble to hold the animal's interest;
   * `lost` is everything passive, which is a coast, a maelstrom, a fight, or
   * the player simply sailing away.
   *
   * Both cost exactly the same, so this is not a rule but a WORD. It exists on
   * `quests.ts`'s precedent, where a failed contract carries `expired` or
   * `abandoned` for the same reason: telling a player who steered off that the
   * leviathan tired of them would be the game mislabelling their own choice.
   */
  readonly reason?: 'pinprick' | 'lost';
  /**
   * How the hunt ended, mirroring `HuntState.ending`. Absent on `hit` and `dry`.
   *
   * `reason` says whose doing it was and is a word for the player; this says
   * which PICTURE was drawn, and is what lets `main.ts` match the fade it sees
   * on the water to the line it pushes on the strip.
   */
  readonly ending?: HuntEnding;
}

/* ------------------------------------------------------------------ */
/* Salvage and the derelict                                            */
/* ------------------------------------------------------------------ */

/**
 * One raft of salvage adrift on the open sea, owned by `salvage.ts` and
 * mutated in place for as long as it floats. Hold the object, never a copy of
 * its vectors.
 *
 * The same pile of timber the arena floats — `raftmesh.ts` draws both — but a
 * different thing in the rules: an arena raft fouls a hull and stops a ball,
 * and this one is taken by touching it and pays. See docs/SALVAGE_PLAN.md.
 */
export interface SalvageRaft {
  /** Unit direction of the raft's centre. */
  readonly position: Vector3;
  /** Its own rolled radius, world units. Drives the mesh's scale and nothing else. */
  readonly radius: number;
  /** Fixed at birth, radians: which way the pile happens to be lying. */
  readonly yaw: number;
  /** Seconds since it was rolled. */
  readonly age: number;
  /** Seconds left before it sinks unclaimed. */
  readonly life: number;
  /** Fade in and out, 0..1, so a raft arrives and leaves rather than popping. */
  readonly envelope: number;
}

/** The salvage afloat, mutated in place for the life of the run. */
export interface SalvageState {
  /** Live rafts, at most `LIVE_MAX` of them. */
  readonly live: readonly SalvageRaft[];
}

/**
 * The dead hull adrift, or what there is of one.
 *
 * At most one exists at a time, and it is `null` for most of a run. Once
 * hooked it stops drifting and is carried astern of the player — see
 * `derelict.ts`, which owns both halves of that.
 */
export interface Derelict {
  /** Unit direction of the hull's centre. */
  readonly position: Vector3;
  /**
   * Unit tangent the hull points along.
   *
   * Adrift it is the way the wind has pushed it; under tow it is the bearing
   * from the derelict to the ship, so the dead hull follows nose-first on the
   * line rather than being dragged sideways.
   */
  readonly forward: Vector3;
  /** Harbour NAME it is bound for. A name and not a place: the world is redrawn, the name is not. */
  readonly bound: string;
  /** Great-circle distance from where it was found to the harbour it is bound for, world units. */
  readonly voyage: number;
  /** True once the towline is on. */
  readonly towed: boolean;
  /** Fade in, 0..1. A derelict never fades out: it is hooked, or it is still there. */
  readonly envelope: number;
}

/** The derelict, mutated in place for the life of the run. */
export interface DerelictState {
  /** The one hull adrift or under tow, or null. */
  readonly live: Derelict | null;
  /**
   * True while the ship is inside the hook ring of an untowed derelict.
   *
   * The same shape as `EnergyState.berthReady` and for the same reason: the
   * ring's own verdict, published so that the notice strip, the `Space` ladder
   * in `main.ts` and the tests all read one opinion of it.
   */
  readonly hookReady: boolean;
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
  /** Hits taken, 0 up to this side's own `hitsToLose`. */
  readonly hits: number;
  /**
   * Hits this side can take before it loses.
   *
   * Per COMBATANT rather than the one shared `HITS_TO_LOSE` it used to be:
   * the AI is always 3, and the player is 3, 2 or 1 off the hull at the
   * moment the fight starts. `docs/SHOP_PLAN.md` lists this split as its open
   * prerequisite; `docs/HARBOURS_PLAN.md` closes it.
   */
  readonly hitsToLose: number;
  /** Seconds until this side may fire again. */
  readonly cooldown: number;
  /**
   * Displacement from the track, arena units, written by `battlesea.ts`.
   *
   * `angle` is where the hull is on the circle and this is how far the sea has
   * shoved it off that point; `x` and `z` are the sum of the two. The gun
   * still fires along the TRACK's inboard beam rather than at the arena
   * centre, so a shoved hull throws a line parallel to the diameter and a few
   * units off it. That is the whole of how a wave spoils an aim.
   */
  readonly swayX: number;
  readonly swayZ: number;
  /**
   * Seconds of fouling left, 0 when clear.
   *
   * Set by a raft of flotsam this hull ran into. While it is positive the
   * hull travels at half its angular speed and its guns do not answer.
   */
  readonly fouled: number;
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

/**
 * A wave crest rolling across the arena, or null while the sea is quiet.
 *
 * `axis` is the direction the crest TRAVELS, and it is also the direction it
 * shoves the hulls it passes: `north` is +z, `south` is -z, `east` is +x,
 * `west` is -x. `at` is the crest's coordinate along that direction of
 * travel and always runs from negative to positive, so a crest's world
 * position is `travel * at` whichever way it is going and every crest is born
 * at the same `at` and dies at the same one.
 *
 * A worked pair, since the sign is the one thing two modules could disagree
 * about. An `east` crest at `at = -6` is the line `x = -6` sweeping toward
 * +x. A `west` crest at `at = -6` is the line `x = +6` sweeping toward -x.
 * The crest itself is drawn perpendicular to its travel.
 *
 * A crest is a SEGMENT of that line and not the whole of it. `length` is how
 * much of it there is and `offset` is where its middle sits, both measured
 * along the crest's own line — the perpendicular to `axis`, taken as
 * `(travel.z, -travel.x)`, so a `north` crest is measured in +x and an `east`
 * one in -z. A hull is only shoved if its track falls inside that segment,
 * which is the whole difference between three short waves crossing an arena
 * and one wall of water that cannot be dodged.
 */
export interface ArenaCrest {
  readonly axis: 'north' | 'south' | 'east' | 'west';
  /** Coordinate along the direction of travel, arena units. Runs negative to positive. */
  readonly at: number;
  /** How much of its own line this crest occupies, arena units. */
  readonly length: number;
  /** Where the middle of that segment sits along the line, arena units, signed. */
  readonly offset: number;
  /** Units per second along `axis`. Rolled per crest, so no two run together. */
  readonly speed: number;
}

/**
 * A raft of debris drifting across the arena.
 *
 * A circle for every purpose the sim has: a hull that reaches one is fouled,
 * a ball swept through one sinks it. Several are adrift at once and no two
 * are alike — each carries its own `radius` and its own velocity, rolled when
 * it was launched.
 */
export interface ArenaFlotsam {
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
  readonly radius: number;
}

/**
 * Which of the sea's two systems are running.
 *
 * Both on in the game; both off under `?calm=1` and in the unit cases that
 * measure the gunner, which has to be pinned on a sea that is not moving the
 * answer underneath it.
 *
 * There were three. `shoals` — the rocks and wrecks that stood still inside
 * the ring — is gone: everything in the water now drifts, and what used to be
 * a fixed blind spot is a raft that has to be watched.
 */
export interface BattleOptions {
  readonly waves: boolean;
  readonly flotsam: boolean;
}

/** Something that happened this tick, for the scene and the UI to react to. */
export interface BattleEvent {
  /**
   * `fire`, `hit` and `splash` are as they always were. The three added by
   * the rework: `aim` is the AI committing to a shot, at its own hull, one
   * fuse before the gun goes; `strike` is a ball lost on a raft, at the point
   * it met it; `foul` is a hull running into a raft, and its `owner` is the
   * hull that was fouled rather than anyone who fired.
   */
  readonly kind: 'fire' | 'hit' | 'splash' | 'aim' | 'strike' | 'foul';
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
  /**
   * Seconds until the AI's committed shot goes, or null while nothing is lit.
   *
   * The telegraph, and the only clock either the scene or the strip may read
   * for it: both draw the warning from this number rather than timing an
   * `aim` event themselves.
   */
  readonly fuse: number | null;
  /** The crests rolling across the arena, up to CREST_MAX of them at once. */
  readonly crests: readonly ArenaCrest[];
  /** The rafts drifting across the arena. */
  readonly flotsam: readonly ArenaFlotsam[];
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
