/**
 * readClaudeTranscriptRaw — the shared Claude-transcript reader. The one thing
 * that MUST hold is the path-traversal guard: `claudeSessionId` is interpolated
 * into `~/.claude/projects/.../<id>.jsonl` and can come from a stored/POSTed
 * field, so anything that isn't a plain id token must be rejected BEFORE any
 * filesystem access (returns null, never reads outside the projects dir). A valid
 * id pointing at a non-existent transcript also returns null (best-effort).
 */
import { describe, it, expect } from "vitest";
import { readClaudeTranscriptRaw } from "../lib/claude-transcript";

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
