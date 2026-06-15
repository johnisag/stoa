/**
 * Rate-limit auto-resume — detect a provider rate/usage limit from the RENDERED
 * screen, parse the reset time, count down, and (opt-in) resume the session at
 * reset so dead overnight hours become throughput.
 *
 * This module is the PURE core (no I/O): detection, reset-time parsing, and the
 * resume decision. server.ts owns the side effects (the reconcile tick that
 * resumes via the SessionBackend seam + dequeues the prompt queue). Everything
 * here is unit-tested; the parsers fail CLOSED (null) when unsure — a false
 * positive would inject a keystroke into a healthy session, so we'd rather miss.
 *
 * Detection + surfacing the "rate-limited, resets in N" state is always-on. The
 * unattended RESUME (injecting input) is opt-in via STOA_AUTO_RESUME=1, mirroring
 * the budget caps' off-by-default posture (see lib/budget.ts).
 */

/** A detected rate-limited state on the rendered screen. */
export interface RateLimitState {
  /** Short human reason (the provider phrasing bucket we matched). */
  reason: string;
  /** Epoch-ms the limit resets, or null if we couldn't parse a reset time. */
  resetAt: number | null;
}

/**
 * Provider rate/usage-limit phrasings. Deliberately NARROW and anchored to
 * limit-specific wording (not a bare "rate limit", which an agent might print
 * while discussing your code) so normal output never false-positives. Each entry
 * pairs a matcher with the bucket label we surface. Order matters only for the
 * label; any match means rate-limited.
 */
const LIMIT_PATTERNS: { re: RegExp; reason: string }[] = [
  // Claude Code: "5-hour limit reached", "Claude usage limit reached".
  { re: /\b\d+\s*-?\s*hour limit reached/i, reason: "usage limit reached" },
  { re: /\b(usage|usage limit) reached\b/i, reason: "usage limit reached" },
  { re: /\bClaude (usage )?limit reached\b/i, reason: "usage limit reached" },
  // Generic "you've hit/reached your … limit" (rate, usage, or message limit).
  {
    re: /\b(reached|hit)\b[^\n]*\b(rate|usage|message|daily|weekly)\s+limit\b/i,
    reason: "usage limit reached",
  },
  // "rate/usage/quota limit exceeded|exhausted" (a strong, specific provider
  // signal — not a bare "rate limit" an agent might print discussing your code).
  {
    re: /\b(?:rate|usage|quota)\s+limit\s+(?:exceeded|exhausted)\b/i,
    reason: "usage limit reached",
  },
  // Anthropic/OpenAI API 429 envelope phrasings.
  {
    re: /\brate[_ ]limit(_error|ed)?\b[^\n]*\btry again\b/i,
    reason: "rate limited",
  },
  {
    re: /\b429\b[^\n]*\b(rate limit|too many requests)\b/i,
    reason: "rate limited",
  },
  // "Too many requests" ONLY inside an error/HTTP envelope — not an agent
  // narrating about rate limiting in your code ("the API returns too many…").
  {
    re: /\b(?:error|status|http)\b[^\n]{0,24}\btoo many requests\b/i,
    reason: "rate limited",
  },
  // Reset notices: require a DIGIT right after at/in, so "resets at midnight" or
  // "try again in a new conversation" / "in CI" don't trip it — only a real
  // clock ("at 3pm") or countdown ("in 30s") does.
  {
    re: /\b(?:try again|resets?)\b[^\n]*\b(?:at|in)\s+\d/i,
    reason: "rate limited",
  },
];

/**
 * Detect a rate-limited state from the rendered screen. Scans only the last few
 * lines (a limit notice is the agent's most recent output; old scrollback would
 * false-positive). Returns null when nothing matches. When it DOES match, it
 * also tries to parse a reset time off the same recent text (best-effort; null
 * when unsure). Pure → unit-tested.
 */
export function detectRateLimit(
  renderedScreen: string,
  nowMs: number = Date.now()
): RateLimitState | null {
  if (!renderedScreen) return null;
  // Limit notices land on the most recent output; bound the window so old
  // scrollback can't trip detection (mirrors the status detector's slice(-N)).
  const recent = renderedScreen.split("\n").slice(-8).join("\n");
  const hit = LIMIT_PATTERNS.find((p) => p.re.test(recent));
  if (!hit) return null;
  return { reason: hit.reason, resetAt: parseResetTime(recent, nowMs) };
}

