import type {
  FishState,
  FishingEvent,
  FishingInput,
  FishingState,
  HarpoonPhase,
  Species,
  Tier,
} from './types';
import { ROW_COUNT, rollSpecies, tierInfo } from './species';

/**
 * fishsim.ts — the fishing ruleset, in card units.
 *
 * See `docs/FISHING_PLAN.md`. No DOM, no canvas, no clock of its own: `dt` and
 * `press` come in, a `FishingState` comes out, and every quantity is in card
 * units so the renderer can scale to any card size without the rules changing.
 *
 * Every tuning number below is a first-pass balance figure and is expected to
 * move, so each one is a named constant carrying what the player feels when it
 * changes — the same standard `energy.ts` holds itself to. A retune should be
 * an edit in this block and nowhere else.
 */
export interface FishingSim {
  /** Live, mutated in place. Hold the reference; never copy it. */
  readonly state: FishingState;
  update(dt: number, input: FishingInput): void;
  /** Ends the session now (Escape). Raises `ended` with reason 'abort'. */
  abort(): void;
}

/* ------------------------------------------------------------------ */
/* The session                                                         */
/* ------------------------------------------------------------------ */

/**
 * Seconds on the clock.
 *
 * Short on purpose. A session costs half the tank, so it has to be a decision
 * rather than a pastime: 30 s is about eight considered shots at the swing's
 * 2.4 s period, which is the whole budget spent if every one of them is aimed.
 */
export const SESSION_SECONDS = 30;

/**
 * Harpoons per session.
 *
 * Deliberately fewer shots than the clock comfortably allows, so the binding
 * constraint is usually the player's patience and not the timer. Whichever
 * runs out first ends the session; ten is the number that makes a wasted shot
 * cost something.
 */
export const SESSION_SHOTS = 10;

/**
 * Longest frame the sim will integrate, seconds.
 *
 * Same clamp and same reason as `energy.ts`: a backgrounded tab hands back a
 * `dt` of whole seconds, and without this the harpoon would teleport through
 * every row in one step and the clock would lose a third of the session in a
 * frame. `main.ts` already clamps to 0.1; this is here so the sim is correct
 * when driven by anything else, a probe included.
 */
const MAX_FRAME = 0.1;

/* ------------------------------------------------------------------ */
/* Geometry — card units                                               */
/* ------------------------------------------------------------------ */

/*
 * x runs [0, 1] across the card and y runs [0, CARD_HEIGHT] DOWN from its top.
 * These are exported because `fishrender.ts` draws against exactly the same
 * numbers: copying them into the renderer is how the picture and the rules
 * start to disagree about where the water is.
 */

/** The card is 9:16, so it is 16/9 units tall for its 1 unit of width. */
export const CARD_HEIGHT = 16 / 9;

/** Sea level. Everything above is sky and boat; every fish is below. */
export const WATERLINE = 0.28;

/** The harpoon pivots here, just under the hull. */
export const PIVOT_X = 0.5;
export const PIVOT_Y = 0.3;

/**
 * Depth of each row's centre line.
 *
 * Evenly spaced at 0.23, which is the spacing that fits five rows between the
 * waterline and the bottom of the card with a margin at each end. The gap is
 * larger than twice the band half-height below, so no two rows overlap and a
 * harpoon threading row 1 has clear water before it reaches row 2.
 */
export const ROW_CENTRES: readonly number[] = [0.55, 0.78, 1.01, 1.24, 1.47];

/**
 * Half-height of the water a row's fish may occupy, card units.
 *
 * The band is what makes a row read as a shoal rather than a conveyor belt:
 * fish take a fixed depth anywhere inside it when they spawn and then bob
 * around that depth. Widen it and the rows start to merge; narrow it and a
 * row becomes a single line a shot either hits or misses entirely.
 */
export const ROW_BAND_HALF = 0.09;

/**
 * How far a fish rises and falls about its own depth, card units.
 *
 * Small — this is idle motion, not evasion. Held clear of ROW_BAND_HALF when
 * the spawn depth is drawn, so a bobbing fish never leaves its band and never
 * strays into the neighbouring row's water.
 */
const BOB_AMPLITUDE = 0.02;

/** Radians per second of the bob, drawn per fish so a shoal is not a chorus. */
const BOB_RATE_MIN = 1.2;
const BOB_RATE_MAX = 2.2;

