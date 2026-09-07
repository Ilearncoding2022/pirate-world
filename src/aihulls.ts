import { Color, Group, Matrix4, Vector3 } from 'three';
import type { Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import type { AiBoat, AiBoatKind, AiBoatState } from './types';
import type { PostFx } from './postfx';
import { GLOBE_RADIUS } from './geo';
import { LAYER_DEFAULT } from './layers';
import { HULL_OFFSET } from './ship';
import { isNeon } from './shipfx';
import { RIM_STRENGTH, installRimGlow } from './rimglow';
import type { RimGlow } from './rimglow';

/**
 * aihulls.ts — the AI boats as things you can see.
 *
 * A pool of at most two hull clones, built lazily from `ship.cloneHull()`,
 * placed on the globe from `aiboats.ts`'s state each frame with their neon
 * recoloured and `rimglow.ts` installed in the boat's colour. Scene objects
 * only: it decides nothing and moves nothing of its own, the same division
 * `hazards.ts` and `waterhazard.ts` keep.
 *
 * A slot is bound to a BOAT, not to a colour, and its colour is written from
 * `boat.kind` every frame it changes. That is what makes the conversion the
 * owner asked for legible -- a red boat whose pursuit clock runs out turns
 * orange where it stands and sails on -- and it is also the only arrangement
 * that survives the one frame where both live boats are orange, which is
 * exactly what a conversion beside a live orange boat produces.
 *
 * `shipfx.ts` is deliberately NOT run on a clone: the raider's lamps do not
 * pulse and its sail does not answer its own speed. Both are invisible at the
 * ranges a raider is seen from and are listed under "Known artefacts,
 * accepted" in docs/BATTLE_PLAN.md.
 */

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/*
 * The two in-world neon swatches, authored LINEAR in exactly the units
 * ART-DIRECTION.md §2.2 lists the ship's own neon in, with the sRGB column
 * beside each so the table can carry both. A `Color` built from three numbers
 * is in Three's working space, which is linear-sRGB, so these tuples reach
 * the shader as written; a hex would have been decoded on the way in and
 * would mean a different colour.
 *
 * Neither is the `--red` / `--orange` the scope draws its arrowheads in.
 * Those are UI chrome (§2.3) and these are lit surfaces that move, bloom and
 * are occluded -- the same separation §2.4 keeps between the HUD's cyan and
 * the hull's, and the reason the two pairs are near neighbours rather than
 * one shared value.
 *
 * Both are pinned red and orange with the blue channel held down at 0.05:
 * enough to keep the darkest part of the rim from going flat black against a
 * night sea, and far too little to drift either hue toward the magenta §2.4
 * forbids on anything in the world.
 */

/** Aggressive. Linear `(1.0, 0.09, 0.05)`, sRGB `#ff553f`. */
export const RED_NEON = new Color(1.0, 0.09, 0.05);

/**
 * A random encounter. Linear `(1.0, 0.34, 0.05)`, sRGB `#ff9e3f`.
 *
 * The green channel is the whole difference between the two, and it is a
 * large step rather than a small one because the pair has to be told apart at
 * a few hundred pixels, through bloom, by a player who is also steering.
 */
export const ORANGE_NEON = new Color(1.0, 0.34, 0.05);

/**
 * Emissive strength every recoloured lamp on a raider is set to, before the
 * envelope fades it.
 *
 * Inside ART-DIRECTION.md §2.2's 2.2-3.5 band, near its middle. One flat
 * strength rather than each lamp's own authored value, because `shipfx.ts`
 * never runs on a clone: without its per-lamp pulse the authored balance is
 * just a static spread of brightnesses, and one value makes the raider read
 * as a single light in one colour, which is the thing the player has to
 * recognise.
 */
const NEON_STRENGTH = 2.8;

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

/**
 * The authored bob, in world units and radians per second.
 *
 * An AI boat does not ride the wave field -- no `sampleWave` tap per boat per
 * frame, no hazard height tap, which is the trade docs/BATTLE_PLAN.md makes
 * and the reason a raider sails through a crest. So it sits at the flat sea
 * radius and breathes on its own, for the same reason `ship.ts` keeps a
 * calm-water residual: a hull holding a dead-fixed height reads as a decal on
 * the sea rather than as a boat on it. Small on purpose, well under the
 * player's own heave, since nothing here is answering the same swell.
 */
const BOB_AMPLITUDE = 0.08;
const BOB_RATE = 1.7;

/**
 * Phase step between pool slots, radians. Half a cycle, so the two raiders
 * that can be on the water at once are never heaving in step -- the giveaway
 * that both are the same authored sine and not two boats.
 */
const BOB_PHASE_STEP = Math.PI;

/**
 * Hulls held in the pool.
 *
 * `AiBoatState.live` is at most one boat of each kind, so two is the whole
 * requirement; a clone is kept and reused rather than rebuilt, since the
 * expensive half of `cloneHull` is cloning a couple of dozen materials and
 * the compile that follows the first draw of each.
 */
const POOL_SIZE = 2;

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

const _right = new Vector3();
const _back = new Vector3();
const _basis = new Matrix4();

export interface AiHulls {
  /** After `ship.update`, before `globe.update`. Places and lights the clones. */
  update(dt: number, state: AiBoatState): void;
  /**
   * The clone standing in for `boat`, for the arena to borrow, or null before
   * the glTF has loaded.
   */
  hullOf(boat: AiBoat): Object3D | null;
}

/** One pooled clone and the handles that light it. */
interface Slot {
  /** Carries the world transform. The clone inside it carries the model's own scale and mount. */
  readonly object: Group;
  /** The recoloured lamps: every material `isNeon` matched, deduplicated by the clone. */
  readonly neon: MeshStandardMaterial[];
  readonly rim: RimGlow;
  /** The boat wearing this hull, or null while it is parked. */
  boat: AiBoat | null;
  /** Colour last written, so a frame that changes nothing writes nothing. */
  kind: AiBoatKind | null;
  /** Fixed for the life of the slot: the bob's phase offset. */
  readonly phase: number;
}

function materialsOf(mesh: Mesh): MeshStandardMaterial[] {
  const held = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const out: MeshStandardMaterial[] = [];
  for (const material of held) {
    if (!material) continue;
    const std = material as MeshStandardMaterial & { isMeshStandardMaterial?: boolean };
    if (std.isMeshStandardMaterial === true) out.push(std);
  }
  return out;
}

/**
 * @param scene the world scene. One group is added to it at construction and
 *   never removed; the clones inside it come and go by `visible`.
 * @param cloneHull `() => ship.cloneHull()`, called at most twice for the
 *   whole run. Null until the glTF hull has landed, which is simply a run
 *   where no raider is drawn -- there is no stand-in for one.
 * @param postFx optional, and only for `adopt`. A clone is built long after
 *   the composer's one-time walk of the scene, so without this its materials
 *   carry no sRGB self-encode and the whole boat renders a stop dark. Optional
 *   rather than required so a test, or a caller that has not built the
 *   composer yet, can still construct this module -- see **Post-processing**
 *   in docs/ARCHITECTURE.md for what is actually being handed over.
 */
export function createAiHulls(
  scene: Scene,
  cloneHull: () => Object3D | null,
  postFx?: Pick<PostFx, 'adopt'>,
): AiHulls {
  const group = new Group();
  group.name = 'ai-hulls';
  scene.add(group);

  const slots: Slot[] = [];
  let elapsed = 0;

  function build(): Slot | null {
    const model = cloneHull();
    if (model === null) return null;

    const object = new Group();
    object.name = `ai-boat-${slots.length}`;
    object.add(model);

    const neon: MeshStandardMaterial[] = [];
    const seen = new Set<MeshStandardMaterial>();
    model.traverse((node) => {
      const mesh = node as Mesh;
      if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
      if (mesh.name.startsWith('thruster_flame')) {
        // An AI boat is not driven: nothing in `aiboats.ts` has a throttle,
        // and two flames burning at whatever strength the clone inherited
        // would be the one part of the raider claiming to be under power.
        mesh.visible = false;
        return;
      }
      for (const material of materialsOf(mesh)) {
        if (seen.has(material)) continue;
        seen.add(material);
        // The sail's circuitry and the flag carry their glow in a texture, so
        // `isNeon` -- flat emissive, no emissive map, the same test that finds
        // the player's lamps -- passes them over and they keep their authored
        // look. Only the lamps change colour.
        if (isNeon(material)) neon.push(material);
      }
    });

    // Before `adopt`, and the order is the rule, not a preference: see the
    // module docstring in `rimglow.ts` and **Post-processing** in
    // docs/ARCHITECTURE.md. Nothing else may adopt this clone.
    //
    // The colour handed over is a placeholder. `recolour` writes the boat's
    // own on the first frame the slot is used and again on every conversion;
    // what matters here is only that the patch goes on these materials before
    // anything else touches them.
    const rim = installRimGlow(model, RED_NEON);
    postFx?.adopt(object);

    // LAYER_DEFAULT only, so the reflection cube never gathers a raider --
    // the same rule that keeps the player's own hull out of it. Set on the
    // whole subtree rather than the root, because `Object3D.layers` is not
    // inherited.
    object.traverse((node) => node.layers.set(LAYER_DEFAULT));

    object.visible = false;
    group.add(object);

    const slot: Slot = {
      object,
      neon,
      rim,
      boat: null,
      kind: null,
      phase: slots.length * BOB_PHASE_STEP,
    };
    slots.push(slot);
    return slot;
  }

  /** The slot already wearing `boat`, or a free one, building it if it can. */
  function claim(boat: AiBoat): Slot | null {
    for (const slot of slots) if (slot.boat === boat) return slot;
    for (const slot of slots) {
      if (slot.boat === null) {
        slot.boat = boat;
        return slot;
      }
    }
    if (slots.length >= POOL_SIZE) return null;
    const built = build();
    if (built === null) return null;
    built.boat = boat;
    return built;
  }

  function recolour(slot: Slot, kind: AiBoatKind): void {
    if (slot.kind === kind) return;
    slot.kind = kind;
    const colour = kind === 'red' ? RED_NEON : ORANGE_NEON;
    for (const material of slot.neon) material.emissive.copy(colour);
    slot.rim.setColor(colour);
  }

  function place(slot: Slot, boat: AiBoat): void {
    // The same basis `ship.ts`'s `applyTransform` builds, and built the same
    // way round: local +X starboard, +Y the surface normal, +Z astern. The
    // boat's own `position` is its surface normal, being a unit direction.
    _right.crossVectors(boat.forward, boat.position);
    // Degenerate only if the bow has somehow ended up radial, which
    // `aiboats.ts`'s transport does not allow. Leaving the hull on last
    // frame's orientation beats writing a NaN quaternion into the scene.
    if (_right.lengthSq() < 1e-12) return;
    _right.normalize();
    _back.copy(boat.forward).negate();
    _basis.makeBasis(_right, boat.position, _back);
    slot.object.quaternion.setFromRotationMatrix(_basis);

    const bob = BOB_AMPLITUDE * Math.sin(elapsed * BOB_RATE + slot.phase);
    // HULL_OFFSET is the player's own mounting height above the sea, exported
    // from `ship.ts` for exactly this: a clone dropped at the same radius,
    // carrying the same MODEL_MOUNT_Y inside it, floats at the same waterline.
    slot.object.position.copy(boat.position).multiplyScalar(GLOBE_RADIUS + HULL_OFFSET + bob);
  }

  return {
    update(dt: number, state: AiBoatState): void {
      elapsed += dt;

      for (const slot of slots) {
        // Rebound below if its boat is still live. A slot whose boat has been
        // removed is parked here rather than in the loop over `live`, which
        // never visits it again.
        if (slot.boat !== null && !state.live.includes(slot.boat)) {
          slot.boat = null;
          slot.object.visible = false;
        }
      }

      for (const boat of state.live) {
        const slot = claim(boat);
        if (slot === null) continue;
        // The arena borrows a clone by reparenting it and hands nothing back:
        // `battlescene.exit()` leaves both hulls where they are, and `main.ts`
        // only moves the player's. So the pool takes its own back the first
        // frame it needs it again, which is the frame after the fade home.
        if (slot.object.parent !== group) group.add(slot.object);
        recolour(slot, boat.kind);
        place(slot, boat);

        // The fade `aiboats.ts` runs on spawn and on the last second of a
        // wander, spent on both lights at once so a boat arrives and leaves as
        // a light coming up and going down. The hull itself does not fade;
        // in daylight at close range it simply stops being there, which is
        // listed under the accepted artefacts.
        const envelope = Math.min(1, Math.max(0, boat.envelope));
        for (const material of slot.neon) material.emissiveIntensity = NEON_STRENGTH * envelope;
        slot.rim.setStrength(RIM_STRENGTH * envelope);
        slot.object.visible = true;
      }
    },

    hullOf(boat: AiBoat): Object3D | null {
      const slot = claim(boat);
      if (slot === null) return null;
      // A contact normally happens to a boat that has been on the water for
      // seconds, so this hull is already built, coloured and lit. The three
      // writes here cost a comparison each and cover the one case it is not:
      // a boat forced onto the hull by `?battle=1`, which fights on the frame
      // it appears and would otherwise be handed to the arena invisible and
      // half faded in. Nothing fades in the arena -- `update` is not called
      // in there -- so the raider goes in at full strength either way.
      recolour(slot, boat.kind);
      for (const material of slot.neon) material.emissiveIntensity = NEON_STRENGTH;
      slot.rim.setStrength(RIM_STRENGTH);
      slot.object.visible = true;
      return slot.object;
    },
  };
}
