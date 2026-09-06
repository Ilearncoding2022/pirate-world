import { defineConfig } from 'vitest/config';

/**
 * A separate, narrow config so `npm run golden:update` runs exactly one
 * file (`generate.test.ts`) and nothing under `tests/unit` ever picks it up
 * by accident. The main `vitest.config.ts` only looks under `tests/unit`, so
 * this file is invisible to a plain `npm test`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/fixtures/generate.test.ts'],
    testTimeout: 10_000,
  },
});
