import { NextRequest, NextResponse } from "next/server";
import {
  push,
  isGitRepo,
  hasUpstream,
  getRemoteUrl,
  getGitStatus,
  expandPath,
} from "@/lib/git-status";
import {
  parseJsonBody,
  getAllowedPathRoots,
  resolveSandboxedPath,
} from "@/lib/api-security";

export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{ path?: string }>(request);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const { path: rawPath } = body;

  if (!rawPath) {
    return NextResponse.json({ error: "Path is required" }, { status: 400 });
  }

  const expandedPath = expandPath(rawPath);
  const roots = getAllowedPathRoots();
  const { allowed } = resolveSandboxedPath(expandedPath, roots);
  if (!allowed) {
    return NextResponse.json(
      { error: "Path is outside the allowed workspace" },
      { status: 403 }
    );
  }

  if (!isGitRepo(expandedPath)) {
    return NextResponse.json(
      { error: "Not a git repository" },
      { status: 400 }
    );
  }

  try {
    // Check if remote exists
    const remoteUrl = getRemoteUrl(expandedPath);
    if (!remoteUrl) {
      return NextResponse.json(
        { error: "No remote origin configured" },
        { status: 400 }
      );
    }

    // Check if there are commits to push
    const status = getGitStatus(expandedPath);
    if (status.ahead === 0) {
      return NextResponse.json({
        success: true,
        message: "Already up to date",
        pushed: false,
      });
    }

    // Push (set upstream if needed)
    const needsUpstream = !hasUpstream(expandedPath);
    const output = push(expandedPath, needsUpstream);

    return NextResponse.json({
      success: true,
      output,
      pushed: true,
      setUpstream: needsUpstream,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to push" },
      { status: 500 }
    );
  }
}
