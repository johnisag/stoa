/**
 * Persisted token/cost history (#15). Pure mappers/aggregation/sample-gating with
 * no DB, plus a real in-memory SQLite round-trip for the upsert (idempotent per
 * session/day) and the fleet-history read. The DB wrappers take an explicit `db`,
 * so no module mock is needed — a fresh in-memory schema is passed directly.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import {
  costSamplesFromComputed,
  aggregateFleetHistory,
  shouldSampleCost,
  metasFromSessions,
  persistCostSamples,
  getFleetCostHistory,
  costSampleEnabled,
  COST_SAMPLE_INTERVAL_MS,
  COST_SAMPLE_RETENTION_DAYS,
  type SessionCostMeta,
} from "@/lib/cost-history";
import { utcDay } from "@/lib/utc-day";
import type { SessionCost } from "@/lib/session-cost";
import type { Session, SessionCostRow } from "@/lib/db";

const MS_PER_DAY = 86_400_000;

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function cost(partial: Partial<SessionCost>): SessionCost {
  return {
    name: "s",
    model: "claude-sonnet-4-6",
    tokens: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10 },
    costUsd: 0.01,
    contextTokens: 0,
    supported: true,
    ...partial,
  };
}

describe("costSamplesFromComputed (pure)", () => {
  const metas: SessionCostMeta[] = [
    { id: "a", key: "ka", agentType: "claude" },
    { id: "b", key: "kb", agentType: "claude" },
    { id: "c", key: "kc", agentType: "codex" },
  ];

  it("maps supported, non-zero sessions and carries the backend key + agent", () => {
    const samples = costSamplesFromComputed(
      metas,
      { a: cost({}), b: cost({ costUsd: null }), c: cost({}) },
      "2026-06-27"
    );
    expect(samples).toHaveLength(3);
    const a = samples.find((s) => s.sessionId === "a")!;
    expect(a.sessionKey).toBe("ka");
    expect(a.agentType).toBe("claude");
    expect(a.day).toBe("2026-06-27");
    expect(a.tokens.input).toBe(100);
    // a null costUsd (unpriced model) is still persisted — tokens are real.
    expect(samples.find((s) => s.sessionId === "b")!.costUsd).toBeNull();
  });

  it("drops unsupported sessions, zero-token sessions, and metas with no cost", () => {
    const samples = costSamplesFromComputed(
      metas,
      {
        a: cost({ supported: false }), // unsupported
        b: cost({ tokens: ZERO }), // nothing to record yet
        // c: absent → no computed cost
      },
      "2026-06-27"
    );
    expect(samples).toHaveLength(0);
  });
});

describe("aggregateFleetHistory (pure)", () => {
  const row = (
    day: string,
    cost: number | null,
    tokens: number
  ): SessionCostRow => ({
    session_key: `k-${day}-${cost}`,
    day,
    session_id: "s",
    agent_type: "claude",
    model: "m",
    input_tokens: tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: cost,
    updated_at: "",
  });

  it("sums cost + tokens per day across distinct sessions (null cost → 0), sorted", () => {
    // Distinct session_keys (unique per row here) → each is a single sample, so its
    // delta is its full value: this exercises the cross-session per-day sum.
    const out = aggregateFleetHistory([
      row("2026-06-27", 0.02, 10),
      row("2026-06-25", 0.01, 5),
      row("2026-06-27", null, 7), // null cost contributes 0 to cost, 7 to tokens
    ]);
    expect(out.map((p) => p.day)).toEqual(["2026-06-25", "2026-06-27"]);
    expect(out[0]).toEqual({
      day: "2026-06-25",
      costUsd: 0.01,
      totalTokens: 5,
    });
    expect(out[1].costUsd).toBeCloseTo(0.02);
    expect(out[1].totalTokens).toBe(17);
  });

  it("attributes per-day DELTAS for a session sampled across days (not the cumulative)", () => {
    // One session, cumulative 0.01 → 0.03 → 0.03 (idle day). Per-day spend is the
    // increase: 0.01, 0.02, 0. Tokens 100 → 250 → 250 → deltas 100, 150, 0.
    const s = (day: string, cost: number, tok: number): SessionCostRow => ({
      session_key: "sess-1",
      day,
      session_id: "sess-1",
      agent_type: "claude",
      model: "m",
      input_tokens: tok,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: cost,
      updated_at: "",
    });
    const out = aggregateFleetHistory([
      s("2026-06-10", 0.01, 100),
      s("2026-06-11", 0.03, 250),
      s("2026-06-12", 0.03, 250),
    ]);
    expect(out.map((p) => p.costUsd.toFixed(2))).toEqual([
      "0.01",
      "0.02",
      "0.00",
    ]);
    expect(out.map((p) => p.totalTokens)).toEqual([100, 150, 0]);
    // Total telescopes to the latest cumulative (real spend), not 0.07.
    expect(out.reduce((sum, p) => sum + p.costUsd, 0)).toBeCloseTo(0.03);
  });

  it("absorbs a transient drop+recovery against the running PEAK (no double-count)", () => {
    // Cumulative dips (a torn read / truncated transcript) then recovers ABOVE the
    // prior peak. Baselining on the peak books: 0.05, 0 (dip), 0.01 (only 0.06−0.05).
    // A previous-value baseline would wrongly book 0.04 on recovery (0.06−0.02),
    // breaking the telescoping invariant.
    const s = (day: string, cost: number): SessionCostRow => ({
      session_key: "sess-1",
      day,
      session_id: "sess-1",
      agent_type: "claude",
      model: "m",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: cost,
      updated_at: "",
    });
    const out = aggregateFleetHistory([
      s("2026-06-10", 0.05),
      s("2026-06-11", 0.02), // transient dip → books 0
      s("2026-06-12", 0.06), // recovery above the 0.05 peak → books only 0.01
    ]);
    expect(out.map((p) => p.costUsd.toFixed(2))).toEqual([
      "0.05",
      "0.00",
      "0.01",
    ]);
    // Total telescopes to the peak cumulative (real spend), not 0.05+0.04 = 0.09.
    expect(out.reduce((sum, p) => sum + p.costUsd, 0)).toBeCloseTo(0.06);
  });

  it("is [] for no rows", () => {
    expect(aggregateFleetHistory([])).toEqual([]);
  });
});

describe("shouldSampleCost (pure)", () => {
  it("always samples on the first tick (no prior sample)", () => {
    expect(shouldSampleCost(1_000_000, null)).toBe(true);
  });
  it("waits until the interval has elapsed", () => {
    const t0 = 1_000_000;
    expect(shouldSampleCost(t0 + COST_SAMPLE_INTERVAL_MS - 1, t0)).toBe(false);
    expect(shouldSampleCost(t0 + COST_SAMPLE_INTERVAL_MS, t0)).toBe(true);
  });
});

describe("metasFromSessions (pure)", () => {
  it("uses tmux_name as the backend key, falling back to name", () => {
    const sessions = [
      { id: "a", name: "na", tmux_name: "ta", agent_type: "claude" },
      { id: "b", name: "nb", tmux_name: "", agent_type: "codex" },
    ] as unknown as Session[];
    const metas = metasFromSessions(sessions);
    expect(metas[0]).toEqual({ id: "a", key: "ta", agentType: "claude" });
    expect(metas[1].key).toBe("nb"); // empty tmux_name → name
  });
});

describe("costSampleEnabled (env flag)", () => {
  it("is off unless STOA_AUTO_COST_SAMPLE=1", () => {
    const prev = process.env.STOA_AUTO_COST_SAMPLE;
    try {
      delete process.env.STOA_AUTO_COST_SAMPLE;
      expect(costSampleEnabled()).toBe(false);
      process.env.STOA_AUTO_COST_SAMPLE = "0";
      expect(costSampleEnabled()).toBe(false);
      process.env.STOA_AUTO_COST_SAMPLE = "1";
      expect(costSampleEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.STOA_AUTO_COST_SAMPLE;
      else process.env.STOA_AUTO_COST_SAMPLE = prev;
    }
  });
});

describe("persist + read round-trip (in-memory SQLite)", () => {
  let db: InstanceType<typeof Database>;
  const sessions = [
    { id: "a", name: "alpha", tmux_name: "ta", agent_type: "claude" },
    { id: "b", name: "beta", tmux_name: "tb", agent_type: "claude" },
  ] as unknown as Session[];

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    runMigrations(db);
  });

  const dayMs = (day: string) => Date.parse(`${day}T12:00:00.000Z`);

  it("persists supported samples and reads them back as a fleet curve", () => {
    const costs = {
      a: cost({ costUsd: 0.05 }),
      b: cost({
        costUsd: 0.02,
        tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    };
    const n = persistCostSamples(db, sessions, costs, dayMs("2026-06-20"));
    expect(n).toBe(2);
    const hist = getFleetCostHistory(db, "2026-06-01");
    expect(hist).toHaveLength(1);
    expect(hist[0].day).toBe("2026-06-20");
    expect(hist[0].costUsd).toBeCloseTo(0.07);
  });

  it("is idempotent per (session, UTC day): re-sampling updates, never duplicates", () => {
    persistCostSamples(
      db,
      sessions,
      { a: cost({ costUsd: 0.05 }) },
      dayMs("2026-06-20")
    );
    // Same session, same day, higher cumulative cost → overwrite, not a new row.
    persistCostSamples(
      db,
      sessions,
      { a: cost({ costUsd: 0.09 }) },
      dayMs("2026-06-20")
    );
    const rows = db
      .prepare("SELECT * FROM session_costs WHERE session_key = 'ta'")
      .all() as SessionCostRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBeCloseTo(0.09);
  });

  it("getFleetCostHistory honors the sinceDay lower bound AND books the first in-window cumulative", () => {
    persistCostSamples(
      db,
      sessions,
      { a: cost({ costUsd: 0.01 }) },
      dayMs("2026-06-10")
    );
    persistCostSamples(
      db,
      sessions,
      { a: cost({ costUsd: 0.03 }) }, // cumulative grew to 0.03
      dayMs("2026-06-20")
    );
    const recent = getFleetCostHistory(db, "2026-06-15");
    expect(recent.map((p) => p.day)).toEqual(["2026-06-20"]);
    // The pre-window 06-10 row is filtered out, so the first IN-WINDOW sample
    // books its whole cumulative (0.03), not the 0.02 day-over-day delta — spend
    // before the window can't be attributed to unsampled in-window days.
    expect(recent[0].costUsd).toBeCloseTo(0.03);
  });

  it("computes per-day deltas end-to-end for a session sampled across in-window days", () => {
    persistCostSamples(
      db,
      sessions,
      { a: cost({ costUsd: 0.01 }) },
      dayMs("2026-06-18")
    );
    persistCostSamples(
      db,
      sessions,
      { a: cost({ costUsd: 0.05 }) },
      dayMs("2026-06-19")
    );
    const hist = getFleetCostHistory(db, "2026-06-01");
    expect(hist.map((p) => p.day)).toEqual(["2026-06-18", "2026-06-19"]);
    expect(hist[0].costUsd).toBeCloseTo(0.01); // first sample books full cumulative
    expect(hist[1].costUsd).toBeCloseTo(0.04); // 0.05 − 0.01 day-over-day delta
  });

  it("prunes samples older than the retention horizon on write (keeps the cutoff day)", () => {
    const todayMs = dayMs("2026-06-20");
    const cutoffDay = utcDay(todayMs - COST_SAMPLE_RETENTION_DAYS * MS_PER_DAY);
    const cutoffMs = Date.parse(`${cutoffDay}T12:00:00.000Z`);
    // Three distinct days: one before the cutoff (prunable), one exactly at the
    // cutoff (kept — the delete is `day < cutoff`), and today.
    persistCostSamples(db, sessions, { a: cost({}) }, cutoffMs - MS_PER_DAY);
    persistCostSamples(db, sessions, { a: cost({}) }, cutoffMs);
    // Writing today's sample triggers the prune (cutoff = today − retention days).
    persistCostSamples(db, sessions, { a: cost({}) }, todayMs);
    const days = (
      db
        .prepare(
          "SELECT day FROM session_costs WHERE session_key = 'ta' ORDER BY day"
        )
        .all() as { day: string }[]
    ).map((r) => r.day);
    expect(days).toEqual([cutoffDay, "2026-06-20"]); // the pre-cutoff row is gone
  });

  it("writes nothing when no session is supported", () => {
    const n = persistCostSamples(
      db,
      sessions,
      { a: cost({ supported: false }), b: cost({ tokens: ZERO }) },
      dayMs("2026-06-20")
    );
    expect(n).toBe(0);
    expect(getFleetCostHistory(db, "2026-06-01")).toEqual([]);
  });
});
