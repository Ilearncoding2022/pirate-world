# Sun, moon and sky — implementation plan

Status: **implemented**, on `feature/sun-moon-visuals`.

This document is kept as the record of what was approved. It is deliberately
NOT updated to follow what the build actually did — `docs/ARCHITECTURE.md` is
the current truth. Four things below were changed by what the first looks
showed, and are worth knowing before trusting the rest:

- the sun is a **view-space billboard**, not a `THREE.Sprite` with a canvas
  texture. A canvas cannot be built in the unit tier's Node environment, and
  doing the billboard in the vertex shader keeps the disc testable;
- the moon needed a **starting elongation** (`MOON_PHASE_OFFSET`). Without it
  both bodies start over longitude 0 and the world opens on a new moon beside
  a noon sun — the one arrangement in which neither can be seen;
- the moon needed a **brightness cap**. At the plan's albedo it went over the
  bloom threshold and read as a second sun;
- the atmosphere rim shell had to be **cross-faded against the dome**, which
  this plan did not anticipate at all. It is additive, it sits exactly where
  the dome is brightest, and at noon the two summed past white. The plan's
  `FOG_SKY_WEIGHT` of 0.55 was also too strong by half and washed the ocean.

The plan's own §5 guessed at the fog seam and was right to; it was the weight,
not the idea, that was wrong.

This document is the complete brief. An implementing agent should not need
the conversation it came from. Read `docs/ARCHITECTURE.md` first, especially
**Day, night, and travel**, **The world environment**, **Post-processing and
colour management** and **Testing, and the budget on it**, and
`docs/TESTING.md` before adding any test.

## What the owner decided

Asked four questions before this plan was written. The answers:

| Question | Decision |
|---|---|
| How does the moon move? | **Its own orbit, with phases.** It rises at a different time each day, can show in daylight, and its lit fraction follows the sun–moon angle. Moonlight intensity follows the phase. |
| How are the bodies drawn? | **A real moon sphere, lit by the sun, and a sprite sun.** The moon's phase comes from actual lighting, not a texture cycle. |
| Does the sky change colour? | **Yes.** A sky gradient seen from the deck: dawn orange, day blue, dusk purple, night dark with stars fading in. The far globe view keeps black space. |
| Shadows? A time-scrub control? | **Neither.** Scope stays at the visible bodies, their motion, and the sky. The light direction and intensity changes already in `daynight.ts` are reused, not redone. |

## What already exists, and is kept

- `daynight.ts` is the sole writer of `WorldEnv`. It places the sun from
  elapsed time with a seasonal tilt, and already ramps the key light's colour
  (orange → gold → white) and intensity (1.15 → 2.05) with the sun's elevation.
  **None of that changes.** This plan adds a moon to it and draws what it
  already computes.
- The "moon" today is a fill `DirectionalLight` parked opposite the sun and
  tilted north, at a constant 0.3. It becomes a real moon.
- `sky.ts` owns the atmosphere rim shell and a 3000-point starfield at radius
  2000 that spins slowly on its own. There is no sky dome; the clear colour is
  `0x05080f` and reads as space at every zoom.
- The camera (`camera.ts`) is a chase camera from 21 units behind and 9.5
  above the ship out to `0.9 × GLOBE_RADIUS` back and `0.55 × GLOBE_RADIUS`
  up. Far plane 6000. So the same scene is a horizon at one end of the wheel
  and a planet in space at the other; everything below has to work at both.
- The water's sun glint already draws the sun with an angular radius of
  `SUN_DISC_RADIANS = 0.03` (`waterglsl.ts`). The sun in the sky must match
  that size so the glint reads as the reflection of the disc above it.
- `battlescene.ts` carries its own copy of the lighting rig for the arena. It
  is **not** touched; the arena keeps its current sky and has no moon.

## Design

### 1. The moon's orbit (`daynight.ts`, `env.ts`)

`WorldEnv` gains two fields, both written only by `daynight.ts`:

```ts
/** Unit vector from the globe centre toward the moon, world space. */
readonly moonDirection: Vector3;
/** Illuminated fraction of the moon's disc, [0, 1]. 0 new, 1 full. */
moonIllumination: number;
```

