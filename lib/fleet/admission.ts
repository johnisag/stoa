export const FLEET_MAX_TOTAL_WORKERS = 40;
export const FLEET_DEFAULT_PARALLEL_WORKERS = 6;
export const FLEET_WORKER_RESERVATION_USD = 0.25;

export function providerConcurrencyCap(provider: string): number {
  if (provider === "claude") return 4;
  if (provider === "codex") return 6;
  return 2;
}

export function availableFleetSlots(input: {
  requestedConcurrency: number;
  runActiveWorkers: number;
  localActiveWorkers: number;
  providerActiveWorkers: number;
  totalWorkers: number;
  provider: string;
}): number {
  return Math.max(
    0,
    Math.min(
      Math.max(1, input.requestedConcurrency) - input.runActiveWorkers,
      FLEET_DEFAULT_PARALLEL_WORKERS - input.localActiveWorkers,
      providerConcurrencyCap(input.provider) - input.providerActiveWorkers,
      FLEET_MAX_TOTAL_WORKERS - input.totalWorkers
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
