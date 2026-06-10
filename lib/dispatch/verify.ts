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
 *   - `resolveBinary(argv[0])` is mandatory (npm/npx/tsc are `.cmd` shims on Windows
 *     that ENOENT under execFile with a bare name); `execFile` with `shell:false`;
 *     SIGKILL on timeout; output bounded to an ~8KB tail before persist.
 *   - It runs FIRE-AND-FORGET off the 60s reconcile tick (a build is slow), verifies
 *     each head exactly once (per-SHA guard), and a pass is SHA-pinned so a stale
 *     verdict can never greenlight a newer push.
 *
 * Pure helpers (parseVerifySteps / summarizeVerifyExit / nextVerifyAction) are
 * unit-tested; runVerify + verifyPass do the I/O. Mirrors the ci-fix/merge-train
 * pass anatomy.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { getDb, queries, type Session } from "../db";
import { getSessionBackend } from "../session-backend";
import { resolveBinary, expandHome } from "../platform";
import { runInBackground } from "../async-operations";
import { getPrReadiness } from "./auto-merge";
import type { DispatchRepo, IssueDispatch } from "./types";

const execFileAsync = promisify(execFile);

/** Hard ceiling for a single verify run before it's SIGKILLed (env-overridable). A
 * watch-mode build that never exits is the failure this prevents (→ status error). */
export const STOA_VERIFY_TIMEOUT_MS = (() => {
  const raw = process.env.STOA_VERIFY_TIMEOUT_MS;
  if (raw == null) return 600_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600_000;
})();

export type VerifyStatus = "running" | "pass" | "fail" | "error";

// Shell metacharacters that must NEVER reach a process unquoted. `&&` is consumed
// by the step split before this runs, so a lone `&` here is a malformed operator.
const SHELL_METACHARS = "|&;<>`$(){}";

/**
 * Tokenize one verify step: whitespace-separated, with double-quote grouping
 * ("a b" → one token). Returns the tokens, or { error } if the step contains a
 * shell metacharacter outside quotes (so no shell string is ever executed). Pure.
 */
function tokenizeStep(step: string): string[] | { error: string } {
  const tokens: string[] = [];
  let cur = "";
  let inQuote = false;
  let building = false;
  for (const ch of step) {
    if (ch === '"') {
      inQuote = !inQuote;
      building = true;
      continue;
    }
    if (!inQuote) {
      if (ch === "\n" || ch === "\r") {
        return { error: "a newline is not allowed in a verify step" };
      }
      if (SHELL_METACHARS.includes(ch)) {
        return {
          error: `shell operators are not allowed (found "${ch}"); chain steps with && and quote args`,
        };
      }
      if (ch === " " || ch === "\t") {
        if (building) {
          tokens.push(cur);
          cur = "";
          building = false;
        }
        continue;
      }
    }
    cur += ch;
    building = true;
  }
  if (inQuote) return { error: "unterminated quote in the verify command" };
  if (building) tokens.push(cur);
  return tokens;
}

/**
 * Parse a verify_command into a list of argv steps. Steps are chained with a
 * literal `&&` (Stoa's delimiter); each is argv-tokenized and shell-operator-
 * rejected. Returns { steps } or { error }. Pure → unit-tested (the safety story
 * rests on this).
 */
export function parseVerifySteps(
  command: string
): { steps: string[][] } | { error: string } {
  if (!command || !command.trim()) {
    return { error: "the verify command is empty" };
  }
  const steps: string[][] = [];
  for (const raw of command.split("&&")) {
    const tokens = tokenizeStep(raw);
    if (!Array.isArray(tokens)) return tokens; // { error }
    if (tokens.length === 0) {
      return { error: "an empty step (check the && placement)" };
    }
    steps.push(tokens);
  }
  return { steps };
}

/**
 * Map one step's process outcome to a verdict. Pure → unit-tested.
 *   exit 0            → pass
 *   non-zero exit     → fail (the code under test is broken)
 *   timeout (killed)  → error (couldn't get a verdict)
 *   spawn error (str) → error (ENOENT / bad binary)
 */
export function summarizeVerifyExit(info: {
  ok: boolean;
  code: number | string | null;
  killed: boolean;
}): VerifyStatus {
  if (info.ok) return "pass";
  if (info.killed) return "error";
  if (typeof info.code === "string") return "error";
  return "fail";
}

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

const MAX_TAIL = 8000;
const tail = (s: string) =>
  s.length > MAX_TAIL ? "…(truncated)…\n" + s.slice(-MAX_TAIL) : s;

export interface VerifyResult {
  status: VerifyStatus;
  output: string;
}

/**
 * Run the verify command in `cwd`, step by step, no shell. Returns the verdict +
 * a bounded output tail of the FAILING step (empty on pass). Never throws — every
 * failure mode maps to fail/error. I/O; the parsing/summarizing are pure + tested.
 */
export async function runVerify(
  cwd: string,
  command: string
): Promise<VerifyResult> {
  const parsed = parseVerifySteps(command);
  if (!("steps" in parsed)) return { status: "error", output: parsed.error };

  for (const step of parsed.steps) {
    const bin = resolveBinary(step[0]);
    if (!bin) {
      return { status: "error", output: `verify binary not found: ${step[0]}` };
    }
    try {
      await execFileAsync(bin, step.slice(1), {
        cwd,
        encoding: "utf-8",
        timeout: STOA_VERIFY_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, CI: "1" }, // non-interactive test runners
      });
    } catch (err) {
      const e = err as {
        code?: number | string | null;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      const status = summarizeVerifyExit({
        ok: false,
        code: e.code ?? null,
        killed: !!e.killed,
      });
      const why = e.killed
        ? `timed out after ${Math.round(STOA_VERIFY_TIMEOUT_MS / 1000)}s`
        : typeof e.code === "string"
          ? `spawn error: ${e.code}`
          : `exit ${e.code}`;
      const body = (e.stdout ?? "") + (e.stderr ?? "");
      return {
        status,
        output: `$ ${step.join(" ")}\n[${why}]\n${tail(body)}`.trim(),
      };
    }
  }
  return { status: "pass", output: "" };
}

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
    const repo = queries.getDispatchRepo(db).get(d.repo_id) as
      | DispatchRepo
      | undefined;
    if (!repo || repo.verify_gate !== 1 || !repo.verify_command) continue;

    const fixerAlive =
      isAlive(d.fixer_session_id) ||
      isAlive(d.ci_fixer_session_id) ||
      isAlive(d.rebase_fixer_session_id);
    const cwd = expandHome(d.worktree_path);
    const { headRefOid } = await getPrReadiness(cwd, d.pr_number);
    const action = nextVerifyAction({
      verifyGate: true,
      status: d.status,
      prNumber: d.pr_number,
      headSha: headRefOid,
      verifyStatus: d.verify_status,
      verifySha: d.verify_sha,
      inFlight: verifyInFlight.has(d.id),
      fixerAlive,
    });
    if (action !== "run") continue; // wait / idle → nothing to launch this tick

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
