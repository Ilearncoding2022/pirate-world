import { Vector3 } from 'three';
import { GLOBE_RADIUS } from './geo';
import type { HeightMap } from './heightmap';
import type {
  AiBoatState,
  CellsState,
  HazardState,
  ShipState,
  Towns,
  WeatherState,
  WindState,
} from './types';
import type { Chart } from './chart';
import type { WaterBodies } from './waterbodies';
import type { Hull } from './hull';
import { createStubHull } from './hull';
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
 * cyan is the instrument itself (rings, sweep, bezel), magenta is own ship,
 * blue is north and its four letters, mint is a berth. Weather is the one mark
 * the player neither steers nor steers by, so reading the scope should never
 * have to begin with working out which mark this is.
 */
const WIND_FILL = 'rgba(255, 186, 84, 0.9)';

/* ------------------------------------------------------------------ */
/* Rough water                                                         */
/* ------------------------------------------------------------------ */

/**
 * Hazard marks, in the HUD's warning accent.
 *
 * `--magenta` is what this project warns in, and ART-DIRECTION.md §2.4 keeps
 * it off in-world objects and nowhere else -- the scope is UI, so it is
 * exactly where the accent belongs. It is own ship's hue too, which is the one
 * thing to watch: the blip is a filled arrowhead welded to the centre of the
 * scope and a hazard is a bar or a ring out on the plot, so the two are never
 * read as the same kind of mark. They are the same colour on purpose. Both
 * mean "this is about the hull", which is the fastest thing the instrument can
 * say.
 */
const HAZARD_STROKE = 'rgb(255, 79, 216)';

/**
 * Crest bar and maelstrom ring line widths, device pixels.
 *
 * Thicker than the range rings (1) and about the weight of the wind's shaft,
 * because a hazard is the one mark on the scope worth breaking off a course
 * for and it has to be found in the half-second the player looks down.
 */
const CREST_WIDTH_PX = 2.6;
const MAELSTROM_WIDTH_PX = 2.2;

/**
 * The three arcs that ride the maelstrom's ring: how long each is, in radians,
 * and how fast the set of them turns.
 *
 * The height field of a funnel is radially symmetric -- the swirl is fragment
 * art and there is nothing in the geometry to spin -- so the scope has to say
 * "this thing is turning" on its own account. Three arcs at 120 degrees, near
 * a quarter turn a second: fast enough to read as rotation at a glance, slow
 * enough that it is not a strobe on a 40-pixel circle.
 */
const MAELSTROM_ARC = 0.6;

/**
 * How many straight segments a crest's bar is drawn in.
 *
 * A crest is a bowed front now (`Hazard.bow`), so the two-point bar this used
 * to draw would be a chord across an arc: on the longest, most curved wave
 * the sea can raise that is seven world units of daylight between the mark
 * and the water it is meant to be marking, which on a 50-unit scope is an
 * eighth of the radius. Six segments hold the arc to under a tenth of a unit,
 * well inside the 2.6-pixel stroke, and a straight wave costs exactly the
 * same six `lineTo` calls on a mark that is still a straight line.
 */
const CREST_SEGMENTS = 6;
const MAELSTROM_SPIN = 1.6;

/* ------------------------------------------------------------------ */
/* Raiders                                                             */
/* ------------------------------------------------------------------ */

/**
 * The two AI boats, in the two UI colours `style.css` carries as `--red` and
 * `--orange`.
 *
 * Written out here rather than read off a CSS custom property, on the same
 * terms as every other colour in this file: the scope is drawn into a 2D
 * canvas context that has no cascade to read, and a `getComputedStyle` per
 * mark per frame would be the most expensive thing on the instrument. Keep
 * these and the two custom properties in step; ART-DIRECTION.md §2.3 lists
 * both.
 *
 * Both are UI colours and stay off in-world objects, exactly as §2.4 says of
 * magenta. The hulls' own neon is a separate pair of LINEAR swatches in
 * `aihulls.ts` and the two pairs are not interchangeable.
 *
 * Red is the hunter, orange is the one running a straight line past you. That
 * is the whole reading a mark at the edge of the scope has to deliver, and it
 * is why the two are a hue apart rather than two shades of a warning colour.
 */
const RED_BOAT_FILL = 'rgb(255, 74, 60)';
const ORANGE_BOAT_FILL = 'rgb(255, 154, 60)';

/**
 * The outline under a raider's arrowhead.
 *
 * Own ship's blip carries a white hairline for the same reason: these are the
 * marks that must be found over a lit coastline in the half second the player
 * looks down, and a filled shape with no edge disappears into a beach.
 */
const BOAT_EDGE = 'rgba(255, 255, 255, 0.5)';

/**
 * The hull arrowhead, in scope radii, pointing at 12 o'clock.
 *
 * ONE shape, issued for own ship at the centre and for every raider out on the
 * plot, because they are the same kind of thing and the scope has to say so:
 * a raider drawn a shade smaller would read as further off than the projection
 * had already placed it, and the player would be judging a closing distance
 * against a mark that was quietly lying about it. Written as a path emitter
 * rather than as four numbers copied twice for exactly that reason.
 *
 * It is issued under whatever transform is in force, so a raider is drawn by
 * turning the canvas rather than by a second set of coordinates.
 */
function blipPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(0, -0.115);
  ctx.lineTo(0.072, 0.072);
  ctx.lineTo(0, 0.03);
  ctx.lineTo(-0.072, 0.072);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* The cardinal ring                                                   */
/* ------------------------------------------------------------------ */

/**
 * Colour of north, on the arrow and on its letter alike.
 *
 * Blue, and deliberately not the cyan the instrument itself is drawn in: at
 * 0.85 alpha over a lit tube a second cyan mark would be read as part of the
 * bezel. It is not magenta either, which is own ship's -- the blip at the
 * centre and the fix printed above the scope are the same fact about where the
 * player is, and north is a fact about the world.
 *
 * The arrow and the N are one mark in two parts and must never be told apart:
 * the arrow says which way, the letter says which way is what.
 */
