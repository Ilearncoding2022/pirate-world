import type { InputState } from './types';

/**
 * controls.ts — the only writer of InputState.
 *
 * Binds three input sources onto one shared snapshot:
 *   - keyboard (WASD + arrows, layout-robust via event.code)
 *   - the on-screen D-pad (#btn-up / #btn-down / #btn-left / #btn-right)
 *   - the mouse wheel / trackpad (accumulated into zoomDelta)
 *
 * Keyboard and pointer are tracked separately so releasing one source never
 * clears a hold from the other. The union drives both InputState and the
 * `.active` class on the D-pad buttons, so the pad lights up for WASD too.
 */

type Dir = 'forward' | 'backward' | 'left' | 'right';

const DIRS: Dir[] = ['forward', 'backward', 'left', 'right'];

const BUTTON_IDS: Record<Dir, string> = {
  forward: 'btn-up',
  backward: 'btn-down',
  left: 'btn-left',
  right: 'btn-right',
};

const KEY_MAP: Record<string, Dir> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

/** Arrow keys scroll the page by default — swallow them. */
const SCROLLING_KEYS: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
};

/** Wheel tuning. deltaMode 1 = lines, 2 = pages; normalize both to pixels. */
const PX_PER_LINE = 16;
const PX_PER_PAGE = 400;
const ZOOM_SCALE = 0.01;

export function createControls(): { input: InputState; endFrame(): void; dispose(): void } {
  const input: InputState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    zoomDelta: 0,
  };

  const keyHeld: Record<Dir, boolean> = {
    forward: false,
    backward: false,
    left: false,
    right: false,
  };
  const pointerHeld: Record<Dir, boolean> = {
    forward: false,
    backward: false,
    left: false,
    right: false,
  };

  // Missing ids must never throw — every use is null-guarded.
  const buttons: Record<Dir, HTMLElement | null> = {
    forward: document.getElementById(BUTTON_IDS.forward),
    backward: document.getElementById(BUTTON_IDS.backward),
    left: document.getElementById(BUTTON_IDS.left),
    right: document.getElementById(BUTTON_IDS.right),
  };

  const cleanups: Array<() => void> = [];

  function sync(dir: Dir): void {
    const held = keyHeld[dir] || pointerHeld[dir];
    input[dir] = held;
    const el = buttons[dir];
    if (el) el.classList.toggle('active', held);
  }

  function releaseAll(): void {
    for (const dir of DIRS) {
      keyHeld[dir] = false;
      pointerHeld[dir] = false;
      sync(dir);
    }
  }

  // ------------------------------------------------------------------
  // Keyboard
  // ------------------------------------------------------------------

  const onKeyDown = (event: KeyboardEvent): void => {
    const dir = KEY_MAP[event.code];
    if (dir === undefined) return;
    if (SCROLLING_KEYS[event.code]) event.preventDefault();
    if (keyHeld[dir]) return; // auto-repeat
    keyHeld[dir] = true;
    sync(dir);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    const dir = KEY_MAP[event.code];
    if (dir === undefined) return;
    if (SCROLLING_KEYS[event.code]) event.preventDefault();
    keyHeld[dir] = false;
    sync(dir);
  };

  // Alt-tabbing mid-press would otherwise leave a key stuck down forever.
  const onBlur = (): void => releaseAll();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  cleanups.push(() => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  });

  // ------------------------------------------------------------------
  // On-screen D-pad — held-down continuous input, not one-shot clicks
  // ------------------------------------------------------------------

  for (const dir of DIRS) {
    const el = buttons[dir];
    if (!el) continue;

    const onPointerDown = (event: PointerEvent): void => {
      // Stops focus scroll-into-view, text selection and touch scrolling.
      event.preventDefault();
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // Capture is best-effort; the pointerup/leave handlers still release.
      }
      pointerHeld[dir] = true;
      sync(dir);
    };

    const onPointerRelease = (event: PointerEvent): void => {
      try {
        if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
      } catch {
        // Already released or unsupported — nothing to undo.
      }
      pointerHeld[dir] = false;
      sync(dir);
    };

    // Never let a held button open a context menu / selection popup.
    const onContextMenu = (event: Event): void => event.preventDefault();

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerRelease);
    el.addEventListener('pointercancel', onPointerRelease);
    el.addEventListener('pointerleave', onPointerRelease);
    el.addEventListener('contextmenu', onContextMenu);

    cleanups.push(() => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerRelease);
      el.removeEventListener('pointercancel', onPointerRelease);
      el.removeEventListener('pointerleave', onPointerRelease);
      el.removeEventListener('contextmenu', onContextMenu);
      el.classList.remove('active');
    });
  }

  // ------------------------------------------------------------------
  // Wheel / trackpad zoom
  // ------------------------------------------------------------------

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    let px = event.deltaY;
    if (event.deltaMode === 1) px *= PX_PER_LINE;
    else if (event.deltaMode === 2) px *= PX_PER_PAGE;
    input.zoomDelta += px * ZOOM_SCALE;
  };

  window.addEventListener('wheel', onWheel, { passive: false });
  cleanups.push(() => window.removeEventListener('wheel', onWheel));

  return {
    input,

    /** Called by main.ts at the end of every frame, after camera.update. */
    endFrame(): void {
      input.zoomDelta = 0;
    },

    dispose(): void {
      releaseAll();
      for (const off of cleanups) off();
      cleanups.length = 0;
    },
  };
}
