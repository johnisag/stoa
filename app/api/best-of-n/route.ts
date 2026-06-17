import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/projects";
import { createBonRun, listBonRuns, BON_N_MIN, BON_N_MAX } from "@/lib/best-of-n";

/**
 * GET /api/best-of-n — list recent Best-of-N runs (optionally filtered by projectId).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId") ?? undefined;
    const runs = listBonRuns(projectId);
    return NextResponse.json({ runs });
  } catch (error) {
    console.error("[best-of-n] GET /api/best-of-n failed:", error);
    return NextResponse.json({ error: "Failed to list runs" }, { status: 500 });
  }
}

/**
 * POST /api/best-of-n — create a new Best-of-N run.
 *
 * Body: { task, n, projectId, baseBranch?, conductorSessionId }
 * Response: { run, candidates }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { task, n, projectId, baseBranch, conductorSessionId } = body as {
    task?: unknown;
    n?: unknown;
    projectId?: unknown;
    baseBranch?: unknown;
    conductorSessionId?: unknown;
  };

  // Validate required fields.
  if (typeof task !== "string" || !task.trim()) {
    return NextResponse.json(
      { error: "task is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  const nNum = typeof n === "number" ? n : parseInt(String(n), 10);
  if (!Number.isInteger(nNum) || nNum < BON_N_MIN || nNum > BON_N_MAX) {
    return NextResponse.json(
      { error: `n must be an integer between ${BON_N_MIN} and ${BON_N_MAX}` },
      { status: 400 }
    );
  }

  if (typeof projectId !== "string" || !projectId.trim()) {
    return NextResponse.json(
      { error: "projectId is required" },
      { status: 400 }
    );
  }

  if (typeof conductorSessionId !== "string" || !conductorSessionId.trim()) {
    return NextResponse.json(
      { error: "conductorSessionId is required" },
      { status: 400 }
    );
  }

  // Resolve the project SERVER-SIDE — never trust a client-supplied path.
  const project = getProject(projectId.trim());
  if (!project) {
    return NextResponse.json({ error: "Unknown project" }, { status: 400 });
  }

  try {
    const result = await createBonRun({
      task: task.trim(),
      n: nNum,
      projectId: project.id,
      baseBranch: typeof baseBranch === "string" ? baseBranch : undefined,
      conductorSessionId: conductorSessionId.trim(),
      workingDirectory: project.working_directory,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[best-of-n] createBonRun failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create Best-of-N run",
      },
      { status: 500 }
    );
  }
}
