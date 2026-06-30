/**
 * Auto-/compact — proactively reclaim a Claude session's context window BEFORE it fills,
 * so an unattended/overnight run doesn't stall in (or crash from) the painful
 * auto-compaction. amux's headline self-healing move, ported to Stoa's posture: detection
 * + the decision live here (pure, unit-tested); server.ts owns the side effect (it sends
 * `/compact` via the SessionBackend at an idle boundary).
 *
 * Unlike the escalate-only watchdog/error-loop, this WRITES to the session — so it is
 * OPT-IN (STOA_AUTO_COMPACT=1, off by default, mirroring auto-resume) and fires ONLY at a
 * clean turn boundary that matches the repo's CANONICAL unattended-write gate: status
 * "idle" AND no detected prompt (`isChannelDeliveryTurn` / queue-dispatch use the same
 * `idle && !hasPrompt`) — never mid-turn, never into an open permission/input dialog. A
 * cooldown prevents re-compacting before the transcript-derived context reading catches up
 * to the just-issued compaction, and a per-session DAILY CAP (like auto-resume's) stops a
 * runaway 5-min loop if context stays high (e.g. the post-compact transcript reads stale).
 * All pure helpers fail SAFE (a junk env value falls back to the default; an unknown
 * context reads as "do nothing"), so a typo can never make it compact more aggressively
 * than intended.
 *
 * NOTE: like every unattended writer here, the paste lands at the cursor — a session that
 * is idle with a half-typed user DRAFT would get `/compact` appended. Accepted: the
 * threshold + cooldown + daily-cap gating keeps the write rate low, matching the posture
 * of auto-resume / channel-delivery.
 */

export type CompactAction = "compact" | "wait" | "idle";

/**
 * Pure decision for one session each tick:
 *   idle    — disabled, or the context window has headroom (< threshold), or unknown →
 *             nothing to do.
 *   wait    — over the threshold but NOT at a clean idle boundary (working / waiting on a
 *             prompt / errored), or still inside the post-compact cooldown → hold.
 *   compact — over the threshold, idle, and past the cooldown → send /compact (once).
 * Unit-tested across the matrix.
 */
export function nextCompactAction(input: {
  /** Context-window occupancy, 0..1 (from the transcript), or null when unknown. */
  contextPct: number | null;
  /** Compact at/above this fraction full. <= 0 disables (treated as off). */
  threshold: number;
  /** The session is at a clean boundary (status "idle": at rest) — necessary, not
   *  sufficient: also require !hasPrompt below. Anything else (running / waiting / error /
   *  dead) holds. */
  isIdle: boolean;
  /** A real interactive prompt (a question / permission / [Y/n]) is on screen. The coarse
   *  "idle" classification can flicker over a prompt whose render is intermittent, so —
   *  exactly like every other unattended writer (channel-delivery, queue-dispatch,
   *  auto-resume) — we NEVER write when a prompt is detected, even if status reads idle. */
  hasPrompt?: boolean;
  /** Auto-compactions already spent for this session today (UTC). */
  compactionsUsedToday?: number;
  /** Daily cap per session (>0 enforced; 0/undefined = unlimited) — backstop against a
   *  runaway loop when context stays high after a compact. */
  maxPerDay?: number;
  /** When we last sent /compact to this session (ms), or null if never this episode. */
  lastCompactMs: number | null;
  /** Minimum gap between compactions — covers the transcript lag after a compact. */
  cooldownMs: number;
  nowMs: number;
}): CompactAction {
  if (input.threshold <= 0) return "idle"; // disabled
  if (
    input.contextPct == null ||
    !Number.isFinite(input.contextPct) ||
    input.contextPct < input.threshold
  ) {
    return "idle"; // unknown or has headroom
  }
  // The canonical unattended-write boundary: settled AND no open prompt to hijack.
  if (!input.isIdle || input.hasPrompt) return "wait";
  // Daily budget: once spent, hold until the UTC day rolls over (stops a hot loop).
  if (
    input.maxPerDay != null &&
    input.maxPerDay > 0 &&
    (input.compactionsUsedToday ?? 0) >= input.maxPerDay
  ) {
    return "wait";
  }
  if (
    input.lastCompactMs != null &&
    input.nowMs - input.lastCompactMs < input.cooldownMs
  ) {
    return "wait"; // still cooling down from the last /compact
  }
  return "compact";
}

