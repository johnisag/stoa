import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import { isValidAgentType } from "@/lib/providers";
import { parseVerifySteps } from "@/lib/dispatch/verify";
import { issueSourceKind } from "@/lib/dispatch/issue-source";
import type { DispatchRepo } from "@/lib/dispatch/types";

/** Trim a verify command to null/string and validate it at SAVE time (same pure
 * parser the runner uses) so a bad command fails loudly here, not minutes later as
 * a 'verify error' on a PR card. Returns the trimmed command or an error string. */
function normalizeVerifyCommand(
  raw: unknown
): { command: string | null } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { command: null };
  const command = raw.trim();
  const parsed = parseVerifySteps(command);
  if (!("steps" in parsed)) return { error: `verify command: ${parsed.error}` };
  return { command };
}

// GET /api/dispatch/repos — list every tracked repo (the allocation console).
export async function GET() {
  try {
    const repos = queries.getAllDispatchRepos(getDb()).all() as DispatchRepo[];
    return NextResponse.json({ repos });
  } catch (error) {
    console.error("dispatch repos list failed:", error);
    return NextResponse.json({ error: "Failed to list" }, { status: 500 });
  }
}

// POST /api/dispatch/repos — track a new repo. New repos default to the safe
// posture: mode='review', disabled — nothing auto-spawns until you opt in.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const repoPath =
      typeof body?.repoPath === "string" ? body.repoPath.trim() : "";
    const repoSlug =
      typeof body?.repoSlug === "string" ? body.repoSlug.trim() : "";
    if (!repoPath || !repoSlug) {
      return NextResponse.json(
        { error: "repoPath and repoSlug are required" },
        { status: 400 }
      );
    }
    // #34: reject a `jira:`-prefixed slug up front — Jira intake isn't
    // implemented, so accepting it would create a tracked-but-dead repo. GitHub
    // (owner/name) and `linear:TEAM` are supported; an unrecognized prefix is
    // treated as a GitHub slug (its own gh error surfaces if it's bogus).
    if (issueSourceKind({ repo_slug: repoSlug }) === "jira") {
      return NextResponse.json(
        {
          error:
            "Jira intake isn't implemented yet. Use owner/name for GitHub, or linear:TEAM for Linear.",
        },
        { status: 400 }
      );
    }
    const agentType = isValidAgentType(body?.agentType)
      ? body.agentType
      : "claude";
    const mode = body?.mode === "auto" ? "auto" : "review";
    const verify = normalizeVerifyCommand(body?.verifyCommand);
    if ("error" in verify) {
      return NextResponse.json({ error: verify.error }, { status: 400 });
    }
    const id = randomUUID();
    queries
      .createDispatchRepo(getDb())
      .run(
        id,
        repoPath,
        repoSlug,
        agentType,
        Number.isFinite(body?.dailyQuota) ? Math.max(0, body.dailyQuota) : 0,
        Number.isFinite(body?.maxConcurrency)
          ? Math.max(1, body.maxConcurrency)
          : 1,
        typeof body?.labelFilter === "string" && body.labelFilter.trim()
          ? body.labelFilter.trim()
          : null,
        typeof body?.baseBranch === "string" && body.baseBranch.trim()
          ? body.baseBranch.trim()
          : "main",
        mode,
        body?.enabled ? 1 : 0,
        body?.reviewGate ? 1 : 0,
        body?.ciAutofix ? 1 : 0,
        body?.mergeTrain ? 1 : 0,
        body?.verifyGate ? 1 : 0,
        verify.command,
        typeof body?.projectId === "string" ? body.projectId : null
      );
    const repo = queries.getDispatchRepo(getDb()).get(id) as DispatchRepo;
    return NextResponse.json({ repo }, { status: 201 });
  } catch (error) {
    console.error("dispatch repo create failed:", error);
    return NextResponse.json({ error: "Failed to create" }, { status: 500 });
  }
}
