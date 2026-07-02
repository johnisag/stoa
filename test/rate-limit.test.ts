/**
 * Rate-limit auto-resume — pure-helper coverage.
 *
 * Locks the three load-bearing pure functions: detectRateLimit (provider
 * phrasings + no-false-positive on normal output), parseResetTime (relative AND
 * absolute forms, fail-closed), and nextRateLimitAction (the wait/resume/idle
 * matrix). No I/O — the server-side resume tick that consumes these is exercised
 * separately; here we guarantee the decisions are correct in isolation.
 */
import { describe, it, expect } from "vitest";
import {
  detectRateLimit,
  parseResetTime,
  nextRateLimitAction,
  parseResumeMaxPerDay,
  parseResumeFallbackMs,
  RESUME_MAX_PER_DAY,
  RESUME_FALLBACK_MS,
} from "../lib/rate-limit";

const NOW = Date.UTC(2026, 0, 1, 10, 0, 0); // fixed anchor for deterministic math

describe("detectRateLimit", () => {
  it("detects Claude's 5-hour limit phrasing", () => {
    const r = detectRateLimit("Claude usage limit reached. Try again at 3pm.");
    expect(r).not.toBeNull();
    expect(r?.reason).toMatch(/limit/i);
  });

  it("detects '5-hour limit reached'", () => {
    expect(detectRateLimit("5-hour limit reached")).not.toBeNull();
    expect(detectRateLimit("5 hour limit reached")).not.toBeNull();
  });

  it("detects an API 429 / too many requests envelope", () => {
    expect(
      detectRateLimit("Error 429: rate limit exceeded, too many requests")
    ).not.toBeNull();
    expect(detectRateLimit("HTTP 429 Too Many Requests")).not.toBeNull();
    // Only in an error/HTTP context — a bare phrase must NOT trip (false-positive
    // guard: an agent narrating about rate limiting in your code).
    expect(detectRateLimit("too many requests")).toBeNull();
  });

  it("detects a 'rate_limit_error … try again' envelope", () => {
    expect(
      detectRateLimit("{'type': 'rate_limit_error'} — please try again later")
    ).not.toBeNull();
  });

  it("detects 'you've reached your usage limit'", () => {
    expect(
      detectRateLimit("You've reached your usage limit for this period")
    ).not.toBeNull();
  });

  it("does NOT false-positive on normal agent output", () => {
    expect(
      detectRateLimit("I implemented the rate limiter you asked for")
    ).toBeNull();
    expect(detectRateLimit("Running tests... 42 passed")).toBeNull();
    expect(
      detectRateLimit("Here is a function that limits requests")
    ).toBeNull();
    expect(detectRateLimit("")).toBeNull();
    // A code-comment mention of a limit must not wedge a healthy session.
    expect(
      detectRateLimit("// TODO: handle the API rate limit gracefully")
    ).toBeNull();
    // "resets"/"try again" without a DIGIT after at/in must not trip.
    expect(detectRateLimit("the counter resets at midnight")).toBeNull();
    expect(detectRateLimit("Let me try again in a fresh approach")).toBeNull();
  });

  it("only looks at recent lines (old scrollback can't trip it)", () => {
    const old =
      "5-hour limit reached\n" + Array(40).fill("normal work").join("\n");
    expect(detectRateLimit(old)).toBeNull();
  });

  it("carries a parsed resetAt when the screen states one", () => {
    const r = detectRateLimit("Usage limit reached. Try again in 2h 5m.", NOW);
    expect(r?.resetAt).toBe(NOW + (2 * 3600 + 5 * 60) * 1000);
  });

  it("returns resetAt=null when no reset time is stated", () => {
    const r = detectRateLimit("rate limit exceeded, too many requests", NOW);
    expect(r).not.toBeNull();
    expect(r?.resetAt).toBeNull();
  });

  it("detects the error/rate-limit overlap screen AND parses its reset (#51 fixture)", () => {
    // The screen the status detector's precedence fix relies on: error wording
    // ("API Error", "Rate limit exceeded") + a limit notice with a reset time.
    // detectRateLimit must both match AND carry the parsed resetAt, so the
    // classifier can prefer the rate-limited (recoverable) classification.
    const screen = [
      '⎿ API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded."}}',
      "You've reached your usage limit. Your rate limit will reset at 3:30 pm.",
    ].join("\n");
    const r = detectRateLimit(screen, NOW);
    expect(r).not.toBeNull();
    expect(r?.resetAt).not.toBeNull();
    const d = new Date(r!.resetAt!);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(30);
    expect(r!.resetAt!).toBeGreaterThan(NOW);
  });
});

