import {
  FLEET_DEFAULT_PARALLEL_WORKERS,
  FLEET_MAX_TOTAL_WORKERS,
  providerConcurrencyCap,
} from "./admission";

export type FleetResourceKind =
  | "pty"
  | "transport_host"
  | "provider"
  | "verifier"
  | "git_operation"
  | "merge_operation"
  | "repo_worktree"
  | "disk_bytes"
  | "output_bytes_per_minute"
  | "artifact_bytes_per_minute"
  | "artifact_bytes_total"
  | "event_bytes_per_minute"
  | "event_fanout_per_minute"
  | "event_bytes_total";

export interface FleetResourceLimits {
  pty: number;
  transportHost: number;
  verifier: number;
  gitOperation: number;
  mergeOperation: number;
  worktreesPerRepo: number;
  diskBytes: number;
  outputBytesPerMinute: number;
  artifactBytesPerMinute: number;
  artifactBytesTotal: number;
  eventBytesPerMinute: number;
  eventFanoutPerMinute: number;
  eventBytesTotal: number;
  providerCaps: Readonly<Record<string, number>>;
}

export interface FleetResourceUnits {
  kind: FleetResourceKind;
  key: string;
  units: number;
}

export interface FleetResourceBlock {
  kind: FleetResourceKind;
  key: string;
  capacity: number;
  used: number;
  requested: number;
  reason: "capacity" | "invalid-request" | "invalid-usage";
}

export interface FleetResourceAdmissionDecision {
  admitted: boolean;
  blocked: FleetResourceBlock[];
}

export const FLEET_DEFAULT_RESOURCE_LIMITS: FleetResourceLimits = Object.freeze(
  {
    pty: FLEET_DEFAULT_PARALLEL_WORKERS,
    transportHost: FLEET_DEFAULT_PARALLEL_WORKERS,
    verifier: 2,
    gitOperation: FLEET_DEFAULT_PARALLEL_WORKERS,
    mergeOperation: 1,
    // A 40-task plan preserves its task worktrees until explicit archived-run
    // cleanup. Leave room for the default six paid review sessions plus the
    // integration worktree without turning this lifetime ceiling into the
    // much smaller active-session concurrency limit.
    worktreesPerRepo: 48,
    diskBytes: 32 * 1024 ** 3,
    outputBytesPerMinute: 64 * 1024 ** 2,
    artifactBytesPerMinute: 16 * 1024 ** 2,
    artifactBytesTotal: 512 * 1024 ** 2,
    eventBytesPerMinute: 16 * 1024 ** 2,
    eventFanoutPerMinute: 2_000,
    eventBytesTotal: 256 * 1024 ** 2,
    providerCaps: Object.freeze({}),
  }
);

const MAXIMA: Omit<FleetResourceLimits, "providerCaps"> = {
  pty: FLEET_MAX_TOTAL_WORKERS,
  transportHost: FLEET_MAX_TOTAL_WORKERS,
  verifier: 16,
  gitOperation: 16,
  mergeOperation: 4,
  worktreesPerRepo: 64,
  diskBytes: 1024 ** 4,
  outputBytesPerMinute: 1024 ** 3,
  artifactBytesPerMinute: 1024 ** 3,
  artifactBytesTotal: 16 * 1024 ** 3,
  eventBytesPerMinute: 1024 ** 3,
  eventFanoutPerMinute: 100_000,
  eventBytesTotal: 16 * 1024 ** 3,
};

function boundedInteger(
  value: unknown,
  fallback: number,
  maximum: number
): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function providerCaps(value: unknown): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [rawProvider, rawLimit] of Object.entries(value).slice(0, 32)) {
    const provider = rawProvider.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(provider)) continue;
    if (
      typeof rawLimit !== "number" ||
      !Number.isSafeInteger(rawLimit) ||
      rawLimit < 1
    )
      continue;
    result[provider] = Math.min(rawLimit, FLEET_MAX_TOTAL_WORKERS);
  }
  return Object.freeze(result);
}

/** Parse untrusted run configuration into safe, explicitly bounded capacities. */
export function normalizeFleetResourceLimits(
  input: Partial<FleetResourceLimits> | null | undefined
): FleetResourceLimits {
  const defaults = FLEET_DEFAULT_RESOURCE_LIMITS;
  return {
    pty: boundedInteger(input?.pty, defaults.pty, MAXIMA.pty),
    transportHost: boundedInteger(
      input?.transportHost,
      defaults.transportHost,
      MAXIMA.transportHost
    ),
    verifier: boundedInteger(
      input?.verifier,
      defaults.verifier,
      MAXIMA.verifier
    ),
    gitOperation: boundedInteger(
      input?.gitOperation,
      defaults.gitOperation,
      MAXIMA.gitOperation
    ),
    mergeOperation: boundedInteger(
      input?.mergeOperation,
      defaults.mergeOperation,
      MAXIMA.mergeOperation
    ),
    worktreesPerRepo: boundedInteger(
      input?.worktreesPerRepo,
      defaults.worktreesPerRepo,
      MAXIMA.worktreesPerRepo
    ),
    diskBytes: boundedInteger(
      input?.diskBytes,
      defaults.diskBytes,
      MAXIMA.diskBytes
    ),
    outputBytesPerMinute: boundedInteger(
      input?.outputBytesPerMinute,
      defaults.outputBytesPerMinute,
      MAXIMA.outputBytesPerMinute
    ),
    artifactBytesPerMinute: boundedInteger(
      input?.artifactBytesPerMinute,
      defaults.artifactBytesPerMinute,
      MAXIMA.artifactBytesPerMinute
    ),
    artifactBytesTotal: boundedInteger(
      input?.artifactBytesTotal,
      defaults.artifactBytesTotal,
      MAXIMA.artifactBytesTotal
    ),
    eventBytesPerMinute: boundedInteger(
      input?.eventBytesPerMinute,
      defaults.eventBytesPerMinute,
      MAXIMA.eventBytesPerMinute
    ),
    eventFanoutPerMinute: boundedInteger(
      input?.eventFanoutPerMinute,
      defaults.eventFanoutPerMinute,
      MAXIMA.eventFanoutPerMinute
    ),
    eventBytesTotal: boundedInteger(
      input?.eventBytesTotal,
      defaults.eventBytesTotal,
      MAXIMA.eventBytesTotal
    ),
    providerCaps: providerCaps(input?.providerCaps),
  };
}

