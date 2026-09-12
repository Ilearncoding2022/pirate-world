/**
 * huntfx.ts — the throw: harpoon line, splash rings, spray, ink and the dive
 * swell.
 *
 * The MVP's press produced nothing at all. `main.ts`'s `onHuntEvent` returned
 * early on a `hit` by deliberate decision, and the whole of the feedback for
 * the feature's one verb was a counter going from `5 LEFT` to `4 LEFT`. This
 * is what a press looks like.
 *
 * ## Rules this file is held to
 *
 * **No new scene lights.** `battlescene.ts` records why: a light arriving
 * under a hull of two dozen standard materials changes the lighting hash and
 * recompiles every one of them, which is a stall in the middle of the thing
 * the player is doing. Everything here is emissive geometry.
 *
 * **Fixed pools, no allocation after construction.** Every effect is a slot
 * that is claimed, aged and released; nothing is built on a cue.
 *
 * **`postFx.adopt` before the first frame**, or these materials carry no sRGB
 * self-encode and render a stop dark.
 *
 * **`frustumCulled = false`** on every mesh, for `leviathanshadows.ts`'s
 * reason: Three culls against a bounding sphere computed at the origin, so a
 * plane placed 200 units out by a fresh world matrix is culled by accident.
 *
 * **Frame `dt` only.** No `setTimeout`, no `performance.now()`.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  Vector3,
} from 'three';
import type { Object3D, Scene } from 'three';
import type { HuntBand, HuntCue, HuntState, ShipState } from './types';
import type { PostFx } from './postfx';
import { GLOBE_RADIUS } from './geo';
import { DISPLACE_AMPLITUDE } from './waveconstants';

/** The same clearance the shadows use, so nothing here sinks under a swell. */
const FX_LIFT = DISPLACE_AMPLITUDE + 0.12;

/** Pool sizes. Generous enough that five presses in a row never starve one. */
const RINGS = 6;
const BURSTS = 4;
const INKS = 2;

/** Lives, seconds. */
const LINE_TAUT = 0.3;
const LINE_FADE = 0.35;
const RING_LIFE = 1.6;
const BURST_LIFE = 0.7;
const INK_LIFE = 3;
const SWELL_LIFE = 2;

/** How far a splash ring grows, world units. Generalised from `battlescene.ts`. */
const RING_FROM = 0.6;
const RING_TO = 5.5;

/** The dive swell: a wide dark ring, the picture that makes sounding a loss. */
const SWELL_FROM = 2;
const SWELL_TO = 26;

/** Where the line leaves the hull, world units forward of its centre. */
const BOW_OFFSET = 1.6;

const BAND_COLOUR: Record<HuntBand, number> = {
  green: 0x8fffc8,
  yellow: 0xffe08a,
  red: 0xff8a6a,
};

const _right = new Vector3();
const _astern = new Vector3();
const _basis = new Matrix4();
const _bow = new Vector3();
const _to = new Vector3();
const _up = new Vector3();

interface Ring {
  mesh: Mesh;
  material: MeshBasicMaterial;
  life: number;
  age: number;
  from: number;
  to: number;
}

interface Burst {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
  scale: number;
}

interface Ink {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
}

export interface HuntFx {
  cue(cue: HuntCue, ship: ShipState): void;
  update(dt: number, state: HuntState, ship: ShipState): void;
  readonly live: number;
  dispose(): void;
}

/**
 * Lay a flat thing on the water at `direction`, facing the sky.
 *
 * The surface basis every other placement in this codebase uses: +X starboard,
 * +Y the normal, +Z astern. A unit direction IS its own surface normal.
 */
function placeFlat(object: Object3D, direction: Vector3, forward: Vector3, lift: number): boolean {
  _right.crossVectors(forward, direction);
  if (_right.lengthSq() < 1e-12) return false;
  _right.normalize();
  _astern.copy(forward).negate();
  _basis.makeBasis(_right, direction, _astern);
  object.quaternion.setFromRotationMatrix(_basis);
  object.position.copy(direction).multiplyScalar(GLOBE_RADIUS + lift);
  return true;
}

