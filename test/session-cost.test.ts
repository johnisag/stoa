import { describe, it, expect } from "vitest";
import {
  parseClaudeUsage,
  parseClaudeContextTokens,
  costReaderFor,
} from "../lib/session-cost";

// A few JSONL lines like Claude Code writes: user turns (no usage) + assistant
// turns carrying message.usage, plus a blank + a malformed line to skip.
const JSONL = [
  JSON.stringify({ type: "user", message: { content: "hi" } }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "..." }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 200,
      },
    },
  }),
  "",
  "{ not valid json",
  JSON.stringify({
    type: "assistant",
    message: {
      usage: { input_tokens: 5, output_tokens: 7 }, // partial usage
    },
  }),
].join("\n");

describe("parseClaudeUsage", () => {
  it("sums usage across assistant turns, ignoring user/blank/malformed lines", () => {
    expect(parseClaudeUsage(JSONL)).toEqual({
      input: 105, // 100 + 5
      output: 57, // 50 + 7
      cacheWrite: 10,
      cacheRead: 200,
    });
  });

  it("returns zeroed usage for empty input", () => {
    expect(parseClaudeUsage("")).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("parseClaudeContextTokens", () => {
  it("uses the LAST assistant turn's input + cache (not the cumulative total)", () => {
    // The first turn carries 100 + 200 + 10 = 310; the last carries only 5.
    // Context occupancy is the latest turn, so it must be 5, not the sum.
    expect(parseClaudeContextTokens(JSONL)).toBe(5);
  });

  it("sums input + cache read + cache write of the final turn", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          usage: {
            input_tokens: 1_000,
            output_tokens: 200,
            cache_read_input_tokens: 50_000,
            cache_creation_input_tokens: 2_000,
          },
        },
      }),
    ].join("\n");
    expect(parseClaudeContextTokens(jsonl)).toBe(53_000); // 1000 + 50000 + 2000
  });

  it("is 0 for an empty / usage-less transcript", () => {
    expect(parseClaudeContextTokens("")).toBe(0);
    expect(
      parseClaudeContextTokens(
        JSON.stringify({ type: "user", message: { content: "hi" } })
      )
    ).toBe(0);
  });
});

describe("costReaderFor (provider seam)", () => {
  it("has a usage reader for Claude (the only parseable transcript today)", () => {
    expect(typeof costReaderFor("claude")).toBe("function");
  });

  it("returns undefined for agents without a reader and for unknown ids", () => {
    // These report supported:false in the cost UI — adding one is registering a
    // reader, not a special-case in computeSessionCosts.
    for (const a of ["codex", "hermes", "kilo", "kimi", "shell", "nope"]) {
      expect(costReaderFor(a)).toBeUndefined();
    }
  });
});
