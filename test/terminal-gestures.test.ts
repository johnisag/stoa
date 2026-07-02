/**
 * Locks the pure gesture math behind #29 mobile terminal gestures
 * (components/Terminal/hooks/useTerminalGestures.ts): tap vs double-tap vs
 * long-press classification, drag→arrow-key translation (diagonal dominance,
 * zero-cell moves, the runaway cap), pinch font clamping at both bounds, and
 * the gestureStep reducer's full flows — including multi-touch cancellation
 * and the scroll hand-off that keeps touch-scroll.ts untouched. No DOM/touch
 * simulation: everything here is the pure core the wiring delegates to.
 */
import { describe, it, expect } from "vitest";
import {
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  ARROW_UP,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LONG_PRESS_MS,
  MAX_DRAG_CELLS,
  TAB_KEY,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  detectGesture,
  dragToArrowKeys,
  gestureStep,
  initialGestureState,
  isDoubleTap,
  pinchToFontSize,
  type CellSize,
  type GestureEvent,
  type GestureResult,
  type GestureState,
  type TouchSample,
} from "@/components/Terminal/hooks/useTerminalGestures";

const ESC = String.fromCharCode(27);
const CELL: CellSize = { cellW: 10, cellH: 20 };

const s = (x: number, y: number, t: number): TouchSample => ({ x, y, t });

describe("key sequences are real escape bytes", () => {
  it("builds the standard CSI arrow sequences and Tab", () => {
    expect(ARROW_UP).toBe(ESC + "[A");
    expect(ARROW_DOWN).toBe(ESC + "[B");
    expect(ARROW_RIGHT).toBe(ESC + "[C");
    expect(ARROW_LEFT).toBe(ESC + "[D");
    expect(TAB_KEY).toBe(String.fromCharCode(9));
    expect(ARROW_RIGHT.charCodeAt(0)).toBe(27);
  });
});

describe("detectGesture", () => {
  it("classifies a quick stationary touch as a tap", () => {
    expect(detectGesture([s(100, 100, 0)], TAP_MAX_MS - 50)).toBe("tap");
  });

  it("allows sub-slop jitter within a tap", () => {
    const samples = [s(100, 100, 0), s(103, 102, 60)];
    expect(detectGesture(samples, 120)).toBe("tap");
  });

  it("classifies early movement past the slop as a scroll", () => {
    const samples = [s(100, 100, 0), s(100, 100 + TAP_SLOP_PX + 1, 50)];
    expect(detectGesture(samples, 60)).toBe("scroll");
  });

  it("holds the EXACT slop boundary: at TAP_SLOP_PX it is still a tap, one past hands off to scroll", () => {
    // Locks the coexistence contract with touch-scroll.ts's 8px direction
    // threshold (its `delta > 8` engages one pixel past the slop too) — if
    // either constant drifts, this boundary pair breaks loudly.
    expect(TAP_SLOP_PX).toBe(8);
    const atSlop = [s(100, 100, 0), s(100, 100 + TAP_SLOP_PX, 60)];
    expect(detectGesture(atSlop, 120)).toBe("tap");
    const pastSlop = [s(100, 100, 0), s(100, 100 + TAP_SLOP_PX + 1, 60)];
    expect(detectGesture(pastSlop, 120)).toBe("scroll");
  });

  it("classifies a stationary hold past the threshold as a long-press", () => {
    expect(detectGesture([s(100, 100, 0)], LONG_PRESS_MS)).toBe("long-press");
  });

  it("stays a long-press when movement happens only AFTER it armed", () => {
    const samples = [s(100, 100, 0), s(140, 100, LONG_PRESS_MS + 50)];
    expect(detectGesture(samples, LONG_PRESS_MS + 60)).toBe("long-press");
  });

  it("returns none for the hesitant in-between hold", () => {
    expect(detectGesture([s(100, 100, 0)], TAP_MAX_MS + 1)).toBe("none");
    expect(detectGesture([s(100, 100, 0)], LONG_PRESS_MS - 1)).toBe("none");
  });

  it("returns none for an empty sample list", () => {
    expect(detectGesture([], 100)).toBe("none");
  });
});

