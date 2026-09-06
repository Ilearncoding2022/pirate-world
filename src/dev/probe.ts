/**
 * `?probe=wave` -- the CPU/GPU wave-field parity harness.
 *
 * Renders a 128x128 quad with the SAME GLSL `waveField` chunk `water.ts` and
 * `waterpatch.ts` paste into their own shaders (swell + wave layers, motion
 * = 1, a fixed pair of offsets, never chop) over a small fixed patch of
 * directions around lon 0, encoded as grey. Puts the identical 128x128 grid
 * of CPU samples (`wavefield.ts`'s `waveHeight`, same offsets, same
 * encoding) on `window.__pirateWorld.probe`.
 *
 * `tests/smoke/wave-parity.spec.ts` loads this, screenshots the canvas,
 * decodes the PNG, and asserts the two agree within 3/255 at every pixel --
 * the whole point of Phase 1 stream B: the hull rides the sea the player
 * actually sees.
 *
 * This file is the only one allowed to reference a probe. `main.ts` imports
 * it dynamically, behind the `?probe=wave` check, so a normal load never
 * fetches this module at all (Vite code-splits it into its own chunk).
 */
import * as THREE from 'three';
import { NOISE_GLSL } from '../noiseglsl';
import { waterWavefield } from '../waterglsl';
import { SWELL_WAVELENGTH, WAVE_WAVELENGTH, CHOP_WAVELENGTH, freq } from '../waveconstants';
import { waveHeight } from '../wavefield';

/** Canvas size in pixels, and the number of CPU samples taken to match it 1:1. */
const PROBE_SIZE = 128;

/**
 * Fixed integrated wave-layer offsets the probe freezes the field at,
 * direction-space units (already the shader's own units -- see `water.ts`'s
 * `uOffsetSwell`/`uOffsetWave` comment). Arbitrary but identical on the GPU
 * and CPU side, which is the entire point of the comparison.
 */
const PROBE_OFFSET_SWELL: [number, number, number] = [0.083, -0.041, 0.062];
const PROBE_OFFSET_WAVE: [number, number, number] = [-0.027, 0.058, 0.014];

/** Half-span of the probed lat/lon patch, degrees -- "a fixed patch of directions around lon 0". */
const PROBE_SPAN_DEG = 6;

/** Maps a raw waveField() value (empirically within roughly [-1.5, 1.5]) into [0, 1] for an 8-bit grey encode. */
function encode(h: number): number {
  const F = Math.fround;
  return Math.min(1, Math.max(0, F(F(h * 0.3) + 0.5)));
}

