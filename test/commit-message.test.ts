import { describe, it, expect } from "vitest";
import {
  boundDiff,
  buildCommitPrompt,
  cleanCommitMessage,
  MAX_DIFF_CHARS,
} from "@/lib/commit-message";

describe("boundDiff", () => {
  it("returns a small diff unchanged", () => {
    const diff = "diff --git a/x b/x\n+hello";
    expect(boundDiff(diff)).toBe(diff);
  });

  it("trims an oversized diff and appends a truncation marker", () => {
    const diff = "x".repeat(MAX_DIFF_CHARS + 500);
    const out = boundDiff(diff);
    expect(out.length).toBeLessThan(diff.length);
    expect(out.startsWith("x".repeat(MAX_DIFF_CHARS))).toBe(true);
    expect(out).toContain("diff truncated");
    expect(out).toContain("500 more characters omitted");
  });

  it("honors a custom max", () => {
    expect(boundDiff("abcdef", 3)).toContain("abc");
    expect(boundDiff("abcdef", 3)).toContain("3 more characters omitted");
    expect(boundDiff("abc", 3)).toBe("abc"); // exactly at the bound: unchanged
  });
});

describe("buildCommitPrompt", () => {
  it("asks for a single Conventional Commit message and nothing else", () => {
    const prompt = buildCommitPrompt("diff --git a/x b/x");
    expect(prompt).toContain("Conventional Commit");
    expect(prompt).toContain("NOTHING else");
    // The Conventional Commit types are spelled out so the model picks one.
    expect(prompt).toContain("feat");
    expect(prompt).toContain("fix");
  });

  it("embeds the (bounded) diff", () => {
    const prompt = buildCommitPrompt("UNIQUE_DIFF_MARKER");
    expect(prompt).toContain("UNIQUE_DIFF_MARKER");
  });

  it("bounds the diff it embeds", () => {
    const big = "y".repeat(MAX_DIFF_CHARS + 100);
    const prompt = buildCommitPrompt(big);
    expect(prompt).toContain("diff truncated");
    expect(prompt).not.toContain("y".repeat(MAX_DIFF_CHARS + 1));
  });
});

describe("cleanCommitMessage", () => {
  it("trims surrounding whitespace", () => {
    expect(cleanCommitMessage("  feat: x  ")).toBe("feat: x");
  });

  it("preserves a subject + body separated by a blank line", () => {
    const msg = "feat: add thing\n\nIt does the thing.";
    expect(cleanCommitMessage(msg)).toBe(msg);
  });

  it("normalizes CRLF and lone CR to LF", () => {
    expect(cleanCommitMessage("feat: x\r\n\r\nbody\rmore")).toBe(
      "feat: x\n\nbody\nmore"
    );
  });

  it("strips control chars and DEL but keeps tab and newline (injection guard)", () => {
    const esc = String.fromCharCode(0x1b); // ESC
    const bell = String.fromCharCode(0x07); // BEL
    const nul = String.fromCharCode(0x00); // NUL
    const del = String.fromCharCode(0x7f); // DEL
    const tab = String.fromCharCode(0x09); // TAB
    const input = `feat${esc}[2J: x${bell}${nul}${del}${tab}end`;
    expect(cleanCommitMessage(input)).toBe(`feat[2J: x${tab}end`);
  });

  it("peels off a wrapping code fence", () => {
    expect(cleanCommitMessage("```\nfeat: x\n```")).toBe("feat: x");
    expect(cleanCommitMessage("```text\nfix: y\n```")).toBe("fix: y");
  });

  it("strips surrounding quotes from a single line", () => {
    expect(cleanCommitMessage('"feat: x"')).toBe("feat: x");
    expect(cleanCommitMessage("'fix: y'")).toBe("fix: y");
  });

  it("does NOT strip quotes spanning multiple lines (could be body content)", () => {
    const msg = '"feat: x\n\nbody"';
    expect(cleanCommitMessage(msg)).toBe(msg);
  });

  it("collapses runs of 3+ blank lines down to one", () => {
    expect(cleanCommitMessage("feat: x\n\n\n\nbody")).toBe("feat: x\n\nbody");
  });

  it("returns empty for control/whitespace-only input", () => {
    const esc = String.fromCharCode(0x1b);
    expect(cleanCommitMessage(`  ${esc}\r\n  `)).toBe("");
    expect(cleanCommitMessage("")).toBe("");
  });
});
