import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { FLEET_MAX_TOTAL_WORKERS } from "./admission";
import { fleetProviderRetryNotBefore } from "./backoff";
import {
  canonicalFleetResourceKey,
  evaluateFleetResourceAdmission,
  FLEET_DEFAULT_RESOURCE_LIMITS,
  normalizeFleetResourceLimits,
  type FleetResourceAdmissionDecision,
  type FleetResourceKind,
  type FleetResourceLimits,
  type FleetResourceUnits,
} from "./resource-admission";
import type { FleetRunRow } from "./types";
import { redactAndCapFleetText } from "./redaction";

const PER_RUN_USAGE_RESOURCE_KINDS = new Set<FleetResourceKind>([
  "output_bytes_per_minute",
  "artifact_bytes_per_minute",
  "artifact_bytes_total",
  "event_bytes_per_minute",
  "event_fanout_per_minute",
  "event_bytes_total",
]);

// These are real host/repository capacities and therefore intentionally count
// active leases across runs. Per-run storage and throughput quotas are kept in
// the separately scoped usage table above.
const HOST_GLOBAL_LEASE_RESOURCE_KINDS = new Set<FleetResourceKind>([
  "pty",
  "transport_host",
  "provider",
  "verifier",
  "git_operation",
  "merge_operation",
  "repo_worktree",
  "disk_bytes",
]);

export type FleetRuntimeUsageKind =
  | "output_bytes_per_minute"
  | "artifact_bytes_per_minute"
  | "artifact_bytes_total"
  | "event_bytes_per_minute"
  | "event_fanout_per_minute"
  | "event_bytes_total";

export interface FleetRuntimeResourceRequest {
  runId: string;
  ownerType: string;
  ownerId: string;
  resources: readonly FleetResourceUnits[];
  limits: FleetResourceLimits;
  now: Date;
  leaseExpiresAt?: string | null;
}

export type FleetRuntimeResourceResult =
  | { admitted: true; leaseIds: string[]; bucketStartMs: number }
  | {
      admitted: false;
      blocked: FleetResourceAdmissionDecision["blocked"];
      retryAt: string | null;
    };

interface RuntimeLeaseRow {
  fleet_run_id: string;
  owner_type: string;
  resource_type: FleetResourceKind;
  resource_key: string;
  units: number;
}

interface UsageBucketRow {
  resource_type: FleetResourceKind;
  resource_key: string;
  units: number;
}

