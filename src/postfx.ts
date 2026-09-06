import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import type { Quality } from './quality';

/** One frame's telemetry for the dev overlay (main.ts, Backquote). */
export interface GpuFrameStats {
  /** Rolling mean, milliseconds. `null` when EXT_disjoint_timer_query_webgl2
   * is unavailable, or while the timer is disabled -- see setTimingEnabled. */
  gpuMs: number | null;
  /** Rolling mean wall-clock time spent inside render(), milliseconds. */
  cpuMs: number;
  /** Rolling mean of renderer.info.render.calls for the whole composer chain. */
  calls: number;
}

export interface PostFx {
  /** Draws the frame. Replaces a direct renderer.render() call. */
  render(dt: number, scene: THREE.Scene, camera: THREE.Camera): void;
  /**
   * Applies the colour-encode patch below to a subtree added after the first
   * frame. The scene is only walked once, on first render, so anything that
   * arrives later -- the glTF hull, which streams in -- would otherwise render
   * a stop dark against everything around it. Idempotent.
   */
  adopt(root: THREE.Object3D): void;
  resize(width: number, height: number): void;
  /** Rolling 60-frame means for the dev overlay. Cheap to call every frame
   * regardless of setTimingEnabled -- see GpuFrameStats.gpuMs. */
  getStats(): GpuFrameStats;
  /**
   * Turns the GPU timer query on or off. A disjoint timer query carries a
   * real, if small, GPU cost, so it only runs while the overlay reading it is
   * visible -- off by default, toggled with Backquote in main.ts. Switching
   * it on clears the rolling GPU mean so a stale pre-toggle number never
   * flashes.
   */
  setTimingEnabled(enabled: boolean): void;
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
 * The scene buffer is 8-bit, so every source that should glow (atmosphere rim,
 * hull neon, town lights) arrives clamped to exactly 1.0, while the brightest
 * surface that should not (cloud tops) sits at about 0.86. The knee therefore
 * has to end below 1.0 so clamped sources reach full weight, and start above
 * 0.86 so clouds stay out. 0.90 to 0.98 does both, and still softens anything
 * that later creeps over the line instead of switching a whole surface on.
 */
const BLOOM_KNEE = 0.08;

/**
 * Cap, in device pixels, on the width the bloom chain runs at -- read from
 * `quality.bloomMaxWidth` (960 / 1280 / 1280 low to high; see quality.ts).
 *
 * The chain is six full screen passes over a five step mip pyramid, so at 2x
 * pixel ratio on a large monitor it is the most expensive thing in the frame --
 * and it is a blur, so the detail it would buy is invisible. Driving it from a
 * capped width rather than from the drawing buffer holds that cost flat across
 * pixel ratios and window sizes while a normal 1x window still gets the full
 * resolution chain. Do not cap it much lower: small sources need the
 * resolution, and halving this dropped the lantern and the town lights far
 * enough down the mip chain that they visibly stopped glowing -- which is why
 * only `low` moves it at all.
 */

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
 * all of which saturate one channel) and what should not is broad spectrum and
 * stays under 0.86 in every channel.
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

/* ------------------------------------------------------------------ */
/* Colour management under the composer                                */
/* ------------------------------------------------------------------ */

/**
 * Why stock materials are patched to encode themselves.
 *
 * This scene mixes two kinds of material. `land`, `ship`, the grid and the
 * starfield are stock Three materials: when drawn straight to the canvas they
 * get an sRGB encode on the way out. `water`, `sky`, `clouds`, `citylights` and
 * `wake` are hand written `ShaderMaterial`s that write `gl_FragColor` raw and
 * were tuned against exactly that raw output. Rendering direct to the canvas,
 * both kinds land on screen as their authors tuned them.
 *
 * A composer breaks that balance: Three hardcodes linear output for anything
 * drawn into an ordinary render target, so the stock materials lose their
 * encode and go a stop darker than everything beside them. An `OutputPass` at
 * the end gives it back to them but also encodes the raw shaders, which were
 * never linear, and the ocean lifts into white haze.
 *
 * An earlier version fixed this by marking the composer targets as WebXR
 * targets, the one flag that makes Three honour a target's own colour space.
 * That flag is not a colour-space switch. It also routes multisampled targets
 * through the XR render-to-texture path whenever the GPU exposes
 * WEBGL_multisampled_render_to_texture, which skips the explicit resolve the
 * composer's ping-pong buffers depend on. Software rendering lacks that
 * extension so the bug never showed in headless tests; on real hardware it
 * produced an unresolved, mostly black frame and colour flicker. Never set
 * `isXRRenderTarget` on a non-XR target.
 *
 * So instead the stock materials are patched, once, to encode with the same
 * function Three uses for the canvas regardless of which buffer is bound. The
 * composer targets stay ordinary linear targets on the standard MSAA path, and
 * the final blit is a plain copy that converts nothing. The result is pixel
 * equivalent to a direct render for both kinds of material, with bloom as the
 * only difference.
 */
