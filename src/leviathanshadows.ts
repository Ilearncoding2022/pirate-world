import { CanvasTexture, Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import type { Object3D, Scene } from 'three';
import type { HuntState, Shadow } from './types';
import type { PostFx } from './postfx';
import { GLOBE_RADIUS } from './geo';
import { SHOAL_COUNT } from './leviathan';

/**
 * leviathanshadows.ts: the shoal as things you can see.
 *
 * A pool of `SHOAL_COUNT` flat planes in one `Group`, placed on the globe from
 * `leviathan.ts`'s state each frame. Scene objects only: it decides nothing
 * and moves nothing of its own, the same division `aiboats.ts` and
 * `aihulls.ts` keep, and the same division `hazards.ts` keeps with
 * `waterhazard.ts`.
 *
 * ## Why a sprite and not a mesh
 *
 * This is the MVP's whole economy. docs/LEVIATHAN_PLAN.md defers the ironwhale
 * itself to Phase 2 precisely because a world-scale animal is glTF work, a
 * rig, and an art pass, and none of that is needed to answer the only question
 * the MVP exists to answer: does steering to hold a drifting target in the bow
 * arc feel like anything. A dark blob on the water answers it for the price of
 * one `PlaneGeometry` and two procedurally generated textures.
 *
 * ## The honest artefact
 *
 * A translucent dark plane sitting slightly ABOVE the water is an
 * approximation of a shape below it, and at the chase camera's grazing angle
 * it can read as a texture artefact rather than as an animal. That is a known,
 * accepted limitation of this phase and not a bug to be tuned away by dropping
 * the opacity until a screenshot passes. The real fix is a darkening term
 * inside the water shader through the plugin contract `waterhazard.ts` already
 * uses (docs/ARCHITECTURE.md, "The water plugin contract"), which reads as
 * genuinely under the surface; it is staged as Phase 2 in the plan.
 *
 * ## No asset file
 *
 * Both textures are drawn into a small 2D canvas at construction, which is the
 * project's ethos (everything but the hull is generated at runtime) and is
 * also why this module costs nothing to ship.
 */

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

/**
 * A shadow's footprint on the water, world units, along its own heading and
 * across it.
 *
 * A little over a hull length long and about half as wide. Big enough to read
 * as an animal at the range the dial arms at (`HARPOON_RANGE`, 12 units) and
 * small enough that fourteen of them inside `SHOAL_RADIUS` are a shoal rather
 * than a slick.
 */
const SHADOW_LENGTH = 4.2;
const SHADOW_WIDTH = 1.7;

/** How much larger the marked one is drawn. The ring does most of the work; this seconds it. */
const MARKED_SCALE = 1.25;

/**
 * How far above the sea a shadow floats, world units.
 *
 * Z-fighting clearance and nothing else. The globe's water is a smooth sphere
 * at `GLOBE_RADIUS` and a plane written at exactly that radius flickers
 * against it; five hundredths of a unit is far below anything visible at this
 * scale and far above the depth buffer's resolution out here.
 */
const SHADOW_LIFT = 0.05;

/**
 * The authored drift, world units and radians per second.
 *
 * A shadow does not ride the wave field, for `aihulls.ts`'s reason and more
 * so: fourteen `sampleWave` taps a frame to move a blob a few hundredths of a
 * unit would be the most expensive thing in this feature. Instead each one
 * breathes on its own, so the shoal shimmers rather than sitting on the sea
 * like a decal. Smaller than the raiders' bob, since a shadow is nominally
 * under the surface and should not appear to heave at all.
 */
const DRIFT_AMPLITUDE = 0.03;
const DRIFT_RATE = 1.1;

/** Phase step between pool slots, radians. Irrational-ish, so no two slots pulse in step. */
const DRIFT_PHASE_STEP = 0.7;

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/**
 * The texture is authored in sRGB bytes on a canvas and its colour is carried
 * by the material's `opacity` rather than by a tint, so there is one number to
 * move when the shoal reads too strong or too faint.
 *
 * `ART-DIRECTION.md` §2.4 keeps the world's lit surfaces off the HUD's cyan;
 * a shadow is neither, being an absence of light rather than a source of one,
 * so the body is pure darkness and only the MARK carries a colour. That colour
 * is the scope's cyan deliberately: the mark is an instrument reading laid on
 * the water, which is what it is.
 */
const BODY_ALPHA = 0.55;
const MARK_ALPHA = 0.8;
const MARK_RING = 'rgba(63, 224, 255, 0.95)';

/** Pixels on a side of each generated texture. Two of them, built once. */
const TEXTURE_SIZE = 128;

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

const _right = new Vector3();
const _back = new Vector3();
const _basis = new Matrix4();

export interface ShadowField {
  /** After `ship.update`, before `globe.update`. Places the sprites. */
  update(dt: number, state: HuntState): void;
  /**
   * How many planes were left visible by the last `update`.
   *
   * Published on the debug hook, and it exists to answer one question that
   * nothing else can: when a shoal is on the water and the sea looks empty,
   * is the shoal not being DRAWN, or is it being drawn and not being SEEN?
   * Those have completely different fixes -- a wiring bug against a legibility
   * problem -- and from a screenshot they are identical.
   */
  readonly visible: number;
  /** Drops the geometry, both textures and both materials. */
  dispose(): void;
}

/**
 * One blob, as a canvas texture.
 *
 * @param ring when true, a bright annulus is stroked at the rim: the mark.
 *   Drawn as a ring rather than as a fill so the marked shadow is still a
 *   shadow, which matters because the player has to read its HEADING to lead
 *   it and a solid mark would hide the shape they are reading.
 */
function blobTexture(ring: boolean): CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  const half = TEXTURE_SIZE / 2;
  ctx.clearRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // Soft-edged, and soft over most of its radius rather than only at the rim:
  // a hard-edged ellipse on open water reads as a decal, which is the exact
  // failure this whole approach is exposed to.
  const fill = ctx.createRadialGradient(half, half, 0, half, half, half);
  fill.addColorStop(0, 'rgba(2, 8, 14, 1)');
  fill.addColorStop(0.45, 'rgba(3, 12, 22, 0.82)');
  fill.addColorStop(0.78, 'rgba(4, 16, 28, 0.28)');
  fill.addColorStop(1, 'rgba(4, 16, 28, 0)');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.fill();

  if (ring) {
    ctx.strokeStyle = MARK_RING;
    ctx.lineWidth = TEXTURE_SIZE * 0.045;
    ctx.beginPath();
    ctx.arc(half, half, half * 0.72, 0, Math.PI * 2);
    ctx.stroke();
  }

  const texture = new CanvasTexture(canvas);
  // Nothing samples this outside [0,1] and nothing tiles it, so the default
  // wrap is already right; what does matter is that it is NOT colour-managed
  // into the working space twice. `CanvasTexture` defaults to no colour space
  // conversion for a 2D canvas, which is what is wanted: these bytes are the
  // picture, not a material parameter.
  texture.needsUpdate = true;
  return texture;
}

