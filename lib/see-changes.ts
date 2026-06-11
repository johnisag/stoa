/**
 * "See changes" jump-to-diff gate — pure and deterministic so the
 * once-per-transition logic is unit-testable and shared by the notifications
 * hook. When a session finishes a turn (running/waiting -> idle) we offer a
 * one-tap affordance to open the diff of what just changed, instead of making
 * the user hunt for what the agent touched.
 *
 * Client-safe: no node builtins, only a status type. The actual diff surface
 * (SessionDiffModal) is opened by the caller via the offered session id.
 */

export type SeeChangesStatus =
  | "idle"
  | "running"
  | "waiting"
  | "error"
  | "dead";

/**
 * True only on the "turn just completed" transition: an active turn
 * (running or waiting) settling to idle. This is the same signal the
 * completed notification fires on, narrowed to the unambiguous idle landing so
 * we don't offer a diff mid-flight or on error/dead.
 */
export function shouldOfferSeeChanges(
  prevStatus: SeeChangesStatus | undefined,
  nextStatus: SeeChangesStatus
): boolean {
  if (nextStatus !== "idle") return false;
  return prevStatus === "running" || prevStatus === "waiting";
}
