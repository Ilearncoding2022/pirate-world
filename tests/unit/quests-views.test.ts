import { describe, it, expect } from 'vitest';
import { QUEST_URGENT_BELOW, questLineText, questSeverity } from '../../src/hud';
import type { QuestLineInput } from '../../src/hud';
import { createToastQueue } from '../../src/toast';
import { formatDeadline, formatSpan } from '../../src/quests';
import { formatGold, formatRep } from '../../src/questcover';
import { TOAST_HOLD, TOAST_QUEUE } from '../../src/questconstants';
import { DAY_LENGTH } from '../../src/daynight';
import type { ActiveQuest } from '../../src/types';

/**
 * The contract views, through their formatters and nothing else.
 *
 * `docs/TESTING.md` rules out asserting on appearance and this adds no
 * exception: nothing here mounts an element. What IS checked is everything
 * upstream of a pixel — which phrase a state produces, which severity a clock
 * falls in, and what a span of world seconds prints as — because each of those
 * is a table with boundaries, and a boundary table is the thing that goes wrong
 * silently.
 *
 * The same argument `hull-hud.test.ts` opens with, applied to the same kind of
 * work one feature later.
 */

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function delivery(over: Partial<ActiveQuest> = {}): ActiveQuest {
  return {
    id: 'd0|Home|1|Ionport',
    kind: 'DELIVERY',
    tier: 2,
    issuer: 'Rustwharf',
    target: 'Ionport',
    window: 'ANY',
    duration: 600,
    coverage: null,
    gold: 1200,
    reputation: 20,
    brief: 'Carry mail to IONPORT',
    remaining: 600,
    ...over,
  };
}

function goal(over: Partial<ActiveQuest> = {}): ActiveQuest {
  return {
    id: 'chart|0.2',
    kind: 'CHART',
    tier: 2,
    issuer: 'Rustwharf',
    target: null,
    window: 'ANY',
    duration: null,
    coverage: 0.2,
    gold: 1000,
    reputation: 20,
    brief: 'Chart 20% of this world',
    remaining: null,
    ...over,
  };
}

