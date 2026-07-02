/**
 * Dispatch — types for the GitHub-issue → agent-fleet control plane.
 *
 * `DispatchRepo` is a row of the allocation console (a tracked repo + its
 * agent/quota/concurrency/mode config). `IssueDispatch` is one row per ingested
 * issue — a `pending` candidate or a live worker that's implementing it. These
 * mirror the SQLite columns in lib/db/schema.ts (booleans are 0/1 INTEGERs).
 */

import type { AgentType } from "../providers";

/** Per-repo dispatch mode: spawn immediately vs surface for one-tap approval. */
export type DispatchMode = "auto" | "review";

export interface DispatchRepo {
  id: string;
  /** Local git checkout used for worktrees (createWorktree projectPath). */
  repo_path: string;
  /** "owner/name" for gh. */
  repo_slug: string;
  agent_type: AgentType;
  /** Max issues dispatched per calendar day (0 = none until raised). */
  daily_quota: number;
  /** Max live workers at once for this repo. */
  max_concurrency: number;
  /** gh label filter (e.g. "ready"); null/empty = all open issues. */
  label_filter: string | null;
  base_branch: string;
  mode: DispatchMode;
  /** 0/1 — paused vs active. */
  enabled: number;
  /** 0/1 — opt-in reviewer gate: spawn a critic panel on each worker's PR. */
  review_gate: number;
  /** 0/1 — opt-in CI auto-fix: spawn a fixer on a worker's PR with RED checks. */
  ci_autofix: number;
  /** 0/1 — opt-in merge train: auto-rebase-and-repair a ready-but-CONFLICTING PR. */
  merge_train: number;
  /** 0/1 — opt-in verification harness: run verify_command in the worktree per PR. */
  verify_gate: number;
  /** The command to run for verification (typecheck/test/build); steps chained with
   * `&&` (Stoa's own delimiter — never a shell). null = nothing armed. */
  verify_command: string | null;
  /** 0/1 — opt-in LLM-as-judge rubric gate (#26): a binary rubric judge over
   * each PR diff, gating auto-merge alongside review/verify. */
  judge_gate: number;
  /** #20 cost-aware routing (migration 48): pin this repo's dispatch workers to
   * an economical catalog model (e.g. haiku). null = the agent's default. */
  default_model?: string | null;
  /** 0/1 — opt-in autonomous maintainer: a survey agent proposes its own backlog
   * on a cadence (proposals NEVER auto-dispatch — they wait for one-tap Approve). */
  maintainer_survey_enabled: number;
  /** The maintenance objective the survey works toward (free text), e.g. "keep CI
   * green, deps current, the issue backlog triaged". null = none set. */
  maintainer_survey_goal: string | null;
  /** Survey cadence: 'hourly'|'daily'|'weekly' (recurrence.ts); null = none. */
  maintainer_survey_cadence: string | null;
  /** ISO time the survey last ran (the cadence anchor); null = never. */
  maintainer_survey_last_at: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export type DispatchStatus =
  | "scheduled"
  | "pending"
  | "dispatched"
  | "pr_open"
  | "merged"
  | "failed"
  | "cancelled";

export interface IssueDispatch {
  id: string;
  repo_id: string;
  issue_number: number;
  issue_title: string | null;
  issue_url: string | null;
  /** When the issue was raised on GitHub (gh createdAt) — "time raised". */
  issue_created_at: string | null;
  status: DispatchStatus;
  session_id: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_status: string | null;
  /** When Stoa spawned the worker (counts against the daily cap). */
  dispatched_at: string | null;
  /** ISO time a 'scheduled' row becomes eligible (promoted to 'pending'). */
  scheduled_at: string | null;
  /** Session id of the first review panelist (spawn-once guard for the panel). */
  reviewer_session_id: string | null;
  /** Stoa's aggregated panel verdict (APPROVED / CHANGES_REQUESTED), null while reviewing. */
  review_decision: string | null;
  /** PR head SHA the current panel verdict is pinned to (null until a complete
   * verdict is cached). Auto-merge uses this as `matchHeadCommit` so a push after
   * approval cannot merge unreviewed commits. */
  review_sha: string | null;
  /** How many fix rounds the worker has done in response to review feedback. */
  fix_rounds: number;
  /** Session id of the in-flight fixer worker (null when none running). */
  fixer_session_id: string | null;
  /** 0/1 — opt-in: auto-merge this issue's PR once it's ready (the reconciler). */
  auto_merge: number;
  /** How many CI-fix rounds have run on this PR's red checks (capped). */
  ci_fix_rounds: number;
  /** Session id of the in-flight CI fixer (null when none running). */
  ci_fixer_session_id: string | null;
  /** How many rebase-repair rounds the merge train has run on this PR (capped). */
  rebase_rounds: number;
  /** Session id of the in-flight rebase fixer (null when none running). */
  rebase_fixer_session_id: string | null;
  /** Latest verification verdict: null | running | pass | fail | error. */
  verify_status: string | null;
  /** Bounded tail of the failing step's output (empty/short on pass). */
  verify_output: string | null;
  /** The PR head SHA this verify_status is for (stale-verdict guard + gating pin). */
  verify_sha: string | null;
  /** When verification last ran (datetime('now')). */
  verify_ran_at: string | null;
  /** #26 rubric judge verdict: null | running | pass | fail | error. */
  judge_status: string | null;
  /** Bounded verdict detail: normalized checks/reasons JSON, or the error. */
  judge_output: string | null;
  /** The PR head SHA this judge_status is for (stale-verdict guard + pin). */
  judge_sha: string | null;
  /** When the judge last ran (datetime('now')). */
  judge_ran_at: string | null;
  /** Conflict-aware decomposition: JSON array of repo-relative path prefixes this
   * task exclusively owns. null/absent = no claims (co-scheduling unaffected). */
  file_claims: string | null;
  /** Intake source: 'github' (a real issue) or 'local' (a freeform task typed
   * into Stoa — issue_number is 0 and the body lives in task_body). */
  source: string;
  /** Freeform task body for a local task (source='local'); null for GitHub issues. */
  task_body: string | null;
  /** Recurrence for a scheduled local task ('hourly'|'daily'|'weekly'); null = once. */
  recurrence: string | null;
  /** 0/1 — proposed by the autonomous maintainer survey. Fenced out of auto-dispatch
   * (waits for one-tap Approve), even on an auto-mode repo. */
  maintainer_proposed: number;
  created_at: string;
  updated_at: string;
}

/** One task in a planner-proposed partition: a title + body (→ a GitHub issue) and
 * the path prefixes it will exclusively own (so tasks run in parallel conflict-free). */
export interface PlanTask {
  title: string;
  body: string;
  claims: string[];
}

/** Result of parsing a planner's PLAN.md. Fail-closed (ok:false) on any malformed
 * output — never spawn workers off a plan we couldn't validate. */
export type PlanParseResult =
  { ok: true; tasks: PlanTask[] } | { ok: false; error: string };

/** One maintenance task a survey agent proposed. `rationale` is the SPECIFIC signal
 * that triggered it (a failing test, an issue #, an outdated package) — required, so
 * the operator always sees WHY before approving. `rank` 1 = highest. */
export interface SurveyTask {
  title: string;
  body: string;
  rationale: string;
  rank: number;
}

/** Result of parsing a maintainer survey's artifact. Fail-closed; an EMPTY task
 * list is a valid "nothing needs doing" answer (ok:true, tasks:[]). */
export type SurveyParseResult =
  { ok: true; tasks: SurveyTask[] } | { ok: false; error: string };

/**
 * Coarse lifecycle marker for a session ceremony (drives the cockpit badge). The
 * reconciler derives each tick's ACTION from the fields (like a dispatch), and
 * writes the matching step for display. 'merged'/'stuck' are terminal.
 */
export type SessionCeremonyStep =
  | "queued" // enrolled; waiting for the owner session to settle before reviewing
  | "reviewing"
  | "fixing"
  | "ci_fixing"
  | "ready" // approved; waiting on CI / mergeability
  | "awaiting_merge" // approved + green + mergeable; auto_merge off → human merges
  | "merging"
  | "merged"
  | "stuck";

/**
 * Session "go to auto" — one row per session enrolled in the dispatch ceremony.
 * The SESSION row owns the worktree / branch / PR; this carries only the
 * review + CI progress, so the reconciler drives it with the SAME pure decision
 * functions as an IssueDispatch (nextReviewAction / nextCiFixAction /
 * nextAutoMergeAction). One ceremony per session (UNIQUE session_id).
 */
export interface SessionCeremony {
  id: string;
  session_id: string;
  step: SessionCeremonyStep;
  /** Optional one-shot instruction sent to the session as it goes autonomous. */
  seed_prompt: string | null;
  pr_number: number | null;
  pr_url: string | null;
  /** First review panelist's session id (spawn-once guard for the panel). */
  reviewer_session_id: string | null;
  /** Aggregated panel verdict (APPROVED / CHANGES_REQUESTED), null while reviewing. */
  review_decision: string | null;
  /** PR head SHA the current panel is reviewing (pinned at spawn) — markers must
   * stamp it and the merge is --match-head-commit-pinned to it. */
  review_sha: string | null;
  /** 0/1 — opt-in: auto-merge when ready (default 0 = stop at 'ready', human merges). */
  auto_merge: number;
  fix_rounds: number;
  fixer_session_id: string | null;
  ci_fix_rounds: number;
  ci_fixer_session_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A normalized open issue pulled from `gh issue list --json`. */
export interface EligibleIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
}

/** Inputs to the pure slot calculator (daily cap ∧ concurrency cap). */
export interface SlotInputs {
  dailyQuota: number;
  dailyDone: number;
  maxConcurrency: number;
  liveInFlight: number;
}