describe("isDoubleTap", () => {
  it("accepts two taps within the window and slop", () => {
    const prev = s(100, 100, 1000);
    expect(isDoubleTap(prev, s(110, 105, 1000 + DOUBLE_TAP_MS))).toBe(true);
  });

  it("rejects a second tap that arrives too late", () => {
    const prev = s(100, 100, 1000);
    expect(isDoubleTap(prev, s(100, 100, 1000 + DOUBLE_TAP_MS + 1))).toBe(
      false
    );
  });

  it("rejects a second tap that lands too far away", () => {
    const prev = s(100, 100, 1000);
    expect(isDoubleTap(prev, s(100 + DOUBLE_TAP_SLOP_PX + 1, 100, 1100))).toBe(
      false
    );
  });

  it("rejects when there is no previous tap", () => {
    expect(isDoubleTap(null, s(100, 100, 1000))).toBe(false);
  });

  it("rejects a clock going backwards", () => {
    expect(isDoubleTap(s(100, 100, 1000), s(100, 100, 900))).toBe(false);
  });
});

describe("dragToArrowKeys", () => {
  it("emits one right arrow per cell crossed", () => {
    expect(dragToArrowKeys(35, 0, 10, 20)).toEqual({
      sequence: ARROW_RIGHT.repeat(3),
      cellsX: 3,
      cellsY: 0,
    });
  });

  it("emits left arrows for a leftward drag", () => {
    expect(dragToArrowKeys(-21, 0, 10, 20)).toEqual({
      sequence: ARROW_LEFT.repeat(2),
      cellsX: -2,
      cellsY: 0,
    });
  });

  it("emits up/down arrows for vertical drags", () => {
    expect(dragToArrowKeys(0, 45, 10, 20)).toEqual({
      sequence: ARROW_DOWN.repeat(2),
      cellsX: 0,
      cellsY: 2,
    });
    expect(dragToArrowKeys(0, -20, 10, 20)).toEqual({
      sequence: ARROW_UP,
      cellsX: 0,
      cellsY: -1,
    });
  });

  it("lets the dominant axis win a diagonal drag (horizontal here)", () => {
    // 3 cells right + 1 cell down → horizontal only, no stray down arrow.
    const r = dragToArrowKeys(35, 25, 10, 20);
    expect(r).toEqual({
      sequence: ARROW_RIGHT.repeat(3),
      cellsX: 3,
      cellsY: 0,
    });
  });

  it("lets vertical dominance win the other way", () => {
    // 1 cell right + 3 cells down → vertical only.
    const r = dragToArrowKeys(15, 65, 10, 20);
    expect(r).toEqual({
      sequence: ARROW_DOWN.repeat(3),
      cellsX: 0,
      cellsY: 3,
    });
  });

  it("breaks ties toward horizontal (the cursor-editing axis)", () => {
    const r = dragToArrowKeys(20, 40, 10, 20); // 2 cells each way
    expect(r.cellsX).toBe(2);
    expect(r.cellsY).toBe(0);
    expect(r.sequence).toBe(ARROW_RIGHT.repeat(2));
  });

  it("emits nothing for a sub-cell move", () => {
    expect(dragToArrowKeys(9, 19, 10, 20)).toEqual({
      sequence: "",
      cellsX: 0,
      cellsY: 0,
    });
  });

  it("emits nothing for a zero move", () => {
    expect(dragToArrowKeys(0, 0, 10, 20)).toEqual({
      sequence: "",
      cellsX: 0,
      cellsY: 0,
    });
  });

  it("is a no-op for non-positive or non-finite cell sizes", () => {
    expect(dragToArrowKeys(100, 0, 0, 20).sequence).toBe("");
    expect(dragToArrowKeys(100, 0, -5, 20).sequence).toBe("");
    expect(dragToArrowKeys(100, 0, NaN, 20).sequence).toBe("");
    expect(dragToArrowKeys(NaN, 0, 10, 20).sequence).toBe("");
  });

  it("caps a runaway delta at MAX_DRAG_CELLS keys", () => {
    const r = dragToArrowKeys(1e9, 0, 10, 20);
    expect(r.cellsX).toBe(MAX_DRAG_CELLS);
    expect(r.sequence).toBe(ARROW_RIGHT.repeat(MAX_DRAG_CELLS));
    expect(dragToArrowKeys(-1e9, 0, 10, 20).cellsX).toBe(-MAX_DRAG_CELLS);
  });
});

