/**
 * Autonomous maintainer — the survey agent.
 *
 * On a cadence, a survey runs in a FRESH throwaway worktree on the base branch and
 * — using its OWN tools (run the tests, `gh issue list`, `gh run list`, `npm
 * outdated`, grep TODO) — proposes the highest-value maintenance work toward the
 * repo's stated GOAL, writing it to a per-run survey artifact between marker lines. Stoa parses it
 * (no commit/PR/stdout-scraping) and files the tasks as PENDING local rows carrying
 * maintainer_proposed=1 — which the auto-dispatch loop structurally EXCLUDES, so a
 * proposal NEVER auto-ships: it waits for one-tap Approve in the Backlog.
 *
 * The agent does the finding AND the dedup (it's given the verbatim open-task list
 * and told not to re-propose them, semantically). buildSurveyPrompt + parseSurvey
 * are PURE (unit-tested); the spawn/read/cleanup I/O reuses the planner's recipe.
 */

import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { getDb, queries, type Session } from "../db";
import { getSessionBackend } from "../session-backend";
import { expandHome } from "../platform";
import {
  createWorktree,
  deleteWorktree,
  getMainRepoPath,
  isStoaWorktree,
} from "../worktrees";
import { spawnWorktreeWorker } from "./reviewer";
import { MAINTAINER_BODY_PREFIX } from "./task-label";
import type { DispatchRepo, SurveyParseResult, SurveyTask } from "./types";

const SURVEY_BEGIN = "STOA_SURVEY_BEGIN";
const SURVEY_END = "STOA_SURVEY_END";

/** Most tasks one survey may propose (keeps the backlog from flooding). */
export const DEFAULT_SURVEY_CAP = 5;
/** Max open tasks fed to the dedup list (newest-first), so a busy repo can't blow
 * the prompt context. */
export const DEDUP_LIST_CAP = 40;
/** Per-field length caps (generous, but bounded so a runaway/injected survey can't
 * persist a megabyte row or blow out the mobile Backlog). Truncated, not rejected. */
const TITLE_CAP = 200;
const RATIONALE_CAP = 1000;
const BODY_CAP = 20000;

/** Trim + hard-cap a string field. */
function clampField(value: unknown, cap: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > cap ? s.slice(0, cap) : s;
}

/** One already-open task, shown to the survey so it doesn't re-propose it. */
export interface OpenTaskSummary {
  title: string;
  bodyFirstLine: string;
}

/**
 * The survey prompt. PURE so its load-bearing instructions (read-only, the markers,
 * "do not commit/push", the goal, the verbatim dedup list, the required rationale)
 * are unit-locked like the planner's. The agent investigates with its own tools and
 * emits a ranked task list.
 */
export function buildSurveyPrompt(
  repo: Pick<DispatchRepo, "base_branch">,
  goal: string,
  openTasks: OpenTaskSummary[],
  cap: number,
  artifactName: string
): string {
  const dedupBlock =
    openTasks.length > 0
      ? [
          `These tasks ALREADY EXIST for this repo — do NOT re-propose any of them`,
          `(judge by MEANING, not exact wording):`,
          ...openTasks.map(
            (t, i) =>
              `  ${i + 1}. ${t.title}${t.bodyFirstLine ? ` — ${t.bodyFirstLine}` : ""}`
          ),
          ``,
        ]
      : [];
  return [
    `[Stoa] You are a MAINTAINER agent investigating the`,
    `"${repo.base_branch ?? "main"}" branch in a fresh worktree. This is a`,
    `READ-ONLY investigation: do NOT modify, create, or delete any file except`,
    `${artifactName} (running the tests and other read-only commands is expected`,
    `and fine). The repo's maintenance GOAL is:`,
    goal.trim(),
    ``,
    `Propose AT MOST ${cap} of the HIGHEST-VALUE pieces of maintenance work that`,
    `move it toward that goal. INVESTIGATE with your tools before proposing — run`,
    `the tests, \`gh issue list\`, \`gh run list\` (recent CI), check for outdated`,
    `dependencies (e.g. \`npm outdated\` for a Node repo), and grep for TODO/FIXME.`,
    `Rank by value — failing tests / security first, then stale dependencies, then`,
    `tech-debt / TODOs — UNLESS the GOAL implies a different priority.`,
    ``,
    ...dedupBlock,
    `For each task give: a short "title", a "body" (what to do and how to verify`,
    `it, in markdown — this becomes the task brief), a "rationale" (the SPECIFIC`,
    `signal that triggered it: the failing test name, the issue #, the outdated`,
    `package, the TODO's file:line), and a "rank" (1 = highest value).`,
    ``,
    `Write your findings to a file named ${artifactName} in this worktree, as ONE`,
    `JSON object between a line "${SURVEY_BEGIN}" and a line "${SURVEY_END}":`,
    ``,
    SURVEY_BEGIN,
    `{"tasks":[{"title":"...","body":"...","rationale":"...","rank":1}]}`,
    SURVEY_END,
    ``,
    `If nothing needs doing, emit {"tasks":[]} — that is a valid, expected answer.`,
    `Do NOT commit, push, or open a PR. Writing ${artifactName} is your only output.`,
  ].join("\n");
}

