/**
 * layers.ts — the two camera/object layer numbers every rendering stream
 * shares, so nobody has to re-derive them and two streams cannot disagree.
 *
 * Three's `Object3D.layers` is a 32-bit mask; these are the bit indices
 * passed to `.layers.enable()` / `.layers.set()` on an object or a camera.
 * Wiring constants, not spatial ones -- the world-scale/ship-scale split in
 * docs/ARCHITECTURE.md does not apply here.
 */

/** Every object starts on this layer -- Three's own default mask (bit 0). */
export const LAYER_DEFAULT = 0;

/**
 * Objects visible only to a reflection-gathering camera: the sky shell, the
 * cloud deck, the docks' beacons and the city lights. Not the land, not the
 * water, never the ship -- see docs/RENDER_PLAN.md, Phase 1 Stream D, which
 * is the first reader of this constant.
 */
export const LAYER_REFLECTED = 1;
