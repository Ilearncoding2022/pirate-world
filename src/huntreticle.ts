/**
 * huntreticle.ts — the gate, drawn on the water.
 *
 * An annulus sector on the sea ahead of the bow: inner radius
 * `HARPOON_MIN_RANGE`, outer `HARPOON_RANGE`, half-angle `BOW_ARC`. It is the
 * three numbers the gate is made of, turned into a shape the player steers
 * into.
 *
 * ## Why this exists at all
 *
 * The MVP stated those numbers nowhere on the water. `armed` turned on inside
 * a band and inside an arc, and a player who could not see either had no way
 * to learn why the bar was dark — the browser probe's own evidence is a hull
 * that closed to `markOffBow` -88 degrees at zero range with the dial never
 * once arming. A dark bar reads as a broken bar.
 *
 * ## Why it is on every tier
 *
 * This is onboarding, not an effect. A quality tier that dropped it would be a
 * tier on which the feature cannot be learned, which is a different thing from
 * a tier that looks plainer. It costs one static geometry and one material.
 *
 * ## Why a shape on the water and not a ring around the animal
 *
 * A projected ring would make `anchor.ts` load-bearing for GAMEPLAY rather
 * than for HUD polish, and it reads worse at a grazing angle — which is the
 * angle the chase camera spends its whole life at. The gate is a region of
 * water, so it is drawn as one.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  Vector3,
} from 'three';
import type { Object3D, Scene } from 'three';
import type { HuntState, ShipState } from './types';
import type { PostFx } from './postfx';
import { GLOBE_RADIUS } from './geo';
import { BOW_ARC, HARPOON_MIN_RANGE, HARPOON_RANGE } from './leviathan';
import { DISPLACE_AMPLITUDE } from './waveconstants';

/**
 * How far above the sea the sector floats, world units.
 *
 * `leviathanshadows.ts`'s lesson, applied without having to relearn it: the
 * water genuinely displaces by up to `DISPLACE_AMPLITUDE`, so anything laid
 * flatter than that is UNDER the sea in any weather and the depth test
 * discards it. Slightly under the shadows' own clearance so that a surfacing
 * body draws over the reticle rather than through it.
 */
const RETICLE_LIFT = DISPLACE_AMPLITUDE + 0.3;

/** Segments across the arc. Enough that the rim reads as a curve, not a fan. */
const ARC_SEGMENTS = 28;

/**
 * The palette, by gate.
 *
 * Cyan on `ok` is the scope's own colour and is deliberate: an armed gate is an
 * instrument reading laid on the water. Everything else is dimmer, because a
 * gate the player cannot use should not compete with the sea for attention.
 * Red is reserved for `dry`, which is the one failure a player cannot steer
 * out of.
 */
const GATE_COLOURS: Record<string, string> = {
  ok: '#3fe0ff',
  far: '#2c4a5a',
  arc: '#4a6a7a',
  close: '#c8a24a',
  dry: '#d05a4a',
  suppressed: '#2c4a5a',
};

/** Opacity by gate. `ok` is the only one that asserts itself. */
const GATE_ALPHA: Record<string, number> = {
  ok: 0.14,
  far: 0.05,
  arc: 0.08,
  close: 0.1,
  dry: 0.12,
  suppressed: 0.04,
};

/** How much brighter the one-shot pulse on `armed` makes it, and how fast it decays. */
const PULSE_GAIN = 0.18;
const PULSE_DECAY = 2.6;

const _right = new Vector3();
const _astern = new Vector3();
const _basis = new Matrix4();
const _colour = new Color();
const _want = new Color();

export interface HuntReticle {
  update(dt: number, state: HuntState, ship: ShipState): void;
  /** A one-shot brightening, on the `armed` cue. */
  pulse(): void;
  dispose(): void;
}

/**
 * Build the sector once, in a local frame: +X starboard, +Y up, +Z ASTERN.
 *
 * The same basis `aihulls.ts` and `leviathanshadows.ts` use, so the placement
 * below is the identical three lines and cannot disagree with them about which
 * way the bow points. The arc is therefore centred on -Z.
 */