/**
 * Parse a survey's artifact file. Last marker block wins (latest output), defensive
 * JSON.parse, then validate: a tasks ARRAY (empty is a valid "nothing to do"
 * answer), each task a non-empty title + body + NON-EMPTY rationale (rejected
 * otherwise — the operator must always see WHY). Sorted by rank ascending.
 * Fail-closed. Pure.
 */
export function parseSurvey(fileText: string): SurveyParseResult {
  if (!fileText) return { ok: false, error: "no survey content" };
  const begin = fileText.lastIndexOf(SURVEY_BEGIN);
  if (begin === -1) return { ok: false, error: "no STOA_SURVEY_BEGIN marker" };
  const afterBegin = begin + SURVEY_BEGIN.length;
  const end = fileText.indexOf(SURVEY_END, afterBegin);
  if (end === -1) return { ok: false, error: "no STOA_SURVEY_END marker" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText.slice(afterBegin, end).trim());
  } catch {
    return { ok: false, error: "the survey block is not valid JSON" };
  }
  const rawTasks =
    parsed && typeof parsed === "object"
      ? (parsed as { tasks?: unknown }).tasks
      : undefined;
  if (!Array.isArray(rawTasks)) {
    return { ok: false, error: "the survey has no tasks array" };
  }
  const tasks: SurveyTask[] = [];
  for (const t of rawTasks) {
    if (!t || typeof t !== "object") {
      return { ok: false, error: "a task is malformed" };
    }
    const rec = t as Record<string, unknown>;
    const title = clampField(rec.title, TITLE_CAP);
    const body = clampField(rec.body, BODY_CAP);
    const rationale = clampField(rec.rationale, RATIONALE_CAP);
    if (!title) return { ok: false, error: "a task is missing a title" };
    // Fail-closed: an empty brief is useless to the worker that will action it.
    if (!body) return { ok: false, error: `task "${title}" has no body` };
    // Fail-closed: a rationale-less proposal is rejected — the operator must see
    // the signal that triggered it before approving.
    if (!rationale) {
      return { ok: false, error: `task "${title}" has no rationale` };
    }
    const rank =
      typeof rec.rank === "number" && Number.isFinite(rec.rank)
        ? Math.trunc(rec.rank)
        : 99;
    tasks.push({ title, body, rationale, rank });
  }
  tasks.sort((a, b) => a.rank - b.rank);
  return { ok: true, tasks };
}

/** The task body filed to the backlog: rationale first (visible inline), then the
 * agent's body. Pure. */
export function buildMaintainerTaskBody(task: SurveyTask): string {
  return `${MAINTAINER_BODY_PREFIX}${task.rationale}\n\n---\n${task.body}`.trim();
}

// ── Runtime survey runs (transient; no DB table — mirrors planner.planRuns) ──────
interface SurveyRun {
  repoId: string;
  sessionName: string;
  sessionId: string | null;
  worktreePath: string;
  projectPath: string;
  /** Per-run artifact filename, so a SURVEY.md already committed on the base branch
   * can't be read as this run's output (which would file stale proposals and reap
   * the live agent every cadence). */
  artifactName: string;
}
const surveyRuns = new Map<string, SurveyRun>();

