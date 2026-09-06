/**
 * CPU port of the GLSL wave field (`waterglsl.ts`'s `waveField`/`snoise`),
 * for the swell and wave layers only -- never chop, which stays fragment-side
 * (see `waterpatch.ts`'s module comment). This is what lets `ship.ts` heave,
 * pitch and roll on the SAME surface the player sees instead of on a fixed
 * sine, and what `dev/probe.ts` checks against the GPU pixel for pixel.
 *
 * Transcribed line for line from `noiseglsl.ts`'s Ashima/Gustavson `snoise`
 * and `waterglsl.ts`'s `waveField`, then every arithmetic step rounded to
 * float32 with `Math.fround` (see the note further down) to match the
 * shader's own `highp float` precision exactly rather than running the
 * smoother float64 arithmetic JS would otherwise use. The Ashima permutation
 * `((x * 34.0) + 1.0) * x` mod 289 has a largest intermediate around 2.8
 * million, far under the 16.7 million where float32 stops representing
 * integers exactly, so the permutation itself is integer-exact regardless;
 * the `Math.fround` wrapping is for the smooth arithmetic around it, which
 * is NOT safe to leave at float64 -- see below for why. Parity is checked by
 * `tests/smoke/wave-parity.spec.ts` via `dev/probe.ts` (measured: within
 * 1/255 at every one of a probe's 16,384 samples).
 *
 * Every frequency and axis is imported from `waveconstants.ts`, the single
 * source both this file and `waterglsl.ts` read, so the two can never
 * numerically drift apart.
 */
import { Vector3 } from 'three';
import {
  SWELL_WAVELENGTH,
  WAVE_WAVELENGTH,
  AXIS_WAVE,
  freqNumber,
} from './waveconstants';
import { GLOBE_RADIUS } from './geo';

/**
 * Step used for the finite difference that reconstructs the wave gradient in
 * `sampleWave`, in world units, converted to direction-space below.
 *
 * Mirrors `water.ts`'s private `NORMAL_STEP` (0.16 world units): duplicated
 * rather than imported because this stream's one permitted edit to
 * `water.ts` is the read-only `offsets` export, nothing else in that file.
 * Keep the two in sync by hand if `NORMAL_STEP` is ever retuned.
 */
const NORMAL_STEP_WORLD = 0.16;
const NORMAL_STEP_DIR = NORMAL_STEP_WORLD / GLOBE_RADIUS;

/** The three wave layers' integrated drift, direction-space -- see `water.offsets`. */
export interface WaveOffsets {
  readonly swell: { x: number; y: number; z: number };
  readonly wave: { x: number; y: number; z: number };
}

/** One sample of the field: height and its tangent-plane gradient. */
export interface WaveSample {
  h: number;
  gu: number;
  gv: number;
}

/* ------------------------------------------------------------------ */
/* Ashima / Gustavson simplex noise, transcribed from noiseglsl.ts      */
/* ------------------------------------------------------------------ */

/*
 * Every arithmetic result below is rounded through `F` (`Math.fround`) to
 * float32, matching the shader's own `highp float` precision step for step.
 * This is not paranoia: two ties this close together are common enough to
 * matter (see the module comment), specifically the `h <= 0` corner-rejection
 * test a few dozen lines down. `h` there is a difference of near-cancelling
 * terms that legitimately lands within double-precision epsilon of zero on a
 * meaningful fraction of real inputs; float64 and float32 arithmetic then
 * round its sign two different ways, which flips which lattice corner's
 * gradient contributes at all and swings the whole return value by up to a
 * unit or more -- not a rare edge case at these frequencies, and not fixable
 * by a looser comparison tolerance, since the two SIDES of the tie are
 * genuinely different numbers. Rounding every step to float32 here, the same
 * way the GPU already does, makes both sides land on the same side of every
 * such tie by construction. Verified against the actual shader running on
 * SwiftShader (a throwaway WebGL2 harness reading a float32 render target)
 * value for value at every intermediate above.
 */
const F = Math.fround;

function mod289(x: number): number {
  return F(x - F(Math.floor(F(x * F(1.0 / 289.0))) * 289.0));
}

function permute(x: number): number {
  return mod289(F(F(F(x * 34.0) + 1.0) * x));
}

function taylorInvSqrt(r: number): number {
  return F(1.79284291400159 - F(0.85373472095314 * r));
}

function step(edge: number, x: number): number {
  return x < edge ? 0 : 1;
}

