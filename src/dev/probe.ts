/**
 * `?probe=wave` and `?probe=hazard` -- the CPU/GPU parity harnesses.
 *
 * Two fields have a CPU port the hull rides and a GLSL original the player
 * sees, and both have to agree to the pixel or the hull quietly stops riding
 * the water it looks like it is riding:
 *
 *   `?probe=wave`   -- `waterglsl.ts`'s `waveField` against `wavefield.ts`.
 *   `?probe=hazard` -- `hazardfield.ts`'s `HAZARD_GLSL` against its own CPU
 *                      `hazardHeight`, over a fixed crest, great crest and
 *                      maelstrom.
 *
 * Each renders a 128x128 quad carrying the SAME GLSL chunk its consumers
 * paste into their own shaders, over a small fixed patch of directions around
 * lon 0, encoded as grey, and puts the identical 128x128 grid of CPU samples
 * on `window.__pirateWorld` -- under `probe` for the wave field, `hazardProbe`
 * for the hazards.
 *
 * `tests/smoke/wave-parity.spec.ts` loads each of them, screenshots the
 * canvas, decodes the PNG, and asserts the two agree within 3/255 at every
 * pixel.
 *
 * This file is the only one allowed to reference a probe. `main.ts` imports
 * it dynamically, behind its `?probe` check, so a normal load never fetches
 * this module at all (Vite code-splits it into its own chunk); which of the
 * two harnesses runs is decided here, off the same query, so the guard over
 * there stays one line.
 */
import * as THREE from 'three';
import { NOISE_GLSL } from '../noiseglsl';
import { waterWavefield } from '../waterglsl';
import { SWELL_WAVELENGTH, WAVE_WAVELENGTH, CHOP_WAVELENGTH, freq } from '../waveconstants';
import { waveHeight } from '../wavefield';
import { GLOBE_RADIUS } from '../geo';
import type { Hazard, HazardKind } from '../types';
import {
  HAZARD_GLSL,
  MAX_HAZARDS,
  CREST_HALF_LENGTH,
  CREST_HALF_WIDTH,
  CREST_HEIGHT,
  CREST_BOW_MAX,
  CREST_HEIGHT_MAX,
  MAELSTROM_RADIUS,
  FUNNEL_DEPTH,
  hazardHeight,
} from '../hazardfield';
import { packHazards } from '../waterhazard';

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

/**
 * The hazard harness gets its own, wider patch: 13 degrees is 45 world units
 * of half-span, and the three hazards below have to fit inside it WITH the
 * ground they fade to nothing over. A 20-unit crest and a 20-unit funnel do
 * not both fit in the wave probe's 21 units, and a profile whose zero edge
 * falls outside the frame is a profile whose edge went untested.
 */
const HAZARD_SPAN_DEG = 13;

/** Maps a raw waveField() value (empirically within roughly [-1.5, 1.5]) into [0, 1] for an 8-bit grey encode. */
function encode(h: number): number {
  const F = Math.fround;
  return Math.min(1, Math.max(0, F(F(h * 0.3) + 0.5)));
}

/**
 * The hazard field's own encode. A funnel goes 3 units down and a great crest
 * 2.4 up, so the eighth-scale is what fits the whole signed range inside the
 * grey ramp with room to spare -- and it costs no precision to check, since
 * an eighth is exact in binary.
 */
function encodeHazard(h: number): number {
  const F = Math.fround;
  return Math.min(1, Math.max(0, F(F(h / 8) + 0.5)));
}

/**
 * The renderer both harnesses draw into, and the canvas they draw it on.
 *
 * preserveDrawingBuffer: this renders exactly once and never runs a
 * requestAnimationFrame loop -- without it, the browser is free to clear the
 * drawing buffer on the next compositor pass, and the smoke test's screenshot
 * (which lands well after that) would capture a cleared canvas instead of the
 * frame actually rendered.
 */
function createProbeRenderer(): THREE.WebGLRenderer {
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
  return renderer;
}

/** The full-screen quad every harness draws: the fragment shader IS the probe. */
function drawProbeQuad(
  renderer: THREE.WebGLRenderer,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
): void {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const scene = new THREE.Scene();
  const vertexShader = ['void main() {', '  gl_Position = vec4(position.xy, 0.0, 1.0);', '}'].join('\n');
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  renderer.render(scene, camera);
}

/** Hands the CPU grid to the smoke test, without disturbing anything already published. */
function publish(key: string, probe: number[][]): void {
  const w = window as unknown as { __pirateWorld?: Record<string, unknown> };
  w.__pirateWorld = { ...(w.__pirateWorld ?? {}), [key]: probe };
}

