/**
 * Telemetry Snapshot schema + builder (Tier-0 / M5, abtop-inspired). A normalized,
 * versioned, snake_case JSON view of the whole fleet's telemetry — aligned to abtop's
 * serde `Snapshot` field names (`context_percent`, `cache_read_tokens`, `mcp_servers`,
 * `orphan_ports`, `rate_limits`, …) so an abtop-shaped consumer can read it. Emitted by
 * `GET /api/monitor?format=json` for interop / scripting.
 *
 * This module is PURE: `buildTelemetrySnapshot` maps the data Stoa already computes (the
 * Agent-Monitor rows, the per-session process/port info, the rate-limit window record)
 * into the wire shape. The route gathers the inputs and stamps `generated_at`.
 */

import type { MonitorRow } from "./agent-monitor";
import type { SessionProcessInfo } from "./process-tree";
import type { RateLimitWindowRecord } from "./rate-limit-window";

/** Schema identifier — bump the suffix on any breaking shape change so consumers adapt. */
export const SNAPSHOT_SCHEMA = "stoa.monitor.v1";

/** One rolling rate-limit window's utilization. */
export interface WindowSnapshot {
  /** Percent of the window consumed, 0..100. */
  used_percent: number;
}

/** Claude's rolling rate-limit windows (account-global). */
export interface RateLimitsSnapshot {
  five_hour: WindowSnapshot | null;
  seven_day: WindowSnapshot | null;
  /** epoch-ms the most-constrained window resets, or null if unknown. */
  reset_at: number | null;
}

/** Per-agent token usage (disjoint buckets). */
export interface TokensSnapshot {
  input: number;
  output: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total: number;
}

/** One agent/session's telemetry. */
export interface AgentSnapshot {
  /** Where this row came from. `abtop` rows are external/read-only, not Stoa-controllable. */
  source: "stoa" | "abtop";
  id: string;
  name: string;
  agent_type: string;
  model: string | null;
  status: string;
  branch: string | null;
  /** Context-window occupancy, 0..100. */
  context_percent: number;
  context_tokens: number;
  tokens: TokensSnapshot;
  cost_usd: number | null;
  /** Descendant process count (M3). */
  child_processes: number;
  /** MCP server names detected under the session (M3). */
  mcp_servers: string[];
  /** Every listening port attributed to the session's tree (M4). */
  ports: number[];
  /** The subset of `ports` Stoa doesn't manage — agent-spawned (M4). */
  orphan_ports: number[];
}

/** The whole-fleet telemetry snapshot. */
export interface TelemetrySnapshot {
  schema: string;
  /** epoch-ms the snapshot was produced. */
  generated_at: number;
  rate_limits: RateLimitsSnapshot | null;
  agents: AgentSnapshot[];
}

/** One rolling window's percent (0..100), or null when the fraction is absent /
 *  non-finite / negative. Clamps to [0,1] before scaling — matching windowUtilization's
 *  `min(1, max(0, …))`, so this export and the cost route agree on the same record and
 *  the documented 0..100 invariant always holds even if the hook writes a bad value. */
function windowPercent(frac: number | undefined): WindowSnapshot | null {
  if (typeof frac !== "number" || !Number.isFinite(frac) || frac < 0)
    return null;
  return { used_percent: Math.round(Math.min(1, frac) * 100) };
}

/** Map the M2a record's 0..1 window fractions to the snapshot's 0..100 percents, or null
 *  when neither window is known. Pure. */
function buildRateLimits(
  rec: RateLimitWindowRecord | null
): RateLimitsSnapshot | null {
  if (!rec) return null;
  const five = windowPercent(rec.fiveHourPct);
  const seven = windowPercent(rec.sevenDayPct);
  if (!five && !seven) return null;
  return { five_hour: five, seven_day: seven, reset_at: rec.resetAt ?? null };
}

/**
 * Build the abtop-aligned telemetry snapshot from Stoa's already-computed data. Pure →
 * unit-tested; `generatedAt` is injected (the route passes Date.now()). A row with no
 * matching process info just reports zero processes / no ports.
 */
export function buildTelemetrySnapshot(input: {
  generatedAt: number;
  rateLimit: RateLimitWindowRecord | null;
  rows: MonitorRow[];
  processInfo: Record<string, SessionProcessInfo>;
}): TelemetrySnapshot {
  const agents = input.rows.map((r): AgentSnapshot => {
    const proc = input.processInfo[r.id];
    const ports = proc?.ports ?? [];
    return {
      source: "stoa",
      id: r.id,
      name: r.name,
      agent_type: r.agentType,
      model: r.model,
      status: r.status,
      branch: r.branch,
      context_percent: Math.round(r.contextPct * 100),
      context_tokens: r.contextTokens,
      tokens: {
        input: r.tokens.input,
        output: r.tokens.output,
        cache_read_tokens: r.tokens.cacheRead,
        cache_write_tokens: r.tokens.cacheWrite,
        total: r.totalTokens,
      },
      cost_usd: r.costUsd,
      child_processes: proc?.childCount ?? 0,
      mcp_servers: proc?.mcpServers ?? [],
      ports: ports.map((p) => p.port),
      orphan_ports: ports.filter((p) => p.orphan).map((p) => p.port),
    };
  });
  return {
    schema: SNAPSHOT_SCHEMA,
    generated_at: input.generatedAt,
    rate_limits: buildRateLimits(input.rateLimit),
    agents,
  };
}
