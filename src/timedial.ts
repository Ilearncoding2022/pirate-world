import type { ShipState } from './types';
import type { WorldEnv } from './env';
import { solarPhase, phaseName } from './solartime';

/**
 * The day dial: where the ship stands in its own day, and how much of it is
 * left.
 *
 * A 2D canvas, like `radar.ts` and `fishrender.ts`, so it costs no draw calls
 * and never touches the scene graph. All the geometry lives in `solartime.ts`;
 * this file only draws it.
 *
 * It used to read `HH:MM`, and the hour is gone on purpose -- see the header of
 * `solartime.ts` for why an hour could not be made to agree with the sun the
 * player could see. What replaced it is a percentage through the CURRENT
 * phase, day or night, because that is the question the dial was being asked
 * anyway: not what time it is, but how long the light will last.
 *
 * Noon sits at the top and the day runs clockwise, so the lit arc is the part
 * of the ring the sun's disc is clear of the water for. Three things move, for
 * three different reasons:
 *
 *   - **The marker** runs round the ring at the rate the ship's local day
 *     passes. At anchor that is one lap per DAY_LENGTH. Under way it is not:
 *     the ship covers longitude about ten times faster than the terminator
 *     does, so running east visibly drives the marker round and running west
 *     can stall it or push it backwards. That is not simulated anywhere; it
 *     falls out of measuring the angle between two meridians.
 *   - **The lit arc** grows and shrinks with latitude. It covers about 65% of
 *     the ring at the equator rather than half, because the drawn horizon is
 *     below eye level and the sun is visible for longer than it is up.
 *   - **The readout** runs 0 to 100% and resets at each crossing, so it is
 *     the one part that does not care how long either phase happens to be.
 */
