import type { FishState, FishingState, Species, SpeciesArt } from './types';

/**
 * fishrender.ts — the fishing card's painter.
 *
 * A 2D canvas, drawn from a `FishingState` every frame, on exactly the terms
 * `radar.ts` draws the scope on: the drawing buffer is sized from the element
 * and the device pixel ratio, everything that can be built once is built once,
 * and the per-frame path allocates nothing but the paths it strokes.
 *
 * The whole picture is drawn in CARD UNITS through a single `setTransform`:
 * x runs [0, 1] across the card and y runs [0, 16/9] down it, which is the
 * coordinate system `fishsim.ts` computes in. Nothing downstream of that
 * transform knows what a pixel is, with one deliberate exception — text, see
 * `drawGlyph` — so a card 300px wide and a card 900px wide are the same
 * picture and the ruleset never has to be told which one it is running on.
 *
 * This is the ONLY module that reads `SpeciesArt`. Real art arrives as an
 * `image` on that record and nothing else in the project changes.
 */

/* ------------------------------------------------------------------ */
/* Geometry — see docs/FISHING_PLAN.md, "Geometry"                     */
/* ------------------------------------------------------------------ */

/** The card is 9:16, so its height in card-WIDTH units is 16/9. */
const CARD_HEIGHT = 16 / 9;

/** Where the sea starts. Everything above is sky, everything below is water. */
const WATERLINE = 0.28;

/** The harpoon hangs from here, just under the hull. */
const PIVOT_X = 0.5;
const PIVOT_Y = 0.3;

/** Base fish length in card widths; `Species.size` multiplies it. */
const FISH_LENGTH = 0.06;

/** The boat is three fish long until there is art for it. */
const BOAT_LENGTH = FISH_LENGTH * 3;

/**
 * Fraction of the boat's own length it sits above the wave it rides.
 *
 * An emoji is drawn inside a square em box and the hull occupies only the
 * lower part of it, so centring that box on the sea would beach the ship. This
 * lifts the box until the hull's bottom meets the water instead.
 */
const BOAT_DRAFT = 0.42;

/**
 * Device pixel ratio ceiling, as in `radar.ts`.
 *
 * The card is the largest surface in the HUD — over 500px on a desktop — and
 * a 3x phone would ask for a 1500px buffer to draw a dozen emoji on. Two is
 * already past the point where any of this is resolvable.
 */
const MAX_DPR = 2;

/* ------------------------------------------------------------------ */
/* Palette — keyed to :root in style.css                               */
/* ------------------------------------------------------------------ */

const SKY = '#05080f';
const WATER_TOP = '#0b3a5e';
const WATER_BOTTOM = '#03101f';
const CYAN = '#3fe0ff';
const MAGENTA = '#ff4fd8';
const GOLD = '#ffc44d';
const ROPE = '#6f93a6';

/**
 * The sea's surface, and the reason the card is not a still image.
 *
 * Two harmonics rather than one: a single sine reads as a drawn curve, and the
 * beat between three waves and seven is what makes it read as water. The
 * amplitude is under a hundredth of the card, so the waterline is still the
 * flat line the geometry table says it is.
 */
const RIPPLE_AMP = 0.006;
const RIPPLE_WAVES = 3;
const RIPPLE_WAVES_2 = 7;
const RIPPLE_PERIOD = 3.4;
/** Segments the wavy top edge is drawn as. */
const RIPPLE_STEPS = 48;

/** Glow behind a fish, as a multiple of its own length. */
const GLOW_RADIUS = 1.15;
/** Alpha at the centre of that glow. */
const GLOW_ALPHA = 0.35;

/** The chevron on the harpoon's tip, in card units, and its half-angle. */
const TIP_SIZE = 0.022;
const TIP_SPREAD = 0.62;

/** Dash pattern for the aim line while the harpoon swings. */
const AIM_DASH = 0.014;
const AIM_GAP = 0.018;

/* ---- the tension bar ---------------------------------------------- */

