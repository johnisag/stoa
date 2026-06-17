/**
 * Command Stoa — the in-process dispatch_issue executor.
 *
 * Creates a local (GitHub-free) dispatch task against a tracked repo row.
 * Mirrors the insertLocalTask path that POST /api/dispatch/local uses, but runs
 * directly via the typed DB primitives — no self-fetch (same rationale as
 * create-session.ts: avoids the SSRF surface and the Host-derived origin).
 *
 * The repo row is resolved server-side by the caller from repoId — the agent
 * never supplies a path. "now" disposition is deliberately not surfaced here
 * (Command Stoa doesn't expose time-sensitive spawning; the task goes to the
 * backlog and the reconciler picks it up in the normal cycle).
 */

import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import type { DispatchIssueParams } from "./actions";

/** The fields of the resolved dispatch repo the executor needs. */
export interface ResolvedDispatchRepo {
  id: string;
  repo_slug: string;
}

export interface CreatedDispatchIssue {
  dispatchId: string;
  title: string;
  repoSlug: string;
}

/**
 * Insert a local dispatch task for the given repo and return its new id + title.
 */
export function executeDispatchIssue(
  params: DispatchIssueParams,
  repo: ResolvedDispatchRepo
): CreatedDispatchIssue {
  const db = getDb();
  const id = randomUUID();
  const nowIso = new Date().toISOString();

  // insertLocalTask args: id, repo_id, title, body|null, created_at, scheduled_at|null, recurrence|null, status
  queries.insertLocalTask(db).run(
    id,
    repo.id,
    params.title,
    params.body ?? null,
    nowIso,
    null, // scheduled_at — immediate backlog entry
    null, // recurrence — one-shot
    "pending"
  );

  return { dispatchId: id, title: params.title, repoSlug: repo.repo_slug };
}
