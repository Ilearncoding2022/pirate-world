import type { Vector3 } from 'three';
import type {
  ActiveQuest,
  QuestEvent,
  QuestOffer,
  QuestTier,
  QuestWindow,
  Town,
  Towns,
} from './types';
import type { Chart } from './chart';
import type { KnownHarbours } from './knownharbours';
import type { Wallet } from './wallet';
import type { Reputation } from './reputation';
import { DAY_LENGTH } from './daynight';
import { GLOBE_RADIUS } from './geo';
import { solarPhase } from './solartime';
import { mulberry32 } from './towns';
import {
  ARC_FAR,
  ARC_NEAR,
  CARGOES,
  CHART_GOLD,
  CHART_PROGRESS_STEP,
  CHART_TARGETS,
  CRUISE_SPEED,
  DELIVERY_DAYS,
  DELIVERY_GOLD,
  GOLD_ROUNDING,
  MAX_ACTIVE,
  OFFERS_PER_HARBOUR,
  REPUTATION_BY_TIER,
  REPUTATION_FAIL,
  REPUTATION_WINDOW_BONUS,
  WINDOW_GOLD_BONUS,
  WINDOW_MIN,
  WINDOW_SLACK,
  WINDOW_WEIGHT_ANY,
  WINDOW_WEIGHT_DAYLIGHT,
  WINDOW_WEIGHT_NIGHT,
} from './questconstants';

/**
 * quests.ts — the contract sim. Every rule in the system is here and nowhere
 * else.
 *
 * Generation, acceptance, the per-frame check, completion, failure and the
 * reward all live in this file; `questcover.ts`, `hud.ts`, `menu.ts` and
 * `toast.ts` are views that read it or subscribe to it and decide nothing. It
 * is the `energy.ts`-to-`hud.ts` split the project already runs on, and the
 * reason for it here is the same: a contract's rules are mostly spherical
 * geometry and clock arithmetic, which are exactly the things that can be
 * wrong without looking wrong, so they have to be testable in plain Node with
 * no DOM and no world. See `docs/QUESTS_PLAN.md`.
 *
 * ## The clock is the world's, never the wall's
 *
 * There is no `Date`, no `performance.now()` and no `setTimeout` in this file,
 * and there must never be one. A deadline is counted down in WORLD seconds,
 * handed in by `main.ts` as `dt` from the sailing branch of the frame loop —
 * the branch that does not run while the fishing card, the shop, the menu, the
 * battle cover or a fight owns the screen. So a contract cannot expire behind
 * an overlay, and it cannot expire while the tab is in the background either.
 * That is not a nicety: the deadlines here are a few minutes long, and a player
 * who lost one while reading the controls page would have lost it to the user
 * interface rather than to the sea.
 *
 * The flip side, and it is the mechanic rather than a flaw: the deadline is in
 * ABSOLUTE world seconds while the *local* day stretches for a ship running
 * west and compresses for one running east (`solartime.ts`). A player who
 * understands that reaches a daylight window a player who does not would miss.
 * The clock does not bend; the daylight does.
 *
 * ## The board is derived, not stored
 *
 * A harbour's three postings are a pure function of `(questSeed, harbour name,
 * world day)`, so they are the same three every time the board is opened
 * inside one world day and a fresh three the next day. Nothing about a posting
 * is written to disk. Two things follow that are worth stating:
 *
 * - Reopening the board costs nothing and cannot reshuffle it, which is what
 *   makes "I'll come back for the pole run" a sentence a player can act on.
 * - A reload redraws the world, so the *targets* move and the board changes
 *   with them. That is consistent rather than surprising: the sea is new.
 *
 * The one thing that is saved is the seed, because a seed re-drawn per load
 * would reshuffle every board on every reload and make the day boundary
 * meaningless.
 *
 * ## Three traps this file is written around
 *
 * **Completion runs on a frame loop.** `update` is called every frame the ship
 * is moored, exactly as `knownHarbours.add` is. So settlement is idempotent by
 * construction: a contract is removed from `active` BEFORE its listeners fire,
 * and the listeners are what pay the purse and write the save. A listener that
 * read `active` back sees the world after the settlement, never during it.
 *
 * **A failure must not import a fail state.** Failing costs
 * `REPUTATION_FAIL` and nothing else. No gold is taken, no upgrade is lost, no
 * other contract is touched, nothing is locked. `docs/ROADMAP.md` asked for
 * "failure costs gold, never progress" and the owner tightened it further.
 *
 * **An offer the player cannot fulfil is worse than no offer.** A harbour never
 * posts itself, never posts a target with no berth, and never posts a window
 * that cannot be reached inside the deadline from a standing start. See
 * `windowReachable`, which is the only genuinely delicate function here.
 *
 * ## One deviation from the plan, and why
 *
 * `docs/QUESTS_PLAN.md` lists the per-frame order as deadlines, then
 * completion, then chart progress. This file settles COMPLETIONS FIRST and
 * expires afterwards. The plan's order decides a contract that arrives on the
 * same frame its clock runs out against the player, by up to 16 ms of a
 * several-minute deadline; and the player did in fact get there. Fairness at a
 * boundary is worth a documented departure, and the departure is visible: the
 * clock is decremented and clamped at zero first, so the HUD never shows a
 * negative, and the expiry sweep runs last.
 */

