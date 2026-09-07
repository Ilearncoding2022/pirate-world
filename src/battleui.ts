import type { AiBoatKind, BattleInput, BattleState, InputState } from './types';

/**
 * battleui.ts — the strip, the FIRE key and the result card.
 *
 * STUB. Agent C fills this in; see docs/BATTLE_PLAN.md, "battleui.ts".
 *
 * `isOpen` is a LIVE GETTER, not a latched flag, for the same reason the
 * fishing card's is: `main.ts` derives the frozen world from it every frame,
 * and a stale `false` would strand the game stopped. See **The pause
 * contract** in docs/ARCHITECTURE.md.
 */
export interface BattleUiDeps {
  /** The player pressed CONTINUE on the result card. `main.ts` applies the outcome and fades home. */
  onContinue: () => void;
}

export interface BattleUi {
  /** True from `open()` until CONTINUE. A live getter, never a stored boolean. */
  readonly isOpen: boolean;
  open(kind: AiBoatKind): void;
  close(): void;
  /** This tick's player intent: the fire edge plus the two throttle keys. */
  input(raw: InputState): BattleInput;
  update(state: BattleState): void;
}

export function createBattleUi(deps: BattleUiDeps): BattleUi {
  void deps;
  let open = false;

  return {
    get isOpen(): boolean {
      return open;
    },
    open(): void {
      open = true;
    },
    close(): void {
      open = false;
    },
    input(raw: InputState): BattleInput {
      return { fire: false, faster: raw.forward, slower: raw.backward };
    },
    update(): void {
      /* stub */
    },
  };
}
