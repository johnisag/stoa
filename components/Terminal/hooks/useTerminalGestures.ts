"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * #29 mobile terminal gestures — pure gesture math + a thin DOM wiring hook.
 *
 * Three gestures, mobile-only and disabled in select mode:
 *  - LONG-PRESS then DRAG moves the cursor: drag distance is translated into
 *    arrow-key sequences (one per character cell crossed) sent through the
 *    existing input path.
 *  - DOUBLE-TAP sends Tab (completion — the worst key to reach on a phone).
 *  - PINCH adjusts the font size (clamped FONT_SIZE_MIN..MAX), mirroring
 *    updateTerminalForMobile's fontSize → refresh → fit → resize dance.
 *
 * The gesture logic is a PURE reducer (gestureStep) over {x,y,t} samples so
 * the whole matrix — tap vs double-tap vs long-press thresholds, drag →
 * arrow-key counts, pinch clamping, multi-touch cancellation — is unit-
 * testable without a DOM (test/terminal-gestures.test.ts). The hook below
 * only translates TouchEvents into GestureEvents and applies the effects.
 *
 * Coexistence with touch-scroll.ts (which converts one-finger drags into
 * wheel events on .xterm-screen): our listeners run in the CAPTURE phase on
 * the terminal container, so an active cursor-drag or pinch stopPropagation()s
 * before touch-scroll ever sees the move. While a touch is still "pending" we
 * never swallow events, and TAP_SLOP_PX matches touch-scroll's 8px direction
 * threshold, so plain scrolling flows through exactly as before.
 */

// ---------------------------------------------------------------------------
// Pure gesture math (unit-tested — keep free of DOM/xterm references)
// ---------------------------------------------------------------------------

/** Hold this long without crossing TAP_SLOP_PX to arm the cursor-drag. */
export const LONG_PRESS_MS = 400;
/** A touch lifted within this window (and slop) counts as a tap. */
export const TAP_MAX_MS = 250;
/**
 * Movement budget before a touch stops being a tap/long-press candidate.
 * MUST stay <= touch-scroll's 8px direction threshold: once touch-scroll
 * starts scrolling, a long-press must no longer arm (no mid-scroll hijack) —
 * radial distance reaches 8 at or before either per-axis delta does.
 */
export const TAP_SLOP_PX = 8;
/** Max gap between a tap's lift and the next tap's touch-down. */
export const DOUBLE_TAP_MS = 300;
/** Max distance between the two taps of a double-tap. */
export const DOUBLE_TAP_SLOP_PX = 40;
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 24;
/** Hard cap on arrow keys emitted per move event (guards a bogus cell size). */
export const MAX_DRAG_CELLS = 120;

// Key sequences are BUILT via fromCharCode so no literal control bytes or
// escape-prone "backslash-x" literals live in this source file.
const ESC = String.fromCharCode(27);
export const ARROW_UP = ESC + "[A";
export const ARROW_DOWN = ESC + "[B";
export const ARROW_RIGHT = ESC + "[C";
export const ARROW_LEFT = ESC + "[D";
export const TAB_KEY = String.fromCharCode(9);

export interface TouchSample {
  x: number;
  y: number;
  /** Milliseconds on any monotonic clock (performance.now() in the wiring). */
  t: number;
}

export type GestureIntent = "tap" | "long-press" | "scroll" | "none";

/**
 * Classify a single-finger touch sequence at time endT.
 *  - Crossed the slop BEFORE the long-press armed → "scroll" (touch-scroll's
 *    territory); after → "long-press" (that movement is the cursor drag).
 *  - Stayed inside the slop: held >= LONG_PRESS_MS → "long-press"; lifted
 *    within TAP_MAX_MS → "tap"; the hesitant in-between → "none".
 */
export function detectGesture(
  samples: readonly TouchSample[],
  endT: number
): GestureIntent {
  const first = samples[0];
  if (!first) return "none";
  for (const s of samples) {
    if (Math.hypot(s.x - first.x, s.y - first.y) > TAP_SLOP_PX) {
      return s.t - first.t < LONG_PRESS_MS ? "scroll" : "long-press";
    }
  }
  const held = endT - first.t;
  if (held >= LONG_PRESS_MS) return "long-press";
  return held <= TAP_MAX_MS ? "tap" : "none";
}

/**
 * Double-tap window: the previous tap's LIFT vs this tap's touch-DOWN must be
 * within DOUBLE_TAP_MS and DOUBLE_TAP_SLOP_PX. Null prev (no tap history, or
 * it was consumed/broken by another gesture) is never a double-tap.
 */
