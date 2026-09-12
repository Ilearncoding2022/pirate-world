/**
 * leviathanwater.ts — the body as a darkening term inside the water shader.
 *
 * The answer `docs/LEVIATHAN_PLAN.md` staged as Phase 2, and the reason is
 * unchanged: a term INSIDE the surface cannot be above or below it and has no
 * height to tune. The sprite pool's accepted artefact — flat planes floating
 * `DISPLACE_AMPLITUDE + 0.1` above a sea that moves — goes away rather than
 * being tuned, because there is no longer a plane.
 *
 * ## What it draws
 *
 * A tapered teardrop per segment in that segment's own tangent frame, lighter
 * toward the head, darkening `col` by an amount that rises with `surfacing`.
 * The marked segment carries a foam ring. At night the rim picks up a neon
 * edge, held under `BLOOM_THRESHOLD` so it glows on the water rather than into
 * the sky.
 *
 * ## The bound loop
 *
 * `MAX_SHOAL` equals `SHOAL_COUNT` and the fragment loop runs to that constant
 * and breaks on the live count — the legacy-style bound `hazardfield.ts`
 * documents, and which GLSL requires because a loop bound must be a constant.
 * A quiet sea pays one comparison for it.
 *
 * ## Why the tiers differ
 *
 * This runs on `medium` and `high`. The `low` tier is the software rasteriser
 * the browser tier runs on, and a fragment loop over fourteen segments there
 * is a real cost, so `low` keeps the sprite pool. Both paths are built, which
 * means if this disappoints under a screenshot there is a fallback rather than
 * a revert — and "illegible" and "absent" look identical in a screenshot, so
 * `quality.huntShadows` is what says which one was asked to draw.
 */

import * as THREE from 'three';
import type { WaterPlugin } from './water';
import type { HuntState } from './types';
import { GLOBE_RADIUS } from './geo';
import { SHOAL_COUNT } from './leviathan';

/** The loop's constant bound. Equal to `SHOAL_COUNT` by construction. */
const MAX_SHOAL = SHOAL_COUNT;

/**
 * The teardrop's reach, world units, along the body and across it.
 *
 * Generous compared with the sprite's seven by two and a half, and for the
 * same reason that one is generous: at the chase camera's distance and grazing
 * angle a small dark patch is a speck, not an animal. A term in the surface
 * can afford to be softer at the edges than a quad can, so it is both larger
 * and fainter.
 */
const REACH_ALONG = 5.2;
const REACH_ACROSS = 2.7;

/** How dark a fully surfaced segment makes the water under it. */
const DARKEN = 0.8;

/** The foam ring on the mark: where it sits and how wide, world units. */
const RING_RADIUS = 3.4;
const RING_WIDTH = 1.1;

/**
 * The night rim's ceiling.
 *
 * `postfx.ts` thresholds bloom at 0.9, so anything above that blooms. The rim
 * is meant to glow ON the water and not to smear into the sky, so it is held
 * below. This is the one number in this file that has to be confirmed in a
 * screenshot rather than argued.
 */
const NIGHT_RIM = 0.62;

export interface LeviathanWaterPlugin extends WaterPlugin {
  /**
   * Bind the live sim and the night factor.
   *
   * Built before `createGlobe` — a plugin cannot be registered after the
   * shader is compiled — and bound after, once `leviathan.ts` exists. That is
   * the awkwardness the water plugin contract imposes and which
   * `waterhazard.ts`'s header already explains. Unbound, the count stays 0 and
   * the sea is the sea.
   */
  bind(state: HuntState, night: () => number): void;
}

