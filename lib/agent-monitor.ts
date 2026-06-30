/**
 * Agent Monitor — pure helpers (no I/O, no React) for the read-only "htop for your
 * AI agents" fleet view (Tier-0 / M1, inspired by graykode/abtop). The view
 * (components/views/AgentMonitorView) is a per-session telemetry table built ENTIRELY
 * from data Stoa already computes — the session roster, the cost/usage estimate
 * (lib/session-cost.ts via /api/sessions/cost), and the managed status — so it adds
 * no new backend: it merges those into one glanceable row per live session.
 *
 * abtop is the read-only OBSERVABILITY half of Stoa's domain; Stoa is the CONTROL
 * plane. We port the IDEA natively in TS (no Rust binary) and cover ALL providers.
 * The merge/format/sort is the only logic worth testing, so it lives here.
 */

import type { Session } from "./db";
import type { SessionCost } from "./session-cost";
import { ZERO_USAGE, totalTokens, type TokenUsage } from "./pricing";
import {
  contextWindowFor,
  tokenMeter,
  type ContextTone,
} from "./context-window";

/** One glanceable row of per-session telemetry. */
export interface MonitorRow {
  id: string;
  name: string;
  agentType: string;
  model: string | null;
  /** Managed status when known (waiting/error/running/idle/dead), else the row's. */
  status: string;
  /** Worktree branch if any (free off the session row — no git I/O). */
  branch: string | null;
  tokens: TokenUsage;
  totalTokens: number;
  costUsd: number | null;
  /** Live context-window occupancy (last turn's input), tokens. */
  contextTokens: number;
  /** Fraction of the model's context window in use, 0..1. */
  contextPct: number;
  /** Tint band for the context gauge. */
  contextTone: ContextTone;
  /** True when a cost/usage estimate is available (a Claude transcript today). */
  supported: boolean;
}

// Attention-first ordering: the sessions you'd act on come first, so the top of the
// monitor is always "what needs me". Unknown statuses sort last.
const STATUS_RANK: Record<string, number> = {
  waiting: 0,
  error: 1,
  running: 2,
  idle: 3,
  dead: 4,
};

/** Sort rank for a status (lower = more urgent). Pure. */
export function monitorStatusRank(status: string): number {
  return STATUS_RANK[status] ?? 5;
}

/**
 * Merge the session roster with the cost/usage estimate (and optional managed
 * statuses) into per-session monitor rows, sorted attention-first then by name
 * (stable + deterministic). Pure → unit-tested. A session with no computed cost
 * shows zeroes + supported:false (e.g. a non-Claude agent), never throwing.
 */
export function buildMonitorRows(
  sessions: Session[],
  costs: Record<string, SessionCost>,
  statusById: Record<string, string> = {}
): MonitorRow[] {
  const rows = sessions.map((s): MonitorRow => {
    const cost = costs[s.id];
    const tokens = cost?.tokens ?? ZERO_USAGE;
    const model = cost?.model ?? s.model ?? null;
    const contextTokens = cost?.contextTokens ?? 0;
    const meter = tokenMeter(contextTokens, contextWindowFor(model));
    return {
      id: s.id,
      name: s.name,
      agentType: s.agent_type,
      model,
      status: statusById[s.id] ?? s.status,
      branch: s.branch_name ?? null,
      tokens,
      totalTokens: totalTokens(tokens),
      costUsd: cost?.costUsd ?? null,
      contextTokens,
      contextPct: meter.pct,
      contextTone: meter.tone,
      supported: cost?.supported ?? false,
    };
  });
  return rows.sort(
    (a, b) =>
      monitorStatusRank(a.status) - monitorStatusRank(b.status) ||
      a.name.localeCompare(b.name)
  );
}

/** Compact token count for a glanceable cell: 0, 980, 1.2k, 3.4M. Pure. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}