/**
 * `snoise(v)` from `noiseglsl.ts`, transcribed line for line -- see the
 * float32-rounding note above for why every step is wrapped in `F`.
 * Deterministic -- see `tests/unit/wavefield.test.ts`.
 */
export function snoise(vx: number, vy: number, vz: number): number {
  const C0 = F(0.16666666666);
  const C1 = F(0.33333333333);
  // D = (0.0, 0.5, 1.0, 2.0), referenced by component below.

  // vec3 i = floor(v + dot(v, C.yyy));
  const s = F(F(F(F(vx + vy) + vz)) * C1);
  let ix = Math.floor(F(vx + s));
  let iy = Math.floor(F(vy + s));
  let iz = Math.floor(F(vz + s));

  // vec3 x0 = v - i + dot(i, C.xxx);
  const sx = F(F(F(ix + iy) + iz) * C0);
  const x0x = F(F(vx - ix) + sx);
  const x0y = F(F(vy - iy) + sx);
  const x0z = F(F(vz - iz) + sx);

  // vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g;
  const gx = step(x0y, x0x);
  const gy = step(x0z, x0y);
  const gz = step(x0x, x0z);
  const lx = F(1.0 - gx);
  const ly = F(1.0 - gy);
  const lz = F(1.0 - gz);

  // vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);
  const i1x = Math.min(gx, lz);
  const i1y = Math.min(gy, lx);
  const i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz);
  const i2y = Math.max(gy, lx);
  const i2z = Math.max(gz, ly);

  // vec3 x1 = x0 - i1 + C.xxx;
  const x1x = F(F(x0x - i1x) + C0);
  const x1y = F(F(x0y - i1y) + C0);
  const x1z = F(F(x0z - i1z) + C0);
  // vec3 x2 = x0 - i2 + C.yyy;
  const x2x = F(F(x0x - i2x) + C1);
  const x2y = F(F(x0y - i2y) + C1);
  const x2z = F(F(x0z - i2z) + C1);
  // vec3 x3 = x0 - D.yyy; (D.y = 0.5)
  const x3x = F(x0x - 0.5);
  const x3y = F(x0y - 0.5);
  const x3z = F(x0z - 0.5);

  // i = mod289(i);
  ix = mod289(ix);
  iy = mod289(iy);
  iz = mod289(iz);

  // vec4 p = permute(permute(permute(i.z + vec4(0,i1.z,i2.z,1)) + i.y + vec4(0,i1.y,i2.y,1)) + i.x + vec4(0,i1.x,i2.x,1));
  let p0 = permute(F(iz + 0.0));
  let p1 = permute(F(iz + i1z));
  let p2 = permute(F(iz + i2z));
  let p3 = permute(F(iz + 1.0));

  p0 = permute(F(F(p0 + iy) + 0.0));
  p1 = permute(F(F(p1 + iy) + i1y));
  p2 = permute(F(F(p2 + iy) + i2y));
  p3 = permute(F(F(p3 + iy) + 1.0));

  p0 = permute(F(F(p0 + ix) + 0.0));
  p1 = permute(F(F(p1 + ix) + i1x));
  p2 = permute(F(F(p2 + ix) + i2x));
  p3 = permute(F(F(p3 + ix) + 1.0));

  // float n_ = 0.142857142857; vec3 ns = n_ * D.wyz - D.xzx;
  const n_ = 0.142857142857;
  // D.wyz = (2.0, 0.5, 1.0); D.xzx = (0.0, 1.0, 0.0)
  const nsX = F(F(n_ * 2.0) - 0.0);
  const nsY = F(F(n_ * 0.5) - 1.0);
  const nsZ = F(F(n_ * 1.0) - 0.0);

  // vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  const j0 = F(p0 - F(49.0 * Math.floor(F(F(p0 * nsZ) * nsZ))));
  const j1 = F(p1 - F(49.0 * Math.floor(F(F(p1 * nsZ) * nsZ))));
  const j2 = F(p2 - F(49.0 * Math.floor(F(F(p2 * nsZ) * nsZ))));
  const j3 = F(p3 - F(49.0 * Math.floor(F(F(p3 * nsZ) * nsZ))));

  // vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);
  const x_0 = Math.floor(F(j0 * nsZ));
  const x_1 = Math.floor(F(j1 * nsZ));
  const x_2 = Math.floor(F(j2 * nsZ));
  const x_3 = Math.floor(F(j3 * nsZ));
  const y_0 = Math.floor(F(j0 - F(7.0 * x_0)));
  const y_1 = Math.floor(F(j1 - F(7.0 * x_1)));
  const y_2 = Math.floor(F(j2 - F(7.0 * x_2)));
  const y_3 = Math.floor(F(j3 - F(7.0 * x_3)));

  // vec4 x = x_ * ns.x + ns.yyyy; vec4 y = y_ * ns.x + ns.yyyy;
  const x0v = F(F(x_0 * nsX) + nsY);
  const x1v = F(F(x_1 * nsX) + nsY);
  const x2v = F(F(x_2 * nsX) + nsY);
  const x3v = F(F(x_3 * nsX) + nsY);
  const y0v = F(F(y_0 * nsX) + nsY);
  const y1v = F(F(y_1 * nsX) + nsY);
  const y2v = F(F(y_2 * nsX) + nsY);
  const y3v = F(F(y_3 * nsX) + nsY);

  // vec4 h = 1.0 - abs(x) - abs(y);
  const h0 = F(F(1.0 - Math.abs(x0v)) - Math.abs(y0v));
  const h1 = F(F(1.0 - Math.abs(x1v)) - Math.abs(y1v));
  const h2 = F(F(1.0 - Math.abs(x2v)) - Math.abs(y2v));
  const h3 = F(F(1.0 - Math.abs(x3v)) - Math.abs(y3v));

  // vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);
  const b0 = [x0v, x1v, y0v, y1v] as const;
  const b1 = [x2v, x3v, y2v, y3v] as const;

  // vec4 s0 = floor(b0) * 2.0 + 1.0; vec4 s1 = floor(b1) * 2.0 + 1.0;
  const s0 = b0.map((v) => F(F(Math.floor(v) * 2.0) + 1.0));
  const s1 = b1.map((v) => F(F(Math.floor(v) * 2.0) + 1.0));

  // vec4 sh = -step(h, vec4(0.0));
  // step(h_i, 0.0) in GLSL: edge=h_i, x=0.0 -> 1 if 0>=h_i i.e h_i<=0, else 0.
  const sh = [-(h0 <= 0.0 ? 1 : 0), -(h1 <= 0.0 ? 1 : 0), -(h2 <= 0.0 ? 1 : 0), -(h3 <= 0.0 ? 1 : 0)];

  // vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  // b0 = (x0,x1,y0,y1) -> b0.xzyw = (b0.x, b0.z, b0.y, b0.w) = (x0, y0, x1, y1)
  const b0_xzyw = [b0[0], b0[2], b0[1], b0[3]];
  const s0_xzyw = [s0[0], s0[2], s0[1], s0[3]];
  const sh_xxyy = [sh[0], sh[0], sh[1], sh[1]];
  const a0 = [
    F(b0_xzyw[0] + F(s0_xzyw[0] * sh_xxyy[0])),
    F(b0_xzyw[1] + F(s0_xzyw[1] * sh_xxyy[1])),
    F(b0_xzyw[2] + F(s0_xzyw[2] * sh_xxyy[2])),
    F(b0_xzyw[3] + F(s0_xzyw[3] * sh_xxyy[3])),
  ];

  // vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  const b1_xzyw = [b1[0], b1[2], b1[1], b1[3]];
  const s1_xzyw = [s1[0], s1[2], s1[1], s1[3]];
  const sh_zzww = [sh[2], sh[2], sh[3], sh[3]];
  const a1 = [
    F(b1_xzyw[0] + F(s1_xzyw[0] * sh_zzww[0])),
    F(b1_xzyw[1] + F(s1_xzyw[1] * sh_zzww[1])),
    F(b1_xzyw[2] + F(s1_xzyw[2] * sh_zzww[2])),
    F(b1_xzyw[3] + F(s1_xzyw[3] * sh_zzww[3])),
  ];

  // vec3 p0 = vec3(a0.xy, h.x); vec3 p1 = vec3(a0.zw, h.y);
  // vec3 p2 = vec3(a1.xy, h.z); vec3 p3 = vec3(a1.zw, h.w);
  let px0 = a0[0], py0 = a0[1], pz0 = h0;
  let px1 = a0[2], py1 = a0[3], pz1 = h1;
  let px2 = a1[0], py2 = a1[1], pz2 = h2;
  let px3 = a1[2], py3 = a1[3], pz3 = h3;

  // vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  const dot3 = (x: number, y: number, z: number, x2: number, y2: number, z2: number): number =>
    F(F(F(x * x2) + F(y * y2)) + F(z * z2));
  const norm0 = taylorInvSqrt(dot3(px0, py0, pz0, px0, py0, pz0));
  const norm1 = taylorInvSqrt(dot3(px1, py1, pz1, px1, py1, pz1));
  const norm2 = taylorInvSqrt(dot3(px2, py2, pz2, px2, py2, pz2));
  const norm3 = taylorInvSqrt(dot3(px3, py3, pz3, px3, py3, pz3));

  // p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  px0 = F(px0 * norm0); py0 = F(py0 * norm0); pz0 = F(pz0 * norm0);
  px1 = F(px1 * norm1); py1 = F(py1 * norm1); pz1 = F(pz1 * norm1);
  px2 = F(px2 * norm2); py2 = F(py2 * norm2); pz2 = F(pz2 * norm2);
  px3 = F(px3 * norm3); py3 = F(py3 * norm3); pz3 = F(pz3 * norm3);

  // vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  const dx0 = dot3(x0x, x0y, x0z, x0x, x0y, x0z);
  const dx1 = dot3(x1x, x1y, x1z, x1x, x1y, x1z);
  const dx2 = dot3(x2x, x2y, x2z, x2x, x2y, x2z);
  const dx3 = dot3(x3x, x3y, x3z, x3x, x3y, x3z);
  let m0 = Math.max(F(0.6 - dx0), 0.0);
  let m1 = Math.max(F(0.6 - dx1), 0.0);
  let m2 = Math.max(F(0.6 - dx2), 0.0);
  let m3 = Math.max(F(0.6 - dx3), 0.0);

  // m = m * m;
  m0 = F(m0 * m0); m1 = F(m1 * m1); m2 = F(m2 * m2); m3 = F(m3 * m3);

  // return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  const dp0 = dot3(px0, py0, pz0, x0x, x0y, x0z);
  const dp1 = dot3(px1, py1, pz1, x1x, x1y, x1z);
  const dp2 = dot3(px2, py2, pz2, x2x, x2y, x2z);
  const dp3 = dot3(px3, py3, pz3, x3x, x3y, x3z);

  const mm0 = F(m0 * m0);
  const mm1 = F(m1 * m1);
  const mm2 = F(m2 * m2);
  const mm3 = F(m3 * m3);
  const sum = F(F(F(F(mm0 * dp0) + F(mm1 * dp1)) + F(mm2 * dp2)) + F(mm3 * dp3));
  return F(42.0 * sum);
}

