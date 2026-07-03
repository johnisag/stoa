/**
 * Best-of-N — core library module.
 *
 * Runs N Claude sessions in parallel, each in an isolated git worktree, on the
 * same task. After all sessions finish, the user compares their diffs and picks
 * a winner. The losing sessions and worktrees are cleaned up.
 *
 * All DB mutations go through the prepared-statement helpers in lib/db/queries/.
 * All session/worktree operations go through the existing orchestration seams
 * (spawnWorker / killWorker) so the tmux/pty/Windows paths stay consistent.
 */

import { randomUUID } from "crypto";
import { db, queries } from "./db";
import type { BestOfNRun, BestOfNCandidate, Session } from "./db";
import { spawnWorker } from "./orchestration";
import { killWorker } from "./orchestration";
import { getSessionDiff } from "./session-diff";
import { runInBackground } from "./async-operations";

export { BestOfNRun, BestOfNCandidate };

export const BON_N_MIN = 2;
export const BON_N_MAX = 3;

export interface CreateBonRunOptions {
  task: string;
  n: number;
  projectId: string;
  baseBranch?: string;
  /** The Stoa session that triggered this run (used as the conductor). */
  conductorSessionId: string;
  workingDirectory: string;
}

export interface BonRunWithCandidates {
  run: BestOfNRun;
  candidates: BestOfNCandidateWithStatus[];
}

export interface BestOfNCandidateWithStatus extends BestOfNCandidate {
  worker_status: string | null;
  session_status: string | null;
}

/**
 * Create a new Best-of-N run: insert the run + candidate rows, spawn N worker
 * sessions in parallel (each with its own isolated worktree), then kick off a
 * background watcher that captures per-candidate diffs once workers finish.
 *
 * Fail-closed: if ANY worker fails to spawn, all already-spawned workers are
 * killed and the run is marked failed.
 */
export async function createBonRun(
  opts: CreateBonRunOptions
): Promise<BonRunWithCandidates> {
  const { task, n, projectId, conductorSessionId, workingDirectory } = opts;
  const baseBranch = opts.baseBranch?.trim() || "main";

  if (n < BON_N_MIN || n > BON_N_MAX || !Number.isInteger(n)) {
    throw new Error(
      `n must be an integer between ${BON_N_MIN} and ${BON_N_MAX}`
    );
  }

  const runId = randomUUID();

  // Insert the run row.
  queries.createBonRun(db).run(runId, task, baseBranch, n, projectId);

  // Spawn N workers in parallel. Track what was successfully created so we can
  // roll back on a partial failure.
  const spawnedSessions: Session[] = [];
  let spawnError: unknown = null;

  // Attempt all spawns.
  const spawnResults = await Promise.allSettled(
    Array.from({ length: n }, (_, i) =>
      spawnWorker({
        conductorSessionId,
        task,
        workingDirectory,
        // Each branch name is unique: bon-<runId-prefix>-<index>
        branchName: `bon-${runId.slice(0, 8)}-${i}`,
        useWorktree: true,
        agentType: "claude",
      })
    )
  );

  for (const result of spawnResults) {
    if (result.status === "fulfilled") {
      spawnedSessions.push(result.value);
    } else {
      spawnError = result.reason;
    }
  }

  if (spawnError || spawnedSessions.length !== n) {
    // Roll back: kill all successfully-spawned workers.
    await Promise.allSettled(
      spawnedSessions.map((s) => killWorker(s.id, true, "failed"))
    );
    // Mark run failed.
    queries.updateBonRunStatus(db).run("failed", null, runId);
    throw new Error(
      `Best-of-N spawn failed (${spawnedSessions.length}/${n} started): ${
        spawnError instanceof Error ? spawnError.message : String(spawnError)
      }`
    );
  }

  // Insert candidate rows.
  for (let i = 0; i < spawnedSessions.length; i++) {
    const session = spawnedSessions[i];
    const candidateId = randomUUID();
    queries.createBonCandidate(db).run(
      candidateId,
      runId,
      session.id,
      session.worktree_path ?? null,
      session.branch_name ?? null,
      i // candidate_index (0-based)
    );
  }

  // Start a background watcher that polls until all workers are terminal, then
  // captures the diff for each candidate.
  runInBackground(
    () => watchAndCaptureDiffs(runId, baseBranch),
    `bon-diff-watcher-${runId}`
  );

  return getBonRunStatus(runId);
}

/**
 * Background watcher: polls worker statuses every 3 s until all N candidates
 * are in a terminal state (completed or failed), then captures git diffs.
 *
 * This intentionally does NOT mark the run as done — that is reserved for
 * pickBonWinner. It only captures diffs so the compare view can render.
 */
