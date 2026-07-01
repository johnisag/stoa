import { describe, it, expect } from "vitest";
import {
  normalizeForSend,
  isSendable,
  composeLaunchPrompt,
} from "@/lib/prompt-compose";

describe("normalizeForSend", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeForSend("  hello  ")).toBe("hello");
    expect(normalizeForSend("\n\tworld\n")).toBe("world");
  });

  it("preserves internal structure (multi-line prompts)", () => {
    expect(normalizeForSend("line one\nline two")).toBe("line one\nline two");
  });

  it("normalizes CRLF and lone CR to LF so a paste can't submit early", () => {
    expect(normalizeForSend("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("collapses to empty for whitespace-only input", () => {
    expect(normalizeForSend("   \r\n\t  ")).toBe("");
    expect(normalizeForSend("")).toBe("");
  });
});

describe("isSendable", () => {
  it("is true when there is content after normalization", () => {
    expect(isSendable("hi")).toBe(true);
    expect(isSendable("  multi\nline  ")).toBe(true);
  });

  it("is false for empty or whitespace-only input", () => {
    expect(isSendable("")).toBe(false);
    expect(isSendable("   ")).toBe(false);
    expect(isSendable("\r\n\t")).toBe(false);
  });
});

describe("composeLaunchPrompt (#12 cache-aware order)", () => {
  it("orders stable parts first, volatile suffix last, joined by blank lines", () => {
    expect(
      composeLaunchPrompt({
        leadInstruction: "RULE: edit in your cwd.",
        projectPrompt: "Project X context.",
        sessionPrompt: "Fix the bug.",
        lessons: "Lesson: watch the flake.",
        volatileSuffix: "[worktree /tmp/wt-abc branch feat]",
      })
    ).toBe(
      "RULE: edit in your cwd.\n\n" +
        "Project X context.\n\n" +
        "Fix the bug.\n\n" +
        "Lesson: watch the flake.\n\n" +
        "[worktree /tmp/wt-abc branch feat]"
    );
  });

  it("keeps the leading (cacheable) prefix BYTE-IDENTICAL across sessions that share the stable parts but differ in the volatile suffix + task", () => {
    const a = composeLaunchPrompt({
      leadInstruction: "RULE: edit in your cwd.",
      projectPrompt: "Project X context.",
      sessionPrompt: "Task A",
      volatileSuffix: "[worktree /tmp/wt-AAAA branch a]",
    })!;
    const b = composeLaunchPrompt({
      leadInstruction: "RULE: edit in your cwd.",
      projectPrompt: "Project X context.",
      sessionPrompt: "Task B — totally different",
      volatileSuffix: "[worktree /tmp/wt-BBBB branch b]",
    })!;
    const shared = "RULE: edit in your cwd.\n\nProject X context.";
    expect(a.startsWith(shared)).toBe(true);
    expect(b.startsWith(shared)).toBe(true);
    // the volatile worktree path is NOT in the shared prefix — it trails
    expect(a.indexOf("wt-AAAA")).toBeGreaterThan(shared.length);
  });

  it("drops empty/whitespace/null segments and trims each", () => {
    expect(
      composeLaunchPrompt({
        leadInstruction: "  lead  ",
        projectPrompt: "",
        sessionPrompt: null,
        lessons: "   ",
        volatileSuffix: "tail",
      })
    ).toBe("lead\n\ntail");
  });

  it("returns undefined when nothing remains", () => {
    expect(composeLaunchPrompt({})).toBeUndefined();
    expect(
      composeLaunchPrompt({ projectPrompt: "  ", sessionPrompt: null })
    ).toBeUndefined();
  });
});