/** Is unattended auto-compact armed? Off by default (STOA_AUTO_COMPACT=1 enables). Read
 *  ONCE at startup (server.ts captures it in a const), like autoResumeEnabled. */
export function autoCompactEnabled(): boolean {
  return process.env.STOA_AUTO_COMPACT === "1";
}

/**
 * Parse `STOA_AUTO_COMPACT_AT` into a 0..1 fullness threshold. Accepts a FRACTION (`0.85`)
 * or a PERCENT (`85`); unset / empty / garbage / out-of-range all fall back to the default
 * 0.85, and any value is clamped to the sane [0.5, 0.99] band (compacting below half-full
 * is wasteful; above 99% is too late). The boolean (STOA_AUTO_COMPACT) is what arms the
 * feature, so a bad threshold tunes to the default rather than disabling. Pure → tested.
 */
export function parseCompactThreshold(raw: string | undefined): number {
  const DEFAULT = 0.85;
  if (raw == null || raw.trim() === "") return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT;
  const frac = n <= 1 ? n : n <= 100 ? n / 100 : NaN;
  if (!Number.isFinite(frac)) return DEFAULT;
  return Math.min(0.99, Math.max(0.5, frac));
}

/** Compact-at threshold (fraction full), read ONCE at startup. */
export const COMPACT_THRESHOLD = parseCompactThreshold(
  process.env.STOA_AUTO_COMPACT_AT
);

/**
 * Parse `STOA_AUTO_COMPACT_COOLDOWN_MS` (pure → tested). The gap after a /compact before
 * another can fire — long enough that the transcript-derived context reading reflects the
 * compaction (else we'd re-compact on stale data). Unset / garbage / negative → the
 * default 5 min (matching amux). Floored at 60s so a tiny value can't spam /compact.
 */
export function parseCompactCooldownMs(raw: string | undefined): number {
  const DEFAULT = 300_000; // 5 min
  if (raw == null || raw.trim() === "") return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT;
  return Math.max(60_000, Math.floor(n));
}

/** Cooldown between compactions (ms), read ONCE at startup. */
export const COMPACT_COOLDOWN_MS = parseCompactCooldownMs(
  process.env.STOA_AUTO_COMPACT_COOLDOWN_MS
);

/**
 * Parse `STOA_AUTO_COMPACT_MAX_PER_DAY` (pure → tested, mirrors parseResumeMaxPerDay). The
 * per-session daily cap — a backstop so a session pinned above the threshold can't be
 * `/compact`ed every cooldown forever (e.g. when the post-compact transcript reads stale).
 * Default 12 (generous: legitimate use rarely refills the window 12× in a day, but a hot
 * loop hits it fast and falls back to the native auto-compaction). Unset / empty / garbage
 * / negative → 12; an explicit `0` is the documented "unlimited" opt-out; a sub-1 positive
 * floors to 1 (never "unlimited" by accident).
 */
export function parseCompactMaxPerDay(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return 12;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 12;
  return n === 0 ? 0 : Math.max(1, Math.floor(n));
}

/** Per-session daily auto-compact cap (`STOA_AUTO_COMPACT_MAX_PER_DAY`). 0 = unlimited;
 *  default 12. Read ONCE at startup. */
export const COMPACT_MAX_PER_DAY = parseCompactMaxPerDay(
  process.env.STOA_AUTO_COMPACT_MAX_PER_DAY
);
