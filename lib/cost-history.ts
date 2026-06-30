/**
 * Persisted token/cost history (#15).
 *
 * Stoa's cost estimate ([lib/session-cost.ts](./session-cost.ts)) was recomputed
 * from the live Claude transcript on every request — rich, but with NO history: a
 * sample died when the session was deleted or its transcript scrolled off, so there
 * was nothing but the current snapshot to trend. This module persists a daily
 * sample per session into the `session_costs` table (migration 43) so the history
 * survives, and aggregates it into a fleet spend curve (surfaced in the cost badge;
 * feeding it into the Insights/analytics trends is a follow-up).
 *
 * Split: PURE functions (mapping/aggregation/sample-gating — exhaustively unit
 * tested with no DB) + THIN DB wrappers over the prepared statements in
 * lib/db/queries.ts. Persistence is best-effort and never on a hot path: it runs
 * when costs are already computed (the cost badge GET, or the opt-in
 * STOA_AUTO_COST_SAMPLE background tick).
 */

import type Database from "better-sqlite3";
import { queries, type SessionCostRow, type Session } from "./db";
import { backendKeyForSession } from "./providers/registry";
import { utcDay } from "./utc-day";
import { totalTokens, type TokenUsage } from "./pricing";
import type { SessionCost } from "./session-cost";

/** Default cadence for the opt-in background cost sampler (5 minutes). */
export const COST_SAMPLE_INTERVAL_MS = 5 * 60_000;

/** Keep this many days of samples; older rows are pruned on write so the table
 *  can't grow without bound. Comfortably past the 90-day max read window. */
export const COST_SAMPLE_RETENTION_DAYS = 120;
const MS_PER_DAY = 86_400_000;

/**
 * Is the opt-in background cost sampler on? Off by default — without it, history
 * still accrues whenever the cost badge is open (the GET persists), but the tick
 * keeps it accruing for unattended/overnight runs. Mirrors STOA_AUTO_* opt-ins.
 */
export function costSampleEnabled(): boolean {
  return process.env.STOA_AUTO_COST_SAMPLE === "1";
}

/** A cost sample ready to persist — one session, one UTC day. Pure value. */
export interface CostSample {
  sessionKey: string;
  day: string;
  sessionId: string;
  agentType: string;
  model: string | null;
  tokens: TokenUsage;
  costUsd: number | null;
}

/** Minimal per-session metadata the pure mapper needs (joined with costs by id). */
export interface SessionCostMeta {
  id: string;
  /**
   * Canonical backend key (backendKeyForSession): tmux_name, else {provider}-{id}.
   * MUST be unique per session — it's the session_costs PK with the day. The old
   * `tmux_name || name` fell back to the display NAME, so two same-named pty
   * sessions (tmux_name null) collided on one cost row and clobbered each other.
   */
  key: string;
  agentType: string;
}

/** A point on the fleet spend-history axis (one UTC day). */
export interface FleetCostPoint {
  day: string;
  /** Summed cost across sessions sampled that day (0 when all models unpriced). */
  costUsd: number;
  totalTokens: number;
}

/**
 * Map computed per-session costs → persistable samples for `day`. Pure. Drops
 * sessions that are unsupported or have zero tokens (nothing worth recording yet)
 * so we never write empty rows, and skips a meta whose cost wasn't computed.
 */
export function costSamplesFromComputed(
  metas: SessionCostMeta[],
  costs: Record<string, SessionCost>,
  day: string
): CostSample[] {
  const out: CostSample[] = [];
  for (const m of metas) {
    const c = costs[m.id];
    if (!c || !c.supported) continue;
    if (totalTokens(c.tokens) <= 0) continue;
    out.push({
      sessionKey: m.key,
      day,
      sessionId: m.id,
      agentType: m.agentType,
      model: c.model,
      tokens: c.tokens,
      costUsd: c.costUsd,
    });
  }
  return out;
}

/**
 * Aggregate persisted sample rows into a per-day fleet spend curve. Pure.
 *
 * Each row holds a session's CUMULATIVE usage as of that day, so summing rows
 * across days would double-count a session sampled on many days. Instead we
 * attribute to each day the INCREASE over that session's running peak (a
 * per-session day-over-day delta), then sum those deltas across sessions per day —
 * a true "spend on day D" curve whose total telescopes to each session's PEAK
 * cumulative = real total spend. A session's FIRST in-window sample books its whole
 * cumulative on that day (we can't attribute spend to days we never sampled, incl.
 * before the read window). Cumulative usage is monotonic in reality, so a DROP is
 * an artifact (a torn read of a transcript mid-write, or a transcript truncated by
 * resume/compaction): we baseline on the running PEAK (not the previous value), so
 * a transient dip is fully absorbed and a later recovery above the old peak isn't
 * re-counted. Tokens follow the same peak-delta rule, tracked independently of cost
 * (a model reprice can move them apart).
 */
