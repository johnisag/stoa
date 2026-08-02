import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";

export interface FleetAnalytics {
  runLimit: number;
  runCount: number;
  archivedRunCount: number;
  runOutcomes: Record<string, number>;
  taskOutcomes: Record<string, number>;
  providerOutcomes: Record<
    string,
    { total: number; completed: number; failed: number; other: number }
  >;
  durations: {
    completedRuns: number;
    averageSeconds: number | null;
    maximumSeconds: number | null;
  };
  budget: {
    configuredUsd: number;
    reservedUsd: number;
    spentUsd: number;
    configuredTokens: number;
    reservedTokens: number;
    spentTokens: number;
    confidence: Record<string, number>;
  };
}

interface AnalyticsRunRow {
  id: string;
  status: string;
  budget_usd: number | null;
  reserved_budget_usd: number;
  spent_budget_usd: number;
  budget_tokens: number | null;
  reserved_budget_tokens: number;
  spent_budget_tokens: number;
  cost_confidence: string;
  started_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
}

function boundedLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), 500)
    : 100;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function roundedCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function getFleetAnalytics(
  options: { limitRuns?: number; db?: Database.Database } = {}
): FleetAnalytics {
  const db = options.db ?? getDb();
  const runLimit = boundedLimit(options.limitRuns);
  const runs = db
    .prepare(
      `SELECT id, status, budget_usd, reserved_budget_usd, spent_budget_usd,
              budget_tokens, reserved_budget_tokens, spent_budget_tokens,
              cost_confidence,
              started_at, ended_at, archived_at
       FROM fleet_runs ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(runLimit) as AnalyticsRunRow[];
  const runOutcomes: Record<string, number> = {};
  const taskOutcomes: Record<string, number> = {};
  const providerOutcomes: FleetAnalytics["providerOutcomes"] = {};
  let archivedRunCount = 0;
  let configuredUsd = 0;
  let reservedUsd = 0;
  let spentUsd = 0;
  let configuredTokens = 0;
  let reservedTokens = 0;
  let spentTokens = 0;
  const costConfidence: Record<string, number> = {};
  const durations: number[] = [];
  for (const run of runs) {
    increment(runOutcomes, run.status);
    if (run.archived_at) archivedRunCount += 1;
    configuredUsd += run.budget_usd ?? 0;
    reservedUsd += run.reserved_budget_usd ?? 0;
    spentUsd += run.spent_budget_usd ?? 0;
    configuredTokens += run.budget_tokens ?? 0;
    reservedTokens += run.reserved_budget_tokens ?? 0;
    spentTokens += run.spent_budget_tokens ?? 0;
    increment(costConfidence, run.cost_confidence || "unknown");
    if (run.started_at && run.ended_at) {
      const started = Date.parse(run.started_at);
      const ended = Date.parse(run.ended_at);
      if (
        Number.isFinite(started) &&
        Number.isFinite(ended) &&
        ended >= started
      ) {
        durations.push((ended - started) / 1000);
      }
    }
  }

  if (runs.length > 0) {
    const placeholders = runs.map(() => "?").join(", ");
    const runIds = runs.map((run) => run.id);
    const taskRows = db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM fleet_tasks
         WHERE fleet_run_id IN (${placeholders}) GROUP BY status`
      )
      .all(...runIds) as { status: string; count: number }[];
    for (const row of taskRows) taskOutcomes[row.status] = row.count;

    const workerRows = db
      .prepare(
        `SELECT COALESCE(provider, 'unknown') AS provider, status,
                COUNT(*) AS count
         FROM fleet_workers WHERE fleet_run_id IN (${placeholders})
         GROUP BY COALESCE(provider, 'unknown'), status`
      )
      .all(...runIds) as Array<{
      provider: string;
      status: string;
      count: number;
    }>;
    for (const row of workerRows) {
      const outcome = (providerOutcomes[row.provider] ??= {
        total: 0,
        completed: 0,
        failed: 0,
        other: 0,
      });
      outcome.total += row.count;
      if (row.status === "completed") outcome.completed += row.count;
      else if (["failed", "dead", "canceled"].includes(row.status)) {
        outcome.failed += row.count;
      } else outcome.other += row.count;
    }
  }

  const durationTotal = durations.reduce((sum, value) => sum + value, 0);
  return {
    runLimit,
    runCount: runs.length,
    archivedRunCount,
    runOutcomes,
    taskOutcomes,
    providerOutcomes,
    durations: {
      completedRuns: durations.length,
      averageSeconds:
        durations.length > 0
          ? Math.round((durationTotal / durations.length) * 1000) / 1000
          : null,
      maximumSeconds: durations.length > 0 ? Math.max(...durations) : null,
    },
    budget: {
      configuredUsd: roundedCurrency(configuredUsd),
      reservedUsd: roundedCurrency(reservedUsd),
      spentUsd: roundedCurrency(spentUsd),
      configuredTokens,
      reservedTokens,
      spentTokens,
      confidence: costConfidence,
    },
  };
}
