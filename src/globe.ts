import * as THREE from 'three';
import type { Terrain } from './types';
import type { WorldEnv } from './env';
import { createHeightMap } from './heightmap';
import type { HeightMap } from './heightmap';
import { createLand } from './land';
import { createWater } from './water';
import { createGrid } from './grid';
import { createSky } from './sky';
import { createDayNight } from './daynight';
import { createClouds } from './clouds';
import { createCityLights } from './citylights';

export interface Globe {
  group: THREE.Group;
  /** Shared height field, also used by ship collision debugging and any map view. */
  heightMap: HeightMap;
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

  const dayNight = createDayNight();
  const water = createWater(terrain, heightMap);
  const land = createLand(terrain);
  const cityLights = createCityLights(terrain, heightMap);
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
