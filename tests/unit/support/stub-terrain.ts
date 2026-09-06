import type { Vector3 } from 'three';
import type { Terrain } from '../../../src/types';
import { latLonToDir } from '../../../src/geo';

/**
 * A minimal `Terrain` for tests that need the interface but not the real
 * generator. `heightAt` defaults to a flat sea (well under `seaLevel`), so
 * `isLand` is false everywhere unless a caller overrides `heightAt` or calls
 * `useLandMask`.
 *
 * Used by `ship-physics.test.ts` (which wants a hull that never runs
 * aground) and `heightmap.test.ts` (which wants full control over what each
 * texel bakes to).
 */
export function createStubTerrain(heightAt: (dir: Vector3) => number = () => -1): Terrain {
  const seaLevel = 0.08;
  let landMask: ((dir: Vector3) => number) | null = null;

  return {
    heightAt,
    isLand(dir: Vector3): boolean {
      return (landMask !== null ? landMask(dir) : heightAt(dir)) > seaLevel;
    },
    isLandLatLon(latDeg: number, lonDeg: number): boolean {
      return this.isLand(latLonToDir(latDeg, lonDeg));
    },
    useLandMask(sample: (dir: Vector3) => number): void {
      landMask = sample;
    },
    seaLevel,
  };
}
