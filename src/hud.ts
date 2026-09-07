import type { EnergyMode, EnergyState, ShipState, WindState } from './types';
import type { Wallet } from './wallet';
import type { GpuFrameStats } from './postfx';
import { BATTERY_CAPACITY } from './battery';

/**
 * hud.ts — formats ShipState into the DOM overlay declared in index.html.
 *
 * update() runs every frame at 60fps, so every element is fronted by a
 * write-through cache: the DOM is only touched when the formatted string
 * actually changes.
 */

/** Returns a setter that writes textContent only when the value changed. */
function textWriter(el: HTMLElement | null): (value: string) => void {
  let last: string | null = null;
  return (value: string): void => {
    if (el === null || value === last) return;
    last = value;
    el.textContent = value;
  };
}

/** Returns a setter that writes style.transform only when the value changed. */
function transformWriter(el: HTMLElement | null): (value: string) => void {
  let last: string | null = null;
  return (value: string): void => {
    if (el === null || value === last) return;
    last = value;
    el.style.transform = value;
  };
}

/** Returns a setter that shows or hides an element only when the flag changed. */
function hiddenWriter(el: HTMLElement | null): (shown: boolean) => void {
  // Read back off the markup, like every other writer in this file: the backup
  // row ships hidden because a new ship has no cell, so a first frame that has
  // not moved off that state touches nothing.
  let last: boolean | null = el === null ? null : !el.hidden;
  return (shown: boolean): void => {
    if (el === null || shown === last) return;
    last = shown;
    el.hidden = !shown;
  };
}

/** Returns a setter that writes one attribute only when the value changed. */
function attrWriter(el: HTMLElement | null, name: string): (value: string) => void {
  let last: string | null = null;
  return (value: string): void => {
    if (el === null || value === last) return;
    last = value;
    el.setAttribute(name, value);
  };
}

/**
 * Returns a setter that arms or dims a button, carrying the reason with it.
 *
 * `disabled` and the tooltip are one fact wearing two attributes — a button
 * that explains why it is dead while it is alive is worse than one that never
 * explains itself at all — so they are written together or not at all.
 *
 * The shipped state is read back off the markup for the same reason
 * `modifierWriter` reads its class back: index.html ships [FISH] armed to
 * match the full tank the sim starts with, so a first frame that has not moved
 * off that state touches no attribute.
 */
function gateWriter(el: HTMLElement | null, reason: string): (armed: boolean) => void {
  let last: boolean | null = el === null ? null : !el.hasAttribute('disabled');
  return (armed: boolean): void => {
    if (el === null || armed === last) return;
    last = armed;
    if (armed) {
      el.removeAttribute('disabled');
      el.removeAttribute('title');
    } else {
      el.setAttribute('disabled', '');
      el.setAttribute('title', reason);
    }
  };
}

/**
 * Returns a setter that keeps exactly one `${prefix}--${name}` class on `el`.
 *
 * The starting value is read back off the markup rather than assumed, so a
 * first frame that has not moved off the shipped state writes nothing and the
 * CSS animations keyed to these classes never restart for free.
 */
function modifierWriter(el: HTMLElement | null, prefix: string): (name: string) => void {
  const marker = `${prefix}--`;
  const shipped =
    el === null ? undefined : Array.from(el.classList).find((c) => c.startsWith(marker));
  let last: string | null = shipped === undefined ? null : shipped.slice(marker.length);
  return (name: string): void => {
    if (el === null || name === last) return;
    if (last !== null) el.classList.remove(marker + last);
    last = name;
    el.classList.add(marker + name);
  };
}

/**
 * Returns a setter that lights the first `n` segments of a segmented bar.
 *
 * Only the segments between the old count and the new one are touched, so a
 * bar ticking down one notch costs one classList call rather than ten and a
 * steady bar costs none. The starting count is counted off the markup, for the
 * same reason modifierWriter reads its class back.
 */