const NORTH_FILL = 'rgba(77, 124, 255, 0.95)';

/** The other three, in the instrument's own cyan and quieter than north. */
const CARDINAL_FILL = 'rgba(63, 224, 255, 0.7)';

/**
 * The four letters, in the order their bearings are generated below.
 *
 * They rotate with the plot, because the scope is bow-up: a player reading E
 * off the right-hand rim is being told that east is to starboard, which is the
 * question actually being asked of a bow-up display. A fixed ring of letters
 * would be a north-up instrument's ring on a bow-up instrument, and would
 * disagree with the terrain under it the moment the ship turned.
 */
const CARDINALS = ['N', 'E', 'S', 'W'];

/**
 * Where the letters sit, as a fraction of the scope's radius.
 *
 * 0.885 puts them inside the rim with their own height clear of it. They
 * cannot go outside: the canvas is exactly the disc, so anything past 1 is
 * cropped by the element rather than drawn on the bezel. `letterRadius` below
 * treats this as a ceiling rather than a fixed figure, for exactly that
 * reason.
 */
const CARDINAL_RADIUS = 0.885;

/**
 * How much bigger north's letter is than the other three.
 *
 * Double. North is the only one of the four a player actually navigates by --
 * the other three are there so that the one they are looking for can be found
 * without counting round the rim -- and at a glance the ring should answer
 * "which way is north" before it answers anything else.
 */
const NORTH_LETTER_SCALE = 2;

/**
 * Half a letter's own height plus its halo, as a fraction of its font size.
 *
 * Used to keep each glyph inside the rim and to find where north's letter ends
 * so the arrow can stop short of it. 0.5 is a cap height of about 0.7 em
 * halved, the halo's half-width, and a pixel or two of air -- deliberately
 * generous, because the cost of being wrong in one direction is a letter with
 * its top sliced off by the canvas edge and in the other is a letter sitting a
 * pixel further in than it had to.
 */
const CARDINAL_INSET = 0.5;

/**
 * The north arrow: how far it stops short of the N, how long it is and how
 * wide at the base, all in scope radii.
 *
 * Wider and longer than it was. It is the mark that answers the scope's most
 * asked question, and beside a letter now twice the size of its neighbours a
 * thin dart read as an afterthought.
 *
 * Its position is DERIVED from the letter rather than fixed, because the
 * letter's own position is derived from the scope's size: the pixel floor on
 * the glyphs means north's letter reaches much further in on a small scope
 * than on a large one, and an arrow pinned to a constant radius would tuck
 * neatly under the N at one size and disappear behind it at another.
 */
const NORTH_ARROW_GAP = 0.035;
const NORTH_ARROW_LENGTH = 0.19;
const NORTH_ARROW_HALF_WIDTH = 0.085;

/**
 * Letter size in scope radii, and its floor in device pixels.
 *
 * Two numbers for the same reason the wind glyph has two: the scope runs from
 * 118px to 158px across, where 0.115 radii is 6.8 to 9.1px, and a 7px letter
 * over a terrain plot is a smudge. The floor wins at every size the panel
 * actually uses; the radii figure is what keeps the ring sane if the scope is
 * ever made much bigger. Both are device pixels, so a 2x display draws the
 * same physical size at twice the samples.
 */
const CARDINAL_SIZE = 0.115;
const CARDINAL_MIN_PX = 17;

/**
 * The radius a glyph of `px` device pixels may be centred on without any part
 * of it crossing the rim.
 *
 * The floor in CARDINAL_MIN_PX is what makes this necessary rather than
 * decorative: on a 118px scope at 1x it holds the letters at nearly a fifth of
 * the scope's radius each, and north's -- twice that again -- would have its
 * top sliced off by the canvas edge if it sat where the other three do. On a
 * large scope, or any 2x display, the floor stops binding and this returns
 * CARDINAL_RADIUS unchanged for all four.
 */
function letterRadius(px: number, R: number): number {
  return Math.min(CARDINAL_RADIUS, 1 - (px * CARDINAL_INSET) / R);
}

/**
 * The stack the letters are drawn in.
 *
 * Named here rather than typed at the call site because it has to match what
 * `style.css` sets on the HUD -- `--font-mono` -- and a canvas cannot read a
 * custom property. Two copies of a font stack is one more than ideal; the
 * alternative is reading the computed style every frame for a string that
 * never changes.
 */
const CARDINAL_FONT =
  'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';

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
  /**
   * `weather`, `cells` and `chart` are optional and all three absent is the
   * instrument the game shipped with: the full range, everything drawn live,
   * and nothing remembered.
   */
  update(
    dt: number,
    ship: ShipState,
    wind: WindState,
    hazards: HazardState,
    boats?: AiBoatState,
    weather?: WeatherState,
    cells?: CellsState,
    chart?: Chart,
  ): void;
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
 * What a pixel the scope cannot currently SEE is painted.
 *
 * A flat, cold slate. Not black: black reads as a hole in the instrument
 * rather than as murk, and the range rings still have to be legible over it
 * so the player can see how much of their scope the weather has taken.
 */
const SCOPE_FOG = [10, 22, 30];

/**
 * How far toward that fog a REMEMBERED pixel is drawn.
 *
 * A coast the ship has charted but cannot presently see is still drawn --
 * that is the entire point of a chart -- but drawn dim, so remembered and
 * seen are never confused. 0.55 of the way to the fog colour is enough to
 * separate them at a glance and not so far as to lose the coastline.
 */
const CHART_DIM = 0.55;