/**
 * Length of an average fish, card units, before `Species.size`.
 *
 * 0.06 is a sixteenth of the card's width, so the biggest legendary (size 2.2)
 * spans an eighth of the card and the smallest anchovy (0.5) a thirty-second.
 * It drives the hit box as well as the sprite, which is the small mercy that
 * keeps the top tiers from being pure luck: a bigger prize is a bigger target.
 */
export const BASE_FISH_LENGTH = 0.06;

/**
 * The hit ellipse, as fractions of the fish's own length.
 *
 * Half the length across and a quarter of it deep — a fish shape, not a disc,
 * so a harpoon coming down almost vertically has to be right along the fish
 * rather than merely near it. The renderer draws the sprite at the full
 * length, so the box is slightly inside the picture and a hit always looks
 * like one.
 */
const HIT_HALF_WIDTH = 0.5;
const HIT_HALF_HEIGHT = 0.25;

/* ------------------------------------------------------------------ */
/* The harpoon                                                         */
/* ------------------------------------------------------------------ */

/**
 * Widest the swing goes either side of straight down, radians (60 degrees).
 *
 * The reachable water is what this number buys. At 60 degrees the tip leaves
 * through the side of the card rather than the bottom, so the deep rows are
 * only available near the middle of the swing — which is the timing the whole
 * risk curve is built on.
 */
const SWING_MAX_ANGLE = (60 * Math.PI) / 180;

/**
 * Seconds for one full left-right-left sweep.
 *
 * 2.4 s is a beat a player can count. Faster and aiming becomes reflex rather
 * than timing; slower and the ten shots would not fit inside the 30 seconds.
 */
const SWING_PERIOD = 2.4;

/**
 * Card units per second on the way out.
 *
 * 1.6 crosses the whole 1.78-unit card in about a second, so a shot at row 5
 * is a second of committed flight — long enough that the shallow rows drift
 * across the line while the harpoon is in it, which is what makes threading
 * the deep water a real shot rather than an aimed one.
 */
const HARPOON_SPEED_OUT = 1.6;

/**
 * Card units per second coming back empty.
 *
 * Half again as fast as the shot, because a miss is already the punishment
 * and making the player watch it come home slowly punishes twice.
 */
const HARPOON_SPEED_BACK = 2.4;

/**
 * Longest step the flying tip may take between hit tests, card units.
 *
 * The smallest hit box in the game is half a tinscale anchovy's depth:
 * 0.06 x 0.5 x 0.25 = 0.0075 units. A frame of flight is up to 0.16 units, so
 * testing once per frame would shoot straight through most of the catalogue.
 * The tip therefore marches in steps under half that smallest box and tests at
 * each one, which makes a hit a fact about the path and not about the frame
 * rate.
 */
const HIT_STEP = 0.003;

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/**
 * Which way each row runs. Alternating, so the picture never reads as one
 * current, and a shot into row 5 has to cross traffic going both ways.
 */
const ROW_DIRS: readonly (1 | -1)[] = [1, -1, 1, -1, 1];

/**
 * Base speed per row, card units per second, before `Species.speed`.
 *
 * Slowing with depth, which is the other half of the risk curve: the good
 * water is easier to lead but harder to reach, so a deep shot is paid for in
 * patience rather than in reflexes. Row 1 crosses the card in 4.5 s, row 5 in
 * 12.5 — and a legendary's own 0.5-0.9 multiplier can stretch that past 20.
 */
const ROW_SPEEDS: readonly number[] = [0.22, 0.16, 0.13, 0.1, 0.08];

/**
 * How many fish a row keeps alive.
 *
 * Thinning with depth so the deep rows stay a wait rather than a queue: row 1
 * is busy enough to be in the way of every shot, row 5 sparse enough that the
 * legendary in it is an event. The minimum is a floor the row refills as fast
 * as spacing allows; the maximum is what the drip-feed timer below tops it up
 * to when there is nothing urgent to do.
 *
 * Rows 1 and 2 carry three times and twice their first-pass populations. That
 * is the shallow traffic getting much heavier, which is exactly the cost the
 * risk curve is built on: a shot at the deep rows now has three ranks of
 * common fish to thread instead of one, and the shallow water is close enough
 * to a wall that volume fishing barely needs aiming.
 */
