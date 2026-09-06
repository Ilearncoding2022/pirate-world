import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createReflection, scheduleFaces } from '../../src/reflection';
import { LAYER_REFLECTED } from '../../src/layers';
import { createShipFx } from '../../src/shipfx';
import type { Quality } from '../../src/quality';

/**
 * docs/RENDER_PLAN.md, Phase 1 Stream D. Three things pinned here, per the
 * plan's Definition of done:
 *
 *   1. `scheduleFaces` (reflection.ts) visits every one of the 6 cube faces
 *      exactly once every `6 / facesPerFrame` calls, and never repeats a
 *      face within that cycle -- checked as a pure function, no GPU needed.
 *   2. The layer constant the camera and every reflected object agree on
 *      matches `layers.ts`.
 *   3. `shipfx.ts`'s `glow.level` (the fake hull-neon streak's brightness)
 *      never leaves [0, 1] across the energy range, docked or not.
 */

const STUB_QUALITY: Quality = {
  tier: 'high',
  pixelRatioCap: 2,
  waveChop: true,
  bloomMaxWidth: 1280,
  wakeMapSize: 512,
  patchSegments: 160,
  reflectionSize: 256,
  reflectionFacesPerFrame: 2,
};

describe('scheduleFaces', () => {
  it('renders nothing when facesPerFrame is 0 -- the `?quality=low` path', () => {
    expect(scheduleFaces(0, 0)).toEqual([]);
    expect(scheduleFaces(4, 0)).toEqual([]);
  });

  it('visits all six faces once every 6 calls at facesPerFrame=1, never repeating within the cycle', () => {
    let counter = 0;
    const seen: number[] = [];
    for (let frame = 0; frame < 6; frame++) {
      const faces = scheduleFaces(counter, 1);
      expect(faces.length).toBe(1);
      seen.push(...faces);
      counter = (counter + faces.length) % 6;
    }
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('visits all six faces once every 3 calls at facesPerFrame=2, never repeating within the cycle', () => {
    let counter = 0;
    const seen: number[] = [];
    for (let frame = 0; frame < 3; frame++) {
      const faces = scheduleFaces(counter, 2);
      expect(faces.length).toBe(2);
      seen.push(...faces);
      counter = (counter + faces.length) % 6;
    }
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps a clean cycle across repeated rounds, at both tiers', () => {
    for (const facesPerFrame of [1, 2]) {
      let counter = 0;
      for (let cycle = 0; cycle < 4; cycle++) {
        const seen: number[] = [];
        const callsPerCycle = 6 / facesPerFrame;
        for (let frame = 0; frame < callsPerCycle; frame++) {
          const faces = scheduleFaces(counter, facesPerFrame);
          seen.push(...faces);
          counter = (counter + faces.length) % 6;
        }
        expect(new Set(seen).size).toBe(6);
      }
    }
  });
});

describe('createReflection', () => {
  it('is entirely absent when quality.reflectionSize is 0: no target, and update() is a safe no-op', () => {
    const reflection = createReflection({ ...STUB_QUALITY, reflectionSize: 0, reflectionFacesPerFrame: 0 });
    expect(reflection.texture).toBeNull();
    expect(() =>
      reflection.update(
        1 / 60,
        new THREE.Vector3(0, 1, 0),
        {} as THREE.WebGLRenderer,
        {} as THREE.Scene,
      ),
    ).not.toThrow();
  });

  it('allocates a cube texture when enabled', () => {
    const reflection = createReflection({ ...STUB_QUALITY, reflectionSize: 128, reflectionFacesPerFrame: 1 });
    expect(reflection.texture).toBeInstanceOf(THREE.CubeTexture);
  });
});

describe('layer constants', () => {
  it('LAYER_REFLECTED is the constant docs/RENDER_PLAN.md fixes for every stream', () => {
    // reflection.ts, docks.ts, citylights.ts, sky.ts and clouds.ts all import
    // this constant directly rather than defining their own copy, so there
    // is nothing here for a second definition to drift out of sync with --
    // this pins the one shared value itself.
    expect(LAYER_REFLECTED).toBe(1);
  });
});

describe('shipfx glow (the fake hull-neon streak driver)', () => {
  it('stays in [0, 1] across the whole energy range, including the dock-flare transient', () => {
    const fx = createShipFx(new THREE.Group(), 1);
    const dt = 1 / 60;
    for (let frame = 0; frame < 600; frame++) {
      // Sweeps the whole charge range and repeatedly crosses in and out of a
      // berth, so both CHARGE_FLOOR..1 and the up-to-1.4x DOCK_FLARE
      // multiplier (and its eased transient) are all exercised.
      const level = (Math.sin(frame * 0.037) + 1) / 2;
      const docked = frame % 130 < 40;
      fx.update(dt, 0.5, 1, level, true, docked, 0, 0);
      expect(fx.glow.level).toBeGreaterThanOrEqual(0);
      expect(fx.glow.level).toBeLessThanOrEqual(1);
    }
  });

  it('is a fixed cyan, never the magenta ART-DIRECTION.md 2.4 bans from an in-world object', () => {
    const fx = createShipFx(new THREE.Group(), 1);
    fx.update(1 / 60, 1, 1, 1, true, false, 0, 0);
    expect(`#${fx.glow.color.getHexString()}`).toBe('#59ddff');
  });
});