const SELF_ENCODE_KEY = 'pirate-world/srgb-self-encode';

/**
 * Used to be a `throw` the moment a material already had an `onBeforeCompile`
 * hook. That was fine while nothing extended a stock material; Stream C
 * (docs/RENDER_PLAN.md, land.ts) needs to add its own hook to the same
 * `MeshStandardMaterial` this patch already targets, so the two now chain
 * instead: the prior hook runs first, unchanged, and this patch's encode
 * replacement runs after it.
 *
 * `customProgramCacheKey` has to stay unique per *combination* of hooks, not
 * just per patch. Three's own default implementation is
 * `this.onBeforeCompile.toString()` -- read here, before `onBeforeCompile` is
 * overwritten below, so it still describes the prior hook rather than this
 * one. Skipping that capture (or reading it after the swap) would collapse
 * every differently-hooked material onto the same cache key, and two
 * materials sharing a compiled program when their shaders actually differ is
 * exactly the "genuinely nasty bug" this exists to avoid.
 */
function selfEncodeToSRGB(material: THREE.Material): void {
  if (material.userData[SELF_ENCODE_KEY] === true) return;
  // Raw shaders are excluded: they never had an encode and are tuned without one.
  const raw = material as unknown as { isShaderMaterial?: boolean; isRawShaderMaterial?: boolean };
  if (raw.isShaderMaterial === true || raw.isRawShaderMaterial === true) return;

  const hadPriorHook = material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile;
  const priorCompile = material.onBeforeCompile;
  const priorCacheKey = hadPriorHook ? material.customProgramCacheKey() : '';

  material.onBeforeCompile = (shader, renderer): void => {
    if (hadPriorHook) priorCompile.call(material, shader, renderer);
    // `sRGBTransferOETF` is declared by <colorspace_pars_fragment>, which every
    // stock fragment shader includes. This replaces the target-dependent
    // `linearToOutputTexel` with an unconditional sRGB encode.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <colorspace_fragment>',
      'gl_FragColor = sRGBTransferOETF( gl_FragColor );',
    );
  };
  material.customProgramCacheKey = (): string =>
    priorCacheKey ? `${priorCacheKey}|${SELF_ENCODE_KEY}` : SELF_ENCODE_KEY;
  material.userData[SELF_ENCODE_KEY] = true;
  material.needsUpdate = true;
}

function patchSceneMaterials(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((obj) => {
    const holder = obj as unknown as { material?: THREE.Material | THREE.Material[] };
    const mat = holder.material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      const before = m.userData[SELF_ENCODE_KEY] === true;
      selfEncodeToSRGB(m);
      if (!before && m.userData[SELF_ENCODE_KEY] === true) count++;
    }
  });
  return count;
}

/* ------------------------------------------------------------------ */
/* GPU/CPU timing, for the dev overlay only                            */
/* ------------------------------------------------------------------ */

/** Frames averaged for the dev overlay's GPU ms / CPU ms / draw-call means. Not world- or ship-scale -- a UI sampling window. */
const TIMING_WINDOW = 60;

/** A fixed-size rolling mean. Preallocated once; push()/mean() never allocate. */
interface RollingMean {
  push(value: number): void;
  mean(): number;
  hasSamples(): boolean;
  reset(): void;
}