function segmentWriter(el: HTMLElement | null, selector: string): (n: number) => void {
  const segments: HTMLElement[] =
    el === null ? [] : Array.from(el.querySelectorAll<HTMLElement>(selector));
  let last = 0;
  for (const segment of segments) if (segment.classList.contains('is-lit')) last++;
  return (n: number): void => {
    if (segments.length === 0 || n === last) return;
    const from = Math.min(last, n);
    const to = Math.max(last, n);
    for (let i = from; i < to; i++) segments[i].classList.toggle('is-lit', i < n);
    last = n;
  };
}

/** "093" — heading as a zero-padded 3-digit integer in [0, 360). */
function formatHeading(headingDeg: number): string {
  const deg = ((Math.round(headingDeg) % 360) + 360) % 360;
  return String(deg).padStart(3, '0');
}

/** Absolute magnitude to 1dp, zero-padded to `intDigits` integer digits. */
function padFixed1(value: number, intDigits: number): string {
  // intDigits + '.' + one decimal
  return Math.abs(value).toFixed(1).padStart(intDigits + 2, '0');
}

function formatLat(latDeg: number): string {
  return `${padFixed1(latDeg, 2)}° ${latDeg < 0 ? 'S' : 'N'}`;
}

function formatLon(lonDeg: number): string {
  return `${padFixed1(lonDeg, 3)}° ${lonDeg < 0 ? 'W' : 'E'}`;
}

/**
 * "12 kn" -- a magnitude, whichever way the ship is pointed.
 *
 * World units per second are printed as knots one for one -- see **Units,
 * pinned** in `docs/ARCHITECTURE.md`. This is the only place that claim is
 * made, so the wind row prints through here too rather than growing a second
 * conversion that could be retuned on its own.
 *
 * Whole knots, rounded half away from zero, so 7.3 reads 7 and 5.5 reads 6.
 * The tenth was noise: a hull under a gusting wind never held one long enough
 * to be read, and a digit that only ever flickers is a digit that costs
 * attention and returns nothing. `Math.round` is exactly half-up on positives,
 * and the magnitude is taken first so astern rounds the same way ahead does
 * rather than half-toward-zero the way `Math.round(-5.5)` would.
 *
 * The AST suffix that used to mark a sternway reading is gone. Nothing else
 * prints it, so going astern now reads as a bare speed on the panel and the
 * sea outside is what tells the player which way they are moving.
 */
function formatSpeed(speed: number): string {
  return `${Math.round(Math.abs(speed))} kn`;
}

/* ------------------------------------------------------------------ */
/* Gold                                                                */
/* ------------------------------------------------------------------ */

/**
 * Below this a gold figure is printed bare; at or above it, grouped.
 *
 * Four digits up, so 1565 reads "1 565".
 *
 * `FISHING_PLAN.md` contradicts itself here: its prose asks for no separator
 * under 10 000 while its own card and Fish Book mock-ups group from four
 * digits ("1 565"). Settled with the owner in favour of the mock-ups, because
 * the same purse is printed in three places — this row, the card's chrome and
 * the book's footer — and the one thing that must not happen is the HUD saying
 * 1565 while the book says 1 565. One rule, one number, three readings of it.
 */
const GOLD_GROUPED_FROM = 1000;

/**
 * The separator. A thin space rather than a comma or a full space: this HUD
 * has no other punctuation on it, and a comma in a mono face at 16px reads as
 * a decimal point at the exact moment the number stops being small.
 */
const THIN_SPACE = '\u2009';

/**
 * "0", "1 565", "12 400" — the purse.
 *
 * Grouped by hand rather than through `toLocaleString`, which would follow
 * the browser's locale and print "12,400" here and "12.400" on a German
 * machine. The HUD is one instrument in one language; the figure it shows must
 * not depend on where the player's browser thinks it is.
 *
 * Negative gold is not a thing the game can produce — `wallet.ts` only ever
 * adds — so the floor is a guard against a bug printing a minus sign, not a
 * feature.
 */
