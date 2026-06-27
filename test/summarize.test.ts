import { describe, it, expect } from "vitest";
import {
  parseClaudeTranscript,
  extractTranscriptEntries,
  lastAssistantText,
  buildSummaryPrompt,
  sanitizeDigest,
} from "@/lib/summarize";

// Build a one-line JSONL entry the way Claude Code writes its transcript.
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("extractTranscriptEntries", () => {
  it("returns role-tagged user + assistant TEXT turns (drops tool_use/thinking)", () => {
    const jsonl = [
      line({ type: "user", message: { content: "build it" } }),
      line({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "done" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    ].join("\n");
    expect(extractTranscriptEntries(jsonl)).toEqual([
      { role: "user", text: "build it" },
      { role: "assistant", text: "done" },
    ]);
  });

  it("stringifies structured user content and skips malformed/empty lines", () => {
    const content = [{ type: "text", text: "hi" }];
    const jsonl = [
      "not json",
      "",
      line({ type: "user", message: {} }),
      line({ type: "user", message: { content } }),
    ].join("\n");
    expect(extractTranscriptEntries(jsonl)).toEqual([
      { role: "user", text: JSON.stringify(content) },
    ]);
  });
});

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

describe("lastAssistantText", () => {
  // Parse the same JSONL shape the route reads into entries.
  function entries(...objs: unknown[]): unknown[] {
    return objs;
  }

  it("returns the last assistant turn's joined text blocks", () => {
    const e = entries(
      { type: "user", message: { content: "do a thing" } },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "first reply" }] },
      },
      { type: "user", message: { content: "and another" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "## Heading" },
            { type: "text", text: "- a bullet" },
          ],
        },
      }
    );
    expect(lastAssistantText(e)).toBe("## Heading\n- a bullet");
  });

  it("keeps only TEXT blocks (drops tool_use and thinking)", () => {
    const e = entries({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "visible answer" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    expect(lastAssistantText(e)).toBe("visible answer");
  });

  it("skips a trailing sidechain (Task sub-agent) turn for the main reply", () => {
    const e = entries(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "main reply" }] },
      },
      {
        type: "assistant",
        isSidechain: true,
        message: { content: [{ type: "text", text: "sub-agent chatter" }] },
      }
    );
    expect(lastAssistantText(e)).toBe("main reply");
  });

  it("skips a trailing tool-only assistant turn and keeps the last TEXT turn", () => {
    const e = entries(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "the answer" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
      }
    );
    expect(lastAssistantText(e)).toBe("the answer");
  });

  it("ignores assistant entries whose content is not an array", () => {
    const e = entries({
      type: "assistant",
      message: { content: "a bare string, not blocks" },
    });
    expect(lastAssistantText(e)).toBe("");
  });

  it("returns '' when there is no assistant turn at all", () => {
    const e = entries(
      { type: "user", message: { content: "hello" } },
      { type: "system", message: { content: "noise" } }
    );
    expect(lastAssistantText(e)).toBe("");
    expect(lastAssistantText([])).toBe("");
  });

  it("tolerates malformed / null entries without throwing", () => {
    const e = entries(
      null,
      "not an object",
      { type: "assistant" }, // no message
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }
    );
    expect(lastAssistantText(e)).toBe("ok");
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