describe("pinchToFontSize", () => {
  it("scales and rounds from the base size", () => {
    expect(pinchToFontSize(1, 14)).toBe(14);
    expect(pinchToFontSize(1.1, 14)).toBe(15); // 15.4 → 15
    expect(pinchToFontSize(0.8, 14)).toBe(11); // 11.2 → 11
  });

  it("clamps at the upper bound", () => {
    expect(pinchToFontSize(3, 14)).toBe(FONT_SIZE_MAX);
    expect(pinchToFontSize(1000, 14)).toBe(FONT_SIZE_MAX);
  });

  it("clamps at the lower bound", () => {
    expect(pinchToFontSize(0.3, 14)).toBe(FONT_SIZE_MIN);
    expect(pinchToFontSize(0.001, 14)).toBe(FONT_SIZE_MIN);
  });

  it("clamps a base that is already out of range", () => {
    expect(pinchToFontSize(1, 60)).toBe(FONT_SIZE_MAX);
    expect(pinchToFontSize(1, 4)).toBe(FONT_SIZE_MIN);
  });

  it("falls back safely on degenerate inputs", () => {
    expect(pinchToFontSize(NaN, 14)).toBe(14);
    expect(pinchToFontSize(0, 14)).toBe(14);
    expect(pinchToFontSize(-2, 14)).toBe(14);
    expect(pinchToFontSize(1, NaN)).toBe(14);
    expect(pinchToFontSize(1, 0)).toBe(14);
  });
});

/** Fold events through the reducer, collecting every step's result. */
function run(
  events: GestureEvent[],
  start: GestureState = initialGestureState()
): { state: GestureState; results: GestureResult[] } {
  let state = start;
  const results: GestureResult[] = [];
  for (const event of events) {
    const r = gestureStep(state, event, CELL);
    state = r.state;
    results.push(r);
  }
  return { state, results };
}

const down = (
  x: number,
  y: number,
  t: number,
  touches = 1,
  extra: { dist?: number; fontSize?: number } = {}
): GestureEvent => ({ type: "down", x, y, t, touches, ...extra });
const move = (
  x: number,
  y: number,
  t: number,
  touches = 1,
  dist?: number
): GestureEvent => ({ type: "move", x, y, t, touches, dist });
const longPress = (t: number): GestureEvent => ({ type: "long-press", t });
const up = (t: number, touches = 0): GestureEvent => ({
  type: "up",
  t,
  touches,
});

