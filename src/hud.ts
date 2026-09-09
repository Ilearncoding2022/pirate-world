import type {
  EnergyMode,
  EnergyState,
  HullMode,
  ShipState,
  Towns,
  WeatherState,
  WindState,
} from './types';
import type { Wallet } from './wallet';
import type { GpuFrameStats } from './postfx';
import type { SeaAnchorStore } from './seaanchor';
import type { OverdriveStore } from './overdrive';
import type { Hull } from './hull';
import {
  HULL_CAP_CRITICAL,
  HULL_CAP_FAILING,
  HULL_CAP_WORN,
  HULL_FAILING_BELOW,
  HULL_MIN,
  HULL_WORN_BELOW,
  createStubHull,
} from './hull';
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
 * Returns a setter that arms or dims a button with a reason chosen anew each
 * call, rather than fixed at construction the way `gateWriter` bakes its
 * `reason` in.
 *
 * ANCHOR and COIL have two different ways to be dead -- nothing stowed, or
 * already deployed/burning -- and `gateWriter`'s one reason cannot say which.
 * The same pairing `shop.ts`'s `offerWriter` keeps, for the same reason: a
 * dead button that does not say why is worse than one that never explains
 * itself, and this one has more than one thing it might be saying.
 */
function reasonGateWriter(el: HTMLElement | null): (armed: boolean, reason: string) => void {
  let lastArmed: boolean | null = el === null ? null : !el.hasAttribute('disabled');
  let lastReason: string | null = null;
  return (armed: boolean, reason: string): void => {
    if (el === null || (armed === lastArmed && reason === lastReason)) return;
    lastArmed = armed;
    lastReason = reason;
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

/**
 * Returns a setter that keeps `className` on exactly ONE segment of a bar, or
 * on none of them when handed a negative index.
 *
 * The companion to `segmentWriter` above, and cached the same way: a marker
 * that has not moved costs one comparison, and a move costs two classList
 * calls rather than a walk down the bar. Nothing in `index.html` ships either
 * marker, so the first write is always an add.
 *
 * Two markers ride on these bars, and both are single by construction:
 *
 *   - `is-crest`, the highest LIT notch — the one the level is standing on,
 *     and so the only one a drain is about to take. CSS blinks it while the
 *     bar's `flow--*` says the level is falling.
 *   - `is-sweep`, the notch the charging sweep is passing over this instant.
 *     See `sweepIndex`.
 */
function markWriter(
  el: HTMLElement | null,
  selector: string,
  className: string,
): (index: number) => void {
  const segments: HTMLElement[] =
    el === null ? [] : Array.from(el.querySelectorAll<HTMLElement>(selector));
  let last = -1;
  return (index: number): void => {
    if (segments.length === 0 || index === last) return;
    if (last >= 0 && last < segments.length) segments[last].classList.remove(className);
    if (index >= 0 && index < segments.length) segments[index].classList.add(className);
    last = index;
  };
}

/**
 * What a segmented bar is DOING, as against what it reads.
 *
 * One vocabulary for all three bars — tank, cell and hull — because the three
 * are read as one column and an animation that meant one thing on the power
 * bar and another on the hull would be worse than no animation at all. It is
 * written as a `flow--*` modifier on the bar element itself and every keyframe
 * hangs off that one class; see the FLOW block in `style.css`.
 */
type BarFlow = 'still' | 'drain' | 'drain-fast' | 'charge';

/** Milliseconds the charging sweep spends on each notch. */
const SWEEP_STEP_MS = 500;

/**
 * Which notch the charging sweep stands on this frame, or -1 for no sweep.
 *
 * The sweep runs over the LIT notches only, from the lowest to the highest,
 * and wraps: it is the bar filling, drawn as a thing in motion, so it may not
 * run out over the dark notches the charge has not reached yet.
 *
 * Phase comes off the wall clock rather than off an accumulated `dt`, for the
 * same reason the CSS keyframes it triggers do: the sweep is chrome, it keeps
 * running while the sim is frozen behind an overlay, and nothing downstream
 * may depend on where it happens to be. A one-notch bar pins this at 0 and
 * never moves it, which is why the keyframe loops rather than playing once --
 * the single notch then pulses in place at the same cadence.
 */
function sweepIndex(lit: number, nowMs: number): number {
  if (lit <= 0) return -1;
  return Math.floor(nowMs / SWEEP_STEP_MS) % lit;
}

/**
 * What the POWER bar is doing.
 *
 * `EnergyState.rate` is the net change in the TOTAL — tank plus cell — so the
 * one case it cannot be read off directly is `reserve`, where the main tank is
 * already on the floor and every watt is coming out of the cell. The total is
 * falling there and this bar is not, so the news belongs to the BACKUP bar
 * below and blinking both would say the ship is losing charge twice over.
 */
function powerFlow(energy: EnergyState): BarFlow {
  if (energy.rate > 0) return 'charge';
  if (energy.rate < 0 && energy.mode !== 'reserve') return 'drain';
  return 'still';
}

/**
 * What the BACKUP bar is doing.
 *
 * `reserve` is the whole answer: the mode means "this frame's shortfall came
 * out of the cell", which is the definition of this bar falling. The cell has
 * no gradual charge to sweep for — a berth refills the tank and not the cell,
 * and the only thing that puts charge back in one is a purchase, which lands
 * whole rather than trickling.
 */
function reserveFlow(energy: EnergyState): BarFlow {
  return energy.mode === 'reserve' ? 'drain' : 'still';
}

/**
 * What the HULL bar is doing.
 *
 * Keyed on the RATE and not on the mode, so a hull sitting on its 1% floor is
 * still: `hull.ts` publishes 0 there rather than the wear it is no longer
 * paying, and a bar blinking over a number that has stopped moving is the
 * same lie the rate readout beside it was written to avoid. The mode is asked
 * only to separate the two speeds of wear.
 *
 * `weathering` is the doubled rate — a storm or rain over the ship, decided in
 * `main.ts` against HULL_WEATHER_THRESHOLD — and gets the doubled beat.
 */
function hullFlow(mode: HullMode, rate: number): BarFlow {
  if (rate > 0) return 'charge';
  if (rate < 0) return mode === 'weathering' ? 'drain-fast' : 'drain';
  return 'still';
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
 * Notches in the backup cell's bar. Ten, the tank's own count, on purpose.
 *
 * The cell holds a WHOLE tank -- `BATTERY_CAPACITY` is `BATTERY_CELL` times
 * `BATTERY_CELLS_MAX`, 0.5 x 2 -- and its figure is quoted against that same
 * tank, so ten notches makes one notch worth the same 10% on both bars and
 * 55% light the same notch in both places. `style.css` draws it on the same
 * scale, indented under the power bar rather than beside it.
 *
 * It was five half-width notches back when a cell really did hold half a
 * tank. The capacity doubled and this did not, so the bar drew a full cell as
 * a half-full one until 2026-09-09. If `BATTERY_CAPACITY` ever stops being a
 * whole tank, this and the `aria-valuemax` in `index.html` both move with it.
 *
 * `index.html` must ship exactly this many segments.
 */
const RSV_SEGMENTS = 10;

/**
 * A quarter tank, under which a *falling* tank goes amber.
 *
 * `energy.ts` has no such mode, and should not have one: how full the tank is
 * is a fact about `level`, not about what the plant is doing to it. It is
 * deliberately only read against a FALLING rate: a tank climbing back through
 * 20% is good news, and a warning there would cry wolf every time the ship
 * leaves a berth.
 */
const PWR_LOW_LEVEL = 0.25;

/**
 * What the tag says: the sim's eleven causes, plus the panel's own FULL.
 *
 * `full` is here rather than in `EnergyMode` because a tank at its ceiling is
 * a fact about `level`, and making it a mode would have put it in front of
 * `docked` — which five other modules test as the single definition of being
 * at a berth. The shop gate is not allowed to turn off because the tank
 * filled up.
 */
type PwrTag = EnergyMode | 'full' | 'ready';

/**
 * The tank is at its ceiling and something is holding it there.
 *
 * Worth its own tag because the alternative reading of a charging state at
 * +0.00 %/s is "the sun has gone down", and that misreading has cost time
 * more than once. The rate test is what tells the two apart: a plant still
 * paying for something reads negative within a frame of the ceiling.
 */
function powerTag(energy: EnergyState): PwrTag {
  // Alongside with the dwell run out and the helm not yet committed. It sits
  // ABOVE the full-tank test, unlike every other tag here, because it is the
  // one reading that asks the player for something: a ship that arrived on a
  // full tank would otherwise read TANK FULL and never mention the berth it
  // is sitting in. `docked` is not tested here at all -- once made fast the
  // mode says so on its own.
  if (energy.berthReady && energy.mode === 'mooring') return 'ready';
  return energy.level >= 1 && energy.rate >= 0 ? 'full' : energy.mode;
}

/**
 * What the tag reads, per cause. Total rather than partial on purpose: a new
 * mode with no wording is a compile error rather than a raw enum name leaking
 * onto the panel.
 *
 * Each one answers the question the panel is actually being asked, which is
 * never "what state am I in" but "is this thing filling up, and may I move".
 * That is why the charging states say CHARGING in as many words, why the two
 * no-thrust states differ by whether the helm is coming back, and why the
 * three at-rest states name what is on the panels rather than all reading
 * IDLE.
 */
const PWR_TAG: Record<PwrTag, string> = {
  dead: 'NO POWER - ADRIFT',
  restart: 'NO THRUST - RESTARTING',
  docked: 'BERTH - CHARGING',
  mooring: 'BERTH - CONNECTING',
  ready: 'BERTH - MAKE FAST',
  reserve: 'ON BACKUP CELL',
  overdrive: 'OVERDRIVE - 4x BURN',
  burn: 'UNDER WAY - BURN',
  solar: 'IDLE - SOLAR CHARGING',
  overcast: 'IDLE - OVERCAST',
  moon: 'IDLE - MOONGLASS',
  hotel: 'IDLE - NO SUN',
  full: 'TANK FULL',
};

/**
 * How alarming it is, which is a different question from what is happening.
 *
 * The whole point of splitting this off the mode: the tag names the cause and
 * this names the severity, so the panel can say RESTARTING in amber without
 * inventing a mode for it, and a backup cell draining away can stop wearing
 * the same neutral colour as a healthy ship under way.
 *
 * `dead` is the only one that flashes, and it keeps its single meaning: the
 * ship cannot move and nothing is bringing it back. A plant already climbing
 * out of zero is `warn` instead — an alarm that stays on through a recovery
 * the player can do nothing to hurry is an alarm they learn to ignore.
 */
type PwrSeverity = 'dead' | 'warn' | 'hot' | 'gain' | 'steady';

function powerSeverity(energy: EnergyState): PwrSeverity {
  if (!energy.canThrust) return energy.rate > 0 ? 'warn' : 'dead';
  // Both irreversible: the coil is spending four times the full-speed draw,
  // and the cell is spending charge no berth and no sunrise will put back.
  if (energy.mode === 'overdrive') return 'hot';
  if (energy.mode === 'reserve') return 'warn';
  if (energy.rate < 0 && energy.level < PWR_LOW_LEVEL) return 'warn';
  return energy.rate > 0 ? 'gain' : 'steady';
}

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
 * "+0.9 %/s" — change in level as a signed percentage of the tank per second.
 *
 * ONE decimal, not two (2026-09-09, owner's call). The figure is read at a
 * glance while steering and the second decimal was never the thing being
 * read; a shorter number is a faster one. The cost is that any load under
 * 0.05 %/s -- the after-dark hotel load in `energy.ts` is 0.04 -- now rounds
 * to `+0.0 %/s`, which reads as a plant holding station when it is in fact
 * draining very slowly. The tag beside it still names the state, so nothing
 * is lost that the row does not say twice.
 *
 * The sign is taken off the *rounded* magnitude, so a rate a hair under zero
 * prints "+0.0" rather than the nonsense "-0.0".
 */
function formatRate(rate: number): string {
  const magnitude = Math.abs(rate * 100).toFixed(1);
  const sign = magnitude === '0.0' || rate > 0 ? '+' : '-';
  return `${sign}${magnitude} %/s`;
}

/**
 * The berth's own name in place of the word BERTH, upper-cased.
 *
 * Two of the eleven power tags name a place rather than a state, and until
 * harbours had names the place was simply "BERTH" — which was fine when the
 * only fact worth reporting was that the ship had arrived somewhere. It is not
 * fine now: a player running for Rustwharf on a remembered fix wants the panel
 * to confirm that Rustwharf is what they found.
 *
 * The tail of the phrase is taken from `PWR_TAG` rather than written again
 * here, so CHARGING and CONNECTING stay one string each. Splitting on the
 * separator is what makes that possible without a second table keyed to the
 * same two modes — a table that could only ever drift out of step with the one
 * above it.
 *
 * A null name is not an error: `towns.dockAt` is a geometric test and
 * `energy.mode` is the plant's, and there is exactly one frame at the edge of
 * a zone where the two can disagree. The word BERTH is the right thing to
 * print in it.
 *
 * Exported for `tests/unit/hull-hud.test.ts`.
 */
export function powerTagText(tag: PwrTag, berth: string | null): string {
  const text = PWR_TAG[tag];
  if (berth === null || (tag !== 'docked' && tag !== 'mooring' && tag !== 'ready')) return text;
  const separator = text.indexOf(' - ');
  if (separator < 0) return text;
  return `${berth.toUpperCase()}${text.slice(separator)}`;
}

/* ------------------------------------------------------------------ */
/* Mooring                                                             */
/* ------------------------------------------------------------------ */

/**
 * What the bottom-of-screen notice reads, made fast or merely alongside.
 *
 * The made-fast line carries the way OUT of the state in the same breath as
 * the state itself, and that is the whole reason it stands there for as long
 * as the ship is tied up rather than fading like an ordinary toast. Being
 * moored takes the helm away: WASD, the arrows, the D-pad, the wind and the
 * sea all stop moving the hull. A player who missed a message that vanished
 * three seconds ago would be left pressing keys at a ship that will not
 * answer, with nothing on screen admitting why.
 *
 * The berth's name is used where there is one, on the same terms as
 * `powerTagText`: a player who ran for Rustwharf wants both instruments to
 * confirm Rustwharf. A null name is not an error -- `dockAt` is geometric and
 * `berthReady` is the dwell clock's, and there is one frame at the edge of a
 * ring where the two can disagree -- so the word BERTH stands in.
 *
 * Exported for `tests/unit/hull-hud.test.ts`'s neighbours.
 */
export function mooringText(fast: boolean, berth: string | null): string {
  const where = berth === null ? 'BERTH' : berth.toUpperCase();
  return fast
    ? `MOORED AT ${where} - HELM LOCKED - PRESS TO CAST OFF`
    : `MOOR AT ${where}`;
}

/* ------------------------------------------------------------------ */
/* Hull                                                                */
/* ------------------------------------------------------------------ */

/** Notches in the hull bar. Ten, like the tank's: index.html ships exactly this many. */
const HULL_SEGMENTS = 10;

/**
 * The floor, under the name this file's phrasing uses for it.
 *
 * The two band edges and the three caps are IMPORTED from `hull.ts` rather
 * than copied. This panel had its own 50 and 25 for one commit, on the
 * argument that the sim derives a speed from them and the panel derives a
 * colour, so the two are different subjects that happen to share a number.
 * They are not. A panel that says WORN while the ship is still making its
 * full speed is worse than no panel at all, which means the two are one
 * subject with two consumers -- and a shared subject belongs in the module
 * that owns the behaviour, not in a copy beside the one that describes it.
 *
 * The caps are imported for the same reason and one better: the tag says
 * `CAP 10 KN` in words, so a retune of `HULL_CAP_WORN` that this file did not
 * hear about would leave the panel telling the player a speed the ship has
 * not got.
 */
const HULL_FLOOR = HULL_MIN;

/**
 * How alarming the hull is, which is a different question from what it is
 * doing.
 *
 * The same split the power block makes, and made here for the same reason: the
 * modifier on the wrapper is a SEVERITY and the tag beside the bar is a CAUSE.
 * Seven tags share four colours, so a hull that learns a new thing to say —
 * a new mode, a new suffix — costs a phrase and not a stylesheet.
 *
 * It reads `percent` and nothing else, because severity here genuinely is a
 * fact about the number: a hull at 20% is failing whether it is wearing,
 * weathering or being worked on at a berth. What the berth changes is the
 * tag.
 *
 * Exported for `tests/unit/hull-hud.test.ts`.
 */
export type HullSeverity = 'sound' | 'worn' | 'failing' | 'critical';

export function hullSeverity(percent: number): HullSeverity {
  if (percent <= HULL_FLOOR) return 'critical';
  if (percent < HULL_FAILING_BELOW) return 'failing';
  if (percent < HULL_WORN_BELOW) return 'worn';
  return 'sound';
}

/**
 * What the tag reads, from the mode and the percent together.
 *
 * Neither alone is enough, which is the whole reason this is a function rather
 * than a `Record` like `PWR_TAG`. The mode says what is happening to the hull
 * and the percent says what that has cost so far, and the panel is being asked
 * both at once: "WORN - CAP 10 KN" answers "why is the ship slow" in four
 * words, and neither half of it can be read off one field.
 *
 * Three rules, in the order they are tested:
 *
 * 1. **A berth wins outright.** Alongside, the hull is going up at eight
 *    times the rate it ever comes down, and naming the band it is passing
 *    through would be reporting a fact that is already stale.
 * 2. **A full hull says so and stops.** There is no cap to warn about and
 *    nothing being spent.
 * 3. **Otherwise the band names the cost and the weather adds the suffix.**
 *    ` x2` is on the two capped bands and on SOUND's own phrasing because
 *    doubled wear is the one thing a player can act on — heave to, or run for
 *    a berth — and it has to be visible before the cap arrives rather than
 *    after. CRITICAL takes no suffix: at 1% the wear rate has stopped being
 *    the news.
 *
 * Exported for `tests/unit/hull-hud.test.ts`.
 */
export function hullTag(mode: HullMode, percent: number): string {
  if (mode === 'repairing') return 'BERTH - REPAIRING';
  if (percent >= 100) return 'HULL FULL';
  const doubled = mode === 'weathering' ? ' x2' : '';
  if (percent <= HULL_FLOOR) return `CRITICAL - CAP ${HULL_CAP_CRITICAL} KN`;
  if (percent < HULL_FAILING_BELOW) return `FAILING - CAP ${HULL_CAP_FAILING} KN${doubled}`;
  if (percent < HULL_WORN_BELOW) return `WORN - CAP ${HULL_CAP_WORN} KN${doubled}`;
  return mode === 'weathering' ? 'SOUND - WEATHERING x2' : 'SOUND - WEARING';
}

/**
 * "-0.5 %/min", "+2.0 %/s", "0.0 %/min" — the hull's signed rate.
 *
 * One decimal, matching `formatRate` above, and for the same reason: the two
 * figures sit in one column and a panel that changed precision between them
 * would read as two instruments.
 *
 * The one readout on this panel that does NOT share the power rate's unit, and
 * the reason is arithmetic rather than taste. `HullState.rate` is percent per
 * second like the plant's, but the two rates are three orders of magnitude
 * apart: wear is 0.25 %/MINUTE, which in the power block's `%/s` prints as
 * `-0.0` — a figure that is simultaneously wrong, alarming and unreadable.
 * Minutes for wear puts a real number on the panel; seconds for a repair keeps
 * a berth's 2.0 from reading as an absurd 120.
 *
 * So the unit is printed beside the figure on every line, every time, rather
 * than assumed from the row. A player who never notices it switch is a player
 * for whom both numbers happened to make sense.
 *
 * Zero prints unsigned. `formatRate` above signs its zero `+` because a plant
 * holding station is still doing something; a hull at rest — moored at 100%,
 * or frozen behind an overlay — is doing nothing at all, and a `+0.00` there
 * would read as a slow repair.
 *
 * Exported for `tests/unit/hull-hud.test.ts`.
 */
export function formatHullRate(rate: number): string {
  if (rate > 0) {
    const gain = rate.toFixed(1);
    if (gain !== '0.0') return `+${gain} %/s`;
  } else if (rate < 0) {
    const loss = Math.abs(rate * 60).toFixed(1);
    if (loss !== '0.0') return `-${loss} %/min`;
  }
  return '0.0 %/min';
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
 * The figure is the RENDERED box: `getBoundingClientRect` is measured after
 * the panel's `scale(var(--panel-scale))`, which is what makes it directly
 * usable as an offset rather than something CSS has to scale again.
 *
 * A `--telemetry-w` was published beside it for one commit, for the controls
 * card that briefly sat against the panel's right edge. That card is a pane of
 * the Escape menu now and nothing is hung off the width, so it is gone: a
 * custom property with no reader is a promise to a box that does not exist.
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
export function createHud(
  wallet: Wallet,
  seaAnchor: SeaAnchorStore,
  overdrive: OverdriveStore,
  /**
   * The durability sim. Defaulted to the stub so a caller built before
   * `hull.ts` has a body — or a test — gets the ship the game shipped with:
   * 100%, no cap, nothing to say.
   */
  hull: Hull = createStubHull(),
  /**
   * The world's harbours, for the berth name in the power tag, and for
   * nothing else.
   *
   * Optional because it is a LABEL: a HUD with no town list still reports the
   * plant correctly, it just says BERTH where it could have said Rustwharf.
   * `dockAt` is only asked while the plant says the ship is at one, so this
   * costs 36 dot products on the frames a berth is actually in play and
   * nothing on the other thousand.
   */
  towns?: Towns,
): {
  update(ship: ShipState, energy: EnergyState, wind: WindState, weather?: WeatherState): void;
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
  const writeWx = textWriter(document.getElementById('hud-wx'));
  // One modifier on the SPEED wrapper hides both the icon and the number,
  // the same way the WIND row hides its dart: the glyph and the figure it labels
  // cannot end up disagreeing about whether the wind is doing anything.
  const writeSpdState = modifierWriter(document.getElementById('hud-spd'), 'spd');
  const writeLat = textWriter(document.getElementById('hud-lat'));
  const writeLon = textWriter(document.getElementById('hud-lon'));

  // Calm versus blowing is one modifier on the wrapper, exactly as the power
  // block does its five severities: the dart and the number take their colour
  // and their visibility from it, so they cannot end up disagreeing.
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
  // What the bar is DOING, on top of what it reads. The modifier goes on the
  // bar rather than on the block, because the hull's bar three rows down wants
  // the same four states and the same keyframes and is not inside this block.
  const writePwrFlow = modifierWriter(pwrBar, 'flow');
  const writePwrCrest = markWriter(pwrBar, '.pwr__seg', 'is-crest');
  const writePwrSweep = markWriter(pwrBar, '.pwr__seg', 'is-sweep');

  // The backup cell. One colour and one behaviour, so it needs no modifier
  // writer -- the whole block is simply shown or hidden depending on whether
  // there is a cell aboard at all.
  const rsvBar = document.getElementById('hud-rsv-bar');
  const writeRsvShown = hiddenWriter(document.getElementById('hud-rsv'));
  const writeRsvValue = textWriter(document.getElementById('hud-rsv-value'));
  const writeRsvSegments = segmentWriter(rsvBar, '.rsv__seg');
  const writeRsvAria = attrWriter(rsvBar, 'aria-valuenow');
  // No sweep writer here, and that is not an omission: a cell has no gradual
  // charge to draw one for. See `reserveFlow`.
  const writeRsvFlow = modifierWriter(rsvBar, 'flow');
  const writeRsvCrest = markWriter(rsvBar, '.rsv__seg', 'is-crest');

  // The hull, built exactly as the power block above it is: one modifier on
  // the wrapper carries the severity and the CSS fans it out to the number,
  // the bar and the tag, so the three can never end up in different states.
  const hullBar = document.getElementById('hud-hull-bar');
  const writeHullState = modifierWriter(document.getElementById('hud-hull'), 'hull');
  const writeHullValue = textWriter(document.getElementById('hud-hull-value'));
  const writeHullSegments = segmentWriter(hullBar, '.hull__seg');
  const writeHullAria = attrWriter(hullBar, 'aria-valuenow');
  const writeHullMode = textWriter(document.getElementById('hud-hull-mode'));
  const writeHullRate = textWriter(document.getElementById('hud-hull-rate'));
  const writeHullFlow = modifierWriter(hullBar, 'flow');
  const writeHullCrest = markWriter(hullBar, '.hull__seg', 'is-crest');
  const writeHullSweep = markWriter(hullBar, '.hull__seg', 'is-sweep');

  // The mooring notice. One modifier carries both states, so the wording and
  // the colour can never end up describing different ones.
  const writeMoorShown = hiddenWriter(document.getElementById('hud-moor'));
  const writeMoorState = modifierWriter(document.getElementById('hud-moor'), 'moor');
  const writeMoorText = textWriter(document.getElementById('hud-moor-text'));

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

  // ANCHOR and COIL. Their stock count pushes off the store the same way the
  // purse does off the wallet -- `seaanchor.ts`/`overdrive.ts` notify on
  // every buy and every spend, and a HUD readout that only redrew on its own
  // per-frame poll would show a bought Sea Anchor a frame late. The gate
  // beneath the count is read every frame instead, because `canDeploy`/
  // `canEngage` also depend on the deploy timer, which moves every frame and
  // fires no event of its own.
  const writeAnchorCount = textWriter(document.getElementById('hud-anchor-count'));
  seaAnchor.onChange((count) => writeAnchorCount(`×${count}`));
  const writeAnchorGate = reasonGateWriter(document.getElementById('btn-anchor'));

  const writeOverdriveCount = textWriter(document.getElementById('hud-overdrive-count'));
  overdrive.onChange((count) => writeOverdriveCount(`×${count}`));
  const writeOverdriveGate = reasonGateWriter(document.getElementById('btn-overdrive'));

  return {
    update(ship: ShipState, energy: EnergyState, wind: WindState, weather?: WeatherState): void {
      // Read once and shared by the two charging sweeps, so the tank and the
      // hull step together at a berth rather than a frame apart. Wall clock
      // rather than the sim's, on the terms `sweepIndex` sets out.
      const nowMs = performance.now();

      // The one consumer of `WeatherState.kind`, and the reason it exists.
      // Absent means clear, so a caller with no weather prints the sky the
      // game always had.
      writeWx(weather ? weather.kind.toUpperCase() : 'CLEAR');
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

      // There is no calm any more -- `wind.ts` floors the weather at LULL_SPEED
      // -- so this row has one state and always carries a real figure and a
      // real bearing. The modifier is still written rather than dropped
      // because the markup ships it and `modifierWriter` reads that back; it
      // costs one comparison a frame and nothing after the first.
      writeWndState('blowing');
      writeWndValue(formatSpeed(wind.speed));
      writeWndArrow(`rotate(${windArrowDeg(wind, ship).toFixed(1)}deg)`);

      writeLat(formatLat(ship.latDeg));
      writeLon(formatLon(ship.lonDeg));

      // `level` is a fraction everywhere else; this is the one place it becomes
      // a percentage, and the printed number and the meter's aria value come
      // off the same rounding so they cannot disagree at a boundary.
      const level = energy.level;
      const clamped = level < 0 ? 0 : level > 1 ? 1 : level;
      const percent = String(Math.round(clamped * 100));
      writePwrState(powerSeverity(energy));
      writePwrValue(`${percent}%`);
      writePwrAria(percent);
      const pwrLit = litSegments(clamped, PWR_SEGMENTS);
      writePwrSegments(pwrLit);
      // The crest is written every frame whether or not anything is animating
      // it: it is a fact about the bar -- the notch the level stands on -- and
      // the `flow--*` class beside it is what decides whether it blinks.
      const pwrFlow = powerFlow(energy);
      writePwrFlow(pwrFlow);
      writePwrCrest(pwrLit - 1);
      writePwrSweep(pwrFlow === 'charge' ? sweepIndex(pwrLit, nowMs) : -1);
      // The berth's name, and only while there is a berth to name. `mode` is
      // asked first because it is a field read and `dockAt` is a walk down the
      // town list: at sea the tag is the same string it always was and this
      // costs one comparison.
      const tag = powerTag(energy);
      // One walk down the town list, shared by the power tag and the mooring
      // notice below. `berthReady` is in the test as well as the three tags
      // because the notice outlives the tag: a ship made fast on a full tank
      // reads TANK FULL up here and still has to name the berth down there.
      const nearBerth =
        tag === 'docked' || tag === 'mooring' || tag === 'ready' || energy.berthReady;
      const berth =
        towns !== undefined && nearBerth
          ? (towns.dockAt(ship.position)?.town.name ?? null)
          : null;
      writePwrMode(powerTagText(tag, berth));
      writePwrRate(formatRate(energy.rate));

      // The backup cell. Hidden outright at zero rather than shown empty: a
      // ship that has never bought one has no cell, and a permanently dark row
      // would be an advertisement for the shop rather than an instrument.
      //
      // Its percentage is of the MAIN tank, matching the figure above it and
      // the one the shop sells against -- a cell reading 50% is half a tank,
      // which is what it is worth. The bar is of the cell's own capacity,
      // which is a whole tank, so the two agree: the figure and the notch
      // count say the same thing, and both say what the power bar above would
      // say for the same number.
      const reserve = energy.reserve;
      const hasCell = reserve > 0;
      writeRsvShown(hasCell);
      const rsvLit = hasCell
        ? litSegments(Math.min(1, reserve / BATTERY_CAPACITY), RSV_SEGMENTS)
        : 0;
      if (hasCell) {
        const cellPercent = String(Math.round(reserve * 100));
        writeRsvValue(`${cellPercent}%`);
        writeRsvAria(cellPercent);
        writeRsvSegments(rsvLit);
      }
      // Outside the guard, so a cell that has just been spent stops blinking
      // rather than being hidden mid-animation and left that way for the next
      // ship that buys one.
      writeRsvFlow(hasCell ? reserveFlow(energy) : 'still');
      writeRsvCrest(rsvLit - 1);

      /*
       * The hull.
       *
       * Never hidden, unlike the cell above it: a ship always has one, and the
       * whole point of the block is that a player watches it come down. The
       * bar is `percent` out of 100 and the aria value is the same figure, off
       * the same field, because `hull.ts` publishes a whole number and there
       * is nothing left here to round.
       *
       * `litSegments` ceils, so the last notch stays lit all the way to the
       * 1% floor. That is the right lie on this bar and not the tank's: a dark
       * power bar means the ship cannot move, and a dark hull bar would mean a
       * sinking the game does not have.
       */
      const hullState = hull.state;
      const hullPercent = hullState.percent;
      writeHullState(hullSeverity(hullPercent));
      writeHullValue(`${hullPercent}%`);
      writeHullAria(String(hullPercent));
      const hullLit = litSegments(hullPercent / 100, HULL_SEGMENTS);
      writeHullSegments(hullLit);
      writeHullMode(hullTag(hullState.mode, hullPercent));
      writeHullRate(formatHullRate(hullState.rate));
      const hullFlowState = hullFlow(hullState.mode, hullState.rate);
      writeHullFlow(hullFlowState);
      writeHullCrest(hullLit - 1);
      writeHullSweep(hullFlowState === 'charge' ? sweepIndex(hullLit, nowMs) : -1);

      /*
       * The mooring notice.
       *
       * Shown on `berthReady` alone, which is true both while the offer stands
       * and while the ship is tied up -- it is a fact about where the hull is,
       * and the modifier beside it is what says what the helm has done about
       * it. Hidden everywhere else, so a ship at sea carries nothing.
       *
       * `mode === 'docked'` is the made-fast test rather than a flag of this
       * file's own, because being docked and being held fast are now the same
       * thing (see `EnergyMode`), and a second opinion here could only ever
       * come to disagree with the module that freezes the hull.
       */
      const moorFast = energy.mode === 'docked';
      writeMoorShown(energy.berthReady);
      if (energy.berthReady) {
        writeMoorState(moorFast ? 'fast' : 'ready');
        writeMoorText(mooringText(moorFast, berth));
      }

      // A berth and nothing else. `energy.mode` is the one definition of
      // docked in the project -- see `wind.ts`, which shelters against the
      // same test -- so the key cannot disagree with the plant about whether
      // the ship has arrived.
      writeShopGate(energy.mode === 'docked');
      // `energy.canThrust` is deliberately not read: `dead` and `restart`
      // between them hold for exactly as long as thrust is refused, so a
      // second indicator would say the same thing twice and could only ever
      // contradict the tag.

      writeAnchorGate(seaAnchor.canDeploy, seaAnchor.isDeployed ? 'Already deployed' : 'None stowed');
      writeOverdriveGate(overdrive.canEngage, overdrive.isActive ? 'Already burning' : 'None stowed');
    },

    setDevTimingVisible(visible: boolean): void {
      devReadout.setVisible(visible);
    },

    updateDevTiming(stats: GpuFrameStats): void {
      devReadout.setStats(stats);
    },
  };
}