/* ------------------------------------------------------------------ */
/* waveField -- swell + wave layers only, transcribed from waterglsl.ts */
/* ------------------------------------------------------------------ */

const FREQ_SWELL = Math.fround(freqNumber(SWELL_WAVELENGTH));
const FREQ_WAVE = Math.fround(freqNumber(WAVE_WAVELENGTH));
const AXIS_WAVE_F: readonly [number, number, number] = [
  Math.fround(AXIS_WAVE[0]),
  Math.fround(AXIS_WAVE[1]),
  Math.fround(AXIS_WAVE[2]),
];

/** `ridge(v, sharp)` from `waterglsl.ts`, float32-rounded to match the shader. */
function ridge(v: number, sharp: number): number {
  const roundOff = F(0.11 - F(F(0.11 - 0.0005) * sharp)); // mix(0.11, 0.0005, sharp)
  return F(0.5 - Math.sqrt(F(F(v * v) + roundOff)));
}

/** `stretch(q, axis, k)` from `waterglsl.ts`, float32-rounded to match the shader. */
function stretch(
  qx: number,
  qy: number,
  qz: number,
  axis: readonly [number, number, number],
  k: number,
): [number, number, number] {
  const dotQAxis = F(F(F(qx * axis[0]) + F(qy * axis[1])) + F(qz * axis[2]));
  const d = F(dotQAxis * k);
  return [F(qx + F(axis[0] * d)), F(qy + F(axis[1] * d)), F(qz + F(axis[2] * d))];
}

