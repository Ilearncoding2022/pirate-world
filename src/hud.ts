import type { ShipState } from './types';

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

/** "12.4 kn", or "12.4 kn AST" (astern) while reversing. */
function formatSpeed(speed: number): string {
  const magnitude = Math.abs(speed).toFixed(1);
  return speed < -0.05 ? `${magnitude} kn AST` : `${magnitude} kn`;
}

export function createHud(): { update(ship: ShipState): void } {
  // Looked up once; every writer tolerates a missing element.
  const writeHeading = textWriter(document.getElementById('hud-heading'));
  const writeNeedle = transformWriter(document.getElementById('hud-compass-needle'));
  const writeSpeed = textWriter(document.getElementById('hud-speed'));
  const writeLat = textWriter(document.getElementById('hud-lat'));
  const writeLon = textWriter(document.getElementById('hud-lon'));

  return {
    update(ship: ShipState): void {
      const headingDeg = ship.headingDeg;

      writeHeading(`${formatHeading(headingDeg)}°`);
      // The rose is fixed; the needle points where the ship is heading.
      writeNeedle(`rotate(${headingDeg.toFixed(1)}deg)`);

      writeSpeed(formatSpeed(ship.speed));
      writeLat(formatLat(ship.latDeg));
      writeLon(formatLon(ship.lonDeg));
    },
  };
}