function createRollingMean(size: number): RollingMean {
  const buf = new Float64Array(size);
  let head = 0;
  let filled = 0;
  let sum = 0;
  return {
    push(value: number): void {
      if (filled < size) {
        sum += value;
        filled++;
      } else {
        sum += value - buf[head];
      }
      buf[head] = value;
      head = (head + 1) % size;
    },
    mean(): number {
      return filled === 0 ? 0 : sum / filled;
    },
    hasSamples(): boolean {
      return filled > 0;
    },
    reset(): void {
      buf.fill(0);
      head = 0;
      filled = 0;
      sum = 0;
    },
  };
}

/**
 * How many `TIME_ELAPSED_EXT` queries may be in flight before `begin()`
 * silently skips a frame's query rather than stall on the async result
 * queue -- a query issued this frame is never readable this frame, per the
 * extension's spec, so there is always at least one in flight. Four is
 * headroom past that without holding a result long enough to read stale on
 * the overlay.
 */
const GPU_QUERY_POOL_SIZE = 4;

interface GpuTimer {
  /** Issues a new query if the pool has a free slot; a no-op otherwise, or when the extension is unavailable. */
  begin(): void;
  /** Ends whichever query begin() issued this frame, if any. */
  end(): void;
  /** Checks every in-flight query for a ready result and folds it into the
   * rolling mean, discarding any result GPU_DISJOINT_EXT marks invalid. */
  poll(): void;
  /** null when the extension is unavailable or the rolling mean is empty (including right after reset()). */
  gpuMeanMs(): number | null;
  /** Clears the rolling mean, so re-enabling the timer never flashes a stale pre-disable number. */
  reset(): void;
  /** Releases the pooled GL query objects. */
  dispose(): void;
}

/**
 * `EXT_disjoint_timer_query_webgl2`, wrapped around `composer.render` in
 * `render()` below, with the extension's own async result queue: a query's
 * result is read back on a later frame, never the one that issued it, and
 * `GPU_DISJOINT_EXT` is checked on every poll so a disjoint frame (a GL
 * error, a context reset) is dropped rather than shown as a wrong number.
 * When the extension is missing altogether, every method here is a
 * documented no-op and `gpuMeanMs()` stays `null` forever, which is what
 * makes the overlay print `n/a` instead of guessing.
 */
