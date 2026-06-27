/**
 * utcDay — the shared UTC calendar-day key (analytics per-day buckets + the
 * rate-limit per-day resume budget). Locks that it's UTC (not host-local), so the
 * day rolls at UTC midnight deterministically across the CI matrix.
 */
import { describe, it, expect } from "vitest";
import { utcDay } from "../lib/utc-day";

describe("utcDay", () => {
  it("is the UTC calendar day (locale/TZ-independent)", () => {
    expect(utcDay(Date.UTC(2026, 0, 1, 23, 59, 0))).toBe("2026-01-01");
    expect(utcDay(Date.UTC(2026, 0, 2, 0, 1, 0))).toBe("2026-01-02");
    // A late-UTC instant stays on its UTC day regardless of host TZ.
    expect(utcDay(Date.parse("2026-06-15T23:30:00Z"))).toBe("2026-06-15");
  });
});