/**
 * The shader's own `gl_FragCoord -> uv -> lon/lat -> dir` mapping, in
 * float32, for one pixel of the CPU grid.
 *
 * Mirrors the fragment shader's raw/sqrt(dot(raw,raw)) normalize exactly -- a
 * genuine division, matching the GLSL, not a multiply by a precomputed
 * reciprocal (the two round differently) -- see the fragment shader's comment
 * on why this replaces sin/cos.
 */
function probeDir(row: number, col: number, spanRadF: number, out: THREE.Vector3): void {
  const F = Math.fround;
  const uvY = F(F(PROBE_SIZE - row - 0.5) / PROBE_SIZE);
  const uvX = F(F(col + 0.5) / PROBE_SIZE);
  const lon = F(F(F(uvX - 0.5) * 2) * spanRadF);
  const lat = F(F(F(uvY - 0.5) * 2) * spanRadF);
  const rawX = lon;
  const rawY = 1.0;
  const rawZ = lat;
  const lenSq = F(F(F(rawX * rawX) + F(rawY * rawY)) + F(rawZ * rawZ));
  const len = F(Math.sqrt(lenSq));
  out.set(F(rawX / len), F(rawY / len), F(rawZ / len));
}

/**
 * The lines every harness's fragment shader opens with: the same
 * gl_FragCoord -> direction mapping, so `dir` is in scope for the field under
 * test and `probeDir` above is the one CPU twin of it.
 *
 * gl_FragCoord.y is 0 at the BOTTOM of the framebuffer; the CPU grids are
 * built to match that mapping, row for row.
 *
 * The direction is built by normalizing a raw vector rather than by
 * latLonToDir's own sin/cos: sin and cos are transcendental and commonly
 * polynomial-approximated per GPU/driver, so a CPU port using the platform
 * math library's sin/cos can differ from the GPU's in the last few bits --
 * exactly the kind of gap `wave-parity.spec.ts` is built to catch, but not
 * the one it is FOR. sqrt is correctly rounded (to within a ULP or so) on
 * essentially everything, GPUs included, so normalizing here instead is what
 * makes the CPU and GPU directions agree as tightly as the field itself does.
 */
const PROBE_DIR_GLSL: string[] = [
  '  vec2 uv = gl_FragCoord.xy / uSize;',
  '  float lon = (uv.x - 0.5) * 2.0 * uSpanRad;',
  '  float lat = (uv.y - 0.5) * 2.0 * uSpanRad;',
  '  vec3 raw = vec3(lon, 1.0, lat);',
  '  vec3 dir = raw / sqrt(dot(raw, raw));',
];

/* ------------------------------------------------------------------ */
/* ?probe=wave                                                          */
/* ------------------------------------------------------------------ */

function runWaveProbe(): void {
  const renderer = createProbeRenderer();

  const spanRad = (PROBE_SPAN_DEG * Math.PI) / 180;

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
    ...PROBE_DIR_GLSL,
    '  float h = waveField(dir, 1.0, 1.0, 0.0);',
    '  float g = clamp(h * 0.3 + 0.5, 0.0, 1.0);',
    '  gl_FragColor = vec4(g, g, g, 1.0);',
    '}',
  ].join('\n');

  const uniforms: Record<string, THREE.IUniform> = {
    uOffsetSwell: { value: new THREE.Vector3(...PROBE_OFFSET_SWELL) },
    uOffsetWave: { value: new THREE.Vector3(...PROBE_OFFSET_WAVE) },
    uOffsetChop: { value: new THREE.Vector3() },
    uSize: { value: PROBE_SIZE },
    uSpanRad: { value: spanRad },
  };

  // CPU samples, one per pixel, using the exact inverse of the shader's own
  // gl_FragCoord -> uv -> lon/lat mapping: PNG row 0 (the screenshot's TOP
  // row) is the framebuffer's highest gl_FragCoord.y, i.e. uv.y closest to 1.
  const offsets = {
    swell: { x: PROBE_OFFSET_SWELL[0], y: PROBE_OFFSET_SWELL[1], z: PROBE_OFFSET_SWELL[2] },
    wave: { x: PROBE_OFFSET_WAVE[0], y: PROBE_OFFSET_WAVE[1], z: PROBE_OFFSET_WAVE[2] },
  };
  const dir = new THREE.Vector3();
  const probe: number[][] = [];
  const spanRadF = Math.fround(spanRad);
  for (let row = 0; row < PROBE_SIZE; row++) {
    const line: number[] = [];
    for (let col = 0; col < PROBE_SIZE; col++) {
      probeDir(row, col, spanRadF, dir);
      line.push(encode(waveHeight(dir, offsets, 1.0)));
    }
    probe.push(line);
  }

  // Rendered inside a rAF (rather than synchronously at import time) so the
  // very first paint of the page already has somewhere to composite it from.
  requestAnimationFrame(() => {
    drawProbeQuad(renderer, fragmentShader, uniforms);
    publish('probe', probe);
  });
}

