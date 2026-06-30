import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import { isGitRepo, getGitStatus, expandPath } from "@/lib/git-status";
import { isWindows } from "@/lib/platform";
import { buildCommitPrompt, cleanCommitMessage } from "@/lib/commit-message";
import { runClaudeOneshot } from "@/lib/claude-oneshot";

/** Read the staged diff (no shell, argv array, cwd = the repo). */
function getStagedDiff(workingDir: string): string {
  // `git diff --staged` exits 0 with changes; non-zero means a real error.
  return execFileSync("git", ["diff", "--staged"], {
    cwd: workingDir,
    encoding: "utf-8",
    windowsHide: isWindows,
    maxBuffer: 20 * 1024 * 1024, // 20MB — boundDiff trims what the agent sees
  });
}

/**
 * Draft a commit message by piping the full prompt (instruction + the bounded
 * staged diff) to `claude -p` on stdin via the shared, cross-platform-safe
 * runClaudeOneshot (the prompt rides stdin — never argv — so it's both
 * argv-length-safe and injection-safe under the Windows shell). cleanCommitMessage
 * strips control chars (keeping newlines/tab) so the text is safe to render and,
 * later, to inject into the message box.
 */
async function draftCommitMessage(diff: string): Promise<string> {
  return cleanCommitMessage(await runClaudeOneshot(buildCommitPrompt(diff)));
}

// POST /api/git/commit-message - Draft a Conventional Commit message from the
// currently staged diff. Returns { message }. 400s when nothing is staged.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { path: rawPath } = body as { path?: string };

    if (!rawPath) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const path = expandPath(rawPath);

    if (!isGitRepo(path)) {
      return NextResponse.json(
        { error: "Not a git repository" },
        { status: 400 }
      );
    }

    // Guard: nothing staged → nothing to draft from.
    const status = getGitStatus(path);
    if (status.staged.length === 0) {
      return NextResponse.json(
        { error: "No staged changes to draft a message from" },
        { status: 400 }
      );
    }

    const diff = getStagedDiff(path);
    if (!diff.trim()) {
      return NextResponse.json(
        { error: "Staged diff is empty" },
        { status: 400 }
      );
    }

    const message = await draftCommitMessage(diff);
    if (!message) {
      return NextResponse.json(
        { error: "Could not generate a commit message" },
        { status: 500 }
      );
    }

    return NextResponse.json({ message });
  } catch (error) {
    console.error("Error generating commit message:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
