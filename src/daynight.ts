import * as THREE from 'three';
import type { WorldEnv } from './env';
import type { WeatherState } from './types';
import { GLOBE_RADIUS } from './geo';
import { SPAWN_LAT_DEG, SPAWN_LON_DEG } from './terrain';
import { SUN_APPEARS_SIN } from './horizon';

export interface DayNight {
  /** Lights and any sun-following objects. Added to the world group. */
  group: THREE.Group;
  /** Advances time and rewrites `env` in place. Called before every consumer. */
  /**
   * `weather` is optional and absent means clear. It reaches the LIGHTS only
   * -- `daynight.ts` stays the sole writer of `WorldEnv`, and a storm must
   * not move the sun's own colour or the day factor, because the fog, the
   * sky and the water all mix by those and a grey sun would double the gloom
   * in every one of them.
   */
  update(dt: number, env: WorldEnv, weather?: WeatherState): void;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * Real seconds for one full orbit of the sun around the globe.
 *
 * Twenty minutes for one full turn of the sun. That is not ten of day and ten
 * of night: the day is measured from the DRAWN horizon, which on a globe this
 * small sits well below eye level, so the sun's disc is visible for about
 * 15.6 of every 24 local hours at the equator and longer than that toward the
 * poles. See `horizon.ts` for where that number comes from and `solartime.ts`
 * for what is done with it.
 *
 * A moving ship gets a different day entirely, and gets it for free. The sun
 * is placed in world space from elapsed time alone, and every shader decides
 * day or night from `dot(surface normal, sunDirection)` at the point being
 * drawn, so local time is a property of *where the ship is*, not of a clock it
 * carries. Sail east, into the sunrise, and dawn arrives sooner; sail west and
 * you chase the sunset and hold it. That is cross-timezone travel, falling out
 * of the geometry rather than being modelled.
 *
 * One caveat worth knowing before retuning this. The terminator sweeps the
 * ground at 2*PI*GLOBE_RADIUS / DAY_LENGTH, which at 1200 s is 1.05 world
 * units a second against the ship's 10. The ship is about ten times faster
 * than the sun -- the reverse of Earth, where the ground beats a ship roughly
 * forty to one. Cutting the day from an hour to twenty minutes and the hull
 * from 15 kn to 10 has narrowed that gap from sixty to one: running west at
 * speed still stretches the day a long way, but it no longer stops the sun
 * outright the way it used to, and running east now compresses the twenty
 * minutes to about two rather than collapsing the hour into one. Only three
 * things move the ratio: the day's length, the ship's speed, or a larger
 * GLOBE_RADIUS, which slows the ship in degrees without slowing the sun.
 */
export const DAY_LENGTH = 1200;

/**
 * Days in one seasonal cycle, and how far the subsolar latitude wanders on it.
 *
 * **The tilt is zero, and that is the setting, not an oversight.** The season
 * machinery below is left standing and still runs, because the choice it
 * encodes is a tuning one and the argument on both sides is worth keeping.
 *
 * What the tilt bought was variety: a terminator that ran at an angle instead
 * of pole to pole, a sunrise that was not always due east, and a day whose
 * length moved with the season. What it cost was that no two days at the same
 * latitude were alike -- and at SEASON_DAYS of 6, a whole year inside six
 * game days, they were not remotely alike. At latitude 40 the sun's visible
 * day ran 16.8 hours one day and 21.3 the next. A player cannot learn a sky
 * that changes that fast, and with the dial now measuring PROGRESS through the
 * day rather than naming an hour, having a learnable day length is worth more
 * than having a varied one.
 *
 * So the sun tracks the equator, every day at a latitude is the last one, and
 * the sunrise is always due east. Raise AXIAL_TILT back toward 0.41 to undo
 * that; everything downstream, `solartime.ts` and `START_ELAPSED` included, is
 * written in the general form and follows without further edits. Raise
 * SEASON_DAYS with it, or the days will not resemble each other.
 */
const SEASON_DAYS = 6;
/** Peak subsolar latitude, radians. Zero: see above. Earth's is 0.41. */
const AXIAL_TILT = 0;
/** Season phase at t = 0. Inert while AXIAL_TILT is zero. */
const SEASON_PHASE = 0.95;

/**
 * Sine of the sun's declination at `elapsed`: the latitude it stands over.
 *
 * Pulled out of `update` so the opening frame can be solved for below without
 * running a frame, and so the two can never disagree about where the sun is.
 */
function declinationAt(elapsed: number): number {
  const season = (elapsed / (DAY_LENGTH * SEASON_DAYS)) * Math.PI * 2 + SEASON_PHASE;
  return Math.sin(season) * AXIAL_TILT;
}

/**
 * Local solar position, in the same [0, 1) `solartime.ts` measures, at which
 * the sun's disc appears over the DRAWN horizon at this latitude.
 *
 * The same sunrise equation `solartime.ts` solves, and it has to stay the same
 * one: this is what puts the world's first frame on the moment of daybreak, so
 * if the two ever disagreed the game would open a little before or after the
 * sunrise it claims to open on.
 *
 * Where there is no crossing -- a sun that never sets, which above about 63
 * degrees of latitude is now permanent -- there is no daybreak to open on, so
 * this falls back to the sun at eye level.
 */
function daybreakLocalTime(latRad: number, declination: number): number {
  const denominator = Math.cos(latRad) * Math.cos(declination);
  if (denominator < 1e-9) return 0.25;
  const cosH0 =
    (SUN_APPEARS_SIN - Math.sin(latRad) * Math.sin(declination)) / denominator;
  if (cosH0 >= 1 || cosH0 <= -1) return 0.25;
  return 0.5 - Math.acos(cosH0) / (Math.PI * 2);
}

/**
 * The `env.elapsed` that puts the spawn meridian at a given solar position.
 *
 * The inversion of `solartime.ts`'s own relation,
 * `solarTime = fract(0.5 + tod + lon / 2PI)`. Where the sun stands over the
 * ship is the angle between two meridians and never a clock the world carries,
 * so the elapsed seconds that land on a given position depend on where the
 * spawn is and how long a day lasts -- both documented as retunable, and both
 * therefore carried by this rather than by a number written down.
 *
 * Exported because `?clock=` (see `main.ts`) needs it for any position, not
 * only for the one the world opens on: a day here lasts 1200 seconds, so two
 * screenshots taken a minute apart are lit differently, and comparing shading
 * changes by eye is impossible without pinning the sun.
 */
export function elapsedAtLocalTime(localTime: number): number {
  return (DAY_LENGTH * (((localTime - 0.5 - SPAWN_LON_DEG / 360) % 1) + 1)) % DAY_LENGTH;
}

/**
 * Elapsed seconds that put the world's first frame on daybreak at the spawn.
 *
 * Solved rather than written down, and solved as a FIXED POINT rather than
 * inverted, because the two halves depend on each other: the moment the disc
 * appears depends on the sun's declination, and the declination depends on the
 * elapsed seconds being solved for. With the axial tilt at zero the second
 * dependency vanishes and the first pass is already exact, which is why four
 * iterations is generous. Restore the tilt and this keeps working, where a
 * closed-form inversion would quietly land minutes off.
 */
export const START_ELAPSED = ((): number => {
  const lat = (SPAWN_LAT_DEG * Math.PI) / 180;
  let elapsed = elapsedAtLocalTime(daybreakLocalTime(lat, 0));
  for (let i = 0; i < 4; i++) {
    elapsed = elapsedAtLocalTime(daybreakLocalTime(lat, declinationAt(elapsed)));
  }
  return elapsed;
})();


/** How far out the key light sits. Directional, so only the direction matters. */
const SUN_DISTANCE = GLOBE_RADIUS * 6;

/* Sun tint ramp, from a sun on the horizon up to a sun overhead. */
const HORIZON_TINT = new THREE.Color('#ff7c3c');
const GOLDEN_TINT = new THREE.Color('#ffc27e');
const NOON_TINT = new THREE.Color('#fff4e4');

/**
 * Elevation, in sine, at which the day/night crossfade is complete.
 *
 * Unchanged from when the fade ran from -0.2 to here. Only its far end moved,
 * down to wherever the drawn horizon is, so the world now starts brightening
 * as the disc appears rather than a quarter of the sky later. About 12.7
 * degrees above eye level, which on this globe is a good way into the morning.
 */
const DAY_FULL_SIN = 0.22;

/* Key light. Graded down as the sun drops, standing in for air extinction. */
const KEY_LOW = 1.15;
const KEY_HIGH = 2.05;

/*
 * Sky/ground bounce. This one is global -- it hits the night hemisphere as
 * hard as the day one -- so the swing is deliberately small. All the real
 * day/night contrast comes from the key light, which by construction only
 * reaches the hemisphere it faces.
 */
const SKY_NIGHT = new THREE.Color('#24365c');
const SKY_DAY = new THREE.Color('#bfe4ff');
const GROUND_NIGHT = new THREE.Color('#0c1017');
const GROUND_DAY = new THREE.Color('#4a4030');
const HEMI_NIGHT = 0.16;
const HEMI_DAY = 0.34;

/**
 * How much of the key light and the sky bounce a full storm takes away.
 *
 * The key loses most of itself (0.7): under a storm the sun is behind a
 * kilometre of water and what reaches the deck is the sky, not the sun. The
 * bounce loses much less (0.35), and that split is the whole look of the
 * thing -- kill both equally and a storm is simply night, which the game
 * already has. Keeping the ambient up while the key falls is what makes an
 * overcast noon read as daylight with no shadows in it.
 */
const STORM_KEY_DIM = 0.7;
const STORM_HEMI_DIM = 0.35;

/**
 * What a full lightning flash adds to each, ADDITIVELY.
 *
 * Additive rather than multiplicative for one reason: most of a storm is
 * looked at after dark, and a multiplier on a key light that has already been
 * dimmed to a fifth of itself would produce a flash nobody could see. 2.5 is
 * a shade above `KEY_HIGH`, so a strike is momentarily brighter than noon,
 * which is what a strike is.
 */
const FLASH_KEY = 2.5;
const FLASH_HEMI = 0.8;

/*
 * Moonlight: a cool fill, and now a body with somewhere of its own to be.
 *
 * The moon used to be parked opposite the sun and tilted north, which made it
 * a mirrored sun that could never be anywhere else and never be anything but
 * full. It now keeps its own orbit, placed from elapsed time exactly the way
 * the sun is, so three things follow that nothing has to model:
 *
 *   - it rises later each day, because it tracks westward more slowly than the
 *     sun (see MOON_DAY_LENGTH), so the sun laps it once a month;
 *   - it is therefore sometimes up in daylight and sometimes absent all night;
 *   - its phase is the angle between the two directions, so a full moon is by
 *     construction one that rises as the sun sets.
 *
 * The fill light follows the phase, so nights are no longer interchangeable.
 * A new moon, or a moon below the horizon, leaves only the hemisphere light
 * and the ambient floor -- darker than any night before this. That is the
 * point, and AMBIENT_INTENSITY is what stops it reaching black.
 */
const MOON_TINT = new THREE.Color('#93b4ec');
/** Fill intensity at a full moon. */
const MOON_INTENSITY = 0.3;
/**
 * Fraction of the full-moon fill that survives at a new moon.
 *
 * Not zero. A new moon is still a disc in the sky catching earthshine, and
 * more practically, dropping the fill to nothing costs the night terrain all
 * its shape at once rather than over the month.
 */
const MOON_FLOOR = 0.2;
/**
 * Game days in one phase cycle, new moon to new moon.
 *
 * Eight, against Earth's 29.5, for the same reason DAY_LENGTH is twenty
 * minutes against Earth's day: a player has to be able to *see* the cycle. One
 * eighth of a turn per day means the moon is visibly a different shape, in a
 * visibly different part of the sky, from one night to the next.
 */
export const MOON_MONTH_DAYS = 8;
/**
 * Seconds for the moon to make one circuit of the globe.
 *
 * Slightly longer than DAY_LENGTH, and this is the whole mechanism: over one
 * month the sun makes MOON_MONTH_DAYS circuits and the moon makes one fewer,
 * so the sun gains exactly a full lap and the phase runs new -> full -> new.
 * Deriving it this way rather than writing a number means the month cannot
 * drift out of step with the phase it is supposed to produce.
 */
const MOON_DAY_LENGTH = (DAY_LENGTH * MOON_MONTH_DAYS) / (MOON_MONTH_DAYS - 1);
/**
 * Peak lunar declination, radians.
 *
 * This is now the ONLY body that leaves the equator: with AXIAL_TILT at zero
 * the sun tracks it exactly, every day. So the moon's track is visibly its
 * own, rather than the sun's path walked at a different hour, by a wider
 * margin than before -- and it is the only thing keeping a tilt in the sky at
 * all, which is a second reason not to flatten it to match.
 */
const MOON_DECL_TILT = 0.5;
/**
 * Days in one declination cycle. Deliberately coprime with neither -- 5
 * against the season's 6 and the month's 8 -- so the sky's three beats take
 * 120 days to line up again and nothing reads as a loop.
 */
const MOON_DECL_DAYS = 5;
/** Declination phase at t = 0, so the world does not open on an equatorial moon. */
const MOON_DECL_PHASE = 1.7;
/**
 * The moon's head start on the sun at t = 0, in turns.
 *
 * Not decorative. Without it both bodies start over longitude 0, which is a
 * NEW moon -- an unlit disc, at noon, in the one part of the sky the sun is
 * already blowing out. The world would open on the single configuration in
 * which the moon cannot be seen at all, and stay that way for the first few
 * minutes of play.
 *
 * Tuned against START_ELAPSED, and it had to be retuned when the world moved
 * from a noon opening to a dawn one -- the two want opposite things. At noon
 * the sun is overhead, so anything far enough from it to be well lit is also
 * below the horizon, and the best available was a third-lit crescent low in
 * the east. At dawn the sun is ON the eastern horizon, which frees the whole
 * western sky: the moon can be nearly opposite the sun, and therefore nearly
 * full, and still be well up. So the world now opens the way a good dawn
 * actually looks -- sun rising ahead of the bow, bright gibbous moon setting
 * astern.
 */
const MOON_PHASE_OFFSET = 0.517;

/** Floor light, so no part of the world is ever pure black. */
const AMBIENT_TINT = new THREE.Color('#54637d');
const AMBIENT_INTENSITY = 0.1;

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

/** Sub-camera direction used until the first frame reports a camera. */
const DEFAULT_VIEW_DIR = new THREE.Vector3(0, 0, 1);

const _viewDir = new THREE.Vector3();

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Zero-cost probe whose only job is to report where the camera is.
 *
 * `WorldEnv.dayFactor` is defined as how lit the *sub-camera* side of the
 * planet is, but `update(dt, env)` is never handed a camera. `onBeforeRender`
 * is, and it fires for any renderable object in the graph, so a single-vertex
 * Points whose vertex is pushed outside the clip volume -- writing neither
 * colour nor depth -- reports the camera for free. If it never fires,
 * `dayFactor` simply falls back to the lon-0 reference direction.
 */
function buildCameraProbe(onCamera: (camera: THREE.Camera) => void): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));

  const material = new THREE.ShaderMaterial({
    vertexShader: [
      'void main() {',
      '  gl_PointSize = 0.0;',
      '  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
      '}',
    ].join('\n'),
    fragmentShader: ['void main() {', '  gl_FragColor = vec4(0.0);', '}'].join('\n'),
    depthTest: false,
    depthWrite: false,
    colorWrite: false,
  });

  const probe = new THREE.Points(geometry, material);
  probe.name = 'camera-probe';
  probe.frustumCulled = false;
  probe.renderOrder = -1000;
  probe.onBeforeRender = (_renderer, _scene, camera): void => {
    onCamera(camera);
  };
  return probe;
}

