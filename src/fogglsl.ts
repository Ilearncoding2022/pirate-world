/**
 * Aerial perspective — the CONTRACT and its body.
 *
 * `applyAerial` blends `col` toward the atmosphere's own colour as distance
 * grows, so the sea (and, once `land.ts` calls this too, the land) fades into
 * the sky instead of meeting it at a hard edge. Distance alone would still
 * leave the ground directly under the camera hazier than it should be for how
 * little air the eye actually looks through, so a grazing-angle term thickens
 * the haze toward the horizon and thins it looking straight down -- the same
 * "more air at a shallow angle" cue real aerial perspective gives.
 *
 * `water.ts`'s `colour` hook calls this now, with the fog colours it reads
 * merged in via `fogUniforms` (owned by `fog.ts`); `land.ts` (Stream C) calls
 * it too, once C lands. `sunDir` is part of the fixed contract every caller
 * uses -- kept in the signature even though this body does not read it,
 * since `uFogColorDay`/`uFogColorNight` already carry the sun's current tint
 * (see `fog.ts`'s `updateFog`) and a second use of it here would double it up.
 */
export const FOG_GLSL = [
  'uniform vec3 uFogColorDay;',
  'uniform vec3 uFogColorNight;',
  'uniform float uFogDensity;',
  '// How much denser the haze gets at a fully grazing view angle (looking',
  '// along the horizon) versus straight down at the surface under the',
  '// camera. A tuning ratio, not a world- or ship-scale distance.',
  'const float FOG_GRAZE_BOOST = 2.2;',
  'vec3 applyAerial(vec3 col, vec3 worldPos, vec3 camPos, vec3 sunDir, float dayFactor) {',
  '  vec3 toCam = camPos - worldPos;',
  '  float dist = length(toCam);',
  '  vec3 viewDir = toCam / max(dist, 1e-4);',
  '  // The shaded point sits on (or just off) a sphere centred at the world',
  '  // origin, so its own direction from that origin IS the local vertical --',
  '  // no separate normal has to be threaded through this contract for it.',
  '  vec3 localUp = normalize(worldPos);',
  '  float grazing = 1.0 - abs(dot(viewDir, localUp));',
  '  float density = uFogDensity * mix(1.0, FOG_GRAZE_BOOST, grazing);',
  '  float fogAmt = clamp(1.0 - exp(-dist * density), 0.0, 1.0);',
  '  vec3 fogColor = mix(uFogColorNight, uFogColorDay, clamp(dayFactor, 0.0, 1.0));',
  '  return mix(col, fogColor, fogAmt);',
  '}',
].join('\n');
