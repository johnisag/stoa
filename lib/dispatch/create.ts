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

// execFile options inlined at every gh call site (not factored into a helper) so
// the windowsHide-coverage guard can statically see windowsHide: true on each —
// the Windows console-flash guard that the test/windows-hide-coverage suite locks.
const EXEC_TIMEOUT_MS = 20000;

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
 * Build the argv for `gh label list` (JSON of label names). Pure + testable.
 * A high `--limit` so we see the full set in one call; a label that still slips
 * past the limit just gets a redundant create attempt that's ignored.
 */
export function buildLabelListArgs(repoSlug: string): string[] {
  return [
    "label",
    "list",
    "--repo",
    repoSlug,
    "--limit",
    "500",
    "--json",
    "name",
  ];
}

/** Parse `gh label list --json name` output into label names. Pure; [] on junk. */
export function parseLabelList(stdout: string): string[] {
  try {
    const arr = JSON.parse(stdout);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) =>
        x && typeof (x as { name?: unknown }).name === "string"
          ? (x as { name: string }).name
          : ""
      )
      .filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

/**
 * Which requested labels are absent from `existing` (case-insensitive, since
 * GitHub label names are unique case-insensitively). Trims, drops blanks, and
 * de-dupes while preserving the user's original casing for creation. Pure.
 */
export function computeMissingLabels(
  requested: string[],
  existing: string[]
): string[] {
  const have = new Set(existing.map((l) => l.toLowerCase()));
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const raw of requested) {
    const label = raw.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (have.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(label);
  }
  return missing;
}

/**
 * Build the argv for `gh label create <name>` (random color). Pure + testable.
 * The name goes AFTER a `--` end-of-options sentinel so a label like `--force`
 * or `-c` is taken literally as the positional name, never parsed as a gh flag.
 */
export function buildLabelCreateArgs(repoSlug: string, name: string): string[] {
  return ["label", "create", "--repo", repoSlug, "--", name];
}

/**
 * Ensure every requested label exists on the repo, creating the missing ones —
 * `gh issue create` aborts the WHOLE issue if any label is unknown, so without
 * this a user-typed label that doesn't exist yet fails the dispatch. Returns the
 * names actually created. A create that fails because the label already exists
 * (a race, or one beyond the list `--limit`) is treated as success; any OTHER
 * failure throws a clear error here rather than letting `issue create` surface a
 * confusing secondary "label not found".
 */
export async function ensureLabelsExist(
  repoSlug: string,
  cwd: string,
  labels: string[]
): Promise<string[]> {
  const requested = labels.map((l) => l.trim()).filter(Boolean);
  if (requested.length === 0) return [];

  let existing: string[] = [];
  try {
    const { stdout } = await execFileAsync(gh, buildLabelListArgs(repoSlug), {
      cwd,
      encoding: "utf-8",
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
    });
    existing = parseLabelList(stdout);
  } catch {
    // Can't list (e.g. transient gh error) — treat all as missing and rely on
    // the already-exists guard below to no-op the ones that do exist.
  }

  const created: string[] = [];
  for (const name of computeMissingLabels(requested, existing)) {
    try {
      await execFileAsync(gh, buildLabelCreateArgs(repoSlug, name), {
        cwd,
        encoding: "utf-8",
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
      });
      created.push(name);
    } catch (err) {
      const stderr =
        err && typeof (err as { stderr?: unknown }).stderr === "string"
          ? (err as { stderr: string }).stderr
          : String(err);
      // Already there (created concurrently, or beyond the list --limit): fine.
      if (/already exists/i.test(stderr)) continue;
      throw new Error(
        `Could not create label '${name}' on ${repoSlug}: ${stderr.trim()}`
      );
    }
  }
  return created;
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
  const cwd = expandHome(opts.repoPath);
  // gh refuses to create an issue if any --label doesn't already exist on the
  // repo, so pre-create the missing ones to make user-supplied labels "just work".
  await ensureLabelsExist(opts.repoSlug, cwd, opts.labels);
  const args = buildIssueCreateArgs(opts);
  const { stdout } = await execFileAsync(gh, args, {
    cwd,
    encoding: "utf-8",
    timeout: EXEC_TIMEOUT_MS,
    windowsHide: true,
  });
  const created = parseCreatedIssueUrl(stdout);
  if (!created)
    throw new Error("Could not parse the created issue URL from gh");
  return created;
}