/**
 * `waveField(p, m, mid, fine)` from `waterglsl.ts`, with `fine` fixed at 0
 * (chop dropped: "the swell and wave layers only, never chop", per
 * `docs/RENDER_PLAN.md`) and `mid` fixed at 1 (full ridge sharpness -- the
 * hull and the patch always want the close-up detail, never the fragment
 * shader's camera-distance LOD fade). Every step float32-rounded, same as
 * `snoise` -- see its module comment.
 */
function waveFieldCPU(px: number, py: number, pz: number, m: number, offsets: WaveOffsets): number {
  const sx = F(F(px + F(offsets.swell.x * m)) * FREQ_SWELL);
  const sy = F(F(py + F(offsets.swell.y * m)) * FREQ_SWELL);
  const sz = F(F(pz + F(offsets.swell.z * m)) * FREQ_SWELL);
  const s = F(snoise(sx, sy, sz) * 0.55);

  const wx = F(F(px + F(offsets.wave.x * m)) * FREQ_WAVE);
  const wy = F(F(py + F(offsets.wave.y * m)) * FREQ_WAVE);
  const wz = F(F(pz + F(offsets.wave.z * m)) * FREQ_WAVE);
  const [pwx, pwy, pwz] = stretch(wx, wy, wz, AXIS_WAVE_F, 1.7);
  const ridged = ridge(snoise(pwx, pwy, pwz), 1.0);

  return F(s + F(ridged * 0.9));
}

