/**
 * battlering.ts — where a fight's ring is allowed to happen.
 *
 * A raider can catch the player anywhere, including a cable off a headland,
 * and `battle.ts` positions both hulls on a circle it assumes is water. On a
 * separate flat arena that assumption cost nothing, because the arena was an
 * empty plane by construction. Now that the fight is staged on the globe
 * itself (docs/ROADMAP.md, "The fight, in the live world") the assumption has
 * to be earned: a duelling circle laid across a headland is two boats sailing
 * through a cliff.
 *
 * DOM-free and Three-light on purpose -- one height map, one sea level and a
 * direction -- so the rule is testable in the two-second tier rather than
 * only visible in a screenshot.
 */
import { Vector3 } from 'three';
import type { HeightMap } from './heightmap';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { ARENA_R0 } from './battleconstants';

/**
 * How much open water a fight needs around its centre, world units.
 *
 * The ring OPENS at `ARENA_R0` and both hulls travel on it, so the clearance
 * is that plus a margin for the sway that throws a hull off its track --
 * `battlesea.ts` caps one pulse at SWAY_MAX, six units -- and a little for
 * the balls that overshoot. Measured against the opening radius rather than
 * the shrinking one, so the water the boats are about to be squeezed through
 * is cleared too and not just the water they start on.
 */
export const RING_CLEARANCE = ARENA_R0 + 8;

/**
 * How far the search may slide the ring, and how finely it looks.
 *
 * **SEARCH_MAX is the whole planet**, and that is the fix rather than a
 * loosening of one. It used to be four ring-radii, 80 units, on the reasoning
 * that a player rammed off a harbour mouth should not be dragged out to sea to
 * answer for it. The reasoning was sound and the number was wrong: measured
 * over 600 water points within twelve units of a coast on the shipped seed,
 * **29% of them had no clear disc anywhere within 80 units**, and every one of
 * those fell through to the fallback and staged a duelling ring across a
 * headland. The median coastal contact has to move 56 units and the worst
 * needs 168, so any cap short of the planet is a cap that fires.
 *
 * Half the circumference reaches the antipode, so a search that runs to the
 * end has looked everywhere there is to look and `fitted: false` now means the
 * world has no fightable water at all -- a world-generation bug, not a
 * runtime case.
 *
 * **Nothing is dragged anywhere.** The ship is put back exactly where the
 * contact happened when the fight ends (`main.ts`'s `onContinue`), and both
 * cuts are behind a blackout, so the distance costs the player nothing but the
 * backdrop -- and open water is a better backdrop than a hillside. What the
 * distance does cost is a lie by omission, which is what `RING_DRIVEN_OFF` and
 * the line it puts on the cover card are for.
 *
 * SEARCH_STEP is half the clearance, so the candidate grid is fine enough
 * that a pocket of water big enough to hold a ring cannot sit between two
 * probes. The whole search is bounded by about 6 300 candidates and costs
 * 0.4 ms on the shipped world, once, behind a three-second card: `ringFits`
 * is 36 us when it passes and 10 us when it fails, and it fails fast.
 */
const SEARCH_MAX = Math.PI * GLOBE_RADIUS;
const SEARCH_STEP = RING_CLEARANCE / 2;

/**
 * The fewest bearings any circle is probed on, for both of the circles in
 * this file: the disc sampler's inner shells and the search's first shells.
 *
 * One constant for the two because it is one statement -- a circle probed on
 * fewer bearings than this is not being probed, it is being spot-checked --
 * and because they were one constant before the search was rewritten. Both
 * callers ask for more as soon as their own arc spacing does; this is only
 * the floor that stops a two-unit shell being sampled twice.
 */
const MIN_BEARINGS = 12;

/**
 * How far a ring has to slide before the player is told it slid, world units.
 *
 * Twice the opening radius, which is the distance at which the ring the fight
 * is staged on and a ring drawn at the contact point share no water at all.
 * Under it the fight is plainly on the sea the player was sailing and saying
 * so would be noise; over it they are somewhere else and a screen that did not
 * mention it would be the game palming a teleport.
 *
 * Read by `main.ts` at the ram and passed to `battlecover.ts`. It is not read
 * here: this module places rings and does not know there is a card.
 */
export const RING_DRIVEN_OFF = 2 * ARENA_R0;

/**
 * The widest gap the disc's sampling is allowed to leave anywhere inside
 * itself, world units.
 *
 * The disc and not the rim, which is the first thing this has to get right. A
 * first cut probed the boundary circle alone and passed a ring drawn straight
 * across an archipelago: every point on the rim happened to be wet and every
 * islet the boats were about to be driven through sat inside it, unprobed. A
 * ring is water the hulls CROSS, not merely water they are surrounded by.
 *
 * The second thing is the spacing, and it is why this is a distance rather
 * than a count of shells. Three shells and twelve bearings -- the 37 samples
 * this module shipped with for an afternoon -- leave a nine-unit hole between
 * the inner rings, and an eight-unit island sits in one without touching a
 * single probe. `tests/unit/battlering.test.ts` puts exactly that island in
 * exactly that hole.
 *
 * Three units is under one hull length (the ship is 3.1 long), so nothing a
 * hull could run into can hide between two probes. It costs about 320 height
 * map reads per candidate and the search tries at most 73 candidates, once,
 * at the start of a fight: a fraction of what one frame of `hazards.ts`'s
 * coast clip already spends every frame of every fight.
 */
