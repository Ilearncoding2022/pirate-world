/**
 * quality.ts — quality tiers, resolved once at startup.
 *
 * `createQuality()` is called once, near the top of `main.ts`, before
 * anything that reads a row of the table below is built. Every module built
 * after it -- this file's own `postfx.ts` and `main.ts`, and Phase 1's A
 * (wake map), B (displacement patch) and D (reflections) -- treats the
 * returned object as read-only; this file is the only writer of what the
 * numbers mean, and the object itself is frozen so nothing downstream can
 * quietly drift its own copy out of step with the table.
 *
 * `wakeMapSize`, `patchSegments`, `reflectionSize` and
 * `reflectionFacesPerFrame` have no reader yet -- A, B and D are the readers,
 * and they arrive in Phase 1 -- so they are exported now, exactly as named,
 * purely so those streams do not also have to agree on a table between them.
 */

export type QualityTier = 'low' | 'medium' | 'high';

/**
 * One row of the quality table.
 *
 * Almost none of these are world-scale or ship-scale in the sense
 * docs/ARCHITECTURE.md's "World scale" section means: they are pipeline and
 * wiring numbers (texel counts, a pixel-ratio ceiling, a vertex count), not
 * distances or frequencies over the globe. `landDetail` is the one exception,
 * and it says why on itself.
 */
export interface QualitySettings {
  /** Ceiling passed to `renderer.setPixelRatio` (both call sites, main.ts). */
  pixelRatioCap: number;
  /** Whether the water shader's fragment-side chop octave runs at all. Read by water.ts, a later stream -- Q does not consume this. */
  waveChop: boolean;
  /** Cap, in device pixels, on the bloom chain's working width (postfx.ts). */
  bloomMaxWidth: number;
  /** Wake render-target size in texels, square. Read by Stream A (wakemap.ts), later -- Q does not consume this. */
  wakeMapSize: number;
  /** Displacement patch vertices per side. Read by Stream B (waterpatch.ts), later -- Q does not consume this. */
  patchSegments: number;
  /** Reflection cube face size in texels; 0 disables the cube outright. Read by Stream D (reflection.ts), later -- Q does not consume this. */
  reflectionSize: number;
  /** Reflection cube faces refreshed per frame; 0 disables the cube outright. Read by Stream D, later -- Q does not consume this. */
  reflectionFacesPerFrame: number;
  /**
   * Icosphere subdivisions the land mesh is built at, per 100 units of
   * GLOBE_RADIUS. Read by `land.ts`, which does the multiplication.
   *
   * The one row here that is not an absolute count, and it cannot be one:
   * the land mesh has to keep its triangle a fixed size in WORLD units as
   * the globe grows, so the count itself is world-scale and only the tier's
   * share of it belongs in a table that knows nothing about the radius. High
   * is 96, the value the low-poly look was tuned at and the number this line
   * was extracted from; low and medium are fractions of it.
   *
   * Unlike `landFacetBlend` below, this one is paid at startup and never
   * again: the mesh is built once, culled against the height map once, and
   * then drawn every frame. So what the lower tiers buy is a smaller vertex
   * buffer and a shorter build, not a cheaper shader.
   */
  landDetail: number;
  /**
   * How far land's per-pixel height-map normal replaces the flat facet
   * normal: 0 = pure low-poly facets, 1 = fully smooth. Read by `land.ts` and
   * fed to the shader as a uniform, so unlike every other row above it costs
   * nothing to move at runtime -- it is the one land tunable the owner
   * expects to keep turning by eye.
   *
   * Not world-scale or ship-scale: it is a blend weight, like the rest of
   * this table's pipeline numbers.
   */
  landFacetBlend: number;
}

/**
 * The authoritative quality table. Q defines every row; nothing here is
 * tuned by feel -- these are the numbers docs/RENDER_PLAN.md's Phase 0/Q
 * section specifies verbatim.
 *
 * The performance budget in that document also fixes the order features drop
 * in in when a frame runs over budget: reflection size, wake map size, patch
 * segments, chop octave, pixel ratio cap -- top to bottom of this table read
 * right to left. The owner moves a machine to a lower tier rather than a
 * single feature being cut piecemeal.
 */