describe("gestureStep — long-press cursor drag", () => {
  it("arms on a stationary long-press and emits arrows per cell dragged", () => {
    const { state, results } = run([
      down(100, 100, 0),
      longPress(LONG_PRESS_MS),
      move(135, 102, LONG_PRESS_MS + 30), // 3.5 cells right
      move(135, 102, LONG_PRESS_MS + 40), // no further movement
      move(105, 102, LONG_PRESS_MS + 80), // 2.5 cells left of the new anchor
    ]);
    expect(results[1].effect).toEqual({ kind: "drag-start" });
    expect(results[2].effect).toEqual({
      kind: "send",
      data: ARROW_RIGHT.repeat(3),
    });
    expect(results[2].swallow).toBe(true); // touch-scroll must never see this
    expect(results[3].effect.kind).toBe("none"); // remainder < 1 cell
    expect(results[4].effect).toEqual({
      kind: "send",
      data: ARROW_LEFT.repeat(2),
    });
    expect(state.phase).toBe("drag");
  });

  it("keeps the sub-cell remainder across moves (no lost distance)", () => {
    const { results } = run([
      down(100, 100, 0),
      longPress(LONG_PRESS_MS),
      move(106, 100, LONG_PRESS_MS + 10), // 0.6 cells — nothing yet
      move(112, 100, LONG_PRESS_MS + 20), // cumulative 1.2 → one key
    ]);
    expect(results[2].effect.kind).toBe("none");
    expect(results[3].effect).toEqual({ kind: "send", data: ARROW_RIGHT });
  });

  it("does not arm when the finger moved past the slop first (scroll wins)", () => {
    const { state, results } = run([
      down(100, 100, 0),
      move(100, 100 + TAP_SLOP_PX + 5, 50), // a scroll flick
      longPress(LONG_PRESS_MS), // stale timer fires anyway
      move(100, 200, LONG_PRESS_MS + 10),
    ]);
    expect(state.phase).toBe("scroll");
    for (const r of results) {
      expect(r.effect.kind).toBe("none");
      expect(r.swallow).toBe(false); // touch-scroll owns the whole sequence
    }
  });

  it("cancels the drag when a second finger lands (multi-touch)", () => {
    const { state, results } = run([
      down(100, 100, 0),
      longPress(LONG_PRESS_MS),
      down(200, 200, LONG_PRESS_MS + 20, 2, { dist: 120, fontSize: 11 }),
      move(150, 150, LONG_PRESS_MS + 40, 2, 130),
      up(LONG_PRESS_MS + 60, 1),
      move(150, 180, LONG_PRESS_MS + 70),
    ]);
    expect(state.phase).toBe("swallow");
    // Nothing after the cancel may emit keys or font changes.
    for (const r of results.slice(2)) expect(r.effect.kind).toBe("none");
    // The tail of the gesture is swallowed so touch-scroll can't jump.
    expect(results[3].swallow).toBe(true);
    expect(results[5].swallow).toBe(true);
  });

  it("resets to idle when the finger lifts", () => {
    const { state } = run([
      down(100, 100, 0),
      longPress(LONG_PRESS_MS),
      move(140, 100, LONG_PRESS_MS + 30),
      up(LONG_PRESS_MS + 60),
    ]);
    expect(state.phase).toBe("idle");
    expect(state.lastTap).toBeNull(); // a drag breaks any double-tap chain
  });
});

describe("gestureStep — tap and double-tap", () => {
  it("sends Tab on a double-tap within the window", () => {
    const { results } = run([
      down(100, 100, 0),
      up(80),
      down(105, 103, 80 + DOUBLE_TAP_MS - 50),
      up(80 + DOUBLE_TAP_MS),
    ]);
    expect(results[1].effect.kind).toBe("none"); // first tap records only
    expect(results[3].effect).toEqual({ kind: "send", data: TAB_KEY });
  });

  it("does not send Tab when the second tap is too late", () => {
    const { results } = run([
      down(100, 100, 0),
      up(80),
      down(100, 100, 80 + DOUBLE_TAP_MS + 100),
      up(80 + DOUBLE_TAP_MS + 180),
    ]);
    expect(results[3].effect.kind).toBe("none");
  });

  it("does not send Tab when the taps are far apart", () => {
    const { results } = run([
      down(100, 100, 0),
      up(80),
      down(100 + DOUBLE_TAP_SLOP_PX + 20, 100, 150),
      up(230),
    ]);
    expect(results[3].effect.kind).toBe("none");
  });

  it("a scroll between two taps breaks the double-tap chain", () => {
    const { results } = run([
      down(100, 100, 0),
      up(80),
      // an intervening scroll flick
      down(100, 100, 120),
      move(100, 140, 150),
      up(170),
      // this tap would be within the window of the FIRST tap's lift
      down(100, 100, 200),
      up(260),
    ]);
    expect(results[6].effect.kind).toBe("none");
  });

  it("a triple tap sends exactly one Tab (window resets after firing)", () => {
    const { results } = run([
      down(100, 100, 0),
      up(60),
      down(100, 100, 150),
      up(210),
      down(100, 100, 300),
      up(360),
    ]);
    const sends = results.filter((r) => r.effect.kind === "send");
    expect(sends).toHaveLength(1);
  });

  it("a slow press-and-lift is neither tap nor drag (no output)", () => {
    const { state, results } = run([
      down(100, 100, 0),
      up(TAP_MAX_MS + 50), // lifted between tap max and long-press
    ]);
    expect(results[1].effect.kind).toBe("none");
    expect(state.phase).toBe("idle");
    expect(state.lastTap).toBeNull();
  });
});

