import { Vector3 } from 'three';
import { GLOBE_RADIUS } from './geo';
import type { HeightMap } from './heightmap';
import type { ShipState } from './types';
import type { WaterBodies } from './waterbodies';

/**
 * radar.ts — the surface plot in the top-right panel.
 *
 * A ship-centred, bow-up plan view of everything within RADAR_RANGE. The scope
 * is a 2D canvas rather than a second WebGL view: what it draws is the same
 * height field and inland-water mask the world is built from, read on the CPU,
 * so it costs no draw calls and can never disagree with what is on screen.
 *
 * Projection is azimuthal equidistant about the ship: distance from the centre
 * of the scope is true great-circle distance, in the same units `hud.ts`
 * prints as knots. That is the one property a range display has to have.
 */

/**
 * Radius of the world the scope covers, in world units.
 *
 * 100 is one full radian of arc on a globe of radius 100 — a sixth of the way
 * around the planet — so the scope shows the neighbourhood, not the hull.
 */
export const RADAR_RANGE = 100;

/** Range rings, as a fraction of RADAR_RANGE. */
const RINGS = [0.25, 0.5, 0.75];

/**
 * Resolution the terrain is rasterised at, before being scaled onto the scope.
 *
 * The plot is a soft, blurred image by design, so it gains nothing from
 * matching device pixels; 128 keeps the per-frame work in the tens of
 * microseconds even at a high device pixel ratio.
 */
const RASTER = 192;

/**
 * Terrain re-raster rate, Hz.
 *
 * The ship covers at most 20 units per second across a scope 200 units wide,
 * so at 10 Hz the picture is never more than a thousandth of the scope stale.
 * The overlay — rings, sweep, blip, north mark — is redrawn every frame.
 */
const RASTER_HZ = 10;

/** Seconds per revolution of the sweep. */
const SWEEP_PERIOD = 4;
/** Trailing wedge behind the sweep line, in radians. */
const SWEEP_TAIL = 1.15;
/** Sectors the trailing wedge is drawn as. */
const SWEEP_STEPS = 14;

export interface Radar {
  /** Redraws the scope. Safe to call before the first terrain raster. */
  update(dt: number, ship: ShipState): void;
}

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/**
 * Scope colours, keyed to the world's own so the plot reads as the same place:
 * green land, blue-black sea, and the lake green of `water.ts` for water the
 * ship cannot reach. Everything is darkened for a lit display — the panel
 * behind it is translucent over a bright ocean.
 */
const SEA_SHALLOW = [22, 104, 112];
const SEA_MID = [10, 52, 78];
const SEA_DEEP = [4, 18, 32];
const LAKE_SHALLOW = [32, 120, 88];
const LAKE_DEEP = [12, 58, 48];
const SAND = [132, 116, 70];
const GRASS = [58, 124, 66];
const FOREST = [34, 84, 60];
const ROCK = [82, 90, 104];
const PEAK = [158, 160, 172];

function mix(a: number[], b: number[], t: number, out: number[]): void {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  out[0] = a[0] + (b[0] - a[0]) * k;
  out[1] = a[1] + (b[1] - a[1]) * k;
  out[2] = a[2] + (b[2] - a[2]) * k;
}

