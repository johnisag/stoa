/**
 * Dispatch — spawn one agent worker for a GitHub issue.
 *
 * Mirrors the spawn recipe in lib/orchestration.ts BUT:
 *   - no conductor session (system-initiated → no conductor FK),
 *   - the issue is delivered as the agent's INITIAL PROMPT via argv
 *     (buildAgentArgs positional token) rather than keystroke injection, so it's
 *     reliable at launch.
 *
 * The agent is told to read the issue (`gh issue view`), implement a fix inside
 * its worktree, and open a PR (`gh pr create … Closes #N`). Stoa later detects
 * that PR by branch name (lib/pr.ts getPRForBranch, polled by the status ticker).
 */

import { randomUUID } from "crypto";
import { getDb, queries } from "../db";
import { createWorktree, deleteWorktree } from "../worktrees";
import { setupWorktree } from "../env-setup";
import { getLessonsBlock } from "./lessons";
import { resolveModelForAgent } from "../model-catalog";
import { getProvider, buildAgentArgs, shellQuoteArg } from "../providers";
import { sessionKey } from "../providers/registry";
import { wrapWithBanner } from "../banner";
import { runInBackground } from "../async-operations";
import { getSessionBackend } from "../session-backend";
import { expandHome } from "../platform";
import type { DispatchRepo, IssueDispatch } from "./types";

/** Seed prompt: worktree boundary note + issue/task context + "open a PR" house
 * rule. A local task (issueNumber <= 0, source='local') has no GitHub issue, so
 * the prompt carries the freeform body directly and drops the `gh issue view` /
 * `Closes #N` lines. */
export function buildIssuePrompt(
  repo: DispatchRepo,
  issueNumber: number,
  issueTitle: string,
  worktreePath: string,
  branchName: string,
  // Fleet memory: recent critic findings for this repo, pre-rendered (empty when
  // none). Pure here so it stays testable — the caller reads the ledger.
  lessonsBlock = "",
  // Freeform body for a local task (null for GitHub issues).
  taskBody: string | null = null
): string {
  const boundary =
    `[Stoa] You are working inside a git worktree at ${worktreePath} on branch ` +
    `"${branchName}". Make ALL file edits inside this directory — do not edit the ` +
    `base checkout or any other branch.\n\n`;

  // Local/freeform task: no GitHub issue to read or close.
  if (issueNumber <= 0) {
    const body = taskBody?.trim() ? `\n${taskBody.trim()}\n` : "";
    return (
      boundary +
      `You have been dispatched to complete this task in ${repo.repo_slug}: ` +
      `"${issueTitle}".\n` +
      body +
      `\n1. Implement a complete, focused change and commit it on this branch.\n` +
      `2. Open a pull request:\n` +
      `   gh pr create --base ${repo.base_branch} --head ${branchName} ` +
      `--title "<concise title>" --body "<what changed>"\n\n` +
      `Keep the change scoped to this task.` +
      lessonsBlock
    );
  }

  return (
    boundary +
    `You have been dispatched to resolve GitHub issue #${issueNumber} in ` +
    `${repo.repo_slug}: "${issueTitle}".\n\n` +
    `1. Read the full issue: gh issue view ${issueNumber} --repo ${repo.repo_slug}\n` +
    `2. Implement a complete, focused fix and commit it on this branch.\n` +
    `3. Open a pull request:\n` +
    `   gh pr create --base ${repo.base_branch} --head ${branchName} ` +
    `--title "<concise title>" --body "Closes #${issueNumber}. <what changed>"\n\n` +
    `Keep the change scoped to this one issue.` +
    lessonsBlock
  );
}

function issueToSessionName(issueNumber: number, issueTitle: string): string {
  // Local tasks have no issue number — show the bare title (no "#0").
  const base = (
    issueNumber > 0 ? `#${issueNumber} ${issueTitle}` : issueTitle
  ).trim();
  return base.length > 60 ? base.slice(0, 60) : base;
}

