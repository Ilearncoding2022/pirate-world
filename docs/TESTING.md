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
| `npm test` | Unit tier. Node, no WebGL. | ~5 s, 528 tests |
| `npm run test:all` | Build, unit tier, browser tier. | ~2.3 min, plus ~2.9 min since the hunt (see below) |
| `npm run shots` | Screenshots only, no assertions. | ~29 s |
| `npm run build` | Alone. | ~2 s |

If a change pushes `test:all` past about two minutes, delete tests until it
comes back. A suite nobody will wait for is a suite that gets skipped, and a
skipped suite catches nothing.

**The leviathan hunt's browser case breaks that rule and is flagged rather than
hidden.** `hunt=armed` measures 2.9 minutes on its own, which roughly doubles
the browser tier. Almost all of it is the boot plus thirty simulated frames on
a software rasteriser, and the case has already been cut once: an earlier
version steered the hull at the shoal and cost 3.3 minutes to test nothing,
because the ship reached a coastline and everything after the steering sat
behind an `if`.

What it buys is five bugs the unit tier structurally could not see: a gate that
could not be met at point blank, shadows drawn under a displaced sea, a needle
that moved one pixel, a dial that cannot arm on a fresh save, and a warning
colour the cascade was eating. Every one of those needed pixels, a real
keystroke, or the game's actual starting state.

**The owner's call, 2026-09-11: keep it, and amend the rule rather than the
suite.** The two-minute line above is a guard against a suite nobody waits for,
not a law, and a case returning six bugs in one feature is the wrong place to
spend it. Read the budget as: under five minutes for a routine build, and any
single case over about a minute has to name what it buys, in this file, the way
this one does.

If it ever does have to go, the thing to keep is the assertion on
`hunt.sprites`: absent and illegible look identical in a screenshot and only
one of them is a design trade.

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
npm run shots -- --label before --query "?clock=10&hazard=wave&quality=high"
npm run shots -- --label before-maelstrom --query "?clock=10&hazard=maelstrom&quality=high"
```

- `?clock=<hour>` starts the world at a fixed local hour on the spawn meridian
  (`?clock=13.5` is 13:30). Out-of-range or unparseable values are ignored.
  10:00 is the hour `docs/TEXTURE_PLAN.md`'s waves compare at: high enough for
  a real sun road on the water, low enough that land relief still casts.
- `?hazard=wave|maelstrom` raises one, 25 units dead ahead, three
  seconds in. Already existed; it is listed here because the two are only
  useful together. `?hazard=maelstrom-now` opens the funnel ON the hull
  instead, so the ship is swallowed at once and the run is about the sea it
  comes back to — the near half of the pair `?battle=1` and `?salvage=take`
  already carry. It exists because 25 units still has to be SAILED, and the
  software rasteriser this tier runs on advances the simulation at about a
  fiftieth of wall clock: measured, a hull under full throttle covered four
  units in two hundred seconds, which puts a funnel dead ahead twenty minutes
  away. That is the vigil this query was invented to end.
- `?quality=low|medium|high` picks the tier. The hazard streams have to be
  looked at on all three: `low` registers no reflection plugin at all, and the
  displacement patch drops from 160 segments to 96.
- `?battle=1` puts an orange raider on the hull so a fight starts at once,
  rather than waiting on a 16%-and-24%-per-ten-seconds draw. `?boat=red|orange`
  spawns one 45 units ahead instead, leaving the approach to play out. Wait on
  `#battle` losing its `hidden` attribute; do not time it.
- `?calm=1` switches off all three of `battlesea.ts`'s systems for every fight
  in the session -- the same `CALM` the gunner's own unit cases are pinned
  against. Tuning the gunner against a hull that is also being shoved, fouled
  and blocked is tuning it against noise.
- `?salvage=1` floats one raft 25 units ahead and `?salvage=take` puts one on
  the hull so the payout runs at once; `?derelict=1` puts a dead hull just
  outside its own hook ring and `?derelict=hook` just inside it. Each pair is
  `?boat=`/`?battle=1` again -- one value to LOOK at the thing, one to make the
  thing HAPPEN -- and the second of each exists because the first cannot be
  reached by a headless run: the wind carries the hull several units sideways
  (`wind.ts`'s `across`), so holding the throttle down passes a dead-ahead
  target a unit or two off and nothing ever fires. A player steers; a
  screenshot cannot.
  Both sims publish on the debug hook under `?debug`, so a run waits on the
  state rather than on a clock: `__pirateWorld.salvage` carries every raft's
  distance and envelope plus a `taken` count, and `__pirateWorld.derelict`
  carries the hull's distance, `towed`, `hookReady`, the harbour it is bound
  for and a `settled` count. The two counters are the point -- a payout is not
  visible in a screenshot, and a notice strip that has already timed out is not
  evidence either.

**The chandlery is reachable now, and it was not before.** `#btn-shop` ships
`disabled`, only a berth enables it, and `main.ts` re-tests the berth on the
click rather than trusting the button -- so for as long as the only way to a
berth was to sail there, no container could open it at a tenth of wall clock.
`?spawn=<lat>,<lon>` puts the ship in a berth ring on the first frame, and
`?seed=1337&spawn=26.31,-12.52` moors at Scrapmoor with the panel one click
away. That is how the repair block and the per-harbour stock were checked.

It is still worth remembering, when reading the markup rather than driving it,
that offers are addressed by template literal (`` `shop-${prefix}-price` ``),
so grepping a literal id finds nothing and proves nothing.

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

## The world is random now, so every test pins it

`worldgen.ts` draws a fresh seed on every page load. Two screenshots of two
different planets are not a comparison, and a browser test that asserted
against whatever it drew would be asserting against noise.

So **every URL the suites open carries `?seed=1337`** — `tests/shots.mjs`
prepends it unless `--seed` says otherwise, and `tests/smoke/game.spec.ts`
passes it explicitly. 1337 is `DEFAULT_SEED`: the seed `world-golden.json`
pins and the one `generateWorld` falls back to after twelve failed draws. A
pinned seed makes exactly one attempt and THROWS if it fails, which is what
makes it a pin; if that ever fires, the unit tier said so first.

Six dev queries are worth knowing when you need to look at something:

| Query | What it is for |
|---|---|
| `?seed=<uint32>` | Pin the world. Always on in both suites. |
| `?reject=<n>` | Force the first n world attempts to fail. The only way to exercise the retry and the fallback, because no failing seed is known. |
| `?hull=<1..100>` | Start worn. Goes through `Hull.override`, which does not write the save. |
| `?spawn=<lat>,<lon>` | Start somewhere else. The only way to reach either polar harbour, or to get close enough to a harbour to see its name label, or to open the chandlery in a browser at all. |
| `?quest=board` | Print every harbour's contract board for today to the console. A board turns over once per world day, which is twenty real minutes, so this is the only way to look at the shape of the draw without waiting for it. |
| `?quest=accept:<n>` / `?quest=accept:<name>:<n>` | Take posting `n` at the nearest harbour, or at a named one (underscores for spaces, matched case-insensitively). The only way to get a contract in hand without sailing to a berth first, which is what makes a completion testable at all. |

`?spawn=` is what retires this file's old note that the chandlery is
unreachable from the browser tier. It is reachable now:
`?seed=1337&spawn=26.31,-12.52` moors at Scrapmoor.

The two contract queries compose with it, and that pairing is the whole point:
`?seed=1337&spawn=26.31,-12.52&quest=accept:0` moors at Scrapmoor carrying its
first posting, which is one `[WORK]` press away from a board to look at and one
passage away from a settlement.
