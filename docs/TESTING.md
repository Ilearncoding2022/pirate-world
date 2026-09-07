# Testing

Read this before adding a test, and before running one in a loop.

This project's tests exist to stop a change breaking something silently. They
do **not** exist to judge whether the game looks right; the owner does that by
eye, and no test may assert on appearance. That single rule is why the suite
can stay small and fast.

## The budget

**A routine feature build must cost under five minutes of testing, in total,
across the whole job.** Not per run. In total.

Measured on the owner's machine, at the sizes and settings checked in:

| Command | What it is | Cost |
|---|---|---|
| `npm test` | Unit tier. Node, no WebGL. | ~2 s, 129 tests |
| `npm run test:all` | Build, unit tier, browser tier. | ~51 s |
| `npm run shots` | Screenshots only, no assertions. | ~29 s |
| `npm run build` | Alone. | ~2 s |

If a change pushes `test:all` past about two minutes, delete tests until it
comes back. A suite nobody will wait for is a suite that gets skipped, and a
skipped suite catches nothing.

## The three tiers, and what belongs in each

### Tier 1 — `npm test`, the routine loop

Vitest, Node, no browser and no GPU. **Run this constantly.** It is two
seconds; there is never a reason to skip it.

It holds pure logic and the golden fixtures: geometry helpers, the height
map's sampling, ship dynamics, the wake ring buffer's invariants, wind, the
save file, the shader-text goldens, and the terrain bake's arithmetic. Anything
that can be checked without drawing a pixel belongs here.

### Tier 2 — `npm run test:smoke`, the browser

Playwright and headless Chromium on a software rasteriser. Slow by nature: a
single 1600x900 screenshot costs about two seconds to render, and launching the
browser costs a few more. **Run it when a piece of work is finished, not while
it is in progress.**

It earns its cost by doing three things nothing else can:

1. **It executes the shaders.** Every shader in this project is a GLSL string
   that never runs in Node. Three reports compile and link failures through
   `console.error`, so collecting those and asserting the list is empty is the
   only shader regression test that exists. It has already caught a real bug: a
   uniform declared in the vertex prefix but used in the fragment stage.
2. **It proves the game still boots and sails.** Including that the hull loads
   and the ship makes way, which is what forces the wake and spray materials to
   compile at all.
3. **It leaves screenshots at fixed camera stations** for a human to compare.

Two liveness checks are the only image assertions allowed: mean luminance and
distinct colour count over the centre of the frame, which catch a black or
single-colour canvas. Nothing else about appearance may be asserted, ever.

### Tier 3 — `npm run shots`, looking at the game

Not a test. No assertions, no test runner, and **no build**. It points a
browser at a preview server you already have running and saves the same five
camera stations the browser tier uses, so its output is directly comparable.

```
npm run build
npm run preview -- --port 4173 --strictPort    # leave this running
npm run shots -- --label before
# ...change something, npm run build...
npm run shots -- --label after
```

Use it for every visual iteration. It exists because diagnosing one shading bug
once cost seven full production builds and seven browser launches, when the
only thing actually needed was a picture.

#### Pinning the sun and the hazard

A day lasts `DAY_LENGTH` = 1200 seconds. Two shots taken a minute apart are lit
differently enough that a real change to the water or the land cannot be told
apart from the hour having moved, and a maelstrom is a 1% draw every ten
seconds, so waiting for one is a vigil rather than a comparison. Both are
pinned with dev queries, passed through `--query`:

```
npm run shots -- --label before --query "?clock=10&hazard=greatwave&quality=high"
npm run shots -- --label before-maelstrom --query "?clock=10&hazard=maelstrom&quality=high"
```

- `?clock=<hour>` starts the world at a fixed local hour on the spawn meridian
  (`?clock=13.5` is 13:30). Out-of-range or unparseable values are ignored.
  10:00 is the hour `docs/TEXTURE_PLAN.md`'s waves compare at: high enough for
  a real sun road on the water, low enough that land relief still casts.
- `?hazard=wave|greatwave|maelstrom` raises one, 25 units dead ahead, three
  seconds in. Already existed; it is listed here because the two are only
  useful together.
- `?quality=low|medium|high` picks the tier. The hazard streams have to be
  looked at on all three: `low` registers no reflection plugin at all, and the
  displacement patch drops from 160 segments to 96.

## Rules

1. **No test asserts on how anything looks.** Screenshots are artefacts for a
   person, never inputs to an assertion. The two liveness checks above are the
   whole exception and they are about the canvas being alive, not about it
   being beautiful.
2. **Never sleep; wait for a condition.** An earlier version of the browser
   tier spent 25.5 seconds in fixed `waitForTimeout` calls, which was most of
   its runtime. The three things those sleeps were guessing at are all directly
   observable: the hull's `.glb` response arriving, the first frame passing the
   liveness check, and the HUD reading way on. Short settles after an input
   are fine; multi-second sleeps are not.
3. **Build exactly once per run.** The npm scripts build; Playwright's
   `webServer` only serves. Having both build meant every full run compiled
   twice.
4. **Do not gate every step on the browser tier.** This is the rule that was
   actually broken. During the rendering work the browser tier ran more than
   twenty times, because it was wired into the definition of done for nine
   separate pieces of work and re-run after all six merges. That is over twenty
   minutes of waiting for a check whose result had not changed. Gate ordinary
   steps on Tier 1, and run Tier 2 at the boundaries: once when a piece of work
   is finished, and once more after everything is integrated.
5. **Golden fixtures are pinned behaviour, not decoration.** `npm run
   golden:update` regenerates them and is deliberately a separate command. A
   golden that moves without an explanation in the same commit is a
   regression, not a stale fixture.
6. **Add a test only when it pins something a change could break silently.**
   Two here earn their place loudly: the CPU-versus-GPU wave field parity
   check, which agrees to 1/255 and would otherwise let the hull ride a
   different sea than the player sees, and the console error check. Tests that
   restate what the code obviously does cost time forever and catch nothing.

## What the tests did and did not catch

Worth knowing before trusting a green run.

They caught a shader that would not compile, three real defects in the CPU port
of the wave field, and would catch a change to the world's coastline.

They did **not** catch either of the two visual regressions that actually
shipped into the integration branch: an aerial perspective that flattened the
ocean's depth palette, and a specular term that turned the near water into a
white sheet. Both passed a green build, all unit tests, and an empty console
error list. Both were found by putting a screenshot next to an earlier one.

So: a green suite means nothing is broken in a way a machine can see. It does
not mean the change is right. Look at `tests/out/` before believing it.
