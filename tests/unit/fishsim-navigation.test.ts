import { describe, it, expect } from 'vitest';
import { createFishingSim, SESSION_SECONDS } from '../../src/fishsim';

/**
 * `createFishingSim`'s three new parameters — everything `fishing.ts` reads
 * an Arc-Lamp Rig, a Chum Drum or a Barbed Heads bundle into. The odds-table
 * side of the Chum Drum's `minSpawnTier` is `species-chum.test.ts`'s job;
 * this file is only the sim's own plumbing.
 */
describe('createFishingSim — Fishing offers', () => {
  it('defaults timeLeft to SESSION_SECONDS with no Arc-Lamp Rig bought', () => {
    const sim = createFishingSim(Math.random, 0);
    expect(sim.state.timeLeft).toBe(SESSION_SECONDS);
  });

  it('starts timeLeft at whatever sessionSeconds is passed', () => {
    const sim = createFishingSim(Math.random, 0, 48);
    expect(sim.state.timeLeft).toBe(48);
  });

  it('never mistakes a shorter Arc-Lamp figure for extra harpoons or a bias', () => {
    // The three new parameters sit after extraShots; a caller passing only
    // sessionSeconds must not disturb minSpawnTier or tensionDrainScale, and
    // this pins the parameter ORDER as much as any one value.
    const sim = createFishingSim(Math.random, 2, 36);
    expect(sim.state.extraLeft).toBe(2);
    expect(sim.state.timeLeft).toBe(36);
  });
});