/** Share of the card's HEIGHT the bar's band occupies, measured from the foot. */
const TENSION_BAND = 0.06;
/** Segments, matching `.pwr__bar` so the two instruments read as one family. */
const TENSION_SEGMENTS = 10;
/** Below this the bar goes magenta: the line is about to part. */
const TENSION_LOW = 0.3;
/** Bar geometry inside its band, in card widths. */
const TENSION_INSET = 0.1;
const TENSION_HEIGHT = 0.026;
const TENSION_GAP = 0.006;

/* ---- float-ups ----------------------------------------------------- */

/**
 * The "+N" and "SNAPPED" marks.
 *
 * They live here rather than in the sim because they are not facts about the
 * session — they are the renderer noticing something and saying so. The sim
 * clears `state.events` at the top of every update, so `draw` has to read the
 * list every single frame or the mark is simply never made.
 */
const FLOAT_RISE = 0.15;
const FLOAT_LIFE = 0.9;
const FLOAT_SIZE = 0.055;
/**
 * Slots in the pool.
 *
 * Ten shots a session and one mark per shot, so twelve is more than a session
 * can raise inside 0.9 seconds. Preallocated for the same reason `radar.ts`
 * precomputes its projection: nothing on a per-frame path may make garbage.
 */
const MAX_FLOATS = 12;

interface Float {
  active: boolean;
  text: string;
  colour: string;
  x: number;
  y: number;
  age: number;
}

/* ------------------------------------------------------------------ */
/* Fonts                                                               */
/* ------------------------------------------------------------------ */

/**
 * The placeholder sprite sheet, such as it is.
 *
 * `sans-serif` last so a machine with no colour emoji font draws a box rather
 * than nothing at all: an invisible fish is a bug report about the harpoon.
 */
const EMOJI_FONT =
  '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

/** The same stack `style.css` gives the HUD, so the card's ink matches the panels. */
const LABEL_FONT =
  'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';

export interface FishRenderer {
  /** Paints one frame. `dt` drives the renderer's own float-up animations. */
  draw(state: FishingState, dt: number): void;
  /** Re-reads the element size and resizes the drawing buffer. */
  resize(): void;
}

/**
 * The species' sprite as a string the DOM can hold.
 *
 * The card's summary has to name a fish with its picture beside it, and this
 * is the module that owns what a fish looks like. Exporting the glyph keeps
 * that ownership intact: `SpeciesArt` is still read in exactly one file, and
 * the day `art.image` arrives the summary asks the same question and gets a
 * different answer without knowing why.
 */