export function createLeviathanWaterPlugin(): LeviathanWaterPlugin {
  const positions: THREE.Vector3[] = [];
  const forwards: THREE.Vector3[] = [];
  const sides: THREE.Vector3[] = [];
  /** x: surfacing, y: envelope, z: taper (1 at the head), w: 1 if marked. */
  const shapes: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_SHOAL; i++) {
    positions.push(new THREE.Vector3(0, 1, 0));
    forwards.push(new THREE.Vector3(1, 0, 0));
    sides.push(new THREE.Vector3(0, 0, 1));
    shapes.push(new THREE.Vector4());
  }

  const uniforms: Record<string, THREE.IUniform> = {
    uLevCount: { value: 0 },
    uLevPos: { value: positions },
    uLevFwd: { value: forwards },
    uLevSide: { value: sides },
    uLevShape: { value: shapes },
    uLevNight: { value: 0 },
  };

  let source: HuntState | null = null;
  let nightOf: (() => number) | null = null;

  const declarations = [
    `uniform int uLevCount;`,
    `uniform vec3 uLevPos[${MAX_SHOAL}];`,
    `uniform vec3 uLevFwd[${MAX_SHOAL}];`,
    `uniform vec3 uLevSide[${MAX_SHOAL}];`,
    `uniform vec4 uLevShape[${MAX_SHOAL}];`,
    `uniform float uLevNight;`,
  ].join('\n');

  const hooks: WaterPlugin['hooks'] = {
    /*
     * The `colour` hook, not `foam` and not `normal`.
     *
     * The body is an absence of light in the water, so it belongs where the
     * water's colour is decided and after the lighting has run — otherwise the
     * sun would be specular off a patch that is meant to be shaded. The mark's
     * foam ring is drawn here too rather than in the `foam` hook, so that the
     * two always agree about where the animal is: one loop, one set of
     * distances, no chance of the ring and the shadow disagreeing by a frame.
     */
    colour: [
      '  {',
      '    vec3 levDir = normalize(vWorldPos);',
      '    float levShade = 0.0;',
      '    float levRing = 0.0;',
      `    for (int i = 0; i < ${MAX_SHOAL}; i++) {`,
      '      if (i >= uLevCount) break;',
      '      vec4 shape = uLevShape[i];',
      '      if (shape.y <= 0.001) continue;',
      /*
       * The offset from the segment to this pixel, resolved in the segment's
       * own tangent frame and scaled to world units. Both vectors are unit
       * directions, so their difference is a chord; over the few units this
       * reaches, the chord and the arc agree to far better than a pixel.
       */
      '      vec3 d = (levDir - uLevPos[i]) * ' + GLOBE_RADIUS.toFixed(1) + ';',
      '      float along = dot(d, uLevFwd[i]);',
      '      float across = dot(d, uLevSide[i]);',
      /*
       * The teardrop. The body narrows toward the tail, so the half-width at a
       * given `along` is widest just ahead of centre and tapers behind — which
       * is what gives every segment a FRONT, and fourteen of them a direction.
       */
      '      float reachAlong = ' + REACH_ALONG.toFixed(2) + ' * shape.z;',
      '      float reachAcross = ' + REACH_ACROSS.toFixed(2) + ' * shape.z;',
      '      float t = clamp(along / reachAlong, -1.0, 1.0);',
      '      float widthAt = reachAcross * (1.0 - 0.55 * clamp(-t, 0.0, 1.0));',
      '      float u = along / reachAlong;',
      '      float v = across / max(0.05, widthAt);',
      '      float r = sqrt(u * u + v * v);',
      '      float body = 1.0 - smoothstep(0.35, 1.0, r);',
      // Lighter toward the head: the nose is less of an absence than the body.
      '      body *= 1.0 - 0.35 * clamp(u, 0.0, 1.0);',
      '      levShade = max(levShade, body * shape.y * (0.62 + 0.38 * shape.x));',
      '      if (shape.w > 0.5) {',
      '        float rr = length(vec2(along, across));',
      '        float ring = 1.0 - smoothstep(0.0, ' + RING_WIDTH.toFixed(2) + ', abs(rr - ' + RING_RADIUS.toFixed(2) + ' * (0.55 + 0.45 * shape.x)));',
      '        levRing = max(levRing, ring * shape.y * shape.x);',
      '      }',
      '    }',
      '    if (levShade > 0.0 || levRing > 0.0) {',
      `      col = mix(col, col * ${(1 - DARKEN).toFixed(3)}, levShade);`,
      // The mark's foam: white by day, and a neon rim once the sun is down.
      '      col += vec3(0.80, 0.92, 1.0) * levRing * 0.45;',
      `      col += vec3(0.25, 0.95, 1.0) * levRing * uLevNight * ${NIGHT_RIM.toFixed(2)};`,
      '    }',
      '  }',
    ].join('\n'),
  };

  return {
    name: 'leviathan',
    uniforms,
    declarations,
    hooks,

    bind(state: HuntState, night: () => number): void {
      source = state;
      nightOf = night;
    },

    /*
     * Packed once a frame from the live state, exactly as `waterHazard.bind`
     * feeds `packHazards`. Slots past the count are never read — the loop
     * breaks there — so they keep whatever they last held rather than being
     * cleared for a tidiness nobody can see.
     */
    update(): void {
      if (source === null) {
        uniforms.uLevCount.value = 0;
        return;
      }

      const shadows = source.shadows;
      const count = Math.min(shadows.length, MAX_SHOAL);
      const last = Math.max(1, shadows.length - 1);

      for (let i = 0; i < count; i++) {
        const shadow = shadows[i];
        positions[i].copy(shadow.position);
        forwards[i].copy(shadow.forward);
        // Starboard, the third axis of the same surface frame every placement
        // in this codebase builds. Derived here rather than sent as a fourth
        // uniform array: a cross product is cheaper than 14 more vec3s.
        sides[i].crossVectors(shadow.forward, shadow.position);
        if (sides[i].lengthSq() > 1e-12) sides[i].normalize();
        shapes[i].set(
          shadow.surfacing,
          shadow.envelope,
          // The same taper the sprite path uses, so the two renderers draw an
          // animal of the same shape and a tier change is not a redesign.
          1 - 0.3 * (shadow.rank / last),
          shadow.marked ? 1 : 0,
        );
      }

      uniforms.uLevCount.value = count;
      uniforms.uLevNight.value = nightOf ? Math.max(0, Math.min(1, nightOf())) : 0;
    },
  };
}
