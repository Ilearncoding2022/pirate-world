import type { Species, Tier } from './types';

/**
 * species.ts — the catalogue, and the odds of meeting anything in it.
 *
 * Data only. Nothing here reads the DOM, the clock or the canvas, so the sim
 * and the Fish Book can both hold it without either owning it.
 *
 * Every number in this file is a first-pass balance figure from
 * `docs/FISHING_PLAN.md` and is expected to move. They are named constants and
 * tables for that reason: a retune should be an edit here and nowhere else.
 */

/* ------------------------------------------------------------------ */
/* Tiers                                                               */
/* ------------------------------------------------------------------ */

export interface TierInfo {
  readonly tier: Tier;
  readonly name: string;
  /** CSS colour. Mirrors --tier-N in style.css; keep the two in step. */
  readonly colour: string;
  /**
   * Whether a hooked fish of this tier fights the line.
   *
   * It is a property of the tier and not of the species because the struggle
   * is the *reward curve* talking, not the animal: the top two bands are worth
   * three to sixty times a common fish, and the tap is what is being charged
   * for that.
   */
  readonly struggles: boolean;
}

export const TIERS: readonly TierInfo[] = [
  { tier: 1, name: 'COMMON', colour: '#9fb3c8', struggles: false },
  { tier: 2, name: 'UNCOMMON', colour: '#4bf0a6', struggles: false },
  { tier: 3, name: 'RARE', colour: '#3fe0ff', struggles: false },
  { tier: 4, name: 'EPIC', colour: '#b05cff', struggles: true },
  { tier: 5, name: 'LEGENDARY', colour: '#ffb445', struggles: true },
];

/** The tier's record. Tiers are 1-based and dense, so this is a subtraction. */
export function tierInfo(tier: Tier): TierInfo {
  return TIERS[tier - 1];
}

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

/**
 * Twenty species, four per tier.
 *
 * `id` is the save key and must never change once a build has shipped: a
 * renamed id is a player's catch history silently reset to zero. `save.ts`
 * keeps unknown ids on load for the same reason.
 *
 * `size` multiplies the base fish length (0.06 card widths) and so drives both
 * the sprite and the hit box — a legendary is a bigger target as well as a
 * bigger prize, which is the small mercy that keeps the top tiers from being
 * pure luck. `speed` multiplies the row's base speed and cuts the other way.
 */
export const SPECIES: readonly Species[] = [
  /* --- Tier 1 — COMMON ------------------------------------------- */
  {
    id: 'voltfin-sardine',
    name: 'Voltfin Sardine',
    tier: 1,
    size: 0.6,
    speed: 1.3,
    gold: 5,
    art: { emoji: '🐟', tint: '#3fe0ff' },
  },
  {
    id: 'rustgill-herring',
    name: 'Rustgill Herring',
    tier: 1,
    size: 0.7,
    speed: 1.1,
    gold: 6,
    art: { emoji: '🐟', tint: '#c8763a' },
  },
  {
    id: 'tinscale-anchovy',
    name: 'Tinscale Anchovy',
    tier: 1,
    size: 0.5,
    speed: 1.5,
    gold: 4,
    art: { emoji: '🐟', tint: '#b8c4cc' },
  },
  {
    id: 'sparkplug-minnow',
    name: 'Sparkplug Minnow',
    tier: 1,
    size: 0.5,
    speed: 1.4,
    gold: 5,
    art: { emoji: '🐠', tint: '#ffe14d' },
  },

  /* --- Tier 2 — UNCOMMON ----------------------------------------- */
  {
    id: 'brass-gill-grouper',
    name: 'Brass-Gill Grouper',
    tier: 2,
    size: 1.0,
    speed: 0.8,
    gold: 15,
    art: { emoji: '🐠', tint: '#dba43a' },
  },
  {
    id: 'coilfin-mackerel',
    name: 'Coilfin Mackerel',
    tier: 2,
    size: 0.8,
    speed: 1.2,
    gold: 12,
    art: { emoji: '🐟', tint: '#4bf0a6' },
  },
  {
    id: 'neon-wrasse',
    name: 'Neon Wrasse',
    tier: 2,
    size: 0.8,
    speed: 1.0,
    gold: 14,
    art: { emoji: '🐠', tint: '#ff4fd8' },
  },
  {
    id: 'gearback-bream',
    name: 'Gearback Bream',
    tier: 2,
    size: 0.9,
    speed: 0.9,
    gold: 13,
    art: { emoji: '🐡', tint: '#9fb3c8' },
  },

  /* --- Tier 3 — RARE --------------------------------------------- */
  {
    id: 'reactor-eel',
    name: 'Reactor Eel',
    tier: 3,
    size: 1.3,
    speed: 1.0,
    gold: 35,
    art: { emoji: '🐍', tint: '#7dff5a' },
  },
  {
    id: 'chrome-manta',
    name: 'Chrome Manta',
    tier: 3,
    size: 1.3,
    speed: 0.7,
    gold: 40,
    art: { emoji: '🛸', tint: '#e8f4ff' },
  },
  {
    id: 'piston-pufferfish',
    name: 'Piston Pufferfish',
    tier: 3,
    size: 1.0,
    speed: 0.6,
    gold: 30,
    art: { emoji: '🐡', tint: '#ffb445' },
  },
  {
    id: 'cobalt-lionfish',
    name: 'Cobalt Lionfish',
    tier: 3,
    size: 1.1,
    speed: 0.8,
    gold: 38,
    art: { emoji: '🐠', tint: '#4d7cff' },
  },

  /* --- Tier 4 — EPIC --------------------------------------------- */
  {
    id: 'dynamo-swordfish',
    name: 'Dynamo Swordfish',
    tier: 4,
    size: 1.5,
    speed: 1.4,
    gold: 90,
    art: { emoji: '🐬', tint: '#3fe0ff' },
  },
  {
    id: 'ironjaw-barracuda',
    name: 'Ironjaw Barracuda',
    tier: 4,
    size: 1.4,
    speed: 1.3,
    gold: 85,
    art: { emoji: '🦈', tint: '#8a96a3' },
  },
  {
    id: 'flux-octopus',
    name: 'Flux Octopus',
    tier: 4,
    size: 1.3,
    speed: 0.6,
    gold: 100,
    art: { emoji: '🐙', tint: '#b05cff' },
  },
  {
    id: 'arc-light-jellyfish',
    name: 'Arc-Light Jellyfish',
    tier: 4,
    size: 1.2,
    speed: 0.4,
    gold: 80,
    art: { emoji: '🪼', tint: '#ff4fd8' },
  },

  /* --- Tier 5 — LEGENDARY ---------------------------------------- */
  {
    id: 'warp-core-hammerhead',
    name: 'Warp-Core Hammerhead',
    tier: 5,
    size: 2.0,
    speed: 0.9,
    gold: 250,
    art: { emoji: '🦈', tint: '#ff5470' },
  },
  {
    id: 'leviathan-squid',
    name: 'Leviathan Squid',
    tier: 5,
    size: 2.2,
    speed: 0.6,
    gold: 300,
    art: { emoji: '🦑', tint: '#b05cff' },
  },
  {
    id: 'plasma-narwhal',
    name: 'Plasma Narwhal',
    tier: 5,
    size: 2.0,
    speed: 0.7,
    gold: 280,
    art: { emoji: '🐋', tint: '#3fe0ff' },
  },
  {
    id: 'clockwork-coelacanth',
    name: 'Clockwork Coelacanth',
    tier: 5,
    size: 1.8,
    speed: 0.5,
    gold: 320,
    art: { emoji: '🐢', tint: '#dba43a' },
  },
];

