import * as THREE from 'three';
import type { CellsState, Terrain, Towns, ShipState, WeatherState, WindState } from './types';
import type { WorldEnv } from './env';
import { createHeightMap } from './heightmap';
import type { HeightMap } from './heightmap';
import type { WaterBodies } from './waterbodies';
import { createLand } from './land';
import { createWater } from './water';
import type { Water, WaterPlugin } from './water';
import { createWaterBodies } from './waterbodies';
import { cullIslets } from './islets';
import type { IsletCull } from './islets';
import { createGrid } from './grid';
import { createSky } from './sky';
import { createCelestial } from './celestial';
import { createDayNight } from './daynight';
import { createClouds } from './clouds';
import { createCityLights } from './citylights';
import { createTowns } from './towns';
import { DEFAULT_SEED, SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import { latLonToDir } from './geo';
import { updateFog } from './fog';
import { createFogBank } from './fogbank';
import { createWeatherMap } from './weathermap';
import { createWaterPatch } from './waterpatch';
import type { Quality } from './quality';

/**
 * Everything about a world that is decided before a single triangle exists.
 *
 * This is the half of `createGlobe` that `worldgen.ts` runs in a loop, and the
 * split is the whole reason the loop is affordable. `docs/HARBOURS_PLAN.md`,
 * Trap 1: the expensive half of building a world is the land mesh -- 2.2
 * million vertices on the high tier -- and it comes LAST, after the height map,
 * the islet cull, the flood fill and the town search have already decided
 * whether the world is any good. A rejection loop around the whole call would
 * have paid for a land mesh per rejected world, twelve times over in the worst
 * case, for meshes nobody ever sees.
 *
 * So: no THREE objects in here, nothing added to a scene, nothing that touches
 * a renderer. About a second on the owner's machine, on the main thread, behind
 * the loading bar. `buildWorldMeshes` turns an accepted one into a `Globe`.
 */
export interface WorldData {
  /**
   * The world seed this was built from. Carried because `citylights.ts` derives
   * its scatter from it and `buildWorldMeshes` is the only thing that calls
   * that -- by the time the meshes are built, the `Terrain` that knew the seed
   * is three modules away and does not report it.
   */
  readonly seed: number;
  /** Rasterised, islets already culled, installed as the terrain's land mask. */
  readonly heightMap: HeightMap;
  /**
   * What the cull did, carried rather than dropped because `worldgen.ts` reads
   * two of its counts to judge the world.
   *
   * The flood fill in `islets.ts` is the only thing in the pipeline that knows
   * which texels belong to the same landmass, and the equatorial strip's
   * guarantee is a connectivity question -- whether land INSIDE the strip is
   * joined to a coast outside it. Asking again downstream would mean a second
   * flood fill over the same raster to recompute an answer that was already
   * worked out and thrown away.
   */
  readonly isletCull: IsletCull;
  /** Flooded from the spawn point: which water the ship can reach. */
  readonly waterBodies: WaterBodies;
  /** Settlements and their berths. Short of HARBOUR_COUNT means a bad world. */
  readonly towns: Towns;
}

export interface Globe {
  group: THREE.Group;
  /** Shared height field, also used by ship collision debugging and any map view. */
  heightMap: HeightMap;
  /** Which water the ship can reach. Read by the water shader. */
  waterBodies: WaterBodies;
  /** Settlements and their berths. Shared with docks.ts, radar.ts and energy.ts. */
  towns: Towns;
  /**
   * `water.offsets` (Phase 1 stream B): the three wave layers' integrated
   * drift, read-only, so `ship.ts` can sample the CPU wave field
   * (`wavefield.ts`) at the exact positions the shader does. Same object
   * `water.update()` mutates in place every frame -- not a copy.
   */
  readonly waveOffsets: Water['offsets'];
  /**
   * `ship` and `camera` exist for the water's plugins (Phase 1 streams A and
   * D): the wake map and the reflection cube both follow the ship, and
   * neither is available from `env` or `wind`.
   */
  update(
    dt: number,
    env: WorldEnv,
    wind: WindState,
    weather: WeatherState,
    cells: CellsState,
    ship: ShipState,
    camera: THREE.Camera,
  ): void;
}

/**
 * The data half of the world: height map, islet cull, flood fill, towns.
 *
 * Pure in the sense that matters here -- it constructs no THREE object and
 * adds nothing to a scene -- with the one documented exception that it installs
 * the culled map as the terrain's land mask, which it must, because collision
 * reads the terrain and not the map. See the note at the call below.
 *
 * `worldgen.ts` calls this once per attempt and throws most of them away.
 * Nothing else may: `main.ts` calls it through `generateWorld` and everything
 * else goes through `createGlobe`.
 *
 * @param quality Unused today and taken anyway, because the one thing that
 *   would plausibly want it -- the height map's resolution -- is the number
 *   every fixture, every berth walk and every shader lookup is calibrated
 *   against, and the day someone tiers it this signature should not have to
 *   change. Named with the leading underscore the compiler wants for an
 *   unused parameter rather than dropped, so the call sites read the same.
 */
export function buildWorldData(
  terrain: Terrain,
  _quality: Quality,
  seed: number = DEFAULT_SEED,
): WorldData {
  const heightMap = createHeightMap(terrain);

  // Sink the specks before anything reads the map. Everything downstream --
  // the flood fill, the berth search, the land mesh, the scope -- then sees one
  // world, and none of them has to know the cull happened.
  const isletCull = cullIslets(heightMap, terrain.seaLevel);
  // Collision is the exception: `ship.ts` asks the terrain, not the map. Hand
  // the culled map over as the land mask so the hull stops snagging on islets
  // that no longer exist anywhere else.
  terrain.useLandMask(heightMap.sample);

  // Flooded from the ship's own spawn point, so "reachable" means reachable
  // by the player, not merely connected to some arbitrary sea.
  const waterBodies = createWaterBodies(
    heightMap,
    terrain.seaLevel,
    latLonToDir(SPAWN_LAT_DEG, SPAWN_LON_DEG),
  );

  // Placed before anything that draws them: the lights, the berths, the scope
  // and the charging test all read this one list. A world whose coast cannot
  // hold HARBOUR_COUNT of them comes back short and `worldgen.ts` redraws;
  // that judgement is not made here.
  const towns = createTowns(heightMap, waterBodies, terrain.seaLevel);

  return { seed, heightMap, isletCull, waterBodies, towns };
}

/**
 * The mesh half: everything that draws.
 *
 * Ordering matters: the day/night rig writes the environment, then every other
 * module reads it, so all shaders agree on sun direction within a frame.
 *
 * Called exactly once per session, on the world that passed its checks. It is
 * the expensive half (the land mesh alone is 2.2 million vertices on the high
 * tier), which is precisely why it is not inside the rejection loop.
 *
 * @param waterPlugins Everything that adds to the water shader, built by
 *   `main.ts` and handed in already constructed. Each one needs something this
 *   module never sees -- the wake needs the ribbon it is drawn from, the
 *   reflection cube needs the renderer and the top-level scene -- and each
 *   one's per-frame work is driven from the frame loop, not from here.
 */
export function buildWorldMeshes(
  data: WorldData,
  terrain: Terrain,
  quality: Quality,
  waterPlugins: WaterPlugin[] = [],
): Globe {
  const group = new THREE.Group();
  group.name = 'world';

  const { heightMap, waterBodies, towns } = data;

  const dayNight = createDayNight();
  // Every water plugin is built by `main.ts` and handed in, because each one
  // needs something this module never sees: the wake needs the ribbon it is
  // drawn from, the reflection cube needs the renderer and the top-level
  // scene. Streams A and D each arrived wanting their own parameter here; one
  // list is what stops the next one adding a third.
  const water = createWater(terrain, heightMap, waterBodies, waterPlugins);
  // Ship-following displacement patch: reads the sphere's already-assembled
  // fragment shader and shares its uniforms by reference, so it never needs
  // its own per-frame wave bookkeeping. It has to be built after the plugins
  // are woven in, or it would clone a shader that is missing them. See
  // waterpatch.ts.
  const waterPatch = createWaterPatch(water, quality);
  const land = createLand(terrain, heightMap, quality);
  const cityLights = createCityLights(terrain, heightMap, towns, data.seed);
  const clouds = createClouds();
  /*
   * The fog you sail into, as opposed to the haze `updateFog` writes into
   * every surface shader below. Built here rather than in `main.ts` -- unlike
   * `rain.ts`, which is a box around the hull and belongs to the scene -- for
   * the same reason the cloud deck is: it reads `weathermap.ts`, whose one
   * uniform is merged into its material at construction, and the map is owned
   * a few lines down.
   *
   * `quality.fogSlices` is 0 on the low tier, where the module is ABSENT and
   * fog is the aerial term alone. Same convention as `main.ts`'s rain.
   */
  const fogBank = quality.fogSlices > 0 ? createFogBank(quality.fogSlices) : null;
  // Owned here rather than in `main.ts` because everything that reads it --
  // the water, the land and the cloud deck -- is built here, and its one
  // uniform is merged into their materials at construction.
  const weatherMap = createWeatherMap();
  const sky = createSky();
  const celestial = createCelestial();

  group.add(dayNight.group);
  group.add(water.mesh);
  group.add(waterPatch.mesh);
  group.add(land.mesh);
  group.add(cityLights.object);
  group.add(clouds.object);
  if (fogBank) group.add(fogBank.object);
  group.add(createGrid());
  group.add(sky.group);
  group.add(celestial.group);

  return {
    group,
    heightMap,
    waterBodies,
    towns,
    waveOffsets: water.offsets,
    update(
      dt: number,
      env: WorldEnv,
      wind: WindState,
      weather: WeatherState,
      cells: CellsState,
      ship: ShipState,
      camera: THREE.Camera,
    ): void {
      // The weather reaches the LIGHTS here and `env` never: `daynight.ts`
      // stays the sole writer of the environment.
      dayNight.update(dt, env, weather);
      // Before water and land, so both shaders sample this frame's fog
      // colours rather than last frame's -- the same ordering rule as the sun.
      updateFog(env, weather);
      // And before anything that samples the map, for the same reason. It
      // re-bakes at its own few-times-a-second rate and skips the work
      // entirely while no cell is alive.
      weatherMap.update(dt, cells);
      // Only the sea reads the weather. It is passed rather than pushed onto
      // `env` because `env.ts` names day/night as its sole writer, and a second
      // writer is a harder thing to give up than an extra argument. `ship` and
      // `camera` are for its plugins; the sphere itself ignores them.
      water.update(dt, env, wind, ship, camera);
      waterPatch.update(dt, ship);
      land.update(dt, env);
      cityLights.update(dt, env);
      clouds.update(dt, env, weather);
      // After the map is baked, like every other consumer of it, and after
      // the deck for no reason beyond reading in the order the two are drawn.
      // It takes `ship` because the bank is a cap that follows the hull, and
      // `cells` because whether it is drawn at all is decided analytically
      // from the live cells rather than read back off the map -- see
      // `fogInRange`, and docs/WEATHER_PLAN.md, Trap 3.
      fogBank?.update(dt, env, ship, weather, cells);
      sky.update(dt, env, weather);
      // After dayNight.update, like every other consumer: it only draws what
      // the sun and moon vectors already say.
      celestial.update(dt, env);
    },
  };
}

/**
 * Both halves, in order. The shape `createGlobe` always had.
 *
 * Kept because most callers -- the fixture generator, anything headless --
 * want a world and do not care that building one is two steps. `main.ts` is
 * the exception and calls the halves itself, with the rejection loop between
 * them.
 */
export function createGlobe(
  terrain: Terrain,
  quality: Quality,
  waterPlugins: WaterPlugin[] = [],
  seed: number = DEFAULT_SEED,
): Globe {
  return buildWorldMeshes(buildWorldData(terrain, quality, seed), terrain, quality, waterPlugins);
}
