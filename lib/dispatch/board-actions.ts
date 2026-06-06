import type { DispatchStatus } from "./types";

/** Actions the cockpit can take on a dispatch row. */
export type BoardAction = "approve" | "cancel" | "dismiss" | "retry";

/**
 * Which board actions are valid for a dispatch in a given status. Pure.
 *   approve  → spawn now (pending only)
 *   cancel   → drop a not-yet-running candidate (pending or scheduled)
 *   dismiss  → hide a failed row (→ cancelled; stays parked)
 *   retry    → re-run a failed row (reset → dispatch fresh)
 */
export function isActionAllowed(
  action: BoardAction,
  status: DispatchStatus
): boolean {
  switch (action) {
    case "approve":
      return status === "pending";
    case "cancel":
      return status === "pending" || status === "scheduled";
    case "dismiss":
    case "retry":
      return status === "failed";
    default:
      return false;
  }
}