/** Built once. The Fish Book resolves saved ids through this every open. */
const BY_ID = new Map<string, Species>(SPECIES.map((s) => [s.id, s]));

/**
 * The species with this id, or undefined for an id this build has never heard
 * of — which is exactly what a save written by a later build can contain.
 */
export function speciesById(id: string): Species | undefined {
  return BY_ID.get(id);
}

/** Indexed by tier, so `BY_TIER[3]` is every EPIC. Index 0 is unused. */
const BY_TIER: readonly (readonly Species[])[] = [
  [],
  SPECIES.filter((s) => s.tier === 1),
  SPECIES.filter((s) => s.tier === 2),
  SPECIES.filter((s) => s.tier === 3),
  SPECIES.filter((s) => s.tier === 4),
  SPECIES.filter((s) => s.tier === 5),
];

/* ------------------------------------------------------------------ */
/* Row odds                                                            */
/* ------------------------------------------------------------------ */

/** Rows in the water. The card's geometry in `fishsim.ts` must agree. */
export const ROW_COUNT = 5;

/**
 * Percent chance, per row, that a spawn belongs to each tier. Row 0 is the
 * shallowest; the deeper the water, the better the company.
 *
 * Rows are the whole risk curve of the game. A harpoon fired at row 4 passes
 * through every row above it and hooks the FIRST thing it touches, so fishing
 * the deep water means threading a gap in the shallow traffic — the odds below
 * are only available to a player who can wait for one.
 *
 * Each row must total 100. `rollSpecies` walks the row's cumulative sum and
 * falls back to the last non-empty tier, so a row that did not total 100 would
 * bias silently toward that tier rather than throwing; the probe in
 * `tools/` (see FISHING_PLAN.md) is what actually holds these to the table.
 */
export const ROW_ODDS: readonly (readonly number[])[] = [
  /* row 1 */ [70, 25, 5, 0, 0],
  /* row 2 */ [50, 30, 15, 5, 0],
  /* row 3 */ [30, 30, 25, 12, 3],
  /* row 4 */ [15, 25, 30, 20, 10],
  /* row 5 */ [5, 15, 30, 30, 20],
];

/**
 * Picks a species for a spawn on `row`, using `rng` for both draws.
 *
 * Two independent rolls: the tier off the row's odds, then a species uniformly
 * within that tier. Uniform within a tier is deliberate — rarity is the tier's
 * job, and giving individual species their own weights would mean two knobs
 * controlling one feeling.
 *
 * `rng` is injected rather than taken from `Math.random` so the odds can be
 * verified against a seeded sequence, and so a future daily-challenge seed
 * costs nothing to add.
 */
export function rollSpecies(row: number, rng: () => number): Species {
  const odds = ROW_ODDS[row] ?? ROW_ODDS[0];

  // Scaled to the row's own total rather than a hard 100, so a mistuned row
  // stays a valid distribution instead of biasing toward its last tier.
  let total = 0;
  for (const share of odds) total += share;

  let roll = rng() * total;
  let tier: Tier = 1;
  for (let i = 0; i < odds.length; i++) {
    roll -= odds[i];
    if (roll < 0) {
      tier = (i + 1) as Tier;
      break;
    }
    // A zero-share tier can never win: `roll -= 0` leaves it non-negative.
    // Falling out of the loop entirely means the row was all zeroes, and tier
    // 1 is the right answer to that.
  }

  const pool = BY_TIER[tier];
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}
