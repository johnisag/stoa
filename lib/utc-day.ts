/**
 * UTC calendar day ("YYYY-MM-DD") for an epoch-ms instant. UTC (not local) so it's
 * deterministic and locale/TZ-independent across the CI matrix and across server
 * restarts. A neutral leaf helper shared by the analytics report (per-day buckets)
 * and the rate-limit per-day resume budget so the two can't drift. Pure.
 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
