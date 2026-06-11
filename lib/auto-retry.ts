/**
 * Auto-retry an interactive agent on a TRANSIENT failure (a provider rate/usage
 * limit or a network hiccup) — surface a "retrying in Ns" affordance and relaunch
 * with exponential backoff, instead of leaving the session dead until the user
 * notices.
 *
 * This module is the PURE core (no I/O, browser-safe — it imports only the equally
 * pure rate-limit detector, never a server-only module): classify the final
 * rendered screen as transient-vs-not, and compute the backoff schedule + the
 * keep-retrying cap. The Terminal hook owns the side effects (the countdown timer +
 * firing the existing relaunch). Everything here is unit-tested.
 *
 * Conservative by construction — a runaway loop is the failure mode to avoid:
 *  - CAPPED attempts (AUTO_RETRY_MAX_ATTEMPTS), then we STOP and surface to the user.
 *  - EXPONENTIAL backoff with a ceiling, so each retry waits longer (never a tight loop).
 *  - TRANSIENT-only: a real (non-transient) failure is NOT auto-retried — it still
 *    surfaces the plain Relaunch affordance so the human sees it.
 *  - The detector fails CLOSED: when unsure it returns false (no auto-retry), and the
 *    user can always cancel a pending retry. A false positive at worst relaunches a
 *    session the user could have relaunched by hand; a false negative just falls back
 *    to the manual button.
 */

import { detectRateLimit } from "./rate-limit";

/** Max auto-retry attempts before we stop and surface to the user. */
export const AUTO_RETRY_MAX_ATTEMPTS = 4;
/** First backoff delay (ms) — attempt 1 waits this long. */
export const AUTO_RETRY_BASE_DELAY_MS = 5_000;
/** Backoff ceiling (ms) — exponential growth is clamped here so the wait stays bounded. */
export const AUTO_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Transient NETWORK / connectivity phrasings — the failures worth auto-retrying
 * that the rate-limit detector doesn't cover. Deliberately NARROW and anchored to
 * connection/transport wording (or an explicit error envelope) so an agent merely
 * printing about networking in your code never false-positives — the same discipline
 * as rate-limit.ts's LIMIT_PATTERNS. A bare "timeout" or "connection" is NOT enough.
 */
const TRANSIENT_NETWORK_PATTERNS: RegExp[] = [
  // Node/undici socket-level errors (the exact codes a dropped connection throws).
  /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|EPIPE)\b/,
  // fetch/undici failure envelopes.
  /\bfetch failed\b/i,
  // Anchored to connection/transport wording — `network error` alone is dropped
  // (it matches prose like "handle the network error case").
  /\b(socket hang up|connection (reset|closed|refused|timed out))\b/i,
  // Transient HTTP gateway/availability codes (the status WORD, so a bare "504"
  // can't trip it; the number+word variant is subsumed by this, so just one).
  /\b(bad gateway|service unavailable|gateway time-?out)\b/i,
  // An explicitly-labeled timeout in an error/request envelope (not a bare "timeout"
  // an agent might print while discussing your code's timeouts).
  /\b(?:request|connection|read|client)\s+time(?:d)?\s*-?\s*out\b/i,
  // Provider-side "overloaded" (Anthropic 529) — transient, retried with backoff.
  /\b(overloaded_error|server is overloaded|temporarily unavailable)\b/i,
];

/**
 * Is the final rendered screen a TRANSIENT failure worth auto-retrying — a provider
 * rate/usage limit OR a network hiccup — as opposed to a normal prompt or a real
 * (non-transient) failure? Scans only the last few lines (the failure is the agent's
 * most recent output; old scrollback would false-positive — mirrors detectRateLimit /
 * the status detector's slice(-N)). Reuses detectRateLimit for the rate-limit
 * phrasings; adds the network patterns above. Fails CLOSED (false) when nothing
 * matches. Pure → unit-tested.
 */
export function isTransientFailure(screenText: string): boolean {
  if (!screenText) return false;
  // A rate-limited screen is transient by definition — reuse the shared detector so
  // the phrasings stay in ONE place (no duplicated rate-limit regexes).
  if (detectRateLimit(screenText) != null) return true;
  // Bound the window the same way detectRateLimit does, so old scrollback that merely
  // mentions a network error can't trip a retry.
  const recent = screenText.split("\n").slice(-8).join("\n");
  return TRANSIENT_NETWORK_PATTERNS.some((re) => re.test(recent));
}

/**
 * Backoff delay (ms) before the Nth auto-retry. `attempt` is 1-based: attempt 1 waits
 * the base delay, then each subsequent attempt doubles (5s, 10s, 20s, 40s, …),
 * clamped to AUTO_RETRY_MAX_DELAY_MS so the wait never runs away. A non-positive /
 * non-finite attempt is treated as the first. Pure.
 */
export function nextRetryDelay(
  attempt: number,
  baseMs: number = AUTO_RETRY_BASE_DELAY_MS,
  maxMs: number = AUTO_RETRY_MAX_DELAY_MS
): number {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  // 2^(n-1) grows fast; cap the exponent too so the shift can't overflow on a
  // pathological attempt count before the Math.min clamp would catch it.
  const factor = 2 ** Math.min(n - 1, 30);
  return Math.min(baseMs * factor, maxMs);
}

/**
 * Should we fire another auto-retry? True only while we're still under the cap.
 * `attempt` is the NEXT (1-based) attempt number we're about to make. Once it exceeds
 * `max` we STOP — the session stays ended and the user gets the plain Relaunch
 * affordance (no infinite loop, ever). Pure.
 */
export function shouldKeepRetrying(
  attempt: number,
  max: number = AUTO_RETRY_MAX_ATTEMPTS
): boolean {
  if (!Number.isFinite(attempt) || !Number.isFinite(max)) return false;
  return attempt >= 1 && attempt <= max;
}
