import type Database from "better-sqlite3";

const fleetGlobal = globalThis as typeof globalThis & {
  __stoaFleetSchedulerReady?: boolean;
};

if (fleetGlobal.__stoaFleetSchedulerReady == null) {
  fleetGlobal.__stoaFleetSchedulerReady = false;
}

export const FLEET_RECOVERY_UNAVAILABLE =
  "fleet scheduler recovery is not ready";

export class FleetRecoveryUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super(FLEET_RECOVERY_UNAVAILABLE);
    this.name = "FleetRecoveryUnavailableError";
  }
}

export function isFleetSchedulerReady(): boolean {
  return fleetGlobal.__stoaFleetSchedulerReady === true;
}

export function setFleetSchedulerReady(ready: boolean): void {
  fleetGlobal.__stoaFleetSchedulerReady = ready;
}

export function fleetRecoveryUnavailable(
  db: Database.Database,
  runId?: string
): boolean {
  if (!isFleetSchedulerReady()) return true;
  if (!runId) return false;
  const row = db
    .prepare(`SELECT recovery_required FROM fleet_runs WHERE id = ?`)
    .get(runId) as { recovery_required: number } | undefined;
  return row?.recovery_required === 1;
}

export function assertFleetLaunchReady(
  db: Database.Database,
  runId?: string
): void {
  if (fleetRecoveryUnavailable(db, runId)) {
    throw new FleetRecoveryUnavailableError();
  }
}

export function fleetLaunchBlockedResult(
  db: Database.Database,
  runId?: string
): { error: string; status: 503 } | null {
  return fleetRecoveryUnavailable(db, runId)
    ? { error: FLEET_RECOVERY_UNAVAILABLE, status: 503 }
    : null;
}
