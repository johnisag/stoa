import { describe, it, expect } from "vitest";
import {
  buildMonitorRows,
  monitorStatusRank,
  formatTokens,
  type MonitorRow,
} from "@/lib/agent-monitor";
import type { Session } from "@/lib/db";
import type { SessionCost } from "@/lib/session-cost";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "alpha",
    status: "idle",
    model: "claude-sonnet-4-6",
    agent_type: "claude",
    branch_name: null,
    ...over,
  } as Session;
}

function cost(over: Partial<SessionCost> = {}): SessionCost {
  return {
    name: "alpha",
    model: "claude-sonnet-4-6",
    tokens: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10 },
    costUsd: 0.01,
    contextTokens: 20_000,
    supported: true,
    ...over,
  };
}

describe("buildMonitorRows (#M1 — agent monitor telemetry)", () => {
  it("merges session + cost into a row with totals and a context gauge", () => {
    const rows = buildMonitorRows(
      [session({ id: "a", name: "alpha", branch_name: "feat/x" })],
      { a: cost({ contextTokens: 100_000 }) } // 100k / 200k window = 50%
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.id).toBe("a");
    expect(r.branch).toBe("feat/x");
    expect(r.totalTokens).toBe(360); // 100+50+200+10
    expect(r.costUsd).toBe(0.01);
    expect(r.contextPct).toBeCloseTo(0.5);
    expect(r.contextTone).toBe("ok");
    expect(r.supported).toBe(true);
  });

  it("zeroes + supported:false for a session with no computed cost", () => {
    const rows = buildMonitorRows(
      [session({ id: "x", agent_type: "codex" })],
      {}
    );
    expect(rows[0].totalTokens).toBe(0);
    expect(rows[0].costUsd).toBeNull();
    expect(rows[0].supported).toBe(false);
    expect(rows[0].contextTokens).toBe(0);
  });

  it("sorts attention-first (waiting/error before running/idle), then by name", () => {
    const rows = buildMonitorRows(
      [
        session({ id: "i", name: "z-idle", status: "idle" }),
        session({ id: "w", name: "m-wait", status: "waiting" }),
        session({ id: "e", name: "a-err", status: "error" }),
        session({ id: "r", name: "b-run", status: "running" }),
      ],
      {}
    );
    expect(rows.map((r) => r.id)).toEqual(["w", "e", "r", "i"]);
  });

  it("a managed status overrides the row's stored status", () => {
    const rows = buildMonitorRows(
      [session({ id: "a", status: "idle" })],
      {},
      {
        a: "waiting",
      }
    );
    expect(rows[0].status).toBe("waiting");
  });

  it("flags a near-full context window", () => {
    const rows = buildMonitorRows([session({ id: "a" })], {
      a: cost({ contextTokens: 190_000 }), // 95% of 200k
    });
    expect(rows[0].contextTone).toBe("full");
    expect(rows[0].contextPct).toBeCloseTo(0.95);
  });
});

describe("monitorStatusRank", () => {
  it("ranks waiting < error < running < idle < dead < unknown", () => {
    expect(monitorStatusRank("waiting")).toBeLessThan(
      monitorStatusRank("error")
    );
    expect(monitorStatusRank("error")).toBeLessThan(
      monitorStatusRank("running")
    );
    expect(monitorStatusRank("running")).toBeLessThan(
      monitorStatusRank("idle")
    );
    expect(monitorStatusRank("idle")).toBeLessThan(monitorStatusRank("dead"));
    expect(monitorStatusRank("dead")).toBeLessThan(monitorStatusRank("???"));
  });
});

describe("formatTokens", () => {
  it("formats compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(980)).toBe("980");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(3_400_000)).toBe("3.4M");
  });
});

// Type-only guard: MonitorRow stays the shape the view renders.
const _row: MonitorRow | null = null;
void _row;
