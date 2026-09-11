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
 *
 * ## The weather argument
 *
 * `wx` is `(rain, fog)` AT THIS FRAGMENT, 0..1 each, and it is passed IN
 * rather than read from a uniform inside this body. That is the whole reason
 * a fog bank can be seen from outside itself: the caller samples
 * `weathermap.ts` at the point being shaded, so the sea and the land INSIDE a
 * bank go grey and flat while the water at the ship stays sharp, which from a
 * deck reads as a wall of air sitting on the horizon.
 *
 * It is an argument and not a uniform for a second reason too. `battlescene.ts`
 * calls this contract from a flat arena that is nowhere on the globe, where a
 * sample of an equirectangular world map would be meaningless; it passes
 * `vec2(0.0)` and gets exactly the arena it always had. A uniform read inside
 * this body would have hazed the arena the first time it stormed at sea.
 *
 * Use `aerialWeather(...)` below to build `wx`: it is the one place the map's
 * sample and the at-ship squall are combined, so a caller cannot combine them
 * one way while another combines them the other.
 *
 * Every weather term is multiplied by a component of `wx`, so at `wx = 0` this
 * is byte for byte the function it was before any of it existed. That is the
 * zero contract (docs/WEATHER_PLAN.md, Trap 2) and it is not negotiable: the
 * ocean's depth ramp has been washed out by a careless additive term twice
 * already, and both times it was found by eye rather than by a test.
 */
