import { describe, it, expect } from 'vitest';
import { hullSeverity, hullTag, formatHullRate, powerTagText } from '../../src/hud';
import { formatBearing, formatDistance } from '../../src/menu';
import { HARBOUR_NAMES, HARBOUR_NAME_MAX_LENGTH } from '../../src/harbournames';

/**
 * Regression cover for the four readings the instruments derive from the hull,
 * and for the two the HARBOURS page derives from a position.
 *
 * `hud.ts` and `radar.ts` have no DOM tests and this stream adds none: nothing
 * in this project asserts on appearance, and a test that mounted the telemetry
 * panel to check that a bar went amber would be exactly that. What IS tested is
 * everything upstream of a pixel — which band a percent falls in, which phrase
 * a mode and a percent produce together, and what a rate and a bearing print
 * as — because every one of those is a table with boundaries, and a boundary
 * table is the thing that goes wrong silently.
 *
 * The two tables are `docs/HARBOURS_PLAN.md`'s, Stream C, and they are checked
 * at EVERY boundary in both directions. The failure this exists to catch is the
 * off-by-one that makes a hull at exactly 50% read WORN while `hull.ts` is
 * still handing it an infinite speed cap: nothing looks broken, the ship simply
 * makes its full speed under a panel that says it cannot.
 */

describe('hullSeverity — the four colour bands', () => {
  /*
   * The plan's modifier table, read as closed intervals on a whole percent:
   *
   *   hull--sound     50..100
   *   hull--worn      25..49
   *   hull--failing    2..24
   *   hull--critical   1
   *
   * Both sides of both interior boundaries are asserted, because a `<` written
   * as a `<=` moves exactly one integer and nothing else about the panel
   * changes.
   */
  it('calls 50 and up sound, at both ends of the band', () => {
    expect(hullSeverity(100)).toBe('sound');
    expect(hullSeverity(75)).toBe('sound');
    expect(hullSeverity(50)).toBe('sound');
  });

  it('drops to worn one whole percent below 50', () => {
    expect(hullSeverity(49)).toBe('worn');
    expect(hullSeverity(25)).toBe('worn');
  });

  it('drops to failing one whole percent below 25', () => {
    expect(hullSeverity(24)).toBe('failing');
    expect(hullSeverity(2)).toBe('failing');
  });

  it('keeps critical for the floor alone', () => {
    expect(hullSeverity(1)).toBe('critical');
  });

  /*
   * `HullState.percent` is a whole number, but the boundaries are written as
   * strict inequalities on purpose -- "under 50%" is strictly below 50, per the
   * plan's own interpretation note -- so a fractional value must land on the
   * same side a rounded one would. This is the guard against someone deciding
   * the panel should read the sim's float directly one day.
   */
  it('puts a hair under a boundary on the low side of it', () => {
    expect(hullSeverity(49.99)).toBe('worn');
    expect(hullSeverity(24.99)).toBe('failing');
  });

  /* Below the floor is not a state the sim can reach, but the panel must still
     name something rather than fall off the bottom of the table. */
  it('holds critical below the floor', () => {
    expect(hullSeverity(0)).toBe('critical');
  });
});

