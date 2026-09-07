import { Material } from 'three';
import type { Color, IUniform, Mesh, MeshStandardMaterial, Object3D } from 'three';

/**
 * rimglow.ts — the Fresnel edge light that makes an AI boat read as hostile.
 *
 * An `onBeforeCompile` patch on every standard material under a root, adding
 * `uRimColor * uRimStrength * pow(1 - dot(N, V), 3)` to the emissive so the
 * whole silhouette lights up in the boat's colour and the bloom in
 * `postfx.ts` catches it. The recoloured lamps alone would not do this job:
 * at the forty to sixty units a raider is first seen from, the lamps are two
 * or three pixels and the hull is a dark shape, so it is the outline that has
 * to carry the colour.
 *
 * Two rules, and both are about ordering rather than about the maths:
 *
 * - It goes on a CLONED hull, never on the player's. `ship.ts`'s `cloneHull`
 *   is what makes that possible, and the whole reason it clones every
 *   material.
 * - It must be installed BEFORE `postFx.adopt` reaches the same materials.
 *   Both hooks chain (see **Post-processing** in docs/ARCHITECTURE.md), and
 *   the chain only assembles correctly in that direction: `adopt` captures
 *   whatever hook it finds, runs it first and appends its own cache key to
 *   the key that hook already had. Installed the other way round this patch
 *   would capture postfx's hook and hand back a cache key postfx never sees,
 *   so two differently-patched materials could collapse onto one compiled
 *   program. `aihulls.ts` is the only caller and does it in that order.
 *
 * The uniforms are one pair of objects shared by reference across every
 * material under the root, so the fade `aihulls.ts` runs each frame is a
 * single write rather than a walk of the hull.
 */

/**
 * Rim emissive multiplier.
 *
 * The authored neon's own order of magnitude (ART-DIRECTION.md §2.2 keeps
 * emissive strength in the 2.2-3.5 band), a little under it because the rim
 * covers the whole silhouette rather than a lamp-sized patch of it: at the
 * lamps' own strength the outline would be the brightest thing on the boat
 * and the neon would stop reading as neon. High enough that the bloom treats
 * the rim as a light source, which is what carries the colour at range.
 */
export const RIM_STRENGTH = 1.6;

/**
 * Fresnel exponent. Three is the usual rim-light power: at 1.0 the term
 * washes across the whole hull and the boat glows like a lamp rather than
 * being outlined by one, and past about 5 the rim thins to a wire that
 * disappears the moment the hull is more than a few hundred pixels away.
 */
const RIM_POWER = 3.0;

/**
 * Cache-key suffix, in the same `namespace/name` shape `postfx.ts` uses for
 * its own. Three's default program cache key is `onBeforeCompile.toString()`,
 * which is identical for every material this patch touches; the suffix is
 * what keeps a patched material from sharing a compiled program with an
 * unpatched one that is otherwise parameterised the same way.
 */
const RIM_CACHE_KEY = 'pirate-world/rim-glow';

export interface RimGlow {
  /** One write: the uniform is shared by reference across the hull's materials. */
  setStrength(strength: number): void;
  /**
   * The other one write, and the reason it exists: a red boat whose pursuit
   * clock runs out becomes an orange one rather than vanishing, and the rim
   * is the largest thing on it carrying that colour. Copied into the uniform,
   * so the caller keeps ownership of its palette constant.
   */
  setColor(color: Color): void;
}

/**
 * `normal` is the shaded view-space normal `<normal_fragment_begin>` builds a
 * few lines above the injection point, and `vViewPosition` is the vector from
 * the fragment to the camera in the same space, declared unconditionally by
 * Three's own `meshphysical_frag`. Both are already in scope, so this patch
 * adds no varying of its own -- which is the failure the browser tier caught
 * once before (a uniform declared in one stage and used in the other) and the
 * one thing a green `npm run build` can never tell us about a shader.
 */
const RIM_DECLARATIONS = ['uniform vec3 uRimColor;', 'uniform float uRimStrength;', ''].join('\n');

const RIM_INJECTION = [
  '#include <emissivemap_fragment>',
  '// Rim glow (rimglow.ts): added to the emissive rather than to the lit',
  '// colour, so it survives a night-side hull with no key light on it at all',
  '// and so the bloom pass reads it as one more emitter.',
  `totalEmissiveRadiance += uRimColor * uRimStrength * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), ${RIM_POWER.toFixed(1)});`,
].join('\n');

/** A material Three will hand a `meshphysical` shader to. Nothing else has the varyings above. */
function standardMaterialsOf(mesh: Mesh): MeshStandardMaterial[] {
  const held = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const out: MeshStandardMaterial[] = [];
  for (const material of held) {
    if (!material) continue;
    const std = material as MeshStandardMaterial & { isMeshStandardMaterial?: boolean };
    if (std.isMeshStandardMaterial === true) out.push(std);
  }
  return out;
}

/**
 * Patches every standard material under `root` to add a Fresnel rim in
 * `color` at `strength`.
 *
 * `color` is copied rather than held, so a caller's palette constant can
 * never be written through by a later `setStrength` or by Three's own colour
 * management; the strength is the only thing that moves after installation.
 */
export function installRimGlow(root: Object3D, color: Color, strength = RIM_STRENGTH): RimGlow {
  const uRimColor: IUniform<Color> = { value: color.clone() };
  const uRimStrength: IUniform<number> = { value: strength };
  const patched = new Set<Material>();

  root.traverse((node) => {
    const mesh = node as Mesh;
    if ((mesh as { isMesh?: boolean }).isMesh !== true) return;

    for (const material of standardMaterialsOf(mesh)) {
      // Materials are shared between meshes on this model -- the build script
      // joins by material on purpose -- so the same one arrives here several
      // times over. Patching it twice would double the rim and, worse, nest
      // the hook inside itself through the prior-hook capture below.
      if (patched.has(material)) continue;
      patched.add(material);

      // Captured BEFORE the swap, exactly as `postfx.ts` captures its own, so
      // the key describes the hook that was there rather than this one.
      const hadPrior = material.onBeforeCompile !== Material.prototype.onBeforeCompile;
      const prior = material.onBeforeCompile;
      const priorKey = hadPrior ? material.customProgramCacheKey() : '';

      material.onBeforeCompile = (shader, renderer): void => {
        if (hadPrior) prior.call(material, shader, renderer);
        shader.uniforms.uRimColor = uRimColor;
        shader.uniforms.uRimStrength = uRimStrength;
        shader.fragmentShader =
          RIM_DECLARATIONS +
          shader.fragmentShader.replace('#include <emissivemap_fragment>', RIM_INJECTION);
      };
      material.customProgramCacheKey = (): string =>
        priorKey ? `${priorKey}|${RIM_CACHE_KEY}` : RIM_CACHE_KEY;
      material.needsUpdate = true;
    }
  });

  return {
    setStrength(next: number): void {
      uRimStrength.value = next;
    },
    setColor(next: Color): void {
      uRimColor.value.copy(next);
    },
  };
}
