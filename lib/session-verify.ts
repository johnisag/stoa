/**
 * Outcome-based verify badge for INTERACTIVE sessions (#19).
 *
 * When a session finishes a turn (the "done" claim — a running/waiting→idle
 * transition with no real prompt on screen), actually RUN the project's verify
 * command (typecheck/test/build) in the session's worktree and record a real
 * red/green verdict on the sessions row — independent of the agent's
 * self-report. The badge is TURN-SCOPED evidence: when the next turn starts
 * (→running) the stale verdict is cleared, so a green badge always refers to
 * the tree as the agent last left it.
 *
 * Reuses the dispatch verify harness wholesale: `runVerify` (no-shell argv
 * steps, timeout, bounded output, never throws) and the same
 * VERIFY_MAX_CONCURRENT local-CPU cap (builds are the one pass whose cost is
 * the operator's machine). Opt-in by construction: a project with no
 * verify_command gets no badge and costs nothing. Fire-and-forget off the
 * status tick — a slow build never stalls the live status broadcast.
 *
 * The decision is pure (decideSessionVerify) → unit-tested; the tick pass does
 * the I/O, mirroring verifyPass.
 */

import { getDb, queries, type Session, type Project } from "./db";
import { runVerify, VERIFY_MAX_CONCURRENT } from "./dispatch/verify";
import { runInBackground } from "./async-operations";
import { expandHome } from "./platform";

export type SessionVerifyDecision = "run" | "clear" | "none";

/**
 * The per-session, per-tick TRANSITION decision. Pure → unit-tested. Note the
 * config/in-flight gates deliberately live in the tick (they need DB/module
 * state and only apply after a boundary is detected), so this function's inputs
 * are all honest observations — nothing is passed as a constant placeholder.
 *   clear — a NEW TURN started (→running from a settled state): the old verdict
 *           no longer describes the tree, drop it (regardless of config).
 *   run   — a turn ENDED (running/waiting → idle) with no real prompt on
 *           screen. (Prompt detection is the same platform-wide screen
 *           heuristic every tick consumer trusts — auto-answer, push, the
 *           prompt queue; a missed prompt costs one capped build whose verdict
 *           clears at the next boundary. No new trust is introduced here.)
 *   none  — everything else (first observation, unchanged status, prompt on
 *           screen).
 */
export function decideSessionVerify(input: {
  prevStatus: string | undefined;
  currStatus: string;
  hasPrompt: boolean;
}): SessionVerifyDecision {
  const turnStarted =
    input.prevStatus != null &&
    input.prevStatus !== "running" &&
    input.currStatus === "running";
  if (turnStarted) return "clear";
  const turnDone =
    (input.prevStatus === "running" || input.prevStatus === "waiting") &&
    input.currStatus === "idle";
  if (!turnDone) return "none";
  if (input.hasPrompt) return "none"; // a real [Y/n]-style prompt isn't "done"
  return "run";
}

// One verify per session at a time; total launches capped by
// VERIFY_MAX_CONCURRENT (shared default with dispatch — worst case the two
// passes together run 2×cap builds; both are env-tunable).
const sessionVerifyInFlight = new Set<string>();

// Previous tick's status per session id — the transition source. Module-level
// is safe: the status tick is single-process and statusTickBusy-serialized.
let prevStatusById = new Map<string, string>();

// Crash recovery: a restart empties the inFlight set, so any DB row still
// marked 'running' belongs to a build that died with the old process — swept
// once, lazily, on the first tick (mirrors dispatch verify's stale-'running'
// re-launch rule, but for a turn-scoped badge the honest verdict is "no
// verdict", not a re-run of a boundary that already passed).
let bootSwept = false;

/** Test-only: reset module state between cases. */
export function _resetSessionVerifyState(): void {
  sessionVerifyInFlight.clear();
  prevStatusById = new Map();
  bootSwept = false;
}

/**
 * The status-tick pass: observe each managed session's transition and act.
 * Called every tick with the freshly computed statuses; never throws and never
 * awaits a build (fire-and-forget), so the tick can't stall. A launch skipped
 * by the concurrency cap simply doesn't run for that turn (the next done
 * boundary re-triggers) — turn-scoped evidence, not a queue.
 */
export function sessionVerifyTick(
  curr: Array<{ id: string; status: string; prompt?: unknown }>
): void {
  const db = getDb();
  if (!bootSwept) {
    bootSwept = true;
    // See the bootSwept comment: after a restart every 'running' row is stale.
    db.prepare(
      `UPDATE sessions SET verify_status = NULL, verify_output = NULL, verify_ran_at = NULL WHERE verify_status = 'running'`
    ).run();
  }
  for (const s of curr) {
    const decision = decideSessionVerify({
      prevStatus: prevStatusById.get(s.id),
      currStatus: s.status,
      hasPrompt: !!s.prompt,
    });
    if (decision === "none") continue;
    // One verify per session at a time (a boundary while a build is already
    // running for this session is dropped — the verdict lands turn-late, and
    // the NEXT boundary re-triggers).
    if (decision === "run" && sessionVerifyInFlight.has(s.id)) continue;

    const session = queries.getSession(db).get(s.id) as Session | undefined;
    if (!session) continue;

    if (decision === "clear") {
      if (session.verify_status != null) {
        queries.clearSessionVerify(db).run(s.id);
      }
      continue;
    }

    // decision === "run" — resolve the project's verify command (the opt-in:
    // no command → no badge, no cost).
    const project = session.project_id
      ? (queries.getProject(db).get(session.project_id) as Project | undefined)
      : undefined;
    const command = project?.verify_command?.trim();
    if (!command) continue;
    if (sessionVerifyInFlight.size >= VERIFY_MAX_CONCURRENT) continue;

    const cwd = expandHome(session.worktree_path || session.working_directory);
    sessionVerifyInFlight.add(s.id);
    queries.setSessionVerifyRunning(db).run(s.id);
    runInBackground(async () => {
      try {
        const r = await runVerify(cwd, command);
        queries
          .setSessionVerifyResult(db)
          .run(r.status, r.output || null, s.id);
      } catch (err) {
        // runVerify never throws, but stay fail-safe: record an error verdict.
        queries
          .setSessionVerifyResult(db)
          .run("error", String(err).slice(-2000), s.id);
      } finally {
        sessionVerifyInFlight.delete(s.id);
      }
    }, `session-verify-${s.id}`);
  }
  prevStatusById = new Map(curr.map((s) => [s.id, s.status]));
}
