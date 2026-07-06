import { describe, it, expect } from "vitest";
import {
  ABTOP_ARGS,
  collectAbtopTelemetry,
  mergeAbtopAgentSnapshots,
  parseAbtopSnapshot,
  parseAbtopSnapshotJson,
  resolveAbtopSpawn,
} from "@/lib/abtop-sensor";
import type { AgentSnapshot } from "@/lib/monitor-snapshot";
import type { Session } from "@/lib/db";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "stoa",
    tmux_name: "codex-s1",
    created_at: "",
    updated_at: "",
    status: "running",
    working_directory: "C:/repo",
    parent_session_id: null,
    claude_session_id: null,
    model: "",
    system_prompt: null,
    group_path: "sessions",
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

function agent(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "s1",
    name: "stoa",
    agent_type: "codex",
    model: null,
    status: "running",
    branch: null,
    context_percent: 0,
    context_tokens: 0,
    tokens: {
      input: 0,
      output: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total: 0,
    },
    cost_usd: null,
    source: "stoa",
    child_processes: 0,
    mcp_servers: [],
    ports: [],
    orphan_ports: [],
    ...over,
  };
}

describe("parseAbtopSnapshot (M6 optional external sensor)", () => {
  it("maps abtop session JSON to sanitized telemetry", () => {
    const [parsed] = parseAbtopSnapshot({
      sessions: [
        {
          agent_cli: "codex",
          session_id: "codex:one",
          project_name: "repo",
          cwd: "C:/repo",
          status: "Thinking",
          model: "gpt-5-codex",
          context_percent: 37.6,
          context_window: 200_000,
          total_tokens: 999,
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 30,
          cache_create_tokens: 5,
          git_branch: "main",
          children: [
            {
              pid: 1,
              command: "node ./node_modules/.bin/mcp-server-filesystem",
              port: 3000,
            },
            {
              pid: 2,
              command: "editor src/mcp.ts",
              port: 70000,
            },
            {
              pid: 3,
              command: "codex --mcp-config .mcp.json",
              port: 4000,
            },
          ],
        },
      ],
    });

    expect(parsed).toMatchObject({
      id: "abtop:codex:codex_one",
      agentType: "codex",
      sessionId: "codex:one",
      name: "repo",
      cwd: "C:/repo",
      model: "gpt-5-codex",
      status: "running",
      branch: "main",
      contextTokens: 75_200,
      tokens: {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
      },
      childCount: 3,
      mcpServers: ["mcp-server-filesystem"],
      ports: [
        { port: 3000, orphan: true },
        { port: 4000, orphan: true },
      ],
    });
    expect(parsed.contextPct).toBeCloseTo(0.376, 6);
  });

  it("fails closed for malformed JSON and invalid session identities", () => {
    expect(parseAbtopSnapshotJson("{nope")).toEqual([]);
    expect(
      parseAbtopSnapshot({
        sessions: [
          { agent_cli: "bad cli", session_id: "x" },
          { agent_cli: "llama", session_id: "x" },
          { agent_cli: "codex" },
        ],
      })
    ).toEqual([]);
  });

  it("sanitizes external display names and clamps huge numeric fields", () => {
    const [parsed] = parseAbtopSnapshot({
      sessions: [
        {
          agent_cli: "codex",
          session_id: "codex:secret-session",
          project_name: "C:/Users/johnis/secret-repo",
          context_percent: 100,
          context_window: Number.MAX_SAFE_INTEGER * 2,
          input_tokens: Number.MAX_SAFE_INTEGER * 2,
          output_tokens: 1,
        },
      ],
    });

    expect(parsed.name).toBe("codex codex_se");
    expect(parsed.contextTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsed.tokens.input).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("collectAbtopTelemetry", () => {
  it("does nothing when abtop is absent", async () => {
    const out = await collectAbtopTelemetry({ resolveBin: () => null });
    expect(out).toEqual([]);
  });

  it("runs abtop with argv tokens, windowsHide, and the roadmap one-shot flags", async () => {
    const calls: Array<{
      file: string;
      args: string[];
      opts: { windowsHide: boolean; maxBuffer: number; timeout: number };
    }> = [];
    const out = await collectAbtopTelemetry({
      resolveBin: () => "C:/bin/abtop.cmd",
      onWindows: true,
      execFileFn: async (file, args, opts) => {
        calls.push({ file, args, opts });
        return { stdout: JSON.stringify({ sessions: [] }) };
      },
    });

    expect(out).toEqual([]);
    expect(calls).toEqual([
      {
        file: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", '"C:/bin/abtop.cmd" "--json" "--once"'],
        opts: {
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          timeout: 2_000,
        },
      },
    ]);
  });

  it("fails closed when the abtop process errors", async () => {
    const out = await collectAbtopTelemetry({
      resolveBin: () => "/usr/bin/abtop",
      execFileFn: async () => {
        throw new Error("boom");
      },
    });
    expect(out).toEqual([]);
  });
});

describe("resolveAbtopSpawn", () => {
  it("leaves native binaries as direct argv execs", () => {
    expect(resolveAbtopSpawn("/usr/bin/abtop", ABTOP_ARGS, false)).toEqual({
      file: "/usr/bin/abtop",
      args: ["--json", "--once"],
    });
  });

  it("rejects unsafe Windows command-shim paths instead of feeding cmd metacharacters", () => {
    expect(resolveAbtopSpawn("C:/evil&/abtop.cmd", ABTOP_ARGS, true)).toEqual({
      file: "",
      args: [],
    });
  });
});

describe("mergeAbtopAgentSnapshots", () => {
  it("enriches matching Stoa rows and appends external sessions", () => {
    const abtopAgents = parseAbtopSnapshot({
      sessions: [
        {
          agent_cli: "codex",
          session_id: "codex-s1",
          project_name: "repo",
          cwd: "C:/repo",
          status: "Executing",
          model: "gpt-5-codex",
          context_percent: 50,
          context_window: 100_000,
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 0,
          cache_create_tokens: 1,
          git_branch: "main",
          children: [{ command: "mcp-server-git", port: 5173 }],
        },
        {
          agent_cli: "opencode",
          session_id: "outside",
          project_name: "outside-repo",
          status: "Waiting",
          model: "opencode-model",
          context_percent: 0,
          input_tokens: 7,
          output_tokens: 3,
        },
      ],
    });

    const merged = mergeAbtopAgentSnapshots(
      [agent()],
      [session()],
      abtopAgents
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((a) => a.id)).toEqual(["abtop:opencode:outside", "s1"]);

    const stoa = merged.find((a) => a.id === "s1")!;
    expect(stoa).toMatchObject({
      source: "stoa",
      model: "gpt-5-codex",
      branch: "main",
      context_percent: 50,
      context_tokens: 50_000,
      child_processes: 1,
      mcp_servers: ["mcp-server-git"],
      ports: [5173],
      orphan_ports: [5173],
    });
    expect(stoa.tokens).toEqual({
      input: 10,
      output: 5,
      cache_read_tokens: 0,
      cache_write_tokens: 1,
      total: 16,
    });

    const external = merged.find((a) => a.id === "abtop:opencode:outside")!;
    expect(external).toMatchObject({
      source: "abtop",
      name: "outside-repo",
      agent_type: "opencode",
      status: "waiting",
      cost_usd: null,
    });
  });

  it("does not overwrite Stoa's own token totals when they are present", () => {
    const merged = mergeAbtopAgentSnapshots(
      [
        agent({
          tokens: {
            input: 1000,
            output: 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total: 1001,
          },
        }),
      ],
      [session()],
      parseAbtopSnapshot({
        sessions: [
          {
            agent_cli: "codex",
            session_id: "codex-s1",
            cwd: "C:/repo",
            input_tokens: 10,
            output_tokens: 5,
          },
        ],
      })
    );

    expect(merged[0].tokens).toEqual({
      input: 1000,
      output: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total: 1001,
    });
  });

  it("does not merge a same-agent external session just because it shares cwd", () => {
    const merged = mergeAbtopAgentSnapshots(
      [agent()],
      [session()],
      parseAbtopSnapshot({
        sessions: [
          {
            agent_cli: "codex",
            session_id: "outside-codex",
            project_name: "outside-repo",
            cwd: "C:/repo",
            model: "gpt-5-external",
          },
        ],
      })
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: "s1", source: "stoa", model: null });
    expect(merged[1]).toMatchObject({
      id: "abtop:codex:outside-codex",
      source: "abtop",
      model: "gpt-5-external",
    });
  });
});