describe("parseResetTime — relative forms", () => {
  it("'try again in 2h 5m'", () => {
    expect(parseResetTime("try again in 2h 5m", NOW)).toBe(
      NOW + (2 * 3600 + 5 * 60) * 1000
    );
  });

  it("'in 43 minutes'", () => {
    expect(parseResetTime("available again in 43 minutes", NOW)).toBe(
      NOW + 43 * 60 * 1000
    );
  });

  it("'resets in 1 hour'", () => {
    expect(parseResetTime("resets in 1 hour", NOW)).toBe(NOW + 3600 * 1000);
  });

  it("'try again in 30 seconds'", () => {
    expect(parseResetTime("try again in 30 seconds", NOW)).toBe(
      NOW + 30 * 1000
    );
  });

  it("combined 'in 1h 30m 15s'", () => {
    expect(parseResetTime("back in 1h 30m 15s", NOW)).toBe(
      NOW + (3600 + 30 * 60 + 15) * 1000
    );
  });
});

describe("parseResetTime — absolute forms", () => {
  it("'try again at 3:00 PM' resolves to the next occurrence", () => {
    const got = parseResetTime("try again at 3:00 PM", NOW)!;
    const d = new Date(got);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(0);
    expect(got).toBeGreaterThan(NOW);
  });

  it("'at 15:30' (24h clock)", () => {
    const got = parseResetTime("try again at 15:30", NOW)!;
    const d = new Date(got);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(30);
  });

  it("rolls to tomorrow when the time already passed today", () => {
    // Anchor at local 23:00; "at 1:00 AM" must be tomorrow, not 22h in the past.
    const lateNight = new Date(2026, 0, 1, 23, 0, 0).getTime();
    const got = parseResetTime("try again at 1:00 AM", lateNight)!;
    expect(got).toBeGreaterThan(lateNight);
    expect(got - lateNight).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  it("'try again at 3pm' (no minutes)", () => {
    const got = parseResetTime("try again at 3pm", NOW)!;
    expect(new Date(got).getHours()).toBe(15);
  });

  it("ignores a bare 'at HH:MM' with no reset cue (no hijack by a stray timestamp)", () => {
    // Regression: an unrelated clock time must NOT pin resetAt.
    expect(
      parseResetTime("job started at 14:30 and is running", NOW)
    ).toBeNull();
    // But a reset-cued line elsewhere in the text still allows the colon form.
    const got = parseResetTime("usage limit reached. resets — at 14:30", NOW)!;
    expect(new Date(got).getHours()).toBe(14);
    expect(new Date(got).getMinutes()).toBe(30);
  });
});

describe("parseResetTime — fail-closed", () => {
  it("returns null when no reset phrase is present", () => {
    expect(parseResetTime("rate limit exceeded", NOW)).toBeNull();
    expect(parseResetTime("", NOW)).toBeNull();
    expect(parseResetTime("the build finished in record time", NOW)).toBeNull();
  });

  it("rejects an out-of-range clock time", () => {
    expect(parseResetTime("try again at 25:00", NOW)).toBeNull();
    expect(parseResetTime("try again at 13:00 PM", NOW)).toBeNull(); // 13 + pm invalid
    expect(parseResetTime("try again at 3:99", NOW)).toBeNull();
  });
});

describe("nextRateLimitAction", () => {
  it("not detected → idle", () => {
    expect(
      nextRateLimitAction({ detected: false, resetAtMs: null, nowMs: NOW })
    ).toBe("idle");
  });

  it("detected, no reset time → wait (hold, don't poke blindly)", () => {
    expect(
      nextRateLimitAction({ detected: true, resetAtMs: null, nowMs: NOW })
    ).toBe("wait");
  });

  it("detected, reset in the future → wait (counting down)", () => {
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: NOW + 60_000,
        nowMs: NOW,
      })
    ).toBe("wait");
  });

  it("detected, reset reached → resume", () => {
    expect(
      nextRateLimitAction({ detected: true, resetAtMs: NOW, nowMs: NOW })
    ).toBe("resume");
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: NOW - 1,
        nowMs: NOW,
      })
    ).toBe("resume");
  });

  it("a real prompt on screen → wait, even past reset (never resume INTO a dialog)", () => {
    // Resume would inject Enter / a queued task; firing that into an open prompt
    // would answer it. So a prompt forces "wait" regardless of the reset time.
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: NOW - 1,
        nowMs: NOW,
        hasPrompt: true,
      })
    ).toBe("wait");
    // Without a prompt the same past-reset state resumes (control).
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: NOW - 1,
        nowMs: NOW,
        hasPrompt: false,
      })
    ).toBe("resume");
  });

  it("busy (actively working) → wait, even past reset (still-parked skip)", () => {
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: NOW - 1,
        nowMs: NOW,
        busy: true,
      })
    ).toBe("wait");
    // Not busy → resumes (control).
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: NOW - 1,
        nowMs: NOW,
        busy: false,
      })
    ).toBe("resume");
  });

  it("daily budget spent → wait; under budget → resume", () => {
    const base = {
      detected: true,
      resetAtMs: NOW - 1,
      nowMs: NOW,
      maxPerDay: 3,
    };
    expect(nextRateLimitAction({ ...base, resumesUsedToday: 3 })).toBe("wait");
    expect(nextRateLimitAction({ ...base, resumesUsedToday: 4 })).toBe("wait");
    expect(nextRateLimitAction({ ...base, resumesUsedToday: 2 })).toBe(
      "resume"
    );
    // maxPerDay 0 = unlimited → never blocks on budget.
    expect(
      nextRateLimitAction({ ...base, maxPerDay: 0, resumesUsedToday: 999 })
    ).toBe("resume");
  });

  it("fallback: no parsed reset → resumes only once parkedAt + fallbackMs has passed", () => {
    const parkedAtMs = NOW - 10_000; // parked 10s ago
    // 5-min fallback not yet elapsed → wait.
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: null,
        nowMs: NOW,
        parkedAtMs,
        fallbackMs: 300_000,
      })
    ).toBe("wait");
    // Parked long enough (parkedAt + fallback <= now) → resume.
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: null,
        nowMs: NOW,
        parkedAtMs: NOW - 300_000,
        fallbackMs: 300_000,
      })
    ).toBe("resume");
    // Fallback off (0) → never resume without a parsed reset (today's behavior).
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: null,
        nowMs: NOW,
        parkedAtMs: NOW - 999_999,
        fallbackMs: 0,
      })
    ).toBe("wait");
  });

  it("a PARSED reset still wins over the fallback (fallback only fills the gap)", () => {
    // resetAt in the future → wait, even though parkedAt+fallback already passed.
    expect(
      nextRateLimitAction({
        detected: true,
        resetAtMs: NOW + 60_000,
        nowMs: NOW,
        parkedAtMs: NOW - 999_999,
        fallbackMs: 300_000,
      })
    ).toBe("wait");
  });
});

