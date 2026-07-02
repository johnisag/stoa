import { describe, it, expect } from "vitest";
import {
  pullReducer,
  INITIAL_PULL_STATE,
  PULL_THRESHOLD_PX,
  PULL_RESISTANCE,
  PULL_MAX_PX,
  type PullState,
  type PullEvent,
} from "@/hooks/usePullToRefresh";

// Drive the pure machine through a list of events, returning the final state and
// whether a refresh fired anywhere along the way.
function run(events: PullEvent[], start: PullState = INITIAL_PULL_STATE) {
  let state = start;
  let refreshed = false;
  for (const e of events) {
    const res = pullReducer(state, e);
    state = res.state;
    refreshed = refreshed || res.shouldRefresh;
  }
  return { state, refreshed };
}

// A raw finger delta that lands the (post-resistance) distance exactly at a target.
const rawFor = (targetDistance: number) => targetDistance * PULL_RESISTANCE;

describe("pullReducer — gating", () => {
  it("does NOT enter the pull machine when the drag starts away from the top", () => {
    const { state } = run([
      { type: "start", atTop: false },
      { type: "move", rawDelta: rawFor(200) },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.distance).toBe(0);
  });

  it("enters 'pulling' when the drag starts at the top", () => {
    const { state } = run([{ type: "start", atTop: true }]);
    expect(state.phase).toBe("pulling");
    expect(state.distance).toBe(0);
  });

  it("ignores moves entirely when the gesture never armed (idle)", () => {
    // start away from top → idle → a move must not resurrect a pull.
    const { state } = run([
      { type: "start", atTop: false },
      { type: "move", rawDelta: rawFor(PULL_THRESHOLD_PX + 40) },
      { type: "end" },
    ]);
    expect(state.phase).toBe("idle");
  });
});

describe("pullReducer — resistance & clamping", () => {
  it("applies the resistance divisor to raw finger travel", () => {
    const { state } = run([
      { type: "start", atTop: true },
      { type: "move", rawDelta: 40 },
    ]);
    expect(state.distance).toBe(40 / PULL_RESISTANCE);
  });

  it("clamps the visible distance to PULL_MAX_PX", () => {
    const { state } = run([
      { type: "start", atTop: true },
      { type: "move", rawDelta: rawFor(PULL_MAX_PX + 500) },
    ]);
    expect(state.distance).toBe(PULL_MAX_PX);
  });

  it("never goes negative on an upward drag", () => {
    const { state } = run([
      { type: "start", atTop: true },
      { type: "move", rawDelta: -300 },
    ]);
    expect(state.distance).toBe(0);
    expect(state.phase).toBe("pulling");
  });
});

describe("pullReducer — threshold arm / disarm", () => {
  it("stays 'pulling' just under the threshold", () => {
    const { state } = run([
      { type: "start", atTop: true },
      { type: "move", rawDelta: rawFor(PULL_THRESHOLD_PX - 1) },
    ]);
    expect(state.phase).toBe("pulling");
  });

  it("arms exactly at the threshold", () => {
    const { state } = run([
      { type: "start", atTop: true },
      { type: "move", rawDelta: rawFor(PULL_THRESHOLD_PX) },
    ]);
    expect(state.phase).toBe("armed");
  });

  it("disarms when the finger drags back under the threshold", () => {
    const { state } = run([
      { type: "start", atTop: true },
      { type: "move", rawDelta: rawFor(PULL_THRESHOLD_PX + 20) },
      { type: "move", rawDelta: rawFor(PULL_THRESHOLD_PX - 10) },
    ]);
    expect(state.phase).toBe("pulling");
  });
});

describe("pullReducer — release", () => {
  it("releasing while ARMED triggers a refresh and enters 'refreshing'", () => {
    const { state, refreshed } = run([
      { type: "start", atTop: true },
      { type: "move", rawDelta: rawFor(PULL_THRESHOLD_PX + 5) },
      { type: "end" },
    ]);
    expect(refreshed).toBe(true);
    expect(state.phase).toBe("refreshing");
    // The indicator holds at the threshold height during the refresh.
    expect(state.distance).toBe(PULL_THRESHOLD_PX);
  });

  it("releasing while merely PULLING snaps back with NO refresh", () => {
    const { state, refreshed } = run([
      { type: "start", atTop: true },
      { type: "move", rawDelta: rawFor(PULL_THRESHOLD_PX - 5) },
      { type: "end" },
    ]);
    expect(refreshed).toBe(false);
    expect(state).toEqual(INITIAL_PULL_STATE);
  });

  it("fires the refresh at most once per arm→release edge", () => {
    // A second 'end' after settling must not re-fire.
    let refreshCount = 0;
    let state: PullState = INITIAL_PULL_STATE;
    for (const e of [
      { type: "start", atTop: true },
      { type: "move", rawDelta: rawFor(PULL_THRESHOLD_PX + 5) },
      { type: "end" },
      { type: "settle" },
      { type: "end" },
    ] as PullEvent[]) {
      const res = pullReducer(state, e);
      state = res.state;
      if (res.shouldRefresh) refreshCount++;
    }
    expect(refreshCount).toBe(1);
    expect(state.phase).toBe("idle");
  });
});

describe("pullReducer — refreshing is exclusive", () => {
  const refreshing: PullState = {
    phase: "refreshing",
    distance: PULL_THRESHOLD_PX,
  };

  it("ignores a new 'start' while a refresh is in flight", () => {
    const { state, refreshed } = run(
      [{ type: "start", atTop: true }],
      refreshing
    );
    expect(refreshed).toBe(false);
    expect(state).toEqual(refreshing);
  });

  it("ignores moves while refreshing", () => {
    const { state } = run(
      [{ type: "move", rawDelta: rawFor(200) }],
      refreshing
    );
    expect(state).toEqual(refreshing);
  });

  it("'settle' collapses a refreshing indicator back to idle", () => {
    const { state } = run([{ type: "settle" }], refreshing);
    expect(state).toEqual(INITIAL_PULL_STATE);
  });

  it("'settle' in a non-refreshing phase is a harmless no-op", () => {
    const pulling: PullState = { phase: "pulling", distance: 20 };
    const { state } = run([{ type: "settle" }], pulling);
    expect(state).toEqual(pulling);
  });
});