/**
 * Storm and fog cells on the plot, and how solid they are drawn.
 *
 * A desaturated slate-violet for a storm, a pale grey for a bank: both
 * outside the terrain palette, for the same reason the dock's mint is, and
 * both drawn as translucent fills rather than outlines because a cell is an
 * area of weather rather than an object with an edge.
 */
const SCOPE_STORM = 'rgba(122, 132, 178, 0.28)';
const SCOPE_FOGCELL = 'rgba(196, 204, 210, 0.24)';
const SCOPE_STORM_EDGE = 'rgba(150, 160, 205, 0.55)';

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

/**
 * Harbour names beside their diamonds, in the berth's own mint.
 *
 * The same colour as the icon and deliberately not a quieter one: the name and
 * the diamond are one mark in two parts, exactly as north's arrow and its
 * letter are, and a label in a second colour would read as a separate thing
 * that happens to be nearby. The world is redrawn on every load, so a name is
 * the ONLY durable fact about a harbour — the diamond alone says "somewhere to
 * moor", and the pair says "this is the place you were looking for".
 *
 * Two sizes, and the discriminator is the scope's own width rather than the
 * viewport's. The panel comes in at 720px of viewport (`style.css`), which
 * takes the scope from 118..158 CSS px down to 104, and 9px of name over a
 * 104px plot buries the coastline it is meant to be labelling. Written in CSS
 * pixels and multiplied by the live device-pixel ratio at the call site, which
 * is what makes "7px" mean the same physical size on a 1x and a 2x display —
 * the one place this file departs from the cardinal ring's device-pixel floor,
 * and it does so because a size chosen against a MEDIA QUERY has to be in the
 * units the media query is in.
 */
const NAME_FILL = DOCK_FILL;
const NAME_HALO = 'rgba(2, 10, 18, 0.85)';
const NAME_SMALL_SCOPE_PX = 112;
const NAME_SMALL_CSS_PX = 7;
const NAME_CSS_PX = 9;

/**
 * How far the name sits from the centre of its diamond, in scope radii.
 *
 * Offset OUTWARD — away from the scope's centre — rather than to a fixed side.
 * A label always to the right would sit on top of the coast a harbour on the
 * right-hand rim is standing on, which is the one piece of terrain the player
 * is reading when they look at that harbour at all. Outward, it falls on the
 * water or the bezel the ship has already sailed past, and it also stops the
 * whole ring of labels leaning the same way.
 *
 * The gap clears the hairline ring around the diamond (`DOCK_ICON * 1.55`)
 * with a little air; the text is anchored on the far side of it, so the two
 * never touch at any scope size.
 */
const NAME_GAP = DOCK_ICON * 1.55 + 0.03;

/* ------------------------------------------------------------------ */
/* The hull annunciator                                                */
/* ------------------------------------------------------------------ */

/**
 * The two colours a hull warning is drawn in.
 *
 * Lifted from the telemetry panel's own hull block (`hull--worn`'s amber and
 * `hull--critical`'s red) rather than from the two raider colours a few
 * constants above, and the distinction matters more than it looks: on this
 * instrument `--red` and `--orange` already mean "a boat, and which kind", and
 * a third mark in either would be read as a raider that had somehow got onto
 * the bezel. These two are the HUD's warning pair instead, so the glyph is the
 * same colour as the block it is warning about.
 *
 * Keep them in step with the HULL section at the end of `style.css`, on the
 * same terms as the raider pair above: a 2D canvas has no cascade to read.
 */
const HULL_WARN_FILL = 'rgb(255, 180, 69)';
const HULL_CRIT_FILL = 'rgb(255, 84, 112)';

/**
 * Where the glyph sits, and how big it is, in scope radii.
 *
 * A BEZEL ornament, like the wind arrow and the compass ring, and it is the
 * only one of the three pinned to the canvas rather than to a bearing. That is
 * on purpose: the wind arrow swings with the weather and the cardinals swing
 * with the helm, so a warning placed "beside" either would be a warning that
 * spends part of every turn hidden behind the mark it was placed beside. The
 * lower-left quadrant is the one stretch of rim no rotating mark ever rests
 * on for long, and a fixed station is what lets a player find an alarm without
 * first finding out where it went.
 *
 * Below the 50% threshold and nothing above it: a sound hull has nothing to
 * say, and an annunciator that is lit in the ordinary case is furniture.
 */
const HULL_MARK_X = -0.72;
const HULL_MARK_Y = 0.72;
const HULL_MARK_SIZE = 0.085;

/** Percent below which the glyph shows at all, and below which it turns red. */
const HULL_MARK_WARN_BELOW = 50;
const HULL_MARK_CRIT_BELOW = 25;
/** Percent at which it flashes: the floor, and nothing else. */
const HULL_MARK_FLASH_AT = 1;

/**
 * The flash, in seconds per cycle and in how far down it dips.
 *
 * 900ms and 0.3, which is `pwr-alarm` in `style.css` to the millisecond. The
 * panel's power block and this scope are two instruments a player watches at
 * once, and two alarms beating against each other at slightly different rates
 * is the sort of thing that reads as a rendering fault rather than as an
 * alarm.
 */