export function aggregateFleetHistory(
  rows: SessionCostRow[]
): FleetCostPoint[] {
  const bySession = new Map<string, SessionCostRow[]>();
  for (const r of rows) {
    const list = bySession.get(r.session_key);
    if (list) list.push(r);
    else bySession.set(r.session_key, [r]);
  }

  const byDay = new Map<string, FleetCostPoint>();
  const addToDay = (day: string, cost: number, tokens: number) => {
    let p = byDay.get(day);
    if (!p) {
      p = { day, costUsd: 0, totalTokens: 0 };
      byDay.set(day, p);
    }
    p.costUsd += cost;
    p.totalTokens += tokens;
  };

  for (const list of bySession.values()) {
    const chronological = [...list].sort((a, b) =>
      a.day < b.day ? -1 : a.day > b.day ? 1 : 0
    );
    let peakCost = 0;
    let peakTokens = 0;
    for (const r of chronological) {
      const cost = r.cost_usd ?? 0;
      const tokens =
        r.input_tokens +
        r.output_tokens +
        r.cache_read_tokens +
        r.cache_write_tokens;
      addToDay(
        r.day,
        Math.max(0, cost - peakCost),
        Math.max(0, tokens - peakTokens)
      );
      peakCost = Math.max(peakCost, cost);
      peakTokens = Math.max(peakTokens, tokens);
    }
  }

  return [...byDay.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0
  );
}

/**
 * Should the opt-in background sampler run now? True on the first tick (no prior
 * sample) or once at least `intervalMs` has elapsed. Pure → unit-tested.
 */
export function shouldSampleCost(
  nowMs: number,
  lastSampleMs: number | null,
  intervalMs: number = COST_SAMPLE_INTERVAL_MS
): boolean {
  if (lastSampleMs == null) return true;
  return nowMs - lastSampleMs >= intervalMs;
}

/** Build the pure mapper's metadata from full Session rows (backend key + agent).
 *  Keys on backendKeyForSession (tmux_name, else the unique {provider}-{id}) so a
 *  pty session with no tmux_name can't collide with another by display name. */
export function metasFromSessions(sessions: Session[]): SessionCostMeta[] {
  return sessions.map((s) => ({
    id: s.id,
    key: backendKeyForSession(s),
    agentType: s.agent_type,
  }));
}

/**
 * Persist today's cost samples for the given sessions (best-effort). Idempotent
 * per (session_key, UTC day): re-running the same day overwrites that day's row
 * with the latest cumulative numbers. Returns the number of rows written. A bad
 * row is logged and skipped — never throws (callers run it as a side effect).
 */
export function persistCostSamples(
  db: Database.Database,
  sessions: Session[],
  costs: Record<string, SessionCost>,
  nowMs: number = Date.now()
): number {
  const day = utcDay(nowMs);
  const samples = costSamplesFromComputed(
    metasFromSessions(sessions),
    costs,
    day
  );
  const stmt = queries.upsertCostSample(db);
  let written = 0;
  for (const s of samples) {
    try {
      stmt.run(
        s.sessionKey,
        s.day,
        s.sessionId,
        s.agentType,
        s.model,
        s.tokens.input,
        s.tokens.output,
        s.tokens.cacheRead,
        s.tokens.cacheWrite,
        s.costUsd
      );
      written++;
    } catch (err) {
      console.warn(
        `cost-history: failed to persist sample for ${s.sessionKey}:`,
        err
      );
    }
  }
  // Prune samples past the retention horizon (cheap indexed delete, usually a
  // no-op). Best-effort: pruning must never fail a write.
  try {
    const cutoff = utcDay(nowMs - COST_SAMPLE_RETENTION_DAYS * MS_PER_DAY);
    queries.deleteCostSamplesBefore(db).run(cutoff);
  } catch (err) {
    console.warn("cost-history: retention prune failed (non-fatal):", err);
  }
  return written;
}

/** Fetch + aggregate the fleet spend history on/after `sinceDay` (UTC 'YYYY-MM-DD'). */
export function getFleetCostHistory(
  db: Database.Database,
  sinceDay: string
): FleetCostPoint[] {
  const rows = queries
    .getCostSamplesSince(db)
    .all(sinceDay) as SessionCostRow[];
  return aggregateFleetHistory(rows);
}
