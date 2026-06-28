/**
 * Cross-loop guards for the server.ts status tick.
 *
 * The status tick runs several per-session loops over ONE status snapshot —
 * prompt-queue dispatch (#5/#96), rate-limit auto-resume (#10), and channel PUSH
 * delivery (#6). Each was built in isolation, so their COMPOSITION needs an
 * explicit mutual-exclusion contract: a session that is rate-limited, or already
 * being written to this tick, must not be pasted into by a second loop. These pure
 * predicates encode that contract in one place (unit-tested) so the tick can't
 * regress into double-writes — the gap the cross-advancement review surfaced (a
 * rate-limited session reads as "idle", so the queue loop would paste a queued
 * prompt into the limited TUI before its reset, defeating the resume loop's gating).
 */

/**
 * Should the prompt-queue dispatch loop SKIP this session?
 * - rateLimited → the rate-limit resume loop owns delivery (it pastes the queued
 *   prompt at resetAt, or waits for the limit to clear); pasting here would defeat
 *   that gating and lose the prompt into a limited TUI.
 * - channelInFlight → a channel push is mid-paste into this terminal; a second
 *   paste off the same idle snapshot would interleave.
 * Pure.
 */
export function queueDispatchBlocked(input: {
  rateLimited: boolean;
  channelInFlight: boolean;
}): boolean {
  return input.rateLimited || input.channelInFlight;
}

/**
 * Should the channel PUSH-delivery loop SKIP this session?
 * - rateLimited → don't inject a directive into a limited TUI (it would burn the
 *   unread mid-limit); the resume loop owns a rate-limited session.
 * - rateLimitResumed → the resume loop already nudged this session THIS tick (set
 *   synchronously before this loop runs); a channel paste would interleave with the
 *   resume Enter.
 * - queueDispatched → the queue loop already pasted this idle period.
 * - channelInFlight → a delivery into this session is already in flight.
 * Pure.
 */
export function channelDeliveryBlocked(input: {
  rateLimited: boolean;
  rateLimitResumed: boolean;
  queueDispatched: boolean;
  channelInFlight: boolean;
}): boolean {
  return (
    input.rateLimited ||
    input.rateLimitResumed ||
    input.queueDispatched ||
    input.channelInFlight
  );
}