/* ------------------------------------------------------------------ */
/* Deps and the interface                                              */
/* ------------------------------------------------------------------ */

export interface QuestsDeps {
  /**
   * The world's harbours, or null before the world exists.
   *
   * A callback and not a value, for the reason every other late-bound
   * dependency in this project is one: `createQuests` is called from
   * `createRecords`' neighbourhood, before `globe.towns` exists, and a value
   * read at construction would be null forever.
   */
  readonly towns: () => Towns | null;
  /**
   * The chart, for `CHART` goals. Null before the world exists.
   */
  readonly chart: () => Chart | null;
  /**
   * Harbours moored at. Unused in Phase 1 and wired anyway: `SURVEY` —
   * "moor somewhere you never have" — is the one Phase 2 kind that needs it,
   * and wiring it now means Phase 2 is a change to this file alone rather than
   * a change to this file and to every caller.
   */
  readonly known: KnownHarbours;
  readonly wallet: Wallet;
  readonly reputation: Reputation;
  /** `questSeed` from the save. A uint32. */
  readonly seed: number;
  /**
   * Contracts loaded off disk, already sanitised by `save.ts`.
   *
   * Their clocks resume where they stopped and their targets are re-resolved
   * by NAME in whatever world came up — see `SaveData.quests`.
   */
  readonly saved?: readonly ActiveQuest[];
}

export interface Quests {
  /** Contracts in hand. Live, and never longer than `MAX_ACTIVE`. */
  readonly active: readonly ActiveQuest[];
  /**
   * The board at `harbour` for world `day`, with anything already in hand
   * filtered out.
   *
   * Empty before the world exists, before the first `update` (this file has
   * not seen the sun yet and cannot judge a window), and for a name that is
   * not a harbour in this world.
   */
  offers(harbour: string, day: number): readonly QuestOffer[];
  /** False when the slots are full, the id is already in hand, or it is unfulfillable. */
  accept(offer: QuestOffer): boolean;
  /**
   * Drops a contract the player no longer wants. Costs exactly what expiry
   * costs. False if the id is not in hand.
   */
  abandon(id: string): boolean;
  /**
   * One frame of the sailing branch.
   *
   * @param dt            world seconds since the last call
   * @param elapsed       `env.elapsed`, for the world day
   * @param sunDirection  `env.sunDirection`. Held by reference — see the note
   *                      in the body on why that is deliberate.
   * @param berth         the moored harbour's name, or null
   */
  update(dt: number, elapsed: number, sunDirection: Vector3, berth: string | null): void;
  /** Subscribe. Returns an unsubscribe function. */
  on(fn: (event: QuestEvent) => void): () => void;
  /** For `save.ts`. Frozen copies; the caller may hold them. */
  snapshot(): readonly ActiveQuest[];
  /** The world day `elapsed` last landed in. What `offers` should be asked for. */
  readonly day: number;
}

