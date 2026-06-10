/**
 * Error-loop nudge — the pure core. Locks the signature normalization (the same
 * error must match across turns despite volatile offsets/ids) and the decision
 * matrix (a productively-iterating agent is NEVER nudged; one nudge per error).
 */
import { describe, it, expect } from "vitest";
import {
  normalizeErrorSig,
  nextErrorLoopAction,
  buildNudgeMessage,
  type LoopTrack,
} from "../lib/error-loop";

describe("normalizeErrorSig", () => {
  it("is stable across volatile bits (offsets, ids, paths, durations)", () => {
    const a = normalizeErrorSig(
      "Error code: 429 invalid_request_error at /src/foo.ts:12 (req_abc123, 1.4s)"
    );
    const b = normalizeErrorSig(
      "Error code: 429 invalid_request_error at /src/bar.ts:88 (req_zzz999, 9.1s)"
    );
    expect(a).toBe(b);
    expect(a).toContain("error code");
    expect(a).toContain("invalid_request_error");
  });

  it("distinguishes genuinely different errors", () => {
    expect(normalizeErrorSig("insufficient_quota")).not.toBe(
      normalizeErrorSig("connection refused")
    );
  });

  it("returns empty for an empty line", () => {
    expect(normalizeErrorSig("")).toBe("");
  });
});

describe("nextErrorLoopAction", () => {
  const base = {
    isError: true,
    rateLimited: false,
    signature: "boom",
    prev: undefined as LoopTrack | undefined,
    threshold: 3,
    nudgeArmed: true,
  };

  it("clears tracking when not a (non-rate-limited) error with a signature", () => {
    for (const over of [
      { isError: false },
      { rateLimited: true },
      { signature: "" },
    ]) {
      const r = nextErrorLoopAction({ ...base, ...over });
      expect(r.action).toBe("idle");
      expect(r.next).toBeNull();
    }
  });

  it("tracks a fresh error and counts consecutive same-signature ticks", () => {
    const t1 = nextErrorLoopAction(base);
    expect(t1).toEqual({
      action: "track",
      next: { sig: "boom", count: 1, nudged: false },
    });
    const t2 = nextErrorLoopAction({ ...base, prev: t1.next! });
    expect(t2.action).toBe("track");
    expect(t2.next).toMatchObject({ count: 2 });
  });

  it("nudges ONCE when the same error sticks to the threshold", () => {
    const prev: LoopTrack = { sig: "boom", count: 2, nudged: false };
    const r = nextErrorLoopAction({ ...base, prev });
    expect(r.action).toBe("nudge");
    expect(r.next).toMatchObject({ count: 3, nudged: true });
    // Next tick, still stuck on the same error → escalate (don't re-nudge).
    const r2 = nextErrorLoopAction({ ...base, prev: r.next! });
    expect(r2.action).toBe("escalate");
  });

  it("escalates instead of nudging when not armed", () => {
    const prev: LoopTrack = { sig: "boom", count: 2, nudged: false };
    expect(
      nextErrorLoopAction({ ...base, prev, nudgeArmed: false }).action
    ).toBe("escalate");
  });

  it("a DIFFERENT error resets the count + re-arms the nudge (productive iteration)", () => {
    const prev: LoopTrack = { sig: "boom", count: 9, nudged: true };
    const r = nextErrorLoopAction({ ...base, signature: "kapow", prev });
    expect(r.action).toBe("track");
    expect(r.next).toEqual({ sig: "kapow", count: 1, nudged: false });
  });
});

describe("buildNudgeMessage", () => {
  it("is benign advisory text — tells the agent to change tack, approves nothing", () => {
    const m = buildNudgeMessage().toLowerCase();
    expect(m).toContain("different");
    expect(m).toMatch(/stop|step back/);
    // It must not instruct a destructive/approval action.
    expect(m).not.toMatch(/\b(yes|allow|rm -rf|force|delete)\b/);
  });
});
