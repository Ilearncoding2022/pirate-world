import * as THREE from 'three';
import type { Terrain, Towns, ShipState, WindState } from './types';
import type { WorldEnv } from './env';
import { createHeightMap } from './heightmap';
import type { HeightMap } from './heightmap';
import type { WaterBodies } from './waterbodies';
import { createLand } from './land';
import { createWater } from './water';
import type { WaterPlugin } from './water';
import { createWaterBodies } from './waterbodies';
import { cullIslets } from './islets';
import { createGrid } from './grid';
import { createSky } from './sky';
import { createDayNight } from './daynight';
import { createClouds } from './clouds';
import { createCityLights } from './citylights';
import { createTowns } from './towns';
import { SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import { latLonToDir } from './geo';
import { updateFog } from './fog';

export interface Globe {
  group: THREE.Group;
  /** Shared height field, also used by ship collision debugging and any map view. */
  heightMap: HeightMap;
  /** Which water the ship can reach. Read by the water shader. */
  waterBodies: WaterBodies;
  /** Settlements and their berths. Shared with docks.ts, radar.ts and energy.ts. */
  towns: Towns;
  /**
   * `ship` and `camera` exist for the water's plugins (Phase 1 streams A and
   * D): the wake map and the reflection cube both follow the ship, and
   * neither is available from `env` or `wind`.
   */
  update(dt: number, env: WorldEnv, wind: WindState, ship: ShipState, camera: THREE.Camera): void;
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
export function createGlobe(terrain: Terrain, waterPlugins: WaterPlugin[] = []): Globe {
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
  const land = createLand(terrain, heightMap);
  const cityLights = createCityLights(terrain, heightMap, towns);
  const clouds = createClouds();
  const sky = createSky();

  group.add(dayNight.group);
  group.add(water.mesh);
  group.add(land.mesh);
  group.add(cityLights.object);
  group.add(clouds.object);
  group.add(createGrid());
  group.add(sky.group);

  return {
    group,
    heightMap,
    waterBodies,
    towns,
    update(dt: number, env: WorldEnv, wind: WindState, ship: ShipState, camera: THREE.Camera): void {
      dayNight.update(dt, env);
      // Before water and land, so both shaders sample this frame's fog
      // colours rather than last frame's -- the same ordering rule as the sun.
      updateFog(env);
      // Only the sea reads the weather. It is passed rather than pushed onto
      // `env` because `env.ts` names day/night as its sole writer, and a second
      // writer is a harder thing to give up than an extra argument. `ship` and
      // `camera` are for its plugins; the sphere itself ignores them.
      water.update(dt, env, wind, ship, camera);
      land.update(dt, env);
      cityLights.update(dt, env);
      clouds.update(dt, env);
      sky.update(dt, env);
    },
  };
}
