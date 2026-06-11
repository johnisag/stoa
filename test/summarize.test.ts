import { describe, it, expect } from "vitest";
import {
  parseClaudeTranscript,
  buildSummaryPrompt,
  sanitizeDigest,
} from "@/lib/summarize";

// Build a one-line JSONL entry the way Claude Code writes its transcript.
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("parseClaudeTranscript", () => {
  it("flattens user (string) and assistant (text blocks) into a transcript", () => {
    const jsonl = [
      line({ type: "user", message: { content: "build me a thing" } }),
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "done, here it is" }] },
      }),
    ].join("\n");

    expect(parseClaudeTranscript(jsonl)).toBe(
      "User: build me a thing\n\nAssistant: done, here it is"
    );
  });

  it("stringifies structured (array) user content", () => {
    const content = [{ type: "text", text: "hi" }];
    const jsonl = line({ type: "user", message: { content } });
    expect(parseClaudeTranscript(jsonl)).toBe(
      `User: ${JSON.stringify(content)}`
    );
  });

  it("keeps only assistant TEXT blocks (drops tool_use and thinking)", () => {
    const jsonl = line({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "visible answer" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    expect(parseClaudeTranscript(jsonl)).toBe("Assistant: visible answer");
  });

  it("joins multiple assistant text blocks with a newline", () => {
    const jsonl = line({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    });
    expect(parseClaudeTranscript(jsonl)).toBe("Assistant: first\nsecond");
  });

  it("skips malformed lines, blank lines, and content-less entries", () => {
    const jsonl = [
      "not json at all",
      "",
      line({ type: "user", message: {} }), // no content
      line({ type: "system", message: { content: "ignored" } }), // wrong type
      line({ type: "user", message: { content: "kept" } }),
    ].join("\n");
    expect(parseClaudeTranscript(jsonl)).toBe("User: kept");
  });

  it("ignores assistant entries whose content is not an array", () => {
    const jsonl = line({
      type: "assistant",
      message: { content: "a bare string, not blocks" },
    });
    expect(parseClaudeTranscript(jsonl)).toBe("");
  });

  it("returns an empty string for empty input", () => {
    expect(parseClaudeTranscript("")).toBe("");
    expect(parseClaudeTranscript("   \n  ")).toBe("");
  });
});

describe("buildSummaryPrompt", () => {
  it("is a stable, specific instruction under a word budget", () => {
    const prompt = buildSummaryPrompt();
    expect(prompt).toContain("300 words");
    expect(prompt).toContain("key files changed");
    expect(prompt).toContain("pending work");
  });
});

describe("sanitizeDigest", () => {
  it("trims surrounding whitespace", () => {
    expect(sanitizeDigest("  hello  ")).toBe("hello");
  });

  it("preserves internal newlines and tabs (a digest needs them)", () => {
    const tab = String.fromCharCode(9);
    expect(sanitizeDigest(`line one\nline two`)).toBe("line one\nline two");
    expect(sanitizeDigest(`a${tab}b`)).toBe(`a${tab}b`);
  });

  it("normalizes CRLF and lone CR to LF", () => {
    expect(sanitizeDigest("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("strips control chars and DEL that aren't tab/newline (injection guard)", () => {
    const esc = String.fromCharCode(0x1b); // ESC
    const bell = String.fromCharCode(0x07); // BEL
    const nul = String.fromCharCode(0x00); // NUL
    const del = String.fromCharCode(0x7f); // DEL
    expect(sanitizeDigest(`x${esc}[2Jy${bell}${nul}${del}z`)).toBe("x[2Jyz");
  });

  it("collapses to empty for control/whitespace-only input", () => {
    const esc = String.fromCharCode(0x1b);
    expect(sanitizeDigest(`  ${esc}\r\n  `)).toBe("");
    expect(sanitizeDigest("")).toBe("");
  });
});
