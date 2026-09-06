import { defineConfig } from 'vitest/config';

/**
 * Unit tests only: Node, no WebGL, no DOM. Three's math and BufferGeometry
 * work fine in plain Node, and nothing under tests/unit may construct a
 * renderer -- see docs/RENDER_PLAN.md, Phase 0 / T.
 *
 * tests/smoke is Playwright's, not vitest's, and is excluded below so `npm
 * test` (vitest run) never tries to load a .spec.ts file written for the
 * other runner.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/smoke/**', 'node_modules/**'],
    // world-golden builds the real 2048x1024 height map (~2s); give every
    // test room rather than special-casing one file.
    testTimeout: 10_000,
  },
});
