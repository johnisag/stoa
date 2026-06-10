/**
 * Auto-steer — error-loop ESCALATION (the third Auto-steer half, after rate-limit
 * auto-resume #178 and policy auto-answer #185).
 *
 * When an agent's turn ENDS on an error and the SAME error sits there turn after
 * turn — stuck on a wall it can't pass, burning the overnight run — Stoa (opt-in)
 * fires ONE distinct "stuck in a loop" push so the human steps in, instead of
 * finding it dead the next morning.
 *
 * v1 is ESCALATE-ONLY: the terminal is NEVER written to. That's the deliberate
 * safety boundary — a false positive costs exactly one extra notification, never a
 * derailed agent (an unattended text-injection "nudge" is a clean follow-up, once
 * the detector earns trust). The only unattended action is a NOTIFICATION.
 *
 * This module is the PURE core (no I/O): normalize an error line into a stable
 * SIGNATURE, and decide from the cross-tick count + elapsed window whether to
 * escalate. server.ts owns the side effect (a Web Push) and the per-session Map. It
 * rides the SAME 2.5s status capture as rate-limit + auto-answer (status + lastLine
 * off computeManagedStatuses — no extra round-trip).
 *
 * SAFETY / false-positive layers (the lesson from auto-answer):
 *  - escalate-only (above) — the structural guard.
 *  - keyed STRICTLY off status === "error" (the status detector's NARROW
 *    provider-failure envelopes, not normal output); a busy/working or waiting
 *    session outranks "error" in classify(), so it's never sampled as a loop.
 *  - normalizeErrorSig collapses turn-to-turn volatility (ids/paths/digits/quoted
 *    spans) so a genuinely-DIFFERENT error each turn resets the count → a
 *    productively-iterating agent never trips the threshold.
 *  - two independent axes: K consecutive same-error ticks AND a ≥MIN_WINDOW elapsed
 *    floor, so a momentary error across a few fast ticks isn't "stuck".
 *  - one escalation per loop (re-armed only when the error changes); opt-in + traced.
 */

/** Per-session loop tracking (lives in a Map in server.ts). */
export interface LoopTrack {
  /** Normalized signature of the persisting error. */
  sig: string;
  /** Consecutive ticks the SAME signature has been seen. */
  count: number;
  /** When this signature was first seen (ms) — the window floor's start. */
  firstMs: number;
  /** When it was last seen (ms). */
  lastMs: number;
  /** Whether we've already paged for this loop (one push per distinct error). */
  escalated: boolean;
}

/**
 * Normalize an error line into a signature stable across turns: lowercased, with the
 * volatile bits collapsed (ANSI; MATCHED quoted spans; absolute paths; any
 * digit-bearing token — ids, hashes, line numbers, durations) so the SAME underlying
 * error matches even as offsets, request-ids, and timestamps change, while two
 * genuinely-different errors stay discriminable. Returns "" for a line with no
 * stable content left. Pure.
 */
export function normalizeErrorSig(line: string): string {
  if (!line) return "";
  return (
    line
      .toLowerCase()
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, " ") // ANSI color codes
      .replace(/"[^"]*"|`[^`]*`/g, " ") // double/back-quoted spans (NOT single — a
      // contraction apostrophe ("you're") would mis-pair and eat the message; a
      // stable error keeps the same filename each turn anyway, so it needn't strip)
      .replace(/[a-z]:\\[^\s]+/gi, " ") // windows paths
      .replace(/\/[^\s]+/g, " ") // posix paths
      .replace(/\S*\d\S*/g, " ") // any token with a digit: ids, hashes, line#s, durations
      .replace(/[^\w]+/g, " ") // collapse punctuation / box-drawing chrome
      .trim()
  );
}

export type ErrorLoopAction = "escalate" | "track" | "idle";

/**
 * Pure decision for one session each tick. Returns the action + the NEXT track state
 * (null = clear the tracking). Unit-tested across the matrix.
 *   idle     — not an error context (or rate-limited / no signature) → clear tracking
 *   track    — the same error is persisting but hasn't met the threshold+window yet,
 *              OR we've already escalated this loop (page once)
 *   escalate — the same error has stuck for >= threshold ticks AND >= minWindowMs,
 *              and we haven't paged yet → page once
 * A DIFFERENT signature starts a fresh track (count 1, re-armed) — productive
 * iteration (the error changes each turn) therefore never escalates. A rate-limited
 * session is the resume loop's job, never escalated here.
 */
export function nextErrorLoopAction(input: {
  isError: boolean;
  rateLimited: boolean;
  signature: string;
  nowMs: number;
  prev: LoopTrack | undefined;
  threshold: number;
  minWindowMs: number;
}): { action: ErrorLoopAction; next: LoopTrack | null } {
  if (!input.isError || input.rateLimited || !input.signature) {
    return { action: "idle", next: null };
  }
  const same = !!input.prev && input.prev.sig === input.signature;
  const next: LoopTrack = same
    ? {
        ...input.prev!,
        count: input.prev!.count + 1,
        lastMs: input.nowMs,
      }
    : {
        sig: input.signature,
        count: 1,
        firstMs: input.nowMs,
        lastMs: input.nowMs,
        escalated: false,
      };
  if (next.escalated) return { action: "track", next }; // already paged this loop
  const stuck =
    next.count >= input.threshold &&
    next.lastMs - next.firstMs >= input.minWindowMs;
  if (stuck) return { action: "escalate", next: { ...next, escalated: true } };
  return { action: "track", next };
}

/** A human-facing push body for a stuck loop: how long the same error has held. Pure. */
export function buildLoopPushBody(name: string, track: LoopTrack): string {
  const mins = Math.max(1, Math.round((track.lastMs - track.firstMs) / 60000));
  return `${name} stuck in an error loop (same error for ~${mins}m)`;
}

/** Consecutive same-error ticks before escalation (env-overridable). Values below 1
 * (or garbage) fall back to the default 4. */
export const ERROR_LOOP_THRESHOLD = (() => {
  const raw = process.env.STOA_ERROR_LOOP_THRESHOLD;
  if (raw == null) return 4;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
})();

/** Minimum elapsed time the SAME error must persist before escalation (ms). The
 * binding gate: at the 2.5s tick, "stuck for ~90s", not a momentary blip. Values
 * <= 0 (or garbage) fall back to the default. */
export const ERROR_LOOP_WINDOW_MS = (() => {
  const raw = process.env.STOA_ERROR_LOOP_WINDOW_MS;
  if (raw == null) return 90_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90_000;
})();

/** Is the unattended error-loop escalation armed? Off by default (STOA_ERROR_LOOP=1).
 * Read ONCE at startup (server.ts captures it in a const), like autoResumeEnabled. */
export function errorLoopEnabled(): boolean {
  return process.env.STOA_ERROR_LOOP === "1";
}
