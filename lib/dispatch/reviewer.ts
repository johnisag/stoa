/**
 * Dispatch — reviewer gate (opt-in).
 *
 * When a repo has `review_gate` on, each worker's PR gets an INDEPENDENT critic
 * agent spawned in the worker's worktree. The critic reviews across three lenses
 * and posts ONE GitHub PR review (approve / request-changes). Stoa reads the
 * resulting `reviewDecision` and surfaces it in the cockpit (advisory — merge
 * stays the user's tap). Pure helpers (shouldSpawnReviewer / parseReviewDecision
 * / buildReviewPrompt) are unit-tested; the spawn + gh reads are I/O.
 */

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDb, queries } from "../db";
import { resolveModelForAgent } from "../model-catalog";
import { getProvider, buildAgentArgs, shellQuoteArg } from "../providers";
import { sessionKey } from "../providers/registry";
import { wrapWithBanner } from "../banner";
import { getSessionBackend } from "../session-backend";
import { resolveBinary, expandHome } from "../platform";
import type { DispatchRepo, IssueDispatch } from "./types";

const execFileAsync = promisify(execFile);
const gh = resolveBinary("gh") || "gh";

/**
 * Whether a row should get a critic spawned now: the gate is on, the PR exists,
 * and we haven't already spawned one. Pure (unit-tested).
 */
export function shouldSpawnReviewer(
  repo: Pick<DispatchRepo, "review_gate">,
  d: Pick<IssueDispatch, "status" | "pr_number" | "reviewer_session_id">
): boolean {
  return (
    repo.review_gate === 1 &&
    d.status === "pr_open" &&
    d.pr_number != null &&
    !d.reviewer_session_id
  );
}

/** Parse `gh pr view --json reviewDecision` → the decision string, or null. */
export function parseReviewDecision(rawJson: string): string | null {
  try {
    const parsed = JSON.parse(rawJson) as { reviewDecision?: unknown };
    const dec = parsed?.reviewDecision;
    return typeof dec === "string" && dec ? dec : null;
  } catch {
    return null;
  }
}

/** Read the current GitHub review decision for a PR (null on any failure). */
export async function getReviewDecision(
  cwd: string,
  prNumber: number
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      gh,
      ["pr", "view", String(prNumber), "--json", "reviewDecision"],
      { cwd, encoding: "utf-8", timeout: 15000 }
    );
    return parseReviewDecision(stdout);
  } catch {
    return null;
  }
}

/** The critic's brief: read-only review across three lenses, ending in exactly
 * one GitHub PR review. Pure (unit-tested for the key instructions). */
export function buildReviewPrompt(
  repo: DispatchRepo,
  d: IssueDispatch
): string {
  return (
    `[Stoa] You are an INDEPENDENT REVIEWER for pull request #${d.pr_number} in ` +
    `${repo.repo_slug} (it resolves issue #${d.issue_number}: ` +
    `"${d.issue_title ?? ""}").\n\n` +
    `Review ONLY — do NOT modify code, commit, or push anything.\n\n` +
    `1. Read the change and the issue:\n` +
    `   gh pr diff ${d.pr_number}\n` +
    `   gh issue view ${d.issue_number} --repo ${repo.repo_slug}\n` +
    `2. Review across three independent lenses: (a) correctness & security, ` +
    `(b) conventions & cross-platform, (c) simplicity & scope. Confirm it ` +
    `actually resolves the issue and adds no regressions.\n` +
    `3. Post EXACTLY ONE verdict as a GitHub review:\n` +
    `   - Solid:       gh pr review ${d.pr_number} --approve --body "<short why>"\n` +
    `   - Needs work:  gh pr review ${d.pr_number} --request-changes ` +
    `--body "<numbered, specific, actionable findings>"\n\n` +
    `Be concrete and terse. Do not open new PRs.`
  );
}

/** Max worker fix rounds before a PR is left for a human (env-overridable;
 * `STOA_MAX_FIX_ROUNDS=0` validly disables the fixer, leaving critic-only). */
export const MAX_FIX_ROUNDS = (() => {
  const raw = process.env.STOA_MAX_FIX_ROUNDS;
  if (raw == null) return 2;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 2;
})();

export type ReviewAction =
  | "spawn_critic"
  | "spawn_fixer"
  | "rereview"
  | "wait"
  | "approved"
  | "stuck"
  | "idle";

/**
 * Pure state machine for the review/fix loop on one open PR. Unit-tested.
 *   no critic yet            → spawn_critic
 *   critic: APPROVED         → approved (ready to merge)
 *   critic: CHANGES_REQUESTED → spawn_fixer (under cap) else stuck (needs human)
 *   fixer running            → wait
 *   fixer finished           → rereview (clear + re-spawn a fresh critic)
 */
