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
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export type DispatchStatus =
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
