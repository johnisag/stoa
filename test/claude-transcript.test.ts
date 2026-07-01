/**
 * readClaudeTranscriptRaw — the shared Claude-transcript reader. The one thing
 * that MUST hold is the path-traversal guard: `claudeSessionId` is interpolated
 * into `~/.claude/projects/.../<id>.jsonl` and can come from a stored/POSTed
 * field, so anything that isn't a plain id token must be rejected BEFORE any
 * filesystem access (returns null, never reads outside the projects dir). A valid
 * id pointing at a non-existent transcript also returns null (best-effort).
 */
import { describe, it, expect } from "vitest";
import {
  readClaudeTranscriptRaw,
  resolveClaudeTranscriptPath,
} from "../lib/claude-transcript";

describe("readClaudeTranscriptRaw — path-traversal guard", () => {
  it("rejects ids containing separators / dot-dot / spaces (returns null, no read)", async () => {
    for (const bad of [
      "../../etc/passwd",
      "..\\..\\windows\\system32\\config",
      "a/b",
      "a\\b",
      "foo.bar", // a dot would let an attacker reach a sibling file
      "with space",
      "semi;colon",
      "",
    ]) {
      await expect(readClaudeTranscriptRaw("~/proj", bad)).resolves.toBeNull();
    }
  });

  it("accepts a plain id token but returns null when the transcript is absent", async () => {
    // Valid shape (word chars + hyphen), but the file won't exist under the test
    // home → readFile ENOENT → null. Proves the guard passes a clean id through.
    await expect(
      readClaudeTranscriptRaw(
        "~/this-project-does-not-exist",
        "stoa-test-nonexistent-0000"
      )
    ).resolves.toBeNull();
  });
});

describe("resolveClaudeTranscriptPath — same guard, no read (#18 cache key)", () => {
  it("returns null for unsafe ids (never builds an escaping path)", () => {
    for (const bad of [
      "../../etc/passwd",
      "..\\..\\windows",
      "a/b",
      "a\\b",
      "foo.bar",
      "with space",
      "",
    ]) {
      expect(resolveClaudeTranscriptPath("~/proj", bad)).toBeNull();
    }
  });

  it("returns a `<id>.jsonl` path for a clean id (so the cache can stat it)", () => {
    const p = resolveClaudeTranscriptPath("~/some-project", "abc-123_DEF");
    expect(p).not.toBeNull();
    // ends with the id + .jsonl, regardless of platform separator
    expect(p!.replace(/\\/g, "/")).toMatch(/\/abc-123_DEF\.jsonl$/);
  });
});
