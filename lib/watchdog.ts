/**
 * Self-healing watchdog — the policy layer that keeps an unattended fleet from
 * silently dying. amux's headline feature; here it lands on seams Stoa already
 * has (the 2.5s status tick + the Dispatch reconciler) as a PURE decision core,
 * mirroring the rate-limit / error-loop modules: detection + the decision live
 * here (unit-tested, no I/O), and the callers (server.ts, reconciler.ts) own the
 * side effects.
 *
 * Two failure modes are covered, each opt-in and default-off so behavior is
 * unchanged unless you arm it:
 *
 *  A. HUNG DISPATCH WORKER — a 'dispatched' worker that is still live but has been
 *     coding far past any reasonable turn pins its concurrency slot forever (no PR,
 *     never exits). `isWorkerHung` is a wall-clock age check the reconciler's
 *     sweepActiveWorkers uses to reap it → 'failed', freeing the slot. Gated by
 *     STOA_DISPATCH_WORKER_MAX_AGE_MS (0/unset = never reap by age = today's
 *     behavior).
 *
 *  B. WEDGED SESSION — an agent whose spinner never settles (a hung request, a
 *     frozen TUI) reads as "running" indefinitely and the operator never finds
 *     out. `nextStuckAction` tracks continuous-running wall-clock per session and
 *     escalates ONCE per stuck episode. ESCALATE-ONLY: like error-loop, the
 *     terminal is NEVER written to — a false positive costs one extra push, never
 *     a derailed agent. A turn boundary (any non-"running" tick) resets the track,
 *     so a normally-iterating agent (which settles between turns) never pages;
 *     only a session that stays "running" for the whole ceiling does. Gated by
 *     STOA_AUTO_WATCHDOG=1.
 *
 * Both parsers fail SAFE (a garbage env value falls back to the default; an
 * unparseable dispatched_at is treated as not-hung) so a typo can never make the
 * watchdog more aggressive than intended.
 *
 * Follow-ups (deliberately out of v1, noted for the next pass): unattended
 * crash-RESTART of a wedged session (Stoa keeps a resumable DB row, so "row
 * without a live pty" is the normal resting state — restart needs a per-provider
 * "was supposed to be running" signal + a crash-loop budget before it's safe) and
 * low-context auto-/compact (a per-provider rendered-screen trigger). Both are the
 * natural next step once this escalate-only core has earned trust.
 */

// ── Part A: hung Dispatch worker (age-based slot reaper) ──

/**
 * Wall-clock age (ms) past which a still-live 'dispatched' worker is considered
 * hung and reaped to free its slot. 0 (the default) disables the age reaper
 * entirely — a worker is then only swept when it actually finishes/dies/opens a
 * PR (today's behavior). Garbage or negative values fall back to 0 (off), so a
 * typo can't silently start killing healthy workers. Read at call time (the
 * reconciler isn't the startup-const home server.ts is), so tests can set it.
 */
