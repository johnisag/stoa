import { describe, it, expect } from "vitest";
import {
  shouldHoldWorkingToIdle,
  isInStartupGrace,
  createDebounceState,
  DEBOUNCE_CONFIG,
} from "@/lib/detection/debounce";
import type { SessionStatus } from "@/lib/status-detector";

const RUNNING: SessionStatus = "running";
const IDLE: SessionStatus = "idle";

describe("shouldHoldWorkingToIdle", () => {
  it("holds the first working→idle reading (starts confirmation)", () => {
    const state = createDebounceState();
    const hold = shouldHoldWorkingToIdle(
      state,
      RUNNING,
      IDLE,
      false,
      false,
      1000
    );
    expect(hold).toBe(true);
    expect(state.pendingIdleConfirmations).toBe(1);
    expect(state.pendingIdleStartedAt).toBe(1000);
  });

  it("publishes after 3 consecutive idle confirmations", () => {
    const state = createDebounceState();
    // First reading: hold
    expect(
      shouldHoldWorkingToIdle(state, RUNNING, IDLE, false, false, 1000)
    ).toBe(true);
    // Second reading: still holding
    expect(
      shouldHoldWorkingToIdle(state, RUNNING, IDLE, false, false, 1100)
    ).toBe(true);
    expect(state.pendingIdleConfirmations).toBe(2);
    // Third reading: published
    expect(
      shouldHoldWorkingToIdle(state, RUNNING, IDLE, false, false, 1200)
    ).toBe(false);
    expect(state.pendingIdleConfirmations).toBe(0); // reset
    expect(state.pendingIdleStartedAt).toBeNull(); // reset
  });

  it("does NOT debounce idle→idle (already idle)", () => {
    const state = createDebounceState();
    const hold = shouldHoldWorkingToIdle(state, IDLE, IDLE, false, false, 1000);
    expect(hold).toBe(false);
    expect(state.pendingIdleConfirmations).toBe(0);
  });

  it("does NOT debounce running→waiting (waiting is definitive)", () => {
    const state = createDebounceState();
    const hold = shouldHoldWorkingToIdle(
      state,
      RUNNING,
      "waiting",
      false,
      false,
      1000
    );
    expect(hold).toBe(false);
  });

  it("does NOT debounce running→error (error is definitive)", () => {
    const state = createDebounceState();
    const hold = shouldHoldWorkingToIdle(
      state,
      RUNNING,
      "error",
      false,
      false,
      1000
    );
    expect(hold).toBe(false);
  });

  it("does NOT debounce when agent changed (definitive transition)", () => {
    const state = createDebounceState();
    const hold = shouldHoldWorkingToIdle(
      state,
      RUNNING,
      IDLE,
      true,
      false,
      1000
    );
    expect(hold).toBe(false);
  });

  it("does NOT debounce when process exited (definitive transition)", () => {
    const state = createDebounceState();
    const hold = shouldHoldWorkingToIdle(
      state,
      RUNNING,
      IDLE,
      false,
      true,
      1000
    );
    expect(hold).toBe(false);
  });

  it("publishes after the cap timeout even without 3 confirmations", () => {
    const state = createDebounceState();
    // Start confirmation
    shouldHoldWorkingToIdle(state, RUNNING, IDLE, false, false, 1000);
    // Jump past the cap
    const capTime = 1000 + DEBOUNCE_CONFIG.PENDING_IDLE_CAP_MS + 1;
    const hold = shouldHoldWorkingToIdle(
      state,
      RUNNING,
      IDLE,
      false,
      false,
      capTime
    );
    expect(hold).toBe(false); // cap exceeded → publish
    expect(state.pendingIdleConfirmations).toBe(0);
  });

  it("resets confirmation when a non-idle transition arrives", () => {
    const state = createDebounceState();
    // Start idle confirmation
    shouldHoldWorkingToIdle(state, RUNNING, IDLE, false, false, 1000);
    expect(state.pendingIdleConfirmations).toBe(1);
    // A different transition arrives (idle→running, e.g. agent resumed)
    shouldHoldWorkingToIdle(state, IDLE, RUNNING, false, false, 1100);
    expect(state.pendingIdleConfirmations).toBe(0); // reset
  });
});

describe("isInStartupGrace", () => {
  it("returns true within the grace window", () => {
    const state = createDebounceState(1000);
    expect(isInStartupGrace(state, 1000 + 1000)).toBe(true); // 1s in
    expect(isInStartupGrace(state, 1000 + 2999)).toBe(true); // 2.999s in
  });

  it("returns false after the grace window expires", () => {
    const state = createDebounceState(1000);
    expect(isInStartupGrace(state, 1000 + 3001)).toBe(false); // 3.001s in
    expect(isInStartupGrace(state, 1000 + 10000)).toBe(false); // 10s in
  });

  it("grace window matches DEBOUNCE_CONFIG", () => {
    const state = createDebounceState(0);
    expect(isInStartupGrace(state, DEBOUNCE_CONFIG.STARTUP_GRACE_MS - 1)).toBe(
      true
    );
    expect(isInStartupGrace(state, DEBOUNCE_CONFIG.STARTUP_GRACE_MS + 1)).toBe(
      false
    );
  });
});

describe("createDebounceState", () => {
  it("starts with no pending idle confirmation", () => {
    const state = createDebounceState();
    expect(state.pendingIdleStartedAt).toBeNull();
    expect(state.pendingIdleConfirmations).toBe(0);
  });

  it("records firstSeenAt", () => {
    const state = createDebounceState(42000);
    expect(state.firstSeenAt).toBe(42000);
  });
});
