/**
 * Error-loop escalation — the pure core. Locks the signature normalization (the same
 * error matches across turns despite volatile offsets/ids; two different errors stay
 * distinct) and the decision matrix (escalate once per stuck error; a progressing
 * agent — different error each turn — never escalates; rate-limited never escalates).
 */
import { describe, it, expect } from "vitest";
import {
  normalizeErrorSig,
  nextErrorLoopAction,
  buildLoopPushBody,
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

  it("keeps two genuinely different errors distinct, incl. ones with a contraction + quotes", () => {
    // The matched-quote fix: a lone apostrophe must NOT swallow the message.
    const out = normalizeErrorSig(
      "You're out of memory. Add more at 'console.example.com/buy'"
    );
    const mem = normalizeErrorSig(
      "You're out of extra usage. Add more at 'console.example.com/buy'"
    );
    expect(out).not.toBe(mem); // "memory" vs "extra usage" survive
    expect(out).toContain("memory");
    expect(mem).toContain("usage");
  });

  it("normalizes a Windows path the same way regardless of the path", () => {
    const a = normalizeErrorSig("Cannot read C:\\Users\\a\\proj\\file.ts:12");
    const b = normalizeErrorSig("Cannot read C:\\Users\\b\\other\\thing.ts:88");
    expect(a).toBe(b);
    expect(a).toContain("cannot read");
  });

  it("returns empty for box-drawing chrome and an empty line", () => {
    expect(normalizeErrorSig("╰─────────╯")).toBe("");
    expect(normalizeErrorSig("")).toBe("");
  });
});

describe("nextErrorLoopAction", () => {
  const base = {
    isError: true,
    rateLimited: false,
    signature: "boom",
    nowMs: 0,
    prev: undefined as LoopTrack | undefined,
    threshold: 3,
    minWindowMs: 90_000,
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
    expect(t1.action).toBe("track");
    expect(t1.next).toMatchObject({ sig: "boom", count: 1, escalated: false });
    const t2 = nextErrorLoopAction({ ...base, nowMs: 2500, prev: t1.next! });
    expect(t2.action).toBe("track");
    expect(t2.next).toMatchObject({ count: 2 });
  });

  it("escalates ONCE only when BOTH the count AND the time window are met", () => {
    // count reached (3) but only 10s elapsed → not yet.
    let prev: LoopTrack = {
      sig: "boom",
      count: 2,
      firstMs: 0,
      lastMs: 10_000,
      escalated: false,
    };
    const early = nextErrorLoopAction({ ...base, nowMs: 10_000, prev });
    expect(early.action).toBe("track");

    // count AND window both met → escalate.
    prev = {
      sig: "boom",
      count: 5,
      firstMs: 0,
      lastMs: 90_000,
      escalated: false,
    };
    const hit = nextErrorLoopAction({ ...base, nowMs: 95_000, prev });
    expect(hit.action).toBe("escalate");
    expect(hit.next).toMatchObject({ escalated: true });

    // next tick, still stuck → track (page once, never twice).
    const after = nextErrorLoopAction({
      ...base,
      nowMs: 97_500,
      prev: hit.next!,
    });
    expect(after.action).toBe("track");
  });

  it("a DIFFERENT error starts a fresh track (a progressing agent never escalates)", () => {
    const prev: LoopTrack = {
      sig: "boom",
      count: 50,
      firstMs: 0,
      lastMs: 200_000,
      escalated: true,
    };
    const r = nextErrorLoopAction({
      ...base,
      signature: "kapow",
      nowMs: 202_500,
      prev,
    });
    expect(r.action).toBe("track");
    expect(r.next).toEqual({
      sig: "kapow",
      count: 1,
      firstMs: 202_500,
      lastMs: 202_500,
      escalated: false,
    });
  });
});

describe("buildLoopPushBody", () => {
  it("states the session + roughly how long it's been stuck", () => {
    const body = buildLoopPushBody("auth-worker", {
      sig: "boom",
      count: 40,
      firstMs: 0,
      lastMs: 120_000,
      escalated: true,
    });
    expect(body).toContain("auth-worker");
    expect(body).toMatch(/loop/i);
    expect(body).toContain("2m");
  });
});
