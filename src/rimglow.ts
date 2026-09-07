import type { Color, Object3D } from 'three';

/**
 * rimglow.ts — the Fresnel edge light that makes an AI boat read as hostile.
 *
 * STUB. Agent B fills this in; see docs/BATTLE_PLAN.md, "rimglow.ts".
 *
 * An `onBeforeCompile` patch on every standard material under a root, adding
 * `uRimColor * uRimStrength * pow(1 - dot(N, V), 3)` to the emissive so the
 * whole silhouette lights up in the boat's colour and the bloom catches it.
 *
 * It must be installed BEFORE `postFx.adopt` chains its own hook onto the same
 * materials — see **Post-processing** in docs/ARCHITECTURE.md — and only ever
 * on a CLONED hull, never on the player's.
 */

/** Rim emissive multiplier. The authored neon's order of magnitude, so the bloom treats it as neon. */
export const RIM_STRENGTH = 1.6;

export interface RimGlow {
  /** One write: the uniform is shared by reference across the hull's materials. */
  setStrength(strength: number): void;
}

export function installRimGlow(root: Object3D, color: Color, strength = RIM_STRENGTH): RimGlow {
  void root;
  void color;
  void strength;
  return {
    setStrength(): void {
      /* stub */
    },
  };
}
