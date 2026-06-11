/**
 * Fleet memory — the lessons ledger (PART-2 multiplier #6).
 *
 * The dispatch loop already SEES every critic finding; fleet memory makes it
 * REMEMBER. When the panel blocks a PR (REQUEST_CHANGES), its per-lens findings are
 * persisted per repo (de-duped); the recent ones are then injected into every NEW
 * worker's prompt as "known pitfalls", so the fleet stops re-making the same
 * mistakes. Every prevented fix-round is a full agent cycle + a human review you
 * don't pay — it compounds every other multiplier.
 *
 * buildLessonsBlock is PURE (unit-tested); capture/read do the I/O. v1 captures
 * critic findings + injects them; the distill-into-AGENTS.md-amendments agent and a
 * lessons UI are a clean v2.
 */

import { randomUUID } from "crypto";
import { getDb, queries } from "../db";
import { expandHome, normalizePathForCompare } from "../platform";
import { readReviewerFindings } from "./reviewer";
import type { DispatchRepo, IssueDispatch } from "./types";

/** A finding is a pointed note, not an essay — cap it so the prompt stays lean. */
export const MAX_LESSON_LEN = 280;
/** How many recent lessons to inject into a worker's prompt. */
const MAX_LESSONS_INJECTED = 8;

export interface Lesson {
  lens: string | null;
  text: string;
}

/**
 * Render recent lessons as a worker-prompt block (empty string when there are none,
 * so callers can concatenate unconditionally). Pure → unit-tested.
 */
export function buildLessonsBlock(lessons: Lesson[]): string {
  if (lessons.length === 0) return "";
  const bullets = lessons
    .map((l) => `- ${l.lens ? `[${l.lens}] ` : ""}${l.text}`)
    .join("\n");
  return (
    `\n\nKNOWN PITFALLS IN THIS REPO (past findings + your rules — follow these):\n` +
    bullets +
    `\n`
  );
}

/** Read a repo's recent lessons and render the worker-prompt block. Empty on any
 * failure or when the repo has no lessons yet (so it's safe to always concatenate). */
export function getLessonsBlock(repoId: string): string {
  try {
    const rows = queries
      .listRecentLessons(getDb())
      .all(repoId, MAX_LESSONS_INJECTED) as Lesson[];
    return buildLessonsBlock(rows);
  } catch {
    return "";
  }
}

/**
 * Lessons block for an INTERACTIVE session: if its working directory is a tracked
 * dispatch repo's root, return that repo's pitfalls block, else "". Best-effort
 * (never throws) so it can't break session creation — it just lets interactive
 * work in a dispatch repo benefit from the same fleet memory.
 */
export function getLessonsBlockForCwd(cwd: string): string {
  try {
    const target = normalizePathForCompare(expandHome(cwd));
    const repos = queries
      .getEnabledDispatchRepos(getDb())
      .all() as DispatchRepo[];
    const match = repos.find(
      (r) => normalizePathForCompare(expandHome(r.repo_path)) === target
    );
    return match ? getLessonsBlock(match.id) : "";
  } catch {
    return "";
  }
}

/**
 * Capture a PR's BLOCKING critic findings into the repo's lessons ledger (de-duped
 * on the exact text). Called when a fixer is spawned — i.e. once per REQUEST_CHANGES
 * round. Best-effort: a capture failure must NEVER break the review pass.
 */
export async function captureLessons(
  repo: DispatchRepo,
  d: IssueDispatch
): Promise<void> {
  if (d.pr_number == null || !d.worktree_path) return;
  try {
    const findings = await readReviewerFindings(
      expandHome(d.worktree_path),
      d.pr_number
    );
    const db = getDb();
    for (const f of findings) {
      if (f.verdict !== "REQUEST_CHANGES") continue; // only the blockers
      const text = f.text.trim().slice(0, MAX_LESSON_LEN);
      if (!text) continue;
      queries
        .insertLessonIfNew(db)
        .run(randomUUID(), repo.id, f.lens, text, repo.id, text);
    }
  } catch {
    // best effort — never let lesson capture break the reconcile tick
  }
}
