import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  parseClaudeUsage,
  parseClaudeContextTokens,
  costReaderFor,
  parseForkBaseline,
  netForkUsage,
  computeSessionCosts,
} from "../lib/session-cost";
import { readClaudeTranscriptRaw } from "../lib/claude-transcript";
import type { Session } from "../lib/db";

// Mock the transcript fs boundary so computeSessionCosts can be exercised with a
// controlled transcript (no real files) — locks that it actually nets the baseline.
vi.mock("../lib/claude-transcript", () => ({
  readClaudeTranscriptRaw: vi.fn(),
  resolveClaudeTranscriptPath: vi.fn(
    (_cwd: string, id: string) => `/fake/${id}.jsonl`
  ),
}));

// Exercise the cost LOGIC with the transcript cache OFF, so these tests read the
// mocked transcript on every call (the #18 stat-gated cache is covered on its own
// in test/transcript-cache.test.ts). readClaudeSessionUsage's kill-switch branch
// then goes straight through readClaudeTranscriptRaw (the mocked fn above).
// The switch is read live per call; suite-scoped hooks keep it from leaking to
// other test files in the same worker.
const prevCacheEnv = process.env.STOA_TRANSCRIPT_CACHE;
beforeAll(() => {
  process.env.STOA_TRANSCRIPT_CACHE = "0";
});
afterAll(() => {
  if (prevCacheEnv === undefined) delete process.env.STOA_TRANSCRIPT_CACHE;
  else process.env.STOA_TRANSCRIPT_CACHE = prevCacheEnv;
});

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