function formatGold(gold: number): string {
  const purse = Math.max(0, Math.round(gold));
  const digits = String(purse);
  if (purse < GOLD_GROUPED_FROM) return digits;
  return digits.replace(/\B(?=(\d{3})+$)/g, THIN_SPACE);
}

/* ------------------------------------------------------------------ */
/* Wind                                                                */
/* ------------------------------------------------------------------ */

const RAD_TO_DEG = 180 / Math.PI;

/**
 * "+8" -- the wind's signed share of the ground speed, or "" for none.
 *
 * Whole knots, because it rides directly beside SPEED and a tenth here against
 * an integer there would read as two different instruments. It follows
 * `formatSpeed` for that reason and not on its own account.
 *
 * The sign is taken off the *rounded* magnitude, the same guard `formatRate`
 * uses, and a share that rounds away prints nothing at all. Rounding to whole
 * knots widens that silence from a twentieth of a knot to a half, so a breath
 * of wind now shows as nothing rather than as "+0.1" -- which is the right
 * trade for a suffix whose whole point is to appear only when the weather is
 * actually doing something.
 */
function formatWindShare(share: number): string {
  const magnitude = Math.round(Math.abs(share));
  if (magnitude === 0) return '';
  return `${share > 0 ? '+' : '-'}${magnitude}`;
}

/**
 * The wind's bearing as the arrow must be rotated, degrees clockwise in
 * [0, 360).
 *
 * Relative to the bow, not to north: the arrow sits beside a bow-up scope, so
 * an arrow at 12 o'clock has to mean "pushing you along" and not "blowing
 * north". `WindState.bearing` and `ShipState.heading` share a convention
 * precisely so this can be a subtraction.
 */
function windArrowDeg(wind: WindState, ship: ShipState): number {
  const deg = (wind.bearing - ship.heading) * RAD_TO_DEG;
  return ((deg % 360) + 360) % 360;
}

/* ------------------------------------------------------------------ */
/* Power                                                               */
/* ------------------------------------------------------------------ */

/** Notches in the power bar. index.html must ship exactly this many segments. */
const PWR_SEGMENTS = 10;

/**
 * Notches in the backup cell's bar. Five, not ten, on purpose.
 *
 * The cell holds half a tank, so five notches makes one notch mean the same
 * 10% of a tank on both bars. `style.css` then draws this bar at half the
 * power bar's length, which is what lets the two be read against each other at
 * a glance: a full cell reaches the middle of the panel, because that is
 * exactly how far its charge goes. `index.html` must ship exactly this many
 * segments.
 */
const RSV_SEGMENTS = 5;

/**
 * A quarter tank, under which a *falling* reserve reads LOW and goes amber.
 *
 * `energy.ts` has no such mode — it reports only docked/solar/drain/empty — so
 * LOW is the panel's own judgement rather than sim state. It is deliberately
 * not raised while charging: a reserve climbing back through 20% is good news,
 * and a warning there would cry wolf every time the ship leaves a berth.
 */
const PWR_LOW_LEVEL = 0.25;

/** The mode as the panel tells it: the sim's four, plus the HUD-only LOW. */
type PwrState = EnergyMode | 'low';

function powerState(energy: EnergyState): PwrState {
  return energy.mode === 'drain' && energy.level < PWR_LOW_LEVEL ? 'low' : energy.mode;
}

/**
 * What the tag reads, per state.
 *
 * The two charging states say so in as many words. They are the states the
 * player is waiting out rather than reacting to, and "SOLAR" alone named the
 * source without answering the question actually being asked of the panel --
 * is this thing filling up? The other three are self-evident and stay a word.
 *
 * The state itself is still what drives the colour, through the modifier class
 * on the wrapper, so this map only ever decides wording. A state missing from
 * it falls back to its own name upper-cased, which is what the tag always did.
 */
const PWR_TAG: Partial<Record<PwrState, string>> = {
  solar: 'IDLE - SOLAR CHARGING',
  docked: 'DOCKED - CHARGING',
  reserve: 'ON BACKUP CELL',
};