/**
 * @param scene the world scene. One group is added at construction and never
 *   removed; the planes inside it come and go by `visible`.
 * @param postFx optional, and only for `adopt`. Both materials are built after
 *   the composer's one-time walk of the scene, so without this they carry no
 *   sRGB self-encode and the whole shoal renders a stop dark: the identical
 *   call `aihulls.ts` makes for a raider's recoloured neon. Optional so a test
 *   or a caller with no composer can still construct this.
 */
export function createShadowField(scene: Scene, postFx?: Pick<PostFx, 'adopt'>): ShadowField {
  const group = new Group();
  group.name = 'leviathan-shadows';
  scene.add(group);

  /*
   * One geometry for every slot, rotated flat ONCE at construction.
   *
   * A `PlaneGeometry` is authored in XY facing +Z, and these lie on the sea
   * facing the sky. Baking the quarter turn into the geometry rather than into
   * each mesh's quaternion is what lets `place` write the surface basis
   * straight in, exactly as `aihulls.ts` writes the hull's, with no second
   * rotation to compose and get the order of wrong.
   */
  const geometry = new PlaneGeometry(SHADOW_WIDTH, SHADOW_LENGTH);
  geometry.rotateX(-Math.PI / 2);

  const bodyTexture = blobTexture(false);
  const markTexture = blobTexture(true);

  /*
   * `depthWrite: false` because these are transparent and overlapping: two
   * shadows crossing must blend rather than have the nearer one punch a hole
   * in the further one. `depthTest` stays ON so land still occludes them.
   */
  const bodyMaterial = new MeshBasicMaterial({
    map: bodyTexture,
    transparent: true,
    depthWrite: false,
    opacity: BODY_ALPHA,
  });
  const markMaterial = new MeshBasicMaterial({
    map: markTexture,
    transparent: true,
    depthWrite: false,
    opacity: MARK_ALPHA,
  });

  const slots: Mesh[] = [];
  for (let i = 0; i < SHOAL_COUNT; i++) {
    const mesh = new Mesh(geometry, bodyMaterial);
    mesh.name = `leviathan-shadow-${i}`;
    mesh.visible = false;
    /*
     * Off the frustum cull.
     *
     * Every slot is written a fresh world matrix each frame from a unit
     * direction, and Three culls against a bounding sphere it computed from
     * the geometry at the ORIGIN. Left on, a plane four units across sitting
     * 200 units out is culled or not by accident. `aihulls.ts` does not need
     * this because a Group carries its children's bounds; a bare Mesh does not.
     */
    mesh.frustumCulled = false;
    group.add(mesh);
    slots.push(mesh);
  }

  // Before adopting, so the composer sees both materials in their final form.
  // The ordering **Post-processing** in docs/ARCHITECTURE.md exists to protect.
  postFx?.adopt(group as unknown as Object3D);

  let elapsed = 0;
  let visibleCount = 0;

  /**
   * Write one shadow's world transform.
   *
   * The same basis `ship.ts`'s `applyTransform` and `aihulls.ts`'s `place`
   * build, and built the same way round: local +X starboard, +Y the surface
   * normal, +Z astern. The shadow's own `position` IS its surface normal,
   * being a unit direction.
   */
  function place(mesh: Mesh, shadow: Shadow, phase: number): boolean {
    _right.crossVectors(shadow.forward, shadow.position);
    // Degenerate only if the heading has somehow ended up radial, which
    // `leviathan.ts`'s transport does not allow. Leaving the plane on last
    // frame's orientation beats writing a NaN quaternion into the scene.
    if (_right.lengthSq() < 1e-12) return false;
    _right.normalize();
    _back.copy(shadow.forward).negate();
    _basis.makeBasis(_right, shadow.position, _back);
    mesh.quaternion.setFromRotationMatrix(_basis);

    const drift = DRIFT_AMPLITUDE * Math.sin(elapsed * DRIFT_RATE + phase);
    mesh.position.copy(shadow.position).multiplyScalar(GLOBE_RADIUS + SHADOW_LIFT + drift);
    return true;
  }

  return {
    update(dt: number, state: HuntState): void {
      elapsed += dt;
      visibleCount = 0;

      const shadows = state.shadows;
      for (let i = 0; i < slots.length; i++) {
        const mesh = slots[i];
        if (i >= shadows.length) {
          mesh.visible = false;
          continue;
        }

        const shadow = shadows[i];
        // The envelope `leviathan.ts` runs on spawn and on a hunt's last
        // second, spent on the opacity so a shoal resolves out of the water
        // and dissolves back into it rather than popping.
        const envelope = shadow.envelope < 0 ? 0 : shadow.envelope > 1 ? 1 : shadow.envelope;
        if (envelope <= 0) {
          mesh.visible = false;
          continue;
        }

        if (!place(mesh, shadow, i * DRIFT_PHASE_STEP)) continue;

        /*
         * The mark is a MATERIAL swap and a scale, not a third mesh.
         *
         * Two materials in the whole feature means two draw batches at worst,
         * and the swap is a pointer write on the one frame the mark moves. A
         * ring mesh parented to the marked slot would be a second object to
         * place, cull and fade in exact step with the first, which is a bug
         * waiting for the frame the two disagree.
         */
        mesh.material = shadow.marked ? markMaterial : bodyMaterial;
        const scale = shadow.marked ? MARKED_SCALE : 1;
        mesh.scale.set(scale, scale, scale);

        /*
         * Opacity is per-MATERIAL and both are shared across the pool, so this
         * writes the same number once per shadow rather than per shadow.
         *
         * That is correct here and would not be in general: every shadow in a
         * shoal shares one envelope (they are born together and they leave
         * together), so the last write of each frame is the value they all
         * want. `leviathan.ts` is what guarantees that, and if a future phase
         * ever fades one shadow independently this becomes a per-slot material
         * and a real cost.
         */
        if (shadow.marked) markMaterial.opacity = MARK_ALPHA * envelope;
        else bodyMaterial.opacity = BODY_ALPHA * envelope;

        mesh.visible = true;
        visibleCount++;
      }
    },

    get visible(): number {
      return visibleCount;
    },

    dispose(): void {
      scene.remove(group);
      geometry.dispose();
      bodyMaterial.dispose();
      markMaterial.dispose();
      bodyTexture?.dispose();
      markTexture?.dispose();
    },
  };
}
