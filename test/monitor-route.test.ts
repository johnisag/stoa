import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionProcessInfo } from "@/lib/process-tree";
import type { RateLimitWindowRecord } from "@/lib/rate-limit-window";
import type { AbtopAgentTelemetry } from "@/lib/abtop-sensor";

// Mock the heavy gather (cost computation, process/port snapshot, rate-limit read) but let
// the REAL buildMonitorRows + buildTelemetrySnapshot run, so the test exercises the route's
// actual end-to-end mapping into the wire shape.
const state = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  costs: {} as Record<string, unknown>,
  processInfo: {} as Record<string, SessionProcessInfo>,
  rateLimit: null as RateLimitWindowRecord | null,
  abtopAgents: [] as AbtopAgentTelemetry[],
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: { getAllSessions: () => ({ all: () => state.sessions }) },
}));
vi.mock("@/lib/session-cost", () => ({
  computeSessionCosts: vi.fn(async () => state.costs),
}));
vi.mock("@/lib/monitor-collect", () => ({
  collectMonitorProcessInfo: vi.fn(async () => state.processInfo),
}));
vi.mock("@/lib/rate-limit-window-source", () => ({
  readRateLimitWindowRecord: vi.fn(() => state.rateLimit),
}));
vi.mock("@/lib/abtop-sensor", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/abtop-sensor")>(
      "@/lib/abtop-sensor"
    );
  return {
    ...actual,
    collectAbtopTelemetry: vi.fn(async () => state.abtopAgents),
  };
});

import { GET } from "@/app/api/monitor/route";
import type { NextRequest } from "next/server";

function reqWith(qs: string): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(qs) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  state.sessions = [];
  state.costs = {};
  state.processInfo = {};
  state.rateLimit = null;
  state.abtopAgents = [];
});

describe("GET /api/monitor (M5 telemetry snapshot)", () => {
  it("emits an abtop-aligned snapshot for ?format=json", async () => {
    state.sessions = [
      {
        id: "s1",
        name: "sess",
        agent_type: "claude",
        status: "running",
        branch_name: "feature/x",
        model: "opus",
      },
    ];
    state.costs = {
      s1: {
        model: "opus",
        tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 },
        costUsd: 0.42,
        contextTokens: 8000,
        supported: true,
      },
    };
    state.processInfo = {
      s1: {
        childCount: 2,
        mcpServers: ["mcp-server-git"],
        ports: [{ port: 8080, orphan: true }],
      },
    };
    state.rateLimit = {
      fiveHourPct: 0.5,
      sevenDayPct: 0.2,
      resetAt: 99,
      updatedAt: 1,
    };

    const body = await (await GET(reqWith("format=json"))).json();
    expect(body.schema).toBe("stoa.monitor.v1");
    expect(typeof body.generated_at).toBe("number");
    expect(body.rate_limits).toEqual({
      five_hour: { used_percent: 50 },
      seven_day: { used_percent: 20 },
      reset_at: 99,
    });
    expect(body.agents).toHaveLength(1);
    const a = body.agents[0];
    expect(a.source).toBe("stoa");
    expect(a.id).toBe("s1");
    expect(a.agent_type).toBe("claude");
    expect(a.mcp_servers).toEqual(["mcp-server-git"]);
    expect(a.ports).toEqual([8080]);
    expect(a.orphan_ports).toEqual([8080]);
    expect(a.tokens.cache_read_tokens).toBe(5);
    expect(a.cost_usd).toBe(0.42);
  });

  it("rejects an unsupported format with 400", async () => {
    const res = await GET(reqWith("format=xml"));
    expect(res.status).toBe(400);
  });

  it("defaults to the snapshot (empty fleet) when format is omitted", async () => {
    const body = await (await GET(reqWith(""))).json();
    expect(body.schema).toBe("stoa.monitor.v1");
    expect(body.agents).toEqual([]);
  });

  it("merges optional abtop sensor telemetry into a matching Stoa session", async () => {
    state.sessions = [
      {
        id: "s1",
        name: "codex-stoa",
        agent_type: "codex",
        status: "running",
        model: "",
        branch_name: null,
        working_directory: "C:/repo",
        worktree_path: null,
        claude_session_id: null,
        tmux_name: "codex-1",
      },
    ];
    state.abtopAgents = [
      {
        id: "abtop:codex:codex-1",
        agentType: "codex",
        sessionId: "codex-1",
        name: "repo",
        cwd: "C:/repo",
        model: "gpt-5-codex",
        status: "running",
        branch: "main",
        contextPct: 0.25,
        contextTokens: 50_000,
        tokens: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 5,
        },
        childCount: 2,
        mcpServers: ["mcp-server-filesystem"],
        ports: [{ port: 5173, orphan: true }],
      },
    ];

    const body = await (await GET(reqWith("format=json"))).json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      source: "stoa",
      id: "s1",
      agent_type: "codex",
      model: "gpt-5-codex",
      branch: "main",
      context_percent: 25,
      context_tokens: 50_000,
      child_processes: 2,
      mcp_servers: ["mcp-server-filesystem"],
      ports: [5173],
      orphan_ports: [5173],
    });
    expect(body.agents[0].tokens).toEqual({
      input: 100,
      output: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 5,
      total: 125,
    });
  });

  it("appends unmatched abtop agents without leaking raw cwd fields", async () => {
    state.abtopAgents = [
      {
        id: "abtop:codex:outside",
        agentType: "codex",
        sessionId: "outside",
        name: "codex outside",
        cwd: "C:/Users/johnis/secret-repo",
        model: "gpt-5-external",
        status: "waiting",
        branch: null,
        contextPct: 0,
        contextTokens: 0,
        tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        childCount: 0,
        mcpServers: [],
        ports: [],
      },
    ];

    const body = await (await GET(reqWith("format=json"))).json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      source: "abtop",
      id: "abtop:codex:outside",
      agent_type: "codex",
      model: "gpt-5-external",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("cwd");
    expect(serialized).not.toContain("C:/Users/johnis/secret-repo");
  });
});