/** Whether a survey is already in flight for this repo (the spawn-once guard). */
export function hasSurveyRun(repoId: string): boolean {
  for (const run of surveyRuns.values()) {
    if (run.repoId === repoId) return true;
  }
  return false;
}

export function trackedSurveyIds(): string[] {
  return [...surveyRuns.keys()];
}

/** Spawn a survey worker in a fresh base-branch worktree; returns the survey id.
 * The worktree is reclaimed once the tasks are filed (or on a failed read).
 * Runs are transient (in-memory, like planner.planRuns): a process restart mid-
 * survey loses the run's in-memory tracking, but `sweepOrphanedSurveys` reclaims
 * the orphaned session + worktree at the next startup. */
export async function spawnSurvey(
  repo: DispatchRepo,
  goal: string,
  openTasks: OpenTaskSummary[],
  cap = DEFAULT_SURVEY_CAP
): Promise<string> {
  const surveyId = randomUUID();
  const { worktreePath } = await createWorktree({
    projectPath: expandHome(repo.repo_path),
    featureName: `survey-${surveyId.slice(0, 8)}`,
    baseBranch: repo.base_branch ?? "main",
  });
  const sessionName = `stoa-survey-${surveyId.slice(0, 8)}`;
  // A unique artifact name so a pre-existing/committed SURVEY.md on the base branch
  // is never mistaken for THIS run's output.
  const artifactName = `SURVEY-${surveyId.slice(0, 8)}.md`;
  const run: SurveyRun = {
    repoId: repo.id,
    sessionName,
    sessionId: null,
    worktreePath,
    projectPath: expandHome(repo.repo_path),
    artifactName,
  };
  surveyRuns.set(surveyId, run);
  // spawnWorktreeWorker swallows its own errors and returns null (never throws) —
  // so we must check the return. On a failed spawn, reclaim the worktree and throw
  // so maintainerPass rolls back the cadence anchor and retries next tick (rather
  // than leaving a dead run tracked and waiting a whole interval).
  const sessionId = await spawnWorktreeWorker(
    {
      agentType: repo.agent_type,
      projectId: repo.project_id,
      baseBranch: repo.base_branch,
      worktreePath,
      branchName: null,
      label: `survey ${repo.repo_slug}`,
    },
    sessionName,
    buildSurveyPrompt(repo, goal, openTasks, cap, artifactName),
    (sid) => {
      run.sessionId = sid;
    }
  );
  if (!sessionId) {
    surveyRuns.delete(surveyId);
    try {
      await deleteWorktree(worktreePath, expandHome(repo.repo_path), true);
    } catch {
      // best effort — a leaked worktree is recoverable
    }
    throw new Error(`survey worker spawn failed for ${repo.repo_slug}`);
  }
  return surveyId;
}

export type SurveyRunStatus =
  | { status: "running" }
  | { status: "ready"; repoId: string; tasks: SurveyTask[] }
  | { status: "failed"; repoId: string };

/** Poll a survey run: read its per-run artifact and parse it. Missing → running,
 * unless the session has died without a valid survey → failed. */
export async function readSurveyRun(
  surveyId: string
): Promise<SurveyRunStatus> {
  const run = surveyRuns.get(surveyId);
  if (!run) return { status: "failed", repoId: "" };

  const readParsed = async (): Promise<SurveyParseResult> => {
    let text = "";
    try {
      text = await readFile(join(run.worktreePath, run.artifactName), "utf-8");
    } catch {
      text = "";
    }
    return text ? parseSurvey(text) : { ok: false, error: "no survey yet" };
  };

  const parsed = await readParsed();
  if (parsed.ok) {
    return { status: "ready", repoId: run.repoId, tasks: parsed.tasks };
  }

  // No valid survey yet — is the worker still alive? Resolve liveness the way the
  // rest of the reconciler does: via the session's BACKEND key (tmux_name), NOT
  // the human display name (sessionName), which backend.list() never returns —
  // comparing against sessionName would reap every survey the tick it spawns.
  if (!run.sessionId) return { status: "running" }; // mid-spawn (id not recorded yet)
  let alive: boolean;
  try {
    const names = new Set(await getSessionBackend().list());
    const sess = queries.getSession(getDb()).get(run.sessionId) as
      | Session
      | undefined;
    alive = !!sess && names.has(sess.tmux_name);
  } catch {
    return { status: "running" }; // can't enumerate → never risk a false reap
  }
  if (alive) return { status: "running" };

  // Dead session with no valid file — re-read once in case it wrote-then-exited
  // between our read and this check (TOCTOU); otherwise give up.
  const final = await readParsed();
  return final.ok
    ? { status: "ready", repoId: run.repoId, tasks: final.tasks }
    : { status: "failed", repoId: run.repoId };
}

