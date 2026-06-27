/**
 * sqliteTimeToMs — the shared SQLite-datetime parser (analytics + watchdog). Locks
 * the one thing that matters: a bare `datetime('now')` value is UTC, so it must
 * parse as UTC, never host-local (which would skew every age/duration by the UTC
 * offset). Includes the fractional-seconds form a strict "ends in :SS" regex would
 * have mis-parsed as local time.
 */
import { describe, it, expect } from "vitest";
import { sqliteTimeToMs } from "../lib/sqlite-time";

describe("sqliteTimeToMs", () => {
  it("treats a bare SQLite datetime as UTC (not host-local)", () => {
    expect(sqliteTimeToMs("2026-06-27 12:00:00")).toBe(
      Date.parse("2026-06-27T12:00:00Z")
    );
  });

  it("parses a fractional-seconds value as UTC too (no local-time skew)", () => {
    expect(sqliteTimeToMs("2026-06-27 12:00:00.123")).toBe(
      Date.parse("2026-06-27T12:00:00.123Z")
    );
  });

  it("passes an already-ISO value (containing a T) through untouched", () => {
    expect(sqliteTimeToMs("2026-06-27T12:00:00Z")).toBe(
      Date.parse("2026-06-27T12:00:00Z")
    );
  });

  it("returns null for null / undefined / empty / garbage", () => {
    expect(sqliteTimeToMs(null)).toBeNull();
    expect(sqliteTimeToMs(undefined)).toBeNull();
    expect(sqliteTimeToMs("")).toBeNull();
    expect(sqliteTimeToMs("not a date")).toBeNull();
  });
});
