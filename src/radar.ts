import { Vector3 } from 'three';
import { GLOBE_RADIUS } from './geo';
import type { HeightMap } from './heightmap';
import type { ShipState, Towns, WindState } from './types';
import type { WaterBodies } from './waterbodies';
import { OCEAN_CAP } from './wind';

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
 * Half a radian of arc at the current GLOBE_RADIUS, about a twelfth of the way
 * around the planet. It was a full radian; halving it trades the wide
 * neighbourhood view for one where a coastline is worth steering by, since
 * everything on the plot is now twice the size it was.
 *
 * Ship-scale in spirit but written absolute, like the hull and its speed: what
 * the scope is for is judging water the ship can reach soon, and that is a
 * distance, not a fraction of the planet.
 */
export const RADAR_RANGE = 50;

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
 * The overlay — rings, sweep, blip, wind arrow, north mark — is redrawn every
 * frame.
 */
const RASTER_HZ = 10;

/** Seconds per revolution of the sweep. */
const SWEEP_PERIOD = 4;
/** Trailing wedge behind the sweep line, in radians. */
const SWEEP_TAIL = 1.15;
/** Sectors the trailing wedge is drawn as. */
const SWEEP_STEPS = 14;

/**
 * Town icon sizes, in scope radii.
 *
 * Written in scope units rather than world units on purpose: a chart symbol
 * says "a town is here", not how big the town is, so it has to stay the same
 * size on screen. Scaled through the projection instead it would swell as the
 * range closed and read as a range ring rather than as a marker.
 */
const DOCK_ICON = 0.042;
const TOWN_DOT = 0.019;

/**
 * Scope radius past which icons start fading into the bezel, so a town does not
 * pop in at full strength the instant it crosses the rim.
 */
const ICON_FADE = 0.88;

/**
 * Wind arrow geometry, in scope radii.
 *
 * Authored in scope units for the same reason the town icons are: the arrow is
 * a rim ornament, not a plotted object. Nothing about the wind has a position
 * on the chart, so nothing about the arrow may scale with the range.
 *
 * `WIND_TIP` sits just inside the bezel stroke, so the head reads as a point
 * rather than as a thickening of the rim.
 *
 * Length carries the speed, which is why it has a floor as well as a ceiling.
 * Scaled honestly off OCEAN_CAP, a 1 kn breath would be a three-pixel stub
 * indistinguishable from a smudge on the plot -- and "a little wind" versus
 * "no wind" is precisely the distinction the player needs, because the second
 * one is drawn as nothing at all. Anything drawn at all must therefore still
 * read as an arrow.
 */
const WIND_TIP = 0.965;
const WIND_MIN_LENGTH = 0.13;
const WIND_MAX_LENGTH = 0.3;
const WIND_HEAD = 0.075;
const WIND_HALF_WIDTH = 0.05;

/**
 * Wind arrow colour, deliberately the only warm thing on the scope.
 *
 * Every other hue here is already spoken for and already means something:
 * cyan is the instrument itself (rings, sweep, bezel), magenta is own ship and
 * north, mint is a berth. Weather is the one mark the player neither steers
 * nor steers by, so reading the scope should never have to begin with working
 * out which mark this is.
 */
const WIND_FILL = 'rgba(255, 186, 84, 0.9)';

/**
 * The gust glyph that sits on the arrow's tail, as SVG path data.
 *
 * Byte-for-byte the same three strokes `index.html` puts in front of the SPEED
 * row's wind share, because it has to be recognised as the same mark: the
 * panel says how many knots the weather is worth and the scope says which way
 * it is going, and a player should not have to learn that twice. Path2D parses
 * the same syntax the SVG does, so the two cannot drift apart by a curve.
 *
 * Authored in the icon's own 24x16 viewBox and scaled to WIND_GLYPH_SIZE scope
 * radii below.
 */
const WIND_GLYPH_PATH =
  'M2 4h11a2.6 2.6 0 1 0-2.6-2.6 M2 8h15a2.9 2.9 0 1 1-2.9 2.9 M2 12h8';