const SAMPLE_STEP = 3;

const _north = new Vector3();
const _east = new Vector3();
const _dir = new Vector3();
const _probe = new Vector3();
const _axis = new Vector3();

/** A great-circle step of `worldUnits` from `from` along tangent `dir`. */
function step(out: Vector3, from: Vector3, dir: Vector3, worldUnits: number): Vector3 {
  _axis.crossVectors(from, dir);
  if (_axis.lengthSq() < 1e-12) return out.copy(from);
  _axis.normalize();
  return out.copy(from).applyAxisAngle(_axis, worldUnits / GLOBE_RADIUS).normalize();
}

/** The unit tangent at `centre` on bearing `theta`, written into `out`. */
function bearing(out: Vector3, centre: Vector3, theta: number): Vector3 {
  tangentFrame(centre, _north, _east);
  return out
    .copy(_north)
    .multiplyScalar(Math.cos(theta))
    .addScaledVector(_east, Math.sin(theta))
    .normalize();
}

/**
 * True where a full disc of open water fits centred on `dir`.
 *
 * A polar grid at SAMPLE_STEP in both directions: shells every three units
 * out to the clearance, and enough bearings on each shell that its own arc
 * spacing is three units too -- so an inner shell is cheap and only the
 * outermost pays for a lot of bearings.
 */
export function ringFits(heightMap: HeightMap, seaLevel: number, dir: Vector3): boolean {
  if (heightMap.sample(dir) > seaLevel) return false;
  const shells = Math.max(1, Math.ceil(RING_CLEARANCE / SAMPLE_STEP));
  for (let s = 1; s <= shells; s++) {
    const radius = (RING_CLEARANCE * s) / shells;
    const bearings = Math.max(MIN_BEARINGS, Math.ceil((Math.PI * 2 * radius) / SAMPLE_STEP));
    for (let b = 0; b < bearings; b++) {
      const theta = (b / bearings) * Math.PI * 2;
      step(_probe, dir, bearing(_dir, dir, theta), radius);
      if (heightMap.sample(_probe) > seaLevel) return false;
    }
  }
  return true;
}

/**
 * The contact point if a ring fits there, otherwise the nearest place one
 * does — searched outward in rings, so the answer is the CLOSEST open water
 * rather than merely some open water.
 *
 * The search now runs to the antipode, so on any world with one fightable
 * patch of water in it this cannot come back unplaced. The fallback below --
 * the contact point itself, `fitted: false` -- is kept for the world that has
 * none, and is the same shape of promise `hazards.ts`'s `pickRespawn` makes:
 * a fight in an awkward place beats a contact that can never resolve.
 *
 * `fitted` is how a caller tells the two identical-looking answers apart.
 * Without it "the contact was already clear" and "there is nowhere on this
 * planet to fight and this is the fallback" both come back as the contact
 * point, and no reader -- or test -- can tell which happened. Nothing in the
 * game changes its behaviour on it today; it exists because an API that
 * cannot report its own failure is one that gets believed when it should not
 * be.
 *
 * `moved` is read: `main.ts` compares it against `RING_DRIVEN_OFF` to decide
 * whether the cover card owes the player a sentence about where the fight
 * went.
 */
export interface RingPlacement {
  /** The ring's centre, a unit direction. */
  readonly centre: Vector3;
  /** True when a full clear disc was actually found. */
  readonly fitted: boolean;
  /** World units the ring was slid from the contact point. 0 when it was not. */
  readonly moved: number;
}

export function findRingCentre(
  heightMap: HeightMap,
  seaLevel: number,
  contact: Vector3,
  out = new Vector3(),
): RingPlacement {
  if (ringFits(heightMap, seaLevel, contact)) {
    out.copy(contact).normalize();
    return { centre: out, fitted: true, moved: 0 };
  }
  const shells = Math.ceil(SEARCH_MAX / SEARCH_STEP);
  for (let r = 1; r <= shells; r++) {
    const distance = (SEARCH_MAX * r) / shells;
    /*
     * The TRUE circumference of a circle of arc radius `distance` on this
     * sphere, which is `2 * PI * R * sin(distance / R)` and not `2 * PI *
     * distance`. The two agree near the contact and part company badly past a
     * quarter of the way round, where a shell is already shrinking back
     * toward the antipode: the flat formula would probe the last shell on 282
     * bearings when it is a circle a few units across. Same spacing on the
     * ground, a third of the candidates.
     */
    const circumference = 2 * Math.PI * GLOBE_RADIUS * Math.sin(distance / GLOBE_RADIUS);
    const bearings = Math.max(MIN_BEARINGS, Math.ceil(circumference / SEARCH_STEP));
    for (let b = 0; b < bearings; b++) {
      const theta = (b / bearings) * Math.PI * 2;
      step(out, contact, bearing(_dir, contact, theta), distance);
      if (ringFits(heightMap, seaLevel, out)) {
        out.normalize();
        return { centre: out, fitted: true, moved: distance };
      }
    }
  }
  out.copy(contact).normalize();
  return { centre: out, fitted: false, moved: 0 };
}
