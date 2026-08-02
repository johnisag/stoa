import { claimsConflict, normalizeClaim } from "@/lib/dispatch/claims";

export const UNKNOWN_FLEET_CLAIM = "*";

export interface FleetPathComparisonOptions {
  /** Git's repository-local `core.ignorecase` path semantics. */
  caseInsensitive?: boolean;
}

/** Build a comparison-only key while preserving the original path for display. */
export function fleetPathComparisonKey(
  value: string,
  options: FleetPathComparisonOptions = {}
): string {
  return options.caseInsensitive ? value.toLowerCase() : value;
}

export function normalizeFleetClaims(values: string[]): string[] {
  const claims = values
    .map(normalizeClaim)
    .filter((value): value is string => value !== null);
  return [...new Set(claims)];
}

/** Empty/invalid write claims fail closed and serialize with every writer. */
export function fleetClaimsConflict(
  a: string[],
  b: string[],
  options: FleetPathComparisonOptions = {}
): boolean {
  if (a.includes(UNKNOWN_FLEET_CLAIM) || b.includes(UNKNOWN_FLEET_CLAIM)) {
    return true;
  }
  return claimsConflict(
    a.map((claim) => fleetPathComparisonKey(claim, options)),
    b.map((claim) => fleetPathComparisonKey(claim, options))
  );
}