/**
 * Glyph size in scope radii, its floor in pixels, and its gap from the tail.
 *
 * It rides on the tail rather than the head because the head is the reading --
 * where the weather is going -- and a mark on top of it would be read as part
 * of the arrowhead's shape. On the tail it is unambiguously a label: this
 * arrow is the wind.
 *
 * The pixel floor is the whole reason there are two numbers. Everything else
 * on this scope is authored in radii and looks after itself, but this mark is
 * three strokes 4 viewBox units apart: below about 20px wide they close up
 * into a smear that reads as a scuff on the tube. The scope runs from 118px to
 * 158px, so 0.13 radii is 8 to 10px -- comfortably inside the smear. The floor
 * wins at every size the panel actually uses; the radii figure is what keeps
 * it sane if the scope is ever made much bigger.
 */
const WIND_GLYPH_SIZE = 0.13;
const WIND_GLYPH_MIN_PX = 20;
const WIND_GLYPH_GAP = 0.055;

/** Parsed once. Path2D is immutable, so the same object strokes every frame. */
const WIND_GLYPH = typeof Path2D === 'undefined' ? null : new Path2D(WIND_GLYPH_PATH);

/**
 * Cosine of the scope's angular radius.
 *
 * cos is monotone over [0, PI], so `dir . up >= this` is exactly "within
 * RADAR_RANGE" for the price of three multiplies -- the cheap gate that keeps
 * the whole town list off the trig path every frame.
 */
const COS_RADAR_RANGE = Math.cos(RADAR_RANGE / GLOBE_RADIUS);