export function isDoubleTap(
  prevTapEnd: TouchSample | null,
  tapStart: TouchSample
): boolean {
  if (!prevTapEnd) return false;
  const gap = tapStart.t - prevTapEnd.t;
  if (gap < 0 || gap > DOUBLE_TAP_MS) return false;
  return (
    Math.hypot(tapStart.x - prevTapEnd.x, tapStart.y - prevTapEnd.y) <=
    DOUBLE_TAP_SLOP_PX
  );
}

export interface DragKeys {
  /** Arrow-key sequence to send ("" when no whole cell was crossed). */
  sequence: string;
  /** Signed cells consumed horizontally (0 when vertical won dominance). */
  cellsX: number;
  /** Signed cells consumed vertically (0 when horizontal won dominance). */
  cellsY: number;
}

const clampCells = (n: number) =>
  Math.max(-MAX_DRAG_CELLS, Math.min(MAX_DRAG_CELLS, n));

/**
 * Translate a drag delta (px) into an arrow-key sequence, one key per whole
 * character cell crossed. Diagonal dominance: only the axis that crossed more
 * cells emits (ties go horizontal — the common cursor-editing direction), so
 * a sloppy diagonal drag doesn't zig-zag the cursor. Sub-cell deltas emit
 * nothing; the caller keeps the remainder by only advancing its anchor by the
 * consumed cells. Non-finite deltas or non-positive cell sizes are a no-op.
 */
export function dragToArrowKeys(
  dx: number,
  dy: number,
  cellW: number,
  cellH: number
): DragKeys {
  if (
    !(cellW > 0) ||
    !(cellH > 0) ||
    !Number.isFinite(dx) ||
    !Number.isFinite(dy)
  ) {
    return { sequence: "", cellsX: 0, cellsY: 0 };
  }
  let cellsX = clampCells(Math.trunc(dx / cellW));
  let cellsY = clampCells(Math.trunc(dy / cellH));
  if (cellsX === 0 && cellsY === 0) {
    return { sequence: "", cellsX: 0, cellsY: 0 };
  }
  if (Math.abs(cellsX) >= Math.abs(cellsY)) cellsY = 0;
  else cellsX = 0;
  const key =
    cellsX > 0
      ? ARROW_RIGHT
      : cellsX < 0
        ? ARROW_LEFT
        : cellsY > 0
          ? ARROW_DOWN
          : ARROW_UP;
  // One of cellsX/cellsY is 0 after dominance, so the sum IS the winner.
  return { sequence: key.repeat(Math.abs(cellsX + cellsY)), cellsX, cellsY };
}

/**
 * Map a pinch scale (current distance / start distance) onto a clamped font
 * size in px. Degenerate inputs (NaN / zero / negative) fall back to the
 * clamped base so a glitchy touch frame can never zero the font.
 */
export function pinchToFontSize(scale: number, base: number): number {
  const safeBase = Number.isFinite(base) && base > 0 ? base : 14;
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, Math.round(safeBase * safeScale))
  );
}

export type GesturePhase =
  | "idle"
  /** One finger down; could still become tap / long-press / scroll. */
  | "pending"
  /** Long-press armed: moves emit arrow keys. */
  | "drag"
  /** Two fingers: moves adjust the font size. */
  | "pinch"
  /** Handed off to touch-scroll; ignore everything until all fingers lift. */
  | "scroll"
  /** Cancelled mid-gesture; swallow everything until all fingers lift. */
  | "swallow";

export interface GestureState {
  phase: GesturePhase;
  /** Pending-phase movement history, bounded to [first, latest]. */
  samples: TouchSample[];
  /** Drag anchor: the position whose crossed cells were already emitted. */
  anchorX: number;
  anchorY: number;
  /** The previous completed tap (its lift), for the double-tap window. */
  lastTap: TouchSample | null;
  pinchStartDist: number;
  pinchBaseFont: number;
  /** Last font size this pinch emitted (dedupes set-font effects). */
  lastFont: number;
}

export function initialGestureState(): GestureState {
  return {
    phase: "idle",
    samples: [],
    anchorX: 0,
    anchorY: 0,
    lastTap: null,
    pinchStartDist: 0,
    pinchBaseFont: 0,
    lastFont: 0,
  };
}

export type GestureEvent =
  | {
      type: "down";
      x: number;
      y: number;
      t: number;
      /** Total touches on screen after this finger landed. */
      touches: number;
      /** Distance between the first two touches (touches >= 2 only). */
      dist?: number;
      /** Current terminal font size in px — the pinch baseline. */
      fontSize?: number;
    }
  | {
      type: "move";
      x: number;
      y: number;
      t: number;
      touches: number;
      dist?: number;
    }
  /** The wiring's long-press timer fired. */
  | { type: "long-press"; t: number }
  | {
      type: "up";
      t: number;
      /** Touches STILL on screen after this lift. */
      touches: number;
    }
  | { type: "cancel" };

