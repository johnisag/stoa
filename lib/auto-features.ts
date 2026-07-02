/**
 * Centralized STOA_AUTO_* feature flags + a guarded-interval helper (#55).
 *
 * server.ts arms six guarded background timers (budget enforcement, budget-park,
 * dispatch reconciler, scheduler, cost sampler, auto-compact) plus the inline
 * status ticker. Each guarded one used to re-derive its env-flag read AND
 * hand-roll the same two pieces of scaffolding: a re-entrancy busy-guard (skip a
 * tick whose predecessor's slow I/O is still running) and `.unref()` (so the
 * timer never keeps the process alive on its own). This module factors both out:
 *
 *  - `getAutoFeatures()` — ONE typed snapshot of the parsed STOA_AUTO_* booleans
 *    (and the few numeric knobs the startup log references), read through the
 *    existing per-module helpers so this stays a single source of truth rather
 *    than a second place the env can drift out of sync. Read ONCE at startup
 *    (like every `*Enabled()` helper it wraps), so a running server's posture is
 *    fixed for its lifetime.
 *  - `anyTickEnabled()` — is ANY unattended write/escalate loop armed? (Mirrors
 *    the status ticker's "should the ticker keep running with no UI/push/queue"
 *    condition — the flags that make a screen-capturing tick worthwhile.)
 *  - `describeEnabled()` — a compact human summary of what's on, for the startup
 *    banner / a diagnostics line.
 *  - `makeGuardedInterval()` — wraps `setInterval` with the busy-guard + `.unref()`
 *    the timers currently hand-roll, so a new tick is one call, not a copy of the
 *    scaffolding. A disabled tick arms NO timer at all (zero overhead), matching
 *    the `if (FLAG) setInterval(...)` shape the timers use today.
 *
 * This is a pure refactor: no flag changes meaning, no timer changes cadence or
 * busy-guard semantics. The parsing/decision logic still lives in each feature's
 * own module; this only collects the reads and the timer scaffolding.
 */

import { autoResumeEnabled } from "./rate-limit";
import { autoAnswerEnabled, pushApproveEnabled } from "./auto-steer";
import { errorLoopEnabled } from "./error-loop";
import { watchdogEnabled } from "./watchdog";
import { channelDeliverEnabled } from "./channel-delivery";
import { costSampleEnabled } from "./cost-history";
import { autoCompactEnabled } from "./auto-compact";
import { compactMemoryEnabled } from "./compact-memory";

/**
 * A typed snapshot of the unattended-feature flags. Booleans mirror the
 * `*Enabled()` helpers 1:1; `snapshots` is the always-on per-turn snapshot toggle
 * (STOA_SNAPSHOTS=1) the status ticker also honors. Read via getAutoFeatures().
 */
export interface AutoFeatures {
  /** STOA_AUTO_RESUME=1 — nudge a rate-limited session at reset. */
  resume: boolean;
  /** STOA_AUTO_ANSWER=1 — press Enter on a routine prompt. */
  answer: boolean;
  /** STOA_PUSH_APPROVE=1 — a lock-screen Approve button presses Enter. */
  pushApprove: boolean;
  /** STOA_ERROR_LOOP=1 — page once when a session sticks on the same error. */
  errorLoop: boolean;
  /** STOA_AUTO_WATCHDOG=1 — page once when a session stays "running" too long. */
  watchdog: boolean;
  /** STOA_AUTO_CHANNEL_DELIVER=1 — inject an unread channel message at a boundary. */
  channelDeliver: boolean;
  /** STOA_AUTO_COST_SAMPLE=1 — persist spend history unattended. */
  costSample: boolean;
  /** STOA_AUTO_COMPACT=1 — send /compact to a full Claude session at idle. */
  compact: boolean;
  /** STOA_COMPACT_MEMORY=1 — flush a memory file before /compact + re-inject a
   *  pointer after (inert unless `compact` is also on). */
  compactMemory: boolean;
  /** STOA_SNAPSHOTS=1 — write refs/stoa/snap/* at each turn boundary. */
  snapshots: boolean;
}

/**
 * Read the current STOA_AUTO_* posture as one typed object. Each field delegates
 * to that feature's own `*Enabled()` helper (the single source of truth for how
 * the flag is parsed), so this can't drift from the modules. Call ONCE at startup
 * — the individual helpers are `=== "1"` reads, so the snapshot is a value, not a
 * live view of process.env.
 */
export function getAutoFeatures(): AutoFeatures {
  return {
    resume: autoResumeEnabled(),
    answer: autoAnswerEnabled(),
    pushApprove: pushApproveEnabled(),
    errorLoop: errorLoopEnabled(),
    watchdog: watchdogEnabled(),
    channelDeliver: channelDeliverEnabled(),
    costSample: costSampleEnabled(),
    compact: autoCompactEnabled(),
    compactMemory: compactMemoryEnabled(),
    snapshots: perTurnSnapshotsEnabled(),
  };
}

