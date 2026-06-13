/**
 * Agent pipelines — default (real) executor deps.
 *
 * Wires the injected ExecutorDeps to the real Stoa seams: spawnWorker for
 * launching a step's worker, and statusDetector for polling its outcome. Kept
 * SEPARATE from executor.ts so the executor's orchestration loop can be unit-
 * tested with fakes and never drags lib/orchestration (which pulls better-
 * sqlite3 + the session backend) into the test process.
 *
 * Outcome mapping (v1, deliberately conservative): a step is `failed` when its
 * session is dead or shows a structured error; it `succeeded` only after we've
 * observed it actually WORKING (a `running` status) and THEN going `idle` — a
 * freshly spawned agent can briefly read `idle` at its prompt before the turn
 * starts, so treating the first `idle` as success would green-light a step that
 * did nothing. Richer, truth-grounded outcomes (did the worker open/merge a
 * PR?) are a tracked follow-up that builds on the merge-signal reconciliation —
 * see docs/ROADMAP.md.
 */

import path from "path";
import { readFile } from "fs/promises";
import { spawnWorker, killWorker } from "../orchestration";
import { statusDetector } from "../status-detector";
import { getProvider } from "../providers";
import { sessionKey } from "../providers/registry";
import { db, queries, type Session } from "../db";
import { STOA_DEFAULT_OUTPUT_FILE } from "./engine";
import type { PipelineStep, PipelineSpec } from "./types";
import type { ExecutorDeps, StepOutcome, SpawnResult } from "./executor";

/**
 * Build the real executor deps for a given conductor session. The conductor is
 * the Stoa session that owns the pipeline run (workers FK to it).
 */
export function defaultExecutorDeps(conductorSessionId: string): ExecutorDeps {
  // Tracks which step sessions we've observed actively running, so we only
  // accept `idle` as success AFTER work was seen (avoids the spawn-time
  // idle-at-prompt false positive). Scoped per deps instance = per run.
  const seenRunning = new Set<string>();
  // The ONE workflow worktree shared by every `worktreePolicy:"shared"` step, and
  // the session that OWNS it (created it). A run with any shared step is serialized
  // (the executor clamps parallelism to 1), so the first shared step populates
  // these and the rest reuse it — no race. (If the first shared step's worktree
  // creation falls back to the source dir — worktree_path null — sharing silently
  // degrades to per-step worktrees; the run is still serialized, just not literally
  // one checkout. A rare misconfig, e.g. a non-git workingDirectory.)
  let sharedWorktreePath: string | null = null;
  let sharedWorktreeOwnerId: string | null = null;

  return {
    async spawn(step: PipelineStep, spec: PipelineSpec): Promise<SpawnResult> {
      // "shared" step reusing the established workflow worktree: spawn straight in
      // it (no new worktree), and carry that shared path so readOutput reads the
      // step's output file from there.
      if (step.worktreePolicy === "shared" && sharedWorktreePath) {
        const session = await spawnWorker({
          conductorSessionId,
          task: step.task,
          workingDirectory: sharedWorktreePath,
          agentType: step.agent,
          model: step.model,
          useWorktree: false,
        });
        return { sessionId: session.id, worktreePath: sharedWorktreePath };
      }
      const session = await spawnWorker({
        conductorSessionId,
        task: step.task,
        workingDirectory: step.workingDirectory || spec.workingDirectory,
        agentType: step.agent,
        model: step.model,
        useWorktree: true,
      });
      // First "shared" step: remember its worktree + owner so later shared steps
      // reuse it and so the reap never deletes it out from under them.
      if (step.worktreePolicy === "shared" && session.worktree_path) {
        sharedWorktreePath = session.worktree_path;
        sharedWorktreeOwnerId = session.id;
      }
      // Carry the worktree path so readOutput can read the step's output file
      // from it after the step succeeds. (DB row uses snake_case worktree_path;
      // it's null when the worktree fell back to the source dir.)
      return { sessionId: session.id, worktreePath: session.worktree_path };
    },

    async readOutput(result: SpawnResult, step: PipelineStep): Promise<string> {
      // The step's output is the contents of its output file inside the kept
      // worktree. No worktree (worktree creation fell back to the source dir, or
      // none requested) → no output. path.join keeps this cross-platform; the
      // file name is relative to the worktree root. Best-effort: any read error
      // (absent/unreadable file) yields "".
      if (!result.worktreePath) return "";
      const fileName = step.outputFile?.trim() || STOA_DEFAULT_OUTPUT_FILE;
      try {
        return await readFile(path.join(result.worktreePath, fileName), "utf8");
      } catch {
        return "";
      }
    },

    async checkOutcome(
      sessionId: string,
      _step: PipelineStep
    ): Promise<StepOutcome> {
      const session = queries.getSession(db).get(sessionId) as
        | Session
        | undefined;
      if (!session) return "failed";
      const provider = getProvider(session.agent_type || "claude");
      const key =
        session.tmux_name ||
        sessionKey({ kind: "agent", provider: provider.id, id: sessionId });

      let status: string;
      try {
        status = await statusDetector.getStatus(key);
      } catch {
        return "failed";
      }

      switch (status) {
        case "dead":
        case "error":
          return "failed";
        case "running":
          // Active work seen — remember it so a later idle counts as done.
          seenRunning.add(sessionId);
          return "running";
        case "idle":
          // Done only if we've previously seen it working; otherwise it's the
          // brief at-prompt idle right after spawn — keep waiting.
          return seenRunning.has(sessionId) ? "succeeded" : "running";
        // "waiting" (mid-turn prompt the worker's auto-approve will clear) is
        // still in flight.
        case "waiting":
        default:
          return "running";
      }
    },

    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),

    async terminate(
      sessionId: string,
      opts: { cleanupWorktree: boolean; succeeded: boolean }
    ): Promise<void> {
      // Tear down the worker once its run is terminal: always kill the pty/agent
      // process (pure leak otherwise); remove the worktree only when asked (the
      // executor keeps succeeded steps' worktrees for inspect/merge). Record the
      // worker's final DB status truthfully (completed for a succeeded step, else
      // failed) so a reaped-but-successful step isn't mislabeled "failed". Log on
      // failure so a silent leak is visible (killWorker itself swallows inner
      // errors, so this catch is belt-and-suspenders for an unexpected throw).
      // The shared worktree's OWNER must NEVER have its worktree reaped, even if
      // the owner step itself FAILED: other (independent) shared steps ran — and
      // may have SUCCEEDED — in that same worktree, so deleting it on the owner's
      // failure would destroy their work. Keep it (as a succeeded worktree is kept;
      // a fully-failed shared run keeping its worktree for inspection is fine).
      const cleanupWorktree =
        sessionId === sharedWorktreeOwnerId ? false : opts.cleanupWorktree;
      try {
        await killWorker(
          sessionId,
          cleanupWorktree,
          opts.succeeded ? "completed" : "failed"
        );
      } catch (err) {
        console.warn(
          `pipeline: failed to terminate worker ${sessionId} ` +
            `(cleanupWorktree=${opts.cleanupWorktree}):`,
          err instanceof Error ? err.message : err
        );
      }
    },
  };
}