The moon is placed exactly the way the sun is: a longitude from elapsed time
and a declination on a slower beat. Constants, all in `daynight.ts` next to
the sun's:

| Constant | Value | Why |
|---|---|---|
| `MOON_MONTH_DAYS` | 8 | Game days per phase cycle (160 real minutes). One eighth of a turn per day is large enough that a player sees the phase change between one night and the next. |
| `MOON_DAY_LENGTH` | `DAY_LENGTH * MOON_MONTH_DAYS / (MOON_MONTH_DAYS - 1)` | The moon tracks westward slightly slower than the sun, so the sun laps it once per month. This is what makes it rise later each day. |
| `MOON_TILT` | 0.5 rad | Peak declination, a little more than the sun's, so it crosses the sky on a visibly different path. |
| `MOON_DECL_DAYS` | 5 | Days per declination cycle. Deliberately incommensurate with 6 (seasons) and 8 (month) so nothing repeats. |
| `MOON_DECL_PHASE` | 1.7 | Starting phase, so the world never opens on an equatorial moon. |

Per frame:

```
moonLon      = -(elapsed / MOON_DAY_LENGTH) * 2π
moonDec      = sin(elapsed / (DAY_LENGTH * MOON_DECL_DAYS) * 2π + MOON_DECL_PHASE) * MOON_TILT
moonDirection = (cos(dec) sin(lon), sin(dec), cos(dec) cos(lon))     // same basis as the sun
moonIllumination = (1 - dot(sunDirection, moonDirection)) / 2
```

Illumination comes straight from the two vectors, so it can never disagree
with what the moon sphere's shader draws (Section 2), for the same reason
`solartime.ts` takes its elevation from a dot product.

**The fill light** is driven from `moonDirection` instead of the anti-sun
hack, and its intensity becomes
`MOON_INTENSITY * (MOON_FLOOR + (1 - MOON_FLOOR) * moonIllumination)` with
`MOON_FLOOR = 0.2`. Two consequences the owner has accepted by choosing this:

- a **new moon** night is darker than any night today (the ambient floor of
  0.1 still guarantees nothing is pure black);
- a night with the **moon below the horizon** gets no moonlight at all, since
  a directional light only reaches the hemisphere it faces. Nights now vary.

`MOON_TINT` stays `#93b4ec`. `MOON_TILT`'s old meaning (the north tilt of the
anti-sun) is deleted with the hack.

### 2. The bodies (`celestial.ts`, new)

One new module, `createCelestial(): { group, update(dt, env) }`, added to the
world group in `globe.ts` after `sky` and updated after `dayNight.update`.
It owns two objects, both at `CELESTIAL_DISTANCE = GLOBE_RADIUS * 8` (1600)
from the globe centre: inside the starfield's 2000, inside the camera's 6000,
and outside the key light's 6R so nothing else in the rig is near them.

**The sun** is a `THREE.Sprite`: a canvas-drawn radial texture with a hard
white core and a soft warm corona, additive blending, `depthWrite: false`,
`depthTest: true` (so the planet occludes it below the horizon). Its colour is
`env.sunColor`, so it goes orange with the key light at the horizon. Its
world size is `2 * tan(0.03) * CELESTIAL_DISTANCE` ≈ 96 units across the
core, matching `SUN_DISC_RADIANS` on the water; the corona texture extends
beyond the core, so the sprite itself is ~2.5× that. The core is over the
bloom threshold (0.9) by construction, so `postfx.ts`'s bloom gives it its
glare for free; nothing in `postfx.ts` changes.

**The moon** is a `SphereGeometry` of radius `tan(0.026) * CELESTIAL_DISTANCE`
≈ 42 units, with a hand-written `ShaderMaterial`, not a lit standard material.
Reasons: the rig's hemisphere and ambient lights would light its dark side; a
hand-written shader takes `uSunDirection` from `env` directly, so the phase is
the same vector the illumination number came from; and it can be pinned by a
golden string test like the other hand-written shaders. Fragment:

