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
  | "event_fanout_per_minute";

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
  eventFanoutPerMinute: number;
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
    gitOperation: 2,
    mergeOperation: 1,
    worktreesPerRepo: 12,
    diskBytes: 10 * 1024 ** 3,
    outputBytesPerMinute: 64 * 1024 ** 2,
    artifactBytesPerMinute: 16 * 1024 ** 2,
    eventFanoutPerMinute: 2_000,
    providerCaps: Object.freeze({}),
  }
);

const MAXIMA: Omit<FleetResourceLimits, "providerCaps"> = {
  pty: FLEET_MAX_TOTAL_WORKERS,
  transportHost: FLEET_MAX_TOTAL_WORKERS,
  verifier: 16,
  gitOperation: 16,
  mergeOperation: 4,
  worktreesPerRepo: FLEET_MAX_TOTAL_WORKERS,
  diskBytes: 1024 ** 4,
  outputBytesPerMinute: 1024 ** 3,
  artifactBytesPerMinute: 1024 ** 3,
  eventFanoutPerMinute: 100_000,
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
    eventFanoutPerMinute: boundedInteger(
      input?.eventFanoutPerMinute,
      defaults.eventFanoutPerMinute,
      MAXIMA.eventFanoutPerMinute
    ),
    providerCaps: providerCaps(input?.providerCaps),
  };
}

function resourceId(resource: FleetResourceUnits): string {
  return `${resource.kind}\0${resource.key}`;
}

function aggregate(
  resources: readonly FleetResourceUnits[]
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const resource of resources) {
    if (!Number.isFinite(resource.units) || resource.units <= 0) continue;
    const key = resourceId(resource);
    totals.set(key, (totals.get(key) ?? 0) + resource.units);
  }
  return totals;
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
    case "event_fanout_per_minute":
      return limits.eventFanoutPerMinute;
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
  const used = aggregate(input.usage);
  const requested = aggregate(input.requested);
  const blocked: FleetResourceBlock[] = [];
  for (const [id, requestedUnits] of requested) {
    const request = input.requested.find(
      (candidate) => resourceId(candidate) === id
    );
    if (!request) continue;
    const usedUnits = used.get(id) ?? 0;
    const capacity = fleetResourceCapacity(request, input.limits);
    if (usedUnits + requestedUnits > capacity) {
      blocked.push({
        kind: request.kind,
        key: request.key,
        capacity,
        used: usedUnits,
        requested: requestedUnits,
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