export function canonicalFleetResourceKey(
  resource: FleetResourceUnits
): string {
  const key = resource.key.trim();
  return resource.kind === "provider" ? key.toLowerCase() : key;
}

function resourceId(resource: FleetResourceUnits): string {
  return `${resource.kind}\0${canonicalFleetResourceKey(resource)}`;
}

function validUnits(units: number): boolean {
  return Number.isSafeInteger(units) && units > 0;
}

function aggregate(resources: readonly FleetResourceUnits[]): {
  totals: Map<string, number>;
  invalid: FleetResourceUnits[];
} {
  const totals = new Map<string, number>();
  const invalid: FleetResourceUnits[] = [];
  for (const resource of resources) {
    if (!canonicalFleetResourceKey(resource) || !validUnits(resource.units)) {
      invalid.push(resource);
      continue;
    }
    const key = resourceId(resource);
    const total = (totals.get(key) ?? 0) + resource.units;
    if (!Number.isSafeInteger(total)) {
      totals.delete(key);
      invalid.push({ ...resource, units: total });
      continue;
    }
    totals.set(key, total);
  }
  return { totals, invalid };
}

export function fleetResourceCapacity(
  resource: Pick<FleetResourceUnits, "kind" | "key">,
  limits: FleetResourceLimits
): number {
  switch (resource.kind) {
    case "pty":
      return limits.pty;
    case "transport_host":
      return limits.transportHost;
    case "provider":
      return (
        limits.providerCaps[resource.key.trim().toLowerCase()] ??
        providerConcurrencyCap(resource.key)
      );
    case "verifier":
      return limits.verifier;
    case "git_operation":
      return limits.gitOperation;
    case "merge_operation":
      return limits.mergeOperation;
    case "repo_worktree":
      return limits.worktreesPerRepo;
    case "disk_bytes":
      return limits.diskBytes;
    case "output_bytes_per_minute":
      return limits.outputBytesPerMinute;
    case "artifact_bytes_per_minute":
      return limits.artifactBytesPerMinute;
    case "artifact_bytes_total":
      return limits.artifactBytesTotal;
    case "event_bytes_per_minute":
      return limits.eventBytesPerMinute;
    case "event_fanout_per_minute":
      return limits.eventFanoutPerMinute;
    case "event_bytes_total":
      return limits.eventBytesTotal;
  }
}

/**
 * Evaluate one atomic reservation set against current durable lease/window use.
 * Duplicate rows are aggregated, preventing callers from bypassing a capacity by
 * splitting one request across multiple lease records.
 */
export function evaluateFleetResourceAdmission(input: {
  limits: FleetResourceLimits;
  usage: readonly FleetResourceUnits[];
  requested: readonly FleetResourceUnits[];
}): FleetResourceAdmissionDecision {
  const usage = aggregate(input.usage);
  const requests = aggregate(input.requested);
  const blocked: FleetResourceBlock[] = [];
  for (const invalid of usage.invalid) {
    blocked.push({
      kind: invalid.kind,
      key: canonicalFleetResourceKey(invalid),
      capacity: 0,
      used: invalid.units,
      requested: 0,
      reason: "invalid-usage",
    });
  }
  for (const invalid of requests.invalid) {
    blocked.push({
      kind: invalid.kind,
      key: canonicalFleetResourceKey(invalid),
      capacity: 0,
      used: 0,
      requested: invalid.units,
      reason: "invalid-request",
    });
  }
  for (const [id, requestedUnits] of requests.totals) {
    const request = input.requested.find(
      (candidate) => resourceId(candidate) === id
    );
    if (!request) continue;
    const usedUnits = usage.totals.get(id) ?? 0;
    const capacity = fleetResourceCapacity(request, input.limits);
    if (usedUnits + requestedUnits > capacity) {
      blocked.push({
        kind: request.kind,
        key: canonicalFleetResourceKey(request),
        capacity,
        used: usedUnits,
        requested: requestedUnits,
        reason: "capacity",
      });
    }
  }
  blocked.sort((a, b) =>
    a.kind === b.kind
      ? a.key.localeCompare(b.key)
      : a.kind.localeCompare(b.kind)
  );
  return { admitted: blocked.length === 0, blocked };
}

/** Deterministically admit a bounded wave while updating in-memory lease use. */
export function admitFleetResourceWave<T>(input: {
  limits: FleetResourceLimits;
  usage: readonly FleetResourceUnits[];
  candidates: readonly T[];
  resources: (candidate: T) => readonly FleetResourceUnits[];
}): T[] {
  const usage = [...input.usage];
  const admitted: T[] = [];
  for (const candidate of input.candidates.slice(0, FLEET_MAX_TOTAL_WORKERS)) {
    const requested = input.resources(candidate);
    if (
      !evaluateFleetResourceAdmission({
        limits: input.limits,
        usage,
        requested,
      }).admitted
    )
      continue;
    admitted.push(candidate);
    usage.push(...requested);
  }
  return admitted;
}