async function watchAndCaptureDiffs(
  runId: string,
  baseBranch: string
): Promise<void> {
  const POLL_INTERVAL_MS = 3000;
  const MAX_WAIT_MS = 60 * 60 * 1000; // 1 hour
  const start = Date.now();

  for (;;) {
    if (Date.now() - start > MAX_WAIT_MS) {
      console.warn(`[best-of-n] diff watcher timed out for run ${runId}`);
      break;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    // Re-read candidates each poll so we see diff updates already written.
    const candidates = queries
      .getBonCandidatesByRun(db)
      .all(runId) as BestOfNCandidateWithStatus[];

    if (candidates.length === 0) break;

    // Check if all candidates are terminal.
    const allTerminal = candidates.every(
      (c) =>
        c.worker_status === "completed" ||
        c.worker_status === "failed" ||
        c.session_status === "error" ||
        // session gone (null) also counts as terminal
        c.session_id === null
    );

    if (!allTerminal) continue;

    // All terminal: capture diffs for any candidate that doesn't have one yet.
    for (const candidate of candidates) {
      if (candidate.diff !== null) continue; // already captured
      if (!candidate.worktree_path) continue; // no worktree to diff

      try {
        const { diff } = await getSessionDiff({
          cwd: candidate.worktree_path,
          baseBranch,
        });
        queries.updateBonCandidateDiff(db).run(diff, candidate.id);
      } catch (err) {
        console.error(
          `[best-of-n] diff capture failed for candidate ${candidate.id}:`,
          err
        );
        // Write an empty string so we don't keep retrying.
        queries.updateBonCandidateDiff(db).run("", candidate.id);
      }
    }

    break; // Done — all terminal, diffs captured.
  }
}

/**
 * Return the current state of a run, with all candidates and their live
 * session statuses joined in.
 */
export function getBonRunStatus(runId: string): BonRunWithCandidates {
  const run = queries.getBonRun(db).get(runId) as BestOfNRun | undefined;
  if (!run) throw new Error(`Best-of-N run not found: ${runId}`);

  const candidates = queries
    .getBonCandidatesByRun(db)
    .all(runId) as BestOfNCandidateWithStatus[];

  return { run, candidates };
}

/**
 * List recent Best-of-N runs, optionally filtered by project.
 */
export function listBonRuns(projectId?: string): BestOfNRun[] {
  if (projectId) {
    return queries.listBonRunsByProject(db).all(projectId) as BestOfNRun[];
  }
  return queries.listBonRuns(db).all() as BestOfNRun[];
}

/**
 * Pick a winner: mark it, kill + delete worktrees of all other candidates,
 * and mark the run as done.
 *
 * Returns the updated run state.
 */
export async function pickBonWinner(
  runId: string,
  candidateId: string
): Promise<BonRunWithCandidates> {
  const run = queries.getBonRun(db).get(runId) as BestOfNRun | undefined;
  if (!run) throw new Error(`Best-of-N run not found: ${runId}`);

  if (run.status === "failed" || run.status === "done") {
    throw new Error("Cannot pick a winner for a run that is already terminal");
  }

  const candidates = queries
    .getBonCandidatesByRun(db)
    .all(runId) as BestOfNCandidateWithStatus[];

  const winner = candidates.find((c) => c.id === candidateId);
  if (!winner) {
    throw new Error(`Candidate ${candidateId} not found in run ${runId}`);
  }

  const winnerSessionId = winner.session_id;

  // Mark the winner and update run status in a single atomic transaction so
  // the DB is never left in an inconsistent state if the process is killed
  // between the two writes.
  db.transaction(() => {
    queries.markBonWinner(db).run(candidateId, runId);
    queries.updateBonRunStatus(db).run("done", winnerSessionId ?? null, runId);
  })();

  // Kill and clean up all non-winner candidates (async, after the DB is
  // already in a consistent terminal state).
  const losers = candidates.filter((c) => c.id !== candidateId);
  await Promise.allSettled(
    losers.map((c) => {
      if (!c.session_id) return Promise.resolve();
      return killWorker(c.session_id, true /* cleanupWorktree */, "failed");
    })
  );

  return getBonRunStatus(runId);
}

/**
 * Cancel a running Best-of-N run: kill all candidates and mark the run failed.
 */
export async function cancelBonRun(runId: string): Promise<void> {
  const run = queries.getBonRun(db).get(runId) as BestOfNRun | undefined;
  if (!run) throw new Error(`Best-of-N run not found: ${runId}`);

  if (run.status !== "running") return; // already terminal, nothing to do

  const candidates = queries
    .getBonCandidatesByRun(db)
    .all(runId) as BestOfNCandidateWithStatus[];

  await Promise.allSettled(
    candidates.map((c) => {
      if (!c.session_id) return Promise.resolve();
      return killWorker(c.session_id, true /* cleanupWorktree */, "failed");
    })
  );

  queries.updateBonRunStatus(db).run("failed", null, runId);
}