/** STOA_SNAPSHOTS=1 — opt-in per-turn working-tree snapshots (refs/stoa/snap/*).
 *  Off by default. Named `perTurn…` to NOT collide with env-snapshot.ts's
 *  `snapshotsEnabled()` (node_modules snapshots, STOA_ENV_SNAPSHOTS, default ON)
 *  — a same-named export with the opposite default would be a footgun. */
export function perTurnSnapshotsEnabled(): boolean {
  return process.env.STOA_SNAPSHOTS === "1";
}

/**
 * Is ANY status-ticker-driving feature armed? These are the flags that make the
 * screen-capturing status tick worth running even with no UI/push/queue attached
 * (a rate-limited session can only resume itself if we keep capturing screens).
 * Mirrors the status ticker's own keep-running condition in server.ts — the
 * auto-* set that observes the rendered screen each tick. Does NOT include the
 * DB-only loops (cost sample / compact / budget), which run on their own timers.
 */
export function anyTickEnabled(f: AutoFeatures = getAutoFeatures()): boolean {
  return (
    f.snapshots ||
    f.resume ||
    f.answer ||
    f.errorLoop ||
    f.watchdog ||
    f.channelDeliver
  );
}

/**
 * A compact, human-readable summary of the enabled features for a startup /
 * diagnostics line — e.g. "auto-resume, auto-answer, watchdog". Returns "none"
 * when everything is off. Lists every ON flag so the summary is a faithful mirror
 * of the posture (compactMemory / pushApprove included even though each is inert
 * without its parent feature).
 */
export function describeEnabled(f: AutoFeatures = getAutoFeatures()): string {
  const on: string[] = [];
  if (f.resume) on.push("auto-resume");
  if (f.answer) on.push("auto-answer");
  if (f.pushApprove) on.push("push-approve");
  if (f.errorLoop) on.push("error-loop");
  if (f.watchdog) on.push("watchdog");
  if (f.channelDeliver) on.push("channel-deliver");
  if (f.costSample) on.push("cost-sample");
  if (f.compact) on.push("auto-compact");
  if (f.compactMemory) on.push("compact-memory");
  if (f.snapshots) on.push("snapshots");
  return on.length ? on.join(", ") : "none";
}

/** A running interval handle. `stop()` clears the timer (idempotent). */
export interface GuardedInterval {
  /** The underlying timer, or null when the tick was disabled (armed nothing). */
  timer: NodeJS.Timeout | null;
  /** Clear the interval. Safe to call more than once / when nothing was armed. */
  stop(): void;
}

export interface GuardedIntervalOptions {
  /** Fire every this many ms. */
  intervalMs: number;
  /** When false, arm NOTHING (zero overhead) — matches `if (FLAG) setInterval`. */
  enabled?: boolean;
  /** The work to run each tick. May be sync or async; a rejection is caught so a
   *  bad tick never crashes the process (parity with each timer's own try/catch,
   *  which callers keep for their own logging). */
  tick: () => void | Promise<void>;
  /** Run one tick immediately (still busy-guarded), before the first interval —
   *  the budget-park loop does this so a restart re-parks without a 30s gap. */
  runAtStartup?: boolean;
  /** Call `.unref()` on the timer so it never holds the event loop open on its
   *  own. Default true (every background loop wants this). A timer that must keep
   *  the process alive (e.g. the always-armed budget enforcement) sets false to
   *  match its hand-rolled `setInterval` that never unref'd. */
  unref?: boolean;
  /** Called if the tick throws/rejects. Defaults to a console.error. Callers that
   *  already wrap their tick body in try/catch can omit this. */
  onError?: (err: unknown) => void;
}

/**
 * setInterval + the re-entrancy busy-guard and `.unref()` the server timers
 * hand-roll. The guard skips a tick whose predecessor is still running (a slow
 * transcript read / gh call must never stack), and `.unref()` keeps the timer
 * from holding the event loop open on its own. A disabled tick arms no timer.
 *
 * The busy-guard is the SAME single-flag pattern the timers use:
 *   if (busy) return; busy = true; try { await tick() } finally { busy = false }
 * so the semantics are behavior-identical to the inline versions it replaces.
 * Because JS is single-threaded, `busy` can only be observed as true across an
 * `await` inside tick — a purely synchronous tick can never re-enter, exactly as
 * before.
 */
export function makeGuardedInterval(
  opts: GuardedIntervalOptions
): GuardedInterval {
  if (opts.enabled === false) {
    return { timer: null, stop() {} };
  }
  const onError =
    opts.onError ??
    ((err) => console.error("guarded interval tick failed:", err));
  let busy = false;
  const run = async () => {
    if (busy) return; // don't stack ticks if the previous run is still going
    busy = true;
    try {
      await opts.tick();
    } catch (err) {
      onError(err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, opts.intervalMs);
  // Don't let the timer keep the process alive on its own (parity with every
  // server.ts timer's `.unref?.()`; optional-chained for non-Node hosts/tests).
  // Opt out (unref:false) for a loop that must hold the loop open, as the inline
  // budget-enforcement timer did.
  if (opts.unref !== false) timer.unref?.();
  if (opts.runAtStartup) void run();
  return {
    timer,
    stop() {
      clearInterval(timer);
    },
  };
}
