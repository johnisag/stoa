/**
 * Centralized STOA_AUTO_* flags + the guarded-interval helper (#55).
 *
 * Locks:
 *  - getAutoFeatures() maps each STOA_AUTO_* flag to its typed boolean — a flag
 *    set to "1" → true, unset / "0" / garbage → false (the `=== "1"` posture the
 *    per-feature helpers all share).
 *  - anyTickEnabled() reflects the status-ticker-driving subset only.
 *  - describeEnabled() summarizes the ON flags (and "none" when all off).
 *  - makeGuardedInterval() fires on cadence, re-entrancy-guards an overlapping
 *    async tick, arms nothing when disabled, runs once at startup when asked, and
 *    unref()s the timer (opt-out honored). Fake timers throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAutoFeatures,
  anyTickEnabled,
  describeEnabled,
  makeGuardedInterval,
  perTurnSnapshotsEnabled,
  type AutoFeatures,
} from "@/lib/auto-features";

// Every STOA_ flag getAutoFeatures reads — snapshotted and restored so a test
// never leaks env into a sibling test file.
const FLAG_ENV = [
  "STOA_AUTO_RESUME",
  "STOA_AUTO_ANSWER",
  "STOA_PUSH_APPROVE",
  "STOA_ERROR_LOOP",
  "STOA_AUTO_WATCHDOG",
  "STOA_AUTO_CHANNEL_DELIVER",
  "STOA_AUTO_COST_SAMPLE",
  "STOA_AUTO_COMPACT",
  "STOA_COMPACT_MEMORY",
  "STOA_SNAPSHOTS",
] as const;

describe("getAutoFeatures", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of FLAG_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of FLAG_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("reads every flag as false when unset", () => {
    const f = getAutoFeatures();
    expect(f).toEqual({
      resume: false,
      answer: false,
      pushApprove: false,
      errorLoop: false,
      watchdog: false,
      channelDeliver: false,
      costSample: false,
      compact: false,
      compactMemory: false,
      snapshots: false,
    } satisfies AutoFeatures);
  });

  it("maps a flag set to '1' to its typed boolean", () => {
    process.env.STOA_AUTO_RESUME = "1";
    process.env.STOA_AUTO_COMPACT = "1";
    const f = getAutoFeatures();
    expect(f.resume).toBe(true);
    expect(f.compact).toBe(true);
    // Untouched flags stay false.
    expect(f.answer).toBe(false);
    expect(f.watchdog).toBe(false);
  });

  it("treats '0', 'true', and garbage as OFF (only '1' arms)", () => {
    process.env.STOA_AUTO_WATCHDOG = "0";
    process.env.STOA_AUTO_ANSWER = "true";
    process.env.STOA_ERROR_LOOP = "yes";
    process.env.STOA_AUTO_CHANNEL_DELIVER = " 1 "; // whitespace ≠ "1"
    const f = getAutoFeatures();
    expect(f.watchdog).toBe(false);
    expect(f.answer).toBe(false);
    expect(f.errorLoop).toBe(false);
    expect(f.channelDeliver).toBe(false);
  });

  it("perTurnSnapshotsEnabled tracks STOA_SNAPSHOTS", () => {
    expect(perTurnSnapshotsEnabled()).toBe(false);
    process.env.STOA_SNAPSHOTS = "1";
    expect(perTurnSnapshotsEnabled()).toBe(true);
    expect(getAutoFeatures().snapshots).toBe(true);
  });
});

const ALL_OFF: AutoFeatures = {
  resume: false,
  answer: false,
  pushApprove: false,
  errorLoop: false,
  watchdog: false,
  channelDeliver: false,
  costSample: false,
  compact: false,
  compactMemory: false,
  snapshots: false,
};

describe("anyTickEnabled", () => {
  it("is false when every flag is off", () => {
    expect(anyTickEnabled(ALL_OFF)).toBe(false);
  });

  it("is true for any status-ticker-driving flag", () => {
    for (const k of [
      "snapshots",
      "resume",
      "answer",
      "errorLoop",
      "watchdog",
      "channelDeliver",
    ] as const) {
      expect(anyTickEnabled({ ...ALL_OFF, [k]: true })).toBe(true);
    }
  });

  it("is NOT driven by the DB-only loops (cost sample / compact)", () => {
    // These run on their own timers, not the screen-capturing status tick.
    expect(anyTickEnabled({ ...ALL_OFF, costSample: true })).toBe(false);
    expect(anyTickEnabled({ ...ALL_OFF, compact: true })).toBe(false);
    expect(anyTickEnabled({ ...ALL_OFF, compactMemory: true })).toBe(false);
    expect(anyTickEnabled({ ...ALL_OFF, pushApprove: true })).toBe(false);
  });
});

describe("describeEnabled", () => {
  it("returns 'none' when everything is off", () => {
    expect(describeEnabled(ALL_OFF)).toBe("none");
  });

  it("lists the enabled features in a stable order", () => {
    expect(
      describeEnabled({
        ...ALL_OFF,
        resume: true,
        watchdog: true,
        compact: true,
      })
    ).toBe("auto-resume, watchdog, auto-compact");
  });

  it("lists every ON flag (a faithful mirror of the posture)", () => {
    const all: AutoFeatures = {
      resume: true,
      answer: true,
      pushApprove: true,
      errorLoop: true,
      watchdog: true,
      channelDeliver: true,
      costSample: true,
      compact: true,
      compactMemory: true,
      snapshots: true,
    };
    expect(describeEnabled(all)).toBe(
      "auto-resume, auto-answer, push-approve, error-loop, watchdog, channel-deliver, cost-sample, auto-compact, compact-memory, snapshots"
    );
  });
});

describe("makeGuardedInterval", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("fires the tick every intervalMs", async () => {
    const tick = vi.fn();
    const h = makeGuardedInterval({ intervalMs: 1000, tick });
    expect(tick).not.toHaveBeenCalled();
    // advanceTimersByTimeAsync drains the microtask that clears the busy-guard
    // between ticks (run() is always async, so even a sync tick releases the
    // guard on a microtask — in production real ticks are seconds apart, so the
    // guard is always clear by the next fire).
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(3);
    h.stop();
  });

  it("arms NO timer when disabled (tick never fires)", () => {
    const tick = vi.fn();
    const h = makeGuardedInterval({ intervalMs: 1000, enabled: false, tick });
    expect(h.timer).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
    // stop() is a safe no-op when nothing was armed.
    expect(() => h.stop()).not.toThrow();
  });

  it("re-entrancy guard blocks an overlapping async tick", async () => {
    let active = 0;
    let maxConcurrent = 0;
    let calls = 0;
    // A slow async tick: it stays "in flight" across two interval periods.
    let release!: () => void;
    const tick = vi.fn(async () => {
      calls++;
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise<void>((res) => {
        release = res;
      });
      active--;
    });
    const h = makeGuardedInterval({ intervalMs: 1000, tick });

    // Tick 1 starts and blocks (in flight).
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    // Tick 2 fires while tick 1 is still running → the guard SKIPS it.
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1); // not 2 — the overlapping tick was blocked
    expect(maxConcurrent).toBe(1); // never two in flight at once

    // Let tick 1 finish; a later interval can run again.
    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    // The next tick blocks again on a fresh promise; it DID start (guard released).
    expect(calls).toBe(2);
    release();
    h.stop();
  });

  it("runs once at startup when runAtStartup is set", async () => {
    const tick = vi.fn();
    const h = makeGuardedInterval({
      intervalMs: 10_000,
      runAtStartup: true,
      tick,
    });
    // Startup run is scheduled as a microtask (void run()); flush it.
    await Promise.resolve();
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1);
    // And it still fires on cadence afterward.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("routes a rejected tick to onError (never an unhandled rejection)", async () => {
    const onError = vi.fn();
    const boom = new Error("boom");
    const tick = vi.fn(async () => {
      throw boom;
    });
    const h = makeGuardedInterval({ intervalMs: 1000, tick, onError });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith(boom);
    // The guard released despite the throw → the next tick still fires.
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("stop() clears the interval (no further ticks)", async () => {
    const tick = vi.fn();
    const h = makeGuardedInterval({ intervalMs: 1000, tick });
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    h.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1); // no more ticks after stop
  });

  it("unref()s the timer by default and opts out when unref:false", () => {
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as NodeJS.Timeout;
    const spy = vi
      .spyOn(global, "setInterval")
      .mockReturnValue(fakeTimer as unknown as ReturnType<typeof setInterval>);
    try {
      makeGuardedInterval({ intervalMs: 1000, tick: () => {} });
      expect(unref).toHaveBeenCalledTimes(1);

      unref.mockClear();
      makeGuardedInterval({ intervalMs: 1000, unref: false, tick: () => {} });
      expect(unref).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
