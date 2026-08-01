export const FLEET_PROVIDER_BACKOFF_BASE_MS = 5_000;
export const FLEET_PROVIDER_BACKOFF_MAX_MS = 5 * 60_000;

/** Deterministic, restart-safe provider retry delay for a 1-based failure. */
export function fleetProviderBackoffMs(failureCount: number): number {
  const count = Number.isSafeInteger(failureCount)
    ? Math.max(1, failureCount)
    : 1;
  return Math.min(
    FLEET_PROVIDER_BACKOFF_BASE_MS * 2 ** Math.min(count - 1, 16),
    FLEET_PROVIDER_BACKOFF_MAX_MS
  );
}

export function fleetProviderRetryNotBefore(
  now: Date,
  failureCount: number
): string {
  return new Date(
    now.getTime() + fleetProviderBackoffMs(failureCount)
  ).toISOString();
}

export function fleetProviderRetryIsDue(
  retryNotBefore: string | null | undefined,
  now: Date
): boolean {
  if (!retryNotBefore) return true;
  const timestamp = Date.parse(retryNotBefore);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}
