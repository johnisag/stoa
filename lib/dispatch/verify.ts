/**
 * Dispatch — the verification harness (opt-in per repo).
 *
 * When a repo arms `verify_gate` with a `verify_command`, the reconciler runs that
 * command (typecheck/test/build) IN the worker's PR worktree and attaches the
 * result to the review card — so approvals are made from EVIDENCE, not by reading
 * code — and (when armed) gates auto-merge on a local pass. It especially fills the
 * gap for repos with NO GitHub CI, where `summarizePrChecks` returns "none" and a
 * PR merges today with zero pre-merge test evidence.
 *
 * SAFETY of running an operator-configured command cross-platform, no shell:
 *   - The command is split on a literal `&&` — STOA's OWN step delimiter, never a
 *     shell's. Each step is tokenized (whitespace + double-quotes) and REJECTED
 *     pre-exec if it contains any other shell metacharacter. No shell string ever
 *     reaches a process (the AGENTS.md rule, made literal).
 *   - `resolveBinary(argv[0])` + Windows `.cmd`/`.bat` routing through `cmd.exe /c`
 *     (npm/npx/tsc are `.cmd` shims: a bare name ENOENTs and a full `.cmd` path
 *     EINVALs under execFile since the CVE-2024-27980 hardening — see spawnArgs).
 *     `execFile` with `shell:false`; SIGKILL on timeout; output bounded to ~8KB.
 *   - It runs FIRE-AND-FORGET off the 60s reconcile tick (a build is slow), verifies
 *     each head exactly once (per-SHA guard), and a pass is SHA-pinned so a stale
 *     verdict can never greenlight a newer push.
 *
 * The parser and process runner live in the shared verification module; this
 * file retains Dispatch's SHA-pinned scheduling and compatibility exports.
 */

import { getDb, queries, type Session } from "../db";
import { getSessionBackend } from "../session-backend";
import { expandHome } from "../platform";
import { runInBackground } from "../async-operations";
import { runVerify, VERIFY_OUTPUT_TAIL_MAX } from "../verification/runner";
import { getPrReadiness } from "./auto-merge";
import type { DispatchRepo, IssueDispatch } from "./types";

export {
  parseVerifySteps,
  runVerify,
  spawnArgs,
  summarizeVerifyExit,
  VERIFY_TIMEOUT_MS,
} from "../verification/runner";
export type { VerifyResult, VerifyStatus } from "../verification/runner";

/** Max builds running at once. Verify is the first pass whose cost is LOCAL CPU
 * (the fixer/critic passes are API-bound), so it needs a cap the others don't —
 * else N open PRs launch N simultaneous installs/builds on the operator's machine.
 * A skipped row is picked up on a later tick (its action stays "run"). */
export const VERIFY_MAX_CONCURRENT = (() => {
  const raw = process.env.STOA_VERIFY_MAX_CONCURRENT;
  if (raw == null) return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
})();

export type VerifyAction = "run" | "wait" | "idle";

/**
 * Pure decision for one open PR this tick. Unit-tested.
 *   idle — not armed / not a live PR / head SHA unknown (gh failed) / already
 *          verified THIS head (terminal verdict for the same SHA)
 *   wait — a verify is in-flight, or a fixer is mid-push (verifying a half-pushed
 *          tree is noise)
 *   run  — fresh row, the head MOVED (a fixer pushed), or a 'running' row with no
 *          in-flight build (crash recovery — a restart lost the in-flight set, so
 *          re-launch once instead of wedging the PR's auto-merge forever)
 * A pass is recorded only against the exact reviewed SHA, so a stale verdict can't
 * greenlight a newer push.
 */
export function nextVerifyAction(input: {
  verifyGate: boolean;
  status: string;
  prNumber: number | null;
  headSha: string | null;
  verifyStatus: string | null;
  verifySha: string | null;
  inFlight: boolean;
  fixerAlive: boolean;
}): VerifyAction {
  if (
    !input.verifyGate ||
    input.status !== "pr_open" ||
    input.prNumber == null
  ) {
    return "idle";
  }
  if (input.headSha == null) return "idle"; // never verify against an unknown SHA
  if (input.inFlight) return "wait";
  if (input.fixerAlive) return "wait";
  const terminal =
    input.verifyStatus === "pass" ||
    input.verifyStatus === "fail" ||
    input.verifyStatus === "error";
  if (input.verifySha === input.headSha && terminal) return "idle";
  return "run"; // fresh / head moved / stale 'running' (crash recovery)
}