describe("parseForkBaseline (#1 — native fork cost baseline)", () => {
  it("parses a stored JSON TokenUsage", () => {
    expect(
      parseForkBaseline(
        JSON.stringify({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
      )
    ).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  });

  it("is null for null/empty/malformed input (no netting)", () => {
    expect(parseForkBaseline(null)).toBeNull();
    expect(parseForkBaseline(undefined)).toBeNull();
    expect(parseForkBaseline("")).toBeNull();
    expect(parseForkBaseline("{not json")).toBeNull();
  });

  it("coerces missing/NaN buckets to 0", () => {
    expect(parseForkBaseline(JSON.stringify({ input: 5 }))).toEqual({
      input: 5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("netForkUsage (#1 — subtract the inherited parent history)", () => {
  it("returns the fork's OWN spend = total minus the parent-at-fork baseline", () => {
    // The fork's transcript = parent history (100/50/200/10) + its own work
    // (30/20/40/5). Netting the baseline yields exactly the fork's own usage.
    const baseline = { input: 100, output: 50, cacheRead: 200, cacheWrite: 10 };
    const total = { input: 130, output: 70, cacheRead: 240, cacheWrite: 15 };
    expect(netForkUsage(total, baseline)).toEqual({
      input: 30,
      output: 20,
      cacheRead: 40,
      cacheWrite: 5,
    });
  });

  it("returns the usage unchanged when there is no baseline (non-fork)", () => {
    const t = { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 };
    expect(netForkUsage(t, null)).toEqual(t);
  });

  it("clamps each bucket at >= 0 (a torn/truncated transcript below the baseline)", () => {
    const baseline = { input: 100, output: 50, cacheRead: 200, cacheWrite: 10 };
    const total = { input: 80, output: 50, cacheRead: 0, cacheWrite: 10 };
    expect(netForkUsage(total, baseline)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("computeSessionCosts (#1 — applies the fork baseline end-to-end)", () => {
  function forkSession(over: Partial<Session> = {}): Session {
    return {
      id: "f",
      name: "fork",
      agent_type: "claude",
      claude_session_id: "cid",
      working_directory: "/repo",
      model: "claude-sonnet-4-6",
      fork_cost_baseline: null,
      ...over,
    } as unknown as Session;
  }

  it("subtracts a native fork's fork_cost_baseline from its transcript usage", async () => {
    // The fork's transcript = parent history (100/50/200/10) + its own work
    // (30/20/40/5). With the baseline stamped, only the fork's own spend counts —
    // this locks that computeSessionCosts actually calls parseForkBaseline+netForkUsage.
    vi.mocked(readClaudeTranscriptRaw).mockResolvedValue(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m",
          usage: {
            input_tokens: 130,
            output_tokens: 70,
            cache_read_input_tokens: 240,
            cache_creation_input_tokens: 15,
          },
        },
      })
    );
    const costs = await computeSessionCosts([
      forkSession({
        fork_cost_baseline: JSON.stringify({
          input: 100,
          output: 50,
          cacheRead: 200,
          cacheWrite: 10,
        }),
      }),
    ]);
    expect(costs["f"].tokens).toEqual({
      input: 30,
      output: 20,
      cacheRead: 40,
      cacheWrite: 5,
    });
    expect(costs["f"].supported).toBe(true);
  });

  it("does not net when there is no baseline (an ordinary session)", async () => {
    vi.mocked(readClaudeTranscriptRaw).mockResolvedValue(
      JSON.stringify({
        type: "assistant",
        message: { id: "m", usage: { input_tokens: 10, output_tokens: 5 } },
      })
    );
    const costs = await computeSessionCosts([forkSession({ id: "s" })]);
    expect(costs["s"].tokens).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("computeSessionCosts (#22 — direct: short-circuits + bounded concurrency)", () => {
  // This function feeds the budget-kill loop and the budget-park tick — its
  // contract is locked here: an entry for EVERY input session, supported:false
  // short-circuits that never touch the fs, best-effort zero on unreadable
  // transcripts, and transcript reads bounded at 12 concurrent.
  // Loose override type: the tests exercise null transcript ids / models,
  // which the DB row can hold even where the TS type says string.
  function cs(over: Record<string, unknown> = {}): Session {
    return {
      id: "s",
      name: "sess",
      agent_type: "claude",
      claude_session_id: "cid",
      working_directory: "/repo",
      model: "claude-sonnet-4-6",
      fork_cost_baseline: null,
      ...over,
    } as unknown as Session;
  }

  it("short-circuits supported:false WITHOUT touching the reader: no reader / no transcript id / no cwd", async () => {
    vi.mocked(readClaudeTranscriptRaw).mockClear();
    const costs = await computeSessionCosts([
      cs({ id: "codex", agent_type: "codex" }), // provider has no reader
      cs({ id: "noid", claude_session_id: null }), // transcript id never captured
      cs({ id: "nocwd", working_directory: null }), // cwd unset
    ]);
    for (const id of ["codex", "noid", "nocwd"]) {
      expect(costs[id]).toMatchObject({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: null,
        contextTokens: 0,
        supported: false,
      });
    }
    expect(readClaudeTranscriptRaw).not.toHaveBeenCalled();
  });

  it("an unreadable transcript is best-effort ZERO (still supported, never a throw)", async () => {
    vi.mocked(readClaudeTranscriptRaw).mockResolvedValue(null);
    const costs = await computeSessionCosts([cs({ id: "gone" })]);
    expect(costs["gone"]).toMatchObject({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0, // priced model × zero usage
      contextTokens: 0,
      supported: true,
    });
  });

  it("an unpriced model reports its tokens but costUsd null (the UI shows —)", async () => {
    vi.mocked(readClaudeTranscriptRaw).mockResolvedValue(
      JSON.stringify({
        type: "assistant",
        message: { id: "m", usage: { input_tokens: 10, output_tokens: 5 } },
      })
    );
    const costs = await computeSessionCosts([cs({ id: "u", model: "gpt-5" })]);
    expect(costs["u"].tokens.input).toBe(10);
    expect(costs["u"].costUsd).toBeNull();
    expect(costs["u"].supported).toBe(true);
  });

  it("returns an entry for EVERY input session (callers key budget decisions on it)", async () => {
    vi.mocked(readClaudeTranscriptRaw).mockResolvedValue(null);
    const costs = await computeSessionCosts([
      cs({ id: "a" }),
      cs({ id: "b", agent_type: "hermes" }),
      cs({ id: "c", claude_session_id: null }),
      cs({ id: "d", model: null }),
    ]);
    expect(Object.keys(costs).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("caps concurrent transcript reads at 12 (fd-exhaustion guard on large fleets)", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(readClaudeTranscriptRaw).mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1)); // hold the slot across a tick
      inFlight--;
      return JSON.stringify({
        type: "assistant",
        message: { id: "m", usage: { input_tokens: 1, output_tokens: 1 } },
      });
    });
    const sessions = Array.from({ length: 30 }, (_, i) =>
      cs({ id: `s${i}`, claude_session_id: `c${i}` })
    );
    const costs = await computeSessionCosts(sessions);
    expect(Object.keys(costs)).toHaveLength(30); // none dropped by batching
    expect(peak).toBe(12); // locks COST_READ_CONCURRENCY — batches fill fully…
    expect(inFlight).toBe(0); // …and drain fully
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
