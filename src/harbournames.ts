/**
 * harbournames.ts — the 36 harbour names, and nothing else.
 *
 * The world is redrawn on every page load (`worldgen.ts`), so a harbour's
 * POSITION is not durable and cannot be an identity. The NAME is: it is what
 * `save.ts` keys `knownHarbours` and `harbourStock` on, and what the player
 * remembers a place by. So this table is the one part of the world that never
 * moves, and it is a plain constant rather than anything generated.
 *
 * Two of the 36 are the owner's own, and they are also the two that are
 * PLACED rather than found: index 0 sits at the North Pole and index 1 at the
 * South Pole in every world ever generated. `towns.ts` reads those two indices
 * from here rather than counting from the front of the list, so re-ordering
 * the gritty and sleek blocks below is safe and moving either of the first two
 * is not.
 *
 * The rest are dealt out by placement order, which is a function of the
 * world seed, so `Rustwharf` is a different island in every world. That is
 * intended: the name is the identity, the ground under it is not.
 */

/**
 * Every harbour name, in index order. Index 0 is the North Pole and index 1
 * the South Pole, always; 2..35 are dealt in placement order.
 *
 * Eleven gritty and twenty-three sleek, which is the one-third/two-thirds mix
 * the owner asked for across the 34 that are not theirs.
 */
export const HARBOUR_NAMES: readonly string[] = [
  // The two fixed harbours, named by the owner.
  'Marine Stronghold',
  "No Man's Land",

  // Gritty, 11.
  'Rustwharf',
  'Cinder Quay',
  'Slagharbour',
  'Bilgewater Reach',
  'Scrapmoor',
  'Tarhook',
  'Ironmaw',
  'Brinegut',
  'Sootfall Landing',
  'Gutterhaven',
  'Rivet Row',

  // Sleek, 23.
  'Neon Reach',
  'Voltmeridian',
  'Lumen Bay',
  'Chromehaven',
  'Halcyon Spire',
  'Azimuth Port',
  'Prism Landing',
  'Ionport',
  'Skyline Berth',
  'Aurelia Dock',
  'Cobalt Terrace',
  'Quantum Quay',
  'Helix Harbour',
  'Zenith Mooring',
  'Solace Wharf',
  'Vantage Cove',
  'Cerulean Gate',
  'Nova Anchorage',
  'Radiant Sound',
  'Oberon Station',
  'Silvercrest',
  'Meridian Arc',
  'Luminary Point',
];

/**
 * How many harbours a world has, exactly.
 *
 * A COUNT, not a target — this is the difference between this and the
 * `CLUSTER_TARGET` it replaced. A world that cannot place all 36 is rejected
 * by `worldgen.ts` and another seed is drawn, which is what lets everything
 * downstream — the name table, the menu page, the stock roll — assume 36.
 */
export const HARBOUR_COUNT = 36;

/** Index of the harbour that is always at the North Pole. */
export const NORTH_POLE_INDEX = 0;
/** Index of the harbour that is always at the South Pole. */
export const SOUTH_POLE_INDEX = 1;

/**
 * The longest name, in characters, for the HUD and the shop header to size
 * against. Computed rather than typed, so it cannot drift from the table.
 */
export const HARBOUR_NAME_MAX_LENGTH = HARBOUR_NAMES.reduce(
  (max, name) => (name.length > max ? name.length : max),
  0,
);
