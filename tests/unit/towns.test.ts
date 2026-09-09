import { describe, it, expect, beforeAll } from 'vitest';
import { Vector3 } from 'three';
import { world1337 } from './support/world-1337';
import { BERTH_MAX_ARC, POLE_OFFSET_RAD } from '../../src/towns';
import { HARBOUR_COUNT, HARBOUR_NAMES } from '../../src/harbournames';
import { GLOBE_RADIUS } from '../../src/geo';
import type { Towns } from '../../src/types';

/**
 * The world's harbours, against the real seed-1337 height map.
 *
 * Everything downstream of `towns.ts` assumes the four promises checked here:
 * that there are exactly HARBOUR_COUNT harbours, that every one has a berth,
 * that no two berths overlap (which is what lets `dockAt` return the first hit
 * and call it THE dock), and that a berth is at its own town rather than
 * somewhere out to sea. None of them is enforced by a type.
 *
 * The float tolerance is 1e-9 rather than exact because the polar pair sit
 * exactly ON the BERTH_MAX_ARC limit by construction -- they are placed at a
 * fixed 0.04 rad rather than searched for -- and `acos` of a dot product does
 * not land on 0.04 to the last bit.
 */
const EPS = 1e-9;

function arc(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
}

describe('towns', () => {
  let towns: Towns;
  beforeAll(() => {
    towns = world1337().data.towns;
  }, 30_000);

  it('founds exactly HARBOUR_COUNT harbours on the pinned seed', () => {
    expect(towns.all.length).toBe(HARBOUR_COUNT);
    expect(towns.docks.length).toBe(HARBOUR_COUNT);
  });

  it('gives every town a berth', () => {
    for (const town of towns.all) expect(town.dock).not.toBeNull();
  });

  it('keeps every berth within BERTH_MAX_ARC of its own town', () => {
    for (const town of towns.all) {
      expect(arc(town.dir, town.dock!.dir)).toBeLessThanOrEqual(BERTH_MAX_ARC + EPS);
    }
  });

  /*
   * The no-overlap promise. It used to follow from CLUSTER_MIN_ARC as well --
   * 19 units of spacing around 16 units of ring -- but the spacing relaxed to
   * 15 units for 36 harbours, so the placement loop's own berth test is now
   * the only thing holding it up. That is exactly the kind of invariant that
   * goes quiet when it breaks: two overlapping zones do not throw, they just
   * mean `dockAt` sometimes names the wrong harbour.
   */
  it('never lets two berthing zones touch', () => {
    const docks = towns.docks;
    for (let i = 0; i < docks.length; i++) {
      for (let j = i + 1; j < docks.length; j++) {
        const units = arc(docks[i].dir, docks[j].dir) * GLOBE_RADIUS;
        expect(units).toBeGreaterThan(docks[i].radius + docks[j].radius);
      }
    }
  });

  it('puts index 0 at the north pole and index 1 at the south', () => {
    const north = towns.all.find((t) => t.index === 0)!;
    const south = towns.all.find((t) => t.index === 1)!;
    expect(north).toBeDefined();
    expect(south).toBeDefined();
    expect(arc(north.dir, new Vector3(0, 1, 0))).toBeLessThanOrEqual(POLE_OFFSET_RAD + EPS);
    expect(arc(south.dir, new Vector3(0, -1, 0))).toBeLessThanOrEqual(POLE_OFFSET_RAD + EPS);
    expect(north.name).toBe(HARBOUR_NAMES[0]);
    expect(south.name).toBe(HARBOUR_NAMES[1]);
  });

  /*
   * The polar towns stand on the islet `terrain.ts` forces there, and they
   * have to still be standing on it after `islets.ts` has run: the cull sinks
   * any landmass under MIN_ISLAND_AREA, and a four-unit disc is not obviously
   * over that line. If it ever drops under, the fortress becomes a buoy and
   * nothing else in the project notices.
   */
  it('leaves both polar towns on dry land after the islet cull', () => {
    const { data, terrain } = world1337();
    for (const index of [0, 1]) {
      const town = data.towns.all.find((t) => t.index === index)!;
      expect(data.heightMap.sample(town.dir)).toBeGreaterThan(terrain.seaLevel);
    }
  });

  it('deals every name exactly once and round-trips it through byName', () => {
    const names = towns.all.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of HARBOUR_NAMES) {
      const town = towns.byName(name);
      expect(town, `byName(${name})`).not.toBeNull();
      expect(town!.name).toBe(name);
    }
    expect(towns.byName('Nowhere At All')).toBeNull();
  });

  it('indexes 0..35 with no gaps', () => {
    const indices = towns.all.map((t) => t.index).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: HARBOUR_COUNT }, (_, i) => i));
  });
});
