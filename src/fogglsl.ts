/**
 * Aerial perspective — the CONTRACT only.
 *
 * `applyAerial` is a placeholder here: it returns `col` unchanged. Stream E
 * (`docs/RENDER_PLAN.md` Phase 1) fills in the real body — a distance-based
 * blend of `col` toward the fog colour, denser at grazing angles, so the sea
 * fades into the atmosphere shell instead of meeting it at a hard edge.
 *
 * `water.ts`'s `colour` hook calls this now, with the placeholder identity
 * body, so E only ever has to change this one function and never has to touch
 * the call site. `land.ts` (Stream C) calls it too, once C lands.
 *
 * The three uniforms below are declared here because every caller needs them
 * in scope; they are OWNED by `fog.ts`, which exposes them as `fogUniforms`
 * (one shared object, merged into each caller's material uniforms) and
 * updates them once per frame from `updateFog(env)`.
 */
export const FOG_GLSL = [
  'uniform vec3 uFogColorDay;',
  'uniform vec3 uFogColorNight;',
  'uniform float uFogDensity;',
  '// Placeholder: identity. Stream E replaces this body with a distance and',
  '// grazing-angle blend toward mix(uFogColorNight, uFogColorDay, dayFactor).',
  'vec3 applyAerial(vec3 col, vec3 worldPos, vec3 camPos, vec3 sunDir, float dayFactor) {',
  '  return col;',
  '}',
].join('\n');
