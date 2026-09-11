import { Group, Matrix4, Vector3 } from 'three';
import type { Scene } from 'three';
import type { SalvageRaft, SalvageState } from './types';
import type { PostFx } from './postfx';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { LAYER_DEFAULT } from './layers';
import { RAFT_NOMINAL_R, buildRaft } from './raftmesh';
import { LIVE_MAX } from './salvage';

/**
 * salvagerafts.ts — the salvage as something you can see.
 *
 * A fixed pool of `LIVE_MAX` rafts from `raftmesh.ts`, placed on the globe from
 * `salvage.ts`'s state each frame. Scene objects only: it decides nothing and
 * moves nothing of its own, the division `hazards.ts`/`waterhazard.ts` and
 * `aiboats.ts`/`aihulls.ts` both keep.
 *
 * `aihulls.ts` is the model, with its two per-slot tricks kept and its pooling
 * simplified. A raft has no bow, no lights and no colour to write, so a slot is
 * bound to a raft by INDEX rather than claimed by identity: there are at most
 * three, they are interchangeable, and the only thing a player could notice is
 * the silhouette, which each slot varies for itself.
 *
 * Three differences from a raider worth naming, because each is deliberate:
 *
 *   - **The fade is on the SCALE, not on a light.** A raider fades its neon up
 *     and a raft has none, so `salvage.ts`'s envelope is spent growing the pile
 *     out of the water. It reads as timber rolling up on the swell rather than
 *     as a pile switching on, and it is the one fade available to an unlit
 *     object in daylight.
 *   - **The bob is per slot and out of step**, on `aihulls.ts`'s own amplitude
 *     and rate, so three rafts in one bay are not three copies of one sine.
 *   - **No `rimglow.ts`.** A raider is lit because a player has to recognise
 *     which colour is coming at sixty units. A raft is a reward for looking at
 *     the scope and then at the water; a glowing pile of wreckage would make
 *     the scope pointless and would also be the brightest thing in a fog bank.
 */

/**
 * The authored bob, in world units and radians per second.
 *
 * `aihulls.ts`'s figures, and deliberately the same: a raft and a raider are
 * both sitting at the flat sea radius rather than riding the displaced wave
 * field (see docs/BATTLE_PLAN.md for the trade), so they have to breathe at the
 * same rate or one of the two reads as being on a different ocean.
 */
const BOB_AMPLITUDE = 0.08;
const BOB_RATE = 1.7;

/** Phase step between slots, radians. A third of a cycle, for three slots. */
const BOB_PHASE_STEP = (Math.PI * 2) / 3;

/**
 * Lift of a raft's origin above the flat sea radius, world units.
 *
 * **Positive, and it has to be.** The first draft sank the pile a tenth of a
 * unit on the reasoning that timber floats IN the water rather than on it, and
 * the raft was invisible: the sea near the ship is genuinely DISPLACED rather
 * than shaded to look that way (see `water.ts` and docs/RENDER_PLAN.md), so
 * anything at or under the mean radius spends its life inside the surface.
 * `ship.ts` clears the same problem with a `HULL_OFFSET` of 0.6.
 *
 * 0.25 is that figure cut to a raft's scale. `raftmesh.ts`'s boxes carry
 * half-heights of 0.07 to 0.11 above their own origin, so at a quarter of a
 * unit the pile rides with its lower faces about at the mean surface and its
 * top clear of it -- awash, which is what a raft should look like -- and a
 * crest rolling through still washes over it. That last part is the same
 * accepted artefact `aihulls.ts` records for a raider sailing through a wave:
 * nothing out here rides the displaced field but the player's own hull.
 */
const RAFT_LIFT = 0.25;

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

const _north = new Vector3();
const _east = new Vector3();
const _basis = new Matrix4();

export interface SalvageRafts {
  /** After `ship.update`, beside `aiHulls.update`. Places and scales the pool. */
  update(dt: number, state: SalvageState): void;
}

/**
 * @param scene the world scene. One group is added at construction and never
 *   removed; the rafts inside it come and go by `visible`.
 * @param postFx optional, and for the same reason `aihulls.ts` takes it: these
 *   materials are built after the composer's one-time walk of the scene, so
 *   without `adopt` they carry no sRGB self-encode and the timber renders a
 *   stop dark.
 */
export function createSalvageRafts(scene: Scene, postFx?: Pick<PostFx, 'adopt'>): SalvageRafts {
  const group = new Group();
  group.name = 'salvage-rafts';
  scene.add(group);

  /** One pooled raft per slot the sim can fill, built once, shown and hidden. */
  const slots: Group[] = [];
  for (let i = 0; i < LIVE_MAX; i++) {
    // The yaw is per SLOT and fixed, as in the arena, so the three silhouettes
    // differ. `salvage.ts` also rolls a `yaw` per raft, and that one is added
    // on top in `place`: the slot's share keeps two rafts in the same frame
    // apart even in the unlikely case the sim rolled them the same heading.
    const raft = buildRaft(`salvage-raft-${i}`, (i * Math.PI * 2) / LIVE_MAX);
    group.add(raft);
    slots.push(raft);
  }
  // LAYER_DEFAULT only, so the reflection cube never gathers salvage — the rule
  // that keeps the player's own hull and every raider out of it. On the whole
  // subtree, because `Object3D.layers` is not inherited.
  group.traverse((node) => node.layers.set(LAYER_DEFAULT));
  postFx?.adopt(group);

  let elapsed = 0;

  function place(slot: Group, raft: SalvageRaft, phase: number): void {
    // The basis `ship.ts`'s `applyTransform` and `aihulls.ts`'s `place` both
    // build: local +X east, +Y the surface normal, +Z the remaining tangent.
    // A raft has no bow, so any tangent frame at its own centre will do —
    // which is exactly why it carries its own `yaw` to be turned by afterwards.
    tangentFrame(raft.position, _north, _east);
    _basis.makeBasis(_east, raft.position, _north);
    slot.quaternion.setFromRotationMatrix(_basis);
    slot.rotateY(raft.yaw);

    const bob = BOB_AMPLITUDE * Math.sin(elapsed * BOB_RATE + phase);
    slot.position.copy(raft.position).multiplyScalar(GLOBE_RADIUS + RAFT_LIFT + bob);

    // The sim's own radius, times the fade. Growing the whole pile is the fade
    // available to an unlit object; see the file header. Floored well clear of
    // zero so a raft in its first frame is small rather than a degenerate
    // matrix Three would warn about.
    const envelope = Math.max(0.05, Math.min(1, raft.envelope));
    slot.scale.setScalar((raft.radius / RAFT_NOMINAL_R) * envelope);
  }

  return {
    update(dt: number, state: SalvageState): void {
      elapsed += dt;
      for (let i = 0; i < slots.length; i++) {
        const raft = state.live[i];
        if (raft === undefined) {
          slots[i].visible = false;
          continue;
        }
        place(slots[i], raft, i * BOB_PHASE_STEP);
        slots[i].visible = true;
      }
    },
  };
}
