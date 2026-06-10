/**
 * Auto-steer — error-loop nudge (the third Auto-steer half, after rate-limit
 * auto-resume #178 and policy auto-answer #185).
 *
 * When an agent gets STUCK on an error — its turn ends on a failure and the same
 * error sits on the rendered screen turn after turn, burning the overnight run on a
 * wall it can't get past — Stoa can (opt-in) nudge it ONCE with advice to try a
 * different approach, rather than the human finding it dead the next morning.
 *
 * This module is the PURE core (no I/O): normalize an error line into a stable
 * SIGNATURE, and decide from the cross-tick count whether to nudge. server.ts owns
 * the side effect (the status tick that pastes the nudge via the SessionBackend
 * seam) and the per-session tracking Map. It rides the SAME capture as rate-limit
 * + auto-answer (status + lastLine off computeManagedStatuses).
 *
 * SAFETY (the lesson from auto-answer): the unattended action is OPT-IN via
 * STOA_AUTO_NUDGE=1, fail-closed, and TRACED. The detector is deliberately
 * conservative — it fires only when the session is classified `error` (the status
 * detector's NARROW provider-failure envelopes, not normal output) AND the
 * normalized error is UNCHANGED for K consecutive ticks (so an agent iterating
 * productively, whose error text changes or whose status flips to `running`, is
 * never nudged). The nudge is benign advisory text (it can't approve a command),
 * sent ONCE per distinct error (re-armed only when the error changes) — a false
 * nudge costs one advisory line, never a destructive action.
 */

/** Per-session loop tracking (lives in a Map in server.ts). */
export interface LoopTrack {
  /** Normalized signature of the persisting error. */
  sig: string;
  /** Consecutive ticks the SAME signature has been seen. */
  count: number;
  /** Whether we've already nudged this signature (one nudge per distinct error). */
  nudged: boolean;
}

/**
 * Normalize an error line into a signature stable across turns: lowercased, with
 * the volatile bits stripped (digits, hex blobs, quoted strings, absolute paths,
 * times/durations) so the SAME underlying error matches even as line/byte offsets,
 * timestamps, and request ids change. Returns "" for an empty line. Pure.
 */
export function normalizeErrorSig(line: string): string {
  if (!line) return "";
  return line
    .toLowerCase()
    .replace(/['"`].*?['"`]/g, " ") // quoted strings (filenames, messages)
    .replace(/[a-z]:\\[^\s]+/g, " ") // windows paths
    .replace(/\/[^\s]+/g, " ") // posix paths
    .replace(/\S*\d\S*/g, " ") // any token with a digit: ids, hashes, line#s, durations
    .replace(/[^\w]+/g, " ") // collapse punctuation
    .trim();
}

export type ErrorLoopAction = "nudge" | "escalate" | "track" | "idle";

/**
 * Pure decision for one session each tick. Returns the action + the NEXT track
 * state (null = clear the tracking). Unit-tested across the matrix.
 *   idle     — not an error context (or rate-limited / no signature) → clear tracking
 *   track    — the same error is persisting but hasn't reached the threshold yet
 *   nudge    — threshold reached, armed, and not yet nudged this error → nudge once
 *   escalate — threshold reached but already nudged (or not armed) → leave it for
 *              the human (the error status is already surfaced)
 * A DIFFERENT signature resets the count to 1 and re-arms the nudge — productive
 * iteration (the error changes each turn) therefore never trips the threshold.
 */
export function nextErrorLoopAction(input: {
  isError: boolean;
  rateLimited: boolean;
  signature: string;
  prev: LoopTrack | undefined;
  threshold: number;
  nudgeArmed: boolean;
}): { action: ErrorLoopAction; next: LoopTrack | null } {
  // Rate-limited sessions are the resume loop's job, not a code-error loop. A
  // non-error session (working / waiting / idle) or an empty signature → clear.
  if (!input.isError || input.rateLimited || !input.signature) {
    return { action: "idle", next: null };
  }
  const same = !!input.prev && input.prev.sig === input.signature;
  const count = same ? input.prev!.count + 1 : 1;
  const nudged = same ? input.prev!.nudged : false;
  if (count < input.threshold) {
    return { action: "track", next: { sig: input.signature, count, nudged } };
  }
  if (input.nudgeArmed && !nudged) {
    return {
      action: "nudge",
      next: { sig: input.signature, count, nudged: true },
    };
  }
  return { action: "escalate", next: { sig: input.signature, count, nudged } };
}

/** The one-shot advisory nudge: benign text (it can't approve a command), telling
 * the agent the current approach is stuck and to change tack. Pure. */
export function buildNudgeMessage(): string {
  return (
    "[Stoa] You've hit the same error several times without making progress. " +
    "Stop and step back — the current approach isn't working. Try a DIFFERENT " +
    "strategy: question an assumption, read the actual error carefully, simplify " +
    "the change, or try another command — rather than retrying the same thing."
  );
}

/** Consecutive same-error ticks before a nudge (env-overridable). At the 2.5s
 * status tick, the default ≈ 20s of an unchanged error. STOA_NUDGE_THRESHOLD=0 is
 * clamped to 1 (a single observation would be far too eager). */
export const NUDGE_THRESHOLD = (() => {
  const raw = process.env.STOA_NUDGE_THRESHOLD;
  if (raw == null) return 8;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 8;
})();

/** Is the unattended error-loop nudge armed? Off by default (STOA_AUTO_NUDGE=1).
 * Read ONCE at startup (server.ts captures it in a const), like autoResumeEnabled. */
export function autoNudgeEnabled(): boolean {
  return process.env.STOA_AUTO_NUDGE === "1";
}