describe('hullTag — the seven phrases', () => {
  it('names a full hull without a cap or a rate', () => {
    expect(hullTag('full', 100)).toBe('HULL FULL');
  });

  it('lets a berth win outright, at every percent', () => {
    expect(hullTag('repairing', 100)).toBe('BERTH - REPAIRING');
    expect(hullTag('repairing', 50)).toBe('BERTH - REPAIRING');
    expect(hullTag('repairing', 49)).toBe('BERTH - REPAIRING');
    expect(hullTag('repairing', 24)).toBe('BERTH - REPAIRING');
    expect(hullTag('repairing', 1)).toBe('BERTH - REPAIRING');
  });

  it('says SOUND above the first cap, and names the weather in as many words', () => {
    expect(hullTag('wearing', 99)).toBe('SOUND - WEARING');
    expect(hullTag('wearing', 50)).toBe('SOUND - WEARING');
    expect(hullTag('weathering', 99)).toBe('SOUND - WEATHERING x2');
    expect(hullTag('weathering', 50)).toBe('SOUND - WEATHERING x2');
  });

  it('names the 10 kn cap from 49 down to 25', () => {
    expect(hullTag('wearing', 49)).toBe('WORN - CAP 10 KN');
    expect(hullTag('wearing', 25)).toBe('WORN - CAP 10 KN');
  });

  it('names the 5 kn cap from 24 down to 2', () => {
    expect(hullTag('wearing', 24)).toBe('FAILING - CAP 5 KN');
    expect(hullTag('wearing', 2)).toBe('FAILING - CAP 5 KN');
  });

  it('names the floor at 1', () => {
    expect(hullTag('wearing', 1)).toBe('CRITICAL - CAP 1 KN');
  });

  /*
   * The suffix rule, which is the fiddliest line in the table: ` x2` rides the
   * two CAPPED bands and SOUND's own second phrasing, and nowhere else. It is
   * doubled wear that a player can actually act on -- heave to, or run for a
   * berth -- so it has to be visible while there is still something to save.
   */
  it('suffixes the two capped bands when the weather is doubling the wear', () => {
    expect(hullTag('weathering', 49)).toBe('WORN - CAP 10 KN x2');
    expect(hullTag('weathering', 25)).toBe('WORN - CAP 10 KN x2');
    expect(hullTag('weathering', 24)).toBe('FAILING - CAP 5 KN x2');
    expect(hullTag('weathering', 2)).toBe('FAILING - CAP 5 KN x2');
  });

  it('leaves the floor unsuffixed: the wear rate has stopped being the news', () => {
    expect(hullTag('weathering', 1)).toBe('CRITICAL - CAP 1 KN');
  });

  it('never leaks a raw mode name onto the panel', () => {
    const modes = ['full', 'wearing', 'weathering', 'repairing'] as const;
    for (const mode of modes) {
      for (let percent = 1; percent <= 100; percent++) {
        const tag = hullTag(mode, percent);
        expect(tag).toMatch(/^[A-Z0-9 x-]+$/);
        expect(tag).not.toContain(mode);
      }
    }
  });
});

describe('formatHullRate — minutes for wear, seconds for a repair', () => {
  /*
   * The whole reason the two units differ. `HULL_WEAR` is 0.25/60 percent per
   * SECOND, which in the power block's `%/s` prints `-0.0` -- a figure that is
   * wrong, alarming and unreadable at once.
   *
   * One decimal since 2026-09-09, matching the power rate above it. Plain wear
   * is 0.25 %/min and lands on a half, which `toFixed` rounds away from zero:
   * `-0.3`, not `-0.2`. That is the rounding the panel actually performs and
   * the figure a player actually reads, so it is the figure asserted here.
   */
  it('prints plain wear per minute', () => {
    expect(formatHullRate(-0.25 / 60)).toBe('-0.3 %/min');
  });

  it('prints doubled wear per minute', () => {
    expect(formatHullRate(-0.5 / 60)).toBe('-0.5 %/min');
  });

  it("prints a berth's repair per second", () => {
    expect(formatHullRate(2)).toBe('+2.0 %/s');
  });

  /* A moored hull at 100%, or one frozen behind an overlay. Unsigned, because
     a `+0.0` would read as a slow repair. */
  it('prints a still hull unsigned', () => {
    expect(formatHullRate(0)).toBe('0.0 %/min');
  });

  /* The same guard `formatRate` keeps: a sign taken off an unrounded magnitude
     produces the nonsense `-0.0`. */
  it('never prints a signed zero', () => {
    expect(formatHullRate(-1e-9)).toBe('0.0 %/min');
    expect(formatHullRate(1e-9)).toBe('0.0 %/min');
  });
});

