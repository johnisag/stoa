import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUndoableRunner, UNDO_DELAY_MS } from "@/lib/undoable-action";

const DELAY = 5000;

describe("createUndoableRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports a positive default grace window", () => {
    expect(UNDO_DELAY_MS).toBeGreaterThan(0);
  });

  it("schedule -> timeout executes exactly once", () => {
    const runner = createUndoableRunner({ delayMs: DELAY });
    const execute = vi.fn();

    runner.schedule("a", execute);
    expect(execute).not.toHaveBeenCalled();
    expect(runner.pending()).toEqual(["a"]);

    vi.advanceTimersByTime(DELAY - 1);
    expect(execute).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runner.pending()).toEqual([]);

    // No re-execution later.
    vi.advanceTimersByTime(DELAY * 3);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fires onScheduled once the timer is armed", () => {
    const runner = createUndoableRunner({ delayMs: DELAY });
    const onScheduled = vi.fn(() => {
      // The optimistic-hide hook runs while the action is already pending.
      expect(runner.pending()).toEqual(["a"]);
    });

    runner.schedule("a", vi.fn(), onScheduled);
    expect(onScheduled).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents execution and is idempotent", () => {
    const runner = createUndoableRunner({ delayMs: DELAY });
    const execute = vi.fn();

    runner.schedule("a", execute);
    runner.cancel("a");
    expect(runner.pending()).toEqual([]);

    vi.advanceTimersByTime(DELAY * 2);
    expect(execute).not.toHaveBeenCalled();

    // Second cancel + unknown id are no-ops.
    expect(() => runner.cancel("a")).not.toThrow();
    expect(() => runner.cancel("never-scheduled")).not.toThrow();
  });

  it("re-scheduling the same id flushes the predecessor first (no lost deletes)", () => {
    const runner = createUndoableRunner({ delayMs: DELAY });
    const first = vi.fn();
    const second = vi.fn();

    runner.schedule("a", first);
    vi.advanceTimersByTime(DELAY / 2);
    runner.schedule("a", second);

    // Predecessor ran immediately at replacement time.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(runner.pending()).toEqual(["a"]);

    // Replacement runs on ITS OWN full window, and the predecessor's original
    // timer must not double-fire anything.
    vi.advanceTimersByTime(DELAY - 1);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("flush executes immediately, cancels the timer, and is idempotent", () => {
    const runner = createUndoableRunner({ delayMs: DELAY });
    const execute = vi.fn();

    runner.schedule("a", execute);
    runner.flush("a");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runner.pending()).toEqual([]);

    // The armed timer must not fire a second execution.
    vi.advanceTimersByTime(DELAY * 2);
    expect(execute).toHaveBeenCalledTimes(1);

    // Second flush + unknown id are no-ops.
    expect(() => runner.flush("a")).not.toThrow();
    expect(() => runner.flush("never-scheduled")).not.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("concurrent ids are independent", () => {
    const runner = createUndoableRunner({ delayMs: DELAY });
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();

    runner.schedule("a", a);
    runner.schedule("b", b);
    runner.schedule("c", c);
    expect(runner.pending()).toEqual(["a", "b", "c"]);

    runner.cancel("a");
    runner.flush("b");
    expect(b).toHaveBeenCalledTimes(1);
    expect(runner.pending()).toEqual(["c"]);

    vi.advanceTimersByTime(DELAY);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("a throwing execute still settles the id (no re-fire, no stuck pending)", () => {
    const runner = createUndoableRunner({ delayMs: DELAY });
    const execute = vi.fn(() => {
      throw new Error("boom");
    });

    runner.schedule("a", execute);
    expect(() => runner.flush("a")).toThrow("boom");
    expect(runner.pending()).toEqual([]);

    vi.advanceTimersByTime(DELAY * 2);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