/* ------------------------------------------------------------------ */
/* The draw                                                            */
/* ------------------------------------------------------------------ */

/**
 * A 32-bit FNV-1a of a string.
 *
 * Used to fold a harbour NAME into the board's seed. A name rather than an
 * index, for the reason `harbournames.ts` gives: index 7 is a different island
 * in every world, and a board keyed on one would follow the island rather than
 * the harbour.
 */
function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    // The FNV prime, as shifts: `hash * 16777619` overflows the 53-bit mantissa
    // on long strings and stops being the function it claims to be.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash >>> 0;
}

/** Folds the three inputs of a board into one uint32 for `mulberry32`. */
function boardSeed(seed: number, harbour: string, day: number): number {
  let h = (seed ^ hashName(harbour)) >>> 0;
  h = (h ^ (day * 0x9e3779b1)) >>> 0;
  // One round of xorshift, so two adjacent days do not share their high bits.
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/** Great-circle arc between two unit directions, radians. */
function arcBetween(a: Vector3, b: Vector3): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
}

/** Which of the three bands an arc falls in. */
function tierForArc(arc: number): QuestTier {
  if (arc < ARC_NEAR) return 1;
  if (arc < ARC_FAR) return 2;
  return 3;
}

/** Wraps into [0, 1). Local to this file; `solartime.ts` keeps its own. */
function fract(v: number): number {
  return v - Math.floor(v);
}

/**
 * World seconds until the sun's disc next appears at a point, or next vanishes.
 *
 * Both fall out of one fact recorded in `solartime.ts`: `solarTime` at a FIXED
 * point advances at exactly `1 / DAY_LENGTH` per second, because the sun's
 * longitude is `-timeOfDay * 2PI` (`daynight.ts`) and the point's longitude
 * does not move. So the wait for any `solarTime` boundary is the forward
 * distance to it, which is what `fract` measures.
 *
 * This is the piece that would be wrong if the sun's direction of travel were
 * ever reversed, so it names the two lines it depends on rather than leaving a
 * reader to rediscover them.
 */
function secondsUntilSolarTime(from: number, boundary: number): number {
  return fract(boundary - from) * DAY_LENGTH;
}

/**
 * Can a ship leaving now reach `target` while it is in the phase `window`
 * asks for, inside `deadline`?
 *
 * The only genuinely delicate function in the file, and the one the fourth
 * trap in the file comment is about: an offer whose window has already closed
 * for good is worse than no offer at all, because the player cannot tell the
 * difference until they have sailed there.
 *
 * The phase at a fixed point is periodic with `DAY_LENGTH`, so the wanted phase
 * is a repeating interval on the time axis. This walks those intervals and asks
 * whether any of them overlaps `[travel, deadline]` by at least `WINDOW_MIN`.
 * The margin is not decoration: an overlap of one second is a window nobody
 * can steer into, and offering it would be a lie told in arithmetic.
 *
 * A polar point is answered rather than guarded: above about 63 degrees the sun
 * either never sets or never rises, so the phase there is a constant and the
 * question collapses to "is it the right one".
 */
