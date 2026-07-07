import { describe, expect, it } from "vitest";
import {
  parseCodexRolloutUsage,
  resolveCodexThreadIdFromRows,
  stripExtendedWindowsPrefix,
  type CodexThreadRow,
} from "@/lib/codex-usage";
import type { Session } from "@/lib/db";

const tokenCount = (
  total: Record<string, number>,
  last: Record<string, number>,
  window = 258_400
) =>
  JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
        model_context_window: window,
      },
    },
  });

describe("parseCodexRolloutUsage", () => {
  it("uses cumulative token_count for spend but last-turn input for context", () => {
    const usage = parseCodexRolloutUsage(
      [
        "{not json",
        tokenCount(
          {
            input_tokens: 33_442_600,
            cached_input_tokens: 32_039_424,
            output_tokens: 99_652,
            total_tokens: 33_542_252,
          },
          {
            input_tokens: 32_944,
            cached_input_tokens: 20_352,
            output_tokens: 854,
            total_tokens: 33_798,
          }
        ),
      ].join("\n")
    );

    expect(usage.tokens).toEqual({
      input: 1_403_176,
      cacheRead: 32_039_424,
      output: 99_652,
      cacheWrite: 0,
    });
    expect(usage.standardTokens).toEqual(usage.tokens);
    expect(usage.longContextTokens).toEqual({
      input: 0,
      cacheRead: 0,
      output: 0,
      cacheWrite: 0,
    });
    expect(usage.contextTokens).toBe(32_944);
    expect(usage.contextWindow).toBe(258_400);
  });

  it("keeps the latest token_count reading and ignores non-token events", () => {
    const usage = parseCodexRolloutUsage(
      [
        tokenCount(
          { input_tokens: 100, cached_input_tokens: 90, output_tokens: 5 },
          { input_tokens: 100, cached_input_tokens: 90, output_tokens: 5 },
          128_000
        ),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message" },
        }),
        tokenCount(
          { input_tokens: 200, cached_input_tokens: 150, output_tokens: 10 },
          { input_tokens: 25, cached_input_tokens: 10, output_tokens: 2 },
          272_000
        ),
      ].join("\n")
    );

    expect(usage.tokens).toEqual({
      input: 50,
      cacheRead: 150,
      output: 10,
      cacheWrite: 0,
    });
    expect(usage.contextTokens).toBe(25);
    expect(usage.contextWindow).toBe(272_000);
  });

  it("uses the compressed-context marker total when Codex reports zero input tokens", () => {
    const usage = parseCodexRolloutUsage(
      tokenCount(
        { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 50 },
        {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          total_tokens: 16_199,
        }
      )
    );

    expect(usage.contextTokens).toBe(16_199);
  });

  it("marks GPT long-context pricing only when the last prompt exceeds 272K input tokens", () => {
    expect(
      parseCodexRolloutUsage(
        tokenCount(
          { input_tokens: 1_000, cached_input_tokens: 0, output_tokens: 1 },
          { input_tokens: 272_000, cached_input_tokens: 0, output_tokens: 1 }
        )
      ).longContext
    ).toBe(false);

    expect(
      parseCodexRolloutUsage(
        tokenCount(
          { input_tokens: 300_000, cached_input_tokens: 0, output_tokens: 1 },
          { input_tokens: 272_001, cached_input_tokens: 0, output_tokens: 1 },
          1_050_000
        )
      ).longContext
    ).toBe(true);
  });

  it("splits standard and long-context pricing buckets by cumulative token deltas", () => {
    const usage = parseCodexRolloutUsage(
      [
        tokenCount(
          { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
          { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }
        ),
        tokenCount(
          {
            input_tokens: 300_100,
            cached_input_tokens: 100_020,
            output_tokens: 1_010,
          },
          {
            input_tokens: 300_000,
            cached_input_tokens: 100_000,
            output_tokens: 1_000,
          }
        ),
        tokenCount(
          {
            input_tokens: 350_100,
            cached_input_tokens: 110_020,
            output_tokens: 1_510,
          },
          {
            input_tokens: 50_000,
            cached_input_tokens: 10_000,
            output_tokens: 500,
          }
        ),
      ].join("\n")
    );

    expect(usage.standardTokens).toEqual({
      input: 40_080,
      cacheRead: 10_020,
      output: 510,
      cacheWrite: 0,
    });
    expect(usage.longContextTokens).toEqual({
      input: 200_000,
      cacheRead: 100_000,
      output: 1_000,
      cacheWrite: 0,
    });
    expect(usage.tokens).toEqual({
      input: 240_080,
      cacheRead: 110_020,
      output: 1_510,
      cacheWrite: 0,
    });
  });

  it("counts the first bucket after a cumulative counter reset as a new epoch", () => {
    const usage = parseCodexRolloutUsage(
      [
        tokenCount(
          { input_tokens: 1_000, cached_input_tokens: 100, output_tokens: 10 },
          { input_tokens: 1_000, cached_input_tokens: 100, output_tokens: 10 }
        ),
        tokenCount(
          { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 },
          { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 }
        ),
        tokenCount(
          { input_tokens: 80, cached_input_tokens: 20, output_tokens: 8 },
          { input_tokens: 30, cached_input_tokens: 10, output_tokens: 3 }
        ),
      ].join("\n")
    );

    expect(usage.tokens).toEqual({
      input: 960,
      cacheRead: 120,
      output: 18,
      cacheWrite: 0,
    });
  });
});