/**
 * Segments to light, out of `count`. Ceil rather than round, so that any charge
 * at all holds one notch lit and a wholly dark bar means exactly one thing:
 * dead.
 *
 * `fraction` is of that bar's OWN capacity, so the caller divides the cell's
 * charge by `BATTERY_CAPACITY` before it gets here. Passing a tank fraction
 * would light half a bar for a cell that is completely full.
 */
function litSegments(fraction: number, count: number): number {
  const lit = Math.ceil(fraction * count);
  return lit < 0 ? 0 : lit > count ? count : lit;
}

/**
 * "+0.85 %/s" — change in level as a signed percentage of the tank per second.
 *
 * The sign is taken off the *rounded* magnitude, so a rate a hair under zero
 * prints "+0.00" rather than the nonsense "-0.00".
 */
function formatRate(rate: number): string {
  const magnitude = Math.abs(rate * 100).toFixed(2);
  const sign = magnitude === '0.00' || rate > 0 ? '+' : '-';
  return `${sign}${magnitude} %/s`;
}

/**
 * Publishes the telemetry panel's height as `--telemetry-h` on the HUD root.
 *
 * The dock hangs under that panel, and nothing in CSS can see where its bottom
 * edge falls: both boxes are absolutely positioned, so they are not in flow
 * with each other and no selector relates their geometry. The panel is also
 * content-sized — it grew a row the day GOLD landed in it — so a hard offset
 * in the stylesheet would be a number that goes stale the next time somebody
 * adds an instrument and never opens style.css.
 *
 * Same write-through discipline as everything else in this file: the property
 * is set only when the measured height actually changes, which after startup
 * is a window resize and nothing else.
 */
