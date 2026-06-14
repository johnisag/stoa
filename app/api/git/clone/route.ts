import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import { expandHome, isWindows } from "@/lib/platform";

const execFileAsync = promisify(execFile);

/**
 * Allowed clone URL schemes. We refuse anything else (e.g. `file:`, `ext::`,
 * or a `-`-leading token) before spawning git. Even though we never run a
 * shell, restricting the scheme avoids git transport helpers reaching the
 * local filesystem / arbitrary helper programs from an attacker-supplied URL.
 */
const ALLOWED_SCHEMES = ["https:", "http:", "git:", "ssh:"];

/**
 * Validate the clone URL. Accepts the common https/http/git/ssh URL forms and
 * the scp-like `git@host:owner/repo` ssh shorthand. Returns false for anything
 * else so the route can 400 instead of handing it to git. Pure (testable).
 */
export function isAllowedCloneUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  // A leading `-` would be read as a git flag; `--` in the argv guards the spawn,
  // but reject it up front for a clearer error.
  if (trimmed.startsWith("-")) return false;

  // scp-like ssh shorthand: user@host:path (no scheme, single ':' before a '/').
  // e.g. git@github.com:owner/repo.git
  if (/^[\w.+-]+@[\w.-]+:[^/].*/.test(trimmed) && !trimmed.includes("://")) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return ALLOWED_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * POST /api/git/clone
 * Clone a git repository into a target directory
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, directory } = body;

    if (!url) {
      return NextResponse.json(
        { error: "Repository URL is required" },
        { status: 400 }
      );
    }

    if (!directory) {
      return NextResponse.json(
        { error: "Target directory is required" },
        { status: 400 }
      );
    }

    if (typeof url !== "string" || !isAllowedCloneUrl(url)) {
      return NextResponse.json(
        { error: "Invalid repository URL" },
        { status: 400 }
      );
    }

    // Resolve ~ to home directory
    const resolvedDir = expandHome(directory);

    // Verify parent directory exists
    try {
      await fs.access(resolvedDir);
    } catch {
      return NextResponse.json(
        { error: `Directory does not exist: ${directory}` },
        { status: 400 }
      );
    }

    // Extract repo name from URL for the clone target
    const repoName = extractRepoName(url);
    if (!repoName) {
      return NextResponse.json(
        { error: "Could not determine repository name from URL" },
        { status: 400 }
      );
    }

    const clonePath = path.join(resolvedDir, repoName);

    // Defense in depth: the resolved clone target must stay inside resolvedDir.
    // Guards against a repoName that slips a traversal past extractRepoName.
    const resolvedParent = path.resolve(resolvedDir);
    const resolvedClone = path.resolve(clonePath);
    if (
      resolvedClone !== resolvedParent &&
      !resolvedClone.startsWith(resolvedParent + path.sep)
    ) {
      return NextResponse.json(
        { error: "Invalid repository name in URL" },
        { status: 400 }
      );
    }

    // Check if target already exists
    try {
      await fs.access(clonePath);
      return NextResponse.json(
        { error: `Directory already exists: ${clonePath}` },
        { status: 409 }
      );
    } catch {
      // Good - doesn't exist yet
    }

    // Clone the repository via execFile (no shell): url/clonePath are discrete
    // argv tokens, so shell metacharacters in the URL can't inject commands.
    // The `--` stops a `-`-leading url from being read as a git flag.
    const { stderr } = await execFileAsync(
      "git",
      ["clone", "--", url, clonePath],
      {
        timeout: 120000,
        // Windows: suppress the per-call conhost.exe console flash. No-op on POSIX.
        windowsHide: isWindows,
      }
    );

    // git clone outputs progress to stderr, not an error
    if (stderr && stderr.includes("fatal:")) {
      return NextResponse.json({ error: stderr.trim() }, { status: 500 });
    }

    return NextResponse.json({
      path: clonePath,
      name: repoName,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to clone repository";
    console.error("Error cloning repository:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export function extractRepoName(url: string): string | null {
  // https://github.com/user/repo.git or https://github.com/user/repo
  // git@github.com:user/repo.git
  const match = url.match(
    /(?:[\w.-]+\/([\w.-]+?)(?:\.git)?$|:([\w.-]+\/)([\w.-]+?)(?:\.git)?$)/
  );
  if (!match) {
    return null;
  }
  const repoName = match[1] || match[3] || null;
  if (!repoName) {
    return null;
  }
  // Reject names that are not a safe single path segment. `[\w.-]+?` admits
  // dots, so a url ending in `/..` would yield ".." and let path.join escape to
  // the parent dir. Refuse "."/".." and any embedded path separator.
  if (
    repoName === "." ||
    repoName === ".." ||
    repoName.includes("/") ||
    repoName.includes("\\")
  ) {
    return null;
  }
  return repoName;
}