export function speciesGlyph(species: Species): string {
  return species.art.emoji;
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Builds a painter for `canvas`.
 *
 * Returns a no-op if there is no 2D context, on the same terms as `radar.ts`
 * and the writers in `hud.ts`: a display that cannot be built must not take
 * the frame loop down with it.
 */
export function createFishRenderer(canvas: HTMLCanvasElement): FishRenderer {
  const context = canvas.getContext('2d');
  if (!context) {
    return { draw: (): void => undefined, resize: (): void => undefined };
  }
  const ctx: CanvasRenderingContext2D = context;

  /** Device pixels per card unit. Set by `syncSize`; 0 until the card is laid out. */
  let scale = 0;
  /** Last CSS width the buffer was sized to, so a still card costs no work. */
  let cssWidth = 0;

  /** Seconds since the renderer was built. Drives the ripple, and nothing else. */
  let clock = 0;

  /*
   * Built once, in card units, and therefore valid at every size.
   *
   * A gradient's coordinates are read in user space at fill time, so these
   * survive a resize untouched — the transform changes, the card units do not.
   * Rebuilding them per frame is the obvious way to write this file and it
   * would allocate three objects sixty times a second for no picture at all.
   */
  const water = ctx.createLinearGradient(0, WATERLINE, 0, CARD_HEIGHT);
  water.addColorStop(0, WATER_TOP);
  water.addColorStop(1, WATER_BOTTOM);

  const horizon = ctx.createLinearGradient(0, 0, 0, WATERLINE);
  horizon.addColorStop(0, 'rgba(63, 224, 255, 0)');
  horizon.addColorStop(0.72, 'rgba(63, 224, 255, 0.05)');
  horizon.addColorStop(1, 'rgba(63, 224, 255, 0.22)');

  /**
   * One radial glow per tint, built in a UNIT space centred on the origin.
   *
   * Canvas has no way to tint a gradient after the fact, so a gradient per
   * fish per frame is the shape this draws itself into — eighteen distinct
   * tints across twenty species, allocated once each here and then placed by a
   * translate and a scale. See `drawGlow`.
   */
  const glows = new Map<string, CanvasGradient>();

  function glowFor(tint: string): CanvasGradient {
    let g = glows.get(tint);
    if (!g) {
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, withAlpha(tint, GLOW_ALPHA));
      g.addColorStop(0.55, withAlpha(tint, GLOW_ALPHA * 0.4));
      g.addColorStop(1, withAlpha(tint, 0));
      glows.set(tint, g);
    }
    return g;
  }

  /**
   * Art loaded from `SpeciesArt.image`, once per path.
   *
   * Nothing sets `image` today. The branch exists anyway because it is the
   * whole seam the plan promises for generated art: when it arrives, the only
   * edits are the table in `species.ts` and the files it points at.
   */
  const images = new Map<string, HTMLImageElement>();

  function imageFor(path: string): HTMLImageElement {
    let img = images.get(path);
    if (!img) {
      img = new Image();
      img.src = path;
      images.set(path, img);
    }
    return img;
  }

  /** The float-up pool. Slots are reused; the array never grows. */
  const floats: Float[] = [];
  for (let i = 0; i < MAX_FLOATS; i++) {
    floats.push({ active: false, text: '', colour: GOLD, x: 0, y: 0, age: 0 });
  }

  function addFloat(text: string, colour: string, x: number, y: number): void {
    let slot: Float | null = null;
    for (const f of floats) {
      if (!f.active) {
        slot = f;
        break;
      }
      // No free slot: take the oldest, which is the one closest to fading out
      // anyway. Dropping the NEW mark instead would lose the catch the player
      // is looking at in favour of one they have already read.
      if (slot === null || f.age > slot.age) slot = f;
    }
    if (slot === null) return;
    slot.active = true;
    slot.text = text;
    slot.colour = colour;
    slot.x = x;
    slot.y = y;
    slot.age = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Sizing                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Points the drawing buffer at the element's current size.
   *
   * Width comes from the element and the height from the card's own aspect,
   * not from `clientHeight`: the two agree to within a rounding error because
   * the CSS pins the card to 9/16, and deriving the height is what guarantees
   * the transform below is a single UNIFORM scale. Taking both from the
   * element would let a sub-pixel disagreement squash every emoji on the card.
   */
  function syncSize(): void {
    const w = canvas.clientWidth;
    if (w <= 0) return;
    if (w === cssWidth && scale > 0) return;
    cssWidth = w;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const pixels = Math.max(1, Math.round(w * dpr));
    canvas.width = pixels;
    canvas.height = Math.max(1, Math.round(pixels * CARD_HEIGHT));
    scale = pixels;
  }

  /* ---------------------------------------------------------------- */
  /* Primitives                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * The sea's surface at `x`, at the current time.
   *
   * The boat rides this rather than the flat waterline, which is why there is
   * no separate bob constant: the hull moves because it is sitting on a wave.
   */
  function waveY(x: number): number {
    const t = (clock / RIPPLE_PERIOD) * Math.PI * 2;
    return (
      WATERLINE +
      Math.sin(x * RIPPLE_WAVES * Math.PI * 2 + t) * RIPPLE_AMP +
      Math.sin(x * RIPPLE_WAVES_2 * Math.PI * 2 - t * 1.4) * RIPPLE_AMP * 0.45
    );
  }

  /**
   * Draws `text` at a real pixel size while positioning it in card units.
   *
   * The one place in this file that knows what a pixel is, and it has to. The
   * card-unit transform would ask for a font a twentieth of a pixel tall, and
   * a browser rounds that to something between illegible and nothing. So the
   * position goes through the transform and the glyph is drawn back in device
   * pixels through its inverse — which also makes the mirror and the tilt
   * free, since both are already part of that matrix.
   */
  function drawGlyph(
    text: string,
    font: string,
    x: number,
    y: number,
    size: number,
    mirror: boolean,
    spin: number,
  ): void {
    const px = size * scale;
    // Under a pixel there is no glyph, only a smudge and the cost of shaping it.
    if (px < 1) return;
    ctx.save();
    ctx.translate(x, y);
    if (spin !== 0) ctx.rotate(spin);
    ctx.scale((mirror ? -1 : 1) / scale, 1 / scale);
    ctx.font = px.toFixed(1) + 'px ' + font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  /** Places a unit-space glow gradient at `(x, y)` with radius `r`. */
  function drawGlow(tint: string, x: number, y: number, r: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(r, r);
    ctx.fillStyle = glowFor(tint);
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  /**
   * One fish: its glow, then its sprite.
   *
   * `spin` is zero for a fish in the water and the rope's cant for one on the
   * hook. `SpeciesArt` is read here and in `glowFor`, and nowhere else in the
   * project.
   */
  function drawFish(species: Species, x: number, y: number, dir: number, spin: number): void {
    const art: SpeciesArt = species.art;
    const len = FISH_LENGTH * species.size;
    drawGlow(art.tint, x, y, len * GLOW_RADIUS);

    if (art.image) {
      const img = imageFor(art.image);
      // `complete` alone is true for a failed load too, so the natural size is
      // what actually says the bitmap arrived. Until it does — or if it never
      // does — the emoji is still there to draw.
      if (img.complete && img.naturalWidth > 0) {
        const h = (len * img.naturalHeight) / img.naturalWidth;
        ctx.save();
        ctx.translate(x, y);
        if (spin !== 0) ctx.rotate(spin);
        if (dir < 0) ctx.scale(-1, 1);
        ctx.drawImage(img, -len / 2, -h / 2, len, h);
        ctx.restore();
        return;
      }
    }

    ctx.fillStyle = '#ffffff';
    drawGlyph(art.emoji, EMOJI_FONT, x, y, len, dir < 0, spin);
  }

  /* ---------------------------------------------------------------- */
  /* The frame                                                         */
  /* ---------------------------------------------------------------- */

  function drawSea(): void {
    ctx.fillStyle = SKY;
    ctx.fillRect(0, 0, 1, WATERLINE + RIPPLE_AMP * 2);
    ctx.fillStyle = horizon;
    ctx.fillRect(0, 0, 1, WATERLINE);

    // One path for the water: the wavy top edge, then down and back along the
    // card's own foot. Filling a rectangle to the flat waterline and stroking
    // a curve over it would leave the sky showing through every trough.
    ctx.beginPath();
    ctx.moveTo(0, waveY(0));
    for (let i = 1; i <= RIPPLE_STEPS; i++) {
      const x = i / RIPPLE_STEPS;
      ctx.lineTo(x, waveY(x));
    }
    ctx.lineTo(1, CARD_HEIGHT);
    ctx.lineTo(0, CARD_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = water;
    ctx.fill();

    // The surface itself, lit. Stroked separately rather than left as the
    // fill's edge, because the sea's brightest line is what tells the player
    // where the boat stops and the fishing starts.
    ctx.beginPath();
    ctx.moveTo(0, waveY(0));
    for (let i = 1; i <= RIPPLE_STEPS; i++) {
      const x = i / RIPPLE_STEPS;
      ctx.lineTo(x, waveY(x));
    }
    ctx.strokeStyle = 'rgba(63, 224, 255, 0.55)';
    ctx.lineWidth = 1.4 / scale;
    ctx.stroke();
  }

  function drawBoat(): void {
    ctx.fillStyle = '#ffffff';
    drawGlyph(
      '⛵',
      EMOJI_FONT,
      PIVOT_X,
      waveY(PIVOT_X) - BOAT_LENGTH * BOAT_DRAFT,
      BOAT_LENGTH,
      false,
      0,
    );
  }

  /**
   * The dotted line showing where a shot fired this instant would go.
   *
   * Drawn only while swinging, because that is the only moment the answer is
   * still the player's to change. `angle` is measured from straight down and
   * positive toward +x, so the direction is (sin, cos) — not the (cos, sin)
   * every other angle in this project uses, and this is the one place it
   * matters.
   */
  function drawAim(angle: number): void {
    const dx = Math.sin(angle);
    const dy = Math.cos(angle);
    // How far the ray runs before it leaves the card. dy is positive across
    // the whole ±60° swing, so the floor only guards a sim that one day swings
    // further.
    let t = dy > 1e-6 ? (CARD_HEIGHT - PIVOT_Y) / dy : CARD_HEIGHT;
    if (dx > 1e-6) t = Math.min(t, (1 - PIVOT_X) / dx);
    else if (dx < -1e-6) t = Math.min(t, -PIVOT_X / dx);

    ctx.save();
    ctx.setLineDash([AIM_DASH, AIM_GAP]);
    ctx.beginPath();
    ctx.moveTo(PIVOT_X, PIVOT_Y);
    ctx.lineTo(PIVOT_X + dx * t, PIVOT_Y + dy * t);
    ctx.strokeStyle = 'rgba(63, 224, 255, 0.3)';
    ctx.lineWidth = 1.2 / scale;
    ctx.stroke();
    ctx.restore();
  }

  /** The rope and the chevron on its point, turned to run with the line. */
  function drawHarpoon(tipX: number, tipY: number): void {
    ctx.beginPath();
    ctx.moveTo(PIVOT_X, PIVOT_Y);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = ROPE;
    ctx.lineWidth = 1.5 / scale;
    ctx.stroke();

    const a = Math.atan2(tipY - PIVOT_Y, tipX - PIVOT_X);
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(-TIP_SIZE * Math.cos(TIP_SPREAD), -TIP_SIZE * Math.sin(TIP_SPREAD));
    ctx.lineTo(0, 0);
    ctx.lineTo(-TIP_SIZE * Math.cos(TIP_SPREAD), TIP_SIZE * Math.sin(TIP_SPREAD));
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 2 / scale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The struggle, in the bottom 6% of the card.
   *
   * Ten segments and the same rail-and-lit construction as `.pwr__bar`, so the
   * player reads it with the instinct the power gauge already taught them.
   * Magenta under 30% is the one departure, and it is the whole message: the
   * bar has stopped reporting a level and started reporting that the line is
   * about to part.
   */
  function drawTension(tension: number): void {
    const t = tension < 0 ? 0 : tension > 1 ? 1 : tension;
    const accent = t < TENSION_LOW ? MAGENTA : CYAN;
    const band = CARD_HEIGHT * TENSION_BAND;
    const y = CARD_HEIGHT - band / 2 - TENSION_HEIGHT / 2;
    const width = 1 - TENSION_INSET * 2;
    const seg = (width - TENSION_GAP * (TENSION_SEGMENTS - 1)) / TENSION_SEGMENTS;
    // Ceil, not round: the fish escapes at exactly zero, so every fraction
    // still on the line has to be worth one lit segment. A bar that empties a
    // notch early teaches the player to give up a notch early.
    const lit = Math.ceil(t * TENSION_SEGMENTS);
    const hairline = 1 / scale;

    for (let i = 0; i < TENSION_SEGMENTS; i++) {
      const x = TENSION_INSET + i * (seg + TENSION_GAP);
      if (i < lit) {
        ctx.fillStyle = accent;
        ctx.fillRect(x, y, seg, TENSION_HEIGHT);
      } else {
        ctx.fillStyle = withAlpha(accent, 0.1);
        ctx.fillRect(x, y, seg, TENSION_HEIGHT);
        ctx.strokeStyle = withAlpha(accent, 0.26);
        ctx.lineWidth = hairline;
        ctx.strokeRect(
          x + hairline / 2,
          y + hairline / 2,
          seg - hairline,
          TENSION_HEIGHT - hairline,
        );
      }
    }
  }

  /** Reads the sim's events and turns the two that have a picture into marks. */
  function collect(state: FishingState): void {
    for (const ev of state.events) {
      if (ev.kind === 'caught') {
        addFloat('+' + ev.gold, GOLD, ev.x, ev.y);
      } else if (ev.kind === 'escaped') {
        // `escaped` carries no position — the fish is gone by the time it is
        // raised — so the mark is made where the line was when it parted.
        addFloat('SNAPPED', MAGENTA, state.harpoon.tipX, state.harpoon.tipY);
      }
    }
  }

  function drawFloats(dt: number): void {
    for (const f of floats) {
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= FLOAT_LIFE) {
        f.active = false;
        continue;
      }
      const k = f.age / FLOAT_LIFE;
      ctx.save();
      // Squared, so the mark holds its colour for most of its rise and then
      // goes quickly. A linear fade spends half its life as a grey smear.
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = f.colour;
      drawGlyph(f.text, LABEL_FONT, f.x, f.y - FLOAT_RISE * k, FLOAT_SIZE, false, 0);
      ctx.restore();
    }
  }

  function draw(state: FishingState, dt: number): void {
    syncSize();
    if (scale <= 0) return;

    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    clock += dt;

    collect(state);

    // One transform for the whole card: 1 unit across is the full width, and
    // y therefore runs to 16/9 at the foot.
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, 1, CARD_HEIGHT);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.setLineDash([]);

    drawSea();
    drawBoat();

    const harpoon = state.harpoon;
    if (harpoon.phase === 'swinging') drawAim(harpoon.angle);

    /*
     * The cant a hooked fish hangs at.
     *
     * Measured off the rope rather than chosen: a line straight down leaves
     * the fish level, and every degree the line swings tips it the same
     * degree. Which is what "tilted toward the pivot" has to mean if it is
     * still to be true with the harpoon out at sixty degrees.
     */
    const cant = Math.atan2(harpoon.tipY - PIVOT_Y, harpoon.tipX - PIVOT_X) - Math.PI / 2;

    for (const fish of state.fish) {
      // The hooked fish is drawn from the harpoon below, at the tip, so it can
      // never be left behind at a position the sim stopped updating. Both
      // sources are honoured because only `fishsim.ts` knows which one it
      // keeps current, and a fish drawn twice is worse than either.
      if (fish.hooked && harpoon.hooked) continue;
      drawFish(fish.species, fish.x, fish.y, fish.dir, fish.hooked ? cant : 0);
    }

    drawHarpoon(harpoon.tipX, harpoon.tipY);

    const hooked: FishState | null = harpoon.hooked;
    if (hooked) drawFish(hooked.species, harpoon.tipX, harpoon.tipY, hooked.dir, cant);

    if (harpoon.struggling) drawTension(harpoon.tension);

    drawFloats(dt);
  }

  function resize(): void {
    // Force the next `syncSize` to act even if the CSS width has not moved:
    // the device pixel ratio may be what changed, and nothing else notices it.
    cssWidth = 0;
    scale = 0;
    syncSize();
  }

  return { draw, resize };
}

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

/**
 * `#rrggbb` (or `#rgb`) at a given alpha, as `rgba(...)`.
 *
 * `SpeciesArt.tint` is authored as a hex literal in `species.ts` and canvas
 * has no way to apply an alpha to a fill colour without rewriting it, so the
 * rewrite happens once per tint, behind the gradient cache. Anything this does
 * not recognise is handed back untouched, which fails as a fully opaque glow
 * rather than as a silent hole in the picture.
 */
function withAlpha(colour: string, alpha: number): string {
  if (colour.charCodeAt(0) !== 35 /* '#' */) return colour;
  const hex = colour.slice(1);
  let r: number;
  let g: number;
  let b: number;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    return colour;
  }
  // NaN fails every comparison, which is the cheapest way to catch a hex digit
  // that was not one.
  if (!(r >= 0) || !(g >= 0) || !(b >= 0)) return colour;
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
}
