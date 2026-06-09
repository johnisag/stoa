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
import { resolveBinary } from "../platform";
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
  const args = [
    "issue",
    "list",
    "--repo",
    repo.repo_slug,
    "--state",
    "open",
    "--json",
    ISSUE_FIELDS,
    "--limit",
    String(MAX_ISSUES),
  ];
  const label = repo.label_filter?.trim();
  if (label) args.push("--label", label);

  try {
    const { stdout } = await execFileAsync(gh, args, {
      cwd: repo.repo_path,
      encoding: "utf-8",
      timeout: 15000,
      windowsHide: process.platform === "win32",
    });
    return parseIssues(stdout);
  } catch (err) {
    console.warn(
      `dispatch: gh issue list failed for ${repo.repo_slug}:`,
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