function createGpuTimer(renderer: THREE.WebGLRenderer): GpuTimer {
  const gl = renderer.getContext();
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const gl2 = gl as WebGL2RenderingContext;
  const ext = isWebGL2
    ? (gl2.getExtension('EXT_disjoint_timer_query_webgl2') as {
        TIME_ELAPSED_EXT: number;
        GPU_DISJOINT_EXT: number;
      } | null)
    : null;

  const queries: WebGLQuery[] = [];
  const busy: boolean[] = [];
  if (ext) {
    for (let i = 0; i < GPU_QUERY_POOL_SIZE; i++) {
      const q = gl2.createQuery();
      if (q) {
        queries.push(q);
        busy.push(false);
      }
    }
  }

  const mean = createRollingMean(TIMING_WINDOW);
  let activeSlot = -1;

  function freeSlot(): number {
    for (let i = 0; i < queries.length; i++) if (!busy[i]) return i;
    return -1;
  }

  return {
    begin(): void {
      if (!ext) return;
      const slot = freeSlot();
      if (slot === -1) return; // pool exhausted this frame; skip rather than stall on readback
      gl2.beginQuery(ext.TIME_ELAPSED_EXT, queries[slot]);
      busy[slot] = true;
      activeSlot = slot;
    },
    end(): void {
      if (!ext || activeSlot === -1) return;
      gl2.endQuery(ext.TIME_ELAPSED_EXT);
      activeSlot = -1;
    },
    poll(): void {
      if (!ext) return;
      for (let i = 0; i < queries.length; i++) {
        if (!busy[i]) continue;
        const q = queries[i];
        if (!gl2.getQueryParameter(q, gl2.QUERY_RESULT_AVAILABLE)) continue;
        const disjoint = gl2.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
        if (!disjoint) {
          const ns = gl2.getQueryParameter(q, gl2.QUERY_RESULT) as number;
          mean.push(ns / 1e6);
        }
        busy[i] = false;
      }
    },
    gpuMeanMs(): number | null {
      if (!ext || !mean.hasSamples()) return null;
      return mean.mean();
    },
    reset(): void {
      mean.reset();
    },
    dispose(): void {
      for (const q of queries) gl2.deleteQuery(q);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

/**
 * Composer chain: render -> bloom -> raw copy to the canvas.
 *
 * Targets are RGBA8 with standard multisampling. 8-bit rather than the
 * composer's default half float because multisampled half float targets are
 * not renderable on every GPU, whereas RGBA8 MSAA is core WebGL2. The only
 * cost is that over-range highlights clamp to 1.0, which the bloom knee above
 * is sized for.
 */
export function createPostFx(renderer: THREE.WebGLRenderer, quality: Quality): PostFx {
  let composer: EffectComposer | null = null;
  let renderPass: RenderPass | null = null;
  let bloomPass: UnrealBloomPass | null = null;
  let copyPass: ShaderPass | null = null;
  let patchedScene: THREE.Scene | null = null;

  const size = renderer.getSize(new THREE.Vector2());
  let width = size.x;
  let height = size.y;

  // The composer issues several internal renderer.render() calls per frame
  // (render pass, bloom's blur passes, the copy pass), each of which would
  // otherwise reset renderer.info.render.calls before the frame's total could
  // be read for the dev overlay -- see render() below, which resets it itself
  // exactly once per outer frame.
  renderer.info.autoReset = false;

  const gpuTimer = createGpuTimer(renderer);
  const cpuMean = createRollingMean(TIMING_WINDOW);
  const callsMean = createRollingMean(TIMING_WINDOW);
  let timingEnabled = false;

  function applySize(): void {
    if (!composer || !bloomPass) return;
    const pixelRatio = renderer.getPixelRatio();
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    const bufferWidth = width * pixelRatio;
    const scale = pixelRatio * Math.min(1, quality.bloomMaxWidth / Math.max(1, bufferWidth));
    bloomPass.setSize(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    );
  }

  function build(scene: THREE.Scene, camera: THREE.Camera): EffectComposer {
    // `main.ts` asks for an antialiased context. Composer targets default to no
    // multisampling, so without this the composer silently drops MSAA and the
    // ocean's wave detail starts to crawl. Costs nothing when AA is off.
    const attributes = renderer.getContext().getContextAttributes();
    const samples = attributes?.antialias ? Math.min(4, renderer.capabilities.maxSamples) : 0;

    const pixelRatio = renderer.getPixelRatio();
    const target = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(width * pixelRatio)),
      Math.max(1, Math.round(height * pixelRatio)),
      {
        type: THREE.UnsignedByteType,
        samples,
        depthBuffer: true,
        stencilBuffer: false,
      },
    );
    target.texture.name = 'postfx.scene';

    const built = new EffectComposer(renderer, target);
    composer = built;

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
      // Materials must be patched before their first compile, and the scene is
      // only known here. Patching is idempotent, so a scene swap re-runs it.
      if (patchedScene !== scene) {
        patchSceneMaterials(scene);
        patchedScene = scene;
      }

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

      // Reset once per outer frame -- see the note on renderer.info.autoReset
      // above -- so the dev overlay's draw-call count is the composer's whole
      // chain, not whichever internal pass rendered last.
      renderer.info.reset();
      const cpuStart = performance.now();
      if (timingEnabled) gpuTimer.begin();
      active.render(dt);
      if (timingEnabled) gpuTimer.end();
      cpuMean.push(performance.now() - cpuStart);
      callsMean.push(renderer.info.render.calls);
      gpuTimer.poll();
    },

    adopt(root: THREE.Object3D): void {
      patchSceneMaterials(root);
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

    getStats(): GpuFrameStats {
      return {
        gpuMs: timingEnabled ? gpuTimer.gpuMeanMs() : null,
        cpuMs: cpuMean.mean(),
        calls: callsMean.mean(),
      };
    },

    setTimingEnabled(enabled: boolean): void {
      if (enabled === timingEnabled) return;
      timingEnabled = enabled;
      gpuTimer.reset();
    },

    dispose(): void {
      bloomPass?.dispose();
      copyPass?.dispose();
      composer?.dispose();
      gpuTimer.dispose();
      composer = null;
      renderPass = null;
      bloomPass = null;
      copyPass = null;
      patchedScene = null;
    },
  };
}
