import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDb, queries, type Session } from "@/lib/db";
import { requireLocalhost, parseJsonBody } from "@/lib/api-security";

// Use execFile (no shell) so titles/bodies/branches pass as single argv
// entries with no quoting/escaping. This is cross-platform safe (notably on
// native Windows / cmd.exe where POSIX backslash-escaping mangles multi-line
// titles and risks injection).
const execFileAsync = promisify(execFile);

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface PRInfo {
  number: number;
  url: string;
  state: string;
  title: string;
}

/**
 * Parse the PR number + URL from `gh pr create` stdout. `gh pr create` prints
 * the PR URL on success (it does NOT support `--json`), so we extract it the
 * same way lib/pr.ts createPR does. Host-agnostic: matches any https URL ending
 * in `/pull/<digits>` so GitHub Enterprise hosts (e.g. https://ghe.corp/...)
 * parse too. Returns null when no URL is present.
 */
export function parsePRCreateOutput(
  stdout: string
): { number: number; url: string } | null {
  const match = stdout.match(/https?:\/\/\S+?\/pull\/(\d+)/);
  if (!match) return null;
  return { url: match[0], number: parseInt(match[1], 10) };
}

/**
 * Check if gh CLI is installed and authenticated
 */
async function checkGhCli(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["auth", "status"], {
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get PR info for a branch
 */
async function getPRForBranch(
  projectPath: string,
  branchName: string
): Promise<PRInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
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
      { cwd: projectPath, timeout: 10000, windowsHide: true }
    );
    const prs = JSON.parse(stdout);
    return prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}

/**
 * Create a new PR for a branch
 */
async function createPR(
  projectPath: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body?: string
): Promise<PRInfo> {
  // First push the branch if not already pushed
  try {
    await execFileAsync("git", ["push", "-u", "origin", branchName], {
      cwd: projectPath,
      timeout: 30000,
      windowsHide: true,
    });
  } catch {
    // Branch might already be pushed, continue
  }

  // `gh pr create` prints the PR URL on success — it does NOT support `--json`
  // (passing it makes gh exit non-zero with "unknown flag: --json"). Parse the
  // URL from stdout, mirroring lib/pr.ts createPR.
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "create",
      "--title",
      title,
      "--base",
      baseBranch,
      "--body",
      body ?? "",
    ],
    { cwd: projectPath, timeout: 30000, windowsHide: true }
  );

  const created = parsePRCreateOutput(stdout);
  if (!created) {
    throw new Error("Failed to parse PR URL from output");
  }

  // Prefer the structured fields gh exposes via `pr list --json`; fall back to
  // the freshly-created URL/number if the list query hasn't caught up yet.
  const listed = await getPRForBranch(projectPath, branchName);
  return (
    listed ?? {
      number: created.number,
      url: created.url,
      state: "open",
      title,
    }
  );
}

// GET /api/sessions/[id]/pr - Get PR info for session
export async function GET(request: NextRequest, { params }: RouteParams) {
  const auth = requireLocalhost(request);
  if (!auth.ok) return auth.response;

  try {
    const { id } = await params;
    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (!session.worktree_path || !session.branch_name) {
      return NextResponse.json(
        { error: "Session is not a worktree session" },
        { status: 400 }
      );
    }

    // Check gh CLI
    if (!(await checkGhCli())) {
      return NextResponse.json(
        {
          error:
            "GitHub CLI not installed or not authenticated. Run 'gh auth login' first.",
        },
        { status: 400 }
      );
    }

    const pr = await getPRForBranch(session.worktree_path, session.branch_name);

    // Update session with PR info if found
    if (pr) {
      queries.updateSessionPR(db).run(pr.url, pr.number, pr.state, id);
    }

    return NextResponse.json({ pr });
  } catch (error) {
    console.error("Error fetching PR:", error);
    return NextResponse.json(
      { error: "Failed to fetch PR info" },
      { status: 500 }
    );
  }
}

// POST /api/sessions/[id]/pr - Create PR for session
export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = requireLocalhost(request);
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody<{
    title?: string;
    description?: string;
  }>(request);
  if (!parsed.ok) return parsed.response;

  try {
    const { id } = await params;
    const { title, description } = parsed.data;

    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (!session.worktree_path || !session.branch_name) {
      return NextResponse.json(
        { error: "Session is not a worktree session" },
        { status: 400 }
      );
    }

    // Check gh CLI
    if (!(await checkGhCli())) {
      return NextResponse.json(
        {
          error:
            "GitHub CLI not installed or not authenticated. Run 'gh auth login' first.",
        },
        { status: 400 }
      );
    }

    // Check if PR already exists
    const existingPR = await getPRForBranch(
      session.worktree_path,
      session.branch_name
    );
    if (existingPR) {
      return NextResponse.json(
        { error: "PR already exists for this branch", pr: existingPR },
        { status: 409 }
      );
    }

    // Create PR
    const prTitle = title || session.name;
    const pr = await createPR(
      session.worktree_path,
      session.branch_name,
      session.base_branch || "main",
      prTitle,
      description
    );

    // Save PR info to session
    queries.updateSessionPR(db).run(pr.url, pr.number, pr.state, id);

    return NextResponse.json({ pr }, { status: 201 });
  } catch (error) {
    console.error("Error creating PR:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to create PR: ${message}` },
      { status: 500 }
    );
  }
}