function windowReachable(
  targetDir: Vector3,
  sunDirection: Vector3,
  window: QuestWindow,
  travel: number,
  deadline: number,
): boolean {
  if (window === 'ANY') return true;
  if (travel > deadline) return false;

  const phase = solarPhase(targetDir, sunDirection);
  const wantDay = window === 'DAYLIGHT';

  // A midnight sun or a polar night: one phase, forever, no boundary to wait
  // for. Either it is the wanted one or this target can never satisfy it.
  if (phase.polar) return phase.isDay === wantDay && deadline - travel >= WINDOW_MIN;

  const wantedLength = (wantDay ? phase.dayFraction : 1 - phase.dayFraction) * DAY_LENGTH;
  // A phase shorter than the margin cannot produce a usable overlap at any
  // offset, so there is no point walking the intervals.
  if (wantedLength < WINDOW_MIN) return false;

  // `dayStart` and `dayEnd` are the two `solarTime` boundaries. The wanted
  // phase opens at one of them and shuts at the other.
  const opens = wantDay ? phase.dayStart : phase.dayEnd;
  const shuts = wantDay ? phase.dayEnd : phase.dayStart;

  let start: number;
  let end: number;
  if (phase.isDay === wantDay) {
    // Already open. The current interval began in the past, which is why its
    // start is clamped to now rather than computed.
    start = 0;
    end = secondsUntilSolarTime(phase.solarTime, shuts);
  } else {
    start = secondsUntilSolarTime(phase.solarTime, opens);
    end = start + wantedLength;
  }

  // At most a handful of turns: `deadline` is one world day at the very most
  // (`DELIVERY_DAYS`), so this runs once or twice in practice. The cap is a
  // guard against a retuned deadline, not a real case.
  for (let turn = 0; turn < 4; turn++) {
    const from = start + turn * DAY_LENGTH;
    if (from > deadline) break;
    const open = Math.max(from, travel);
    const shut = Math.min(end + turn * DAY_LENGTH, deadline);
    if (shut - open >= WINDOW_MIN) return true;
  }
  return false;
}

/** World seconds the sun's disc is still up at a point, or Infinity in a polar day. */
function daylightLeft(targetDir: Vector3, sunDirection: Vector3): number {
  const phase = solarPhase(targetDir, sunDirection);
  if (phase.polar) return phase.isDay ? Infinity : 0;
  if (!phase.isDay) return 0;
  return secondsUntilSolarTime(phase.solarTime, phase.dayEnd);
}

/** True while `target` is in the phase a window demands. `ANY` is always true. */
function windowSatisfied(
  targetDir: Vector3,
  sunDirection: Vector3,
  window: QuestWindow,
): boolean {
  if (window === 'ANY') return true;
  const phase = solarPhase(targetDir, sunDirection);
  return window === 'DAYLIGHT' ? phase.isDay : !phase.isDay;
}

/** To the nearest `GOLD_ROUNDING`, never below it. */
function roundGold(value: number): number {
  const stepped = Math.round(value / GOLD_ROUNDING) * GOLD_ROUNDING;
  return stepped < GOLD_ROUNDING ? GOLD_ROUNDING : stepped;
}