const ROW_MIN: readonly number[] = [6, 4, 2, 2, 1];
const ROW_MAX: readonly number[] = [12, 8, 3, 3, 3];

/**
 * Closest two fish on one row may ever be, card units between centres.
 *
 * 0.18 — three average fish lengths — is the figure the rules were authored
 * around: a row cannot present a solid wall the player could not miss, and a
 * spawn never appears inside the fish already standing at the edge.
 *
 * It has to be per-row now, because it is also a hard cap on population. The
 * card is one unit wide, so at 0.18 no row can ever hold more than six fish
 * however high ROW_MAX is set — a row asked for twelve would simply spawn,
 * fail `hasRoom`, and retry forever while sitting at six. Rows 1 and 2 divide
 * the gap by the same 3x and 2x their populations were multiplied by, so the
 * water gets denser in exactly the proportion asked for rather than jamming
 * against a constant that was never part of the request. Row 1's 0.06 is one
 * average fish length between centres: shoulder to shoulder, still not
 * overlapping.
 */
const SPAWN_MIN_GAP: readonly number[] = [0.06, 0.09, 0.18, 0.18, 0.18];

/**
 * Seconds between top-up spawns while a row is between its min and max.
 *
 * A row under its minimum ignores this entirely and refills the moment there
 * is room; this is only the drip that carries a row up toward a full house.
 * Randomised so the five rows never fall into step with each other.
 */
const SPAWN_INTERVAL_MIN = 1.5;
const SPAWN_INTERVAL_MAX = 3.5;

/**
 * Tries the opening fill gets per fish before it gives up on a row.
 *
 * The card opens FULL rather than empty. A session costs half the tank and
 * runs 30 s, and a player who spent it watching fish trickle in from the edge
 * for the first four seconds has been charged for water. Placements are drawn
 * uniformly across the card and rejected against SPAWN_MIN_GAP, so a row ends
 * up somewhere between its min and its max depending on how the draw fell.
 *
 * 24 rather than the original 12 because row 1 now seeds twelve fish into a
 * card that fits at most sixteen at its gap. The last few placements are
 * drawing into water that is nearly full, and at twelve tries the row would
 * routinely open several fish short of a shoal it can perfectly well hold.
 */
const SEED_TRIES = 24;

/* ------------------------------------------------------------------ */
/* Reeling and the struggle                                            */
/* ------------------------------------------------------------------ */

/**
 * Seconds to haul a hooked fish back to the boat, indexed by tier. [0] unused.
 *
 * Tiers 1-3 follow `1.0 + 0.3 x tier`: a common fish is aboard in 1.3 s and
 * the harpoon is swinging again, which is what keeps the shallow water a
 * volume game. Tier 4 lands on 2.2 s by the same formula.
 *
 * Tier 5 is 2.8 s and NOT the 2.5 s the formula gives. That is the plan's
 * table and it is deliberate: the longest fight in the game is the one worth
 * 250-320 gold, and at 0.60 tension a second it is the fight that most needs
 * the extra half-second of tapping to feel like a fight at all.
 */
const REEL_SECONDS: readonly number[] = [0, 1.3, 1.6, 1.9, 2.2, 2.8];

/**
 * Tension the line holds the instant a fighting fish is hooked. [0] unused.
 *
 * Under a full bar for both tiers, so the player starts behind and has to tap
 * to catch up rather than merely to hold on. Tier 5 starts lower AND drains
 * faster, so the legendary is losing ground from the first frame.
 */
const HOOK_TENSION: readonly number[] = [0, 0, 0, 0, 0.6, 0.5];

/**
 * Tension lost per second while a fighting fish is on the line. [0] unused.
 *
 * These are the whole difficulty of the top tiers. Untouched, a tier 4 line
 * snaps 1.33 s after the hook and a tier 5 in 0.83 s — both well inside their
 * own reel times, so neither can ever be landed by watching.
 */
const TENSION_DRAIN: readonly number[] = [0, 0, 0, 0, 0.45, 0.6];

/**
 * Tension recovered per press, the same for both fighting tiers.
 *
 * One number rather than two because the difficulty is authored in the drain:
 * 0.12 against those rates asks for 3.8 taps a second to hold a tier 4 steady
 * and 5.0 for a tier 5. That is the gap between "fast" and "as fast as you
 * can", and it is what the two bands are meant to feel like.
 */
