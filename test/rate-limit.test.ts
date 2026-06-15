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
});
