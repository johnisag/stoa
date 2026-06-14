import { describe, it, expect } from "vitest";

import { parseDbTimestamp } from "@/components/QuickSwitcher";

// Regression test for B011: QuickSwitcher.formatTime parsed a SQLite
// datetime("now") value (naive UTC, no zone — "YYYY-MM-DD HH:MM:SS") with a
// bare `new Date(dateStr)`. JS treats a space-separated, offset-less string as
// LOCAL time, so "Xm ago" was skewed by the viewer's TZ offset. The fix mirrors
// SessionCard.getTimeAgo: a zone-less value is interpreted as UTC.

describe("parseDbTimestamp treats zone-less SQLite timestamps as UTC", () => {
  it("parses a naive 'YYYY-MM-DD HH:MM:SS' string as UTC, not local", () => {
    const d = parseDbTimestamp("2026-06-14 12:00:00");
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 14, 12, 0, 0));
  });

  it('agrees with SessionCard\'s `new Date(dateStr + "Z")` approach', () => {
    const s = "2026-01-02 03:04:05";
    expect(parseDbTimestamp(s).getTime()).toBe(new Date(s + "Z").getTime());
  });

  it("does not double-apply a zone when the string already ends in Z", () => {
    const s = "2026-06-14T12:00:00Z";
    expect(parseDbTimestamp(s).getTime()).toBe(Date.UTC(2026, 5, 14, 12, 0, 0));
  });

  it("respects an explicit numeric offset rather than forcing UTC", () => {
    // 12:00 at +02:00 is 10:00 UTC — must NOT be re-stamped as 12:00 UTC.
    const d = parseDbTimestamp("2026-06-14T12:00:00+02:00");
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 14, 10, 0, 0));
  });

  it("treats a stray NON-terminal z/offset as zone-less (the marker is anchored to the end)", () => {
    // Anchoring foot-gun: the zone check is /(?:[zZ]|[+-]\d{2}:?\d{2})$/. Both
    // alternatives must be TERMINAL. A stray "z" (or a "+HH:MM"-looking run) in
    // the BODY must NOT be mistaken for a real zone — otherwise such a value
    // would skip UTC normalization and reintroduce the TZ skew B011 fixed.
    //
    // We can't observe this via getTime() (any stray z makes the value an
    // un-parseable Date in both branches), so assert the anchored decision the
    // function relies on directly. An UNanchored `/[zZ]|.../ ` would wrongly
    // report `true` for these mid-string markers; the anchored one reports
    // false (zone-less → normalize), and true only for genuinely terminal ones.
    const isZoned = (s: string) => /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s);

    // Stray z/offset in the body → NOT zoned (will be UTC-normalized).
    expect(isZoned("2026-06-14z12:00:00")).toBe(false);
    expect(isZoned("Zona 2026-06-14 12:00:00")).toBe(false);
    expect(isZoned("2026-06-14T12:00:00+02:00 (extra)")).toBe(false);

    // Genuinely terminal zone markers → zoned (left untouched).
    expect(isZoned("2026-06-14T12:00:00Z")).toBe(true);
    expect(isZoned("2026-06-14T12:00:00z")).toBe(true);
    expect(isZoned("2026-06-14T12:00:00+02:00")).toBe(true);
    expect(isZoned("2026-06-14T12:00:00+0200")).toBe(true);

    // And the well-formed terminal values still round-trip through the real
    // function exactly as before (no double-Z, offset respected).
    expect(parseDbTimestamp("2026-06-14T12:00:00Z").getTime()).toBe(
      Date.UTC(2026, 5, 14, 12, 0, 0)
    );
    expect(parseDbTimestamp("2026-06-14T12:00:00+02:00").getTime()).toBe(
      Date.UTC(2026, 5, 14, 10, 0, 0)
    );
  });
});