/* ------------------------------------------------------------------ */
/* ?probe=hazard                                                        */
/* ------------------------------------------------------------------ */

/**
 * Where the three hazards sit on the probed patch, in world units across
 * (`lon`) and up (`lat`) from its centre, and how far each one's frame is
 * turned within its own tangent plane.
 *
 * One of every profile the field can draw, laid out so that all three, and
 * the ground each fades to nothing over, land inside the 45-unit half-span:
 * a tall crest square to the patch and BOWED to the limit of the range, a
 * shorter straight one turned 45 degrees so the dot products are exercised
 * off-axis, and a maelstrom at nine tenths of full size so the
 * `extent * size` path is exercised too. The envelopes are deliberately not
 * 1: a probe that only ever multiplied by one would not notice a side that
 * had dropped the envelope entirely.
 *
 * The two crests carry DIFFERENT bows, and both cases matter. The bowed one
 * is the arithmetic itself: `hazBowV` is one more multiply-add in each port
 * and float32 is not associative, so a transcription that reordered it would
 * show up here and nowhere else. The straight one is the claim that a zero
 * bow costs nothing -- `0.0 * a * anything` is exactly zero on both sides, so
 * that crest has to come back bit-for-bit the crest this probe measured
 * before the bow existed.
 *
 * They do not overlap. Two hazards summing is arithmetic the loop does
 * anyway; three profiles each drawn wrong in its own way is what this is
 * looking for, and overlap would only hide it.
 */
interface Placement {
  readonly kind: HazardKind;
  readonly lon: number;
  readonly lat: number;
  readonly turn: number;
  readonly extent: number;
  readonly halfWidth: number;
  readonly bow: number;
  readonly breakNeg: number;
  readonly breakPos: number;
  readonly amplitude: number;
  readonly envelope: number;
  readonly size: number;
}

const HAZARD_PLACEMENTS: readonly Placement[] = [
  {
    kind: 'wave',
    lon: 0,
    lat: 26,
    turn: 0,
    extent: CREST_HALF_LENGTH,
    halfWidth: CREST_HALF_WIDTH,
    bow: CREST_BOW_MAX,
    // Broken at one end and whole at the other, deliberately asymmetric: the
    // taper reads a DIFFERENT number per end off one vec2, so a probe that
    // broke both ends equally would pass just as happily with the two lanes
    // swapped. Fully broken, because 1 is where `1 - t * x * x` reaches zero
    // at the tip and is the one value that can expose a sign error.
    breakNeg: 0,
    breakPos: 1,
    amplitude: CREST_HEIGHT_MAX,
    envelope: 0.85,
    size: 1,
  },
  {
    kind: 'wave',
    lon: -26,
    lat: -18,
    turn: Math.PI / 4,
    extent: CREST_HALF_LENGTH,
    halfWidth: CREST_HALF_WIDTH,
    bow: 0,
    // The other lane, and a partial value: between them the two crests cover
    // both ends, both extremes and a middle.
    breakNeg: 0.45,
    breakPos: 0,
    amplitude: CREST_HEIGHT,
    envelope: 1,
    size: 1,
  },
  {
    kind: 'maelstrom',
    lon: 24,
    lat: -20,
    turn: 0.6,
    extent: MAELSTROM_RADIUS,
    halfWidth: 0,
    bow: 0,
    // Nonzero on a funnel ON PURPOSE. The accessors force a maelstrom's break
    // to 0, so this is what proves they do: if either port ever read the raw
    // field instead, this funnel would come out lopsided on that side alone.
    breakNeg: 0.8,
    breakPos: 0.8,
    amplitude: FUNNEL_DEPTH,
    envelope: 0.75,
    size: 0.9,
  },
];

/**
 * Builds the placements into real `Hazard` objects -- the same shape
 * `hazards.ts` hands the plugin and the hull, so both sides of this probe are
 * fed exactly the way the game feeds them.
 *
 * The tangent pair at each centre is world X projected onto that centre's
 * tangent plane, crossed with the centre, then turned by `turn` inside the
 * plane. Any orthonormal pair would do: what the field cares about is that
 * `east` and `north` are unit, perpendicular, and perpendicular to `centre`.
 */