function transaction<T>(db: Database.Database, fn: () => T): T {
  if (db.inTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function minuteBucket(now: Date): number {
  return Math.floor(now.getTime() / 60_000) * 60_000;
}

function isPerRunUsageResource(kind: FleetResourceKind): boolean {
  return PER_RUN_USAGE_RESOURCE_KINDS.has(kind);
}

function usageBucketStart(
  kind: FleetResourceKind,
  minuteStart: number
): number {
  return kind === "artifact_bytes_total" || kind === "event_bytes_total"
    ? 0
    : minuteStart;
}

function aggregateRuntimeResources(
  resources: readonly FleetResourceUnits[]
): FleetResourceUnits[] {
  const aggregated = new Map<string, FleetResourceUnits>();
  for (const resource of resources) {
    const key = canonicalFleetResourceKey(resource);
    const id = `${resource.kind}\0${key}`;
    const current = aggregated.get(id);
    aggregated.set(id, {
      kind: resource.kind,
      key,
      units: (current?.units ?? 0) + resource.units,
    });
  }
  return [...aggregated.values()];
}

function parseObject(
  value: string | null | undefined
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function fleetResourceLimitsForRun(
  run: FleetRunRow
): FleetResourceLimits {
  return normalizeFleetResourceLimits({
    ...(parseObject(run.resource_limits_json) as Partial<FleetResourceLimits>),
    providerCaps: parseObject(run.provider_caps_json) as Readonly<
      Record<string, number>
    >,
  });
}

export function fleetWorkerResourceRequest(input: {
  provider: string;
  repositoryKey: string;
  estimatedDiskBytes?: number;
}): FleetResourceUnits[] {
  return [
    { kind: "pty", key: "local", units: 1 },
    { kind: "transport_host", key: "local", units: 1 },
    { kind: "provider", key: input.provider, units: 1 },
    { kind: "git_operation", key: input.repositoryKey, units: 1 },
    { kind: "repo_worktree", key: input.repositoryKey, units: 1 },
    {
      kind: "disk_bytes",
      key: "fleet",
      units: input.estimatedDiskBytes ?? 512 * 1024 ** 2,
    },
  ];
}

/** Atomically charge actual output/artifact/event usage at its durable boundary. */
export function chargeFleetRuntimeUsageBatch(
  db: Database.Database,
  input: {
    runId: string;
    usage: readonly {
      kind: FleetRuntimeUsageKind;
      units: number;
      key?: string;
    }[];
    now: Date;
  }
): FleetRuntimeResourceResult {
  const run = db
    .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
    .get(input.runId) as FleetRunRow | undefined;
  if (!run) {
    return {
      admitted: false,
      retryAt: null,
      blocked: input.usage.map((usage) => ({
        kind: usage.kind,
        key: usage.key ?? "fleet",
        capacity: 0,
        used: 0,
        requested: usage.units,
        reason: "invalid-request" as const,
      })),
    };
  }
  return acquireFleetRuntimeResources(db, {
    runId: input.runId,
    ownerType: "runtime_usage",
    ownerId: `${input.runId}:runtime-usage`,
    resources: input.usage.map((usage) => ({
      kind: usage.kind,
      key: usage.key ?? "fleet",
      units: usage.units,
    })),
    limits: fleetResourceLimitsForRun(run),
    now: input.now,
  });
}

export function chargeFleetRuntimeUsage(
  db: Database.Database,
  input: {
    runId: string;
    kind: FleetRuntimeUsageKind;
    units: number;
    now: Date;
    key?: string;
  }
): FleetRuntimeResourceResult {
  return chargeFleetRuntimeUsageBatch(db, {
    runId: input.runId,
    usage: [{ kind: input.kind, units: input.units, key: input.key }],
    now: input.now,
  });
}

/** Atomically acquire all leases/rate reservations or write nothing. */
export function acquireFleetRuntimeResources(
  db: Database.Database,
  input: FleetRuntimeResourceRequest
): FleetRuntimeResourceResult {
  return transaction(db, () => {
    const nowIso = input.now.toISOString();
    const bucketStartMs = minuteBucket(input.now);
    const requestedResources = aggregateRuntimeResources(input.resources);
    db.prepare(
      `UPDATE fleet_runtime_leases
       SET status = 'expired', released_at = ?
       WHERE status = 'reserved' AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?`
    ).run(nowIso, nowIso);
    db.prepare(
      `DELETE FROM fleet_resource_usage_buckets
       WHERE bucket_start_ms > 0 AND bucket_start_ms < ?`
    ).run(bucketStartMs - 60 * 60_000);

    const providerRequests = requestedResources.filter(
      (resource) => resource.kind === "provider"
    );
    let retryAt: string | null = null;
    for (const request of providerRequests) {
      const provider = canonicalFleetResourceKey(request);
      const cooldown = db
        .prepare(
          `SELECT blocked_until FROM fleet_provider_cooldowns
           WHERE provider = ? AND blocked_until > ?`
        )
        .get(provider, nowIso) as { blocked_until: string } | undefined;
      if (cooldown && (!retryAt || cooldown.blocked_until > retryAt)) {
        retryAt = cooldown.blocked_until;
      }
    }
    if (retryAt) {
      return {
        admitted: false,
        retryAt,
        blocked: providerRequests.map((request) => ({
          kind: request.kind,
          key: canonicalFleetResourceKey(request),
          capacity: 0,
          used: 0,
          requested: request.units,
          reason: "capacity" as const,
        })),
      };
    }

    const leaseUsage = db
      .prepare(
        `SELECT fleet_run_id, owner_type, resource_type, resource_key,
                SUM(units) AS units
         FROM fleet_runtime_leases WHERE status = 'reserved'
         GROUP BY fleet_run_id, owner_type, resource_type, resource_key`
      )
      .all() as RuntimeLeaseRow[];
    const invalidLeaseKind = leaseUsage.some(
      (row) => !HOST_GLOBAL_LEASE_RESOURCE_KINDS.has(row.resource_type)
    );
    if (invalidLeaseKind) {
      throw new Error("Fleet runtime lease contains a non-host resource kind");
    }
    const bucketUsage = db
      .prepare(
        `SELECT resource_type, resource_key, units
         FROM fleet_resource_usage_buckets
         WHERE fleet_run_id = ? AND bucket_start_ms IN (0, ?)`
      )
      .all(input.runId, bucketStartMs) as UsageBucketRow[];
    // A run's configured limits constrain only that run. Host/repository
    // capacities are authoritative process-wide defaults and cannot change
    // depending on which run happens to ask next. Evaluate both scopes so a
    // low run cap does not throttle its neighbours, while a high run cap cannot
    // overcommit the host.
    const runDecision = evaluateFleetResourceAdmission({
      limits: input.limits,
      usage: [
        ...leaseUsage.filter((row) => row.fleet_run_id === input.runId),
        ...bucketUsage,
      ].map((row) => ({
        kind: row.resource_type,
        key: row.resource_key,
        units: row.units,
      })),
      requested: requestedResources,
    });
    const requestedHostResources = requestedResources.filter((resource) =>
      HOST_GLOBAL_LEASE_RESOURCE_KINDS.has(resource.kind)
    );
    const hostDecision = evaluateFleetResourceAdmission({
      limits: FLEET_DEFAULT_RESOURCE_LIMITS,
      usage: leaseUsage.map((row) => ({
        kind: row.resource_type,
        key: row.resource_key,
        units: row.units,
      })),
      requested: requestedHostResources,
    });
    // The repository ceiling includes short-lived planner/reviewer/integration
    // worktrees, so it is intentionally larger than the planner's 40-task cap.
    // Keep a second, owner-scoped guard for preserved worker worktrees: otherwise
    // retries or malformed imported plans could consume the transient headroom
    // and make the lifetime ceiling silently wider than the task contract.
    const retainedWorkerDecision =
      input.ownerType === "worker"
        ? evaluateFleetResourceAdmission({
            limits: {
              ...input.limits,
              worktreesPerRepo: Math.min(
                input.limits.worktreesPerRepo,
                FLEET_MAX_TOTAL_WORKERS
              ),
            },
            usage: leaseUsage
              .filter(
                (row) =>
                  row.fleet_run_id === input.runId &&
                  row.owner_type === "worker" &&
                  row.resource_type === "repo_worktree"
              )
              .map((row) => ({
                kind: row.resource_type,
                key: row.resource_key,
                units: row.units,
              })),
            requested: requestedResources.filter(
              (resource) => resource.kind === "repo_worktree"
            ),
          })
        : { admitted: true, blocked: [] };
    if (!runDecision.admitted) {
      return { admitted: false, blocked: runDecision.blocked, retryAt: null };
    }
    if (!hostDecision.admitted) {
      return { admitted: false, blocked: hostDecision.blocked, retryAt: null };
    }
    if (!retainedWorkerDecision.admitted) {
      return {
        admitted: false,
        blocked: retainedWorkerDecision.blocked,
        retryAt: null,
      };
    }

    const leaseIds: string[] = [];
    const insertLease = db.prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key,
        units, status, lease_expires_at, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, '{}', ?)`
    );
    const upsertBucket = db.prepare(
      `INSERT INTO fleet_resource_usage_buckets
       (fleet_run_id, resource_type, resource_key, bucket_start_ms, units, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(fleet_run_id, resource_type, resource_key, bucket_start_ms)
       DO UPDATE SET units = units + excluded.units, updated_at = excluded.updated_at`
    );
    for (const resource of requestedResources) {
      const key = canonicalFleetResourceKey(resource);
      if (isPerRunUsageResource(resource.kind)) {
        upsertBucket.run(
          input.runId,
          resource.kind,
          key,
          usageBucketStart(resource.kind, bucketStartMs),
          resource.units,
          nowIso
        );
      } else {
        if (!HOST_GLOBAL_LEASE_RESOURCE_KINDS.has(resource.kind)) {
          throw new Error("Fleet runtime resource kind has no declared scope");
        }
        const id = randomUUID();
        insertLease.run(
          id,
          input.runId,
          input.ownerType,
          input.ownerId,
          resource.kind,
          key,
          resource.units,
          input.leaseExpiresAt ?? null,
          nowIso
        );
        leaseIds.push(id);
      }
    }
    return { admitted: true, leaseIds, bucketStartMs };
  });
}

export function releaseFleetRuntimeResources(
  db: Database.Database,
  input: {
    ownerType: string;
    ownerId: string;
    now: Date;
    resourceTypes?: readonly FleetResourceKind[];
    preserveResourceTypes?: readonly FleetResourceKind[];
  }
): number {
  const selected = input.resourceTypes ?? [];
  const preserved = input.preserveResourceTypes ?? [];
  const clauses = ["owner_type = ?", "owner_id = ?", "status = 'reserved'"];
  const params: unknown[] = [input.ownerType, input.ownerId];
  if (selected.length > 0) {
    clauses.push(`resource_type IN (${selected.map(() => "?").join(",")})`);
    params.push(...selected);
  }
  if (preserved.length > 0) {
    clauses.push(
      `resource_type NOT IN (${preserved.map(() => "?").join(",")})`
    );
    params.push(...preserved);
  }
  return db
    .prepare(
      `UPDATE fleet_runtime_leases SET status = 'released', released_at = ?
       WHERE ${clauses.join(" AND ")}`
    )
    .run(input.now.toISOString(), ...params).changes;
}

export function recordFleetProviderCooldown(
  db: Database.Database,
  input: { provider: string; reason: string; now: Date }
): string {
  const provider = input.provider.trim().toLowerCase();
  const current = db
    .prepare(
      `SELECT failure_count FROM fleet_provider_cooldowns WHERE provider = ?`
    )
    .get(provider) as { failure_count: number } | undefined;
  const failureCount = (current?.failure_count ?? 0) + 1;
  const blockedUntil = fleetProviderRetryNotBefore(input.now, failureCount);
  db.prepare(
    `INSERT INTO fleet_provider_cooldowns
     (provider, blocked_until, failure_count, reason, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET blocked_until = excluded.blocked_until,
       failure_count = excluded.failure_count, reason = excluded.reason,
       updated_at = excluded.updated_at`
  ).run(
    provider,
    blockedUntil,
    failureCount,
    redactAndCapFleetText(input.reason, 240).text,
    input.now.toISOString()
  );
  return blockedUntil;
}

export function clearFleetProviderCooldown(
  db: Database.Database,
  provider: string
): void {
  db.prepare(`DELETE FROM fleet_provider_cooldowns WHERE provider = ?`).run(
    provider.trim().toLowerCase()
  );
}

export function looksLikeProviderRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:rate[ _-]?limit|too many requests|\b429\b|quota exceeded)/i.test(
    message
  );
}
