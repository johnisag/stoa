/**
 * Status transition debouncing — inspired by Herdr's PendingIdleConfirmation.
 *
 * A working-to-idle transition is noisy: a spinner redraw can momentarily
 * make the screen look idle between frames, and Claude's "tokens" line
 * disappears for a frame before the "esc to interrupt" cue reappears. Without
 * debouncing, the Fleet Board and notification system flicker between running
 * and idle, creating false "done" notifications.
 *
 * Herdr's solution: require N consecutive idle readings (100ms apart) before
 * publishing a working→idle transition. We do the same, with these constants:
 *
 *   PENDING_IDLE_CONFIRMATIONS = 3  (consecutive idle readings required)
 *   PENDING_IDLE_INTERVAL_MS  = 100 (minimum time between confirmations)
 *   PENDING_IDLE_CAP_MS       = 700 (max time to wait before giving up and
 *                                    publishing idle anyway — prevents a
 *                                    stuck "running" if the poll interval
 *                                    is longer than 3×100ms)
 *   STARTUP_GRACE_MS          = 3000 (don't classify during agent boot)
 */

import type { SessionStatus } from "../status-detector";

/** Configuration constants for the debounce logic. */
export const DEBOUNCE_CONFIG = {
  PENDING_IDLE_CONFIRMATIONS: 3,
  PENDING_IDLE_INTERVAL_MS: 100,
  // The cap must be LONGER than 3× the status poll interval (2.5s), otherwise
  // the cap always fires before 3 confirmations can be collected and the
  // debounce never actually holds. 10s gives comfortable room for 3 polls.
  PENDING_IDLE_CAP_MS: 10_000,
  STARTUP_GRACE_MS: 3000,
} as const;

/**
 * Per-session debounce state. Tracks whether we're in the middle of confirming
 * a working→idle transition, and when the session was first seen (for the
 * startup grace window).
 */
export interface DebounceState {
  /** When the pending-idle confirmation sequence started, or null if inactive. */
  pendingIdleStartedAt: number | null;
  /** How many consecutive idle readings we've seen. */
  pendingIdleConfirmations: number;
  /** When this session was first observed (for the startup grace window). */
  firstSeenAt: number;
}

/**
 * Create a fresh debounce state for a newly-seen session.
 */
export function createDebounceState(now: number = Date.now()): DebounceState {
  return {
    pendingIdleStartedAt: null,
    pendingIdleConfirmations: 0,
    firstSeenAt: now,
  };
}

/**
 * Decide whether a working→idle transition should be held (debounced) or
 * published. Mirrors Herdr's shouldHoldWorkingToIdle logic.
 *
 * Returns true if the transition should be HELD (stay "running"), false if
 * it should be published (allow the idle status).
 *
 * This is a PURE function — it doesn't mutate the state; the caller updates
 * `state` based on the outcome. This makes it trivially unit-testable.
 */
export function shouldHoldWorkingToIdle(
  state: DebounceState,
  previousStatus: SessionStatus,
  nextStatus: SessionStatus,
  agentChanged: boolean,
  processExited: boolean,
  now: number
): boolean {
  // Only debounce a plain working→idle transition. Not idle→idle, not
  // working→waiting, not working→error. And NOT if the agent just changed
  // or the process exited (those are definitive, not noisy).
  const isWorkingToPlainIdle =
    previousStatus === "running" &&
    nextStatus === "idle" &&
    !agentChanged &&
    !processExited;

  if (!isWorkingToPlainIdle) {
    // Reset — this isn't a debounce-able transition.
    state.pendingIdleStartedAt = null;
    state.pendingIdleConfirmations = 0;
    return false;
  }

  // First time we see idle after running — start the confirmation window.
  if (state.pendingIdleStartedAt === null) {
    state.pendingIdleStartedAt = now;
    state.pendingIdleConfirmations = 1;
    return true; // hold — not confirmed yet
  }

  // We're in the confirmation window. Check if we've waited long enough
  // since the last confirmation (at least PENDING_IDLE_INTERVAL_MS).
  const elapsed = now - state.pendingIdleStartedAt;

  // Cap: if we've been confirming for too long, publish anyway. This
  // prevents a stuck "running" if the poll interval is long and we never
  // get 3 readings within the confirmation window.
  if (elapsed >= DEBOUNCE_CONFIG.PENDING_IDLE_CAP_MS) {
    state.pendingIdleStartedAt = null;
    state.pendingIdleConfirmations = 0;
    return false; // publish — cap exceeded
  }

  // Another consecutive idle reading.
  state.pendingIdleConfirmations++;

  if (
    state.pendingIdleConfirmations >= DEBOUNCE_CONFIG.PENDING_IDLE_CONFIRMATIONS
  ) {
    // Enough confirmations — publish the idle transition.
    state.pendingIdleStartedAt = null;
    state.pendingIdleConfirmations = 0;
    return false;
  }

  // Not enough confirmations yet — hold.
  return true;
}

/**
 * Whether a session is within its startup grace window. During this window
 * the detector returns a neutral "running" status regardless of what the
 * screen shows, because agent startup output (banners, loading screens) can
 * false-positive on every pattern.
 */
export function isInStartupGrace(state: DebounceState, now: number): boolean {
  return now - state.firstSeenAt < DEBOUNCE_CONFIG.STARTUP_GRACE_MS;
}
