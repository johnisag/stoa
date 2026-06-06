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

/**
 * Spawn a critic agent in the worker's existing worktree to review its PR.
 * Returns the new reviewer session id (the caller records it), or null on
 * failure. Reuses the worker spawn recipe minus worktree creation.
 */
export async function spawnReviewer(
  repo: DispatchRepo,
  d: IssueDispatch
): Promise<string | null> {
  if (!d.worktree_path || d.pr_number == null) return null;
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
        `review #${d.pr_number}`,
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
    // Record the reviewer id BEFORE spawning so the spawn-once guard fires even
    // if the backend create throws — never spawn two critics on one PR.
    queries.setDispatchReviewer(db).run(sessionId, d.id);
    const prompt = buildReviewPrompt(repo, d);
    // autoApprove so the critic can run `gh pr diff/review` unattended. The prompt
    // bounds it to read-only + one review; tool access isn't hard-enforced, which
    // is the inherent (opt-in, default-off) risk of an unattended review agent.
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
      `reviewer spawn failed for ${repo.repo_slug}#${d.issue_number}:`,
      err
    );
    return null;
  }
}