export function nextReviewAction(input: {
  reviewGate: boolean;
  status: string;
  prNumber: number | null;
  reviewerSessionId: string | null;
  reviewDecision: string | null;
  fixerSessionId: string | null;
  fixerAlive: boolean;
  fixRounds: number;
  maxFixRounds: number;
}): ReviewAction {
  if (
    !input.reviewGate ||
    input.status !== "pr_open" ||
    input.prNumber == null
  ) {
    return "idle";
  }
  if (input.fixerSessionId && input.fixerAlive) return "wait";
  if (input.fixerSessionId && !input.fixerAlive) return "rereview";
  if (!input.reviewerSessionId) return "spawn_critic";
  if (input.reviewDecision === "APPROVED") return "approved";
  if (input.reviewDecision === "CHANGES_REQUESTED") {
    return input.fixRounds < input.maxFixRounds ? "spawn_fixer" : "stuck";
  }
  return "idle"; // pending / unknown — keep polling the decision
}

/** The fixer's brief: address the review feedback and push to the SAME branch
 * (updates the existing PR — no new PR). Pure (unit-tested). */
export function buildFixPrompt(repo: DispatchRepo, d: IssueDispatch): string {
  return (
    `[Stoa] A reviewer requested changes on pull request #${d.pr_number} in ` +
    `${repo.repo_slug} (issue #${d.issue_number}: "${d.issue_title ?? ""}").\n\n` +
    `You are in the PR's worktree.\n\n` +
    `1. Read the feedback and the diff:\n` +
    `   gh pr view ${d.pr_number} --comments\n` +
    `   gh pr diff ${d.pr_number}\n` +
    `2. Implement the requested changes, commit them, and PUSH to the SAME ` +
    `branch (git push). Do NOT open a new PR — pushing updates PR #${d.pr_number}.\n` +
    `3. Keep the changes scoped to the feedback.`
  );
}

/**
 * Spawn an agent in the worker's existing worktree (no new worktree). Records
 * the session id on the dispatch row via `onSpawn` BEFORE the backend create, so
 * the spawn-once guard holds even if create throws. Returns the session id or
 * null on failure. autoApprove so the agent runs gh/git unattended (prompt-
 * bounded; the inherent opt-in risk).
 */
async function spawnInWorktree(
  repo: DispatchRepo,
  d: IssueDispatch,
  sessionName: string,
  prompt: string,
  onSpawn: (sessionId: string) => void
): Promise<string | null> {
  if (!d.worktree_path) return null;
  try {
    const db = getDb();
    const provider = getProvider(repo.agent_type);
    const model = resolveModelForAgent(repo.agent_type, undefined);
    const cwd = expandHome(d.worktree_path);
    const sessionId = randomUUID();
    const tmuxName = sessionKey({
      kind: "agent",
      provider: provider.id,
      id: sessionId,
    });
    queries
      .createSession(db)
      .run(
        sessionId,
        sessionName,
        tmuxName,
        cwd,
        null,
        model,
        null,
        "sessions",
        repo.agent_type,
        1,
        repo.project_id ?? "uncategorized"
      );
    // Persist worktree/branch on the session row (consistency with dispatcher)
    // so reviewer/fixer sessions are complete for diff/branch lookups.
    queries
      .updateSessionWorktree(db)
      .run(cwd, d.branch_name, repo.base_branch, null, sessionId);
    onSpawn(sessionId); // record id BEFORE create (spawn-once)
    const { binary, args } = buildAgentArgs(repo.agent_type, {
      model,
      autoApprove: true,
      initialPrompt: prompt,
    });
    const command = wrapWithBanner(
      [binary, ...args.map(shellQuoteArg)].join(" ")
    );
    await getSessionBackend().create({
      name: tmuxName,
      cwd,
      command,
      binary,
      args,
    });
    return sessionId;
  } catch (err) {
    console.error(
      `spawn (${sessionName}) failed for ${repo.repo_slug}#${d.issue_number}:`,
      err
    );
    return null;
  }
}

/** Spawn the critic that reviews the PR (records reviewer_session_id). */
export async function spawnReviewer(
  repo: DispatchRepo,
  d: IssueDispatch
): Promise<string | null> {
  if (d.pr_number == null) return null;
  return spawnInWorktree(
    repo,
    d,
    `review #${d.pr_number}`,
    buildReviewPrompt(repo, d),
    (sid) => queries.setDispatchReviewer(getDb()).run(sid, d.id)
  );
}

/** Spawn a fixer that addresses review feedback (records fixer + bumps round). */
export async function spawnFixer(
  repo: DispatchRepo,
  d: IssueDispatch
): Promise<string | null> {
  if (d.pr_number == null) return null;
  return spawnInWorktree(
    repo,
    d,
    `fix #${d.pr_number}`,
    buildFixPrompt(repo, d),
    (sid) => queries.startFixRound(getDb()).run(sid, d.id)
  );
}
