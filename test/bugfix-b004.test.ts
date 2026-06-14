import { describe, it, expect } from "vitest";

import { parseDockerComposeServices } from "@/lib/projects";

// Regression test for B004: detectDockerServices used to run
//   `docker compose -f "..." config --services 2>/dev/null || echo ""`
// via promisify(exec) (a shell) on every platform. On Windows cmd.exe does not
// understand `2>/dev/null` or `|| echo ""`, so the redirect/fallback leaked into
// stdout and the parser produced a phantom "" service. The fix runs execFile
// (no shell) and parses the newline-separated service list in JS via this
// helper. These assertions lock the parser against re-introducing empty/phantom
// entries and guarantee CRLF (Windows) output is handled.

describe("parseDockerComposeServices", () => {
  it("returns clean service names from LF output", () => {
    expect(parseDockerComposeServices("web\napi\ndb\n")).toEqual([
      "web",
      "api",
      "db",
    ]);
  });

  it("handles Windows CRLF line endings", () => {
    expect(parseDockerComposeServices("web\r\napi\r\n")).toEqual([
      "web",
      "api",
    ]);
  });

  it('drops empty/whitespace-only lines (no phantom "" service)', () => {
    // Mirrors the shape of the old contaminated stdout where the `|| echo ""`
    // fallback (or a trailing blank line) produced an empty entry.
    expect(parseDockerComposeServices("web\n\n\napi\n   \n")).toEqual([
      "web",
      "api",
    ]);
  });

  it("returns [] for empty stdout (docker absent / no services)", () => {
    expect(parseDockerComposeServices("")).toEqual([]);
    expect(parseDockerComposeServices("\n")).toEqual([]);
    expect(parseDockerComposeServices("\r\n")).toEqual([]);
  });
});