const MAX_TAIL = VERIFY_OUTPUT_TAIL_MAX;

// In-flight verify launches, keyed by dispatch id. Module-level is safe: the
// reconciler is single-process and tickBusy-serialized (same assumption the
// ci-fix/merge-train round guards make). A restart clears it — the crash-recovery
// rule in nextVerifyAction (running + not-in-flight → run) re-launches once.
const verifyInFlight = new Set<string>();

/**
 * Verify pass: for every open PR whose repo armed `verify_gate`, launch the verify
 * command in the worktree when its head hasn't been verified yet. A no-op for
 * non-armed repos (the common case). The slow build runs FIRE-AND-FORGET via
 * runInBackground so it never holds the reconcile tick; status='running' + the SHA
 * are written synchronously up front. Runs after the merge train, before auto-merge.
 */
export async function verifyPass(): Promise<void> {
  const db = getDb();
  const prOpen = queries.listPrOpen(db).all() as IssueDispatch[];
  if (prOpen.length === 0) return;

  let liveNames: Set<string>;
  try {
    liveNames = new Set(await getSessionBackend().list());
  } catch {
    liveNames = new Set();
  }
  const isAlive = (sessionId: string | null): boolean => {
    if (!sessionId) return false;
    const s = queries.getSession(db).get(sessionId) as Session | undefined;
    return !!s && liveNames.has(s.tmux_name);
  };

  for (const d of prOpen) {
    if (d.pr_number == null || !d.worktree_path) continue;
    // Armed == gate on AND a command set (matches autoMergePass / listInboxItems).
    const repo = queries.getDispatchRepo(db).get(d.repo_id) as
      DispatchRepo | undefined;
    if (!repo || repo.verify_gate !== 1 || !repo.verify_command) continue;

    // Our own verify already running for this row → the gh call is pointless (we
    // pinned the head); skip it (mirrors ci-fix/merge-train skipping the gh call).
    if (verifyInFlight.has(d.id)) continue;

    const fixerAlive =
      isAlive(d.fixer_session_id) ||
      isAlive(d.ci_fixer_session_id) ||
      isAlive(d.rebase_fixer_session_id);
    const cwd = expandHome(d.worktree_path);
    // The PR-state read is repo-explicit from the stable checkout; the verify
    // COMMAND below still runs in the worktree (it needs the tree).
    const { headRefOid } = await getPrReadiness(
      expandHome(repo.repo_path),
      d.pr_number,
      repo.repo_slug
    );

    // The head MOVED off the verdict's SHA (a fixer pushed) → clear the now-stale
    // verdict so the board/inbox stop showing a 'pass'/'fail' for a head that's
    // gone, and the inbox stops offering a one-tap Merge on it — even while the
    // fixer is still running (so we do NOT skip the gh call on fixerAlive).
    const terminal =
      d.verify_status === "pass" ||
      d.verify_status === "fail" ||
      d.verify_status === "error";
    if (terminal && headRefOid && d.verify_sha && d.verify_sha !== headRefOid) {
      queries.clearVerify(db).run(d.id);
    }

    const action = nextVerifyAction({
      verifyGate: true,
      status: d.status,
      prNumber: d.pr_number,
      headSha: headRefOid,
      verifyStatus: d.verify_status,
      verifySha: d.verify_sha,
      inFlight: false, // guarded above
      fixerAlive,
    });
    if (action !== "run") continue; // wait / idle → nothing to launch this tick

    // Concurrency cap: a build is local CPU — don't launch a new one when the cap's
    // worth are already running. The skipped row stays action "run" for a later tick.
    if (verifyInFlight.size >= VERIFY_MAX_CONCURRENT) break;

    // Record running + pin the SHA SYNCHRONOUSLY (UI shows "verifying…", the
    // once-guard holds across a restart), then launch the build OFF the tick.
    verifyInFlight.add(d.id);
    queries.setVerifyRunning(db).run(headRefOid, d.id);
    const command = repo.verify_command;
    runInBackground(async () => {
      try {
        const r = await runVerify(cwd, command);
        queries.setVerifyResult(db).run(r.status, r.output, headRefOid, d.id);
      } catch (err) {
        queries
          .setVerifyResult(db)
          .run("error", String(err).slice(-MAX_TAIL), headRefOid, d.id);
      } finally {
        verifyInFlight.delete(d.id);
      }
    }, `verify-${d.id}`);
  }
}
