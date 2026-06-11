import { describe, it, expect } from "vitest";
import { normalizeForSend, isSendable } from "@/lib/prompt-compose";

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