export type GestureEffect =
  | { kind: "none" }
  /** Send key data (arrow sequence or Tab) through the terminal input path. */
  | { kind: "send"; data: string }
  /** Apply a pinched font size (px) to the terminal + refit/resize. */
  | { kind: "set-font"; px: number }
  /** The cursor-drag armed (haptic cue). */
  | { kind: "drag-start" };

export interface GestureResult {
  state: GestureState;
  effect: GestureEffect;
  /** preventDefault + stopPropagation the DOM event (blocks touch-scroll). */
  swallow: boolean;
}

export interface CellSize {
  cellW: number;
  cellH: number;
}

const NONE: GestureEffect = { kind: "none" };

/**
 * The pure gesture state machine. The wiring feeds it down/move/up/cancel
 * events (plus a "long-press" event when its timer fires) and performs the
 * returned effect; `swallow` asks it to preventDefault + stopPropagation the
 * DOM event so touch-scroll / native handling never sees an active gesture.
 */
export function gestureStep(
  state: GestureState,
  event: GestureEvent,
  cell: CellSize
): GestureResult {
  switch (event.type) {
    case "down": {
      if (event.touches === 1) {
        // The only finger on screen — a fresh gesture (self-healing even if a
        // previous touchend was dropped). Keeps lastTap: the double-tap window
        // spans this transition.
        return {
          state: {
            ...state,
            phase: "pending",
            samples: [{ x: event.x, y: event.y, t: event.t }],
          },
          effect: NONE,
          swallow: false,
        };
      }
      // An in-progress scroll keeps scrolling — extra fingers don't hijack it
      // into a pinch mid-flick (touch-scroll ignores them too).
      if (state.phase === "scroll") {
        return { state, effect: NONE, swallow: false };
      }
      if (
        event.touches === 2 &&
        (state.phase === "pending" || state.phase === "idle") &&
        event.dist !== undefined &&
        event.dist > 0 &&
        event.fontSize !== undefined &&
        event.fontSize > 0
      ) {
        return {
          state: {
            ...state,
            phase: "pinch",
            samples: [],
            lastTap: null, // a pinch is not a tap — break the double-tap chain
            pinchStartDist: event.dist,
            pinchBaseFont: event.fontSize,
            lastFont: event.fontSize,
          },
          effect: NONE,
          swallow: false,
        };
      }
      // A second finger during a cursor-drag (or a 3rd anywhere, or a pinch we
      // couldn't baseline) cancels the gesture; swallow until all fingers lift.
      return {
        state: { ...state, phase: "swallow", samples: [], lastTap: null },
        effect: NONE,
        swallow: false,
      };
    }
    case "move": {
      switch (state.phase) {
        case "pending": {
          const sample = { x: event.x, y: event.y, t: event.t };
          // Bounded history: only the first and latest samples matter — any
          // slop-crossing sample transitions immediately below, so history
          // can't hide an excursion.
          const first = state.samples[0];
          const samples = first ? [first, sample] : [sample];
          if (detectGesture(samples, event.t) === "scroll") {
            // Crossed the slop before the long-press armed → it's a scroll;
            // touch-scroll owns it from here (this path is never swallowed).
            return {
              state: { ...state, phase: "scroll", samples: [] },
              effect: NONE,
              swallow: false,
            };
          }
          return {
            state: { ...state, samples },
            effect: NONE,
            swallow: false,
          };
        }
        case "drag": {
          const keys = dragToArrowKeys(
            event.x - state.anchorX,
            event.y - state.anchorY,
            cell.cellW,
            cell.cellH
          );
          if (!keys.sequence) return { state, effect: NONE, swallow: true };
          // Advance the anchor by the WHOLE cells consumed on the dominant
          // axis (keeping the sub-cell remainder); snap the other axis to the
          // finger so cross-axis drift from a slightly slanted drag can't
          // slowly accumulate into a stray perpendicular key.
          const next =
            keys.cellsX !== 0
              ? {
                  ...state,
                  anchorX: state.anchorX + keys.cellsX * cell.cellW,
                  anchorY: event.y,
                }
              : {
                  ...state,
                  anchorY: state.anchorY + keys.cellsY * cell.cellH,
                  anchorX: event.x,
                };
          return {
            state: next,
            effect: { kind: "send", data: keys.sequence },
            swallow: true,
          };
        }
        case "pinch": {
          if (
            event.dist === undefined ||
            !(event.dist > 0) ||
            !(state.pinchStartDist > 0)
          ) {
            return { state, effect: NONE, swallow: true };
          }
          const px = pinchToFontSize(
            event.dist / state.pinchStartDist,
            state.pinchBaseFont
          );
          if (px === state.lastFont) {
            return { state, effect: NONE, swallow: true };
          }
          return {
            state: { ...state, lastFont: px },
            effect: { kind: "set-font", px },
            swallow: true,
          };
        }
        case "swallow":
          return { state, effect: NONE, swallow: true };
        default:
          // idle / scroll — not ours; let touch-scroll and xterm handle it.
          return { state, effect: NONE, swallow: false };
      }
    }
    case "long-press": {
      if (state.phase !== "pending") {
        return { state, effect: NONE, swallow: false };
      }
      const last = state.samples[state.samples.length - 1];
      if (!last || detectGesture(state.samples, event.t) !== "long-press") {
        return { state, effect: NONE, swallow: false };
      }
      return {
        state: {
          ...state,
          phase: "drag",
          samples: [],
          anchorX: last.x,
          anchorY: last.y,
          lastTap: null,
        },
        effect: { kind: "drag-start" },
        swallow: false,
      };
    }
    case "up": {
      if (event.touches > 0) {
        // Fingers remain. Leaving a pinch/drag mid-way must not fall through
        // to scrolling (touch-scroll holds stale coordinates) — swallow the
        // rest of this gesture until every finger lifts.
        if (
          state.phase === "drag" ||
          state.phase === "pinch" ||
          state.phase === "swallow"
        ) {
          return {
            state: { ...state, phase: "swallow" },
            effect: NONE,
            swallow: true,
          };
        }
        return { state, effect: NONE, swallow: false };
      }
      // Last finger lifted — resolve the gesture and reset.
      if (state.phase === "pending") {
        const start = state.samples[0];
        if (start && detectGesture(state.samples, event.t) === "tap") {
          if (isDoubleTap(state.lastTap, start)) {
            return {
              state: { ...state, phase: "idle", samples: [], lastTap: null },
              effect: { kind: "send", data: TAB_KEY },
              swallow: false,
            };
          }
          return {
            state: {
              ...state,
              phase: "idle",
              samples: [],
              lastTap: { x: start.x, y: start.y, t: event.t },
            },
            effect: NONE,
            swallow: false,
          };
        }
        // Held too long for a tap (and the long-press never dragged) — no-op.
        return {
          state: { ...state, phase: "idle", samples: [], lastTap: null },
          effect: NONE,
          swallow: false,
        };
      }
      const swallow =
        state.phase === "drag" ||
        state.phase === "pinch" ||
        state.phase === "swallow";
      return {
        state: {
          ...state,
          phase: "idle",
          samples: [],
          // A scroll/drag/pinch in between breaks a double-tap chain.
          lastTap: null,
        },
        effect: NONE,
        swallow,
      };
    }
    case "cancel":
      return { state: initialGestureState(), effect: NONE, swallow: false };
  }
}

