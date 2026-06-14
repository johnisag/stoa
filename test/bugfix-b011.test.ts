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
});
