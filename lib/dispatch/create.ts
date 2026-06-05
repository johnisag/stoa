/**
 * Dispatch — create a GitHub issue via gh.
 *
 * Mirrors lib/dispatch/issues.ts (resolve gh once, execFile with an argv array,
 * NO shell string). `buildIssueCreateArgs` + `parseCreatedIssueUrl` are split out
 * as pure functions so tests don't spawn anything.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { resolveBinary, expandHome } from "../platform";

const execFileAsync = promisify(execFile);

// Resolve gh once (see lib/dispatch/issues.ts for the Windows-shim rationale).
const gh = resolveBinary("gh") || "gh";

export interface CreatedIssue {
  number: number;
  url: string;
}

export interface CreateIssueOptions {
  repoSlug: string;
  repoPath: string;
  title: string;
  body: string;
  labels: string[];
}

/**
 * Build the argv for `gh issue create`. Pure + testable. Always passes --title
 * and --body so gh runs non-interactively; labels become repeated --label flags
 * (blank entries dropped).
 */
export function buildIssueCreateArgs(opts: {
  repoSlug: string;
  title: string;
  body: string;
  labels: string[];
}): string[] {
  const args = [
    "issue",
    "create",
    "--repo",
    opts.repoSlug,
    "--title",
    opts.title,
    "--body",
    opts.body,
  ];
  for (const raw of opts.labels) {
    const label = raw.trim();
    if (label) args.push("--label", label);
  }
  return args;
}

/**
 * Parse the issue number + url from gh's success output (it prints the new
 * issue's URL, e.g. https://github.com/owner/name/issues/123). Pure; returns
 * null if no /issues/<n> url is found.
 */
export function parseCreatedIssueUrl(stdout: string): CreatedIssue | null {
  // Scan tokens last-first for an /issues/<n> url — robust if gh ever prints a
  // trailing line after the url (rather than blindly taking the final token).
  const tokens = stdout.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const m = tokens[i].match(/\/issues\/(\d+)\b/);
    if (m) return { number: Number(m[1]), url: tokens[i] };
  }
  return null;
}

/**
 * Create a real GitHub issue via gh. Throws on failure (gh missing /
 * unauthenticated / bad repo / unparseable output) so the route surfaces it.
 */
export async function createIssue(
  opts: CreateIssueOptions
): Promise<CreatedIssue> {
  const args = buildIssueCreateArgs(opts);
  const { stdout } = await execFileAsync(gh, args, {
    cwd: expandHome(opts.repoPath),
    encoding: "utf-8",
    timeout: 20000,
  });
  const created = parseCreatedIssueUrl(stdout);
  if (!created)
    throw new Error("Could not parse the created issue URL from gh");
  return created;
}
