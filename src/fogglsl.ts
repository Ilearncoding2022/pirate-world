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
 * Two things bound it, both added after the first version shipped: real air
 * has a *finite* optical depth (FOG_MAX_AMOUNT), and a camera high above the
 * surface looks through *less* of that air, not more, because its whole line
 * of sight barely dips into the shell of it near the ground (the altitude
 * term below). Distance and grazing angle alone grow without limit, and on a
 * planet only GLOBE_RADIUS = 200 units across, they saturated by mid zoom and
 * washed `water.ts`'s deliberately re-authored depth ramp (uShallow through
 * uAbyss) into a flat pale sheet -- visible even close to the ship, since
 * that "close" distance is already large again once the camera has pulled
 * back. Both fixes below are what let one set of constants soften the
 * horizon at chase view without erasing the ocean at mid and far zoom.
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
  '// The camera\'s own height above the local surface, in world units, over',
  '// which the haze weakens by 1/e. A real atmosphere\'s scale height does not',
  '// grow with the planet underneath it, so -- like camera.ts\'s NEAR_DISTANCE',
  '// -- this is a fixed, camera-scale number, not a fraction of GLOBE_RADIUS.',
  '// First tuned to 45, which still left the haze at 63% strength at the',
  '// chase camera\'s own ~21 units of altitude -- and the chase view is where',
  '// the player actually sails, with plenty of visible water 100+ units away',
  '// even there, so that 63% was enough to wash the depth ramp on its own.',
  '// 20 cuts chase-altitude haze to about 35% instead, while mid (~70 units up)',
  '// and far (~160 up) -- already well clear of the ceiling below -- fall to a',
  '// few percent and a fraction of one, which is the "less air from higher up"',
  '// half of "the world fades into its atmosphere".',
  'const float FOG_ALTITUDE_FALLOFF = 20.0;',
  '// The largest fraction `col` is EVER blended toward the fog colour, no',
  '// matter how far away or how grazing the view. Real air has a finite',
  '// optical depth; without a ceiling the exponential below keeps climbing',
  '// toward 1.0 and, combined with FOG_GRAZE_BOOST, erases the depth ramp',
  '// long before the true horizon. This has to be much lower than it looks --',
  '// the fog colour is a bright sky blue and the deep-water bands it is',
  '// blending over are dark, so even a 30-40% mix already reads as the ocean',
  '// turning into a flat pale sheet. 0.15 (down from an initial 0.18, which',
  '// was tuned against mid and far alone and still left the chase view -- the',
  '// framing the player actually sails in -- washed) was chosen by rendering',
  '// `idle.png`, `sailing.png`, `mid.png` and `far.png` at all three framings',
  '// and comparing them against `tests/out/phase0/` until every band (shallow,',
  '// shelf, ocean, deep, abyss) stayed plainly distinct at all of them, not',
  '// just the two zoomed-out ones.',
  'const float FOG_MAX_AMOUNT = 0.15;',
  'vec3 applyAerial(vec3 col, vec3 worldPos, vec3 camPos, vec3 sunDir, float dayFactor) {',
  '  vec3 toCam = camPos - worldPos;',
  '  float dist = length(toCam);',
  '  vec3 viewDir = toCam / max(dist, 1e-4);',
  '  // The shaded point sits on (or just off) a sphere centred at the world',
  '  // origin, so its own direction from that origin IS the local vertical --',
  '  // no separate normal has to be threaded through this contract for it.',
  '  vec3 localUp = normalize(worldPos);',
  '  float grazing = 1.0 - abs(dot(viewDir, localUp));',
  '  // How far the CAMERA sits above this same local surface. length(worldPos)',
  '  // is that surface\'s own radius at this point (exactly GLOBE_RADIUS on the',
  '  // water sphere), so this reads the globe\'s size off the point being',
  '  // shaded instead of needing a uniform or a baked-in constant for it.',
  '  float camAlt = max(0.0, length(camPos) - length(worldPos));',
  '  float altFalloff = exp(-camAlt / FOG_ALTITUDE_FALLOFF);',
  '  float density = uFogDensity * mix(1.0, FOG_GRAZE_BOOST, grazing) * altFalloff;',
  '  // Scaled by FOG_MAX_AMOUNT rather than clamped after the fact, so the',
  '  // curve eases into its ceiling instead of hitting a visible elbow where',
  '  // the clamp engages.',
  '  float fogAmt = FOG_MAX_AMOUNT * (1.0 - exp(-dist * density));',
  '  vec3 fogColor = mix(uFogColorNight, uFogColorDay, clamp(dayFactor, 0.0, 1.0));',
  '  return mix(col, fogColor, fogAmt);',
  '}',
].join('\n');