export interface Radar {
  /** Redraws the scope. Safe to call before the first terrain raster. */
  update(dt: number, ship: ShipState, wind: WindState): void;
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

/**
 * Town icons, deliberately outside the terrain palette above.
 *
 * The land bands already own every dark, desaturated green on the plot, so a
 * dock drawn in any of them would be read as ground rather than as an object.
 * This mint is a hue `surfaceColor` cannot produce at any height, which is what
 * makes a berth findable in the half-second the player actually looks.
 */
const DOCK_FILL = 'rgba(72, 255, 168, 0.92)';
const DOCK_RING = 'rgba(226, 255, 240, 0.7)';
const TOWN_FILL = 'rgba(186, 198, 208, 0.5)';

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

/**
 * A true compass bearing, expressed in the scope's own angle.
 *
 * The scope is bow-up, so nothing that comes off a compass is drawn where the
 * world puts it: every world bearing has to be turned by the ship's heading
 * first. Both marks that come off a compass -- north and the wind -- are
 * placed through here, so the turn is defined exactly once. That matters more
 * than the arithmetic saved: two marks that were each rotated correctly but by
 * separately written expressions would agree in every screenshot taken head-up
 * and disagree by a sign only when the player turned, which is when neither is
 * being watched closely enough to catch it.
 *
 * From the returned angle `a`, the point on the rim is `(sin a, -cos a)` --
 * canvas y runs down while the bow points up the screen.
 */
function scopeAngle(bearing: number, heading: number): number {
  return bearing - heading;
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
  towns: Towns,
): Radar {
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
  const rgb = [0, 0, 0];

  /*
   * The ship frame the plot was last rasterised in, held rather than re-read.
   *
   * Terrain and town icons both project through this one copy, which is what
   * pins an icon to the picture under it instead of to the ship's live
   * attitude. Projecting icons from the live frame looks identical standing
   * still and comes apart in a turn: the raster only refreshes at RASTER_HZ,
   * and ship.ts turns at up to 1.2 rad/s, so between two rasters a smoothly
   * swinging icon would walk an eighth of the scope off its own island and
   * snap back, ten times a second. Stale together is coherent; stale apart is
   * a bug the player reads as the radar lying about where a town is.
   */
  const pUp = new Vector3();
  const pFwd = new Vector3();
  const pStb = new Vector3();
  let frameValid = false;

  function captureFrame(ship: ShipState): void {
    // Matches ship.ts: right = forward x up is starboard.
    pStb.crossVectors(ship.forward, ship.up);
    if (pStb.lengthSq() < 1e-12) {
      // forward parallel to up, which ship.ts should never hand us. Refuse the
      // frame rather than project the whole scope through a zero vector.
      frameValid = false;
      return;
    }
    pStb.normalize();
    pUp.copy(ship.up);
    pFwd.copy(ship.forward);
    frameValid = true;
  }

  let sinceRaster = Infinity;
  let sweep = 0;
  let cssSize = 0;

  function raster(): void {
    if (!plotCtx || !image || !frameValid) return;

    const up = pUp;
    const fwd = pFwd;
    const starboard = pStb;
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

  function update(dt: number, ship: ShipState, wind: WindState): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    sinceRaster += dt;
    if (sinceRaster >= 1 / RASTER_HZ) {
      sinceRaster = 0;
      captureFrame(ship);
      raster();
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

    // ---- Towns, over the plot and under the marks that must never be lost --
    /*
     * The per-pixel projection table, run backwards.
     *
     * The raster asks "which direction is this pixel?"; a town asks "which
     * pixel is this direction?". Both are the same relation --
     *     dir = up * cos(t) + (fwd * cos(b) + stb * sin(b)) * sin(t)
     * -- so inverting it is three dot products against the very frame the
     * raster used: dir . up is cos(t), and the two tangent dots are already
     * sin(t)cos(b) and sin(t)sin(b), so dividing them by sin(t) places the icon
     * with no atan2 and, more importantly, with no second projection anywhere
     * in the file. A second projection is the failure worth designing out
     * rather than testing for: an icon a few pixels off its own coastline reads
     * as a rendering nicety rather than an error, so it is never reported and
     * never found.
     */
    if (frameValid) {
      // Clipped to the bezel, so a town straddling the rim is drawn cut instead
      // of spilling onto the panel around the scope.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.clip();
      ctx.lineWidth = 1 / R;

      const list = towns.all;
      for (let i = 0; i < list.length; i++) {
        const town = list[i];
        const d = town.dir;
        // Cull before any trig. Walking the whole list is free; calling acos
        // down it is not, and neither is the garbage a per-town Vector3 would
        // make sixty times a second.
        const c = pUp.x * d.x + pUp.y * d.y + pUp.z * d.z;
        if (c < COS_RADAR_RANGE) continue;

        // Rounding can push a unit-vector dot fractionally over 1, and acos of
        // that is NaN -- which would silently drop the icon, not crash.
        const cc = c > 1 ? 1 : c;
        const sinT = Math.sqrt(1 - cc * cc);
        // Great-circle distance as a fraction of the range. Azimuthal
        // equidistant is the whole point of the scope, so this is the same r
        // the range rings are calibrated in.
        const r = (Math.acos(cc) * GLOBE_RADIUS) / RADAR_RANGE;
        // A town under the keel has no bearing at all: put it dead centre
        // rather than divide by a vanishing sine.
        const k = sinT < 1e-6 ? 0 : r / sinT;
        const f = pFwd.x * d.x + pFwd.y * d.y + pFwd.z * d.z;
        const s = pStb.x * d.x + pStb.y * d.y + pStb.z * d.z;
        const x = k * s;
        // Canvas y runs down while the bow points up the screen -- the same
        // flip the north mark below makes.
        const y = -k * f;

        ctx.globalAlpha = r > ICON_FADE ? Math.max(0, (1 - r) / (1 - ICON_FADE)) : 1;

        if (town.dock) {
          // Filled diamond in a hairline ring: the only actionable thing on the
          // scope, so it gets the only hard-edged shape on it. The plot behind
          // it is a blurred image with no straight edges anywhere, which is
          // what lets a berth pick itself out of its own coastline.
          ctx.beginPath();
          ctx.moveTo(x, y - DOCK_ICON);
          ctx.lineTo(x + DOCK_ICON, y);
          ctx.lineTo(x, y + DOCK_ICON);
          ctx.lineTo(x - DOCK_ICON, y);
          ctx.closePath();
          ctx.fillStyle = DOCK_FILL;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, DOCK_ICON * 1.55, 0, Math.PI * 2);
          ctx.strokeStyle = DOCK_RING;
          ctx.stroke();
        } else {
          // A landlocked town is a landmark, not a destination: legible when
          // looked for, and out of the way when it is the coast being read.
          ctx.beginPath();
          ctx.arc(x, y, TOWN_DOT, 0, Math.PI * 2);
          ctx.fillStyle = TOWN_FILL;
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // ---- Wind arrow, on the true bearing, from the LIVE frame -------------
    /*
     * Deliberately not held back to the raster's frame the way the terrain and
     * its icons are.
     *
     * That rule exists to keep an icon welded to the coastline underneath it,
     * and it is worth its staleness precisely because the icon and the picture
     * are the same subject. The wind is attached to nothing on the picture: it
     * is this instant's weather turned by this instant's heading, both of them
     * live. Projected through a frame up to a tenth of a second old it would
     * simply lag the bow through every turn -- weather that swings when the
     * ship swings and settles late, which is the reading a player would call
     * broken. The north mark below is live for exactly the same reason.
     *
     * `bearing` holds its last value through a calm rather than going stale in
     * some detectable way, so the calm has to be tested on `speed`, which
     * `wind.ts` puts at exactly 0. Drawing the held bearing anyway would put a
     * short arrow on the rim reporting a wind that is not blowing.
     */
    if (wind.speed > 0) {
      const windAngle = scopeAngle(wind.bearing, ship.heading);
      const wx = Math.sin(windAngle);
      const wy = -Math.cos(windAngle);
      // Perpendicular to the shaft, for the head's two barbs.
      const px = -wy;
      const py = wx;
      /*
       * Scaled off the imported OCEAN_CAP rather than a literal 16, so the
       * arrow cannot drift away from the wind it draws. Retune the cap with
       * the number written here as well and every wind reads full strength at
       * the old ceiling: an arrow at its stop while the hull is still gaining
       * speed is a worse lie than no arrow, because it is quietly wrong rather
       * than obviously missing.
       */
      const t = Math.min(1, wind.speed / OCEAN_CAP);
      const length = WIND_MIN_LENGTH + (WIND_MAX_LENGTH - WIND_MIN_LENGTH) * t;
      const tail = WIND_TIP - length;
      const neck = WIND_TIP - WIND_HEAD;

      // Head outward, because `bearing` is the direction the wind travels
      // toward: the arrow shows where the weather is going, which is the same
      // way it is pushing the hull.
      ctx.beginPath();
      ctx.moveTo(wx * tail, wy * tail);
      ctx.lineTo(wx * neck, wy * neck);
      ctx.strokeStyle = WIND_FILL;
      ctx.lineWidth = 2.2 / R;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(wx * WIND_TIP, wy * WIND_TIP);
      ctx.lineTo(wx * neck + px * WIND_HALF_WIDTH, wy * neck + py * WIND_HALF_WIDTH);
      ctx.lineTo(wx * neck - px * WIND_HALF_WIDTH, wy * neck - py * WIND_HALF_WIDTH);
      ctx.closePath();
      ctx.fillStyle = WIND_FILL;
      ctx.fill();

      // The glyph, inboard of the tail and turned to run with the shaft, so
      // its strokes stream the way the arrow points. It keeps a fixed size:
      // length already carries the speed, and a glyph that grew with it would
      // say the same thing twice while getting hard to read at the bottom of
      // the range.
      if (WIND_GLYPH !== null) {
        const glyph = Math.max(WIND_GLYPH_SIZE, WIND_GLYPH_MIN_PX / R);
        const centre = tail - WIND_GLYPH_GAP - glyph * 0.5;
        // 24 is the glyph viewBox's width; the translate centres its 24x16 box
        // on the origin before it is placed.
        const scale = glyph / 24;
        ctx.save();
        ctx.translate(wx * centre, wy * centre);
        ctx.rotate(Math.atan2(wy, wx));
        ctx.scale(scale, scale);
        ctx.translate(-12, -8);
        ctx.strokeStyle = WIND_FILL;
        // Two nested scales are in force here -- the scope's R and the glyph's
        // own -- so the width has to be divided by both to land on 1.7 pixels.
        ctx.lineWidth = 1.5 / (R * scale);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(WIND_GLYPH);
        ctx.restore();
      }
    }

    // ---- North mark: the scope is bow-up, so north swings with heading ----
    // Drawn after the wind so that a wind blowing due north leaves the compass
    // on top: the player can lose the weather behind a mark for a moment, but
    // never the direction they navigate by.
    const northAngle = scopeAngle(0, ship.heading);
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
