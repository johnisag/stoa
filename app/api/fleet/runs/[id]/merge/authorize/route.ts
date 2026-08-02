import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { readCappedJsonBody } from "@/lib/fleet/http";
import {
  authorizeFleetManualLanding,
  getFleetMergeStatus,
  reconcileFleetMerges,
} from "@/lib/fleet/merge-runtime";
import type { FleetMergeTarget } from "@/lib/fleet/types";

const LANDING_BODY_MAX = 2048;
const HASH = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const parsed = await readCappedJsonBody(request, LANDING_BODY_MAX);
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
      {
        error:
          "exact expectedPlanHash, expectedExecutionHash, expectedBaseSha, and expectedIntegrationHeadSha preconditions are required",
      },
      { status: 400 }
    );
  }

  const target: FleetMergeTarget = body.target;
  const authorized = await authorizeFleetManualLanding(
    id,
    target,
    "fleet-api-admin",
    {
      planHash: body.expectedPlanHash,
      executionHash: body.expectedExecutionHash,
      baseSha: body.expectedBaseSha,
      integrationHeadSha: body.expectedIntegrationHeadSha,
    }
  );
  if ("error" in authorized) {
    return NextResponse.json(
      { error: authorized.error },
      { status: authorized.status ?? 409 }
    );
  }
  await reconcileFleetMerges({}, id);
  return NextResponse.json(getFleetMergeStatus(id), { status: 202 });
}