const TENSION_GAIN = 0.12;

/* ------------------------------------------------------------------ */
/* Internal, mutable mirrors of the read-only state surface            */
/* ------------------------------------------------------------------ */

interface MutableFish {
  species: Species;
  row: number;
  x: number;
  y: number;
  dir: 1 | -1;
  hooked: boolean;
  /** Depth held inside the band, card units from the row centre. */
  depth: number;
  /** Phase and rate of this fish's own bob, so a shoal is not a chorus. */
  bobPhase: number;
  bobRate: number;
}

interface MutableHarpoon {
  phase: HarpoonPhase;
  angle: number;
  tipX: number;
  tipY: number;
  hooked: MutableFish | null;
  struggling: boolean;
  tension: number;
}

interface MutableFishingState {
  timeLeft: number;
  shotsLeft: number;
  fish: MutableFish[];
  harpoon: MutableHarpoon;
  caught: Species[];
  goldEarned: number;
  over: boolean;
  events: FishingEvent[];
}

/* ------------------------------------------------------------------ */
/* The simulation                                                      */
/* ------------------------------------------------------------------ */

/**
 * One fishing session: a clock, ten harpoons, five rows of fish and a rope.
 *
 * `rng` is injected and every random draw in the file goes through it —
 * species, spawn depth, spawn timing, bob — so a seeded run replays exactly.
 * That is what makes the odds and the struggle testable without a browser;
 * calling `Math.random` anywhere below would quietly take that away.
 */