```
lit     = smoothstep(-0.05, 0.12, dot(normal, uSunDirection))   // soft terminator
albedo  = grey with a cheap hash-noise crater pattern on the sphere normal
colour  = albedo * lit
alpha   = max(lit, EARTHSHINE * (1 - uDayFactor))               // EARTHSHINE = 0.08
```

`alpha` is the point. The dark side is transparent, so by day it shows sky
(the moon reads as the pale daytime moon) and by night it shows space. The
material is `transparent: true`, normal blending, `depthTest: true`.

Neither body is put on `LAYER_REFLECTED`. The reflection cube's far plane is
`3 × GLOBE_RADIUS` (`reflection.ts`), so it could not see them at 8R anyway,
and the water already has its own sun glint. Say so in a comment where the
layer would have been set, so the next reader does not "fix" it.

### 3. The sky dome (`sky.ts`)

A second shell in `sky.ts`, `buildSkyDome()`, radius `GLOBE_RADIUS * 2`,
`BackSide`, `transparent`, `depthWrite: false`. Large enough that the camera is
inside it at every zoom (the furthest camera is ~1.8R from the centre), so
the colour is never a function of the dome's geometry, only of the view ray.

Fragment shader, per pixel, with `cameraPosition` (Three's built-in world-space
uniform) as the observer:

```
ray      = normalize(worldPos - cameraPosition)
zenith   = normalize(cameraPosition)          // local up at the camera
sunElev  = dot(zenith, uSunDirection)         // same quantity dayFactor smooths
rayElev  = dot(ray, zenith)
toSun    = dot(ray, uSunDirection)

day      = smoothstep(-0.10, 0.25, sunElev)
twilight = 1 - smoothstep(0, 0.35, abs(sunElev))          // peaks at the horizon
horizon  = mix(NIGHT_HORIZON, DAY_HORIZON, day)
zenithC  = mix(NIGHT_ZENITH,  DAY_ZENITH,  day)
sky      = mix(horizon, zenithC, smoothstep(0, 0.5, rayElev))
glow     = pow(max(toSun, 0), 8) * twilight * (1 - smoothstep(0, 0.4, rayElev))
colour   = mix(sky, DUSK_GLOW, glow)                       // warm lobe around the sun

opacity  = mix(NIGHT_OPACITY, 1, day) * altitude
altitude = 1 - smoothstep(ALT_FADE_LO, ALT_FADE_HI, length(cameraPosition) - GLOBE_RADIUS)
```

`NIGHT_OPACITY = 0.25` leaves a deep navy veil at night so the stars sit in a
sky rather than in a void, and lets them and the moon show through. `altitude`
runs 1 → 0 between 15 and 60 units above the surface (zoom ≈ 0.05 → 0.5), so
the gradient thins out as the wheel climbs and the globe view stays black
space. Both are eye-tuned numbers; the palette below is the starting point,
not a spec:

| Token | Start value |
|---|---|
| `DAY_ZENITH` | `#3f8fe0` |
| `DAY_HORIZON` | `#a9d4f5` |
| `NIGHT_ZENITH` | `#06091a` |
| `NIGHT_HORIZON` | `#141c3a` |
| `DUSK_GLOW` | `#ff8a4a` |

Same dither line as the atmosphere shell, same colour-space convention as the
atmosphere shell (hand-written, unencoded; see **Post-processing and colour
management**). The dome **is** put on `LAYER_REFLECTED`: it is inside the
cube's far plane, and the water should reflect a dawn sky rather than a
constant.

The atmosphere shell's shaders are **not edited**, so `sky-shader.test.ts`'s
existing golden stays green untouched.

### 4. Draw order

Everything here is transparent and centred on the world origin, so Three's
distance sort sees them all at the same depth and `renderOrder` is the only
thing that decides who paints over whom. Fix it explicitly, in one place
(`sky.ts` and `celestial.ts` each set their own, with the table below copied
into a comment in `sky.ts`):