// ---------------------------------------------------------------------------
// DOM wiring (thin: TouchEvent → GestureEvent → apply effect)
// ---------------------------------------------------------------------------

export interface UseTerminalGesturesOptions {
  /** The terminal container div (listeners attach here, capture phase). */
  terminalRef: RefObject<HTMLDivElement | null>;
  xtermRef: RefObject<XTerm | null>;
  /** Gate: isMobile && !selectMode — listeners are detached otherwise. */
  enabled: boolean;
  sendInput: (data: string) => void;
  /** Re-fit + propagate cols/rows after a pinch font change. */
  triggerResize: () => void;
}

export function useTerminalGestures({
  terminalRef,
  xtermRef,
  enabled,
  sendInput,
  triggerResize,
}: UseTerminalGesturesOptions): void {
  // Latest callbacks in refs so the listeners bind once per enable-flip.
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;
  const triggerResizeRef = useRef(triggerResize);
  triggerResizeRef.current = triggerResize;

  useEffect(() => {
    if (!enabled) return;
    const el = terminalRef.current;
    if (!el) return;

    let state = initialGestureState();
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLongPress = () => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    // Live cell metrics off the rendered screen (font-metric estimate before
    // first render); a pinch changes them, so read fresh on every drag move.
    const cellSize = (): CellSize => {
      const term = xtermRef.current;
      const fontSize = term?.options.fontSize ?? 14;
      const screen = term?.element?.querySelector(
        ".xterm-screen"
      ) as HTMLElement | null;
      const cellW =
        term && screen && term.cols > 0 && screen.clientWidth > 0
          ? screen.clientWidth / term.cols
          : fontSize * 0.6;
      const cellH =
        term && screen && term.rows > 0 && screen.clientHeight > 0
          ? screen.clientHeight / term.rows
          : fontSize * 1.2;
      return { cellW, cellH };
    };

    const apply = (event: GestureEvent, domEvent?: TouchEvent) => {
      const result = gestureStep(state, event, cellSize());
      state = result.state;
      if (result.swallow && domEvent) {
        domEvent.stopPropagation();
        if (domEvent.cancelable) domEvent.preventDefault();
      }
      const effect = result.effect;
      if (effect.kind === "send") {
        sendInputRef.current(effect.data);
      } else if (effect.kind === "set-font") {
        const term = xtermRef.current;
        if (term) {
          // Mirror updateTerminalForMobile: fontSize → refresh → fit+resize.
          term.options.fontSize = effect.px;
          term.refresh(0, term.rows - 1);
          triggerResizeRef.current();
        }
      } else if (effect.kind === "drag-start") {
        try {
          navigator.vibrate?.(15); // haptic cue: cursor-drag armed
        } catch {
          // vibration unsupported/blocked — the gesture works without it
        }
      }
      // Mirror the phase with the long-press timer: arm it when a fresh touch
      // enters pending, drop it the moment the gesture leaves pending.
      if (state.phase === "pending" && event.type === "down") {
        clearLongPress();
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          apply({ type: "long-press", t: performance.now() });
        }, LONG_PRESS_MS);
      } else if (state.phase !== "pending") {
        clearLongPress();
      }
    };

    const pinchDist = (touches: TouchList): number | undefined =>
      touches.length >= 2
        ? Math.hypot(
            touches[0].clientX - touches[1].clientX,
            touches[0].clientY - touches[1].clientY
          )
        : undefined;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      apply(
        {
          type: "down",
          x: t.clientX,
          y: t.clientY,
          t: performance.now(),
          touches: e.touches.length,
          dist: pinchDist(e.touches),
          fontSize: xtermRef.current?.options.fontSize,
        },
        e
      );
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      apply(
        {
          type: "move",
          x: t.clientX,
          y: t.clientY,
          t: performance.now(),
          touches: e.touches.length,
          dist: pinchDist(e.touches),
        },
        e
      );
    };
    const onTouchEnd = (e: TouchEvent) => {
      apply({ type: "up", t: performance.now(), touches: e.touches.length }, e);
    };
    const onTouchCancel = () => {
      apply({ type: "cancel" });
    };

    // iOS: a long-press on text otherwise raises the native magnifier/callout
    // menu before any preventDefault can run — suppress selection UI on the
    // container while gestures own it, restoring the prior inline values on
    // cleanup (select mode re-enables its own selectable overlay).
    const style = el.style as CSSStyleDeclaration & {
      webkitUserSelect?: string;
      webkitTouchCallout?: string;
    };
    const prevUserSelect = style.userSelect;
    const prevWebkitUserSelect = style.webkitUserSelect;
    const prevTouchCallout = style.webkitTouchCallout;
    style.userSelect = "none";
    style.webkitUserSelect = "none";
    style.webkitTouchCallout = "none";

    // Capture phase: an active drag/pinch must stopPropagation() BEFORE
    // touch-scroll's listeners on .xterm-screen run. touchstart stays passive
    // (down events are never swallowed); moves/ends need preventDefault to
    // block native scrolling and the synthetic click after a drag.
    el.addEventListener("touchstart", onTouchStart, {
      capture: true,
      passive: true,
    });
    el.addEventListener("touchmove", onTouchMove, {
      capture: true,
      passive: false,
    });
    el.addEventListener("touchend", onTouchEnd, {
      capture: true,
      passive: false,
    });
    el.addEventListener("touchcancel", onTouchCancel, { capture: true });

    return () => {
      // Order matters: drop the timer first (a late long-press must not fire
      // into a detached closure), then remove listeners. Gesture state itself
      // is closure-local — a re-run starts fresh from initialGestureState().
      clearLongPress();
      el.removeEventListener("touchstart", onTouchStart, { capture: true });
      el.removeEventListener("touchmove", onTouchMove, { capture: true });
      el.removeEventListener("touchend", onTouchEnd, { capture: true });
      el.removeEventListener("touchcancel", onTouchCancel, { capture: true });
      style.userSelect = prevUserSelect;
      style.webkitUserSelect = prevWebkitUserSelect ?? "";
      style.webkitTouchCallout = prevTouchCallout ?? "";
    };
  }, [enabled, terminalRef, xtermRef]);
}
