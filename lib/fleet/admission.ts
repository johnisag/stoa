export const FLEET_MAX_TOTAL_WORKERS = 40;
export const FLEET_DEFAULT_PARALLEL_WORKERS = 6;
export const FLEET_PARALLEL_WORKERS_WARNING_THRESHOLD = 12;
export const FLEET_WORKER_RESERVATION_USD = 0.25;

export function providerConcurrencyCap(
  provider: string,
  configured: Readonly<Record<string, number>> = {}
): number {
  const normalized = provider.trim().toLowerCase();
  const override = configured[normalized];
  if (Number.isSafeInteger(override) && override > 0) {
    return Math.min(override, FLEET_MAX_TOTAL_WORKERS);
  }
  if (normalized === "claude") return 4;
  if (normalized === "codex") return 6;
  return 2;
}

export function availableFleetSlots(input: {
  requestedConcurrency: number;
  runActiveWorkers: number;
  localActiveWorkers: number;
  providerActiveWorkers: number;
  totalWorkers: number;
  provider: string;
  providerCaps?: Readonly<Record<string, number>>;
  localCapacity?: number;
  totalCapacity?: number;
}): number {
  return Math.max(
    0,
    Math.min(
      Math.max(1, input.requestedConcurrency) - input.runActiveWorkers,
      (input.localCapacity ?? FLEET_DEFAULT_PARALLEL_WORKERS) -
        input.localActiveWorkers,
      providerConcurrencyCap(input.provider, input.providerCaps) -
        input.providerActiveWorkers,
      (input.totalCapacity ?? FLEET_MAX_TOTAL_WORKERS) - input.totalWorkers
    )
  );
}

export function canReserveFleetBudget(input: {
  budgetUsd: number | null;
  reservedBudgetUsd: number;
  spentBudgetUsd?: number;
  reservationUsd?: number;
}): boolean {
  if (input.budgetUsd == null) return true;
  return (
    (input.spentBudgetUsd ?? 0) +
      input.reservedBudgetUsd +
      (input.reservationUsd ?? FLEET_WORKER_RESERVATION_USD) <=
    input.budgetUsd
  );
}
