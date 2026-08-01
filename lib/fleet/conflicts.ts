import { claimsConflict, normalizeClaim } from "@/lib/dispatch/claims";

export const UNKNOWN_FLEET_CLAIM = "*";

export function normalizeFleetClaims(values: string[]): string[] {
  const claims = values
    .map(normalizeClaim)
    .filter((value): value is string => value !== null);
  return [...new Set(claims)];
}

/** Empty/invalid write claims fail closed and serialize with every writer. */
export function fleetClaimsConflict(a: string[], b: string[]): boolean {
  if (a.includes(UNKNOWN_FLEET_CLAIM) || b.includes(UNKNOWN_FLEET_CLAIM)) {
    return true;
  }
  return claimsConflict(a, b);
}
