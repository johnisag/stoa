/**
 * Conflict-aware decomposition — the planner.
 *
 * A planner is "just another spawned worker role" (like the critic panel): given a
 * spec, it runs in a FRESH throwaway worktree on the base branch, reads the real
 * tree to judge file ownership, and writes a partition to PLAN.md between marker
 * lines — N tasks, each owning a DISJOINT set of path prefixes so they can run in
 * parallel without colliding. Stoa parses PLAN.md (no commit/PR/stdout-scraping),
 * the operator reviews + edits the split, then approves → N ordinary pending
 * dispatch rows carrying file_claims, which flow through the IDENTICAL ceremony and
 * serialize automatically when claims overlap (pickSchedulable in the reconciler).
 *
 * buildPlannerPrompt + parsePlan are PURE (unit-tested); the spawn/read/cleanup I/O
 * reuses the canonical worktree + spawn recipe.
 */

import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { getDb, queries, type Session } from "../db";
import { getSessionBackend } from "../session-backend";
import { expandHome } from "../platform";
import { createWorktree, deleteWorktree } from "../worktrees";
import { spawnWorktreeWorker } from "./reviewer";
import { normalizeClaim } from "./claims";
import type { DispatchRepo, PlanParseResult, PlanTask } from "./types";

const PLAN_BEGIN = "STOA_PLAN_BEGIN";
const PLAN_END = "STOA_PLAN_END";

/** Default ceiling on tasks a planner may emit (the ~ceiling the roadmap targets). */
export const DEFAULT_TASK_CAP = 8;

/**
 * The planner prompt. PURE so its load-bearing instructions (the markers, "path
 * PREFIXES not globs", "disjoint / no overlap", "do not commit/push") are
 * unit-locked like the critic verdict markers.
 */
export function buildPlannerPrompt(
  repo: Pick<DispatchRepo, "base_branch">,
  spec: string,
  taskCap: number
): string {
  return [
    `[Stoa] You are a PLANNING agent working in a READ-ONLY worktree on the`,
    `"${repo.base_branch ?? "main"}" branch. Decompose the spec below into AT MOST`,
    `${taskCap} independent tasks, each owning a DISJOINT set of files so they can`,
    `run in PARALLEL without conflicting.`,
    ``,
    `SPEC:`,
    spec,
    ``,
    `For each task give: a short "title", a "body" (what to do, in markdown — this`,
    `becomes a GitHub issue), and a "claims" array of repo-relative PATH PREFIXES it`,
    `will EXCLUSIVELY own — directories like "lib/dispatch/" or exact files like`,
    `"lib/db/schema.ts". Use forward slashes; NO globs; no leading "./" or "/".`,
    `Two tasks MUST NOT share or nest claims. If the work cannot be cleanly split,`,
    `make FEWER, COARSER tasks rather than overlapping ones — correctness over`,
    `parallelism (any residual overlap will just be serialized).`,
    ``,
    `Read the real tree (ls, cat, git grep) to ground your file ownership. Then`,
    `write your plan to a file named PLAN.md in this worktree, as ONE JSON object`,
    `between a line "${PLAN_BEGIN}" and a line "${PLAN_END}":`,
    ``,
    PLAN_BEGIN,
    `{"tasks":[{"title":"...","body":"...","claims":["lib/x/","src/y.ts"]}]}`,
    PLAN_END,
    ``,
    `Do NOT commit, push, or open a PR. Writing PLAN.md is your only output.`,
  ].join("\n");
}

/**
 * Parse a planner's PLAN.md text. Takes the LAST marker block (latest-wins, like the
 * critic verdict markers), defensively JSON-parses it, and validates: a non-empty
 * tasks array, each task a non-empty title + a body + >= 1 NORMALIZED claim. Returns
 * { ok:true, tasks } or { ok:false, error }. Fail-closed — never spawn off a plan we
 * couldn't validate. Pure.
 */
export function parsePlan(fileText: string): PlanParseResult {
  if (!fileText) return { ok: false, error: "no PLAN.md content" };
  // Last begin…end block.
  const begin = fileText.lastIndexOf(PLAN_BEGIN);
  if (begin === -1) return { ok: false, error: "no STOA_PLAN_BEGIN marker" };
  const afterBegin = begin + PLAN_BEGIN.length;
  const end = fileText.indexOf(PLAN_END, afterBegin);
  if (end === -1) return { ok: false, error: "no STOA_PLAN_END marker" };
  const inner = fileText.slice(afterBegin, end).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return { ok: false, error: "the plan block is not valid JSON" };
  }
  const rawTasks =
    parsed && typeof parsed === "object"
      ? (parsed as { tasks?: unknown }).tasks
      : undefined;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return { ok: false, error: "the plan has no tasks" };
  }
  const tasks: PlanTask[] = [];
  for (const t of rawTasks) {
    if (!t || typeof t !== "object") {
      return { ok: false, error: "a task is malformed" };
    }
    const rec = t as Record<string, unknown>;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const body = typeof rec.body === "string" ? rec.body.trim() : "";
    if (!title) return { ok: false, error: "a task is missing a title" };
    const claims: string[] = [];
    if (Array.isArray(rec.claims)) {
      for (const c of rec.claims) {
        const norm = normalizeClaim(c);
        if (norm && !claims.includes(norm)) claims.push(norm);
      }
    }
    if (claims.length === 0) {
      return { ok: false, error: `task "${title}" has no valid file claims` };
    }
    tasks.push({ title, body, claims });
  }
  return { ok: true, tasks };
}

