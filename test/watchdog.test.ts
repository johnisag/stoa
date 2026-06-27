/**
 * Self-healing watchdog — the pure core. Locks the two decision surfaces:
 *   A. isWorkerHung / workerMaxAgeMs — the Dispatch age reaper fails CLOSED
 *      (disarmed, or an unparseable/missing start, never reaps).
 *   B. nextStuckAction — a session escalates ONCE only after staying "running"
 *      continuously past the ceiling; any non-running tick OR an unobserved gap
 *      resets the streak, so a normally-iterating agent never pages.
 * (The shared SQLite-time parser is covered separately in sqlite-time.test.ts.)
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  isWorkerHung,
  workerMaxAgeMs,
  nextStuckAction,
  buildStuckPushBody,
  WATCHDOG_STUCK_MS,
  watchdogEnabled,
  type StuckTrack,
} from "../lib/watchdog";

describe("workerMaxAgeMs", () => {
  afterEach(() => {
    delete process.env.STOA_DISPATCH_WORKER_MAX_AGE_MS;
  });

  it("defaults to 0 (reaper disarmed) when unset", () => {
    expect(workerMaxAgeMs()).toBe(0);
  });

  it("parses a positive integer", () => {
    process.env.STOA_DISPATCH_WORKER_MAX_AGE_MS = "7200000";
    expect(workerMaxAgeMs()).toBe(7_200_000);
  });

  it("falls back to 0 (off) on garbage or non-positive values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.STOA_DISPATCH_WORKER_MAX_AGE_MS = v;
      expect(workerMaxAgeMs()).toBe(0);
    }
  });
});

describe("isWorkerHung", () => {
  it("never reaps when the reaper is disarmed (maxAgeMs <= 0)", () => {
    expect(
      isWorkerHung({ dispatchedAtMs: 0, nowMs: 10_000_000, maxAgeMs: 0 })
    ).toBe(false);
  });

  it("never reaps when the start time is unknown (fails closed)", () => {
    expect(
      isWorkerHung({ dispatchedAtMs: null, nowMs: 10_000_000, maxAgeMs: 1000 })
    ).toBe(false);
    expect(
      isWorkerHung({ dispatchedAtMs: NaN, nowMs: 10_000_000, maxAgeMs: 1000 })
    ).toBe(false);
  });

  it("reaps only once age >= maxAgeMs", () => {
    const maxAgeMs = 7_200_000; // 2h
    const dispatchedAtMs = 1_000_000;
    // 1h59m in → not yet.
    expect(
      isWorkerHung({
        dispatchedAtMs,
        nowMs: dispatchedAtMs + 7_199_000,
        maxAgeMs,
      })
    ).toBe(false);
    // exactly 2h → hung (boundary inclusive).
    expect(
      isWorkerHung({
        dispatchedAtMs,
        nowMs: dispatchedAtMs + maxAgeMs,
        maxAgeMs,
      })
    ).toBe(true);
    // 3h in → hung.
    expect(
      isWorkerHung({
        dispatchedAtMs,
        nowMs: dispatchedAtMs + 10_800_000,
        maxAgeMs,
      })
    ).toBe(true);
  });
});

describe("nextStuckAction", () => {
  const base = {
    isRunning: true,
    nowMs: 0,
    prev: undefined as StuckTrack | undefined,
    stuckMs: 1_800_000, // 30 min
    maxGapMs: 60_000, // 60s — continuous-observation tolerance
  };

  it("clears tracking the moment a session is not running (turn boundary)", () => {
    const prev: StuckTrack = {
      firstMs: 0,
      lastMs: 1_000_000,
      escalated: false,
    };
    const r = nextStuckAction({
      ...base,
      isRunning: false,
      nowMs: 1_000_000,
      prev,
    });
    expect(r.action).toBe("idle");
    expect(r.next).toBeNull();
  });

  it("never pages a rate-limited session (its countdown can read as running)", () => {
    // Long running streak, but it's rate-limited → cleared, not escalated. The
    // resume loop owns this case; a limit window isn't a wedge.
    const prev: StuckTrack = {
      firstMs: 0,
      lastMs: 1_799_000,
      escalated: false,
    };
    const r = nextStuckAction({
      ...base,
      isRunning: true,
      rateLimited: true,
      nowMs: 1_800_000,
      prev,
    });
    expect(r.action).toBe("idle");
    expect(r.next).toBeNull();
  });

  it("starts a fresh streak and tracks while under the ceiling", () => {
    const t1 = nextStuckAction(base);
    expect(t1.action).toBe("track");
    expect(t1.next).toEqual({ firstMs: 0, lastMs: 0, escalated: false });

    const t2 = nextStuckAction({ ...base, nowMs: 2500, prev: t1.next! });
    expect(t2.action).toBe("track");
    expect(t2.next).toMatchObject({ firstMs: 0, lastMs: 2500 });
  });

  it("escalates ONCE after running continuously past the ceiling", () => {
    // 29m59s in → not yet.
    const early = nextStuckAction({
      ...base,
      nowMs: 1_799_000,
      prev: { firstMs: 0, lastMs: 1_796_500, escalated: false },
    });
    expect(early.action).toBe("track");

    // exactly the ceiling → escalate, and mark escalated.
    const hit = nextStuckAction({
      ...base,
      nowMs: 1_800_000,
      prev: { firstMs: 0, lastMs: 1_797_500, escalated: false },
    });
    expect(hit.action).toBe("escalate");
    expect(hit.next).toMatchObject({ escalated: true });

    // still running next tick → track (page once, never twice).
    const after = nextStuckAction({
      ...base,
      nowMs: 1_802_500,
      prev: hit.next!,
    });
    expect(after.action).toBe("track");
  });

  it("a turn boundary resets the streak so a normally-iterating agent never pages", () => {
    // Long streak, but it settled (idle) → cleared.
    const settled = nextStuckAction({
      ...base,
      isRunning: false,
      nowMs: 1_900_000,
      prev: { firstMs: 0, lastMs: 1_800_000, escalated: false },
    });
    expect(settled.next).toBeNull();
    // Next running tick starts a brand-new streak from now (not the old firstMs).
    const fresh = nextStuckAction({
      ...base,
      nowMs: 1_902_500,
      prev: undefined,
    });
    expect(fresh.next).toEqual({
      firstMs: 1_902_500,
      lastMs: 1_902_500,
      escalated: false,
    });
  });

  it("restarts the streak across an UNOBSERVED gap (starved tick / host sleep / clock step)", () => {
    // A streak began at 0, last observed at 2500 — then no ticks for ~40m (the
    // host slept / the tick was starved). We did NOT watch it run continuously,
    // so the streak restarts from now and does NOT escalate on the stale firstMs.
    const prev: StuckTrack = { firstMs: 0, lastMs: 2500, escalated: false };
    const r = nextStuckAction({ ...base, nowMs: 2_400_000, prev });
    expect(r.action).toBe("track"); // crucially NOT "escalate"
    expect(r.next).toEqual({
      firstMs: 2_400_000,
      lastMs: 2_400_000,
      escalated: false,
    });
  });

  it("restarts the streak on a BACKWARD clock step (now < last observed)", () => {
    const prev: StuckTrack = {
      firstMs: 1_000_000,
      lastMs: 1_700_000,
      escalated: false,
    };
    // Wall clock stepped back below lastMs → can't trust the streak → restart.
    const r = nextStuckAction({ ...base, nowMs: 1_650_000, prev });
    expect(r.action).toBe("track");
    expect(r.next).toEqual({
      firstMs: 1_650_000,
      lastMs: 1_650_000,
      escalated: false,
    });
  });
});

describe("buildStuckPushBody", () => {
  it("states the session + roughly how long it's been running", () => {
    const body = buildStuckPushBody("auth-worker", {
      firstMs: 0,
      lastMs: 1_800_000,
      escalated: true,
    });
    expect(body).toContain("auth-worker");
    expect(body).toMatch(/stuck|settl/i);
    expect(body).toContain("30m");
  });
});

describe("env defaults", () => {
  it("WATCHDOG_STUCK_MS defaults to 30 min when unset", () => {
    expect(WATCHDOG_STUCK_MS).toBe(1_800_000);
  });

  it("watchdogEnabled is off unless STOA_AUTO_WATCHDOG=1", () => {
    expect(watchdogEnabled()).toBe(false);
  });
});
