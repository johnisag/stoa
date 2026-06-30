import { describe, it, expect } from "vitest";
import {
  parseWindowRecord,
  windowUtilization,
  isWindowStale,
  WINDOW_STALE_MS,
  type RateLimitWindowRecord,
} from "@/lib/rate-limit-window";

const NOW = 1_000_000_000;

function record(
  over: Partial<RateLimitWindowRecord> = {}
): RateLimitWindowRecord {
  return { fiveHourPct: 0.5, sevenDayPct: 0.2, updatedAt: NOW, ...over };
}

describe("isWindowStale (#M2a)", () => {
  it("fresh data is not stale; data past the horizon is", () => {
    expect(isWindowStale(record({ updatedAt: NOW }), NOW)).toBe(false);
    expect(
      isWindowStale(record({ updatedAt: NOW - WINDOW_STALE_MS - 1 }), NOW)
    ).toBe(true);
  });

  it("a non-finite updatedAt is treated as stale (fail-closed)", () => {
    expect(isWindowStale(record({ updatedAt: NaN }), NOW)).toBe(true);
  });
});

describe("windowUtilization (#M2a — binding constraint, fail-closed)", () => {
  it("takes the MAX of the known windows (whichever you hit first)", () => {
    const w = windowUtilization(
      record({ fiveHourPct: 0.4, sevenDayPct: 0.85 }),
      NOW
    );
    expect(w?.pct).toBeCloseTo(0.85);
    expect(w?.tone).toBe("warn");
  });

  it("bands: ok < 0.7, warn 0.7–0.9, full >= 0.9", () => {
    expect(
      windowUtilization(record({ fiveHourPct: 0.5, sevenDayPct: 0 }), NOW)?.tone
    ).toBe("ok");
    expect(
      windowUtilization(record({ fiveHourPct: 0.75, sevenDayPct: 0 }), NOW)
        ?.tone
    ).toBe("warn");
    expect(
      windowUtilization(record({ fiveHourPct: 0.95, sevenDayPct: 0 }), NOW)
        ?.tone
    ).toBe("full");
  });

  it("clamps to 1 and carries resetAt", () => {
    const w = windowUtilization(record({ fiveHourPct: 1.5, resetAt: 42 }), NOW);
    expect(w?.pct).toBe(1);
    expect(w?.resetAt).toBe(42);
  });

  it("is null when stale, empty, or has no usable window (fail-closed)", () => {
    expect(
      windowUtilization(record({ updatedAt: NOW - WINDOW_STALE_MS - 1 }), NOW)
    ).toBeNull();
    expect(windowUtilization(null, NOW)).toBeNull();
    expect(
      windowUtilization({ updatedAt: NOW }, NOW) // no percentages at all
    ).toBeNull();
    expect(
      windowUtilization(
        record({ fiveHourPct: -1, sevenDayPct: undefined }),
        NOW
      )
    ).toBeNull();
  });
});

describe("parseWindowRecord (#M2a — fail-closed)", () => {
  it("parses a well-formed record", () => {
    expect(
      parseWindowRecord(
        JSON.stringify({
          fiveHourPct: 0.3,
          sevenDayPct: 0.1,
          resetAt: 7,
          updatedAt: NOW,
        })
      )
    ).toEqual({
      fiveHourPct: 0.3,
      sevenDayPct: 0.1,
      resetAt: 7,
      updatedAt: NOW,
    });
  });

  it("is null for empty/malformed/non-object/missing-updatedAt", () => {
    expect(parseWindowRecord(null)).toBeNull();
    expect(parseWindowRecord("")).toBeNull();
    expect(parseWindowRecord("{not json")).toBeNull();
    expect(parseWindowRecord("42")).toBeNull();
    expect(parseWindowRecord(JSON.stringify({ fiveHourPct: 0.5 }))).toBeNull(); // no updatedAt
  });

  it("coerces bad bucket values to undefined but keeps a valid updatedAt", () => {
    const r = parseWindowRecord(
      JSON.stringify({ fiveHourPct: "high", sevenDayPct: NaN, updatedAt: NOW })
    );
    expect(r).toEqual({
      fiveHourPct: undefined,
      sevenDayPct: undefined,
      resetAt: null,
      updatedAt: NOW,
    });
  });
});