function sectorGeometry(): BufferGeometry {
  const positions: number[] = [];
  const step = (BOW_ARC * 2) / ARC_SEGMENTS;

  for (let i = 0; i < ARC_SEGMENTS; i++) {
    const a0 = -BOW_ARC + i * step;
    const a1 = a0 + step;

    // Forward is -Z, so an angle off the bow sweeps X against -Z.
    const i0x = Math.sin(a0) * HARPOON_MIN_RANGE;
    const i0z = -Math.cos(a0) * HARPOON_MIN_RANGE;
    const i1x = Math.sin(a1) * HARPOON_MIN_RANGE;
    const i1z = -Math.cos(a1) * HARPOON_MIN_RANGE;
    const o0x = Math.sin(a0) * HARPOON_RANGE;
    const o0z = -Math.cos(a0) * HARPOON_RANGE;
    const o1x = Math.sin(a1) * HARPOON_RANGE;
    const o1z = -Math.cos(a1) * HARPOON_RANGE;

    positions.push(i0x, 0, i0z, o0x, 0, o0z, o1x, 0, o1z);
    positions.push(i0x, 0, i0z, o1x, 0, o1z, i1x, 0, i1z);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

/** The rim: the outer edge alone, drawn brighter so the band has a far wall. */
function rimGeometry(): BufferGeometry {
  const positions: number[] = [];
  const step = (BOW_ARC * 2) / ARC_SEGMENTS;
  const inner = HARPOON_RANGE - 0.35;

  for (let i = 0; i < ARC_SEGMENTS; i++) {
    const a0 = -BOW_ARC + i * step;
    const a1 = a0 + step;
    const i0x = Math.sin(a0) * inner;
    const i0z = -Math.cos(a0) * inner;
    const i1x = Math.sin(a1) * inner;
    const i1z = -Math.cos(a1) * inner;
    const o0x = Math.sin(a0) * HARPOON_RANGE;
    const o0z = -Math.cos(a0) * HARPOON_RANGE;
    const o1x = Math.sin(a1) * HARPOON_RANGE;
    const o1z = -Math.cos(a1) * HARPOON_RANGE;
    positions.push(i0x, 0, i0z, o0x, 0, o0z, o1x, 0, o1z);
    positions.push(i0x, 0, i0z, o1x, 0, o1z, i1x, 0, i1z);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

export function createHuntReticle(
  scene: Scene,
  postFx?: Pick<PostFx, 'adopt'>,
): HuntReticle {
  const group = new Group();
  group.name = 'hunt-reticle';
  group.visible = false;
  scene.add(group);

  /*
   * Additive, and `depthWrite` off. The sector is a light laid ON the water
   * rather than a thing floating over it, so it must brighten what is under it
   * rather than replace it — which is also what stops it reading as a decal at
   * the grazing angle the chase camera works at. `depthTest` stays ON, so a
   * headland still occludes the far end of the band.
   */
  const fillMaterial = new MeshBasicMaterial({
    color: GATE_COLOURS.far,
    transparent: true,
    opacity: GATE_ALPHA.far,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  const rimMaterial = new MeshBasicMaterial({
    color: GATE_COLOURS.far,
    transparent: true,
    opacity: GATE_ALPHA.far,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });

  const fill = new Mesh(sectorGeometry(), fillMaterial);
  const rim = new Mesh(rimGeometry(), rimMaterial);
  // Bare meshes written a fresh world matrix every frame from a unit
  // direction, so Three's bounding sphere — computed from geometry at the
  // origin — would cull them by accident. `leviathanshadows.ts` records this.
  fill.frustumCulled = false;
  rim.frustumCulled = false;
  group.add(fill);
  group.add(rim);

  // Before the first frame, so the composer sees both materials in their final
  // form and they carry the sRGB self-encode. Without it they render a stop dark.
  postFx?.adopt(group as unknown as Object3D);

  let pulseAmount = 0;

  return {
    pulse(): void {
      pulseAmount = 1;
    },

    update(dt: number, state: HuntState, ship: ShipState): void {
      /*
       * Shown whenever there is something to shoot at. Not gated on `armed`:
       * the entire point is to be visible while the gate is FAILING, so the
       * player can see the shape they are trying to put the animal inside.
       */
      const live = state.phase === 'drifting' && state.gate !== 'suppressed';
      group.visible = live;
      if (!live) {
        pulseAmount = 0;
        return;
      }

      if (pulseAmount > 0) {
        pulseAmount = Math.max(0, pulseAmount - dt * PULSE_DECAY);
      }

      // The ship's own surface basis, exactly as `aihulls.ts` builds a hull's.
      _right.crossVectors(ship.forward, ship.position);
      if (_right.lengthSq() < 1e-12) return;
      _right.normalize();
      // +X starboard, +Y the surface normal, +Z ASTERN — which is why the
      // third column is the negated bow. The sector geometry is authored in
      // that frame, so the arc lands centred on the bow with no second
      // rotation to compose and get the order of wrong.
      _astern.copy(ship.forward).negate();
      _basis.makeBasis(_right, ship.position, _astern);
      group.quaternion.setFromRotationMatrix(_basis);
      group.position.copy(ship.position).multiplyScalar(GLOBE_RADIUS + RETICLE_LIFT);

      /*
       * The colour IS the gate. One state, one colour, and the dial's hint
       * prints the same word — so the shape on the water and the text in the
       * HUD can never tell the player two different stories.
       */
      const key = state.gate;
      _want.set(GATE_COLOURS[key] ?? GATE_COLOURS.far);
      _colour.copy(fillMaterial.color).lerp(_want, Math.min(1, dt * 8));
      fillMaterial.color.copy(_colour);
      rimMaterial.color.copy(_colour);

      const base = GATE_ALPHA[key] ?? GATE_ALPHA.far;
      const lift = pulseAmount * PULSE_GAIN;
      fillMaterial.opacity = base + lift;
      rimMaterial.opacity = Math.min(1, base * 3 + lift);
    },

    dispose(): void {
      scene.remove(group);
      fill.geometry.dispose();
      rim.geometry.dispose();
      fillMaterial.dispose();
      rimMaterial.dispose();
    },
  };
}
