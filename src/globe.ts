import * as THREE from 'three';
import type { Terrain, Towns } from './types';
import type { WorldEnv } from './env';
import { createHeightMap } from './heightmap';
import type { HeightMap } from './heightmap';
import type { WaterBodies } from './waterbodies';
import { createLand } from './land';
import { createWater } from './water';
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

export interface Globe {
  group: THREE.Group;
  /** Shared height field, also used by ship collision debugging and any map view. */
  heightMap: HeightMap;
  /** Which water the ship can reach. Read by the water shader. */
  waterBodies: WaterBodies;
  /** Settlements and their berths. Shared with docks.ts, radar.ts and energy.ts. */
  towns: Towns;
  update(dt: number, env: WorldEnv): void;
}

/**
 * Assembles the world.
 *
 * Ordering matters: the day/night rig writes the environment, then every other
 * module reads it, so all shaders agree on sun direction within a frame.
 */
export function createGlobe(terrain: Terrain): Globe {
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
  const water = createWater(terrain, heightMap, waterBodies);
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
    update(dt: number, env: WorldEnv): void {
      dayNight.update(dt, env);
      water.update(dt, env);
      land.update(dt, env);
      cityLights.update(dt, env);
      clouds.update(dt, env);
      sky.update(dt, env);
    },
  };
}
