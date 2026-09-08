import { GLOBE_RADIUS } from './geo';
import { CHASE_CAMERA_RADIUS } from './camera';
import { SUN_DISC_RADIANS } from './celestial';

/**
 * Where the sea meets the sky, and what it costs the sun to climb over it.
 *
 * One fact drives this whole file: on a globe this small the DRAWN horizon is
 * nowhere near eye level. At the chase camera's opening framing it sits about
 * 25 degrees BELOW horizontal, and it drops further as the camera climbs. So a
 * sun on the geometric horizon -- elevation zero, the angle every sunrise
 * equation is written against -- is already a quarter of the sky clear of the
 * water, and has been for a while.
 *
 * That gap used to be nobody's business, and it showed: the sun's disc hung
 * plainly over the sea while every shader in the project lit the world as
 * night, because they all decide day from night at elevation zero. Naming the
 * gap once, here, is what lets `solartime.ts` call daybreak the moment the
 * player can actually SEE the sun and lets `daynight.ts` grade the light to
 * match.
 *
 * Everything is a SINE of an elevation, never an angle, because that is the
 * form the dot products upstream already come in.
 */

/**
 * Sine of the elevation of the limb, seen from `cameraRadius` out of the
 * globe's centre.
 *
 * The horizon of a sphere seen from outside it: `-sqrt(1 - R^2/d^2)`, the same
 * expression `sky.ts` recomputes per pixel for its own gradient (`limbElev`),
 * and it has to stay the same one. The dome fades its twilight band from the
 * limb; if this drifted from that, the sun would rise out of a band of sky
 * that was not the band it was drawn against.
 *
 * Inside the globe -- which nothing should ever ask about, but a bad frame
 * can -- there is no limb, so this answers 0 rather than a NaN.
 */
export function limbSin(cameraRadius: number): number {
  if (!(cameraRadius > GLOBE_RADIUS)) return 0;
  return -Math.sqrt(1 - (GLOBE_RADIUS * GLOBE_RADIUS) / (cameraRadius * cameraRadius));
}

/**
 * Sine of the elevation the sun's CENTRE reaches as its disc touches the limb.
 *
 * The disc appears when its top edge does, so the centre is still a disc
 * radius below the limb at that moment. The same subtraction serves both ends
 * of the day, which is the point: the top edge is the last part of the sun to
 * go under as well as the first to come up, so daybreak and nightfall are one
 * threshold rather than two that have to be kept in step.
 */
export function sunAppearsSin(cameraRadius: number): number {
  return Math.sin(Math.asin(limbSin(cameraRadius)) - SUN_DISC_RADIANS);
}

/**
 * The threshold at the framing the game opens on, ~-0.450 (-26.7 degrees).
 *
 * The horizon really does drop as the camera climbs, and both of its consumers
 * deliberately ignore that and pin themselves here instead:
 *
 *   - `solartime.ts`, because the phase of the day must not move when the
 *     player zooms. It would otherwise be possible to set the sun on the dial
 *     by pulling the wheel back, without the sun moving in the sky.
 *   - `daynight.ts`, because `env.dayFactor` reaches the water, the land and
 *     the fog as one global scalar. Tracking the live camera there would
 *     brighten the whole sea as a player zoomed out at dusk -- a worse lie
 *     than a fixed offset, and a much more visible one.
 *
 * The one thing that DOES follow the live camera is `sky.ts`, which recomputes
 * the limb per pixel because the dome is the surface actually being drawn
 * against the horizon. It uses the same expression `limbSin` does.
 */
export const SUN_APPEARS_SIN = sunAppearsSin(CHASE_CAMERA_RADIUS);