function buildProbeHazards(): Hazard[] {
  return HAZARD_PLACEMENTS.map((p) => {
    const centre = new THREE.Vector3(p.lon / GLOBE_RADIUS, 1, p.lat / GLOBE_RADIUS).normalize();
    const e0 = new THREE.Vector3(1, 0, 0).addScaledVector(centre, -centre.x).normalize();
    const n0 = new THREE.Vector3().crossVectors(centre, e0).normalize();
    const c = Math.cos(p.turn);
    const s = Math.sin(p.turn);
    const east = e0.clone().multiplyScalar(c).addScaledVector(n0, s).normalize();
    const north = n0.clone().multiplyScalar(c).addScaledVector(e0, -s).normalize();
    return {
      kind: p.kind,
      centre,
      east,
      north,
      extent: p.extent,
      halfWidth: p.halfWidth,
      bow: p.bow,
      breakNeg: p.breakNeg,
      breakPos: p.breakPos,
      // Not read by the field at all -- it is what makes a crest travel, and
      // nothing travels in a probe -- but `Hazard` is the shape the game
      // hands the plugin and this harness feeds both sides the real thing.
      speed: 0,
      amplitude: p.amplitude,
      envelope: p.envelope,
      size: p.size,
      age: 0,
      consumed: false,
    };
  });
}

function runHazardProbe(): void {
  const renderer = createProbeRenderer();

  const spanRad = (HAZARD_SPAN_DEG * Math.PI) / 180;
  const hazards = buildProbeHazards();

  const centres: THREE.Vector3[] = [];
  const easts: THREE.Vector3[] = [];
  const norths: THREE.Vector3[] = [];
  const shapes: THREE.Vector4[] = [];
  const bows: number[] = [];
  const breaks: THREE.Vector2[] = [];
  for (let i = 0; i < MAX_HAZARDS; i++) {
    bows.push(0);
    breaks.push(new THREE.Vector2());
    centres.push(new THREE.Vector3(0, 1, 0));
    easts.push(new THREE.Vector3(1, 0, 0));
    norths.push(new THREE.Vector3(0, 0, 1));
    shapes.push(new THREE.Vector4());
  }
  // `waterhazard.ts`'s own packing, not a copy of it: the uniforms under test
  // are then the uniforms the game ships, down to which float32 each number
  // rounds to.
  const count = packHazards(hazards, centres, easts, norths, shapes, bows, breaks);

  const fragmentShader = [
    'precision highp float;',
    'uniform float uSize;',
    'uniform float uSpanRad;',
    HAZARD_GLSL,
    'void main() {',
    ...PROBE_DIR_GLSL,
    '  float h = hazardHeight(dir);',
    '  float g = clamp(h / 8.0 + 0.5, 0.0, 1.0);',
    '  gl_FragColor = vec4(g, g, g, 1.0);',
    '}',
  ].join('\n');

  const uniforms: Record<string, THREE.IUniform> = {
    uSize: { value: PROBE_SIZE },
    uSpanRad: { value: spanRad },
    uHazCount: { value: count },
    uHazCentre: { value: centres },
    uHazEast: { value: easts },
    uHazNorth: { value: norths },
    uHazShape: { value: shapes },
    uHazBow: { value: bows },
    uHazBreak: { value: breaks },
  };

  const dir = new THREE.Vector3();
  const probe: number[][] = [];
  const spanRadF = Math.fround(spanRad);
  for (let row = 0; row < PROBE_SIZE; row++) {
    const line: number[] = [];
    for (let col = 0; col < PROBE_SIZE; col++) {
      probeDir(row, col, spanRadF, dir);
      line.push(encodeHazard(hazardHeight(dir, hazards)));
    }
    probe.push(line);
  }

  requestAnimationFrame(() => {
    drawProbeQuad(renderer, fragmentShader, uniforms);
    publish('hazardProbe', probe);
  });
}

/**
 * Dispatches on `?probe` itself rather than taking an argument, so `main.ts`
 * keeps one guarded line for however many harnesses end up living here.
 * Anything but `hazard` is the wave field, which is what the single caller
 * behind `?probe=wave` has always got.
 */
export function runProbe(): void {
  const which = new URLSearchParams(window.location.search).get('probe');
  if (which === 'hazard') {
    runHazardProbe();
    return;
  }
  runWaveProbe();
}
