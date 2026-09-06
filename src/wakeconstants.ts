import { GLOBE_RADIUS } from './geo';
import { MODEL_SCALE } from './ship';

/**
 * The wake's shared geometry: the numbers that both the on-screen ribbon in
 * `wake.ts` and the map-only ribbon in `wakemap.ts` have to agree on.
 *
 * They exist as their own module because the two consumers form a cycle --
 * `wake.ts` imports `createWakeMap` from `wakemap.ts`, so `wakemap.ts` cannot
 * import back. The first version of the wake map duplicated all six of these
 * with a comment asking the next reader to keep them in sync by hand, which is
 * the kind of arrangement that survives exactly until someone tunes one file
 * and not the other. This module imports nothing from either, so there is no
 * cycle and nothing to remember.
 *
 * Every value here is **ship-scale**: absolute world units, authored against
 * the hull, unchanged by `GLOBE_RADIUS`. See **World scale** in
 * `docs/ARCHITECTURE.md` for why that is a deliberate half of the split.
 */

/**
 * Lift of the ribbon above the water sphere.
 *
 * Was 0.1, which cleared the sphere's facet sag and nothing else, because the
 * sea was flat. It is not any more: `waterpatch.ts` displaces the surface near
 * the ship by up to DISPLACE_AMPLITUDE (0.3) at a full gale, so a ribbon at
 * 0.1 would be swallowed by every crest in heavy weather. This clears the
 * highest crest the sea can raise.
 *
 * The cost is that in a dead calm -- where the displacement is only
 * `CALM_INTENSITY` of that, about 0.05 -- the ribbon sits a little proud of
 * the water. The honest fix is to displace each rib by the wave field as it is
 * laid, which `wavefield.ts` now makes possible and which nothing else needed
 * before; it is deliberately left as a follow-up rather than folded into an
 * integration pass.
 *
 * The water mesh is a 256x128 sphere, so its facets sag
 * `GLOBE_RADIUS * (1 - cos(PI / 256))` below the true surface -- about 0.015 at
 * the current radius. This has to clear that plus the ribbon's own much smaller
 * sag. Absolute rather than radius-scaled on purpose: the sag grows with the
 * radius but the segment counts grow with it too, so it stays put.
 */
export const SURFACE_LIFT = 0.4;

/** Radius the ribbon is drawn at: the water surface plus its lift. */
export const WAKE_RADIUS = GLOBE_RADIUS + SURFACE_LIFT;

/**
 * Half-width of a freshly laid rib, and how fast a rib keeps spreading.
 *
 * The initial width is the hull's beam, so it scales with the hull. The spread
 * rate is the sea's answer to being parted and is left alone, so a smaller ship
 * cuts a narrower wake that opens out just as wide behind it.
 */
export const HALF_WIDTH_0 = 1.15 * MODEL_SCALE;
export const SPREAD_RATE = 1.95;

/** Seconds from laying a rib to it having completely dissolved. */
export const WAKE_LIFE = 4.0;

/**
 * Where the foam is thrown, relative to the ship's origin.
 *
 * Authored against the hull's own half-length, so they are multiplied by the
 * same `MODEL_SCALE` the hull is drawn at. Left at full size against a shrunken
 * ship the wake starts a whole boat-length astern of the transom and the bow
 * spray erupts out of open water ahead of the stem -- the most visible way
 * there is to get a scale change wrong.
 */
export const STERN_BACK = 2.3 * MODEL_SCALE;
export const BOW_FORWARD = 2.5 * MODEL_SCALE;