/** "6:00" — a span of world seconds as minutes and seconds. */
function formatSpan(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const mins = Math.floor(whole / 60);
  return `${mins}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The deadline as the card says it: world days where that is a round-ish
 * number, and minutes and seconds where it is not.
 *
 * A player reads the dial in days and the HUD line in minutes, so a card that
 * only spoke one of those two would be translating for one of them.
 */
function formatDeadline(seconds: number): string {
  const days = seconds / DAY_LENGTH;
  const asDays =
    Math.abs(days - 1) < 0.01
      ? '1 day'
      : Math.abs(days - Math.round(days)) < 0.01
        ? `${Math.round(days)} days`
        : `${days.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} day`;
  return `${asDays} (${formatSpan(seconds)})`;
}

/** What a window reads as in a brief. */
function windowPhrase(window: QuestWindow): string {
  if (window === 'DAYLIGHT') return ', arrive in daylight';
  if (window === 'NIGHT') return ', arrive after dark';
  return '';
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export function createQuests(deps: QuestsDeps): Quests {
  const active: ActiveQuest[] = [];
  for (const quest of deps.saved ?? []) {
    if (active.length >= MAX_ACTIVE) break;
    // A shallow copy, because `remaining` is written every frame and the
    // object `save.ts` handed over came out of `JSON.parse` — shared with
    // nothing, but copying makes that true by construction rather than by
    // inspection of a caller.
    active.push({ ...quest });
  }

  const listeners = new Set<(event: QuestEvent) => void>();

  /**
   * The sun, by REFERENCE rather than by copy.
   *
   * `daynight.ts` is the sole writer of `WorldEnv` and rewrites
   * `env.sunDirection` in place every frame (`env.ts` forbids reassigning it),
   * so holding the reference means this file always reads the current sun
   * without a per-frame clone and without a value import of `Vector3`. The
   * cost is that it is null until the first `update`, which is why `offers`
   * answers empty before then: the frame loop updates before any click can
   * reach the board, so that window does not exist in a real session.
   */
  let sun: Vector3 | null = null;
  /** The world day, from the last `elapsed` seen. */
  let worldDay = 0;
  /**
   * Coverage at the last `progress` event per quest id, so a step is announced
   * once rather than on every frame inside it.
   */
  const announced = new Map<string, number>();

  function emit(event: QuestEvent): void {
    // Over a copy, on `wallet.ts`'s terms: a subscriber may unsubscribe itself
    // from inside its own callback.
    for (const fn of Array.from(listeners)) fn(event);
  }

  /* ---------------------------------------------------------------- */
  /* Generation                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * The `CHART` goal this world is ready for, or null.
   *
   * The lowest `CHART_TARGETS` entry the player has not passed, so the board
   * always shows the next rung and never one already cleared. It takes NOTHING
   * from the board's random stream, which is what lets it come and go during a
   * day without reshuffling the two deliveries beside it — see `offers`.
   *
   * Its id names the target and not the harbour or the day, deliberately: a
   * chart goal is a fact about the world rather than about who posted it, so
   * every harbour offers the same one and accepting it anywhere takes it off
   * every board at once.
   */
  function chartOffer(issuer: string): QuestOffer | null {
    const chart = deps.chart();
    if (chart === null) return null;
    const coverage = chart.coverage();
    const index = CHART_TARGETS.findIndex((target) => coverage < target);
    if (index < 0) return null;
    const target = CHART_TARGETS[index];
    const tier = (index + 1) as QuestTier;
    return {
      id: `chart|${target}`,
      kind: 'CHART',
      tier,
      issuer,
      target: null,
      window: 'ANY',
      duration: null,
      coverage: target,
      gold: CHART_GOLD[index],
      reputation: REPUTATION_BY_TIER[index],
      brief: `Chart ${Math.round(target * 100)}% of this world`,
    };
  }

  /**
   * One delivery, drawn from `rng`.
   *
   * The rng is consumed in a FIXED order — cargo, window, purse — whatever the
   * target turns out to be and whether or not the window survives the legality
   * test. A draw whose length depended on its own outcome would make the
   * second posting on a board a function of the first, and the board would
   * reshuffle whenever anything upstream changed.
   */
  function deliveryOffer(
    issuer: Town,
    target: Town,
    slot: number,
    day: number,
    rng: () => number,
    sunNow: Vector3,
  ): QuestOffer {
    const arc = arcBetween(issuer.dir, target.dir);
    const tier = tierForArc(arc);
    const cargo = CARGOES[Math.floor(rng() * CARGOES.length) % CARGOES.length];

    const total = WINDOW_WEIGHT_ANY + WINDOW_WEIGHT_DAYLIGHT + WINDOW_WEIGHT_NIGHT;
    const roll = rng() * total;
    let window: QuestWindow =
      roll < WINDOW_WEIGHT_ANY
        ? 'ANY'
        : roll < WINDOW_WEIGHT_ANY + WINDOW_WEIGHT_DAYLIGHT
          ? 'DAYLIGHT'
          : 'NIGHT';

    const base = DELIVERY_DAYS[tier - 1] * DAY_LENGTH;
    const travel = (arc * GLOBE_RADIUS) / CRUISE_SPEED;
    // The legality test, and the fallback is to drop the WINDOW rather than the
    // offer: a target a day's sail away is worth posting whatever the sun is
    // doing over it, and dropping the whole posting would leave a board of two.
    if (window !== 'ANY' && !windowReachable(target.dir, sunNow, window, travel, base * WINDOW_SLACK)) {
      window = 'ANY';
    }

    const duration = window === 'ANY' ? base : base * WINDOW_SLACK;
    const [low, high] = DELIVERY_GOLD[tier - 1];
    const purse = low + rng() * (high - low);
    const gold = roundGold(window === 'ANY' ? purse : purse * WINDOW_GOLD_BONUS);
    const reputation =
      REPUTATION_BY_TIER[tier - 1] + (window === 'ANY' ? 0 : REPUTATION_WINDOW_BONUS);

    return {
      id: `d${day}|${issuer.name}|${slot}|${target.name}`,
      kind: 'DELIVERY',
      tier,
      issuer: issuer.name,
      target: target.name,
      window,
      duration,
      coverage: null,
      gold,
      reputation,
      brief: `Carry ${cargo} to ${target.name.toUpperCase()}, ${formatDeadline(duration)}${windowPhrase(window)}`,
    };
  }

  function offers(harbour: string, day: number): readonly QuestOffer[] {
    const towns = deps.towns();
    const sunNow = sun;
    if (towns === null || sunNow === null) return [];
    const issuer = towns.byName(harbour);
    if (issuer === null) return [];

    /*
     * Always the full count of deliveries, drawn first and in order.
     *
     * The chart goal is slotted in AFTERWARDS, over slot 0, rather than taking
     * a slot before the draw. The difference matters: coverage moves while the
     * player sails, so a chart goal that consumed a slot would shorten the
     * delivery draw the moment a target was passed and reshuffle the two
     * postings beside it. Drawn this way, slots 1 and 2 are fixed for the whole
     * world day and only slot 0 ever changes hands.
     */
    const rng = mulberry32(boardSeed(deps.seed, harbour, day));
    // Only harbours with a berth: a target the ship cannot tie up at cannot be
    // delivered to, and `energy.ts`'s docked verdict is what settles a
    // delivery. `towns.all` order is a property of the world's seed, so this
    // pool is the same on every call.
    const pool = towns.all.filter((town) => town.name !== harbour && town.dock !== null);
    const draws: QuestOffer[] = [];
    for (let slot = 0; slot < OFFERS_PER_HARBOUR && pool.length > 0; slot++) {
      // Without replacement, so one board never posts the same harbour twice.
      const pick = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
      const target = pool.splice(pick, 1)[0];
      draws.push(deliveryOffer(issuer, target, slot, day, rng, sunNow));
    }

    const chart = chartOffer(harbour);
    const board = chart === null ? draws : [chart, ...draws.slice(1)];
    // Anything already in hand is not a posting any more. Filtered here rather
    // than in the cover screen so the menu page, the dev log and the screen all
    // see one board.
    const held = new Set(active.map((quest) => quest.id));
    return board.filter((offer) => !held.has(offer.id));
  }

  /* ---------------------------------------------------------------- */
  /* Acceptance                                                       */
  /* ---------------------------------------------------------------- */

  function accept(offer: QuestOffer): boolean {
    if (active.length >= MAX_ACTIVE) return false;
    if (active.some((quest) => quest.id === offer.id)) return false;
    // A delivery with no reachable berth in this world is refused rather than
    // accepted-and-stuck. It cannot happen off a board this file generated —
    // the pool is filtered on `dock !== null` — but `accept` is public and the
    // dev query reaches it.
    if (offer.kind === 'DELIVERY') {
      const towns = deps.towns();
      if (towns === null) return false;
      if (offer.target === null || towns.byName(offer.target) === null) return false;
    }
    const quest: ActiveQuest = { ...offer, remaining: offer.duration };
    active.push(quest);
    emit({ kind: 'accepted', quest });
    return true;
  }

  /**
   * Takes a contract out of `active` and returns it, or null.
   *
   * The one place `active` shrinks, which is what makes settlement idempotent:
   * a caller that settles twice on two frames of the same mooring gets a null
   * the second time and pays nothing.
   */
  function take(id: string): ActiveQuest | null {
    const index = active.findIndex((quest) => quest.id === id);
    if (index < 0) return null;
    const [quest] = active.splice(index, 1);
    announced.delete(id);
    return quest;
  }

  function fail(id: string, reason: 'expired' | 'abandoned'): boolean {
    const quest = take(id);
    if (quest === null) return false;
    // The state is changed, then the stores, then the listeners — so a
    // subscriber that reads `active` or the reputation back sees the world
    // after the failure rather than halfway through it.
    deps.reputation.penalise(REPUTATION_FAIL);
    emit({ kind: 'failed', quest, reputation: REPUTATION_FAIL, reason });
    return true;
  }

  function settle(quest: ActiveQuest): void {
    const taken = take(quest.id);
    if (taken === null) return;
    deps.wallet.add(taken.gold);
    deps.reputation.award(taken.reputation);
    emit({
      kind: 'completed',
      quest: taken,
      gold: taken.gold,
      reputation: taken.reputation,
    });
  }

  /* ---------------------------------------------------------------- */
  /* The frame                                                        */
  /* ---------------------------------------------------------------- */

  function update(
    dt: number,
    elapsed: number,
    sunDirection: Vector3,
    berth: string | null,
  ): void {
    sun = sunDirection;
    worldDay = Math.floor(elapsed / DAY_LENGTH);

    /*
     * Clocks first, clamped at zero rather than allowed negative.
     *
     * The clamp is what lets the expiry sweep run LAST without the HUD ever
     * printing a negative figure in between: a contract sitting at 0 for one
     * frame reads `0:00`, which is the truth about it.
     */
    if (dt > 0) {
      for (const quest of active) {
        if (quest.remaining === null) continue;
        quest.remaining = Math.max(0, quest.remaining - dt);
      }
    }

    /*
     * Deliveries, settled against the project's one definition of moored.
     *
     * The window is tested at the TARGET's own direction and not at the ship's,
     * which is the same thing here — the ship is tied up at it — but says which
     * of the two the rule is about. Over a copy of `active`, because `settle`
     * splices it.
     */
    if (berth !== null) {
      const towns = deps.towns();
      for (const quest of Array.from(active)) {
        if (quest.kind !== 'DELIVERY' || quest.target !== berth) continue;
        const town = towns?.byName(berth) ?? null;
        if (town === null) continue;
        if (!windowSatisfied(town.dir, sunDirection, quest.window)) continue;
        settle(quest);
      }
    }

    /*
     * Chart goals. Read once per frame whatever else is going on, because
     * coverage moves while the ship sails rather than on an event.
     */
    const chart = deps.chart();
    if (chart !== null) {
      const coverage = chart.coverage();
      for (const quest of Array.from(active)) {
        if (quest.kind !== 'CHART' || quest.coverage === null) continue;
        if (coverage >= quest.coverage) {
          settle(quest);
          continue;
        }
        // One announcement per whole step, and the step is measured from the
        // last one announced rather than from zero, so a goal loaded mid-run
        // does not fire a burst of them on its first frame.
        const step = Math.floor(coverage / CHART_PROGRESS_STEP);
        const last = announced.get(quest.id);
        if (last === undefined) {
          announced.set(quest.id, step);
          continue;
        }
        if (step > last) {
          announced.set(quest.id, step);
          emit({ kind: 'progress', quest, fraction: coverage });
        }
      }
    }

    // Expiry last, for the reason the file comment gives: a contract that
    // arrived on the frame its clock ran out has already been settled above.
    for (const quest of Array.from(active)) {
      if (quest.remaining !== null && quest.remaining <= 0) fail(quest.id, 'expired');
    }
  }

  return {
    get active(): readonly ActiveQuest[] {
      return active;
    },
    get day(): number {
      return worldDay;
    },
    offers,
    accept,
    abandon: (id: string): boolean => fail(id, 'abandoned'),
    update,
    on(fn: (event: QuestEvent) => void): () => void {
      listeners.add(fn);
      return (): void => {
        listeners.delete(fn);
      };
    },
    snapshot(): readonly ActiveQuest[] {
      return active.map((quest) => Object.freeze({ ...quest }));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Exported for the views and the tests                                */
/* ------------------------------------------------------------------ */

export {
  arcBetween,
  daylightLeft,
  formatDeadline,
  formatSpan,
  tierForArc,
  windowReachable,
  windowSatisfied,
};
