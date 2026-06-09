/**
 * Dispatch — GitHub issue ingestion via the `gh` CLI.
 *
 * Mirrors lib/pr.ts: resolve `gh` once (a `.cmd` shim on Windows ENOENTs under
 * execFile when bare), invoke with an argv array (NO shell string), request
 * `--json`, and JSON.parse the output. Calls are ASYNC (execFile, not the sync
 * variant) — the reconciler runs in the main server process, so a slow/hung `gh`
 * (15s timeout) must NOT block the event loop (WS/pty/HTTP). Errors degrade to
 * empty/null (logged) so a missing/unauthenticated `gh` never throws in a tick.
 *
 * `parseIssues` is split out as a pure function so tests feed canned gh JSON
 * without spawning anything.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { resolveBinary, expandHome } from "../platform";
import type { DispatchRepo, EligibleIssue } from "./types";

const execFileAsync = promisify(execFile);

// Resolve gh once (see lib/pr.ts:10 for the Windows-shim rationale).
const gh = resolveBinary("gh") || "gh";

const ISSUE_FIELDS = "number,title,url,createdAt,labels";
const MAX_ISSUES = 50;

interface RawIssue {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  createdAt?: unknown;
  labels?: unknown;
}

/**
 * Normalize `gh issue list --json number,title,url,createdAt,labels` output into
 * EligibleIssue[]. Pure + defensive: non-array input or malformed entries are
 * dropped (a row needs at least a numeric `number`). gh returns labels as
 * `[{name,...}]`; we flatten to string[].
 */
export function parseIssues(rawJson: string): EligibleIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: EligibleIssue[] = [];
  for (const item of parsed as RawIssue[]) {
    if (typeof item?.number !== "number") continue;
    const labels = Array.isArray(item.labels)
      ? (item.labels as Array<{ name?: unknown }>)
          .map((l) => (typeof l?.name === "string" ? l.name : ""))
          .filter(Boolean)
      : [];
    out.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      url: typeof item.url === "string" ? item.url : "",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
      labels,
    });
  }
  return out;
}

/**
 * Pull open issues for a tracked repo. Applies the repo's label filter
 * server-side (gh `--label`) when set. Returns [] on any failure (gh missing,
 * unauthenticated, repo unreachable) — the caller treats empty as "nothing to
 * dispatch this tick" — and logs the cause so a misconfigured slug / expired
 * token isn't silently invisible.
 */
export async function listEligibleIssues(
  repo: DispatchRepo
): Promise<EligibleIssue[]> {
  try {
    // Same gh issue-list command as the on-demand browse, bound to the repo's
    // standing label filter (single source of truth: buildOpenIssueArgs).
    const { stdout } = await execFileAsync(
      gh,
      buildOpenIssueArgs(repo.repo_slug, { label: repo.label_filter }),
      { cwd: expandHome(repo.repo_path), encoding: "utf-8", timeout: 15000 }
    );
    return parseIssues(stdout);
  } catch (err) {
    console.warn(
      `dispatch: gh issue list failed for ${repo.repo_slug}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * On-demand backlog browse query. Unlike the reconciler path it is NOT bound to
 * the repo's standing `label_filter` — a human triaging the backlog passes an
 * explicit (optional) label/search, so the WHOLE open backlog is reachable.
 */
export interface OpenIssueQuery {
  /** Narrow to a single gh label; omit/empty = all open issues. */
  label?: string | null;
  /** gh `--search` query (e.g. "sort:created-desc no:assignee"). */
  search?: string | null;
  /** Page size; clamped to [1, MAX_ISSUES]. */
  limit?: number;
}

/**
 * Build the argv for an on-demand `gh issue list` browse. Pure (no spawn) so the
 * command string is unit-locked (AGENTS.md). Deliberately does NOT read
 * repo.label_filter — callers pass the label explicitly so triage can see issues
 * the standing filter would hide.
 */
export function buildOpenIssueArgs(
  repoSlug: string,
  opts: OpenIssueQuery = {}
): string[] {
  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_ISSUES)
      : MAX_ISSUES;
  const args = [
    "issue",
    "list",
    "--repo",
    repoSlug,
    "--state",
    "open",
    "--json",
    ISSUE_FIELDS,
    "--limit",
    String(limit),
  ];
  const label = opts.label?.trim();
  if (label) args.push("--label", label);
  const search = opts.search?.trim();
  if (search) args.push("--search", search);
  return args;
}

/**
 * Browse a tracked repo's OPEN issues on demand for triage. Returns [] on any
 * failure (gh missing/unauthenticated/repo unreachable), logged. Mirrors
 * listEligibleIssues' spawn recipe (execFile, no shell; cwd = checkout).
 */
export async function listOpenIssues(
  repo: DispatchRepo,
  opts: OpenIssueQuery = {}
): Promise<EligibleIssue[]> {
  try {
    const { stdout } = await execFileAsync(
      gh,
      buildOpenIssueArgs(repo.repo_slug, opts),
      {
        cwd: expandHome(repo.repo_path),
        encoding: "utf-8",
        timeout: 15000,
        windowsHide: process.platform === "win32",
      }
    );
    return parseIssues(stdout);
  } catch (err) {
    console.warn(
      `dispatch: gh issue list (browse) failed for ${repo.repo_slug}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/** A PR for a branch, in ANY state (open/merged/closed). */
export interface BranchPR {
  number: number;
  url: string;
  state: string; // "OPEN" | "MERGED" | "CLOSED"
}

/**
 * Look up the PR for a worktree branch in ANY state (async, non-blocking). Unlike
 * lib/pr.ts getPRForBranch (open-only), this sees MERGED/CLOSED too — so the sweep
 * can record a merged worker as 'merged' instead of mislabeling it 'failed' once
 * its PR leaves the open set. Returns null if none / on error.
 */
export async function getPRForBranchAnyState(
  workingDir: string,
  branchName: string
): Promise<BranchPR | null> {
  try {
    const { stdout } = await execFileAsync(
      gh,
      [
        "pr",
        "list",
        "--head",
        branchName,
        "--state",
        "all",
        "--json",
        "number,url,state",
        "--limit",
        "1",
      ],
      {
        cwd: workingDir,
        encoding: "utf-8",
        timeout: 15000,
        windowsHide: process.platform === "win32",
      }
    );
    const prs = JSON.parse(stdout);
    return Array.isArray(prs) && prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}