describe('powerTagText — the berth name in the power tag', () => {
  it('puts the harbour where the word BERTH was', () => {
    expect(powerTagText('docked', 'Rustwharf')).toBe('RUSTWHARF - CHARGING');
    expect(powerTagText('mooring', 'Rustwharf')).toBe('RUSTWHARF - MAKE FAST');
  });

  it('upper-cases whatever the name table holds, apostrophes included', () => {
    expect(powerTagText('docked', "No Man's Land")).toBe("NO MAN'S LAND - CHARGING");
  });

  /* One frame at the edge of a zone can have the plant saying docked while the
     geometry says nothing is under the keel. BERTH is the right thing to print
     in it, not an empty phrase. */
  it('falls back to the shipped phrase with no name to hand', () => {
    expect(powerTagText('docked', null)).toBe('BERTH - CHARGING');
    expect(powerTagText('mooring', null)).toBe('BERTH - MAKE FAST');
  });

  it('leaves every tag that is not about a place alone', () => {
    expect(powerTagText('solar', 'Rustwharf')).toBe('IDLE - SOLAR CHARGING');
    expect(powerTagText('dead', 'Rustwharf')).toBe('NO POWER - PADDLING (1 KN)');
    expect(powerTagText('full', 'Rustwharf')).toBe('TANK FULL');
  });

  /*
   * The panel is sized against a fixed longest phrase, so the widest thing the
   * tag can ever say is worth pinning: it is what `#hud-pwr-mode`'s ellipsis
   * clamp in style.css exists for, and if the name table grows a longer entry
   * this is where that shows up.
   *
   * MAKE FAST rather than CHARGING because it is the longer tail of the two by
   * one character -- ` - MAKE FAST` to ` - CHARGING` -- so the mooring rung is
   * still the one that sets the budget, as it was when it read CONNECTING.
   */
  it('reaches its widest at the longest name plus MAKE FAST', () => {
    const longest = HARBOUR_NAMES.reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest.length).toBe(HARBOUR_NAME_MAX_LENGTH);
    expect(powerTagText('mooring', longest).length).toBe(HARBOUR_NAME_MAX_LENGTH + 12);
  });
});

describe('the HARBOURS page fix', () => {
  /*
   * `N` is the reference and not a rose point -- a bearing measured from north,
   * clockwise, exactly as the HDG readout above the scope is. The three digits
   * are `formatHeading`'s shape on purpose: the bearing read here is the
   * heading the player is about to steer.
   */
  it('prints a true bearing zero-padded to three digits', () => {
    expect(formatBearing(0)).toBe('000°');
    expect(formatBearing(Math.PI / 4)).toBe('045°');
    expect(formatBearing(Math.PI / 2)).toBe('090°');
    expect(formatBearing(Math.PI)).toBe('180°');
    expect(formatBearing((3 * Math.PI) / 2)).toBe('270°');
  });

  /* A bearing a hair under a full turn must read 000, never the impossible
     360: the wrap is taken AFTER the rounding for exactly that reason. */
  it('wraps a full turn back to north rather than printing 360', () => {
    expect(formatBearing(Math.PI * 2)).toBe('000°');
    expect(formatBearing(Math.PI * 2 - 1e-6)).toBe('000°');
  });

  /* `tangentFrame` hands out signed angles and nothing in this project
     normalises one before it is printed, so a westerly bearing arrives
     negative. */
  it('turns a negative bearing into the same compass direction', () => {
    expect(formatBearing(-Math.PI / 2)).toBe('270°');
    expect(formatBearing(-Math.PI)).toBe('180°');
  });

  it('rounds to the nearest whole degree', () => {
    expect(formatBearing((41.6 * Math.PI) / 180)).toBe('042°');
    expect(formatBearing((42.4 * Math.PI) / 180)).toBe('042°');
  });

  /* Units, not knots. Everything else the HUD prints off a world-unit figure
     is a speed; this is a length, and a harbour 34 units off at 12 knots is
     three minutes away only if the two carry different names. */
  it('prints a distance in whole units', () => {
    expect(formatDistance(0)).toBe('0 u');
    expect(formatDistance(33.6)).toBe('34 u');
    expect(formatDistance(412)).toBe('412 u');
  });

  /* A great-circle distance cannot be negative; the floor is a guard against a
     bug printing a minus sign, not a feature -- `formatGold`'s reasoning. */
  it('floors a negative distance at zero', () => {
    expect(formatDistance(-3)).toBe('0 u');
  });
});
