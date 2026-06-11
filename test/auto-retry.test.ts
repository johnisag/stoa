/**
 * Pure-core coverage for the interactive auto-retry: classify a final rendered
 * screen as a TRANSIENT failure worth retrying (rate-limit OR a narrow network
 * envelope — never a normal prompt or a real bug), and the conservative backoff
 * schedule + cap that keep it from ever becoming a tight loop.
 */
import { describe, it, expect } from "vitest";
import {
  isTransientFailure,
  nextRetryDelay,
  shouldKeepRetrying,
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_BASE_DELAY_MS,
  AUTO_RETRY_MAX_DELAY_MS,
} from "@/lib/auto-retry";

describe("isTransientFailure", () => {
  it("matches narrow network/transport error envelopes", () => {
    for (const s of [
      "Error: read ECONNRESET",
      "fetch failed",
      "socket hang up",
      "connection reset by peer",
      "503 Service Unavailable",
      "request timed out",
      "overloaded_error: server is overloaded",
    ]) {
      expect(isTransientFailure(s)).toBe(true);
    }
  });

  it("does NOT trip on normal output or a real (non-transient) failure", () => {
    for (const s of [
      "Here is your refactored function.",
      "TypeError: cannot read property 'x' of undefined",
      "Permission denied",
      "504", // a bare number with no error wording
      "let timeout = setTimeout(fn, 100)", // discussing timeouts in code
      "the connection pooling logic looks fine",
      "",
    ]) {
      expect(isTransientFailure(s)).toBe(false);
    }
  });

  it("only scans the recent tail — old scrollback can't trip it", () => {
    const old =
      "fetch failed\n" + Array(20).fill("normal agent output line").join("\n");
    expect(isTransientFailure(old)).toBe(false);
  });
});

describe("nextRetryDelay", () => {
  it("backs off exponentially from the base, clamped to the ceiling", () => {
    expect(nextRetryDelay(1)).toBe(AUTO_RETRY_BASE_DELAY_MS); // 5s
    expect(nextRetryDelay(2)).toBe(AUTO_RETRY_BASE_DELAY_MS * 2); // 10s
    expect(nextRetryDelay(3)).toBe(AUTO_RETRY_BASE_DELAY_MS * 4); // 20s
    expect(nextRetryDelay(4)).toBe(AUTO_RETRY_BASE_DELAY_MS * 8); // 40s
    expect(nextRetryDelay(5)).toBe(AUTO_RETRY_MAX_DELAY_MS); // clamped at 60s
    expect(nextRetryDelay(100)).toBe(AUTO_RETRY_MAX_DELAY_MS); // never runs away
  });

  it("treats a garbage/non-positive attempt as the first", () => {
    expect(nextRetryDelay(0)).toBe(AUTO_RETRY_BASE_DELAY_MS);
    expect(nextRetryDelay(-3)).toBe(AUTO_RETRY_BASE_DELAY_MS);
    expect(nextRetryDelay(NaN)).toBe(AUTO_RETRY_BASE_DELAY_MS);
  });
});

describe("shouldKeepRetrying", () => {
  it("keeps going up to the cap, then stops (no infinite loop)", () => {
    expect(shouldKeepRetrying(1)).toBe(true);
    expect(shouldKeepRetrying(AUTO_RETRY_MAX_ATTEMPTS)).toBe(true);
    expect(shouldKeepRetrying(AUTO_RETRY_MAX_ATTEMPTS + 1)).toBe(false);
  });

  it("rejects a garbage attempt count (fails closed)", () => {
    expect(shouldKeepRetrying(0)).toBe(false);
    expect(shouldKeepRetrying(NaN)).toBe(false);
    expect(shouldKeepRetrying(1, NaN)).toBe(false);
  });
});
