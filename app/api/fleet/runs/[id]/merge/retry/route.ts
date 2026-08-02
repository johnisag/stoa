import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { readCappedJsonBody } from "@/lib/fleet/http";
import {
  getFleetMergeStatus,
  reconcileFleetMerges,
  retryFailedFleetLanding,
} from "@/lib/fleet/merge-runtime";

const RECOVERY_BODY_MAX = 4096;
const HASH = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const parsed = await readCappedJsonBody(request, RECOVERY_BODY_MAX);
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status }
    );
  }
  const body =
    parsed.body &&
    typeof parsed.body === "object" &&
    !Array.isArray(parsed.body)
      ? (parsed.body as Record<string, unknown>)
      : {};
  if (body.target !== "local" && body.target !== "github_pr") {
    return NextResponse.json(
      { error: "target must be local or github_pr" },
      { status: 400 }
    );
  }
  if (
    typeof body.expectedOperationId !== "string" ||
    body.expectedOperationId.length === 0 ||
    body.expectedOperationId.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(body.expectedOperationId) ||
    typeof body.expectedPlanHash !== "string" ||
    !HASH.test(body.expectedPlanHash) ||
    typeof body.expectedExecutionHash !== "string" ||
    !HASH.test(body.expectedExecutionHash) ||
    typeof body.expectedBaseSha !== "string" ||
    !GIT_SHA.test(body.expectedBaseSha) ||
    typeof body.expectedIntegrationHeadSha !== "string" ||
    !GIT_SHA.test(body.expectedIntegrationHeadSha)
  ) {
    return NextResponse.json(
      { error: "exact failed-landing recovery preconditions are required" },
      { status: 400 }
    );
  }

  const recovered = await retryFailedFleetLanding(
    id,
    body.target,
    "fleet-api-admin",
    {
      operationId: body.expectedOperationId,
      planHash: body.expectedPlanHash,
      executionHash: body.expectedExecutionHash,
      baseSha: body.expectedBaseSha,
      integrationHeadSha: body.expectedIntegrationHeadSha,
    }
  );
  if ("error" in recovered) {
    return NextResponse.json(
      { error: recovered.error },
      { status: recovered.status ?? 409 }
    );
  }
  await reconcileFleetMerges({}, id);
  return NextResponse.json(getFleetMergeStatus(id), { status: 202 });
}
