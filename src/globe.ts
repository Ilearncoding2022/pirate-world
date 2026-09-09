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
import { createGrid } from './grid';
import { createSky } from './sky';
import { createCelestial } from './celestial';
import { createDayNight } from './daynight';
import { createClouds } from './clouds';
import { createCityLights } from './citylights';
import { createTowns } from './towns';
import { SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import { latLonToDir } from './geo';
import { updateFog } from './fog';
import { createFogBank } from './fogbank';
import { createWeatherMap } from './weathermap';
import { createWaterPatch } from './waterpatch';
import type { Quality } from './quality';

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
 * Assembles the world.
 *
 * Ordering matters: the day/night rig writes the environment, then every other
 * module reads it, so all shaders agree on sun direction within a frame.
 *
 * @param waterPlugins Everything that adds to the water shader, built by
 *   `main.ts` and handed in already constructed. Each one needs something this
 *   module never sees -- the wake needs the ribbon it is drawn from, the
 *   reflection cube needs the renderer and the top-level scene -- and each
 *   one's per-frame work is driven from the frame loop, not from here.
 */
export function createGlobe(
  terrain: Terrain,
  quality: Quality,
  waterPlugins: WaterPlugin[] = [],
): Globe {
  const group = new THREE.Group();
  group.name = 'world';

  const heightMap = createHeightMap(terrain);

  // Sink the specks before anything reads the map. Everything downstream --
  // the flood fill, the berth search, the land mesh, the scope -- then sees one
  // world, and none of them has to know the cull happened.
  cullIslets(heightMap, terrain.seaLevel);
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
  // and the charging test all read this one list.
  const towns = createTowns(heightMap, waterBodies, terrain.seaLevel);

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
  const cityLights = createCityLights(terrain, heightMap, towns);
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