export function runProbe(): void {
  // preserveDrawingBuffer: this renders exactly once and never runs a
  // requestAnimationFrame loop -- without it, the browser is free to clear
  // the drawing buffer on the next compositor pass, and the smoke test's
  // screenshot (which lands well after that) would capture a cleared canvas
  // instead of the frame actually rendered below.
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(PROBE_SIZE, PROBE_SIZE, true);
  // Raw output: this is a numeric encode/decode round trip, not a picture,
  // so nothing here should go through an sRGB transfer function. Three's
  // default `outputColorSpace` (SRGBColorSpace) is left as-is deliberately:
  // a `<canvas>` is always presented by the browser as sRGB, so that default
  // is what makes a direct `gl.readPixels` and an external screenshot agree
  // -- overriding it to LinearSRGBColorSpace made the two disagree instead.
  /*
   * index.html's static HUD markup (the `.hud` overlay, its glassy panels)
   * exists regardless of which branch of `main.ts` runs, and it is
   * `position: fixed` over the whole viewport with its own z-index. A canvas
   * merely appended to `document.body` sits in the ordinary document flow
   * beneath that, so a screenshot would show the HUD's translucent panels
   * blended over this canvas rather than the canvas itself -- the numbers
   * still decode right off a direct `gl.readPixels`, which is what made this
   * one confusing to find. Lifting the canvas onto its own fixed, top layer
   * is this module's own concern and touches no shared file.
   */
  const canvas = renderer.domElement;
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '0';
  // Not `inset: 0` -- that would stretch the 128x128 drawing buffer to fill
  // the viewport, blurring every sample through the browser's own upscale
  // filter. Pinned at its natural size instead.
  canvas.style.width = `${PROBE_SIZE}px`;
  canvas.style.height = `${PROBE_SIZE}px`;
  canvas.style.zIndex = '999999';
  document.body.appendChild(canvas);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const scene = new THREE.Scene();

  const spanRad = (PROBE_SPAN_DEG * Math.PI) / 180;

  const vertexShader = ['void main() {', '  gl_Position = vec4(position.xy, 0.0, 1.0);', '}'].join('\n');

  const fragmentShader = [
    'precision highp float;',
    `uniform vec3 uOffsetSwell;`,
    `uniform vec3 uOffsetWave;`,
    `uniform vec3 uOffsetChop;`,
    `uniform float uSize;`,
    `uniform float uSpanRad;`,
    NOISE_GLSL,
    ...waterWavefield(freq(SWELL_WAVELENGTH), freq(WAVE_WAVELENGTH), freq(CHOP_WAVELENGTH)),
    'void main() {',
    // gl_FragCoord.y is 0 at the BOTTOM of the framebuffer; the CPU grid
    // below is built to match this exact mapping, row for row -- see its
    // comment.
    '  vec2 uv = gl_FragCoord.xy / uSize;',
    '  float lon = (uv.x - 0.5) * 2.0 * uSpanRad;',
    '  float lat = (uv.y - 0.5) * 2.0 * uSpanRad;',
    // Not latLonToDir's own sin/cos formula: sin and cos are transcendental
    // and commonly polynomial-approximated per GPU/driver, so a CPU port
    // using the platform math library's sin/cos can differ from the GPU's
    // in the last few bits -- exactly the kind of gap `wave-parity.spec.ts`
    // is built to catch, but not the one it is FOR. sqrt is correctly
    // rounded (to within a ULP or so) on essentially everything, GPUs
    // included, so normalizing a raw vector here instead is what makes the
    // CPU and GPU directions agree as tightly as the noise itself does.
    '  vec3 raw = vec3(lon, 1.0, lat);',
    '  vec3 dir = raw / sqrt(dot(raw, raw));',
    '  float h = waveField(dir, 1.0, 1.0, 0.0);',
    '  float g = clamp(h * 0.3 + 0.5, 0.0, 1.0);',
    '  gl_FragColor = vec4(g, g, g, 1.0);',
    '}',
  ].join('\n');

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uOffsetSwell: { value: new THREE.Vector3(...PROBE_OFFSET_SWELL) },
      uOffsetWave: { value: new THREE.Vector3(...PROBE_OFFSET_WAVE) },
      uOffsetChop: { value: new THREE.Vector3() },
      uSize: { value: PROBE_SIZE },
      uSpanRad: { value: spanRad },
    },
    vertexShader,
    fragmentShader,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  // CPU samples, one per pixel, using the exact inverse of the shader's own
  // gl_FragCoord -> uv -> lon/lat mapping: PNG row 0 (the screenshot's TOP
  // row) is the framebuffer's highest gl_FragCoord.y, i.e. uv.y closest to 1.
  const offsets = {
    swell: { x: PROBE_OFFSET_SWELL[0], y: PROBE_OFFSET_SWELL[1], z: PROBE_OFFSET_SWELL[2] },
    wave: { x: PROBE_OFFSET_WAVE[0], y: PROBE_OFFSET_WAVE[1], z: PROBE_OFFSET_WAVE[2] },
  };
  const dir = new THREE.Vector3();
  const probe: number[][] = [];
  // Float32-rounded at each step, matching the shader's own arithmetic --
  // `waveFieldCPU` already assumes a float32 `dir`, and the trig here is
  // exactly what `gl_FragCoord -> uv -> lon/lat -> dir` costs the GPU too.
  const F = Math.fround;
  const spanRadF = F(spanRad);
  for (let row = 0; row < PROBE_SIZE; row++) {
    const line: number[] = [];
    const uvY = F(F(PROBE_SIZE - row - 0.5) / PROBE_SIZE);
    for (let col = 0; col < PROBE_SIZE; col++) {
      const uvX = F(F(col + 0.5) / PROBE_SIZE);
      const lon = F(F(F(uvX - 0.5) * 2) * spanRadF);
      const lat = F(F(F(uvY - 0.5) * 2) * spanRadF);
      // Mirrors the shader's own raw/sqrt(dot(raw,raw)) normalize exactly --
      // a genuine division, matching the GLSL, not a multiply by a
      // precomputed reciprocal (the two round differently) -- see the
      // fragment shader's comment on why this replaces sin/cos.
      const rawX = lon;
      const rawY = 1.0;
      const rawZ = lat;
      const lenSq = F(F(F(rawX * rawX) + F(rawY * rawY)) + F(rawZ * rawZ));
      const len = F(Math.sqrt(lenSq));
      dir.set(F(rawX / len), F(rawY / len), F(rawZ / len));
      const h = waveHeight(dir, offsets, 1.0);
      line.push(encode(h));
    }
    probe.push(line);
  }

  // Rendered inside a rAF (rather than synchronously at import time) so the
  // very first paint of the page already has somewhere to composite it from.
  requestAnimationFrame(() => {
    renderer.render(scene, camera);
    const w = window as unknown as { __pirateWorld?: Record<string, unknown> };
    w.__pirateWorld = { ...(w.__pirateWorld ?? {}), probe };
  });
}