export function workerMaxAgeMs(): number {
  const raw = process.env.STOA_DISPATCH_WORKER_MAX_AGE_MS;
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Pure: is a dispatched worker hung purely by age? True only when the age reaper
 * is armed (maxAgeMs > 0) AND we can parse dispatched_at AND now is at least
 * maxAgeMs past it. Fails CLOSED: a null/garbage timestamp or a disarmed reaper
 * returns false (never reap) — we'd rather leave a slow-but-live worker than
 * abandon a healthy one. Unit-tested across the matrix.
 */
export function isWorkerHung(input: {
  /** issue_dispatches.dispatched_at as epoch-ms, or null if unparseable/unset. */
  dispatchedAtMs: number | null;
  nowMs: number;
  maxAgeMs: number;
}): boolean {
  if (input.maxAgeMs <= 0) return false; // reaper disarmed
  if (input.dispatchedAtMs == null || !Number.isFinite(input.dispatchedAtMs))
    return false; // can't age an unknown start → don't reap
  return input.nowMs - input.dispatchedAtMs >= input.maxAgeMs;
}

// ── Part B: wedged session (continuous-running escalation) ──

/** Per-session continuous-"running" tracking (lives in a Map in server.ts). */
export interface StuckTrack {
  /** When the current uninterrupted "running" streak began (ms). */
  firstMs: number;
  /** When it was last still running (ms). */
  lastMs: number;
  /** Whether we've already paged for this streak (one push per stuck episode). */
  escalated: boolean;
}

export type WatchdogAction = "escalate" | "track" | "idle";

/**
 * Pure decision for one session each tick. Returns the action + the NEXT track
 * state (null = clear tracking). Unit-tested across the matrix.
 *   idle     — not running (a turn boundary / waiting / idle / error), OR
 *              rate-limited → clear the streak, so only UNINTERRUPTED, healthy
 *              running counts.
 *   track    — running but the streak hasn't reached the ceiling yet, OR we've
 *              already paged for this streak (page once).
 *   escalate — running continuously for >= stuckMs and not yet paged → page once.
 * Because any non-running tick resets the streak, a normally-iterating agent
 * (which flips to waiting/idle at each turn boundary) never reaches the ceiling;
 * only a session whose spinner never settles does. A rate-limited session is
 * EXCLUDED (its spinner/countdown can keep it "running" for the whole limit
 * window) — that's the resume loop's job, never a wedge, exactly as the sibling
 * error-loop suppresses it.
 */
export function nextStuckAction(input: {
  isRunning: boolean;
  /** Rate-limited this tick — never a wedge (the resume loop owns it). */
  rateLimited?: boolean;
  nowMs: number;
  prev: StuckTrack | undefined;
  stuckMs: number;
  /** Max gap (ms) between observed ticks for the streak to count as continuous.
   * If the gap since the last observed tick exceeds this — a starved ticker (a
   * single slow capture holds the tick), a host sleep/suspend, or a wall-clock
   * step — we did NOT observe continuous running across it, so the streak
   * restarts. "Continuous" therefore means continuously OBSERVED, never two
   * far-apart samples bridging an unseen idle gap (which would false-page). */
  maxGapMs: number;
}): { action: WatchdogAction; next: StuckTrack | null } {
  if (!input.isRunning || input.rateLimited)
    return { action: "idle", next: null };
  // Continue the streak only if the prior observation is recent enough that the
  // intervening time was actually watched; otherwise treat the gap as a boundary
  // and start fresh from now.
  const continuous =
    input.prev !== undefined &&
    input.nowMs - input.prev.lastMs <= input.maxGapMs &&
    input.nowMs >= input.prev.lastMs; // a backward clock step also restarts
  const next: StuckTrack = continuous
    ? { ...input.prev!, lastMs: input.nowMs }
    : { firstMs: input.nowMs, lastMs: input.nowMs, escalated: false };
  if (next.escalated) return { action: "track", next }; // already paged this streak
  const stuck = next.lastMs - next.firstMs >= input.stuckMs;
  if (stuck) return { action: "escalate", next: { ...next, escalated: true } };
  return { action: "track", next };
}

/** Max gap (ms) between two observed status ticks for a "running" streak to count
 * as continuous. The tick runs every 2.5s; 60s tolerates a few slow/skipped
 * captures under load while still restarting the streak on a real gap (a host
 * sleep, a long starvation, an NTP step) so a wedge must be continuously OBSERVED,
 * not inferred from two distant samples. Not env-tunable — it's tied to the tick
 * cadence, not a user policy. */
export const WATCHDOG_MAX_GAP_MS = 60_000;

/** A human-facing push body for a wedged session: how long it's been running. Pure. */
export function buildStuckPushBody(name: string, track: StuckTrack): string {
  const mins = Math.max(1, Math.round((track.lastMs - track.firstMs) / 60000));
  return `${name} has been running ~${mins}m without settling — it may be stuck`;
}

/**
 * Continuous wall-clock "running" (ms) before a session is escalated as wedged
 * (env-overridable). Default 30 min — long enough that a genuine big build / long
 * turn rarely trips it, short enough to catch a hung agent the same night. Values
 * <= 0 (or garbage) fall back to the default. Read ONCE at startup (server.ts
 * captures it in a const), like ERROR_LOOP_WINDOW_MS.
 */
export const WATCHDOG_STUCK_MS = (() => {
  const raw = process.env.STOA_WATCHDOG_STUCK_MS;
  if (raw == null) return 1_800_000; // 30 min
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1_800_000;
})();

/** Is the unattended wedged-session escalation armed? Off by default
 * (STOA_AUTO_WATCHDOG=1 enables). Read ONCE at startup (server.ts captures it in
 * a const), like errorLoopEnabled. */
export function watchdogEnabled(): boolean {
  return process.env.STOA_AUTO_WATCHDOG === "1";
}