// ── Runtime plan runs (transient; no DB table in v1) ──────────────────────────
interface PlanRun {
  repoId: string;
  sessionName: string;
  sessionId: string | null;
  worktreePath: string;
  projectPath: string;
}
const planRuns = new Map<string, PlanRun>();

export function getPlanRun(planId: string): PlanRun | undefined {
  return planRuns.get(planId);
}

/** Spawn a planner worker in a fresh base-branch worktree; returns the plan id the
 * UI polls. The worktree is reclaimed on approve/cancel (or on a failed read). */
export async function spawnPlanner(
  repo: DispatchRepo,
  spec: string,
  taskCap: number
): Promise<string> {
  const planId = randomUUID();
  const { worktreePath } = await createWorktree({
    projectPath: expandHome(repo.repo_path),
    featureName: `plan-${planId.slice(0, 8)}`,
    baseBranch: repo.base_branch ?? "main",
  });
  const sessionName = `stoa-plan-${planId.slice(0, 8)}`;
  const run: PlanRun = {
    repoId: repo.id,
    sessionName,
    sessionId: null,
    worktreePath,
    projectPath: expandHome(repo.repo_path),
  };
  planRuns.set(planId, run);
  await spawnWorktreeWorker(
    {
      agentType: repo.agent_type as DispatchRepo["agent_type"],
      projectId: repo.project_id,
      baseBranch: repo.base_branch,
      worktreePath,
      branchName: null,
      label: `plan ${repo.repo_slug}`,
    },
    sessionName,
    buildPlannerPrompt(repo, spec, taskCap),
    (sessionId) => {
      run.sessionId = sessionId;
    }
  );
  return planId;
}

export type PlanRunStatus =
  | { status: "running" }
  | { status: "ready"; tasks: PlanTask[] }
  | { status: "failed"; error: string };

/**
 * Is the planner's session still alive? Liveness must be resolved via the session's
 * BACKEND key (`tmux_name`), NOT the human display name (`sessionName`), which
 * `backend.list()` never returns — comparing against `sessionName` would reap every
 * planner the tick it spawns. Mirrors maintainer.readSurveyRun. Pure (so it's
 * unit-locked against the always-false regression). */
export function isPlanSessionAlive(
  backendNames: Set<string>,
  session: Session | undefined
): boolean {
  return !!session && backendNames.has(session.tmux_name);
}

/** Poll a plan run: read PLAN.md from the worktree and parse it. While it's missing
 * we report "running"; once it parses we report "ready". If the planner session has
 * DIED without a valid plan, we report "failed" (so the UI doesn't spin forever). */
export async function readPlanRun(planId: string): Promise<PlanRunStatus> {
  const run = planRuns.get(planId);
  if (!run) return { status: "failed", error: "unknown plan run" };
  let text = "";
  try {
    text = await readFile(join(run.worktreePath, "PLAN.md"), "utf-8");
  } catch {
    text = "";
  }
  const parsed = text ? parsePlan(text) : { ok: false as const, error: "" };
  if (parsed.ok) return { status: "ready", tasks: parsed.tasks };

  // No valid plan yet — is the worker still alive? Resolve liveness via the
  // session's BACKEND key (tmux_name), NOT the display name (sessionName) which
  // backend.list() never returns — that comparison was always false and reaped a
  // just-spawned planner whenever PLAN.md wasn't readable yet.
  if (!run.sessionId) return { status: "running" }; // mid-spawn (id not recorded yet)
  let alive = false;
  try {
    const names = new Set(await getSessionBackend().list());
    const session = queries.getSession(getDb()).get(run.sessionId) as
      | Session
      | undefined;
    alive = isPlanSessionAlive(names, session);
  } catch {
    return { status: "running" }; // can't enumerate → never risk a false reap
  }
  if (alive) return { status: "running" };
  return {
    status: "failed",
    error: parsed.error || "the planner finished without writing a valid plan",
  };
}

/** Reclaim a plan run's worktree + kill its session, and drop the run. Idempotent. */
export async function cleanupPlanRun(planId: string): Promise<void> {
  const run = planRuns.get(planId);
  if (!run) return;
  planRuns.delete(planId);
  try {
    if (run.sessionId) {
      const s = queries.getSession(getDb()).get(run.sessionId) as
        | Session
        | undefined;
      if (s) await getSessionBackend().kill(s.tmux_name);
    }
  } catch {
    // best effort
  }
  try {
    await deleteWorktree(run.worktreePath, run.projectPath, true);
  } catch {
    // best effort — a leaked worktree is recoverable, a crash here isn't worth it
  }
}