/**
 * Parse a reset time out of `text` into epoch-ms, or null when unsure.
 * Handles RELATIVE forms ("in 2h 5m", "in 43 minutes", "try again in 30s") and
 * ABSOLUTE clock forms ("at 3:00 PM", "try again at 15:30"). Fails CLOSED: if no
 * recognizable reset phrase is present, returns null (the caller then counts no
 * timer and waits for the agent itself / the user). `nowMs` anchors both the
 * relative offset and the next-occurrence resolution of an absolute clock time.
 */
export function parseResetTime(text: string, nowMs: number): number | null {
  if (!text) return null;
  return parseRelativeReset(text, nowMs) ?? parseAbsoluteReset(text, nowMs);
}

// "in 2h 5m" / "in 43 minutes" / "try again in 30 seconds" / "resets in 1 hour".
// Anchored on an "in" lead-in so an unrelated "5 minutes" elsewhere is ignored.
function parseRelativeReset(text: string, nowMs: number): number | null {
  // Find the clause introduced by "in" near a try-again/reset cue, else any "in".
  const m =
    /\b(?:try again|resets?|available again|back)\s+in\s+([^\n.,;)]+)/i.exec(
      text
    ) ||
    /\bin\s+(\d[\dhms\s]*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|[hms])\b[^\n.,;)]*)/i.exec(
      text
    );
  if (!m) return null;
  const clause = m[1];
  let totalMs = 0;
  let matched = false;
  // Sum every "<n> <unit>" / "<n><unit>" token in the clause (e.g. "2h 5m").
  const unitRe =
    /(\d+(?:\.\d+)?)\s*(hours?|hrs?|hour|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi;
  for (const u of clause.matchAll(unitRe)) {
    const n = Number(u[1]);
    if (!Number.isFinite(n)) continue;
    const unit = u[2].toLowerCase();
    if (unit.startsWith("h")) totalMs += n * 3600_000;
    else if (unit.startsWith("m")) totalMs += n * 60_000;
    else if (unit.startsWith("s")) totalMs += n * 1_000;
    else continue;
    matched = true;
  }
  if (!matched || totalMs <= 0) return null;
  return nowMs + totalMs;
}

// "at 3:00 PM" / "at 15:30" / "try again at 3pm". Resolves to the NEXT
// occurrence of that clock time at/after now (so a "3 PM" when it's already 4 PM
// means tomorrow). Date math is in the host local zone (the agent's clock).
function parseAbsoluteReset(text: string, nowMs: number): number | null {
  // The bare `at HH:MM` fallback fires ONLY when the text actually mentions a
  // reset/retry — otherwise an unrelated clock time in the window (a log
  // timestamp, an ETA) would hijack resetAt. Fail closed (prefer null) over a
  // wrong resume time.
  const resetCued =
    /\b(?:try again|resets?|available again|come back|back)\b/i.test(text);
  const m =
    /\b(?:try again|resets?|available again|back)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(
      text
    ) ||
    (resetCued ? /\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.exec(text) : null);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] != null ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  const now = new Date(nowMs);
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    0,
    0
  );
  let t = candidate.getTime();
  // If that time already passed today, it's the same clock time TOMORROW — built
  // in local time (not +24h) so a DST transition night stays on the right hour.
  if (t <= nowMs) {
    t = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      hour,
      minute,
      0,
      0
    ).getTime();
  }
  return t;
}

export type RateLimitAction = "wait" | "resume" | "idle";

/**
 * Pure decision for one rate-limited session each tick:
 *   not detected            → "idle"   (nothing to do)
 *   detected, no resetAt     → "wait"   (count nothing; hold until the agent/user acts)
 *   detected, now <  resetAt → "wait"   (counting down)
 *   detected, now >= resetAt → "resume" (reset has passed — nudge the session)
 * Resume fires ONLY once now has reached resetAt, so we never poke a session that
 * is still inside its limit window. Unit-tested across the matrix.
 */
export function nextRateLimitAction(input: {
  detected: boolean;
  resetAtMs: number | null;
  nowMs: number;
  /** A real prompt is on the rendered screen. Resume re-triggers a counted-down
   * TURN by injecting Enter/a queued task; firing that into an open permission
   * dialog would answer it. So never resume while a prompt is up — keep waiting
   * until the user (or auto-answer) clears it. */
  hasPrompt?: boolean;
}): RateLimitAction {
  if (!input.detected) return "idle";
  if (input.hasPrompt) return "wait";
  if (input.resetAtMs == null) return "wait";
  return input.nowMs >= input.resetAtMs ? "resume" : "wait";
}

/** Is unattended auto-resume armed? Off by default (STOA_AUTO_RESUME=1 enables).
 * Read ONCE at startup (server.ts captures it in a const), like budget.ts. */
export function autoResumeEnabled(): boolean {
  return process.env.STOA_AUTO_RESUME === "1";
}