describe("resolveCodexThreadIdFromRows", () => {
  const createdAt = Math.floor(Date.parse("2026-07-07T10:00:00Z") / 1000);
  const activity = createdAt + 42;

  function session(over: Partial<Session> = {}): Session {
    return {
      id: "s",
      name: "codex-s",
      tmux_name: "codex-s",
      created_at: "2026-07-07 10:00:00",
      updated_at: "2026-07-07 10:00:00",
      status: "idle",
      working_directory: "C:\\repo",
      parent_session_id: null,
      claude_session_id: null,
      model: "gpt-5.5",
      system_prompt: null,
      group_path: "",
      project_id: null,
      agent_type: "codex",
      auto_approve: false,
      worktree_path: null,
      branch_name: null,
      base_branch: null,
      dev_server_port: null,
      pr_url: null,
      pr_number: null,
      pr_status: null,
      conductor_session_id: null,
      worker_task: null,
      worker_status: null,
      mcp_launch_args: null,
      ...over,
    };
  }

  function row(over: Partial<CodexThreadRow> = {}): CodexThreadRow {
    return {
      id: "thread-1",
      rollout_path: "C:\\Users\\me\\.codex\\sessions\\rollout.jsonl",
      cwd: "C:\\repo",
      created_at: createdAt,
      updated_at: activity,
      model: "gpt-5.5",
      source: "vscode",
      thread_source: "user",
      ...over,
    };
  }

  it("resolves a unique same-cwd thread only when terminal activity also matches", () => {
    expect(resolveCodexThreadIdFromRows(session(), [row()], activity)).toBe(
      "thread-1"
    );
  });

  it("rejects ambiguous same-cwd rows instead of guessing", () => {
    expect(
      resolveCodexThreadIdFromRows(
        session(),
        [row({ id: "thread-1" }), row({ id: "thread-2" })],
        activity
      )
    ).toBeNull();
  });

  it("rejects multiple matching user threads instead of guessing by timestamp", () => {
    expect(
      resolveCodexThreadIdFromRows(
        session(),
        [
          row({ id: "before", updated_at: activity - 1 }),
          row({ id: "after", updated_at: activity + 1 }),
        ],
        activity
      )
    ).toBeNull();
  });

  it("ignores matching subagent rows when resolving the user Codex thread", () => {
    expect(
      resolveCodexThreadIdFromRows(
        session(),
        [
          row({ id: "thread-1", thread_source: "user" }),
          row({ id: "subagent-1", thread_source: "subagent" }),
          row({ id: "automation-1", thread_source: "automation" }),
        ],
        activity
      )
    ).toBe("thread-1");
  });

  it("ignores legacy JSON source subagent rows when thread_source is missing", () => {
    expect(
      resolveCodexThreadIdFromRows(
        session(),
        [
          row({ id: "thread-1", thread_source: "user" }),
          row({
            id: "legacy-subagent",
            thread_source: null,
            source: JSON.stringify({
              subagent: {
                thread_spawn: {
                  parent_thread_id: "thread-1",
                },
              },
            }),
          }),
        ],
        activity
      )
    ).toBe("thread-1");
  });

  it("rejects stale or unrelated same-cwd rows outside the activity window", () => {
    expect(
      resolveCodexThreadIdFromRows(
        session(),
        [row({ updated_at: activity - 60 })],
        activity
      )
    ).toBeNull();
  });

  it("normalizes Windows extended UNC paths before comparing cwd", () => {
    expect(stripExtendedWindowsPrefix("\\\\?\\UNC\\server\\share\\repo")).toBe(
      "\\\\server\\share\\repo"
    );
    expect(
      resolveCodexThreadIdFromRows(
        session({ working_directory: "\\\\server\\share\\repo" }),
        [row({ cwd: "\\\\?\\UNC\\server\\share\\repo" })],
        activity
      )
    ).toBe("thread-1");
  });
});
