import {
  CanvasTexture,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import type { Object3D, Scene } from 'three';
import type { HuntState, Shadow } from './types';
import type { PostFx } from './postfx';
import { GLOBE_RADIUS } from './geo';
import { SHOAL_COUNT } from './leviathan';
import { DISPLACE_AMPLITUDE } from './waveconstants';

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
 * A translucent dark plane sitting ABOVE the water is an approximation of a
 * shape below it, and at the chase camera's grazing angle it can read as a
 * texture artefact rather than as an animal. That is a known, accepted
 * limitation of this phase and not a bug to be tuned away by dropping the
 * opacity until a screenshot passes.
 *
 * It also has a failure mode that is NOT the accepted one and was mistaken for
 * it once: sitting above the water by less than the water's own displacement
 * means sitting UNDER it, and the shoal disappears completely. See
 * `SHADOW_LIFT`. "Illegible" and "absent" look identical in a screenshot and
 * only one of them is a design trade. The real fix is a darkening term
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
 * Set from a screenshot rather than from a guess. The first figures were 4.2
 * by 1.7, a little over a hull length, which sounds right and is not: the
 * chase camera sits 52 units BACK from the ship, so a shadow 22 units ahead is
 * 74 from the lens, and at a grazing 20 degrees a flat quad that size
 * foreshortens to about ten pixels. Ten pixels is not an animal, it is a
 * speck, and no amount of opacity tuning makes it one.
 *
 * Seven by two and a half is over twice the hull's length. That sounds far too
 * big written down and is about right on screen, which is the only place the
 * question has an answer.
 */
const SHADOW_LENGTH = 7;
const SHADOW_WIDTH = 2.6;

/** How much larger the marked one is drawn. The ring does most of the work; this seconds it. */
const MARKED_SCALE = 1.25;

/**
 * How far above the sea a shadow floats, world units.
 *
 * NOT a z-fighting epsilon, though it was written as one (0.05) and that was
 * the bug: the shoal was submitted, counted visible, and drawn nowhere.
 *
 * The water is a sphere at `GLOBE_RADIUS`, but `waterpatch.ts` genuinely
 * DISPLACES it near the ship by up to `DISPLACE_AMPLITUDE` (0.3) at a full
 * gale, and it writes depth. A plane five hundredths of a unit up is therefore
 * under the sea almost everywhere there is any sea running at all, and the
 * depth test discards it. Proved by turning `depthTest` off for one build, at
 * which point the shadows appeared.
 *
 * So this clears the displacement with room over: `DISPLACE_AMPLITUDE` plus a
 * tenth. In a calm the shadow then floats four tenths of a unit proud of the
 * water, which at these ranges is about four pixels and is the price of the
 * approach. `depthTest` stays ON, which is what keeps land occluding a shoal
 * behind a headland.
 *
 * The real answer is still the water-shader darkening term staged as Phase 2 in
 * docs/LEVIATHAN_PLAN.md: a term inside the surface cannot be above or below
 * it, and has no height to tune.
 */
const SHADOW_LIFT = DISPLACE_AMPLITUDE + 0.1;

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

/**
 * The swim: how fast a segment sways, and how far, world units.
 *
 * Applied HERE and not in `leviathan.ts`, deliberately. The sim's chain is
 * rigid and its spacing is exact — the unit tier asserts it to four places —
 * so the undulation is something the eye is shown rather than something the
 * gate has to reason about. A wiggle that moved the real positions could put a
 * segment inside `BOW_ARC` that geometrically was not, and the gate is the
 * whole design.
 *
 * Under half a hull's beam: enough that the body reads as swimming, little
 * enough that the chain still reads as one line.
 */
const SWIM_RATE = 2.4;
const SWIM_SWAY = 0.45;

/** How far a full `bank` tips a segment, radians. */
const BANK_TILT = 0.5;

/**
 * How much higher a fully surfaced segment floats, world units.
 *
 * Added to `SHADOW_LIFT`, so a breaching animal genuinely clears the swell
 * rather than merely brightening. Modest, because the sprite is flat and a
 * plane lifted too far stops reading as a thing in the water and starts
 * reading as a decal hanging over it.
 */
const SURFACE_RISE = 0.55;

/**
 * How much smaller the tail is than the head.
 *
 * The body tapers, which is what makes a line of fourteen identical blobs read
 * as an animal with a front. Rank 0 keeps its full size and the tail is this
 * fraction of it, interpolated between.
 */
const TAIL_TAPER = 0.7;

/**
 * How large a segment is at the instant it arrives, as a fraction of full.
 *
 * Item 19. The MVP faded a full-sized shoal up from nothing, which reads as a
 * decal switching on; this grows it out of the water. Not zero, because a
 * segment that started at literally no size would pop on its first visible
 * frame rather than rise.
 */
const ARRIVAL_MIN = 0.35;

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
const _tilt = new Quaternion();

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

  /*
   * A TEARDROP, not a disc.
   *
   * The geometry is authored with +Z astern, so on this canvas the top edge is
   * the segment's nose. Tapering the shape toward the bottom gives every
   * segment a front, and fourteen of them nose to tail then read as one animal
   * travelling in a direction rather than as a string of beads. That direction
   * cue is what item 1 is actually buying: a player who can see which end is
   * the head can see which way the body is about to go.
   *
   * Drawn by scaling the canvas about the nose rather than by plotting a
   * curve: one transform, and the soft radial falloff below — which is what
   * keeps a flat quad from reading as a decal, and is the MVP's hard-won
   * lesson — survives it unchanged.
   */
  const fill = ctx.createRadialGradient(half, half, 0, half, half, half);
  fill.addColorStop(0, 'rgba(2, 8, 14, 1)');
  fill.addColorStop(0.45, 'rgba(3, 12, 22, 0.82)');
  fill.addColorStop(0.78, 'rgba(4, 16, 28, 0.28)');
  fill.addColorStop(1, 'rgba(4, 16, 28, 0)');

  ctx.save();
  if (!ring) {
    /*
     * Widest a third of the way back from the nose and drawn to a point at the
     * tail. The mark keeps the plain disc: it carries a ring and is read as an
     * instrument mark rather than as anatomy, and tapering it would fight the
     * ring for the same pixels.
     */
    ctx.translate(half, TEXTURE_SIZE * 0.34);
    ctx.scale(1, 1.15);
    ctx.translate(-half, -TEXTURE_SIZE * 0.34);
  }
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (!ring) {
    /*
     * A lighter head. `docs/LEVIATHAN_PHASE2_PLAN.md` asks for the falloff to
     * lighten toward the nose on both shadow paths, and on this one it is a
     * second, smaller gradient laid over the first: the body is an absence of
     * light, and the nose is slightly less of one.
     */
    const nose = ctx.createRadialGradient(
      half,
      TEXTURE_SIZE * 0.3,
      0,
      half,
      TEXTURE_SIZE * 0.3,
      half * 0.55,
    );
    nose.addColorStop(0, 'rgba(26, 54, 74, 0.55)');
    nose.addColorStop(1, 'rgba(26, 54, 74, 0)');
    ctx.fillStyle = nose;
    ctx.beginPath();
    ctx.arc(half, TEXTURE_SIZE * 0.3, half * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

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
export function createShadowField(
  scene: Scene,
  postFx?: Pick<PostFx, 'adopt'>,
  /**
   * Which renderer the quality tier chose. `'shader'` means the water term in
   * `leviathanwater.ts` is drawing the body, so this pool hides itself
   * entirely rather than drawing a second set of shadows on top of it.
   *
   * Defaults to the sprite path so that every existing caller and every
   * existing test keeps the behaviour it had. Stream B2 owns what this does
   * beyond hiding.
   */
  path: 'sprites' | 'shader' = 'sprites',
): ShadowField {
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

    /*
     * The swim wiggle, and the roll.
     *
     * A segment eases side to side about the body's centre line on its own
     * `wobble` phase, so the chain undulates instead of sliding along its own
     * path like a train on rails. `leviathan.ts` keeps the SIM's chain rigid —
     * spacing is exact there, and the tests assert it — and the waving is
     * purely what the eye is shown, which is why it lives here and why it can
     * never make the animal miss a gate it geometrically passed.
     *
     * The roll is `bank`, tipped about the body's own forward axis. On the
     * head that is item 7's telegraph; on the body it is the same roll
     * arriving a beat later, which is `leviathan.ts`'s `BANK_TRAVEL`.
     */
    const swim = Math.sin(elapsed * SWIM_RATE + phase) * SWIM_SWAY;
    if (shadow.bank !== 0) {
      _tilt.setFromAxisAngle(_back, -shadow.bank * BANK_TILT);
      mesh.quaternion.multiply(_tilt);
    }

    /*
     * How high it floats, and the arrival from depth.
     *
     * `surfacing` runs 0 deep to 1 breaching, so a segment that is merely
     * cruising sits at the old clearance and the MARK — which `leviathan.ts`
     * lifts to `SURFACE_MARK` — rides visibly higher. That is most of what
     * makes the mark findable at chase distance without a HUD marker on it.
     */
    const drift = DRIFT_AMPLITUDE * Math.sin(elapsed * DRIFT_RATE + phase);
    const lift = SHADOW_LIFT + drift + shadow.surfacing * SURFACE_RISE;
    mesh.position.copy(shadow.position).multiplyScalar(GLOBE_RADIUS + lift);
    // The lateral sway, applied in world units along the body's own starboard.
    mesh.position.addScaledVector(_right, swim);
    return true;
  }

  return {
    update(dt: number, state: HuntState): void {
      elapsed += dt;
      visibleCount = 0;

      /*
       * The shader tier draws the body inside the water's own fragment shader,
       * so this pool stands down entirely rather than laying a second set of
       * shadows over the top of it.
       *
       * `visibleCount` stays 0, which is the honest answer and the one the
       * debug hook needs: it is what lets a screenshot distinguish "the sprite
       * path drew nothing" from "the sprite path was not the one asked to
       * draw", and only one of those is a bug.
       */
      if (path === 'shader') {
        for (const mesh of slots) mesh.visible = false;
        return;
      }

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

        /*
         * Three things decide how big a segment draws, multiplied together.
         *
         * The TAPER makes the body an animal with a front rather than a line
         * of identical blobs: rank 0 is full size and the tail is
         * `TAIL_TAPER` of it. The MARK is enlarged on top of that, as it was
         * in the MVP. And `envelope` scales the whole thing from nearly
         * nothing to full size, which is item 19: a shoal grows out of the sea
         * as it arrives instead of fading in at full size, and leaves by
         * shrinking back into it.
         */
        const last = Math.max(1, shadows.length - 1);
        const taper = 1 - (1 - TAIL_TAPER) * (shadow.rank / last);
        const arrival = ARRIVAL_MIN + (1 - ARRIVAL_MIN) * envelope;
        const scale = taper * arrival * (shadow.marked ? MARKED_SCALE : 1);
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
