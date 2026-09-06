import type { EnergyMode, EnergyState, ShipState, WindState } from './types';

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
 * "12.4 kn", or "12.4 kn AST" (astern) while reversing.
 *
 * World units per second are printed as knots one for one -- see **Units,
 * pinned** in `docs/ARCHITECTURE.md`. This is the only place that claim is
 * made, so the wind row prints through here too rather than growing a second
 * conversion that could be retuned on its own.
 */
function formatSpeed(speed: number): string {
  const magnitude = Math.abs(speed).toFixed(1);
  return speed < -0.05 ? `${magnitude} kn AST` : `${magnitude} kn`;
}

/* ------------------------------------------------------------------ */
/* Wind                                                                */
/* ------------------------------------------------------------------ */

const RAD_TO_DEG = 180 / Math.PI;

/**
 * "+7.5" -- the wind's signed share of the ground speed, or "" for none.
 *
 * The sign is taken off the *rounded* magnitude, the same guard `formatRate`
 * uses, and a share that rounds away prints nothing at all. A permanent
 * "+0.0" hanging off the SPD row would be a value the player has to learn to
 * ignore, and the point of the suffix is that it only appears when the
 * weather is actually doing something.
 */
function formatWindShare(share: number): string {
  const magnitude = Math.abs(share).toFixed(1);
  if (magnitude === '0.0') return '';
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
 * Segments to light. Ceil rather than round, so that any charge at all holds
 * one notch lit and a wholly dark bar means exactly one thing: dead.
 */
function litSegments(level: number): number {
  const lit = Math.ceil(level * PWR_SEGMENTS);
  return lit < 0 ? 0 : lit > PWR_SEGMENTS ? PWR_SEGMENTS : lit;
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

export function createHud(): {
  update(ship: ShipState, energy: EnergyState, wind: WindState): void;
} {
  // Looked up once; every writer tolerates a missing element.
  const writeHeading = textWriter(document.getElementById('hud-heading'));
  const writeNeedle = transformWriter(document.getElementById('hud-compass-needle'));
  const writeSpeed = textWriter(document.getElementById('hud-speed'));
  const writeSpeedWind = textWriter(document.getElementById('hud-speed-wind'));
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

  return {
    update(ship: ShipState, energy: EnergyState, wind: WindState): void {
      const headingDeg = ship.headingDeg;

      writeHeading(`${formatHeading(headingDeg)}°`);
      // The rose is fixed; the needle points where the ship is heading.
      writeNeedle(`rotate(${headingDeg.toFixed(1)}deg)`);

      // SPD is GROUND speed -- what the player watches go past -- with the
      // engine's share subtracted out beside it. Printing engine speed here
      // instead would leave the panel flatly contradicting the sea, and the
      // difference is the only place the 0.75 grip rule becomes visible: 8 kn
      // of engine under a 10 kn tailwind reads "15.5 kn +7.5".
      writeSpeed(formatSpeed(ship.groundSpeed));
      writeSpeedWind(formatWindShare(ship.groundSpeed - ship.speed));

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
      writePwrSegments(litSegments(clamped));
      writePwrMode(state.toUpperCase());
      writePwrRate(formatRate(energy.rate));
      // `energy.canThrust` is deliberately not read: `empty` holds for exactly
      // as long as thrust is refused, so a second indicator would say the same
      // thing twice and could only ever contradict the tag.
    },
  };
}