const QUALITY_TABLE: Readonly<Record<QualityTier, QualitySettings>> = {
  low: {
    pixelRatioCap: 1,
    waveChop: false,
    bloomMaxWidth: 960,
    wakeMapSize: 256,
    patchSegments: 96,
    reflectionSize: 0,
    reflectionFacesPerFrame: 0,
    landDetail: 64,
    landFacetBlend: 0.6,
  },
  medium: {
    pixelRatioCap: 1.5,
    waveChop: true,
    bloomMaxWidth: 1280,
    wakeMapSize: 512,
    patchSegments: 128,
    reflectionSize: 128,
    reflectionFacesPerFrame: 1,
    landDetail: 80,
    landFacetBlend: 0.8,
  },
  high: {
    pixelRatioCap: 2,
    waveChop: true,
    bloomMaxWidth: 1280,
    wakeMapSize: 512,
    patchSegments: 160,
    reflectionSize: 256,
    reflectionFacesPerFrame: 2,
    landDetail: 96,
    landFacetBlend: 0.85,
  },
};

export interface Quality extends QualitySettings {
  readonly tier: QualityTier;
}

/**
 * Same "namespace/name" shape as `SAVE_KEY` in save.ts, and stored the same
 * tolerant way: a player's chosen tier survives a reload without a `?quality=`
 * on the URL.
 */
export const QUALITY_STORAGE_KEY = 'pirate-world/quality';

function isQualityTier(value: string | null): value is QualityTier {
  return value === 'low' || value === 'medium' || value === 'high';
}

/**
 * `localStorage` throws on access in some private-browsing modes rather than
 * merely being empty, and a quota error can happen on a machine that was
 * reading it happily a moment earlier -- same tolerance `save.ts` applies to
 * every read and write of its own key.
 */
function readStoredTier(): QualityTier | null {
  try {
    const stored = window.localStorage.getItem(QUALITY_STORAGE_KEY);
    return isQualityTier(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** `?quality=` wins outright over a stored choice; a stored choice wins over the default. */
function resolveTier(search: string): QualityTier {
  const fromQuery = new URLSearchParams(search).get('quality');
  if (isQualityTier(fromQuery)) return fromQuery;
  return readStoredTier() ?? 'high';
}

declare global {
  interface Window {
    /**
     * Present only when `?quality=` or `?debug` is on the URL -- never in an
     * ordinary player's session. `import.meta.env.MODE !== 'production'`
     * would be the wrong guard here: `vite preview` serves a genuine
     * production build, and the smoke test's `?quality=low` pass needs this
     * hook to exist under exactly that build.
     */
    __pirateWorld?: {
      quality: Quality;
      /**
       * The live hazards, kind and envelope only, refreshed every frame.
       * Written by `main.ts` when this hook exists at all, so it appears and
       * disappears with the hook rather than on a guard of its own.
       *
       * It is here for `tests/shots.mjs`, which has to photograph a great wave
       * and a maelstrom and cannot do it on a timer. `?hazard=` releases one
       * three SIMULATED seconds in, and `dt` is capped at 0.1 s a frame
       * (`main.ts`), so on the software rasteriser the browser tier runs --
       * roughly a frame a second -- those three seconds take thirty of wall
       * clock, and then the funnel still has to grow. A fixed sleep either
       * photographs empty water or wastes half a minute on every run. This is
       * the condition to wait for instead, per docs/TESTING.md rule 2.
       */
      hazards?: { kind: string; envelope: number }[];
    };
  }
}

/**
 * Builds the frozen settings for this session and, if the URL asks for it,
 * publishes the debug hook. Called once, at the top of `main.ts`, before the
 * two `renderer.setPixelRatio` calls or anything else that reads a row of the
 * table.
 */
export function createQuality(search: string = window.location.search): Quality {
  const tier = resolveTier(search);
  const quality: Quality = Object.freeze({ tier, ...QUALITY_TABLE[tier] });

  const params = new URLSearchParams(search);
  if (params.has('quality') || params.has('debug')) {
    window.__pirateWorld = { quality };
  }

  return quality;
}
