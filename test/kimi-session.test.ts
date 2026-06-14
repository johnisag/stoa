import { describe, it, expect } from "vitest";
import { parseKimiSessionIndex } from "@/lib/kimi-session";

// Kimi Code writes one JSON object per line to ~/.kimi-code/session_index.jsonl:
//   {"sessionId":"session_<uuid>","sessionDir":"…","workDir":"C:/path"}
const line = (sessionId: string, workDir: string) =>
  JSON.stringify({ sessionId, sessionDir: `x/${sessionId}`, workDir });

// Deterministic normalizers (independent of the test runner's OS) so the
// matching logic is asserted identically on the ubuntu/macos/windows matrix.
const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const winNorm = (p: string) => slash(p).toLowerCase(); // case-insensitive (Windows)
const posixNorm = slash; // case-sensitive (POSIX)

describe("parseKimiSessionIndex — Kimi Code resume-id resolution", () => {
  it("returns the sessionId whose workDir matches the cwd", () => {
    const idx = [
      line("session_aaa", "C:/p/other"),
      line("session_bbb", "C:/p/pocs"),
    ].join("\n");
    expect(parseKimiSessionIndex(idx, "C:/p/pocs", posixNorm)).toBe(
      "session_bbb"
    );
  });

  it("matches a backslash cwd against a forward-slash workDir (separator-agnostic)", () => {
    const idx = line("session_win", "C:/p/pocs");
    expect(parseKimiSessionIndex(idx, "C:\\p\\pocs", winNorm)).toBe(
      "session_win"
    );
  });

  it("case-folds only when the normalizer does (Windows); POSIX stays case-sensitive", () => {
    const idx = line("session_x", "/home/u/Repo");
    // Windows-style fold: different case matches.
    expect(parseKimiSessionIndex(idx, "/home/u/repo", winNorm)).toBe(
      "session_x"
    );
    // POSIX: different case does NOT match (distinct directories).
    expect(parseKimiSessionIndex(idx, "/home/u/repo", posixNorm)).toBeNull();
  });

  it("returns the MOST RECENT (last) session for a workDir", () => {
    const idx = [
      line("session_old", "/repo"),
      line("session_new", "/repo"),
    ].join("\n");
    expect(parseKimiSessionIndex(idx, "/repo", posixNorm)).toBe("session_new");
  });

  it("returns null when no workDir matches", () => {
    expect(
      parseKimiSessionIndex(line("session_a", "/repo"), "/other", posixNorm)
    ).toBeNull();
  });

  it("skips malformed lines but still resolves a valid one", () => {
    const idx = ["not json", "{partial", line("session_ok", "/repo"), ""].join(
      "\n"
    );
    expect(parseKimiSessionIndex(idx, "/repo", posixNorm)).toBe("session_ok");
  });

  it("returns null for empty content or empty cwd", () => {
    expect(parseKimiSessionIndex("", "/repo", posixNorm)).toBeNull();
    expect(parseKimiSessionIndex(line("s", "/repo"), "", posixNorm)).toBeNull();
  });

  it("collapses '.'/'..' via the default canonicalizer so a non-canonical cwd still matches", () => {
    // Uses the REAL default normalize (path.normalize + normalizePathForCompare).
    // Lowercase input → the win32 case-fold is a no-op, so this is deterministic
    // on all three OSes.
    const idx = line("session_canon", "/home/u/repo");
    expect(parseKimiSessionIndex(idx, "/home/u/sub/../repo")).toBe(
      "session_canon"
    );
  });
});
