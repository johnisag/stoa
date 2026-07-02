/**
 * Copy-as-Markdown (#40) — toMarkdownBlock wraps captured terminal text in a
 * fenced code block. Locks the fence-length escalation (a body containing ```
 * must not close the fence early), the ANSI/C0 strip (hostile input built via
 * String.fromCharCode — never control-char literals in test source), CRLF
 * normalization, trailing-blank trimming, the lang info string, and the
 * empty-input contract.
 */
import { describe, it, expect } from "vitest";
import { toMarkdownBlock } from "@/lib/markdown-block";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CR = String.fromCharCode(0x0d);
const TAB = String.fromCharCode(0x09);
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
const BACKSPACE = String.fromCharCode(0x08);

describe("toMarkdownBlock", () => {
  it("wraps text in a three-backtick fence by default", () => {
    expect(toMarkdownBlock("npm test")).toBe("```\nnpm test\n```");
  });

  it("adds the language tag to the opening fence", () => {
    expect(toMarkdownBlock("const x = 1;", "ts")).toBe(
      "```ts\nconst x = 1;\n```"
    );
  });

  it("sanitizes a hostile lang tag to a single clean token", () => {
    expect(toMarkdownBlock("x", " type` script ")).toBe(
      "```typescript\nx\n```"
    );
  });

  it("escalates the fence past a ``` run in the body", () => {
    const inner = "`".repeat(3);
    const body = `docs say:\n${inner}\ncode\n${inner}`;
    const fence = "`".repeat(4);
    expect(toMarkdownBlock(body)).toBe(`${fence}\n${body}\n${fence}`);
  });

  it("escalates past a four-backtick run too", () => {
    const body = "a " + "`".repeat(4) + " b";
    const fence = "`".repeat(5);
    expect(toMarkdownBlock(body)).toBe(`${fence}\n${body}\n${fence}`);
  });

  it("keeps the minimum three-backtick fence for short inline runs", () => {
    const body = "run `npm test` or ``x``";
    expect(toMarkdownBlock(body)).toBe("```\n" + body + "\n```");
  });

  it("strips complete ANSI color sequences, not just the ESC byte", () => {
    const input = `${ESC}[31merror${ESC}[0m: build failed`;
    expect(toMarkdownBlock(input)).toBe("```\nerror: build failed\n```");
  });

  it("strips OSC title sequences, short escapes, and C0/DEL bytes", () => {
    const input =
      `${ESC}]0;window title${BEL}` +
      `ok${NUL}${DEL}${BACKSPACE} done` +
      `${ESC}(B`;
    expect(toMarkdownBlock(input)).toBe("```\nok done\n```");
  });

  it("keeps tab and newline layout", () => {
    const input = `col1${TAB}col2\nrow2`;
    expect(toMarkdownBlock(input)).toBe("```\n" + input + "\n```");
  });

  it("normalizes CRLF and lone CR to LF", () => {
    const input = `line1${CR}\nline2${CR}line3`;
    expect(toMarkdownBlock(input)).toBe("```\nline1\nline2\nline3\n```");
  });

  it("trims surrounding blank lines and whitespace", () => {
    expect(toMarkdownBlock("\n\n  output  \n\n\n")).toBe("```\noutput\n```");
  });

  it("returns empty string for empty, whitespace-only, and control-only input", () => {
    expect(toMarkdownBlock("")).toBe("");
    expect(toMarkdownBlock(`   \n${TAB}  `)).toBe("");
    expect(toMarkdownBlock(`${ESC}[2J${ESC}[H${BEL}`)).toBe("");
  });
});
