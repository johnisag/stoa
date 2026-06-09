import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "child_process";
import { resolveBinary } from "./platform";

// Resolve gh once. On Windows an npm/winget-installed `gh` may be a `.cmd` shim,
// which ENOENTs under execFile when invoked bare — resolveBinary picks a
// spawnable PATHEXT variant. `git` is a real .exe, so it stays bare.
const gh = resolveBinary("gh") || "gh";

/**
 * Run a git command via execFileSync (no shell) with an argument array, so it
 * behaves identically across platforms — no shell quoting/redirection. Mirrors
 * the helper in lib/git-status.ts.
 */
function git(
  args: string[],
  cwd: string,
  opts: { timeout?: number; stdio?: "pipe" } = {}
): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
  };
  if (opts.timeout) options.timeout = opts.timeout;
  if (opts.stdio) options.stdio = opts.stdio;
  return execFileSync("git", args, options);
}

export interface PRInfo {
  number: number;
  url: string;
  state: string;
  title: string;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
}

/**
 * Check if gh CLI is installed and authenticated
 */
export function checkGhCli(): boolean {
  try {
    execFileSync(gh, ["auth", "status"], {
      timeout: 5000,
      stdio: "pipe",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get commits between current branch and base branch
 */
export function getCommitsSinceBase(
  workingDir: string,
  baseBranch = "main"
): CommitInfo[] {
  try {
    // Get the merge base
    const mergeBase = git(
      ["merge-base", baseBranch, "HEAD"],
      workingDir
    ).trim();

    // Get commits since merge base. The --format value is a single argv token
    // with NO surrounding quotes (the old shell string quoted it); git expands
    // %n to newlines and the COMMIT_START/COMMIT_END parsing below is unchanged.
    const output = git(
      [
        "log",
        `${mergeBase}..HEAD`,
        "--format=COMMIT_START%n%H%n%s%n%b%nCOMMIT_END",
      ],
      workingDir
    );

    const commits: CommitInfo[] = [];
    const parts = output.split("COMMIT_START").filter(Boolean);

    for (const part of parts) {
      // Each part begins with the "%n" that followed COMMIT_START and ends with
      // the "%n" before COMMIT_END's trailing newline. Trim those framing
      // newlines so lines[0] is the hash — without the trim, the leading "" made
      // hash empty and this returned [] for all real `git log` output.
      const lines = part
        .trim()
        .split("\n")
        .filter((line) => line !== "COMMIT_END");
      if (lines.length >= 2) {
        const hash = lines[0].trim();
        const subject = lines[1].trim();
        const body = lines.slice(2).join("\n").trim();
        if (hash && subject) {
          commits.push({ hash, subject, body });
        }
      }
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Generate PR title from commits
 */
export function generatePRTitle(
  commits: CommitInfo[],
  branchName: string
): string {
  if (commits.length === 0) {
    // Fallback to branch name
    return branchName
      .replace(/^(feature|fix|hotfix|bugfix|chore|docs)\//i, "")
      .replace(/-/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase());
  }

  if (commits.length === 1) {
    return commits[0].subject;
  }

  // Multiple commits - try to find a common pattern or use the first one
  const firstCommit = commits[0];
  return firstCommit.subject;
}

/**
 * Generate PR body from commits
 */
export function generatePRBody(commits: CommitInfo[]): string {
  if (commits.length === 0) {
    return "## Summary\n\n_No commits yet_\n";
  }

  const lines: string[] = ["## Summary\n"];

  // List all commits
  for (const commit of commits) {
    lines.push(`- ${commit.subject}`);
  }

  lines.push("");
  lines.push("## Changes\n");

  // Add commit bodies if any have meaningful content
  for (const commit of commits) {
    if (commit.body && commit.body.length > 10) {
      lines.push(`### ${commit.subject}\n`);
      lines.push(commit.body);
      lines.push("");
    }
  }

  lines.push("## Test Plan\n");
  lines.push("- [ ] Manual testing completed");
  lines.push("- [ ] Automated tests pass");
  lines.push("");

  return lines.join("\n");
}

/**
 * Get PR for a branch
 */
export function getPRForBranch(
  workingDir: string,
  branchName: string
): PRInfo | null {
  try {
    const output = execFileSync(
      gh,
      [
        "pr",
        "list",
        "--head",
        branchName,
        "--json",
        "number,url,state,title",
        "--limit",
        "1",
      ],
      {
        cwd: workingDir,
        encoding: "utf-8",
        timeout: 10000,
        windowsHide: true,
      }
    );
    const prs = JSON.parse(output);
    return prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}

/**
 * Create a new PR
 */
export function createPR(
  workingDir: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string
): PRInfo {
  // First ensure branch is pushed
  try {
    git(["push", "-u", "origin", branchName], workingDir, {
      timeout: 30000,
      stdio: "pipe",
    });
  } catch {
    // Branch might already be pushed
  }

  // Create PR using gh CLI
  // gh pr create outputs the PR URL on success.
  // Pass arguments as an array so multi-line bodies and special characters are
  // forwarded verbatim (no shell quoting/escaping, cross-platform safe).
  const output = execFileSync(
    gh,
    ["pr", "create", "--title", title, "--base", baseBranch, "--body", body],
    {
      cwd: workingDir,
      encoding: "utf-8",
      timeout: 30000,
      windowsHide: true,
    }
  );

  // Parse URL from output (gh pr create prints the URL)
  const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  if (!urlMatch) {
    throw new Error("Failed to parse PR URL from output");
  }

  const url = urlMatch[0];
  const number = parseInt(urlMatch[1], 10);

  return {
    number,
    url,
    state: "open",
    title,
  };
}

/**
 * Get current branch name
 */
export function getCurrentBranch(workingDir: string): string {
  return git(["branch", "--show-current"], workingDir).trim();
}

/**
 * Get the default base branch (main or master)
 */
export function getBaseBranch(workingDir: string): string {
  try {
    // Try to get from remote HEAD. The shell `2>/dev/null || echo` fallback is
    // handled here in JS so this works cross-platform (no POSIX shell needed).
    const output = execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      {
        cwd: workingDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }
    ).trim();
    return output
      .replace("refs/remotes/origin/", "")
      .replace("refs/heads/", "");
  } catch {
    return "main";
  }
}
