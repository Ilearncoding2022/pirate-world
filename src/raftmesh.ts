import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

/**
 * raftmesh.ts — one pile of lost timber, drawn the same way in both seas.
 *
 * The arena has floated rafts of flotsam since the battle rework
 * (`battlesea.ts` owns their sim, `battlescene.ts` drew them), and the open
 * ocean now floats salvage on the same model (`salvage.ts` and
 * `salvagerafts.ts`). They are the same object in the fiction — timber off a
 * hull that did not make it — so they are one table of boxes here rather than
 * two tables that would drift apart on the first retune.
 *
 * Lifted out of `battlescene.ts` unchanged: the four pieces, the radius they
 * are authored against and the colour are the numbers that shipped in the
 * arena, and `buildRaft` is the loop that was already there. Nothing about the
 * look of an arena raft changes by moving it.
 *
 * **Units are deliberately unnamed.** The arena works in flat metres on a
 * tangent plane and the world works in world units on the globe, and they are
 * the same size — a 3-unit hull either side — so a raft authored once reads
 * correctly in both. What a caller must supply is the SCALE: a raft's own
 * rolled radius over `RAFT_NOMINAL_R`, which is what `buildRaft`'s own
 * `radius` argument does.
 *
 * Geometry and material are shared across every raft this module builds, in
 * both seas, because a box is a box and a hundred of them have no business
 * being a hundred uploads. That is also why neither is disposed: they live as
 * long as the page.
 */

/** Dark weathered-wood colour for a raft's debris: lost timber, and nothing else is made of it. */
export const RAFT_COLOR = '#181410';

/**
 * The radius `RAFT_PIECES` is authored against.
 *
 * The arena's rafts used to be one size -- `battlesea.ts`'s old flat
 * `FLOTSAM_RADIUS` of 1.2 -- and the pile was drawn to fit it. Now every raft
 * rolls its own radius, so the group is scaled by `radius / RAFT_NOMINAL_R`
 * and the pieces keep the proportions they were drawn with. It describes THIS
 * pile of boxes and not any sim's range: change the boxes and this moves;
 * change a range and it does not.
 */
export const RAFT_NOMINAL_R = 1.2;

/**
 * The raft's own small cluster of debris, one box per entry: its offset from
 * the raft's centre and height above the water, its half-extents, and a fixed
 * tilt and heading baked in at construction so no two pieces read as the same
 * crate. Four pieces, kept within a unit or so of the centre -- inside
 * `RAFT_NOMINAL_R`, the radius they are drawn against -- so the pile never
 * reads bigger than the thing it actually is.
 */
export const RAFT_PIECES: ReadonlyArray<{
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly tilt: number;
  readonly yaw: number;
}> = [
  { x: 0, z: 0.05, y: 0.08, w: 0.7, h: 0.22, d: 0.5, tilt: 0.08, yaw: 0.3 },
  { x: 0.55, z: 0.3, y: 0.05, w: 0.4, h: 0.16, d: 0.9, tilt: -0.15, yaw: 1.1 },
  { x: -0.5, z: 0.35, y: 0.1, w: 0.5, h: 0.18, d: 0.35, tilt: 0.22, yaw: -0.6 },
  { x: -0.15, z: -0.55, y: 0.04, w: 0.35, h: 0.14, d: 0.6, tilt: -0.1, yaw: 2.0 },
];

/**
 * The one box geometry and the one material every raft in the game shares.
 *
 * Built lazily rather than at module load so that importing this file costs
 * nothing in a Node unit test, which has no WebGL context to upload to. Three
 * does not allocate GPU memory until a draw, so this is about import order and
 * not about bytes.
 */
let geometry: BoxGeometry | null = null;
let material: MeshStandardMaterial | null = null;

/**
 * One raft, as a `Group` at the origin with `RAFT_PIECES` inside it.
 *
 * @param name   the object's name, for the scene graph and the inspector.
 * @param yaw    a fixed heading baked in at construction. The sims have no
 *   bearing for a raft -- a floating pile of timber has no bow -- so this
 *   exists only so that several rafts on the water are not several copies of
 *   one silhouette.
 * @param radius the raft's own radius, applied as the group's uniform scale
 *   against `RAFT_NOMINAL_R`. A caller whose rafts all roll their own radius
 *   per frame should leave this and write `scale` itself.
 *
 * The group arrives `visible = false`, because every caller so far is a pool
 * that shows a slot when the sim fills it.
 */
export function buildRaft(name: string, yaw: number, radius = RAFT_NOMINAL_R): Group {
  if (geometry === null) geometry = new BoxGeometry(1, 1, 1);
  if (material === null) {
    material = new MeshStandardMaterial({ color: RAFT_COLOR, roughness: 0.85, metalness: 0 });
  }

  const raft = new Group();
  raft.name = name;
  raft.visible = false;
  raft.rotation.y = yaw;
  raft.scale.setScalar(radius / RAFT_NOMINAL_R);
  for (const piece of RAFT_PIECES) {
    const box = new Mesh(geometry, material);
    box.scale.set(piece.w, piece.h, piece.d);
    box.position.set(piece.x, piece.y, piece.z);
    box.rotation.set(piece.tilt, piece.yaw, 0);
    raft.add(box);
  }
  return raft;
}