export function createFishingSim(rng: () => number = Math.random): FishingSim {
  const harpoon: MutableHarpoon = {
    phase: 'swinging',
    angle: 0,
    tipX: PIVOT_X,
    tipY: PIVOT_Y,
    hooked: null,
    struggling: false,
    tension: 0,
  };

  const state: MutableFishingState = {
    timeLeft: SESSION_SECONDS,
    shotsLeft: SESSION_SHOTS,
    fish: [],
    harpoon,
    caught: [],
    goldEarned: 0,
    over: false,
    events: [],
  };

  /** Seconds of session elapsed. Drives the bob, and nothing else. */
  let clock = 0;

  /**
   * Seconds the harpoon has spent swinging, which is NOT the session clock.
   *
   * It stops while the rope is out, so the swing resumes from exactly the
   * angle it fired at instead of teleporting to wherever a free-running phase
   * had got to during the flight.
   */
  let swingClock = 0;

  /** Seconds until each row's next top-up spawn. Negative means "as soon as". */
  const spawnTimers: number[] = [];

  /** Progress of the current haul, seconds, against REEL_SECONDS[tier]. */
  let reelElapsed = 0;
  let reelDuration = 0;
  /** Where the hook went in, so the tip can be walked home along the shot. */
  let hookX = PIVOT_X;
  let hookY = PIVOT_Y;

  /**
   * Why the session is going to end, decided the moment either budget runs
   * out and held until the rope is home. First to zero wins: firing the tenth
   * harpoon with ten seconds left is a session that ended on shots, however
   * long the fight afterwards takes.
   */
  let pendingEnd: 'time' | 'shots' | null = null;

  /* ---------------------------------------------------------------- */
  /* Fish                                                              */
  /* ---------------------------------------------------------------- */

  function nextSpawnInterval(): number {
    return SPAWN_INTERVAL_MIN + rng() * (SPAWN_INTERVAL_MAX - SPAWN_INTERVAL_MIN);
  }

  /** Where a fish sits right now: its held depth plus its own bob. */
  function fishY(f: MutableFish): number {
    return ROW_CENTRES[f.row] + f.depth + Math.sin(f.bobPhase + clock * f.bobRate) * BOB_AMPLITUDE;
  }

  /** Half the fish's length, card units — its own margin off either edge. */
  function halfLength(species: Species): number {
    return BASE_FISH_LENGTH * species.size * 0.5;
  }

  /**
   * Whether a fish may be put down at `x` on `row`.
   *
   * A hooked fish is out of the water as far as its row is concerned, so it
   * neither blocks a spawn nor counts toward the population.
   */
  function hasRoom(row: number, x: number): boolean {
    for (const f of state.fish) {
      if (f.row !== row || f.hooked) continue;
      if (Math.abs(f.x - x) < SPAWN_MIN_GAP[row]) return false;
    }
    return true;
  }

  function countAlive(row: number): number {
    let n = 0;
    for (const f of state.fish) if (f.row === row && !f.hooked) n++;
    return n;
  }

  function addFish(row: number, x: number, species: Species): MutableFish {
    // Held clear of the bob so the sum can never leave the row's band.
    const depth = (rng() * 2 - 1) * (ROW_BAND_HALF - BOB_AMPLITUDE);
    const f: MutableFish = {
      species,
      row,
      x,
      y: 0,
      dir: ROW_DIRS[row],
      hooked: false,
      depth,
      bobPhase: rng() * Math.PI * 2,
      bobRate: BOB_RATE_MIN + rng() * (BOB_RATE_MAX - BOB_RATE_MIN),
    };
    f.y = fishY(f);
    state.fish.push(f);
    return f;
  }

  /**
   * Tries to put one new fish just off the edge its row enters from.
   *
   * Returns false when the fish already standing at that edge is inside
   * SPAWN_MIN_GAP, in which case the caller simply asks again next frame — a
   * row under its minimum refills the instant there is room for it.
   */
  function trySpawn(row: number): boolean {
    const species = rollSpecies(row, rng);
    const off = halfLength(species);
    const x = ROW_DIRS[row] === 1 ? -off : 1 + off;
    if (!hasRoom(row, x)) return false;
    addFish(row, x, species);
    return true;
  }

  /** Opens the card with the water already busy. See SEED_TRIES. */
  function seedRows(): void {
    for (let row = 0; row < ROW_COUNT; row++) {
      for (let i = 0; i < ROW_MAX[row]; i++) {
        for (let attempt = 0; attempt < SEED_TRIES; attempt++) {
          const species = rollSpecies(row, rng);
          const x = rng();
          if (!hasRoom(row, x)) continue;
          addFish(row, x, species);
          break;
        }
      }
      spawnTimers[row] = nextSpawnInterval();
    }
  }

  function removeFish(f: MutableFish): void {
    const i = state.fish.indexOf(f);
    if (i >= 0) state.fish.splice(i, 1);
  }

  function moveFish(dt: number): void {
    for (let i = state.fish.length - 1; i >= 0; i--) {
      const f = state.fish[i];
      // A hooked fish is on the rope: the harpoon writes its position, not the
      // row, and it must not despawn off an edge it is being dragged away from.
      if (f.hooked) continue;
      f.x += f.dir * ROW_SPEEDS[f.row] * f.species.speed * dt;
      f.y = fishY(f);
      const off = halfLength(f.species);
      if (f.dir === 1 ? f.x > 1 + off : f.x < -off) state.fish.splice(i, 1);
    }
  }

  function spawnFish(dt: number): void {
    for (let row = 0; row < ROW_COUNT; row++) {
      spawnTimers[row] -= dt;
      const alive = countAlive(row);
      if (alive >= ROW_MAX[row]) continue;
      const urgent = alive < ROW_MIN[row];
      if (!urgent && spawnTimers[row] > 0) continue;
      // An urgent spawn does not reset the drip-feed timer: refilling a row
      // that has emptied out is not the same event as topping one up, and
      // charging the top-up for it would leave the row thin twice over.
      if (trySpawn(row) && !urgent) spawnTimers[row] = nextSpawnInterval();
    }
  }

  /* ---------------------------------------------------------------- */
  /* The harpoon                                                       */
  /* ---------------------------------------------------------------- */

  /** The fish whose ellipse contains this point, nearest the pivot first. */
  function fishAt(x: number, y: number): MutableFish | null {
    let best: MutableFish | null = null;
    let bestDist = Infinity;
    for (const f of state.fish) {
      if (f.hooked) continue;
      const len = BASE_FISH_LENGTH * f.species.size;
      const hw = len * HIT_HALF_WIDTH;
      const hh = len * HIT_HALF_HEIGHT;
      const dx = (x - f.x) / hw;
      const dy = (y - f.y) / hh;
      if (dx * dx + dy * dy > 1) continue;
      // Two rows can never overlap, but two fish on one row can be inside one
      // sample of each other's boxes. The nearer one is the one the tip
      // reached first, which is the fish the plan says gets hooked.
      const px = f.x - PIVOT_X;
      const py = f.y - PIVOT_Y;
      const dist = px * px + py * py;
      if (dist < bestDist) {
        bestDist = dist;
        best = f;
      }
    }
    return best;
  }

  function onCard(x: number, y: number): boolean {
    return x >= 0 && x <= 1 && y <= CARD_HEIGHT;
  }

  function fire(): void {
    state.shotsLeft--;
    harpoon.phase = 'flying';
    harpoon.tipX = PIVOT_X;
    harpoon.tipY = PIVOT_Y;
    state.events.push({ kind: 'fired', shotsLeft: state.shotsLeft });
  }

  function hook(f: MutableFish): void {
    f.hooked = true;
    harpoon.hooked = f;
    harpoon.phase = 'reeling';
    hookX = harpoon.tipX;
    hookY = harpoon.tipY;
    reelElapsed = 0;
    reelDuration = REEL_SECONDS[f.species.tier];
    const fights = tierInfo(f.species.tier).struggles;
    harpoon.struggling = fights;
    harpoon.tension = fights ? HOOK_TENSION[f.species.tier] : 0;
    state.events.push({ kind: 'hooked', fish: f as FishState });
  }

  function land(f: MutableFish): void {
    removeFish(f);
    state.caught.push(f.species);
    state.goldEarned += f.species.gold;
    state.events.push({
      kind: 'caught',
      species: f.species,
      gold: f.species.gold,
      // Where the fish came aboard, so the renderer floats the "+N" off the
      // boat rather than off the water the shot started in.
      x: harpoon.tipX,
      y: harpoon.tipY,
    });
    releaseRope();
    harpoon.phase = 'swinging';
    harpoon.tipX = PIVOT_X;
    harpoon.tipY = PIVOT_Y;
  }

  function snap(f: MutableFish): void {
    // The fish takes the shot with it: it is gone from the water, not merely
    // unhooked, so a player cannot re-fire at the legendary that just beat
    // them and the escape reads as a loss.
    removeFish(f);
    state.events.push({ kind: 'escaped', species: f.species });
    releaseRope();
    harpoon.phase = 'retracting';
  }

  function releaseRope(): void {
    harpoon.hooked = null;
    harpoon.struggling = false;
    harpoon.tension = 0;
  }

  function swing(dt: number, press: boolean): void {
    swingClock += dt;
    harpoon.angle = SWING_MAX_ANGLE * Math.sin((Math.PI * 2 * swingClock) / SWING_PERIOD);
    harpoon.tipX = PIVOT_X;
    harpoon.tipY = PIVOT_Y;
    // Neither budget may be overdrawn. Once either is out the swing carries on
    // for the frame it takes the session to end, but it cannot be spent.
    if (press && state.timeLeft > 0 && state.shotsLeft > 0) fire();
  }

  function fly(dt: number): void {
    const dx = Math.sin(harpoon.angle);
    const dy = Math.cos(harpoon.angle);
    const travel = HARPOON_SPEED_OUT * dt;
    // Marched rather than stepped: see HIT_STEP.
    const steps = Math.max(1, Math.ceil(travel / HIT_STEP));
    const step = travel / steps;
    for (let i = 0; i < steps; i++) {
      harpoon.tipX += dx * step;
      harpoon.tipY += dy * step;
      const f = fishAt(harpoon.tipX, harpoon.tipY);
      if (f) {
        hook(f);
        return;
      }
      if (!onCard(harpoon.tipX, harpoon.tipY)) {
        harpoon.phase = 'retracting';
        state.events.push({ kind: 'missed' });
        return;
      }
    }
  }

  function reel(dt: number, press: boolean): void {
    const f = harpoon.hooked;
    if (!f) {
      // Cannot happen; if it ever did, an empty rope hauling nothing home is
      // the harmless outcome rather than a fish stuck to the boat.
      harpoon.phase = 'retracting';
      return;
    }

    if (harpoon.struggling) {
      // The press lands BEFORE the drain, so a tap on the frame the line would
      // otherwise part still saves it. The player pressed inside that frame;
      // charging them for the order the sim happens to run in is a loss they
      // cannot see coming.
      if (press) harpoon.tension = Math.min(1, harpoon.tension + TENSION_GAIN);
      harpoon.tension -= TENSION_DRAIN[f.species.tier] * dt;
      if (harpoon.tension <= 0) {
        harpoon.tension = 0;
        snap(f);
        return;
      }
    }

    reelElapsed += dt;
    const t = reelDuration > 0 ? Math.min(1, reelElapsed / reelDuration) : 1;
    // Straight back down the shot, so the rope stays a single line at the
    // angle it was fired at and the renderer needs no second geometry.
    harpoon.tipX = hookX + (PIVOT_X - hookX) * t;
    harpoon.tipY = hookY + (PIVOT_Y - hookY) * t;
    f.x = harpoon.tipX;
    f.y = harpoon.tipY;
    if (t >= 1) land(f);
  }

  function retract(dt: number): void {
    const dx = PIVOT_X - harpoon.tipX;
    const dy = PIVOT_Y - harpoon.tipY;
    const dist = Math.hypot(dx, dy);
    const travel = HARPOON_SPEED_BACK * dt;
    if (dist <= travel || dist === 0) {
      harpoon.tipX = PIVOT_X;
      harpoon.tipY = PIVOT_Y;
      harpoon.phase = 'swinging';
      return;
    }
    harpoon.tipX += (dx / dist) * travel;
    harpoon.tipY += (dy / dist) * travel;
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  function update(dt: number, input: FishingInput): void {
    // The event list is this frame's outbox, not simulation state: it is
    // emptied at the top of EVERY update and refilled as the frame runs, so
    // no event can ever be delivered twice. That matters more than it sounds:
    // `fishing.ts` banks gold off `caught`, and an event left standing for a
    // consumer that kept calling `update` would pay for the same fish every
    // frame. `types.ts` states the other half of the deal — read the list in
    // the same frame or lose it. `over` is the durable fact; the `ended`
    // event is only the notice.
    state.events.length = 0;
    if (state.over) return;

    // A frame that advanced no time changes nothing — the same guard, and the
    // same reason, as `energy.ts`. Falling through would still bob the fish
    // and re-derive the swing from an unmoved clock.
    if (!(dt > 0)) return;
    if (dt > MAX_FRAME) dt = MAX_FRAME;

    clock += dt;
    state.timeLeft -= dt;
    if (state.timeLeft < 0) state.timeLeft = 0;

    moveFish(dt);
    spawnFish(dt);

    const press = input.press;
    switch (harpoon.phase) {
      case 'swinging':
        swing(dt, press);
        break;
      case 'flying':
        fly(dt);
        break;
      case 'reeling':
        reel(dt, press);
        break;
      case 'retracting':
        retract(dt);
        break;
    }

    if (pendingEnd === null) {
      if (state.timeLeft <= 0) pendingEnd = 'time';
      else if (state.shotsLeft <= 0) pendingEnd = 'shots';
    }

    // The rope has to be home first. A fish hooked on the buzzer is landed —
    // struggle and all — because the shot was paid for before the budget ran
    // out, and taking it away at the moment of the catch is the one ending
    // that would read as the game cheating.
    if (pendingEnd !== null && harpoon.phase === 'swinging') {
      state.over = true;
      state.events.push({ kind: 'ended', reason: pendingEnd });
    }
  }

  /**
   * Escape. Ends the session where it stands, hooked fish included.
   *
   * The list is cleared rather than appended to: this runs from a key handler
   * and not from a frame, so whatever is still sitting in the outbox has
   * already been banked by `fishing.ts` and leaving it there to be drained a
   * second time would pay for the same catch twice.
   *
   * The `ended` it raises obeys the same one-frame rule as every other event:
   * read it before the next `update` or lose it. Nothing depends on catching
   * it, because `over` is already true the instant this returns and that is
   * the fact the card actually reads.
   */
  function abort(): void {
    if (state.over) return;
    const f = harpoon.hooked;
    if (f) f.hooked = false;
    releaseRope();
    harpoon.phase = 'swinging';
    harpoon.tipX = PIVOT_X;
    harpoon.tipY = PIVOT_Y;
    state.over = true;
    state.events.length = 0;
    state.events.push({ kind: 'ended', reason: 'abort' });
  }

  seedRows();

  return { state: state as FishingState, update, abort };
}

/**
 * Seconds a hooked fish of this tier takes to reach the boat.
 *
 * Exported so the renderer can size the tension bar's drain against the fight
 * it is actually drawing rather than against a copy of the table.
 */
export function reelSeconds(tier: Tier): number {
  return REEL_SECONDS[tier];
}
