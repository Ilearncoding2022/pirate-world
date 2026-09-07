import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildTerrainGolden,
  buildWorldGolden,
  buildWaterShaderGolden,
  buildHazardShaderGolden,
} from './generate';

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

  /*
   * The two shader fixtures. These used to have no writer at all -- the JSON
   * was produced by hand -- which made a legitimate shader change a manual
   * copy-and-paste of a 20KB string, and that is not a thing to ask of the
   * four streams `docs/TEXTURE_PLAN.md` Wave 1 sets going in parallel. Same
   * rule as the goldens above: run the writer only for a change that
   * legitimately moves the shader, and itemise what moved in the commit.
   */
  it('writes tests/fixtures/water-shader.json', () => {
    const golden = buildWaterShaderGolden();
    writeFileSync(fixturePath('water-shader.json'), JSON.stringify(golden, null, 2) + '\n');
    expect(golden.fragmentShader).toContain('void main()');
  });

  it('writes tests/fixtures/hazard-shader.json', () => {
    const golden = buildHazardShaderGolden();
    writeFileSync(fixturePath('hazard-shader.json'), JSON.stringify(golden, null, 2) + '\n');
    expect(golden.fragmentShader).toContain('hazardHeight');
  });
});
