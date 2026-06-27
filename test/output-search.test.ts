/**
 * Cross-session output search — the pure matcher. Locks: case-insensitive
 * SUBSTRING matching over user+assistant transcript text (tool calls/thinking
 * excluded), role-labelled snippets, a TOTAL count that can exceed the capped
 * hit list, long-line windowing, control/ANSI stripping, and literal (non-regex)
 * matching of special characters.
 */
import { describe, it, expect } from "vitest";
import { searchTranscript } from "../lib/output-search";

// Build a one-line JSONL entry the way Claude Code writes its transcript.
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const user = (text: string) =>
  line({ type: "user", message: { content: text } });
const assistant = (...texts: string[]) =>
  line({
    type: "assistant",
    message: { content: texts.map((t) => ({ type: "text", text: t })) },
  });

describe("searchTranscript", () => {
  it("matches case-insensitively and labels the snippet by role", () => {
    const jsonl = [
      user("Please fix the TypeError in auth.ts"),
      assistant("I found the typeerror and patched it"),
    ].join("\n");

    const { hits, total } = searchTranscript(jsonl, "typeerror", {
      maxHits: 5,
    });
    expect(total).toBe(2); // both lines match, regardless of case
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ role: "user" });
    expect(hits[1]).toMatchObject({ role: "assistant" });
    expect(hits[0].snippet.toLowerCase()).toContain("typeerror");
  });

  it("counts ALL matching lines but caps the returned hits at maxHits", () => {
    const jsonl = assistant(
      "error one",
      "error two",
      "error three",
      "error four"
    );
    // assistant text blocks are joined by \n, so each is its own line.
    const { hits, total } = searchTranscript(jsonl, "error", { maxHits: 2 });
    expect(total).toBe(4);
    expect(hits).toHaveLength(2);
  });

  it("returns nothing for a non-match and for a blank query", () => {
    const jsonl = user("hello world");
    expect(searchTranscript(jsonl, "missing", { maxHits: 5 })).toEqual({
      hits: [],
      total: 0,
    });
    expect(searchTranscript(jsonl, "   ", { maxHits: 5 })).toEqual({
      hits: [],
      total: 0,
    });
  });

  it("does NOT search tool calls or thinking blocks (only text turns)", () => {
    const jsonl = line({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "secret SENTINEL reasoning" },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "echo SENTINEL" },
          },
          { type: "text", text: "the visible answer" },
        ],
      },
    });
    expect(searchTranscript(jsonl, "SENTINEL", { maxHits: 5 }).total).toBe(0);
    expect(searchTranscript(jsonl, "visible", { maxHits: 5 }).total).toBe(1);
  });

  it("matches what is SHOWN, not the raw bytes (collapses whitespace/tabs/ANSI between words)", () => {
    const esc = String.fromCharCode(0x1b);
    // Double space, a tab, and an ANSI run between the words — a single-space
    // query must still find each (the snippet renders them single-spaced anyway).
    expect(
      searchTranscript(assistant("the  quick fox"), "the quick", { maxHits: 5 })
        .total
    ).toBe(1);
    expect(
      searchTranscript(assistant("the\tquick fox"), "the quick", { maxHits: 5 })
        .total
    ).toBe(1);
    expect(
      searchTranscript(
        assistant(`the ${esc}[1mquick${esc}[0m fox`),
        "the quick",
        {
          maxHits: 5,
        }
      ).total
    ).toBe(1);
  });

  it("windows a mid-line match with ellipses on BOTH sides", () => {
    const long = `${"x".repeat(300)} NEEDLE ${"y".repeat(300)}`;
    const { hits } = searchTranscript(assistant(long), "needle", {
      maxHits: 5,
    });
    expect(hits).toHaveLength(1);
    const snip = hits[0].snippet;
    expect(snip.toLowerCase()).toContain("needle");
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip.length).toBeLessThanOrEqual(210); // SNIPPET_MAX (200) + ellipses
  });

  it("windows a match at the START with no leading ellipsis", () => {
    const { hits } = searchTranscript(
      assistant(`NEEDLE${"x".repeat(400)}`),
      "needle",
      {
        maxHits: 5,
      }
    );
    const snip = hits[0].snippet;
    expect(snip.toLowerCase()).toContain("needle");
    expect(snip.startsWith("…")).toBe(false);
    expect(snip.endsWith("…")).toBe(true);
  });

  it("windows a match at the END with no trailing ellipsis (start-clamp)", () => {
    const { hits } = searchTranscript(
      assistant(`${"y".repeat(400)}NEEDLE`),
      "needle",
      {
        maxHits: 5,
      }
    );
    const snip = hits[0].snippet;
    expect(snip.toLowerCase()).toContain("needle");
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(false);
  });

  it("strips ANSI / control bytes from the snippet", () => {
    const esc = String.fromCharCode(0x1b);
    const bell = String.fromCharCode(0x07);
    const jsonl = assistant(`${esc}[31mTypeError${esc}[0m${bell} at line 5`);
    const { hits } = searchTranscript(jsonl, "typeerror", { maxHits: 5 });
    expect(hits[0].snippet).toContain("TypeError");
    expect(hits[0].snippet).not.toContain(esc);
    expect(hits[0].snippet).not.toContain(bell);
  });

  it("ignores a query that is only control/ANSI bytes (no inflated total)", () => {
    const esc = String.fromCharCode(0x1b);
    const jsonl = assistant(`${esc}[31m hello world ${esc}[0m`);
    // A query of pure escape bytes would be stripped from every snippet, so it
    // must match nothing rather than count lines it can't render.
    expect(searchTranscript(jsonl, `${esc}${esc}`, { maxHits: 5 })).toEqual({
      hits: [],
      total: 0,
    });
  });

  it("matches special characters LITERALLY (no RegExp from user input)", () => {
    const jsonl = assistant("call foo(a) and bar.* here");
    // These would be metacharacters in a regex; substring matching is literal.
    expect(searchTranscript(jsonl, "foo(a)", { maxHits: 5 }).total).toBe(1);
    expect(searchTranscript(jsonl, "bar.*", { maxHits: 5 }).total).toBe(1);
    expect(searchTranscript(jsonl, "(z)", { maxHits: 5 }).total).toBe(0);
  });
});