describe("resume hardening env defaults", () => {
  it("default daily cap is a generous 8, fallback is OFF (opt-in)", () => {
    expect(RESUME_MAX_PER_DAY).toBe(8);
    expect(RESUME_FALLBACK_MS).toBe(0);
  });
});

describe("parseResumeMaxPerDay (fails SAFE toward the cap)", () => {
  it("unset / empty / whitespace / garbage / negative → the safe default 8", () => {
    for (const v of [undefined, "", "   ", "abc", "NaN", "-5", "1e999x"]) {
      expect(parseResumeMaxPerDay(v)).toBe(8);
    }
  });

  it("an EXPLICIT 0 is unlimited; a sub-1 positive floors to 1; an integer is kept", () => {
    expect(parseResumeMaxPerDay("0")).toBe(0); // documented unlimited opt-out
    expect(parseResumeMaxPerDay("0.5")).toBe(1); // NOT silently unlimited
    expect(parseResumeMaxPerDay("0.001")).toBe(1);
    expect(parseResumeMaxPerDay("12")).toBe(12);
    expect(parseResumeMaxPerDay("3.9")).toBe(3); // floor
  });
});

describe("parseResumeFallbackMs (junk only disables it)", () => {
  it("unset / empty / garbage / negative → 0 (off)", () => {
    for (const v of [undefined, "", "abc", "-1"]) {
      expect(parseResumeFallbackMs(v)).toBe(0);
    }
  });

  it("a positive value is kept (floored)", () => {
    expect(parseResumeFallbackMs("300000")).toBe(300000);
    expect(parseResumeFallbackMs("0")).toBe(0);
    expect(parseResumeFallbackMs("1500.7")).toBe(1500);
  });
});
