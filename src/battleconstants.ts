/**
 * battleconstants.ts — the numbers the cannon fight is built out of.
 *
 * Split out of `battle.ts` by the rework so that `battleai.ts` and
 * `battlesea.ts` can read the ring's dimensions without importing the module
 * that imports them. Nothing here is logic; every one of these is a tuning
 * decision with the reasoning attached, and `battle.ts` re-exports the lot so
 * that every existing importer keeps working.
 *
 * The brief is docs/BATTLE_PLAN.md for the fight and
 * docs/BATTLE_REWORK_PLAN.md for what the rework moved. Read both before
 * retuning anything here.
 *
 * The AI's own constants are NOT here. They live in `battleai.ts`, because
 * they describe a gunner rather than an arena and nothing else has any
 * business reading them.
 */

/**
 * The circle: where it starts, where it stops, and how fast it closes, in
 * arena units and units/s.
 *
 * Twenty units across the diameter is a ball flight of nearly a second at
 * BALL_SPEED, which is long enough that the lead is a real judgement. Eight is
 * the point where two 3.1-unit hulls are close enough to read each other's
 * damage. Half a minute to cross that gap is slow enough not to be noticed as
 * motion and fast enough that a fight which is going nowhere still ends up
 * somewhere.
 */
export const ARENA_R0 = 20;
export const ARENA_R_MIN = 8;
export const ARENA_SHRINK = 0.4;

/**
 * How fast the boats go round, authored as a tangential speed at the opening
 * radius and divided out into the angular rate that is actually integrated.
 *
 * Written this way for the same reason `ship.ts` derives `ACCEL` from
 * `MAX_FORWARD`: six units a second at twenty units of radius is a fact about
 * how fast the hulls look like they are moving, and 0.3 rad/s is only the
 * consequence. The RATE is what is held constant as the circle shrinks, so the
 * boats visibly slow as they close and the fight tightens rather than
 * spinning up.
 */
export const ARENA_SPEED = 6;
export const ARENA_OMEGA = ARENA_SPEED / ARENA_R0;

/**
 * How much W and S move a boat's angular speed, as a fraction of ARENA_OMEGA.
 *
 * Half. The separation between the two hulls therefore drifts by up to 0.15
 * rad/s, so a player can pull a third of the way off the diameter in two
 * seconds and put themselves back on it in two more. Much less and the
 * throttle does not feel connected to anything; much more and the fight
 * becomes a race rather than a duel.
 */
export const THROTTLE_GAIN = 0.5;

/**
 * Hits that end the AI's fight. Three, as it always was.
 *
 * It used to be BOTH sides' number, and the value has not moved -- only its
 * meaning has. The player's threshold is read off `hull.ts` at the moment of
 * contact and is 3, 2 or 1 (docs/HARBOURS_PLAN.md, decision 19), so it
 * travels on the `Combatant` rather than living here; `battle.ts` settles each
 * side against its own. This constant is now the raider's alone, and the AI
 * has no hull of its own by design -- the durability system is the player's
 * problem, not a stat block for the world.
 *
 * It is still the DEFAULT for `createBattleSim`'s `playerHitsToLose` and the
 * default the rules card and the player's pip strip fall back to, so a caller
 * that knows nothing about hulls -- every unit case in
 * `tests/unit/battle.test.ts` bar one, and `?battle=1` before `main.ts` is
 * wired -- gets the fight exactly as it was.
 */
export const HITS_TO_LOSE = 3;

/**
 * Seconds between shots from one side: three a second, and the locker is
 * bottomless.
 *
 * Both halves of that are one decision. There used to be ten rounds a side at
 * one a second, and the two numbers were holding each other up: the cooldown
 * existed to make a locker last, and the locker existed to stop a fight being
 * decided in the first three seconds. Take the locker away and the cooldown
 * has only its own job left, which is to keep a shot a decision rather than a
 * held key -- a third of a second is still four ball-flights of the arena at
 * BALL_SPEED, so a gunner who fires the moment the gun is cold is throwing
 * rounds at where the hull was, not where it will be.
 *
 * What this changes about the fight: it can no longer end because both sides
 * ran out of ammunition, and `battle.ts`'s `settle` lost that draw rule with
 * it. A stand-off now ends on BATTLE_TIMEOUT and nowhere else.
 */
export const FIRE_COOLDOWN = 1 / 3;

/**
 * The ball: how fast it flies, how long it may live, and how far past the far
 * side it travels before it is written off as a miss.
 *
 * **Forty-four is the rework's doubling**, and it halves the lead the shot
 * asks for: about fifteen degrees at the opening radius where it used to be
 * thirty, and six at the closing one where it was twelve. The fight reads
 * quicker and the ball is easier to follow, and the skill moves off the lead
 * and onto the two things the rework added, which are the sea and the
 * telegraph.
 *
 * BALL_LIFE came down with it, 4 to 2, and is a backstop and nothing more: at
 * this speed a ball has crossed the circle and cleared the splash margin in
 * well under a second, so the only balls it ever collects are ones a
 * shrinking radius has stranded.
 */
export const BALL_SPEED = 44;
export const BALL_LIFE = 2;
export const SPLASH_MARGIN = 3;

/**
 * How close a ball has to pass to a hull's centre to score, arena units.
 *
 * Half a hull length, on a centre-to-centre test, which is the same trade
 * `aiboats.ts`'s CONTACT_RADIUS makes and for the same reason. The test is
 * against the SEGMENT the ball swept this tick rather than the point it ended
 * on: at 44 units a second a tenth-of-a-second frame moves it 4.4 units, which
 * is nearly three times this radius, and a point test would let balls tunnel
 * straight through a hull on a slow machine. The doubling made that test
 * matter twice as much and is the reason it may never be simplified away.
 */
export const HIT_RADIUS = 1.6;

/**
 * Seconds a fight may run before it is called a draw.
 *
 * The world is frozen behind the arena and the power plant is still burning,
 * so a player who simply never fires may not hold the game there.
 *
 * Expect the rework to reach this more often than the old fight did: an AI
 * reading the player two seconds late, telegraphing every shot and being
 * shoved about by the sea misses a great deal more than its predecessor. That
 * is a known consequence and is deliberately NOT tuned away here; see
 * docs/BATTLE_REWORK_PLAN.md, "The prediction horizon, and the risk in it".
 */
export const BATTLE_TIMEOUT = 120;
