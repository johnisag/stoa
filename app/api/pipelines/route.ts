import { NextResponse } from "next/server";
import { startPipeline, PipelineRequestError } from "@/lib/pipeline/start";
import { listRuns } from "@/lib/pipeline/registry";
import type { PipelineSpec } from "@/lib/pipeline/types";

/**
 * POST /api/pipelines — start a declarative agent pipeline.
 * Body: { conductorSessionId: string, spec: PipelineSpec }
 * Returns the initial run; poll GET /api/pipelines/[id] for progress.
 *
 * GET /api/pipelines — list recent runs (newest first).
 */
export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be valid JSON" },
        { status: 400 }
      );
    }
    if (typeof body !== "object" || body === null) {
      return NextResponse.json(
        { error: "Request body must be a JSON object" },
        { status: 400 }
      );
    }
    const { conductorSessionId, spec } = body as {
      conductorSessionId?: string;
      spec?: PipelineSpec;
    };

    if (!conductorSessionId || !spec) {
      return NextResponse.json(
        { error: "Missing required fields: conductorSessionId, spec" },
        { status: 400 }
      );
    }

    const { run } = startPipeline(spec, conductorSessionId);
    return NextResponse.json({ run });
  } catch (error) {
    // A PipelineRequestError is a client error (invalid spec / unknown
    // conductor); anything else is a server fault.
    if (error instanceof PipelineRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message =
      error instanceof Error ? error.message : "Failed to start pipeline";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ runs: listRuns() });
}
