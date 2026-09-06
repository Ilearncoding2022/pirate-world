import * as THREE from 'three';
import type { Quality } from './quality';
import { LAYER_REFLECTED } from './layers';
import { GLOBE_RADIUS } from './geo';

/**
 * The low-resolution cubemap that lets the beacons, the sky, the town lights
 * and the hull's own neon appear in the water at night -- docs/RENDER_PLAN.md,
 * Phase 1 Stream D. `waterreflect.ts` is the only reader of the resulting
 * `texture`; this module owns nothing about the water shader itself.
 *
 * Never renders the water (it would be sampling itself) or the ship (the
 * camera sits inside the hull) or the land (cheap to skip; its silhouette
 * against the sky barely registers at 128-256px, and it is the most
 * expensive draw in the scene). What *is* rendered is restricted entirely by
 * `LAYER_REFLECTED` -- see `docks.ts`, `citylights.ts`, `sky.ts`, `clouds.ts`
 * for which objects that stream sets it on.
 */

/**
 * Cube camera near plane, world units (ship-scale).
 *
 * The camera sits at the ship's own water-level point, so this only has to
 * clear whatever a reflected object might sit right on top of the ship at --
 * a mast a docked ship is nosed up against, say. There is no water or hull
 * geometry in this camera's layer to clip against.
 */
const REFLECTION_NEAR = 1.0;

/**
 * Cube camera far plane, world units (world-scale).
 *
 * The binding case is the atmosphere shell in `sky.ts`, radius
 * `GLOBE_RADIUS * 1.068`, seen from a camera near `GLOBE_RADIUS` itself: the
 * longest ray from inside that shell to its own far side is a little over
 * twice its radius. This clears that with room to spare for a distant city's
 * glow, and costs nothing extra -- the target is tiny and the far plane only
 * affects depth precision, which nothing here reads.
 */
const REFLECTION_FAR = GLOBE_RADIUS * 3;

/**
 * Pure round-robin cube-face scheduler.
 *
 * `counter` is a monotonically increasing count of faces already rendered
 * (not a frame index -- `createReflection` advances it by exactly how many
 * faces it just returned, wrapping mod 6), so calling this repeatedly with
 * `counter` taken from its own running total visits every face exactly once
 * every `6 / facesPerFrame` calls and never repeats a face within that cycle.
 * Exported so the schedule can be checked without a GPU -- see
 * `tests/unit/reflection.test.ts`.
 */
export function scheduleFaces(counter: number, facesPerFrame: number): number[] {
  if (facesPerFrame <= 0) return [];
  const faces: number[] = [];
  for (let i = 0; i < facesPerFrame; i++) {
    faces.push((counter + i) % 6);
  }
  return faces;
}

export interface Reflection {
  /**
   * `null` when `quality.reflectionSize` is 0 -- the whole system is then
   * absent, not merely idle: no render target is allocated and `update` is a
   * no-op. `globe.ts` reads this to decide whether to register the water
   * plugin at all, which is what makes `?quality=low` compile and run with
   * reflections simply not existing rather than existing and doing nothing.
   */
  readonly texture: THREE.CubeTexture | null;
  /**
   * Renders this frame's share of faces (see `scheduleFaces`) from a camera
   * parked at `shipPosition`'s water-level point. No-op when disabled.
   *
   * Driven directly from `main.ts`'s frame loop rather than through the
   * water plugin's own `update(dt, env, ship, camera)`: that signature has no
   * `renderer` or top-level `scene`, both of which a render-to-cubemap pass
   * needs and the water shader itself never does.
   */
  update(dt: number, shipPosition: THREE.Vector3, renderer: THREE.WebGLRenderer, scene: THREE.Scene): void;
}

export function createReflection(quality: Quality): Reflection {
  const size = quality.reflectionSize;
  if (size <= 0) {
    return {
      texture: null,
      update(): void {
        // Disabled outright -- see the `texture` doc comment above.
      },
    };
  }

  const target = new THREE.WebGLCubeRenderTarget(size, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
  });

  // A real THREE.CubeCamera rather than six hand-built PerspectiveCameras: it
  // is the one place in the engine that already gets the per-face direction
  // and up vectors right for a texture that `textureCube`/`reflect()` will
  // sample correctly, and re-deriving that table by hand risks a mirrored or
  // rolled cube that would be very hard to notice was wrong from a 128px
  // reflection. Only its *scheduling* is custom -- see `update` below.
  const cubeCamera = new THREE.CubeCamera(REFLECTION_NEAR, REFLECTION_FAR, target);
  // Shared by reference with all six of the CubeCamera's own child cameras
  // (its constructor does `child.layers = this.layers` for each), so setting
  // it once here, rather than per face, is enough. `.set()` rather than
  // `.enable()`: this camera must see ONLY LAYER_REFLECTED, not that layer in
  // addition to the default one everything else in the scene starts on.
  cubeCamera.layers.set(LAYER_REFLECTED);

  // True once every face has been painted at least once. Until then the cube
  // would otherwise be sampled with whatever garbage or transparent black its
  // GPU allocation started with on the faces the round-robin has not yet
  // reached -- a several-second-long black smear at the corner of the sea the
  // player happened to spawn away from.
  let primed = false;
  // A running total of faces rendered, mod 6 -- see `scheduleFaces`.
  let faceCounter = 0;

  return {
    texture: target.texture,
    update(_dt: number, shipPosition: THREE.Vector3, renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
      cubeCamera.position.set(
        shipPosition.x * GLOBE_RADIUS,
        shipPosition.y * GLOBE_RADIUS,
        shipPosition.z * GLOBE_RADIUS,
      );
      cubeCamera.updateMatrixWorld();

      if (!primed) {
        // First frame only: THREE.CubeCamera's own `update` paints all six
        // faces in one call (and, as a side effect, resolves its per-face
        // child cameras against `renderer.coordinateSystem` the first time
        // it runs, which the partial path below depends on). It also saves
        // and restores the render target itself, so nothing further is
        // needed here.
        cubeCamera.update(renderer, scene);
        primed = true;
        faceCounter = 0;
        return;
      }

      const faces = scheduleFaces(faceCounter, quality.reflectionFacesPerFrame);
      faceCounter = (faceCounter + faces.length) % 6;
      if (faces.length === 0) return;

      const previousTarget = renderer.getRenderTarget();
      const previousActiveCubeFace = renderer.getActiveCubeFace();
      const previousActiveMipmapLevel = renderer.getActiveMipmapLevel();

      // Mirrors THREE.CubeCamera.update()'s own trick: regenerating the
      // whole cube's mip chain is one GPU call per renderer.render(), valid
      // only once every face of the cube has real data in it, so it is held
      // off until the last face in THIS batch rather than firing once per
      // face rendered.
      const wantsMipmaps = target.texture.generateMipmaps;
      for (let i = 0; i < faces.length; i++) {
        target.texture.generateMipmaps = i === faces.length - 1 ? wantsMipmaps : false;
        const face = faces[i];
        renderer.setRenderTarget(target, face);
        renderer.render(scene, cubeCamera.children[face] as THREE.Camera);
      }
      target.texture.generateMipmaps = wantsMipmaps;

      // Hazard: never leave the reflection cube bound as the render target,
      // or the very next thing drawn -- the whole game -- renders into it
      // and the canvas goes black.
      renderer.setRenderTarget(previousTarget, previousActiveCubeFace, previousActiveMipmapLevel);
    },
  };
}
