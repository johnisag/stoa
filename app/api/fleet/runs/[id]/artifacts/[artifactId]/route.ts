import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { readFleetArtifactBody } from "@/lib/fleet/artifact-read";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; artifactId: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 0) {
    return NextResponse.json(
      { error: "artifact body reads do not accept a body" },
      { status: 413 }
    );
  }
  if (request.nextUrl.search.length > 0) {
    return NextResponse.json(
      { error: "artifact body reads do not accept query parameters" },
      { status: 400 }
    );
  }
  const { id, artifactId } = await params;
  try {
    const result = readFleetArtifactBody({ runId: id, artifactId });
    return result.ok
      ? NextResponse.json(result.artifact, {
          headers: { "Cache-Control": "no-store" },
        })
      : NextResponse.json({ error: result.error }, { status: result.status });
  } catch (error) {
    console.error("[fleet] artifact body read failed:", error);
    return NextResponse.json(
      { error: "Failed to read Fleet artifact body" },
      { status: 500 }
    );
  }
}