export const FOG_GLSL = [
  'uniform vec3 uFogColorDay;',
  'uniform vec3 uFogColorNight;',
  'uniform float uFogDensity;',
  '// The ceiling below, as a uniform rather than the constant it used to be,',
  '// so a fog bank can raise it. Its resting value IS the old constant.',
  'uniform float uFogMax;',
  '// The two colours weather fades the distance toward. A FOG bank is a pale',
  '// grey -- fog is bright, it is lit water in the air, and it takes the',
  '// colour out of what is behind it. A STORM is the opposite and needs its',
  '// own endpoint: rain darkens the distance rather than whitening it, and',
  '// fading a storm toward the bank grey painted the whole ocean into the',
  '// flat pale sheet this file warns about twice above. Seen, once, in a',
  '// `?weather=storm` shot; the two colours are the fix.',
  'uniform vec3 uFogBankColor;',
  'uniform vec3 uFogStormColor;',
  '// The weather AT THE SHIP, for the half of it that has no place: a squall',
  '// is rolled off the wind and is wherever the ship is, so it cannot come',
  '// from the map. `aerialWeather` maxes these with the map\'s own sample.',
  'uniform float uFogHere;',
  'uniform float uRainHere;',
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
  '// How much denser a full fog bank makes the haze.',
  '//',
  '// 3.5, down from a first cut of 6.0 which -- with the ceiling below at its',
  '// own first cut of 0.85 -- put the water directly under the hull at a 60%',
  '// blend and produced a ship sailing on a sheet of white paper. That is the',
  '// exact failure the ceiling constant below is written to prevent, and it',
  '// was caught in a `?weather=fog` shot rather than by any test.',
  '//',
  '// At 3.5, with the chase camera about 21 units up, the sea twenty units',
  '// ahead of the bow is blended about a third of the way to the bank and the',
  '// horizon is gone entirely. That is a bank you sail INTO rather than one',
  '// you are painted over by.',
  '//',
  '// 10.5 now, which is that number times three: the owner asked for fog three',
  '// times as thick at every intensity, and this is the RATE half of it. The',
  '// rate is the right half to triple because it is the only term that still',
  '// has room -- the ceilings below are deliberately not moved (FOG_MAX_BANK',
  '// is already 0.92, and there is no 2.76 to go to), so what triples is how',
  '// FAST the haze reaches them, not how far it goes. Concretely the sea now',
  '// crosses any given blend at about a third of the distance it used to: the',
  '// water twenty units ahead of the bow is most of the way to the bank colour',
  '// rather than a third of it, and a thin bank that used to read as a haze on',
  '// the horizon closes to within the chase frame.',
  '//',
  '// The near field is NOT this constant\'s to wash out, which is what makes a',
  '// 3x here survivable at all: FOG_BANK_ONSET below keeps the bank\'s share of',
  '// this term near zero inside about 20 units, so tripling it thickens the',
  '// distance and leaves the water under the hull to `fogbank.ts`\'s geometry',
  '// and its clear-air bowl. Clear-weather haze is untouched -- `uFogDensity`',
  '// is the same 2.0 / GLOBE_RADIUS it always was, and every warning in this',
  '// file and in `fog.ts` about the depth ramp applies to THAT constant.',
  'const float FOG_DENSITY_GAIN = 10.5;',
  '// Rain thickens the air, but nothing like a bank does: you can see a long',
  '// way through a downpour and a few hundred metres through fog. 1.0 against',
  '// the 10.5 above is that ratio -- it was 1.0 against 3.5 when a bank was a',
  '// third as thick, and it stays 1.0 now rather than tracking the bank up,',
  '// because a downpour was never asked to get thicker and the first cut at',
  '// 2.0 was already part of what washed the sea out.',
  'const float STORM_DENSITY_GAIN = 1.0;',
  '// What the ceiling becomes in a full bank.',
  '//',
  '// 0.92, up from the 0.75 this constant held for as long as the flat tint',
  '// WAS the fog. That old number is still the right one for a tint applied at',
  '// every distance, and its reasoning is worth keeping in full: even inside',
  '// the thickest fog the sea immediately under the hull has to still be sea,',
  '// or the ship appears to be sailing on a sheet of paper -- a first cut said',
  '// exactly that at 0.85 and then did it anyway, because the density gain',
  '// above was pushing every distance into the ceiling.',
  '//',
  '// What changed is that the near field is no longer this term\'s to protect.',
  '// `fogbank.ts` draws real geometry over the first tens of units and',
  '// FOG_BANK_ONSET below keeps this term out of exactly that range, so the',
  '// ceiling now only ever applies to distance -- and at distance a bank is',
  '// SUPPOSED to take the horizon away completely. 0.92 rather than 1.0 only',
  '// because a horizon that reaches the fog colour to the last bit reads as a',
  '// cleared framebuffer rather than as thick air.',
  'const float FOG_MAX_BANK = 0.92;',
  '// Over how many world units the BANK\'s share of this term ramps in, and',
  '// the seam between the two halves of fog.',
  '//',
  '// A bank is a volume, and since `fogbank.ts` it is drawn as one: a stack of',
  '// slices standing on the water, near the ship, that genuinely passes in',
  '// front of the hull. This term cannot do that -- it tints the surface being',
  '// shaded and nothing else -- and when it was the only fog there was, the',
  '// result was the note that produced this constant: a grey layer laid over',
  '// the sea rather than fog sitting in the air above it.',
  '//',
  '// So the two divide the range. Under about 20 units this term contributes',
  '// almost nothing to a bank and the geometry is the whole effect; by 70 it',
  '// is at full weight and the geometry has faded out at its own cap rim.',
  '// Neither module reads the other: they overlap over the middle third and',
  '// the sum is continuous, which is all a seam has to be.',
  '//',
  '// It gates the bank ONLY. Rain keeps this term at every distance, because a',
  '// downpour really is a tint on everything you can see through it, and there',
  '// is no rain geometry past `rain.ts`\'s box around the hull.',
  'const float FOG_BANK_ONSET = 70.0;',
  '// How far rain lifts the ceiling, and it has to be SMALL.',
  '//',
  '// The comment on FOG_MAX_AMOUNT above is the whole argument: 0.15 was',
  '// chosen over 0.18 because the larger number washed the chase view, and',
  '// "even a 30-40% mix already reads as the ocean turning into a flat pale',
  '// sheet". The first cut of this constant was 0.25, which put a full',
  '// downpour at exactly 0.40 and reproduced that failure precisely. 0.08 is',
  '// a ceiling of 0.23 in the heaviest rain: a visibly hazier sea that is',
  '// still a sea with a depth ramp in it.',
  '//',
  '// A fog BANK may go to 0.85 because a bank is meant to take the horizon',
  '// away -- that is the effect, and there is nothing left to preserve.',
  'const float STORM_MAX_GAIN = 0.08;',
  '// How much of a storm reads as rain in the air, for the map\'s sake: the',
  '// map carries a storm field and a fog field and no rain field of its own,',
  '// because rain is a fixed function of storm and a third channel would be',
  '// a byte per texel spent on arithmetic.',
  'const float RAIN_OF_STORM = 0.75;',
  '// How far a full downpour pulls the haze toward the storm colour above.',
  '// Not toward the BANK colour: see uFogStormColor. Under rain the air is',
  '// wet and dark, and this is a weight on a dark endpoint rather than on a',
  '// pale one, so it can afford to be large.',
  'const float STORM_GREY = 0.7;',
  '// Build the `wx` argument from `weathermap.ts`\'s sample at this fragment.',
  '// The ONE place the map and the at-ship squall are combined, so every',
  '// caller combines them the same way. `max`, not a sum: two pieces of',
  '// weather in one place are one weather.',
  'vec2 aerialWeather(vec3 mapSample) {',
  '  return vec2(max(uRainHere, mapSample.r * RAIN_OF_STORM), max(uFogHere, mapSample.g));',
  '}',
  'vec3 applyAerial(vec3 col, vec3 worldPos, vec3 camPos, vec3 sunDir, float dayFactor, vec2 wx) {',
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
  '  // The altitude term is kept in FRONT of the weather, deliberately. A fog',
  '  // bank is a thing that sits on water; from orbit you should see the sea',
  '  // through it and the cell in the CLOUD deck above it instead. Without',
  '  // this, thick weather would paint the whole limb grey at far zoom.',
  '',
  '  // The bank\'s share of this term, ramped in with distance so the near',
  '  // field belongs to `fogbank.ts`\'s geometry and this keeps the far. See',
  '  // FOG_BANK_ONSET. `wx.y` itself is left alone -- the ramp is applied to',
  '  // every USE of it below rather than to the value, so it stays readable as',
  '  // "the bank here" and a future reader cannot use the raw one by accident.',
  '  float bank = wx.y * smoothstep(0.0, FOG_BANK_ONSET, dist);',
  '  float weather = 1.0 + FOG_DENSITY_GAIN * bank + STORM_DENSITY_GAIN * wx.x;',
  '  float density = uFogDensity * weather * mix(1.0, FOG_GRAZE_BOOST, grazing) * altFalloff;',
  '  // Scaled by the ceiling rather than clamped after the fact, so the',
  '  // curve eases into it instead of hitting a visible elbow where the clamp',
  '  // engages. At wx = 0 the ceiling is uFogMax, whose resting value is the',
  '  // FOG_MAX_AMOUNT above -- the constant is kept as the documented default',
  '  // and the reasoning behind it is still the reasoning behind the uniform.',
  '  float ceiling = min(1.0, mix(uFogMax, FOG_MAX_BANK, bank) + wx.x * STORM_MAX_GAIN);',
  '  float fogAmt = ceiling * (1.0 - exp(-dist * density));',
  '  vec3 fogColor = mix(uFogColorNight, uFogColorDay, clamp(dayFactor, 0.0, 1.0));',
  '  // Then the weather\'s own colour, in two steps rather than one, because',
  '  // the two endpoints pull opposite ways: a bank whitens the distance, a',
  '  // downpour darkens it. Rain first, so that a bank rolling through a',
  '  // storm still reads as a bank.',
  '  fogColor = mix(fogColor, uFogStormColor, clamp(STORM_GREY * wx.x, 0.0, 1.0));',
  '  fogColor = mix(fogColor, uFogBankColor, clamp(bank, 0.0, 1.0));',
  '  return mix(col, fogColor, fogAmt);',
  '}',
].join('\n');