describe("gestureStep — pinch font sizing", () => {
  const pinchStart: GestureEvent[] = [
    down(100, 100, 0),
    down(150, 100, 20, 2, { dist: 100, fontSize: 11 }),
  ];

  it("grows the font on spread and dedupes repeat sizes", () => {
    const { results } = run([
      ...pinchStart,
      move(100, 100, 40, 2, 150), // 1.5x → 17 (round 16.5)
      move(100, 100, 60, 2, 150), // same distance → no new effect
      move(100, 100, 80, 2, 200), // 2x → 22
    ]);
    expect(results[2].effect).toEqual({ kind: "set-font", px: 17 });
    expect(results[3].effect.kind).toBe("none");
    expect(results[4].effect).toEqual({ kind: "set-font", px: 22 });
    // Every pinch move is swallowed so touch-scroll never sees two fingers.
    for (const r of results.slice(2)) expect(r.swallow).toBe(true);
  });

  it("clamps at both bounds", () => {
    const { results } = run([
      ...pinchStart,
      move(100, 100, 40, 2, 10000), // huge spread
      move(100, 100, 60, 2, 1), // huge squeeze
    ]);
    expect(results[2].effect).toEqual({ kind: "set-font", px: FONT_SIZE_MAX });
    expect(results[3].effect).toEqual({ kind: "set-font", px: FONT_SIZE_MIN });
  });

  it("ends the gesture cleanly: fingers lift one by one, no scroll fallthrough", () => {
    const { state, results } = run([
      ...pinchStart,
      move(100, 100, 40, 2, 150),
      up(60, 1), // one finger up → swallow the rest
      move(100, 120, 80, 1),
      up(100, 0),
    ]);
    expect(results[3].swallow).toBe(true);
    expect(results[4].swallow).toBe(true);
    expect(results[4].effect.kind).toBe("none"); // no keys from the leftover finger
    expect(state.phase).toBe("idle");
    expect(state.lastTap).toBeNull(); // a pinch is not a tap
  });

  it("does not hijack an in-progress scroll into a pinch", () => {
    const { state } = run([
      down(100, 100, 0),
      move(100, 140, 30), // scrolling
      down(150, 100, 60, 2, { dist: 100, fontSize: 11 }),
      move(100, 160, 90, 2, 120),
    ]);
    expect(state.phase).toBe("scroll");
  });

  it("falls back to swallow when the pinch has no usable baseline", () => {
    const { state } = run([
      down(100, 100, 0),
      down(100, 100, 20, 2, { dist: 0, fontSize: 11 }), // zero distance
    ]);
    expect(state.phase).toBe("swallow");
  });

  it("a third finger cancels into swallow", () => {
    const { state } = run([
      ...pinchStart,
      down(200, 200, 40, 3, { dist: 100, fontSize: 11 }),
    ]);
    expect(state.phase).toBe("swallow");
  });
});

describe("gestureStep — cancel and recovery", () => {
  it("touchcancel resets everything", () => {
    const { state } = run([
      down(100, 100, 0),
      longPress(LONG_PRESS_MS),
      { type: "cancel" },
    ]);
    expect(state).toEqual(initialGestureState());
  });

  it("a fresh single-finger down always restarts cleanly (self-healing)", () => {
    // Even from a stuck swallow phase (e.g. a dropped touchend), the next
    // solo touch is a normal gesture again.
    const stuck: GestureState = { ...initialGestureState(), phase: "swallow" };
    const { state, results } = run(
      [down(100, 100, 0), up(60), down(100, 100, 150), up(210)],
      stuck
    );
    expect(results[3].effect).toEqual({ kind: "send", data: TAB_KEY });
    expect(state.phase).toBe("idle");
  });
});
