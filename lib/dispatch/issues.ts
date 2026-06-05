/**
 * Dispatch — GitHub issue ingestion via the `gh` CLI.
 *
 * Mirrors lib/pr.ts exactly: resolve `gh` once (a `.cmd` shim on Windows ENOENTs
 * under execFile when bare), invoke with an argv array (NO shell string), request
 * `--json`, and JSON.parse the output. All errors degrade to `[]` so a missing /
 * unauthenticated `gh` never throws inside the reconciler tick.
 *
 * `parseIssues` is split out as a pure function so tests feed canned gh JSON
 * without spawning anything.
 */

import { execFileSync } from "child_process";
import { resolveBinary } from "../platform";
import type { DispatchRepo, EligibleIssue } from "./types";

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
 * dispatch this tick".
 */
export function listEligibleIssues(repo: DispatchRepo): EligibleIssue[] {
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
    const output = execFileSync(gh, args, {
      cwd: repo.repo_path,
      encoding: "utf-8",
      timeout: 15000,
    });
    return parseIssues(output);
  } catch {
    return [];
  }
}
