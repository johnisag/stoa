import { describe, it, expect } from "vitest";
import { createRequire } from "module";

// The hook is a CommonJS script (runs under plain `node`, invoked by Claude); load it
// via createRequire so this ESM/TS test can import its pure helpers. main() is guarded
// by `require.main === module`, so importing has no side effects (no stdin read / write).
const require = createRequire(import.meta.url);
const { windowFrom, mapStatuslineToRecord, formatStatusLine, recordPath } =
  require("../scripts/claude-statusline-hook.js") as {
    windowFrom: (
      entry: unknown
    ) => { pct: number; resetAt: number | null } | null;
    mapStatuslineToRecord: (
      input: unknown,
      nowMs: number
    ) => {
      fiveHourPct?: number;
      sevenDayPct?: number;
      resetAt: number | null;
      updatedAt: number;
    } | null;
    formatStatusLine: (input: unknown) => string;
    recordPath: () => string;
  };

const NOW = 1_700_000_000_000;

describe("claude-statusline-hook: windowFrom (Claude window → 0..1 + epoch-ms)", () => {
  it("converts used_percentage (0..100) to a fraction and resets_at (sec) to ms", () => {
    expect(
      windowFrom({ used_percentage: 23.5, resets_at: 1738425600 })
    ).toEqual({
      pct: 0.235,
      resetAt: 1738425600000,
    });
  });

  it("keeps a window with a percentage but no reset (resetAt null)", () => {
    expect(windowFrom({ used_percentage: 0 })).toEqual({
      pct: 0,
      resetAt: null,
    });
  });

  it("is null when the percentage is missing or not a finite number", () => {
    expect(windowFrom({ resets_at: 123 })).toBeNull();
    expect(windowFrom({ used_percentage: "high" })).toBeNull();
    expect(windowFrom({ used_percentage: NaN })).toBeNull();
    expect(windowFrom(null)).toBeNull();
    expect(windowFrom(undefined)).toBeNull();
  });
});

describe("claude-statusline-hook: mapStatuslineToRecord (→ M2a record)", () => {
  it("maps both windows and stamps updatedAt with the supplied now", () => {
    const rec = mapStatuslineToRecord(
      {
        rate_limits: {
          five_hour: { used_percentage: 40, resets_at: 1738425600 },
          seven_day: { used_percentage: 85, resets_at: 1738857600 },
        },
      },
      NOW
    );
    expect(rec).toEqual({
      fiveHourPct: 0.4,
      sevenDayPct: 0.85,
      // resetAt carries the MORE-CONSTRAINED (higher-util) window's reset → 7d here.
      resetAt: 1738857600000,
      updatedAt: NOW,
    });
  });

  it("carries the 5h reset when 5h is the binding (higher) window", () => {
    const rec = mapStatuslineToRecord(
      {
        rate_limits: {
          five_hour: { used_percentage: 90, resets_at: 111 },
          seven_day: { used_percentage: 10, resets_at: 222 },
        },
      },
      NOW
    );
    expect(rec?.resetAt).toBe(111000);
  });

  it("maps a single present window (the other independently absent)", () => {
    const rec = mapStatuslineToRecord(
      { rate_limits: { five_hour: { used_percentage: 12, resets_at: 5 } } },
      NOW
    );
    expect(rec).toEqual({
      fiveHourPct: 0.12,
      resetAt: 5000,
      updatedAt: NOW,
    });
    expect(rec).not.toHaveProperty("sevenDayPct");
  });

  it("is null when there's no usable rate-limit window (free tier / pre-first-response)", () => {
    // Returning null tells main() to SKIP the write, so an empty session can't clobber
    // a good record written by another active session.
    expect(mapStatuslineToRecord({}, NOW)).toBeNull();
    expect(mapStatuslineToRecord({ rate_limits: {} }, NOW)).toBeNull();
    expect(
      mapStatuslineToRecord({ rate_limits: { five_hour: {} } }, NOW)
    ).toBeNull();
    expect(mapStatuslineToRecord(null, NOW)).toBeNull();
    expect(mapStatuslineToRecord("not json", NOW)).toBeNull();
  });
});

describe("claude-statusline-hook: formatStatusLine (the rendered bar)", () => {
  it("joins model, context %, and both quota windows", () => {
    expect(
      formatStatusLine({
        model: { display_name: "Opus" },
        context_window: { used_percentage: 8.6 },
        rate_limits: {
          five_hour: { used_percentage: 23.5 },
          seven_day: { used_percentage: 41.2 },
        },
      })
    ).toBe("Opus · ctx 9% · 5h 24% · 7d 41%");
  });

  it("includes only the parts that are present", () => {
    expect(formatStatusLine({ model: { display_name: "Sonnet" } })).toBe(
      "Sonnet"
    );
    expect(formatStatusLine({ context_window: { used_percentage: 50 } })).toBe(
      "ctx 50%"
    );
  });

  it("is an empty string when nothing is known", () => {
    expect(formatStatusLine({})).toBe("");
    expect(formatStatusLine(null)).toBe("");
    expect(formatStatusLine("nope")).toBe("");
  });
});

describe("claude-statusline-hook: recordPath", () => {
  it("targets ~/.stoa/rate-limits.json (the file lib/rate-limit-window.ts reads)", () => {
    const p = recordPath();
    expect(p).toContain(".stoa");
    expect(p.endsWith("rate-limits.json")).toBe(true);
  });
});
