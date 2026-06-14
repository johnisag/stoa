/**
 * Dispatch — GitHub repo listing + clone-if-needed.
 *
 * Mirrors lib/dispatch/issues.ts: resolve `gh` once, invoke with an argv array
 * (NO shell string), request `--json`, and JSON.parse the output. `parseGitHubRepos`
 * is split out as a pure function so tests feed canned gh JSON without spawning.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import { resolveBinary, expandHome } from "../platform";
import { isGitRepo, getDefaultBranch } from "../git";
import { defaultScanRoots } from "./discover";

const execFileAsync = promisify(execFile);

// Resolve gh once (see lib/dispatch/issues.ts for the Windows-shim rationale).
const gh = resolveBinary("gh") || "gh";

const REPO_FIELDS = "nameWithOwner,defaultBranchRef,isPrivate";
const MAX_REPOS = 100;

export interface GitHubRepo {
  slug: string; // owner/name
  defaultBranch: string; // "" for an empty repo with no default ref
  isPrivate: boolean;
}

interface RawRepo {
  nameWithOwner?: unknown;
  defaultBranchRef?: unknown;
  isPrivate?: unknown;
}

/**
 * Normalize `gh repo list --json nameWithOwner,defaultBranchRef,isPrivate`.
 * Pure + defensive: non-array input or entries without a slug are dropped.
 * `defaultBranchRef` is `{name}` (or null for an empty repo) → flattened.
 */
export function parseGitHubRepos(rawJson: string): GitHubRepo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: GitHubRepo[] = [];
  for (const item of parsed as RawRepo[]) {
    const slug =
      typeof item?.nameWithOwner === "string" ? item.nameWithOwner : "";
    if (!slug) continue;
    const ref = item.defaultBranchRef as { name?: unknown } | null | undefined;
    const defaultBranch = ref && typeof ref.name === "string" ? ref.name : "";
    out.push({ slug, defaultBranch, isPrivate: Boolean(item.isPrivate) });
  }
  return out;
}

/**
 * List the authenticated user's GitHub repos via gh. Returns [] on any failure
 * (gh missing / unauthenticated) — logged so a misconfig isn't invisible.
 */
export async function listGitHubRepos(): Promise<GitHubRepo[]> {
  // Let failures propagate (gh missing / unauthenticated) so the UI can show a
  // real error instead of a misleading "no repos found". A successful gh call
  // with no repos returns "[]" → an empty list, a distinct and valid state.
  const { stdout } = await execFileAsync(
    gh,
    ["repo", "list", "--json", REPO_FIELDS, "--limit", String(MAX_REPOS)],
    {
      encoding: "utf-8",
      timeout: 15000,
      windowsHide: true,
    }
  );
  return parseGitHubRepos(stdout);
}

/**
 * Where new clones land: STOA_CLONE_ROOT if set, else the first project parent
 * folder (so clones sit beside existing repos). Null when neither is available.
 */
export function defaultCloneRoot(projectDirs: string[]): string | null {
  const env = process.env.STOA_CLONE_ROOT?.trim();
  if (env) return expandHome(env);
  const roots = defaultScanRoots(projectDirs);
  return roots[0] ?? null;
}

/** The local folder name a slug clones into (the repo part of owner/name). */
export function repoDirName(slug: string): string {
  return slug.split("/").pop() || slug;
}

export interface PreparedRepo {
  path: string;
  defaultBranch: string;
  cloned: boolean; // true if we cloned it now, false if it already existed
}

/**
 * Ensure a GitHub repo is available locally under `parentDir`, cloning it with
 * gh if it isn't there yet ("clone-if-needed"). Returns the local path + its
 * default branch. execFile (no shell). Throws on clone failure.
 */
export async function prepareGitHubRepo(
  slug: string,
  parentDir: string
): Promise<PreparedRepo> {
  const name = repoDirName(slug);
  // Defense in depth (the route also validates the slug): never let a crafted
  // name like ".." escape parentDir via path.join.
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error(`unsafe repo name from slug: ${slug}`);
  }
  const parent = expandHome(parentDir);
  const dest = path.join(parent, name);

  // NOTE: small TOCTOU window between isGitRepo and clone — two concurrent picks
  // of the same slug both miss, the 2nd `gh repo clone` then fails on the now-
  // existing dest (a 500, no corruption). The UI doesn't retry, so it's fine.
  if (await isGitRepo(dest)) {
    return {
      path: dest,
      defaultBranch: await getDefaultBranch(dest),
      cloned: false,
    };
  }
  await fs.mkdir(parent, { recursive: true });
  await execFileAsync(gh, ["repo", "clone", slug, dest], {
    timeout: 120000,
    windowsHide: true,
  });
  return {
    path: dest,
    defaultBranch: await getDefaultBranch(dest),
    cloned: true,
  };
}