export interface TimeDial {
  update(ship: ShipState, env: WorldEnv): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Ring radius as a fraction of the canvas half-size. */
const RING_RADIUS = 0.78;
/** Ring line width, as a fraction of the canvas half-size. */
const RING_WIDTH = 0.15;
/** Radius of the marker that rides the ring, same units. */
const MARKER_RADIUS = 0.115;

/* Palette. UI chrome, so it is drawn from style.css's variables by hand --
 * a canvas cannot read them. Kept to the HUD's cyan and a warm sun; magenta
 * is reserved for north on the scope and for UI accents (ART-DIRECTION 2.4). */
const RING_TRACK = 'rgba(63, 224, 255, 0.13)';
const NIGHT_ARC = 'rgba(46, 96, 128, 0.55)';
const DAY_ARC = 'rgba(255, 196, 77, 0.85)';
const SUN_CORE = '#fff2d6';
const SUN_DOWN = '#5d7f97';
const HORIZON_LINE = 'rgba(63, 224, 255, 0.22)';
const TICK = 'rgba(207, 239, 251, 0.30)';
const PROGRESS_TEXT = '#cfeffb';
const PHASE_TEXT = '#6f93a6';

/**
 * Local time to angle on the canvas.
 *
 * Canvas angles start at 3 o'clock and increase clockwise (y grows downward),
 * so a quarter turn is subtracted to put local noon at the top. Sunrise then
 * falls on the left, sunset on the right, and midnight at the bottom.
 */
function angleFor(solarTime: number): number {
  return (solarTime - 0.5) * Math.PI * 2 - Math.PI / 2;
}

export function createTimeDial(canvas: HTMLCanvasElement): TimeDial {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('timedial: no 2D context');
  const ctx = context;

  let cssWidth = 0;
  let cssHeight = 0;

  /**
   * Matches the canvas backing store to its CSS box.
   *
   * Both axes, unlike `radar.ts`, which may assume a square because its scope
   * is a disc. This box is deliberately wider than it is tall, so sizing the
   * backing store from the width alone would stretch the ring into an ellipse.
   */
  function resizeToCss(): boolean {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return false;
    if (w !== cssWidth || h !== cssHeight) {
      cssWidth = w;
      cssHeight = h;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    }
    return true;
  }

  function update(ship: ShipState, env: WorldEnv): void {
    if (!resizeToCss()) return;

    const phase = solarPhase(ship.up, env.sunDirection);

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const half = Math.min(w, h) / 2;
    const r = half * RING_RADIUS;
    const lineWidth = half * RING_WIDTH;

    ctx.clearRect(0, 0, w, h);

    // ---- the ring -----------------------------------------------------
    ctx.lineCap = 'butt';
    ctx.lineWidth = lineWidth;

    ctx.strokeStyle = RING_TRACK;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Night first, then the lit arc over it. A polar night draws no lit arc
    // at all and a midnight sun draws a complete one, which is the honest
    // picture in both cases rather than a special case.
    ctx.strokeStyle = NIGHT_ARC;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    if (phase.dayFraction > 0) {
      ctx.strokeStyle = DAY_ARC;
      ctx.beginPath();
      if (phase.dayFraction >= 1) {
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      } else {
        ctx.arc(cx, cy, r, angleFor(phase.dayStart), angleFor(phase.dayEnd));
      }
      ctx.stroke();
    }

    // ---- horizon, and the quarter ticks --------------------------------
    // The chord through daybreak and nightfall: the line the sun's disc
    // crosses. Off centre, unlike the old one, because the day is longer than
    // the night here -- which is the honest picture, and the reason the chord
    // is worth drawing at all now.
    if (!phase.polar) {
      const a0 = angleFor(phase.dayStart);
      const a1 = angleFor(phase.dayEnd);
      ctx.strokeStyle = HORIZON_LINE;
      ctx.lineWidth = Math.max(1, half * 0.012);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
      ctx.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
      ctx.stroke();
    }

    ctx.strokeStyle = TICK;
    ctx.lineWidth = Math.max(1, half * 0.016);
    for (let q = 0; q < 4; q++) {
      const a = angleFor(q / 4);
      const inner = r - lineWidth / 2;
      const outer = r + lineWidth / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();
    }

    // ---- the sun marker -------------------------------------------------
    const a = angleFor(phase.solarTime);
    const mx = cx + Math.cos(a) * r;
    const my = cy + Math.sin(a) * r;
    const up = phase.isDay;
    const markerR = half * MARKER_RADIUS;

    if (up) {
      const glow = ctx.createRadialGradient(mx, my, 0, mx, my, markerR * 2.6);
      glow.addColorStop(0, 'rgba(255, 242, 214, 0.55)');
      glow.addColorStop(1, 'rgba(255, 242, 214, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(mx, my, markerR * 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = up ? SUN_CORE : SUN_DOWN;
    ctx.beginPath();
    ctx.arc(mx, my, markerR, 0, Math.PI * 2);
    ctx.fill();

    // ---- readout --------------------------------------------------------
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    /*
     * How far through this phase, as a percentage, with the phase named under
     * it. A percentage rather than a countdown for the same reason the hour
     * went: how long the rest of the day will TAKE is not a fact about the
     * ship's position, and the moment the wheel goes over it stops being true.
     *
     * Where the sun never sets there is no phase to be a fraction of, so the
     * dial says so rather than showing a number that would run 0 to 100 and
     * mean nothing at either end.
     */
    ctx.fillStyle = PROGRESS_TEXT;
    ctx.font = `600 ${Math.round(half * 0.42)}px "Segoe UI Mono", "Consolas", monospace`;
    const readout = phase.polar
      ? '--'
      : `${Math.min(99, Math.floor(phase.progress * 100))}%`;
    ctx.fillText(readout, cx, cy + half * 0.06);

    ctx.fillStyle = PHASE_TEXT;
    ctx.font = `600 ${Math.round(half * 0.21)}px "Segoe UI Mono", "Consolas", monospace`;
    const label = phase.polar
      ? phase.isDay
        ? 'NO SUNSET'
        : 'NO SUNRISE'
      : phaseName(phase);
    ctx.fillText(label, cx, cy + half * 0.34);
  }

  return { update };
}
