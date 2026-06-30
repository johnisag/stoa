import { describe, it, expect } from "vitest";
import {
  buildTelemetrySnapshot,
  SNAPSHOT_SCHEMA,
} from "@/lib/monitor-snapshot";
import type { MonitorRow } from "@/lib/agent-monitor";
import type { SessionProcessInfo } from "@/lib/process-tree";
import type { RateLimitWindowRecord } from "@/lib/rate-limit-window";

const NOW = 1_700_000_000_000;

function row(over: Partial<MonitorRow> = {}): MonitorRow {
  return {
    id: "s1",
    name: "sess",
    agentType: "claude",
    model: "opus",
    status: "running",
    branch: "feature/x",
    tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 },
    totalTokens: 128,
    costUsd: 0.42,
    contextTokens: 8000,
    contextPct: 0.04,
    contextTone: "ok",
    supported: true,
    ...over,
  };
}

describe("buildTelemetrySnapshot (M5 — abtop-aligned wire shape)", () => {
  it("maps a row + its process info into a snake_case agent snapshot", () => {
    const processInfo: Record<string, SessionProcessInfo> = {
      s1: {
        childCount: 4,
        mcpServers: ["mcp-server-git"],
        ports: [
          { port: 3000, orphan: false },
          { port: 8080, orphan: true },
        ],
      },
    };
    const snap = buildTelemetrySnapshot({
      generatedAt: NOW,
      rateLimit: null,
      rows: [row()],
      processInfo,
    });

    expect(snap.schema).toBe(SNAPSHOT_SCHEMA);
    expect(snap.generated_at).toBe(NOW);
    expect(snap.rate_limits).toBeNull();
    expect(snap.agents).toEqual([
      {
        id: "s1",
        name: "sess",
        agent_type: "claude",
        model: "opus",
        status: "running",
        branch: "feature/x",
        context_percent: 4, // round(0.04 * 100)
        context_tokens: 8000,
        tokens: {
          input: 100,
          output: 20,
          cache_read_tokens: 5,
          cache_write_tokens: 3,
          total: 128,
        },
        cost_usd: 0.42,
        child_processes: 4,
        mcp_servers: ["mcp-server-git"],
        ports: [3000, 8080],
        orphan_ports: [8080], // only the orphan
      },
    ]);
  });

  it("zero-fills an agent that has no matching process info", () => {
    const snap = buildTelemetrySnapshot({
      generatedAt: NOW,
      rateLimit: null,
      rows: [row({ id: "x" })],
      processInfo: {},
    });
    const a = snap.agents[0];
    expect(a.child_processes).toBe(0);
    expect(a.mcp_servers).toEqual([]);
    expect(a.ports).toEqual([]);
    expect(a.orphan_ports).toEqual([]);
  });

  it("converts the rate-limit record's 0..1 fractions to 0..100 percents", () => {
    const rec: RateLimitWindowRecord = {
      fiveHourPct: 0.235,
      sevenDayPct: 0.41,
      resetAt: 1234,
      updatedAt: NOW,
    };
    const snap = buildTelemetrySnapshot({
      generatedAt: NOW,
      rateLimit: rec,
      rows: [],
      processInfo: {},
    });
    expect(snap.rate_limits).toEqual({
      five_hour: { used_percent: 24 }, // round(23.5)
      seven_day: { used_percent: 41 },
      reset_at: 1234,
    });
  });

  it("clamps an out-of-range window fraction to 0..100 and drops a negative (Gate D)", () => {
    const rec: RateLimitWindowRecord = {
      fiveHourPct: 1.5, // a bad hook value → clamp to 100, not 150
      sevenDayPct: -0.1, // negative → unknown (null), not -10
      updatedAt: NOW,
    };
    const snap = buildTelemetrySnapshot({
      generatedAt: NOW,
      rateLimit: rec,
      rows: [],
      processInfo: {},
    });
    expect(snap.rate_limits).toEqual({
      five_hour: { used_percent: 100 },
      seven_day: null,
      reset_at: null,
    });
  });

  it("rate_limits null with no record; a missing window is null (not 0)", () => {
    expect(
      buildTelemetrySnapshot({
        generatedAt: NOW,
        rateLimit: null,
        rows: [],
        processInfo: {},
      }).rate_limits
    ).toBeNull();

    const fiveOnly: RateLimitWindowRecord = {
      fiveHourPct: 0.5,
      updatedAt: NOW,
    };
    expect(
      buildTelemetrySnapshot({
        generatedAt: NOW,
        rateLimit: fiveOnly,
        rows: [],
        processInfo: {},
      }).rate_limits
    ).toEqual({
      five_hour: { used_percent: 50 },
      seven_day: null,
      reset_at: null,
    });
  });
});