/** Reclaim a survey run's worktree + kill its session, then drop it. Idempotent.
 * Mirrors cleanupPlanRun. */
export async function cleanupSurveyRun(surveyId: string): Promise<void> {
  const run = surveyRuns.get(surveyId);
  if (!run) return;
  surveyRuns.delete(surveyId);
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
    // best effort — a leaked worktree is recoverable
  }
}

/** The EXACT machine shape of a survey session name: `stoa-survey-` + the 8
 * lowercase-hex chars of `surveyId.slice(0, 8)`. `sessions.name` is user-renamable
 * and SQLite LIKE is case-insensitive, so this destructive sweep must allowlist the
 * precise shape Stoa itself emits — never a user-spoofable prefix (fail-closed). */
const SURVEY_SESSION_NAME = /^stoa-survey-[0-9a-f]{8}$/;

/**
 * Reclaim surveys orphaned by a restart. `surveyRuns` is in-memory only, so a
 * process restart mid-survey leaves a live agent session + its worktree with
 * nothing tracking them. Run at startup (from reconcileOrphans): each matched
 * survey session is killed, its worktree reclaimed (the owning repo recovered from
 * the worktree via `getMainRepoPath`), and its session row dropped. Two structural,
 * fail-closed guards keep it from ever touching a user's session/worktree: it acts
 * ONLY on sessions named in the exact machine shape Stoa emits AND not currently
 * tracked, and removes ONLY worktrees inside Stoa's worktrees dir. Best-effort and
 * idempotent: a failure on one survey never blocks the rest.
 */
export async function sweepOrphanedSurveys(): Promise<void> {
  const db = getDb();
  const rows = queries.listSurveySessions(db).all() as Session[];
  if (rows.length === 0) return;
  const backend = getSessionBackend();
  // Skip any survey the in-memory map still tracks, so "every matched row is an
  // orphan" holds structurally (not only at t=0): a slow startup that lets a fresh
  // survey spawn before this runs can't reap a LIVE, tracked one.
  const tracked = new Set(
    [...surveyRuns.values()].map((r) => r.sessionId).filter(Boolean)
  );
  for (const s of rows) {
    // Fail-closed: act only on a session Stoa itself named (exact shape, not a user
    // rename) that isn't currently tracked.
    if (!SURVEY_SESSION_NAME.test(s.name) || tracked.has(s.id)) continue;
    try {
      await backend.kill(s.tmux_name);
    } catch {
      // already gone / unreachable — fine
    }
    // Only reclaim a worktree under Stoa's worktrees dir — never an external path
    // (mirrors the session DELETE route's isStoaWorktree guard).
    if (s.worktree_path && isStoaWorktree(s.worktree_path)) {
      try {
        // Recover the MAIN repo that owns the worktree so the git-side removal +
        // branch delete run from the right place; fall back to the worktree path
        // itself (deleteWorktree's fs removal still reclaims the directory).
        const repo =
          (await getMainRepoPath(s.worktree_path)) ?? s.worktree_path;
        await deleteWorktree(s.worktree_path, repo, true);
      } catch (err) {
        console.warn(
          `maintainer: could not reclaim survey worktree ${s.worktree_path}:`,
          err
        );
      }
    }
    try {
      queries.deleteSession(db).run(s.id);
    } catch {
      // best effort
    }
    console.log(`maintainer: reclaimed orphaned survey session ${s.id}`);
  }
}
