import { Color, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three';
import type { MeshStandardMaterial, Object3D, Scene } from 'three';
import type { DerelictState } from './types';
import type { PostFx } from './postfx';
import { GLOBE_RADIUS, tangentFrame } from './geo';
import { LAYER_DEFAULT } from './layers';
import { HULL_OFFSET } from './ship';
import { isNeon } from './shipfx';
import { installRimGlow } from './rimglow';
import type { RimGlow } from './rimglow';
import { HOOK_RADIUS } from './derelict';

/**
 * derelicthull.ts — the dead hull as something you can see, and the ring you
 * hook it from.
 *
 * One lazily-built clone of `ship.cloneHull()` and one ring on the water,
 * placed from `derelict.ts`'s state each frame. Scene objects only, the
 * division `aiboats.ts`/`aihulls.ts` keeps.
 *
 * `aihulls.ts` is the model and this is its opposite number in every visible
 * respect, which is the whole point: a raider is a lit hull coming at you and a
 * derelict is an unlit one that has stopped.
 *
 *   - **The neon is dead, not recoloured.** A raider's lamps are written to one
 *     of two hot swatches at `NEON_STRENGTH`; these are written to a cold grey
 *     at an emissive intensity of zero. Nothing on this boat is under power.
 *   - **The planking is darkened.** Every standard material on the clone has
 *     its colour multiplied down, so the hull reads as a silhouette in daylight
 *     rather than as the player's own bright boat parked in the water.
 *   - **The rim glow is kept, and kept faint.** This is the one borrowing from
 *     the raider, and without it the thing is unfindable: an unlit dark hull on
 *     dark water at forty units is nothing at all, and a derelict that the
 *     player sails past because they could not see it is a once-an-hour event
 *     wasted. A tenth of a raider's strength, in grey, is enough to say
 *     "something is out there" without ever being mistaken for a boat under
 *     way.
 *
 * The ring is this module's own, and deliberately NOT `docks.ts`'s. A berth
 * never moves, so its rings are baked into one buffer geometry at world build
 * time; a derelict drifts, so its ring is one small mesh moved every frame.
 */

/** The dead lamp colour. Cold grey, and only ever seen as a colour if something re-lights it. */
const DEAD_NEON = new Color(0.18, 0.2, 0.22);

/**
 * What the planking is multiplied by.
 *
 * A third. Enough that the hull is clearly not the player's own boat at any
 * range, not so much that it becomes a black cut-out with no shape in it —
 * which is what a flat near-zero produced: the silhouette read as a hole in the
 * sea rather than as a wreck.
 */
const HULL_DARKEN = 0.34;

/**
 * The rim glow's strength on a derelict.
 *
 * `rimglow.ts`'s `RIM_STRENGTH` is 0.55 for a raider. A tenth of that is a hull
 * that resolves out of the dark at the range the scope has already put a mark
 * at, and disappears against a bright noon sea — which is the right way round:
 * at noon there is enough light to see a dark hull by.
 */
const RIM_STRENGTH_DERELICT = 0.055;

/** Segments around the hook ring. Smooth at the size it is read from — a few units across. */
const RING_SEGMENTS = 48;

/** The ring's colour, and how far it opens up when the hook is actually on offer. */
const RING_COLOR = new Color(0.62, 0.66, 0.7);
const RING_ALPHA_NEAR = 0.42;
const RING_ALPHA_FAR = 0.16;

/**
 * Lift of the ring above the water sphere, world units.
 *
 * `docks.ts` uses 0.05 for the same job and for the same two reasons: the sea
 * is a full sphere at exactly `GLOBE_RADIUS` so a ring drawn at that radius
 * z-fights it across its whole face, and the water mesh's own faceting sags a
 * few hundredths of a unit below the true surface between vertices.
 */
const RING_LIFT = 0.05;

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

const _right = new Vector3();
const _back = new Vector3();
const _north = new Vector3();
const _east = new Vector3();
const _basis = new Matrix4();

export interface DerelictHull {
  /** After `ship.update`, beside `aiHulls.update`. Places and lights the clone. */
  update(dt: number, state: DerelictState): void;
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
 * @param scene the world scene. One group is added at construction and never
 *   removed; the hull inside it comes and goes by `visible`.
 * @param cloneHull `() => ship.cloneHull()`, called at most ONCE for the whole
 *   run. Null until the glTF has landed, which is simply a run with no derelict
 *   drawn in it — there is no stand-in.
 * @param postFx optional, and for `adopt` only, on `aihulls.ts`'s own terms: a
 *   clone built after the composer's one-time walk carries no sRGB self-encode
 *   and renders a stop dark without it.
 */
export function createDerelictHull(
  scene: Scene,
  cloneHull: () => Object3D | null,
  postFx?: Pick<PostFx, 'adopt'>,
): DerelictHull {
  const group = new Group();
  group.name = 'derelict';
  scene.add(group);

  // The ring is built now, because it needs nothing from the glTF. The hull is
  // built on the first frame a derelict actually exists, which for most runs is
  // never: `cloneHull` is the expensive call in this module.
  const ring = new Mesh(
    new RingGeometry(HOOK_RADIUS * 0.82, HOOK_RADIUS, RING_SEGMENTS),
    new MeshBasicMaterial({
      color: RING_COLOR,
      transparent: true,
      opacity: RING_ALPHA_FAR,
      // Depth-tested so a wave in front of it covers it, and not depth-written
      // so it cannot punch a hole in the sea behind it -- `battlescene.ts`'s
      // rule for every flat transparent thing lying on the water.
      depthWrite: false,
      side: DoubleSide,
    }),
  );
  ring.name = 'derelict-ring';
  ring.visible = false;
  group.add(ring);
  group.traverse((node) => node.layers.set(LAYER_DEFAULT));
  postFx?.adopt(group);

  let hull: Group | null = null;
  let rim: RimGlow | null = null;
  let built = false;

  function build(): void {
    built = true;
    const model = cloneHull();
    if (model === null) return;

    const object = new Group();
    object.name = 'derelict-hull';
    object.add(model);

    const seen = new Set<MeshStandardMaterial>();
    model.traverse((node) => {
      const mesh = node as Mesh;
      if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
      if (mesh.name.startsWith('thruster_flame')) {
        // Nothing on a dead hull is burning. `aihulls.ts` hides these because a
        // raider has no throttle; here it is the fiction itself.
        mesh.visible = false;
        return;
      }
      for (const material of materialsOf(mesh)) {
        if (seen.has(material)) continue;
        seen.add(material);
        if (isNeon(material)) {
          // Out, not recoloured: the emissive is zeroed so the lamp contributes
          // no light at all, and its colour set to the dead grey so anything
          // that later reads it gets a cold answer rather than the raider red
          // the clone was handed.
          material.emissive.copy(DEAD_NEON);
          material.emissiveIntensity = 0;
        }
        material.color.multiplyScalar(HULL_DARKEN);
      }
    });

    // Before `adopt`, and the order is the rule rather than a preference — see
    // `rimglow.ts` and **Post-processing** in docs/ARCHITECTURE.md.
    rim = installRimGlow(model, RING_COLOR);
    postFx?.adopt(object);
    object.traverse((node) => node.layers.set(LAYER_DEFAULT));
    object.visible = false;
    group.add(object);
    hull = object;
  }

  return {
    update(_dt: number, state: DerelictState): void {
      const derelict = state.live;
      if (derelict === null) {
        if (hull !== null) hull.visible = false;
        ring.visible = false;
        return;
      }

      if (!built) build();
      const envelope = Math.max(0, Math.min(1, derelict.envelope));

      if (hull !== null) {
        // The basis `aihulls.ts`'s `place` builds, for the same reason: local
        // +X starboard, +Y the surface normal, +Z astern.
        _right.crossVectors(derelict.forward, derelict.position);
        if (_right.lengthSq() > 1e-12) {
          _right.normalize();
          _back.copy(derelict.forward).negate();
          _basis.makeBasis(_right, derelict.position, _back);
          hull.quaternion.setFromRotationMatrix(_basis);
        }
        // No bob. A raider breathes because it is a boat under way on a sea it
        // does not otherwise answer; a dead hull sitting still is the one thing
        // out here that should look inert.
        hull.position.copy(derelict.position).multiplyScalar(GLOBE_RADIUS + HULL_OFFSET);
        rim?.setStrength(RIM_STRENGTH_DERELICT * envelope);
        hull.visible = true;
      }

      // The ring goes down the moment the line is on: it is an offer, and an
      // offer that has been taken is not an offer.
      if (derelict.towed) {
        ring.visible = false;
        return;
      }

      tangentFrame(derelict.position, _north, _east);
      // `RingGeometry` is authored in its own XY plane, so the basis is built
      // with the surface normal as the ring's local +Z rather than its +Y --
      // which is the one place in this project a mesh is NOT laid out the way
      // the hull basis lays one out.
      _basis.makeBasis(_east, _north, derelict.position);
      ring.quaternion.setFromRotationMatrix(_basis);
      ring.position.copy(derelict.position).multiplyScalar(GLOBE_RADIUS + RING_LIFT);
      // Brighter the moment the offer is actually live, which is the only
      // feedback the water itself gives that a press would do something.
      const material = ring.material as MeshBasicMaterial;
      material.opacity = (state.hookReady ? RING_ALPHA_NEAR : RING_ALPHA_FAR) * envelope;
      ring.visible = true;
    },
  };
}
