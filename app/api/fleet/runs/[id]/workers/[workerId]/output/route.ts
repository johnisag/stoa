import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import {
  captureFleetWorkerOutput,
  FLEET_WORKER_OUTPUT_DEFAULT_LINES,
  FLEET_WORKER_OUTPUT_ID_MAX,
} from "@/lib/fleet/worker-output";

const OUTPUT_QUERY_MAX = 512;
const ALLOWED_QUERY_KEYS = new Set([
  "expectedAttempt",
  "expectedSessionId",
  "lines",
]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; workerId: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 0) {
    return NextResponse.json(
      { error: "worker output reads do not accept a body" },
      { status: 413 }
    );
  }
  if (request.nextUrl.search.length > OUTPUT_QUERY_MAX) {
    return NextResponse.json(
      { error: "worker output query is too large" },
      { status: 414 }
    );
  }
  const keys = [...request.nextUrl.searchParams.keys()];
  if (
    keys.some(
      (key) =>
        !ALLOWED_QUERY_KEYS.has(key) ||
        request.nextUrl.searchParams.getAll(key).length !== 1
    )
  ) {
    return NextResponse.json(
      { error: "invalid worker output query" },
      { status: 400 }
    );
  }

  const { id, workerId } = await params;
  const expectedSessionId =
    request.nextUrl.searchParams.get("expectedSessionId") ?? "";
  const expectedAttemptText =
    request.nextUrl.searchParams.get("expectedAttempt") ?? "";
  const linesText = request.nextUrl.searchParams.get("lines");
  if (
    id.length > FLEET_WORKER_OUTPUT_ID_MAX ||
    workerId.length > FLEET_WORKER_OUTPUT_ID_MAX ||
    expectedSessionId.length > FLEET_WORKER_OUTPUT_ID_MAX ||
    !/^\d+$/.test(expectedAttemptText) ||
    (linesText != null && !/^\d+$/.test(linesText))
  ) {
    return NextResponse.json(
      { error: "invalid worker output binding" },
      { status: 400 }
    );
  }

  try {
    const result = await captureFleetWorkerOutput({
      runId: id,
      workerId,
      expectedAttempt: Number(expectedAttemptText),
      expectedSessionId,
      lines:
        linesText == null
          ? FLEET_WORKER_OUTPUT_DEFAULT_LINES
          : Number(linesText),
    });
    if (result.ok) {
      return NextResponse.json(result.output, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const headers =
      result.status === 429
        ? {
            "Retry-After": result.retryAt
              ? new Date(result.retryAt).toUTCString()
              : "60",
          }
        : undefined;
    return NextResponse.json(
      { error: result.error, retryAt: result.retryAt ?? undefined },
      { status: result.status, headers }
    );
  } catch (error) {
    console.error("[fleet] rendered worker output failed:", error);
    return NextResponse.json(
      { error: "Failed to capture rendered Fleet worker output" },
      { status: 500 }
    );
  }
}
