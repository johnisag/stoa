import { describe, it, expect } from "vitest";
import { parseKimiSessionIndex } from "@/lib/kimi-session";

// Kimi Code writes one JSON object per line to ~/.kimi-code/session_index.jsonl:
//   {"sessionId":"session_<uuid>","sessionDir":"…","workDir":"C:/path"}
const line = (sessionId: string, workDir: string) =>
  JSON.stringify({ sessionId, sessionDir: `x/${sessionId}`, workDir });

describe("parseKimiSessionIndex — Kimi Code resume-id resolution", () => {
  it("returns the sessionId whose workDir matches the cwd", () => {
    const idx = [
      line("session_aaa", "C:/my-projects/other"),
      line("session_bbb", "C:/my-projects/pocs"),
    ].join("\n");
    expect(parseKimiSessionIndex(idx, "C:/my-projects/pocs")).toBe(
      "session_bbb"
    );
  });

  it("matches a Windows backslash cwd against the index's forward-slash workDir", () => {
    const idx = line("session_win", "C:/my-projects/pocs");
    expect(parseKimiSessionIndex(idx, "C:\\my-projects\\pocs")).toBe(
      "session_win"
    );
  });

  it("is case-insensitive and ignores a trailing separator", () => {
    const idx = line("session_x", "C:/My-Projects/Pocs");
    expect(parseKimiSessionIndex(idx, "c:/my-projects/pocs/")).toBe(
      "session_x"
    );
  });

  it("returns the MOST RECENT (last) session for a workDir", () => {
    const idx = [
      line("session_old", "C:/repo"),
      line("session_new", "C:/repo"),
    ].join("\n");
    expect(parseKimiSessionIndex(idx, "C:/repo")).toBe("session_new");
  });

  it("returns null when no workDir matches", () => {
    expect(
      parseKimiSessionIndex(line("session_a", "C:/repo"), "C:/other")
    ).toBeNull();
  });

  it("skips malformed lines but still resolves a valid one", () => {
    const idx = [
      "not json",
      "{partial",
      line("session_ok", "C:/repo"),
      "",
    ].join("\n");
    expect(parseKimiSessionIndex(idx, "C:/repo")).toBe("session_ok");
  });

  it("returns null for empty content or empty cwd", () => {
    expect(parseKimiSessionIndex("", "C:/repo")).toBeNull();
    expect(parseKimiSessionIndex(line("s", "C:/repo"), "")).toBeNull();
  });
});