| Object | `renderOrder` | Effect |
|---|---|---|
| starfield | -20 | Backdrop. The dome veils it by day. |
| sky dome | -10 | Painted over the stars; under everything else. |
| moon | -5 | Over the dome, so the daytime moon shows; under clouds. |
| sun sprite | -4 | Same; clouds pass in front of the sun. |
| atmosphere shell | 0 (unchanged) | Additive rim over the sky. |
| cloud slices | 2 + i (unchanged) | In front of all of the above. |

The water mesh is opaque with `renderOrder = -1`; opaque and transparent
passes are sorted separately, so it is unaffected.

### 5. Fog meets the sky (`fog.ts`, small)

Today `fog.ts` blends toward `ATMOSPHERE_COLOR`, which no longer matches what
is on the horizon once the dome exists: the sea would fade into a blue that
the sky above it is not. Export from `sky.ts` a CPU-side
`skyHorizonColor(env, out: Color)` that evaluates the same
`horizon`/`day` mix as the dome (the constants are shared, so they cannot
drift), and have `updateFog` lerp `uFogColorDay` toward it. Ten lines, and it
is what stops a visible seam at the horizon at dawn and dusk. If it fights the
look, the owner can revert this one commit without touching the rest.

## Commits, in order

Each is a working game on its own, so they can be judged and reverted
separately. Messages in the repo's imperative style.

1. **Give the moon its own orbit and phases** — `env.ts`, `daynight.ts`,
   `tests/unit/daynight-moon.test.ts`. No visual change beyond nights varying.
2. **Draw the sun and the moon** — `celestial.ts`, `globe.ts`,
   `tests/unit/celestial-shader.test.ts` + fixture.
3. **Colour the sky by the hour** — `sky.ts` (dome, render order,
   `skyHorizonColor`), `fog.ts`, the sky fixture gains the dome's shaders.
4. **Record the sky in the architecture notes** — `docs/ARCHITECTURE.md`
   (Day, night, and travel; Module ownership; the render-order table),
   `docs/TESTING.md` test count, this file's status line.

## Tests, and the budget

Unit tier only. Nothing here needs a renderer, and `docs/TESTING.md` forbids
asserting on appearance.

- `daynight-moon.test.ts` (~5 cases, milliseconds): `moonDirection` stays
  unit; `moonIllumination` is in [0, 1]; illumination is ~1 when the vectors
  oppose and ~0 when they align (drive `elapsed` to known values); the
  sun–moon hour angle advances by `1 / MOON_MONTH_DAYS` of a turn per
  `DAY_LENGTH`; `env.sunDirection` after `update` is byte-identical to today's
  for a few fixed times, pinning that the sun did not move when the moon was
  added.
- `celestial-shader.test.ts`: golden strings for the moon's vertex and
  fragment shaders, modulo whitespace, in the exact shape of
  `sky-shader.test.ts`.
- `sky-shader.test.ts`: two more cases for the dome's shaders against new
  fixture keys. The atmosphere cases are untouched.

Browser tier once, at the end, not per commit: `npm run test:all` must stay
green (~51 s), and the headless screenshot recipe is run to confirm the
shaders compile and the sky is not black at noon. Because there is no scrub
control, dawn and night are checked by starting the world with `env.elapsed`
preset from a scratch harness that is **not committed**, at three offsets
(`0.22`, `0.5`, `0.75` of `DAY_LENGTH`). Total testing cost stays under the
five-minute cap.

## Risks and things to watch

- **Colour space.** Hand-written shaders here write unencoded and the water
  encodes; the dome must follow the atmosphere shell's convention or the day
  sky will come out washed. Check the first screenshot against the palette.
- **Bloom on the sky.** The dome's day colours must stay under the 0.9 bloom
  threshold or the whole sky glows. The starting palette does.
- **The camera crossing 60 units of altitude** is where the dome has fully
  faded; if the transition reads as the sky "switching off", widen
  `ALT_FADE_HI`. This is the number most likely to need the owner's eye.
- **New-moon nights** will be noticeably darker than today. If that hurts
  navigation, raise `MOON_FLOOR` before touching anything else.
- **`daynight.ts`'s camera probe** already reports the camera; the dome does
  not need it, because `cameraPosition` is a built-in uniform. Do not add a
  second probe.
