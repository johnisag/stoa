import { NextRequest, NextResponse } from "next/server";
import { execFileSync, spawn } from "child_process";
import { isGitRepo, getGitStatus, expandPath } from "@/lib/git-status";
import { resolveBinary, isWindows } from "@/lib/platform";
import { buildCommitPrompt, cleanCommitMessage } from "@/lib/commit-message";

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
 * staged diff) to `claude -p` on stdin. Mirrors the spawn in
 * app/api/sessions/[id]/summarize/route.ts: resolveBinary("claude") for the
 * .cmd shim on Windows, argv array, content on stdin, post-process the reply
 * with a pure helper. The prompt is piped (not on argv) so a large diff can't
 * blow the platform argv-length limit.
 */
function draftCommitMessage(diff: string): Promise<string> {
  const prompt = buildCommitPrompt(diff);
  const binary = resolveBinary("claude") || "claude";

  return new Promise((resolve, reject) => {
    const claude = spawn(binary, ["-p"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: isWindows,
    });

    let stdout = "";
    let stderr = "";

    claude.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    claude.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    claude.on("close", (code) => {
      if (code === 0) {
        // cleanCommitMessage strips control chars (keeping newlines/tab) so the
        // text is safe to render and, later, to inject into the message box.
        resolve(cleanCommitMessage(stdout));
      } else {
        console.error("Claude CLI failed:", stderr);
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });

    claude.on("error", (err) => {
      reject(err);
    });

    // Hand the prompt to Claude on stdin (read by `claude -p`).
    claude.stdin.write(prompt);
    claude.stdin.end();
  });
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
