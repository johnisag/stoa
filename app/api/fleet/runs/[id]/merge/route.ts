import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { readCappedJsonBody } from "@/lib/fleet/http";
import {
  getFleetMergeStatus,
  reconcileFleetMerges,
  requestFleetMerge,
} from "@/lib/fleet/merge-runtime";
import type { FleetMergeTarget } from "@/lib/fleet/types";
import { getFleetRunDetail } from "@/lib/fleet/service";

const MERGE_BODY_MAX = 2048;
const PLAN_HASH = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const status = getFleetMergeStatus(id);
  return status
    ? NextResponse.json(status)
    : NextResponse.json({ error: "Fleet run not found" }, { status: 404 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const parsed = await readCappedJsonBody(request, MERGE_BODY_MAX);
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status }
    );
  }
  const body =
    parsed.body && typeof parsed.body === "object"
      ? (parsed.body as Record<string, unknown>)
      : {};
  if (body.dryRun === true) {
    const status = getFleetMergeStatus(id);
    const detail = getFleetRunDetail(id);
    return status
      ? NextResponse.json({
          ...status,
          dryRun: true,
          requestPreconditions: {
            expectedPlanHash: detail?.run.planHash ?? null,
            expectedBaseSha: detail?.run.automationBaseSha ?? null,
            expectedIntegrationHeadSha: status.integration.headSha,
          },
        })
      : NextResponse.json({ error: "Fleet run not found" }, { status: 404 });
  }
  if (body.target !== "local" && body.target !== "github_pr") {
    return NextResponse.json(
      { error: "target must be local or github_pr" },
      { status: 400 }
    );
  }
  if (
    typeof body.expectedPlanHash !== "string" ||
    !PLAN_HASH.test(body.expectedPlanHash) ||
    !(
      body.expectedBaseSha === null ||
      (typeof body.expectedBaseSha === "string" &&
        GIT_SHA.test(body.expectedBaseSha))
    ) ||
    !(
      body.expectedIntegrationHeadSha === null ||
      (typeof body.expectedIntegrationHeadSha === "string" &&
        GIT_SHA.test(body.expectedIntegrationHeadSha))
    )
  ) {
    return NextResponse.json(
      {
        error:
          "exact expectedPlanHash, expectedBaseSha, and expectedIntegrationHeadSha preconditions are required",
      },
      { status: 400 }
    );
  }
  const target: FleetMergeTarget = body.target;
  const requested = await requestFleetMerge(
    id,
    target,
    "fleet-api-admin",
    {},
    {
      planHash: body.expectedPlanHash,
      baseSha: body.expectedBaseSha,
      integrationHeadSha: body.expectedIntegrationHeadSha,
    }
  );
  if ("error" in requested) {
    return NextResponse.json({ error: requested.error }, { status: 409 });
  }
  await reconcileFleetMerges({}, id);
  return NextResponse.json(getFleetMergeStatus(id), { status: 202 });
}