function line(over: Partial<QuestLineInput> = {}): QuestLineInput {
  return {
    quest: delivery(),
    bearing: (42 * Math.PI) / 180,
    distance: 310,
    phaseOk: true,
    atTarget: false,
    coverage: 0.14,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* The HUD line                                                        */
/* ------------------------------------------------------------------ */

describe('questLineText — the four shapes', () => {
  it('prints nothing for no contract', () => {
    expect(questLineText(null)).toBe('');
  });

  it('prints the target, the fix and the clock for a passage under way', () => {
    // The bearing and the distance come through `menu.ts`'s own two formatters,
    // so this line and the HARBOURS page cannot disagree about where Ionport is.
    expect(questLineText(line())).toBe('IONPORT  042°  310 u  10:00');
  });

  it('names the wait rather than the failure at the target in the wrong hour', () => {
    /*
     * The line the whole day/night half of this feature exists to produce, and
     * the reason it is phrased as an instruction: a player who has sailed to the
     * right harbour and arrived in the wrong hour has done most of the job, and
     * the sun will be round again in minutes.
     */
    expect(
      questLineText(
        line({ quest: delivery({ window: 'DAYLIGHT' }), atTarget: true, phaseOk: false }),
      ),
    ).toBe('IONPORT  WAIT FOR DAYLIGHT');
    expect(
      questLineText(
        line({ quest: delivery({ window: 'NIGHT' }), atTarget: true, phaseOk: false }),
      ),
    ).toBe('IONPORT  WAIT FOR NIGHT');
  });

  it('prints the fix again once the hour comes round', () => {
    expect(questLineText(line({ atTarget: true, phaseOk: true }))).toBe(
      'IONPORT  042°  310 u  10:00',
    );
  });

  it('prints UNCHARTED for a harbour this world does not have, and keeps the clock', () => {
    // Contracts survive a world being redrawn by NAME, so this is an ordinary
    // reading rather than damage — and the clock is still running, which is the
    // half the player has to be told.
    expect(questLineText(line({ bearing: null }))).toBe('IONPORT  UNCHARTED  10:00');
  });

  it('prints coverage against the target for a chart goal, and no clock', () => {
    expect(questLineText(line({ quest: goal(), coverage: 0.14 }))).toBe('CHART  14% of 20%');
  });

  it('floors the coverage figure rather than rounding it', () => {
    // Rounding would let the line read `20% of 20%` on a goal that has not
    // settled, which is a readout contradicting the thing it is describing.
    expect(questLineText(line({ quest: goal(), coverage: 0.1999 }))).toBe('CHART  19% of 20%');
  });

  it('never prints a WAIT line for a contract with no window', () => {
    // `phaseOk` is always true for an ANY window, but the shape is asserted
    // anyway: the branch order here decides whether a moored delivery shows a
    // fix or a wait, and that is exactly the sort of thing a later edit moves.
    expect(questLineText(line({ atTarget: true, phaseOk: true }))).toContain('042°');
  });
});

describe('questSeverity — the four bands', () => {
  it('calls a goal with no clock a goal', () => {
    expect(questSeverity(line({ quest: goal() }))).toBe('goal');
  });

  it('calls a wait a wait, even under a minute', () => {
    // The wait outranks the clock, and should: the player is already there, and
    // turning the line amber would tell them to hurry at a ship that is moored.
    expect(
      questSeverity(
        line({
          quest: delivery({ window: 'DAYLIGHT', remaining: 5 }),
          atTarget: true,
          phaseOk: false,
        }),
      ),
    ).toBe('wait');
  });

  it('goes urgent below QUEST_URGENT_BELOW and not at it', () => {
    expect(questSeverity(line({ quest: delivery({ remaining: QUEST_URGENT_BELOW }) }))).toBe('run');
    expect(
      questSeverity(line({ quest: delivery({ remaining: QUEST_URGENT_BELOW - 0.01 }) })),
    ).toBe('urgent');
  });

  it('calls no contract at all run, so the element is never left mid-animation', () => {
    expect(questSeverity(null)).toBe('run');
  });
});

/* ------------------------------------------------------------------ */
/* The spans                                                           */
/* ------------------------------------------------------------------ */

describe('formatSpan — world seconds as a clock', () => {
  it('pads the seconds and not the minutes', () => {
    expect(formatSpan(0)).toBe('0:00');
    expect(formatSpan(9)).toBe('0:09');
    expect(formatSpan(60)).toBe('1:00');
    expect(formatSpan(599)).toBe('9:59');
    expect(formatSpan(DAY_LENGTH)).toBe('20:00');
  });

  it('floors a negative at zero rather than printing a minus', () => {
    // `quests.ts` clamps the clock, so this should be unreachable — which is
    // exactly why it is pinned: the one place a player could see a negative
    // clock is a formatter that trusts its input.
    expect(formatSpan(-5)).toBe('0:00');
  });

  it('rounds to the nearest second', () => {
    expect(formatSpan(59.6)).toBe('1:00');
    expect(formatSpan(59.4)).toBe('0:59');
  });
});

describe('formatDeadline — the card says it twice', () => {
  it('names a whole day as a day', () => {
    expect(formatDeadline(DAY_LENGTH)).toBe('1 day (20:00)');
  });

  it('names two whole days as days', () => {
    expect(formatDeadline(DAY_LENGTH * 2)).toBe('2 days (40:00)');
  });

  it('gives a fraction of a day two figures and the clock beside it', () => {
    // A player reads the dial in days and the HUD line in minutes, so a card
    // that spoke only one of the two would be translating for the other.
    expect(formatDeadline(DAY_LENGTH * 0.25)).toBe('0.25 day (5:00)');
    expect(formatDeadline(DAY_LENGTH * 0.5)).toBe('0.5 day (10:00)');
  });
});

/* ------------------------------------------------------------------ */
/* The board's own two figures                                         */
/* ------------------------------------------------------------------ */

describe('formatGold and formatRep', () => {
  it('spaces a purse in thousands', () => {
    expect(formatGold(500)).toBe('500 g');
    expect(formatGold(1200)).toBe('1 200 g');
    expect(formatGold(20000)).toBe('20 000 g');
  });

  it('always signs a standing, because it is a change and not a total', () => {
    expect(formatRep(20)).toBe('+20 REP');
    expect(formatRep(0)).toBe('+0 REP');
    expect(formatRep(-5)).toBe('-5 REP');
  });
});

/* ------------------------------------------------------------------ */
/* The strip                                                           */
/* ------------------------------------------------------------------ */

describe('the notification queue', () => {
  it('shows nothing until something is pushed', () => {
    const strip = createToastQueue();
    expect(strip.current).toBeNull();
    expect(strip.waiting).toBe(0);
  });

  it('shows the first message without waiting for a frame', () => {
    // The first notice of a session must not be a frame late: `push` is called
    // from a contract event, which can land before the strip is ever ticked.
    const strip = createToastQueue();
    strip.push('CONTRACT TAKEN', 'info');
    expect(strip.current).toEqual({ text: 'CONTRACT TAKEN', severity: 'info' });
  });

  it('holds a message for TOAST_HOLD of the dt it is handed', () => {
    /*
     * The whole reason the strip takes a `dt` rather than using a real clock: it
     * is ticked from the sailing branch only, so a notice raised as the fishing
     * card opens is still there when the card closes. A wall clock would have
     * run it out behind the card.
     */
    const strip = createToastQueue();
    strip.push('FIRST');
    strip.push('SECOND');
    strip.update(TOAST_HOLD - 0.01);
    expect(strip.current?.text).toBe('FIRST');
    strip.update(0.02);
    expect(strip.current?.text).toBe('SECOND');
  });

  it('clears itself once the last message has had its time', () => {
    const strip = createToastQueue();
    strip.push('ONLY');
    strip.update(TOAST_HOLD);
    expect(strip.current).toBeNull();
  });

  it(`drops the message past TOAST_QUEUE rather than queueing it`, () => {
    /*
     * At TOAST_HOLD seconds each, a deeper queue would be describing something
     * that happened TOAST_QUEUE * TOAST_HOLD seconds ago and is no longer news.
     * The drop is silent on purpose — a notice about a dropped notice is worse
     * than the drop.
     */
    const strip = createToastQueue();
    strip.push('ON SCREEN');
    for (let i = 0; i < TOAST_QUEUE; i++) expect(strip.push(`QUEUED ${i}`)).toBe(true);
    expect(strip.waiting).toBe(TOAST_QUEUE);
    expect(strip.push('ONE TOO MANY')).toBe(false);
    expect(strip.waiting).toBe(TOAST_QUEUE);
  });

  it('refuses an empty message', () => {
    const strip = createToastQueue();
    expect(strip.push('')).toBe(false);
    expect(strip.current).toBeNull();
  });

  it('does nothing on a tick with nothing to show', () => {
    const strip = createToastQueue();
    strip.update(100);
    expect(strip.current).toBeNull();
  });

  it('does not start the next message’s hold from the previous one’s overrun', () => {
    // A long frame must not eat two notices: the hold restarts from zero on each
    // advance, so a 100-second tick shows the second message rather than
    // skipping straight past it.
    const strip = createToastQueue();
    strip.push('FIRST');
    strip.push('SECOND');
    strip.update(100);
    expect(strip.current?.text).toBe('SECOND');
  });
});