/**
 * The spray plume, drawn into a canvas at construction.
 *
 * An untextured quad is a white RECTANGLE — which is exactly what the first
 * build of this looked like on the water, and no amount of opacity tuning
 * fixes a hard edge. Spray is a soft column, densest at the base and ragged at
 * the top, so that is what this draws: a vertical gradient for the fall-off
 * and a handful of blobs for the rag.
 *
 * No asset file, like everything else in this project.
 */
function makeSprayTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  ctx.clearRect(0, 0, size, size);

  // The column: bright at the foot, gone by the top.
  const column = ctx.createLinearGradient(0, size, 0, 0);
  column.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  column.addColorStop(0.45, 'rgba(226, 244, 255, 0.45)');
  column.addColorStop(1, 'rgba(226, 244, 255, 0)');

  // Narrowed toward the top with a horizontal mask, so the plume is a plume
  // and not a bar. Drawn as a soft-edged triangle rather than clipped, because
  // a clip would give back the hard edge this exists to avoid.
  for (let y = 0; y < size; y++) {
    const t = y / size;
    const halfWidth = (size * 0.42) * (0.35 + 0.65 * t);
    const fade = ctx.createLinearGradient(size / 2 - halfWidth, 0, size / 2 + halfWidth, 0);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(0.5, 'rgba(255,255,255,1)');
    fade.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = fade;
    ctx.fillRect(size / 2 - halfWidth, size - 1 - y, halfWidth * 2, 1);
  }

  // Tint the mask with the vertical fall-off in one pass.
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = column;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function createHuntFx(scene: Scene, postFx?: Pick<PostFx, 'adopt'>): HuntFx {
  const sprayTexture = makeSprayTexture();
  const group = new Group();
  group.name = 'hunt-fx';
  scene.add(group);

  /* ---- The harpoon line ---------------------------------------------- */

  /*
   * Two vertices, rewritten every frame it is live. A line rather than a
   * cylinder because it is seen end-on from a chase camera and a tube would be
   * three hundred triangles to look like two vertices.
   */
  const lineGeometry = new BufferGeometry();
  lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
  const lineMaterial = new LineBasicMaterial({
    color: 0xf2e8d0,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const line = new Line(lineGeometry, lineMaterial);
  line.frustumCulled = false;
  line.visible = false;
  group.add(line);

  let lineAge = 0;
  let lineLive = false;
  const lineFrom = new Vector3();
  const lineTo = new Vector3();

  /* ---- Splash rings --------------------------------------------------- */

  const rings: Ring[] = [];
  for (let i = 0; i < RINGS; i++) {
    const material = new MeshBasicMaterial({
      color: 0xdff2ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    // Authored in XY facing +Z; the quarter turn is baked once so the
    // placement can write the surface basis straight in.
    const geometry = new RingGeometry(0.82, 1, 24);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    group.add(mesh);
    rings.push({ mesh, material, life: RING_LIFE, age: RING_LIFE, from: RING_FROM, to: RING_TO });
  }

  /* ---- Spray bursts --------------------------------------------------- */

  const bursts: Burst[] = [];
  for (let i = 0; i < BURSTS; i++) {
    const material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    // A vertical quad: spray goes UP, which is the one direction a flat ring
    // cannot show and is what makes a strike read as an impact. The texture is
    // what keeps it from reading as the white rectangle an untextured quad is.
    material.map = sprayTexture;
    const mesh = new Mesh(new PlaneGeometry(1.6, 2.2), material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    group.add(mesh);
    bursts.push({ mesh, material, age: BURST_LIFE, scale: 1 });
  }

  /* ---- Ink ------------------------------------------------------------ */

  const inks: Ink[] = [];
  for (let i = 0; i < INKS; i++) {
    const material = new MeshBasicMaterial({
      color: 0x0a1420,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    group.add(mesh);
    inks.push({ mesh, material, age: INK_LIFE });
  }

  /* ---- The dive swell -------------------------------------------------- */

  const swellMaterial = new MeshBasicMaterial({
    color: 0x16384a,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const swellGeometry = new RingGeometry(0.7, 1, 40);
  swellGeometry.rotateX(-Math.PI / 2);
  const swell = new Mesh(swellGeometry, swellMaterial);
  swell.frustumCulled = false;
  swell.visible = false;
  group.add(swell);
  let swellAge = SWELL_LIFE;
  const swellAt = new Vector3();

  postFx?.adopt(group as unknown as Object3D);

  let liveCount = 0;

  /** The oldest slot, so a sixth ring in a row replaces the first rather than being dropped. */
  function claimRing(): Ring {
    let oldest = rings[0];
    for (const ring of rings) if (ring.age > oldest.age) oldest = ring;
    return oldest;
  }
  function claimBurst(): Burst {
    let oldest = bursts[0];
    for (const burst of bursts) if (burst.age > oldest.age) oldest = burst;
    return oldest;
  }
  function claimInk(): Ink {
    let oldest = inks[0];
    for (const ink of inks) if (ink.age > oldest.age) oldest = ink;
    return oldest;
  }

  return {
    cue(cue: HuntCue, ship: ShipState): void {
      if (cue.kind === 'strike' && cue.position) {
        // The line: from a bow offset on the hull to where the harpoon landed.
        if (ship.forward.lengthSq() > 1e-12) {
          _bow
            .copy(ship.position)
            .addScaledVector(ship.forward, BOW_OFFSET / GLOBE_RADIUS)
            .normalize();
        } else {
          _bow.copy(ship.position);
        }
        lineFrom.copy(_bow).multiplyScalar(GLOBE_RADIUS + FX_LIFT + 0.9);
        lineTo.copy(cue.position).multiplyScalar(GLOBE_RADIUS + FX_LIFT);
        lineAge = 0;
        lineLive = true;

        const ring = claimRing();
        ring.age = 0;
        ring.life = RING_LIFE;
        ring.from = RING_FROM;
        ring.to = RING_TO;
        placeFlat(ring.mesh, cue.position, ship.forward, FX_LIFT);
        ring.material.color.setHex(BAND_COLOUR[cue.band ?? 'yellow']);

        const burst = claimBurst();
        burst.age = 0;
        // Bigger for a better press, so the spray itself reads the band.
        burst.scale = cue.band === 'green' ? 1.25 : cue.band === 'yellow' ? 0.95 : 0.6;
        burst.mesh.position.copy(cue.position).multiplyScalar(GLOBE_RADIUS + FX_LIFT + 1.4);

        /*
         * Ink on a GREEN strike only. It is the reward for the best press and
         * it should not appear on a press the player should feel bad about,
         * which is also why it is the one effect the low tier drops.
         */
        if (cue.band === 'green') {
          const ink = claimInk();
          ink.age = 0;
          placeFlat(ink.mesh, cue.position, ship.forward, FX_LIFT - 0.02);
        }
      }

      if (cue.kind === 'dive' && cue.position) {
        swellAge = 0;
        swellAt.copy(cue.position);
        placeFlat(swell, cue.position, ship.forward, FX_LIFT - 0.04);
      }
    },

    update(dt: number, _state: HuntState, ship: ShipState): void {
      if (!(dt > 0)) return;
      liveCount = 0;

      /* ---- Line ------------------------------------------------------- */
      if (lineLive) {
        lineAge += dt;
        const total = LINE_TAUT + LINE_FADE;
        if (lineAge >= total) {
          lineLive = false;
          line.visible = false;
        } else {
          // The throw: the line extends over the taut phase, then fades where
          // it landed. It does not retract, because a harpoon does not.
          const reach = Math.min(1, lineAge / LINE_TAUT);
          const attribute = lineGeometry.getAttribute('position') as BufferAttribute;
          _to.copy(lineFrom).lerp(lineTo, reach);
          attribute.setXYZ(0, lineFrom.x, lineFrom.y, lineFrom.z);
          attribute.setXYZ(1, _to.x, _to.y, _to.z);
          attribute.needsUpdate = true;
          lineMaterial.opacity =
            lineAge <= LINE_TAUT ? 0.9 : 0.9 * (1 - (lineAge - LINE_TAUT) / LINE_FADE);
          line.visible = true;
          liveCount++;
        }
      }

      /* ---- Rings ------------------------------------------------------ */
      for (const ring of rings) {
        if (ring.age >= ring.life) {
          ring.mesh.visible = false;
          continue;
        }
        ring.age += dt;
        const t = Math.min(1, ring.age / ring.life);
        // Fast out, slow to a stop: a splash spreads hardest at the moment it
        // is made. `battlescene.ts`'s pool uses the same easing.
        const eased = 1 - (1 - t) * (1 - t);
        const radius = ring.from + (ring.to - ring.from) * eased;
        ring.mesh.scale.set(radius, 1, radius);
        ring.material.opacity = 0.75 * (1 - t);
        ring.mesh.visible = true;
        liveCount++;
      }

      /* ---- Spray ------------------------------------------------------ */
      for (const burst of bursts) {
        if (burst.age >= BURST_LIFE) {
          burst.mesh.visible = false;
          continue;
        }
        burst.age += dt;
        const t = Math.min(1, burst.age / BURST_LIFE);
        /*
         * A standing quad, oriented by hand rather than with a `Sprite`.
         *
         * A Sprite always faces the camera squarely, which for a column of
         * spray means it would lean over as the camera pitched and stop
         * standing ON the water. So: local +Y is the surface normal, so the
         * spray goes genuinely up; local +Z faces astern, which is where the
         * chase camera always is, so it is broadside to the player without
         * having to be told where the camera is.
         */
        _up.copy(burst.mesh.position).normalize();
        _astern.copy(ship.forward).negate();
        _astern.addScaledVector(_up, -_astern.dot(_up));
        if (_astern.lengthSq() > 1e-12) {
          _astern.normalize();
          _right.crossVectors(_up, _astern).normalize();
          _basis.makeBasis(_right, _up, _astern);
          burst.mesh.quaternion.setFromRotationMatrix(_basis);
        }
        const rise = burst.scale * (0.6 + t * 0.9);
        burst.mesh.scale.set(rise, rise, rise);
        burst.material.opacity = 0.85 * (1 - t) * (1 - t);
        burst.mesh.visible = true;
        liveCount++;
      }

      /* ---- Ink -------------------------------------------------------- */
      for (const ink of inks) {
        if (ink.age >= INK_LIFE) {
          ink.mesh.visible = false;
          continue;
        }
        ink.age += dt;
        const t = Math.min(1, ink.age / INK_LIFE);
        const size = 2 + t * 9;
        ink.mesh.scale.set(size, 1, size);
        // Grows and thins: ink spreads, it does not evaporate.
        ink.material.opacity = 0.5 * (1 - t);
        ink.mesh.visible = true;
        liveCount++;
      }

      /* ---- The dive swell --------------------------------------------- */
      if (swellAge < SWELL_LIFE) {
        swellAge += dt;
        const t = Math.min(1, swellAge / SWELL_LIFE);
        const eased = 1 - (1 - t) * (1 - t);
        const radius = SWELL_FROM + (SWELL_TO - SWELL_FROM) * eased;
        // Re-placed each frame so it keeps its footing on a displacing sea.
        placeFlat(swell, swellAt, ship.forward, FX_LIFT - 0.04);
        swell.scale.set(radius, 1, radius);
        swellMaterial.opacity = 0.6 * (1 - t);
        swell.visible = true;
        liveCount++;
      } else {
        swell.visible = false;
      }
    },

    get live(): number {
      return liveCount;
    },

    dispose(): void {
      scene.remove(group);
      lineGeometry.dispose();
      lineMaterial.dispose();
      for (const ring of rings) {
        ring.mesh.geometry.dispose();
        ring.material.dispose();
      }
      for (const burst of bursts) {
        burst.mesh.geometry.dispose();
        burst.material.dispose();
      }
      for (const ink of inks) {
        ink.mesh.geometry.dispose();
        ink.material.dispose();
      }
      swellGeometry.dispose();
      swellMaterial.dispose();
    },
  };
}
