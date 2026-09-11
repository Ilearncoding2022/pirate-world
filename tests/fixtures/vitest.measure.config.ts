import { defineConfig } from 'vitest/config';

/**
 * A separate, narrow config so `npm run world:measure` runs exactly one file
 * (`measure.test.ts`) and nothing under `tests/unit` ever picks it up by
 * accident -- the same argument `vitest.config.ts` beside it makes for the
 * golden writer, and for the same reason: the main `vitest.config.ts` only
 * looks under `tests/unit`, so this file is invisible to a plain `npm test`.
 *
 * The timeout is the difference between the two. A golden is written in
 * seconds; a fifty-seed sweep builds fifty worlds at about a second each and
 * then evaluates a grid of candidate biases against every one of them, so the
 * per-test timeouts in `measure.test.ts` are in minutes and this has to be long
 * enough not to cut the file off before they do.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/fixtures/measure.test.ts'],
    testTimeout: 60 * 60_000,
    hookTimeout: 60 * 60_000,
    // The whole output of this run is `console.log`, so it has to reach the
    // terminal as it happens rather than being buffered into a per-test blob
    // the default reporter only unfolds on failure. Without these two, a
    // fifty-seed sweep prints nothing at all and then exits green.
    disableConsoleIntercept: true,
    reporters: ['verbose'],
  },
});