const HULL_FLASH_PERIOD = 0.9;
const HULL_FLASH_FLOOR = 0.3;

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
  /**
   * Names of harbours the ship has moored at, in this world or an earlier one.
   *
   * A live `ReadonlySet` handed over once, not a snapshot: `knownharbours.ts`
   * mutates the set the moment a berth is made, and the scope has to show the
   * name on the same frame rather than on the next reload. An empty default is
   * a ship that has never moored anywhere, which is exactly what a new save
   * is.
   */
  known: ReadonlySet<string> = new Set(),
  /**
   * The durability sim, for the bezel's warning glyph and nothing else. The
   * stub is a sound hull, so a caller that knows nothing about durability gets
   * the instrument the game shipped with.
   */
  hull: Hull = createStubHull(),
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
  /**
   * Each pixel's distance from the scope's centre, as a fraction of
   * `RADAR_RANGE`.
   *
   * Precomputed with the projection tables beside it, and for the same
   * reason: the visibility mask below is a comparison against this on every
   * pixel of every raster, and `Math.hypot` on 37000 pixels ten times a
   * second to recover a number the build loop already had would be waste.
   */
  const kRadius = new Float32Array(cells);
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
      kRadius[i] = r;
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

  /*
   * The LIVE ship frame, and the scratch the hazard marks are projected with.
   *
   * Deliberately a second frame rather than the raster's `pUp`/`pFwd`/`pStb`.
   * The held frame exists to weld a town to the coastline drawn under it, and
   * a hazard has no coastline: it is a moving thing attached to nothing on the
   * picture, exactly like the wind arrow and the compass, so it is placed from
   * this instant's attitude. Through a frame a tenth of a second old a crest
   * would lag the bow through every turn, which on the one mark a player steers
   * to avoid is worse than being a fraction stale against the plot.
   */
  const hUp = new Vector3();
  const hFwd = new Vector3();
  const hStb = new Vector3();
  /** Where a projected hazard point lands, in scope units. Reused; never allocated per mark. */
  const hazPoint = { x: 0, y: 0 };
  const hazDir = new Vector3();

  /**
   * Projects a unit direction into scope units through the live frame.
   *
   * The same inversion the town icons use -- `dir . up` is already cos(t) and
   * the two tangent dots are already sin(t)cos(b) and sin(t)sin(b) -- written
   * once more against this frame rather than duplicated inline at each mark.
   * Returns false when the point is outside the scope's angular radius, so a
   * crest with one end over the horizon is simply not drawn from that end.
   */
  /**
   * The live frame's own cull, in cosine, so `projectLive` can compare
   * against it without a trig call per mark.
   *
   * Rewritten once a frame in `update` from `WeatherState.visibility`, and
   * exactly `COS_RADAR_RANGE` in clear weather -- so with no weather threaded
   * through, every mark on the scope is culled precisely where it always was.
   */
  let cosSight = COS_RADAR_RANGE;

  function projectLive(d: Vector3): boolean {
    const c = hUp.x * d.x + hUp.y * d.y + hUp.z * d.z;
    // Hazards and raiders are LIVE things: seen or not seen, and never
    // remembered. The chart holds coastline and harbours, which do not move;
    // a crest the ship saw a minute ago is not information, it is a ghost.
    if (c < cosSight) return false;
    const cc = c > 1 ? 1 : c;
    const sinT = Math.sqrt(1 - cc * cc);
    const r = (Math.acos(cc) * GLOBE_RADIUS) / RADAR_RANGE;
    const k = sinT < 1e-6 ? 0 : r / sinT;
    const f = hFwd.x * d.x + hFwd.y * d.y + hFwd.z * d.z;
    const st = hStb.x * d.x + hStb.y * d.y + hStb.z * d.z;
    hazPoint.x = k * st;
    // Canvas y runs down while the bow points up the screen.
    hazPoint.y = -k * f;
    return true;
  }

  let sinceRaster = Infinity;
  let sweep = 0;
  /** Turns the maelstrom's arcs. Wrapped so it cannot drift out of float precision on a long run. */
  let spin = 0;
  /**
   * The hull annunciator's flash phase, seconds into its own cycle.
   *
   * Its own accumulator rather than a share of `sweep`'s: the sweep is four
   * seconds a lap and this is nine-tenths of one, and hanging an alarm off a
   * clock tuned for something else is how the two end up retuned together by
   * accident. Wrapped for `spin`'s reason.
   */
  let alarm = 0;
  let cssSize = 0;

  /**
   * Rasterise the plot.
   *
   * Three cases per pixel, and the order they are tested in is the order they
   * cost:
   *
   *  - Beyond the current visibility and never charted: `SCOPE_FOG`, and no
   *    height-map read at all. In thick weather that is two thirds of the
   *    scope skipped, which is the one place the mask pays for itself.
   *  - Beyond visibility but charted: drawn, then dimmed toward the fog.
   *    Remembered, not seen.
   *  - Inside visibility: drawn as it always was.
   *
   * The scope's GEOMETRY does not change with the weather. `RADAR_RANGE` and
   * the projection tables built from it are fixed, and the range rings still
   * draw at the radii they always did; what shrinks is how much of that
   * geometry has anything in it. Re-ranging the instrument instead would mean
   * rebuilding those tables whenever the fog thickened, and would leave the
   * player without the one cue that tells them how much they have lost.
   */
  function raster(visibility: number, chart: Chart | null): void {
    if (!plotCtx || !image || !frameValid) return;

    const up = pUp;
    const fwd = pFwd;
    const starboard = pStb;
    const data = image.data;
    const seeable = visibility / RADAR_RANGE;

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

      const seen = kRadius[i] <= seeable;
      if (!seen && chart !== null && !chart.discovered(dir)) {
        data[o] = SCOPE_FOG[0];
        data[o + 1] = SCOPE_FOG[1];
        data[o + 2] = SCOPE_FOG[2];
        data[o + 3] = 255;
        continue;
      }

      surfaceColor(heightMap.sample(dir), seaLevel, waterBodies.sample(dir), rgb);
      if (!seen) {
        // Charted, but not in sight: the same coastline, turned down.
        data[o] = rgb[0] + (SCOPE_FOG[0] - rgb[0]) * CHART_DIM;
        data[o + 1] = rgb[1] + (SCOPE_FOG[1] - rgb[1]) * CHART_DIM;
        data[o + 2] = rgb[2] + (SCOPE_FOG[2] - rgb[2]) * CHART_DIM;
      } else {
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
      }
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

  function update(
    dt: number,
    ship: ShipState,
    wind: WindState,
    hazards: HazardState,
    boats?: AiBoatState,
    weather?: WeatherState,
    cells?: CellsState,
    chart?: Chart,
  ): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    // How far the scope can see this frame. Absent weather is clear weather,
    // so a caller that knows nothing about it gets the whole instrument.
    const visibility = weather ? weather.visibility : RADAR_RANGE;
    const theChart = chart ?? null;
    cosSight = Math.cos(visibility / GLOBE_RADIUS);

    sinceRaster += dt;
    if (sinceRaster >= 1 / RASTER_HZ) {
      sinceRaster = 0;
      captureFrame(ship);
      raster(visibility, theChart);
      /*
       * And chart exactly the disc that was just drawn live.
       *
       * Here rather than in the frame loop because this is the one place that
       * knows both numbers -- what the scope can see, and when it last looked
       * -- and it already runs at the right rate. Tying discovery to
       * visibility is also what makes fog cost something lasting: a coast
       * passed in thick weather is not charted, and has to be passed again.
       */
      if (theChart !== null) theChart.reveal(ship.position, visibility);
    }
    if (theChart !== null) theChart.tick(dt);

    sweep = (sweep + (dt * Math.PI * 2) / SWEEP_PERIOD) % (Math.PI * 2);
    spin = (spin + dt * MAELSTROM_SPIN) % (Math.PI * 2);
    alarm = (alarm + dt) % HULL_FLASH_PERIOD;

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

      /*
       * Names are collected here and drawn in one pass below, in device
       * pixels, after every icon is down.
       *
       * Two reasons, and the second is the one that matters. A glyph has a
       * size of its own and cannot be authored in a unit system where 1 is the
       * whole scope -- the same escape the cardinal letters and the wind glyph
       * make, by the same route -- so the text pass runs under a different
       * transform and cannot be interleaved with the diamonds. And drawing
       * every label after every icon is what stops one harbour's name being
       * painted over by the next harbour's diamond on a crowded coastline,
       * which at CLUSTER_MIN_ARC's 15 units is a coastline the world routinely
       * produces.
       */
      const labels: { x: number; y: number; name: string; alpha: number }[] = [];

      const list = towns.all;
      // The same cull the raster's mask uses, in the cosine the town loop
      // already compares against, so the icons and the plot under them agree
      // about where sight ends.
      const cosVisibility = Math.cos(visibility / GLOBE_RADIUS);
      for (let i = 0; i < list.length; i++) {
        const town = list[i];
        const d = town.dir;
        // Cull before any trig. Walking the whole list is free; calling acos
        // down it is not, and neither is the garbage a per-town Vector3 would
        // make sixty times a second.
        const c = pUp.x * d.x + pUp.y * d.y + pUp.z * d.z;
        if (c < COS_RADAR_RANGE) continue;
        /*
         * Beyond what the scope can presently see, a harbour is drawn only if
         * it is remembered -- and then out to the full range, exactly as
         * before. A remembered harbour is most of the point of keeping a
         * chart at all: fog should make a coast hard to READ, not make the
         * berth you were running for cease to exist.
         *
         * Remembered means either of two things, and the second is the whole
         * of decision 9. The CHART is where this world has been: it is wiped
         * with the world, because it records ground. `known` is where the SHIP
         * has been, by name, and it survives every world the player ever
         * loads -- so a harbour moored at three seas ago is on the scope from
         * the first frame of a sea it has never been seen in, at whatever
         * position this world put it. The chart cannot express that, because
         * the chart is a picture of a coastline that no longer exists.
         */
        const remembered =
          known.has(town.name) || (theChart !== null && theChart.discovered(d));
        if (c < cosVisibility && !remembered) continue;

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

        const iconAlpha = r > ICON_FADE ? Math.max(0, (1 - r) / (1 - ICON_FADE)) : 1;
        ctx.globalAlpha = iconAlpha;

        // Every harbour that is drawn is named. The two are one mark, so the
        // label rides the icon's own fade into the bezel rather than a fade of
        // its own. Queued outside the branch below rather than inside it, so
        // that this line survives the day `town.dock` stops being nullable and
        // that branch goes away.
        if (town.dock !== null && town.name !== '') {
          labels.push({ x, y, name: town.name, alpha: iconAlpha });
        }

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

      /*
       * The names, in device pixels and still inside the bezel clip.
       *
       * Each one is anchored on the side of its diamond AWAY from the scope's
       * centre, so it leans out over water the ship has already passed rather
       * than over the coast the harbour is standing on -- which is the one
       * piece of terrain a player is reading when they look at a harbour at
       * all. `textAlign` follows the same sign, so the text grows outward
       * instead of straddling the anchor.
       *
       * A dark halo under every glyph, for the cardinal ring's reason: this is
       * mint over a lit coastline, and a bare glyph on a beach is unreadable
       * at exactly the moment it is wanted.
       */
      if (labels.length > 0) {
        const dpr = cssSize > 0 ? (R * 2) / cssSize : 1;
        const namePx =
          (cssSize > 0 && cssSize < NAME_SMALL_SCOPE_PX ? NAME_SMALL_CSS_PX : NAME_CSS_PX) * dpr;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(R, R);
        ctx.font = `600 ${namePx}px ${CARDINAL_FONT}`;
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, namePx * 0.18);
        ctx.strokeStyle = NAME_HALO;
        ctx.fillStyle = NAME_FILL;
        for (const label of labels) {
          // Dead centre has no "away from the centre"; a harbour under the
          // keel takes the starboard side, which is where the eye already is
          // on a bow-up plot.
          const outward = label.x >= 0 ? 1 : -1;
          ctx.textAlign = outward > 0 ? 'left' : 'right';
          const tx = (label.x + outward * NAME_GAP) * R;
          const ty = label.y * R;
          ctx.globalAlpha = label.alpha;
          ctx.strokeText(label.name, tx, ty);
          ctx.fillText(label.name, tx, ty);
        }
        ctx.restore();
      }

      ctx.restore();
    }

    // ---- Rough water, from the LIVE frame ---------------------------------
    /*
     * Crests and funnels, drawn over the plot and under the marks the player
     * navigates by.
     *
     * `hazards.live` is at most three entries, so this loop is free; the
     * common case is that it is empty and nothing below runs at all.
     */
    /*
     * The live frame, captured once for every mark that is placed from this
     * instant rather than from the raster's.
     *
     * It was inside the hazard block while hazards were its only reader. The
     * raiders read it too now, and both must be projected through ONE frame:
     * two blocks each building their own from the same ship state would agree
     * today and would be free to disagree the first time either was touched,
     * which is the second-projection failure the town icons' comment above
     * spells out at length.
     */
    hStb.crossVectors(ship.forward, ship.up);
    const liveFrame = hStb.lengthSq() > 1e-12;
    if (liveFrame) {
      hStb.normalize();
      hUp.copy(ship.up);
      hFwd.copy(ship.forward);
    }

    /*
     * Weather cells, drawn UNDER the hazards and the raiders and over the
     * plot.
     *
     * From the live frame, like everything else that moves, and for the same
     * reason: a cell drifts and a raster is up to a tenth of a second old.
     *
     * A cell is drawn as a filled disc of `radius * strength`, so it grows on
     * the instrument over the same half-minute it grows in the sky, and it is
     * culled on `RADAR_RANGE + radius` rather than on the range alone -- a
     * bank whose centre is off the scope but whose edge is on it is exactly
     * the case the player most needs to see.
     *
     * It is masked by visibility like everything else: you cannot see a
     * second storm through the first one.
     */
    if (cells !== undefined && cells.live.length > 0 && liveFrame) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.clip();
      for (const cell of cells.live) {
        if (cell.strength <= 0) continue;
        const c = hUp.x * cell.centre.x + hUp.y * cell.centre.y + hUp.z * cell.centre.z;
        const cc = c > 1 ? 1 : c < -1 ? -1 : c;
        const distance = Math.acos(cc) * GLOBE_RADIUS;
        if (distance > visibility + cell.radius) continue;

        const sinT = Math.sqrt(1 - cc * cc);
        const r = distance / RADAR_RANGE;
        const k = sinT < 1e-6 ? 0 : r / sinT;
        const f = hFwd.x * cell.centre.x + hFwd.y * cell.centre.y + hFwd.z * cell.centre.z;
        const st = hStb.x * cell.centre.x + hStb.y * cell.centre.y + hStb.z * cell.centre.z;
        const cx = k * st;
        const cy = -k * f;
        const radius = (cell.radius * cell.strength) / RADAR_RANGE;
        if (!(radius > 0)) continue;

        ctx.fillStyle = cell.kind === 'fog' ? SCOPE_FOGCELL : SCOPE_STORM;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();

        // A lightning cell gets a mark at its centre. It is the one piece of
        // information on the scope that the sky cannot give the player from
        // outside: a storm and a storm with lightning in it look alike at
        // forty units, and only one of them is worth going round.
        if (cell.kind === 'storm' && cell.lightning) {
          const z = Math.min(radius * 0.45, 0.09);
          ctx.strokeStyle = SCOPE_STORM_EDGE;
          ctx.lineWidth = 1.6 / R;
          ctx.beginPath();
          ctx.moveTo(cx - z * 0.5, cy - z);
          ctx.lineTo(cx + z * 0.2, cy - z * 0.15);
          ctx.lineTo(cx - z * 0.2, cy + z * 0.15);
          ctx.lineTo(cx + z * 0.5, cy + z);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (hazards.live.length > 0) {
      if (liveFrame) {
        // Clipped to the bezel like the towns are: a crest crossing the rim is
        // drawn cut rather than spilling onto the panel around the scope.
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, Math.PI * 2);
        ctx.clip();
        ctx.strokeStyle = HAZARD_STROKE;
        ctx.lineCap = 'round';

        for (let i = 0; i < hazards.live.length; i++) {
          const haz = hazards.live[i];
          // The same envelope the sea is displaced by, so a hazard fades off
          // the scope at the moment it fades out of the water -- including the
          // distance fade, which is what stops a crest that has outrun the
          // displacement patch from being marked here as if it were still real.
          ctx.globalAlpha = haz.envelope < 0 ? 0 : haz.envelope > 1 ? 1 : haz.envelope;

          if (haz.kind === 'maelstrom') {
            if (!projectLive(haz.centre)) continue;
            const cx = hazPoint.x;
            const cy = hazPoint.y;
            // Its drawn radius is the radius it actually has this instant --
            // `extent * size` -- so the ring grows on the scope over the same
            // three seconds the funnel opens in the water.
            const radius = (haz.extent * haz.size) / RADAR_RANGE;
            if (!(radius > 0)) continue;

            ctx.lineWidth = MAELSTROM_WIDTH_PX / R;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.stroke();

            // Three arcs on the ring, turned by the elapsed time. The geometry
            // of a funnel is radially symmetric and has no rotation in it at
            // all, so this is the only thing on the instrument that says the
            // water in there is going round.
            ctx.lineWidth = (MAELSTROM_WIDTH_PX * 1.7) / R;
            for (let k = 0; k < 3; k++) {
              const a0 = spin + (k * 2 * Math.PI) / 3;
              ctx.beginPath();
              ctx.arc(cx, cy, radius * 0.62, a0, a0 + MAELSTROM_ARC);
              ctx.stroke();
            }
            continue;
          }

          // A crest is its own long axis, and that axis is the ARC the water
          // actually stands on: `centre + t * extent * east`, pulled back
          // along `north` by `bow * extent * t^2`, which is the crest line
          // `hazardfield.ts`'s `hazBowV` puts the height on. Every point is
          // stepped in DIRECTION units and projected separately, because
          // drawing from a centre and a heading instead would be a second
          // projection, and a bar a few degrees off its own wave reads as a
          // rendering nicety rather than as an error.
          //
          // The polyline breaks rather than skipping the whole crest when a
          // point falls off the projection: a long front crossing the rim has
          // one end behind the observer, and the near half of it is still a
          // wave the player needs marked.
          const half = haz.extent / GLOBE_RADIUS;
          const trail = (haz.bow * haz.extent) / GLOBE_RADIUS;

          // Drawn heavier the taller it is, off the amplitude rather than off
          // the kind -- which is the only thing it could be off now that the
          // two crest kinds are one and the height is a continuous roll. The
          // threshold is where the old great wave sat, so the scope says the
          // same thing about the same water it always did.
          ctx.lineWidth = (CREST_WIDTH_PX * (haz.amplitude > 2 ? 1.5 : 1)) / R;
          ctx.beginPath();
          let pen = false;
          for (let k = 0; k <= CREST_SEGMENTS; k++) {
            const t = (2 * k) / CREST_SEGMENTS - 1;
            hazDir
              .copy(haz.centre)
              .addScaledVector(haz.east, half * t)
              .addScaledVector(haz.north, -trail * t * t)
              .normalize();
            if (!projectLive(hazDir)) {
              pen = false;
              continue;
            }
            if (pen) ctx.lineTo(hazPoint.x, hazPoint.y);
            else ctx.moveTo(hazPoint.x, hazPoint.y);
            pen = true;
          }
          ctx.stroke();
        }

        // `restore` puts back the alpha, the line cap and the clip together --
        // the same contract the town block above relies on.
        ctx.restore();
      }
    }

    // ---- Raiders, from the LIVE frame -------------------------------------
    /*
     * The AI boats, drawn over the plot and over the crests, under the compass.
     *
     * Live, for the hazards' own reason and more so: a raider is a moving hull
     * attached to nothing on the picture, and the one it is closing on is at
     * the centre of the scope. A mark that lagged the bow through a turn would
     * be lagging exactly when the player is turning to shake it.
     *
     * `boats` is optional so a hand-built call in a test, and the world before
     * `aiboats.ts` has been wired, both draw a scope with no raiders on it
     * rather than throwing. `live` is at most two entries, so this loop costs
     * nothing and is empty on almost every frame of a run.
     */
    if (liveFrame && boats && boats.live.length > 0) {
      // Clipped to the bezel, like the towns and the crests: a boat straddling
      // the rim is drawn cut rather than spilling onto the panel around the
      // scope.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.clip();
      ctx.lineWidth = 0.9 / R;
      ctx.strokeStyle = BOAT_EDGE;

      for (let i = 0; i < boats.live.length; i++) {
        const boat = boats.live[i];
        if (!projectLive(boat.position)) continue;
        const bx = hazPoint.x;
        const by = hazPoint.y;

        // The same envelope the hull's own neon and rim are lit by, so a boat
        // arrives on the scope as it arrives on the water and leaves the same
        // way. A hull fading out over its last second is not a contact any
        // more, and the mark says so before it goes.
        ctx.globalAlpha = boat.envelope < 0 ? 0 : boat.envelope > 1 ? 1 : boat.envelope;

        /*
         * Which way its bow points, measured between two world vectors rather
         * than subtracted between two compass bearings.
         *
         * That is the project's own rule -- see **Frames, and where they stop
         * working** in docs/ARCHITECTURE.md: the vectors are the truth and the
         * angles are read off them. `boat.forward` is a tangent at the boat
         * and this frame is a tangent at the ship, so resolving one against
         * the other carries the small error of the arc between them; over the
         * scope's half-radian that is a couple of degrees on a mark the size
         * of the blip, and it costs two dot products instead of a second
         * projection.
         */
        const f = hFwd.x * boat.forward.x + hFwd.y * boat.forward.y + hFwd.z * boat.forward.z;
        const s = hStb.x * boat.forward.x + hStb.y * boat.forward.y + hStb.z * boat.forward.z;
        const a = Math.atan2(s, f);

        /*
         * The blip's own outline, turned and moved.
         *
         * The path is built under the boat's transform and then filled with
         * the transform put back, which is deliberate and is how Canvas2D
         * works: path points are resolved against the matrix in force when
         * each command is issued, while `lineWidth` is resolved at the stroke.
         * Restoring first is therefore what keeps the hairline exactly the
         * 0.9 device pixels own ship's carries, instead of the scope's radius
         * multiplied by it.
         */
        const sinA = Math.sin(a);
        const cosA = Math.cos(a);
        ctx.save();
        ctx.transform(cosA, sinA, -sinA, cosA, bx, by);
        blipPath(ctx);
        ctx.restore();
        ctx.fillStyle = boat.kind === 'red' ? RED_BOAT_FILL : ORANGE_BOAT_FILL;
        ctx.fill();
        ctx.stroke();
      }

      // Puts back the alpha, the line width and the clip together, the same
      // contract the two blocks above rely on.
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
     * The speed test is now only a guard against a zero-length arrow, not a
     * calm: `wind.ts` floors the weather at LULL_SPEED and there is no longer
     * a state in which nothing is blowing. It is kept because this file also
     * runs against hand-built `WindState`s in the tests, and an arrow scaled
     * off a zero speed is a division waiting to happen.
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

    // ---- The cardinal ring: N/E/S/W, and the arrow on north ---------------
    //
    // The scope is bow-up, so all five marks swing with the heading and every
    // one of them goes through `scopeAngle`. Drawn after the wind, so that a
    // wind blowing due north leaves the compass on top: the player can lose
    // the weather behind a mark for a moment, but never the direction they
    // navigate by.
    const northAngle = scopeAngle(0, ship.heading);
    const nx = Math.sin(northAngle);
    const ny = -Math.cos(northAngle);

    // Both letter sizes, and where north's ends, are wanted before either the
    // arrow or the ring is drawn: the arrow is placed off the N's inner edge,
    // and the N's own radius depends on how big it came out.
    const letterPx = Math.max(CARDINAL_MIN_PX, R * CARDINAL_SIZE);
    const northPx = letterPx * NORTH_LETTER_SCALE;
    const northRing = letterRadius(northPx, R);
    const northInner = northRing - (northPx * CARDINAL_INSET) / R;

    // The arrow, tucked under its own letter rather than reaching the rim as
    // it used to. It points at the N and the two are one mark, but they are
    // not one shape: the tip stops short of the letter so the pair reads as an
    // arrow beside an N rather than as a single blue smudge.
    const tip = northInner - NORTH_ARROW_GAP;
    const base = tip - NORTH_ARROW_LENGTH;
    const halfW = NORTH_ARROW_HALF_WIDTH;
    ctx.beginPath();
    ctx.moveTo(nx * tip, ny * tip);
    ctx.lineTo(nx * base - ny * halfW, ny * base + nx * halfW);
    ctx.lineTo(nx * base + ny * halfW, ny * base - nx * halfW);
    ctx.closePath();
    ctx.fillStyle = NORTH_FILL;
    ctx.fill();

    // The letters are drawn in DEVICE pixels rather than in scope radii. A
    // glyph is the one mark on this instrument with a size of its own -- it
    // has to stay legible while everything around it scales -- and the floor
    // in CARDINAL_MIN_PX cannot be expressed in a unit system where 1 is the
    // whole scope. The same escape the wind glyph makes, by the same route.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(R, R);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // A dark halo under each letter, because the ring crosses whatever the
    // terrain plot put there -- a coastline, a peak, open water -- and a bare
    // glyph over a lit shoreline is unreadable at exactly the moment it
    // matters. Stroked before the fill so the halo sits behind its own letter.
    ctx.strokeStyle = 'rgba(2, 10, 18, 0.85)';
    for (let i = 0; i < CARDINALS.length; i++) {
      const north = i === 0;
      const px = north ? northPx : letterPx;
      const ring = north ? northRing : letterRadius(px, R);
      const a = scopeAngle((i * Math.PI) / 2, ship.heading);
      const x = Math.sin(a) * ring * R;
      const y = -Math.cos(a) * ring * R;
      ctx.font = `700 ${px}px ${CARDINAL_FONT}`;
      ctx.lineWidth = Math.max(2, px * 0.16);
      ctx.strokeText(CARDINALS[i], x, y);
      ctx.fillStyle = north ? NORTH_FILL : CARDINAL_FILL;
      ctx.fillText(CARDINALS[i], x, y);
    }
    ctx.restore();

    // ---- The hull annunciator, on the bezel -------------------------------
    /*
     * A warning triangle, and it is the only mark on this instrument that is
     * about the SHIP rather than about the sea.
     *
     * Three states and no more, because an annunciator that reports a
     * continuous quantity is a gauge, and the panel already has the gauge. It
     * is outlined while the hull is merely worn -- a cap the player has to
     * plan around -- and filled once it is failing, because a filled shape is
     * found by peripheral vision and an outline is not. At the 1% floor it
     * flashes, on the same 900ms the power block's own alarm keeps.
     *
     * Nothing at all at 50% and above. Almost every hour of play happens up
     * there, and a scope with a permanent light on it is a scope whose lights
     * stop meaning anything.
     */
    const hullPercent = hull.state.percent;
    if (hullPercent < HULL_MARK_WARN_BELOW) {
      const critical = hullPercent < HULL_MARK_CRIT_BELOW;
      const colour = critical ? HULL_CRIT_FILL : HULL_WARN_FILL;
      const size = HULL_MARK_SIZE;

      ctx.save();
      if (hullPercent <= HULL_MARK_FLASH_AT) {
        const wave = 0.5 + 0.5 * Math.cos((alarm / HULL_FLASH_PERIOD) * Math.PI * 2);
        ctx.globalAlpha = HULL_FLASH_FLOOR + (1 - HULL_FLASH_FLOOR) * wave;
      }

      ctx.beginPath();
      ctx.moveTo(HULL_MARK_X, HULL_MARK_Y - size);
      ctx.lineTo(HULL_MARK_X + size * 0.92, HULL_MARK_Y + size * 0.7);
      ctx.lineTo(HULL_MARK_X - size * 0.92, HULL_MARK_Y + size * 0.7);
      ctx.closePath();
      ctx.lineJoin = 'round';
      if (critical) {
        ctx.fillStyle = colour;
        ctx.fill();
      } else {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2.2 / R;
        ctx.stroke();
      }

      // The bar and the dot inside it. On the filled triangle they are cut out
      // in the scope's own ground rather than drawn in a third colour, so the
      // mark stays two colours at every size -- at 20 device pixels a third
      // one is a smudge, not a detail.
      ctx.strokeStyle = critical ? '#020a12' : colour;
      ctx.lineWidth = 2 / R;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(HULL_MARK_X, HULL_MARK_Y - size * 0.42);
      ctx.lineTo(HULL_MARK_X, HULL_MARK_Y + size * 0.14);
      ctx.moveTo(HULL_MARK_X, HULL_MARK_Y + size * 0.42);
      ctx.lineTo(HULL_MARK_X, HULL_MARK_Y + size * 0.43);
      ctx.stroke();
      ctx.restore();
    }

    // ---- Own ship, always dead centre and always pointing up --------------
    // The same shape every raider is drawn with, issued with no transform in
    // force: see `blipPath`.
    blipPath(ctx);
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