/**
 * The sun cycle, and the sole writer of `WorldEnv`.
 *
 * The sun orbits the globe once every `DAY_LENGTH` seconds, sweeping a
 * terminator across the surface, while its latitude drifts on a slower
 * seasonal beat so the terminator stays tilted and never repeats exactly.
 *
 * `env.sunDirection` and the `DirectionalLight` are driven from the same
 * vector, so the hemisphere lit by the rig is exactly the one every shader
 * derives from `env`. Letting those two disagree breaks the whole world.
 */
export function createDayNight(): DayNight {
  const group = new THREE.Group();
  group.name = 'daynight';

  const hemi = new THREE.HemisphereLight(SKY_DAY.getHex(), GROUND_DAY.getHex(), HEMI_DAY);
  hemi.name = 'hemi-light';
  group.add(hemi);

  const ambient = new THREE.AmbientLight(AMBIENT_TINT.getHex(), AMBIENT_INTENSITY);
  ambient.name = 'ambient-floor';
  group.add(ambient);

  const sun = new THREE.DirectionalLight(NOON_TINT.getHex(), KEY_HIGH);
  sun.name = 'sun';
  group.add(sun);

  const moon = new THREE.DirectionalLight(MOON_TINT.getHex(), MOON_INTENSITY);
  moon.name = 'moon-fill';
  group.add(moon);

  // Sub-camera direction, refreshed once per frame by the probe.
  const viewDir = DEFAULT_VIEW_DIR.clone();
  group.add(
    buildCameraProbe((camera) => {
      if (camera.position.lengthSq() > 1e-8) viewDir.copy(camera.position).normalize();
    }),
  );

  function update(dt: number, env: WorldEnv, weather?: WeatherState): void {
    if (!(dt > 0)) dt = 0;
    env.elapsed += dt;

    // ---- Where the sun is --------------------------------------------
    // timeOfDay 0 puts the sun over lon 0 (see env.ts). Longitude decreases
    // with time so the sun tracks westward and therefore rises in the east.
    let tod = (env.elapsed / DAY_LENGTH) % 1;
    if (tod < 0) tod += 1;
    env.timeOfDay = tod;

    const sunLon = -tod * Math.PI * 2;
    // Shared with the START_ELAPSED solve above, so the opening frame and
    // every frame after it place the sun by the same arithmetic.
    const declination = declinationAt(env.elapsed);
    const cosDec = Math.cos(declination);

    // Mutated in place: consumers hold this reference.
    env.sunDirection.set(
      cosDec * Math.sin(sunLon),
      Math.sin(declination),
      cosDec * Math.cos(sunLon),
    );

    // ---- How lit the side of the planet we are looking at is ----------
    _viewDir.copy(viewDir);
    if (_viewDir.lengthSq() < 1e-8) _viewDir.copy(DEFAULT_VIEW_DIR);
    // Sine of the sun's elevation above EYE LEVEL at the sub-camera point.
    const elevation = env.sunDirection.dot(_viewDir);

    /*
     * Where the sea is, in the same units.
     *
     * Every ramp below starts here rather than at zero, and that is the whole
     * change: on a globe this small the drawn horizon is some 25 degrees under
     * eye level, so grading the light from zero meant the sun rose out of the
     * water, climbed a quarter of the sky, and only THEN was allowed to look
     * like it had risen. A disc hanging in plain sight over a sea lit as
     * midnight was the result. The tops of the ramps are unchanged: what moved
     * is where they begin.
     *
     * `SUN_APPEARS_SIN` is the horizon at ONE framing, the deck view the game
     * is played from, and not the live camera's -- even though the live one is
     * known here and really does drop as the camera climbs. Tracking it would
     * mean the whole sea brightening as a player pulled the wheel back at
     * dusk, which is a worse lie than a fixed offset and a far more visible
     * one. `dayFactor` is a property of the world; only the sky dome, which
     * fades out with altitude anyway, needs the horizon it is actually drawn
     * against, and `sky.ts` recomputes that per pixel for itself.
     */
    env.dayFactor = smoothstep(SUN_APPEARS_SIN, DAY_FULL_SIN, elevation);

    // ---- Sun tint -----------------------------------------------------
    // Deep orange with the sun on the water, through gold as it clears eye
    // level, to a neutral warm white overhead. Below the sea it holds at the
    // horizon tint: the only part of the lit hemisphere still visible from a
    // night-side camera is the sliver either side of the terminator, which is
    // warm.
    const low = smoothstep(SUN_APPEARS_SIN, 0.0, elevation);
    const high = smoothstep(0.16, 0.46, elevation);
    env.sunColor.copy(HORIZON_TINT).lerp(GOLDEN_TINT, low).lerp(NOON_TINT, high);

    // ---- Drive the rig from exactly the same vector --------------------
    sun.position.copy(env.sunDirection).multiplyScalar(SUN_DISTANCE);
    sun.color.copy(env.sunColor);
    // Thicker air near the horizon: dim the key as the sun drops.
    const key = KEY_LOW + (KEY_HIGH - KEY_LOW) * smoothstep(SUN_APPEARS_SIN, 0.42, elevation);
    // Then the weather, which dims what the sun manages to deliver and adds
    // what the lightning does. Both terms vanish exactly at zero weather.
    const storm = weather ? weather.storm : 0;
    const flash = weather ? weather.flash : 0;
    sun.intensity = key * (1 - STORM_KEY_DIM * storm) + FLASH_KEY * flash;

    // ---- Where the moon is --------------------------------------------
    // Placed from elapsed time on its own period, in the same basis as the
    // sun above, so the two are comparable and the phase below is real.
    const moonLon =
      (MOON_PHASE_OFFSET - env.elapsed / MOON_DAY_LENGTH) * Math.PI * 2;
    const moonSeason =
      (env.elapsed / (DAY_LENGTH * MOON_DECL_DAYS)) * Math.PI * 2 + MOON_DECL_PHASE;
    const moonDec = Math.sin(moonSeason) * MOON_DECL_TILT;
    const cosMoonDec = Math.cos(moonDec);

    env.moonDirection.set(
      cosMoonDec * Math.sin(moonLon),
      Math.sin(moonDec),
      cosMoonDec * Math.cos(moonLon),
    );

    /*
     * Phase, straight from the two vectors.
     *
     * `dot` is 1 with the moon in front of the sun (new: its lit face is
     * turned away from the globe) and -1 with the moon opposite (full), so
     * (1 - dot) / 2 is the illuminated fraction. This is the same quantity
     * the moon's own shader recovers per pixel from `dot(normal, sunDir)`,
     * which is why the two can never disagree about the shape in the sky.
     */
    env.moonIllumination = (1 - env.sunDirection.dot(env.moonDirection)) * 0.5;

    moon.position.copy(env.moonDirection).multiplyScalar(SUN_DISTANCE);
    // Directional, so it lights only the hemisphere it faces: a moon below
    // the horizon contributes nothing there, without any test for it here.
    moon.intensity =
      MOON_INTENSITY * (MOON_FLOOR + (1 - MOON_FLOOR) * env.moonIllumination);

    const hemiBase = HEMI_NIGHT + (HEMI_DAY - HEMI_NIGHT) * env.dayFactor;
    hemi.intensity = hemiBase * (1 - STORM_HEMI_DIM * storm) + FLASH_HEMI * flash;
    hemi.color.copy(SKY_NIGHT).lerp(SKY_DAY, env.dayFactor);
    hemi.groundColor.copy(GROUND_NIGHT).lerp(GROUND_DAY, env.dayFactor);
  }

  return { group, update };
}
