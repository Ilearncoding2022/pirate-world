import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';

export interface PostFx {
  /** Draws the frame. Replaces a direct renderer.render() call. */
  render(dt: number, scene: THREE.Scene, camera: THREE.Camera): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const BLOOM_THRESHOLD = 0.9;
const BLOOM_STRENGTH = 1.0;
const BLOOM_RADIUS = 0.6;

/**
 * Width of the ramp above the threshold, replacing the pass's default 0.01.
 *
 * A near-hard cut makes the threshold a cliff: the brightest ordinary surface
 * in the scene (cloud tops, 0.86) sits only just below it, so any later tweak
 * that lifts clouds or sea over the line would switch the entire deck to
 * glowing at once. A wide knee means anything creeping over the line fades in
 * instead, while the genuinely over-range sources still pass at full weight.
 */
const BLOOM_KNEE = 0.15;

/**
 * Cap, in device pixels, on the width the bloom chain runs at.
 *
 * The chain is six full screen passes over a five step mip pyramid, so at 2x
 * pixel ratio on a large monitor it is the most expensive thing in the frame --
 * and it is a blur, so the detail it would buy is invisible. Driving it from a
 * capped width rather than from the drawing buffer holds that cost flat across
 * pixel ratios and window sizes while a normal 1x window still gets the full
 * resolution chain. Do not cap it much lower: small sources need the
 * resolution, and halving this dropped the lantern and the town lights far
 * enough down the mip chain that they visibly stopped glowing.
 */
const BLOOM_MAX_WIDTH = 1280;

/**
 * Bright-pass keyed on the peak channel instead of Rec.709 luminance.
 *
 * Measured off this scene: the atmosphere rim peaks at rgb(25, 136, 255) --
 * blue fully saturated -- but scores only 0.47 luminance, because luminance
 * weights blue at 0.07. A sunlit cloud top, rgb(218, 205, 183), scores 0.81.
 * So with the stock luminance high pass every threshold that lets the rim glow
 * also blooms the whole cloud deck and the lit sea, and every threshold that
 * spares them kills the rim. There is no setting in between.
 *
 * Peak channel separates them cleanly, because what should glow here is
 * saturated (blue rim, cyan and magenta hull neon, amber and cyan town lights,
 * all of which run past 1.0 in one channel) and what should not is broad
 * spectrum and stays under 0.86 in every channel.
 *
 * Same uniform names as `LuminosityHighPassShader`, so the pass keeps driving
 * `luminosityThreshold` from `bloomPass.threshold` every frame.
 */
const PEAK_HIGH_PASS_FRAGMENT = [
  'uniform sampler2D tDiffuse;',
  'uniform vec3 defaultColor;',
  'uniform float defaultOpacity;',
  'uniform float luminosityThreshold;',
  'uniform float smoothWidth;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec4 texel = texture2D(tDiffuse, vUv);',
  '  float peak = max(texel.r, max(texel.g, texel.b));',
  '  vec4 outputColor = vec4(defaultColor.rgb, defaultOpacity);',
  '  float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, peak);',
  '  gl_FragColor = mix(outputColor, texel, alpha);',
  '}',
].join('\n');

/**
 * Composer chain: render -> bloom -> raw copy to the canvas.
 *
 * The last pass is a plain copy rather than an `OutputPass`, and the working
 * buffers are marked as holding sRGB, because this scene mixes materials that
 * colour manage with materials that do not. `land`, `ship` and the starfield
 * are stock Three materials and get an sRGB encode on the way out; `water`,
 * `sky` and `citylights` are hand written `ShaderMaterial`s that write
 * `gl_FragColor` raw, with no encode. Rendering straight to the canvas, both
 * land on screen exactly as their authors tuned them.
 *
 * A composer normally breaks that. Three forces `LinearSRGBColorSpace` output
 * for anything drawn into an ordinary render target, so the stock materials
 * lose their encode; putting an `OutputPass` at the end gives it back to them
 * but then also applies it to the raw shaders, which were never linear, and the
 * ocean lifts from near black to mid blue. Measured: an `OutputPass` chain
 * takes mean frame luminance from 23 to 117 and turns the sea into white haze.
 *
 * So instead the render targets declare sRGB and the final blit does nothing at
 * all, which reproduces the direct-to-canvas result for both kinds of material
 * and leaves bloom as the only difference. Verified by A/B: with the bloom
 * threshold above every source, composer output matches a direct render to
 * within 0.1 of a luminance level.
 */
export function createPostFx(renderer: THREE.WebGLRenderer): PostFx {
  let composer: EffectComposer | null = null;
  let renderPass: RenderPass | null = null;
  let bloomPass: UnrealBloomPass | null = null;
  let copyPass: ShaderPass | null = null;

  const size = renderer.getSize(new THREE.Vector2());
  let width = size.x;
  let height = size.y;

  function applySize(): void {
    if (!composer || !bloomPass) return;
    const pixelRatio = renderer.getPixelRatio();
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    const bufferWidth = width * pixelRatio;
    const scale = pixelRatio * Math.min(1, BLOOM_MAX_WIDTH / Math.max(1, bufferWidth));
    bloomPass.setSize(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    );
  }

  function build(scene: THREE.Scene, camera: THREE.Camera): EffectComposer {
    const built = new EffectComposer(renderer);
    composer = built;

    // `main.ts` asks for an antialiased context. Composer targets default to no
    // multisampling, so without this the composer silently drops MSAA and the
    // ocean's wave detail starts to crawl. Costs nothing when AA is off.
    const attributes = renderer.getContext().getContextAttributes();
    const samples = attributes?.antialias ? Math.min(4, renderer.capabilities.maxSamples) : 0;

    for (const target of [built.renderTarget1, built.renderTarget2]) {
      target.samples = samples;
      // Three decides a draw's output colour space from the bound target, and
      // for an ordinary target the answer is hardcoded to linear -- the
      // target's own `texture.colorSpace` is ignored. `isXRRenderTarget` is the
      // one flag that makes it read `texture.colorSpace` instead, which is what
      // keeps stock materials encoding exactly as they do to the canvas (see
      // `WebGLPrograms.getParameters`). The buffers are RGBA16F, so nothing
      // else changes: sRGB is not a valid half float internal format, and the
      // same flag tells `getInternalFormat` to keep the linear one.
      target.texture.colorSpace = THREE.SRGBColorSpace;
      (target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
    }

    renderPass = new RenderPass(scene, camera);
    built.addPass(renderPass);

    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    bloomPass.materialHighPassFilter.fragmentShader = PEAK_HIGH_PASS_FRAGMENT;
    bloomPass.materialHighPassFilter.needsUpdate = true;
    bloomPass.materialHighPassFilter.uniforms.smoothWidth.value = BLOOM_KNEE;
    built.addPass(bloomPass);

    // Final blit, deliberately conversion free. `CopyShader` is a plain
    // `ShaderMaterial`, so it neither decodes the buffer nor encodes on the way
    // out; the pixels reach the canvas exactly as the render pass wrote them.
    // Letting the bloom pass be last instead would hand the job to its internal
    // `MeshBasicMaterial`, which does encode, and double encode the frame.
    copyPass = new ShaderPass(CopyShader);
    copyPass.material.blending = THREE.NoBlending;
    built.addPass(copyPass);

    applySize();
    return built;
  }

  return {
    render(dt: number, scene: THREE.Scene, camera: THREE.Camera): void {
      // The composer needs the scene and camera up front but they only arrive
      // per frame, so it is built on the first draw. A later swap of either is
      // a field write on the existing pass, never a rebuild -- rebuilding would
      // reallocate every render target mid-flight.
      let active = composer;
      if (active === null || renderPass === null) {
        active = build(scene, camera);
      } else {
        if (renderPass.scene !== scene) renderPass.scene = scene;
        if (renderPass.camera !== camera) renderPass.camera = camera;
      }
      active.render(dt);
    },

    resize(w: number, h: number): void {
      // Still owns the canvas resize, exactly as the placeholder did: `main.ts`
      // sets the pixel ratio and then calls only this, so dropping it would
      // freeze the drawing buffer at its startup size.
      width = w;
      height = h;
      renderer.setSize(w, h);
      applySize();
    },

    dispose(): void {
      bloomPass?.dispose();
      copyPass?.dispose();
      composer?.dispose();
      composer = null;
      renderPass = null;
      bloomPass = null;
      copyPass = null;
    },
  };
}