/** Height only, at full mid-octave sharpness, no chop -- see `waveFieldCPU`. */
export function waveHeight(dir: Vector3, offsets: WaveOffsets, motion: number): number {
  return waveFieldCPU(dir.x, dir.y, dir.z, motion, offsets);
}

/**
 * The tangent basis `waterglsl.ts`'s `waterDepth` builds for its own
 * finite-difference normal, transcribed here so `sampleWave`'s gradient (and
 * any test comparing it to a smaller step) uses the identical basis.
 * Degenerate nowhere but the poles' immediate neighbourhood, and built fresh
 * from `dir` every call -- nothing here is stored across samples.
 */
export function waveNormalBasis(dir: Vector3, outU: Vector3, outV: Vector3): void {
  const useX = Math.abs(dir.y) >= 0.95; // step(0.95, abs(n.y))
  const refx = useX ? 1 : 0;
  const refy = useX ? 0 : 1;
  const refz = 0;
  // tanU = normalize(cross(ref, n))
  let ux = refy * dir.z - refz * dir.y;
  let uy = refz * dir.x - refx * dir.z;
  let uz = refx * dir.y - refy * dir.x;
  const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ulen; uy /= ulen; uz /= ulen;
  outU.set(ux, uy, uz);
  // tanV = cross(n, tanU)
  const vx = dir.y * uz - dir.z * uy;
  const vy = dir.z * ux - dir.x * uz;
  const vz = dir.x * uy - dir.y * ux;
  outV.set(vx, vy, vz);
}

const _tanU = new Vector3();
const _tanV = new Vector3();

/**
 * `sampleWave(dir, offsets, motion, out)` -- the CPU port's public entry
 * point. `dir` is a unit direction on the globe; `offsets` are `water.offsets`
 * (the same integrated drift positions the shader reads); `motion` is the
 * lake-calm factor (1 on open sea). `out.h` is the raw waveField height,
 * `out.gu`/`out.gv` are the finite-difference gradient along the tangent
 * basis above, stepped by the same NORMAL_STEP the shader uses (as a true
 * slope: (sample - centre) / step, not the shader's unnormalised difference).
 *
 * Nothing here allocates: `_tanU`/`_tanV` are module-scope scratch vectors
 * reused across calls, never returned or stored by the caller.
 */
export function sampleWave(dir: Vector3, offsets: WaveOffsets, motion: number, out: WaveSample): void {
  waveNormalBasis(dir, _tanU, _tanV);
  const h0 = waveFieldCPU(dir.x, dir.y, dir.z, motion, offsets);
  const hu = waveFieldCPU(
    dir.x + _tanU.x * NORMAL_STEP_DIR,
    dir.y + _tanU.y * NORMAL_STEP_DIR,
    dir.z + _tanU.z * NORMAL_STEP_DIR,
    motion,
    offsets,
  );
  const hv = waveFieldCPU(
    dir.x + _tanV.x * NORMAL_STEP_DIR,
    dir.y + _tanV.y * NORMAL_STEP_DIR,
    dir.z + _tanV.z * NORMAL_STEP_DIR,
    motion,
    offsets,
  );
  out.h = h0;
  out.gu = (hu - h0) / NORMAL_STEP_DIR;
  out.gv = (hv - h0) / NORMAL_STEP_DIR;
}
