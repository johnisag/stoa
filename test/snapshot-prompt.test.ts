import { describe, it, expect } from "vitest";
import { normalizeEditedPrompt } from "../lib/snapshot-prompt";

describe("normalizeEditedPrompt", () => {
  it("keeps a multi-line edited prompt intact (rides in as one paste)", () => {
    expect(normalizeEditedPrompt("line one\nline two")).toBe(
      "line one\nline two"
    );
  });

  it("normalizes CRLF to LF and trims surrounding blank lines", () => {
    expect(normalizeEditedPrompt("\r\nfirst\r\nsecond\r\n")).toBe(
      "first\nsecond"
    );
  });

  it("strips dangerous C0 controls but keeps tab and newline", () => {
    // ESC is stripped; tab + newline survive as legitimate layout.
    expect(normalizeEditedPrompt("a\tb\x1bcd\ne")).toBe("a\tbcd\ne");
  });

  it("returns empty when nothing meaningful is left (caller blocks send)", () => {
    expect(normalizeEditedPrompt("")).toBe("");
    expect(normalizeEditedPrompt("   \n\t ")).toBe("");
    expect(normalizeEditedPrompt(" ")).toBe("");
  });
});
