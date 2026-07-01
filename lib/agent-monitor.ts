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
import {
  ZERO_USAGE,
  totalTokens,
  cacheHitRate as computeCacheHitRate,
  cacheSavingsUsd as computeCacheSavingsUsd,
  type TokenUsage,
} from "./pricing";
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
  /** Prompt-cache hit rate 0..1 (#12) — cacheRead ÷ input-side; null when
   *  unsupported / no input yet. High = most re-sent context was a cheap ~0.1× read. */
  cacheHitRate: number | null;
  /** Estimated USD the prompt cache saved this session vs. full input price (#12), or
   *  null when the model is unpriced. */
  cacheSavingsUsd: number | null;
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
      cacheHitRate: computeCacheHitRate(tokens),
      cacheSavingsUsd: computeCacheSavingsUsd(tokens, model),
      supported: cost?.supported ?? false,
    };
  });
  return rows.sort(
    (a, b) =>
      monitorStatusRank(a.status) - monitorStatusRank(b.status) ||
      a.name.localeCompare(b.name)
  );
}

/**
 * Fleet-wide prompt-cache hit rate (#12): the POOLED cacheRead ÷ input-side across
 * all rows (a session with no cost contributes zeroes), or null when the fleet has
 * processed no input-side tokens yet. Pooling weights by volume — a big cached
 * session dominates a tiny one, which is what a "fleet is caching well" read wants.
 * Pure → unit-tested.
 */
export function fleetCacheHitRate(rows: MonitorRow[]): number | null {
  const pooled = rows.reduce<TokenUsage>(
    (acc, r) => ({
      input: acc.input + r.tokens.input,
      output: acc.output + r.tokens.output,
      cacheRead: acc.cacheRead + r.tokens.cacheRead,
      cacheWrite: acc.cacheWrite + r.tokens.cacheWrite,
    }),
    { ...ZERO_USAGE }
  );
  return computeCacheHitRate(pooled);
}

/**
 * Fleet-wide estimated USD saved by the prompt cache (#12): the sum of each row's
 * `cacheSavingsUsd` (unpriced/unsupported rows contribute nothing), or null when no
 * row is priced. Pure → unit-tested.
 */
export function fleetCacheSavingsUsd(rows: MonitorRow[]): number | null {
  let total = 0;
  let priced = false;
  for (const r of rows) {
    if (r.cacheSavingsUsd != null) {
      total += r.cacheSavingsUsd;
      priced = true;
    }
  }
  return priced ? total : null;
}

/** A 0..1 fraction as a rounded whole-percent string ("83%"), or "—" when null. Pure. */
export function formatPct(fraction: number | null): string {
  return fraction == null ? "—" : `${Math.round(fraction * 100)}%`;
}

/** Compact token count for a glanceable cell: 0, 980, 1.2k, 3.4M. Pure. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}