function trackTelemetryHeight(): void {
  const panel = document.querySelector<HTMLElement>('.panel--telemetry');
  const hud = document.querySelector<HTMLElement>('.hud');
  if (panel === null || hud === null) return;

  let last = -1;
  const publish = (): void => {
    const height = Math.round(panel.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    hud.style.setProperty('--telemetry-h', `${height}px`);
  };

  publish();
  // Fires after layout and before paint, so the CSS fallback is only ever
  // seen on a browser without the observer at all.
  new ResizeObserver(publish).observe(panel);
}

/**
 * The dev telemetry line: GPU ms / CPU ms / draw calls, from Q's frame timer
 * in postfx.ts. It is not in index.html, because it does not exist for most
 * players -- appended here, at the foot of the telemetry panel, only once
 * the game has actually booted, hidden until Backquote asks for it, and
 * never shipped as a first-class HUD row.
 */
function createDevReadout(): { setVisible(visible: boolean): void; setStats(stats: GpuFrameStats): void } {
  const el = document.createElement('div');
  el.id = 'hud-dev-timer';
  el.className = 'panel__dev';
  el.hidden = true;
  document.querySelector('.panel--telemetry')?.appendChild(el);

  const writeText = textWriter(el);

  return {
    setVisible(visible: boolean): void {
      el.hidden = !visible;
    },
    setStats(stats: GpuFrameStats): void {
      // 'n/a' rather than a wrong number: EXT_disjoint_timer_query_webgl2 is
      // not on every GPU, and a disjoint frame is also folded into this by
      // postfx.ts simply never advancing its mean -- see GpuFrameStats.gpuMs.
      const gpu = stats.gpuMs === null ? 'n/a' : `${stats.gpuMs.toFixed(2)}ms`;
      writeText(`GPU ${gpu}  CPU ${stats.cpuMs.toFixed(2)}ms  DC ${Math.round(stats.calls)}`);
    },
  };
}

/**
 * Builds the panel writers and subscribes the purse.
 *
 * The wallet is taken rather than read, because gold changes on a catch and
 * not on a frame: `onChange` fires once immediately with the current figure
 * and again only when it moves, so the GOLD row costs nothing between catches
 * and cannot be a frame behind one. Everything else here is a reading off a
 * live sim state and is therefore still polled in `update`.
 *
 * The subscription is never dropped. The HUD is built once and lives as long
 * as the page does, so an unsubscribe would only ever be dead code — and a
 * `dispose` nobody calls is a promise nobody keeps.
 */
export function createHud(wallet: Wallet): {
  update(ship: ShipState, energy: EnergyState, wind: WindState): void;
  /** Shows or hides the GPU/CPU/draw-call line. Off by default; main.ts calls this from its Backquote listener. */
  setDevTimingVisible(visible: boolean): void;
  /** Feeds this frame's rolling means to the dev line. A no-op while it is hidden costs nothing worth guarding. */
  updateDevTiming(stats: GpuFrameStats): void;
} {
  trackTelemetryHeight();
  const devReadout = createDevReadout();

  // Looked up once; every writer tolerates a missing element.
  const writeHeading = textWriter(document.getElementById('hud-heading'));
  const writeSpeed = textWriter(document.getElementById('hud-speed'));
  const writeSpeedWind = textWriter(document.getElementById('hud-speed-wind'));
  // One modifier on the SPEED wrapper hides both the icon and the number,
  // the same way the WIND row hides its dart: the glyph and the figure it labels
  // cannot end up disagreeing about whether the wind is doing anything.
  const writeSpdState = modifierWriter(document.getElementById('hud-spd'), 'spd');
  const writeLat = textWriter(document.getElementById('hud-lat'));
  const writeLon = textWriter(document.getElementById('hud-lon'));

  // Calm versus blowing is one modifier on the wrapper, exactly as the power
  // block does its four states: the dart and the number take their colour and
  // their visibility from it, so they cannot end up disagreeing.
  const writeWndState = modifierWriter(document.getElementById('hud-wnd'), 'wnd');
  const writeWndArrow = transformWriter(document.getElementById('hud-wnd-arrow'));
  const writeWndValue = textWriter(document.getElementById('hud-wnd-value'));

  // The whole power block is coloured from one modifier class on its wrapper,
  // so a state change is a single classList write and the CSS fans it out to
  // the number, the bar and the tag.
  const pwrBar = document.getElementById('hud-pwr-bar');
  const writePwrState = modifierWriter(document.getElementById('hud-pwr'), 'pwr');
  const writePwrValue = textWriter(document.getElementById('hud-pwr-value'));
  const writePwrSegments = segmentWriter(pwrBar, '.pwr__seg');
  const writePwrAria = attrWriter(pwrBar, 'aria-valuenow');
  const writePwrMode = textWriter(document.getElementById('hud-pwr-mode'));
  const writePwrRate = textWriter(document.getElementById('hud-pwr-rate'));

  // The backup cell. One colour and one behaviour, so it needs no modifier
  // writer -- the whole block is simply shown or hidden depending on whether
  // there is a cell aboard at all.
  const rsvBar = document.getElementById('hud-rsv-bar');
  const writeRsvShown = hiddenWriter(document.getElementById('hud-rsv'));
  const writeRsvValue = textWriter(document.getElementById('hud-rsv-value'));
  const writeRsvSegments = segmentWriter(rsvBar, '.rsv__seg');
  const writeRsvAria = attrWriter(rsvBar, 'aria-valuenow');

  // The purse pushes; it is not pulled. See the note on createHud above.
  const writeGold = textWriter(document.getElementById('hud-gold'));
  wallet.onChange((gold) => writeGold(formatGold(gold)));

  // [SHOP] is an affordance, not a lock: `main.ts` re-tests the berth before
  // it opens anything. A shop key is dead at sea because the shop is the
  // berth's, not the ship's.
  //
  // [FISH] used to be gated here too, against half a tank. It is not any more,
  // and the reason is worth keeping: it opens the activity's cover screen
  // rather than a session, and the record is one of the two doors on that
  // screen. A player with a flat battery is exactly the player who wants to
  // look at their record, and a key locked by the price of the OTHER thing on
  // the menu would have shut them out of it. `fishcover.ts` holds the power
  // gate now, on the button that actually spends.
  const writeShopGate = gateWriter(
    document.getElementById('btn-shop'),
    'Only alongside a berth',
  );

  return {
    update(ship: ShipState, energy: EnergyState, wind: WindState): void {
      // The heading as a number. It used to drive a compass needle in the
      // D-pad's hub as well; that rose is gone, and the scope's own rim is
      // what carries the direction now.
      writeHeading(`${formatHeading(ship.headingDeg)}°`);

      // SPEED is GROUND speed -- what the player watches go past -- with the
      // engine's share subtracted out beside it. Printing engine speed here
      // instead would leave the panel flatly contradicting the sea, and the
      // difference is the only place the 0.35 grip rule becomes visible: 8 kn
      // of engine under a 10 kn tailwind reads "12 kn +4".
      writeSpeed(formatSpeed(ship.groundSpeed));
      const share = formatWindShare(ship.groundSpeed - ship.speed);
      writeSpeedWind(share);
      writeSpdState(share === '' ? 'calm' : 'wind');

      // A calm holds its last bearing rather than clearing it, so the arrow is
      // hidden by the class instead of being pointed anywhere, and its
      // transform is left alone: nothing to write for the seconds between
      // events, and the direction is already correct when one begins.
      const blowing = wind.speed > 0;
      writeWndState(blowing ? 'blowing' : 'calm');
      writeWndValue(blowing ? formatSpeed(wind.speed) : 'CALM');
      if (blowing) writeWndArrow(`rotate(${windArrowDeg(wind, ship).toFixed(1)}deg)`);

      writeLat(formatLat(ship.latDeg));
      writeLon(formatLon(ship.lonDeg));

      // `level` is a fraction everywhere else; this is the one place it becomes
      // a percentage, and the printed number and the meter's aria value come
      // off the same rounding so they cannot disagree at a boundary.
      const level = energy.level;
      const clamped = level < 0 ? 0 : level > 1 ? 1 : level;
      const percent = String(Math.round(clamped * 100));
      const state = powerState(energy);

      writePwrState(state);
      writePwrValue(`${percent}%`);
      writePwrAria(percent);
      writePwrSegments(litSegments(clamped, PWR_SEGMENTS));
      writePwrMode(PWR_TAG[state] ?? state.toUpperCase());
      writePwrRate(formatRate(energy.rate));

      // The backup cell. Hidden outright at zero rather than shown empty: a
      // ship that has never bought one has no cell, and a permanently dark row
      // would be an advertisement for the shop rather than an instrument.
      //
      // Its percentage is of the MAIN tank, matching the figure above it and
      // the one the shop sells against -- a cell reading 50% is half a tank,
      // which is what it is worth. Its bar is of its own capacity, so a full
      // cell is a full bar.
      const reserve = energy.reserve;
      writeRsvShown(reserve > 0);
      if (reserve > 0) {
        const cellFrac = Math.min(1, reserve / BATTERY_CAPACITY);
        const cellPercent = String(Math.round(reserve * 100));
        writeRsvValue(`${cellPercent}%`);
        writeRsvAria(cellPercent);
        writeRsvSegments(litSegments(cellFrac, RSV_SEGMENTS));
      }

      // A berth and nothing else. `energy.mode` is the one definition of
      // docked in the project -- see `wind.ts`, which shelters against the
      // same test -- so the key cannot disagree with the plant about whether
      // the ship has arrived.
      writeShopGate(energy.mode === 'docked');
      // `energy.canThrust` is deliberately not read: `empty` holds for exactly
      // as long as thrust is refused, so a second indicator would say the same
      // thing twice and could only ever contradict the tag.
    },

    setDevTimingVisible(visible: boolean): void {
      devReadout.setVisible(visible);
    },

    updateDevTiming(stats: GpuFrameStats): void {
      devReadout.setStats(stats);
    },
  };
}
