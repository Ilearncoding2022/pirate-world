import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTerrainGolden, buildWorldGolden } from './generate';

/**
 * The golden *writer*. Only reachable through `npm run golden:update`
 * (`tests/fixtures/vitest.config.ts` is the only config that includes this
 * file), never through the ordinary `npm test`.
 *
 * Run this after a change that legitimately moves `terrain-golden.json` or
 * `world-golden.json` -- a change to `terrain.ts`'s noise, `islets.ts`'s
 * threshold, or similar -- and commit the new fixture in the same commit as
 * the change that moved it, with a note in the report. Run it for any other
 * reason and `git diff` on the two JSON files should be empty; a nonempty
 * diff with no accompanying source change is the regression these fixtures
 * exist to catch.
 */
function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, import.meta.url));
}

describe('golden fixture writer', () => {
  it('writes tests/fixtures/terrain-golden.json', () => {
    const golden = buildTerrainGolden();
    writeFileSync(fixturePath('terrain-golden.json'), JSON.stringify(golden, null, 2) + '\n');
    expect(golden.heights.length).toBe(64);
  });

  it('writes tests/fixtures/world-golden.json', () => {
    const golden = buildWorldGolden();
    writeFileSync(fixturePath('world-golden.json'), JSON.stringify(golden, null, 2) + '\n');
    expect(golden.allDocksNonNull).toBe(true);
  }, 15_000);
});