/**
 * Dispatch one pending candidate: atomically CLAIM it (so a concurrent
 * tick/approve can't double-spawn the same issue), then create a worktree,
 * insert a (conductor-free) session row, and spawn the agent with the issue as
 * its initial prompt. On any failure the row is marked `failed` (worktree cleaned
 * up) so it neither retries forever nor holds a concurrency slot.
 */
export async function dispatchOne(
  repo: DispatchRepo,
  candidate: IssueDispatch
): Promise<void> {
  const db = getDb();
  const issueNumber = candidate.issue_number;
  const issueTitle = candidate.issue_title ?? `issue-${issueNumber}`;

  // 0. Atomic claim: pending → dispatched. If another caller already claimed it
  // (changes===0) we must NOT spawn — bail before doing any work. This closes the
  // double-spawn race (reconcile tick vs manual approve, or two rapid approves)
  // and the crash window: the row is 'dispatched' (swept, never re-dispatched)
  // rather than lingering 'pending' (which a later tick would re-spawn).
  const claim = queries.claimDispatch(db).run(candidate.id);
  if (claim.changes === 0) return;

  // Tracked so the catch can clean up a half-built dispatch — otherwise a failure
  // after createWorktree leaks the worktree+branch and the next attempt collides.
  let createdWorktree: string | null = null;

  try {
    const provider = getProvider(repo.agent_type);
    const model = resolveModelForAgent(repo.agent_type, undefined);

    // 1. Worktree per task (createWorktree owns branch naming + uniqueness).
    // Local tasks have no issue number, so name the worktree by the row id.
    const featureName =
      issueNumber > 0
        ? `issue-${issueNumber}`
        : `task-${candidate.id.slice(0, 8)}`;
    const { worktreePath, branchName } = await createWorktree({
      projectPath: expandHome(repo.repo_path),
      featureName,
      baseBranch: repo.base_branch,
    });
    createdWorktree = worktreePath;

    // 2. Env setup (copy .env, install deps) in the background — never block.
    const sourcePath = expandHome(repo.repo_path);
    runInBackground(async () => {
      await setupWorktree({ worktreePath, sourcePath });
    }, `dispatch-setup-${candidate.id}`);

    // 3. Conductor-free session row + link it onto the (already-claimed) dispatch
    // row BEFORE spawning, so the sweep can judge liveness even if spawn crashes.
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
        issueToSessionName(issueNumber, issueTitle),
        tmuxName,
        worktreePath,
        null,
        model,
        null,
        "sessions",
        repo.agent_type,
        1,
        repo.project_id ?? "uncategorized"
      );
    queries
      .updateSessionWorktree(db)
      .run(worktreePath, branchName, repo.base_branch, null, sessionId);
    queries
      .setDispatchSession(db)
      .run(sessionId, branchName, worktreePath, candidate.id);

    // 4. Spawn the agent with the issue as its initial prompt (+ fleet-memory
    // pitfalls: recent critic findings for this repo, so it avoids known mistakes).
    const prompt = buildIssuePrompt(
      repo,
      issueNumber,
      issueTitle,
      worktreePath,
      branchName,
      getLessonsBlock(repo.id),
      candidate.task_body
    );
    const { binary, args } = buildAgentArgs(repo.agent_type, {
      model,
      autoApprove: true,
      initialPrompt: prompt,
    });
    // tmux backend consumes `command`; pty backend consumes binary/args.
    const command = wrapWithBanner(
      [binary, ...args.map(shellQuoteArg)].join(" ")
    );
    await getSessionBackend().create({
      name: tmuxName,
      cwd: worktreePath,
      command,
      binary,
      args,
    });
  } catch (err) {
    const ref = issueNumber > 0 ? `#${issueNumber}` : ` task "${issueTitle}"`;
    console.error(`dispatch failed for ${repo.repo_slug}${ref}:`, err);
    // Clean up the worktree+branch so the disk doesn't leak and a future attempt
    // for this issue doesn't collide on the branch name.
    if (createdWorktree) {
      try {
        await deleteWorktree(createdWorktree, expandHome(repo.repo_path), true);
      } catch (cleanupErr) {
        console.error("dispatch worktree cleanup failed:", cleanupErr);
      }
    }
    queries.updateDispatchStatus(db).run("failed", candidate.id);
  }
}
