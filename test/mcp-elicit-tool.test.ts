/**
 * MCP elicitation tool formatter (#48) — the tool's text result. A decline /
 * cancel / expiry / timeout is a NORMAL outcome and must NOT be rendered with an
 * "Error:" prefix (else toolResultStatus in orchestration-server counts a routine
 * operator refusal as a tool failure, inflating error rates).
 */
import { describe, it, expect } from "vitest";
import { formatElicitResult } from "../mcp/orchestration-tools";

describe("formatElicitResult", () => {
  it("renders accepted input as a readable list (no Error prefix)", () => {
    const text = formatElicitResult({
      status: "answered",
      action: "accept",
      content: { target: "prod", count: 7, confirm: true },
    });
    expect(text).toContain("- target: prod");
    expect(text).toContain("- count: 7");
    expect(text).toContain("- confirm: true");
    expect(text.startsWith("Error:")).toBe(false);
  });

  it("renders decline / cancel / expired / timeout as non-error outcomes", () => {
    for (const r of [
      { status: "answered", action: "decline", content: null },
      { status: "answered", action: "cancel", content: null },
      { status: "expired", action: null, content: null },
      { status: "timeout", action: null, content: null },
      { status: "unknown", action: null, content: null },
    ]) {
      const text = formatElicitResult(r);
      expect(text.length).toBeGreaterThan(0);
      expect(text.startsWith("Error:")).toBe(false);
    }
  });
});