function surfaceColor(h: number, seaLevel: number, inland: number, out: number[]): void {
  if (h <= seaLevel) {
    const depth = seaLevel - h;
    if (inland > 0) {
      mix(LAKE_SHALLOW, LAKE_DEEP, depth / 0.22, out);
      return;
    }
    if (depth < 0.11) mix(SEA_SHALLOW, SEA_MID, depth / 0.11, out);
    else mix(SEA_MID, SEA_DEEP, (depth - 0.11) / 0.45, out);
    return;
  }
  // Exactly the bands `land.ts` colours the terrain with, including its 0.5
  // relief span, so an island is the same shape and the same green on the
  // scope as it is out of the window. Getting this wrong is how a radar ends
  // up reporting mountains where the world has meadow.
  const a = h - seaLevel;
  if (a < 0.055) {
    mix(SAND, GRASS, a / 0.055, out);
    return;
  }
  const t = Math.min(1, (a - 0.055) / 0.5);
  if (t < 0.4) mix(GRASS, FOREST, t / 0.4, out);
  else if (t < 0.75) mix(FOREST, ROCK, (t - 0.4) / 0.35, out);
  else mix(ROCK, PEAK, (t - 0.75) / 0.25, out);
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Builds the scope against `#hud-radar`.
 *
 * Returns a no-op if the canvas or a 2D context is missing, exactly like the
 * writers in `hud.ts`: a HUD element that is not in the document must never
 * take the frame loop down with it.
 */
export function createRadar(
  heightMap: HeightMap,
  waterBodies: WaterBodies,
  seaLevel: number,
): Radar {
  // Single source of truth for the range: the panel label is written from the
  // same constant the projection uses.
  const rangeLabel = document.getElementById('hud-radar-range');
  if (rangeLabel) rangeLabel.textContent = `${RADAR_RANGE} KN`;

  const noop: Radar = { update: (): void => undefined };

  const element = document.getElementById('hud-radar');
  if (!(element instanceof HTMLCanvasElement)) return noop;
  const context = element.getContext('2d');
  if (!context) return noop;

  // Re-bound with narrow types so the draw closures below see them as such.
  const canvas: HTMLCanvasElement = element;
  const ctx: CanvasRenderingContext2D = context;

  /*
   * Per-pixel projection tables.
   *
   * A scope pixel sits at great-circle distance `d` and bearing `b` from the
   * ship, and the direction it looks at is
   *     dir = up * cos(d/R) + (forward * cos(b) + starboard * sin(b)) * sin(d/R)
   * Only `up`, `forward` and `starboard` change as the ship moves, so the three
   * trig coefficients are computed once here and the per-frame work per pixel
   * is three scalar-times-vector terms. `up` and the two tangents are
   * orthonormal, so the result is already unit length.
   */
  const cells = RASTER * RASTER;
  const kUp = new Float32Array(cells);
  const kFwd = new Float32Array(cells);
  const kStb = new Float32Array(cells);
  const inScope = new Uint8Array(cells);

  for (let py = 0; py < RASTER; py++) {
    // +1 at the top of the scope, which is where the bow points.
    const ny = 1 - (2 * (py + 0.5)) / RASTER;
    for (let px = 0; px < RASTER; px++) {
      const nx = (2 * (px + 0.5)) / RASTER - 1;
      const r = Math.hypot(nx, ny);
      const i = py * RASTER + px;
      if (r > 1) continue;
      inScope[i] = 1;
      const theta = (r * RADAR_RANGE) / GLOBE_RADIUS;
      // Bearing clockwise from the bow: +x on the scope is starboard.
      const bearing = Math.atan2(nx, ny);
      const sinT = Math.sin(theta);
      kUp[i] = Math.cos(theta);
      kFwd[i] = sinT * Math.cos(bearing);
      kStb[i] = sinT * Math.sin(bearing);
    }
  }

  // Terrain is rasterised here, then scaled onto the scope.
  const plot = document.createElement('canvas');
  plot.width = RASTER;
  plot.height = RASTER;
  const plotCtx = plot.getContext('2d');
  const image = plotCtx ? plotCtx.createImageData(RASTER, RASTER) : null;

  const dir = new Vector3();
  const starboard = new Vector3();
  const rgb = [0, 0, 0];

  let sinceRaster = Infinity;
  let sweep = 0;
  let cssSize = 0;

  function raster(ship: ShipState): void {
    if (!plotCtx || !image) return;
    // Matches ship.ts: right = forward x up is starboard.
    starboard.crossVectors(ship.forward, ship.up);
    if (starboard.lengthSq() < 1e-12) return;
    starboard.normalize();

    const up = ship.up;
    const fwd = ship.forward;
    const data = image.data;

    for (let i = 0; i < cells; i++) {
      const o = i * 4;
      if (inScope[i] === 0) {
        data[o + 3] = 0;
        continue;
      }
      const a = kUp[i];
      const b = kFwd[i];
      const c = kStb[i];
      dir.set(
        up.x * a + fwd.x * b + starboard.x * c,
        up.y * a + fwd.y * b + starboard.y * c,
        up.z * a + fwd.z * b + starboard.z * c,
      );
      surfaceColor(heightMap.sample(dir), seaLevel, waterBodies.sample(dir), rgb);
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
    plotCtx.putImageData(image, 0, 0);
  }

  function resizeToCss(): number {
    const size = canvas.clientWidth;
    if (size <= 0) return cssSize;
    if (size !== cssSize) {
      cssSize = size;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(size * dpr));
      canvas.height = Math.max(1, Math.round(size * dpr));
    }
    return cssSize;
  }

  function update(dt: number, ship: ShipState): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    sinceRaster += dt;
    if (sinceRaster >= 1 / RASTER_HZ) {
      sinceRaster = 0;
      raster(ship);
    }

    sweep = (sweep + (dt * Math.PI * 2) / SWEEP_PERIOD) % (Math.PI * 2);

    const size = resizeToCss();
    if (size <= 0) return;

    const w = canvas.width;
    const R = w / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, w);
    // Draw in a unit system where the scope is a circle of radius 1 centred on
    // the ship, and the bow points up the screen.
    ctx.translate(R, R);
    ctx.scale(R, R);
    ctx.lineWidth = 1 / R;

    // ---- Terrain plot ---------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#020a12';
    ctx.fillRect(-1, -1, 2, 2);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.92;
    ctx.drawImage(plot, -1, -1, 2, 2);
    ctx.globalAlpha = 1;

    // ---- Sweep, inside the clip so it stays on the scope ------------------
    for (let i = 0; i < SWEEP_STEPS; i++) {
      const t = i / SWEEP_STEPS;
      const a0 = sweep - SWEEP_TAIL * (t + 1 / SWEEP_STEPS);
      const a1 = sweep - SWEEP_TAIL * t;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      // -PI/2 puts angle 0 at the top of the scope, matching the bow.
      ctx.arc(0, 0, 1, a0 - Math.PI / 2, a1 - Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = `rgba(63, 224, 255, ${(0.16 * (1 - t) ** 2).toFixed(4)})`;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(sweep), -Math.cos(sweep));
    ctx.strokeStyle = 'rgba(120, 240, 255, 0.55)';
    ctx.lineWidth = 1.6 / R;
    ctx.stroke();
    ctx.restore();

    // ---- Range rings and spokes ------------------------------------------
    ctx.lineWidth = 1 / R;
    ctx.strokeStyle = 'rgba(63, 224, 255, 0.22)';
    for (const r of RINGS) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-1, 0);
    ctx.lineTo(1, 0);
    ctx.moveTo(0, -1);
    ctx.lineTo(0, 1);
    ctx.strokeStyle = 'rgba(63, 224, 255, 0.14)';
    ctx.stroke();

    // ---- North mark: the scope is bow-up, so north swings with heading ----
    const northAngle = (-ship.headingDeg * Math.PI) / 180;
    const nx = Math.sin(northAngle);
    const ny = -Math.cos(northAngle);
    ctx.beginPath();
    ctx.moveTo(nx * 0.995, ny * 0.995);
    ctx.lineTo(nx * 0.80 - ny * 0.055, ny * 0.80 + nx * 0.055);
    ctx.lineTo(nx * 0.80 + ny * 0.055, ny * 0.80 - nx * 0.055);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 79, 216, 0.85)';
    ctx.fill();

    // ---- Own ship, always dead centre and always pointing up --------------
    ctx.beginPath();
    ctx.moveTo(0, -0.115);
    ctx.lineTo(0.072, 0.072);
    ctx.lineTo(0, 0.03);
    ctx.lineTo(-0.072, 0.072);
    ctx.closePath();
    ctx.fillStyle = '#ff4fd8';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.lineWidth = 0.9 / R;
    ctx.stroke();

    // Rim, drawn last so nothing overlaps it.
    ctx.beginPath();
    ctx.arc(0, 0, 1 - 0.5 / R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(63, 224, 255, 0.55)';
    ctx.lineWidth = 1.4 / R;
    ctx.stroke();
  }

  return { update };
}
