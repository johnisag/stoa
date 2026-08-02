import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authorize: vi.fn(async () => ({ readiness: { requested: true } })),
  reconcile: vi.fn(async () => 0),
}));

vi.mock("@/lib/fleet/merge-runtime", () => ({
  authorizeFleetManualLanding: state.authorize,
  reconcileFleetMerges: state.reconcile,
  getFleetMergeStatus: () => ({ readiness: { requested: true } }),
}));

import { POST } from "@/app/api/fleet/runs/[id]/merge/authorize/route";

const exact = {
  target: "github_pr",
  expectedPlanHash: "1".repeat(64),
  expectedExecutionHash: "2".repeat(64),
  expectedBaseSha: "a".repeat(40),
  expectedIntegrationHeadSha: "b".repeat(40),
};

function request(body: unknown, scope = "admin") {
  return new NextRequest("http://local/api/fleet/runs/run-1/merge/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", "x-stoa-scope": scope },
    body: JSON.stringify(body),
  });
}

describe("Fleet manual landing authorization route", () => {
  beforeEach(() => {
    state.authorize.mockClear();
    state.reconcile.mockClear();
  });

  it("requires admin authority and all exact landing bindings", async () => {
    expect(
      (
        await POST(request(exact, "observer"), {
          params: Promise.resolve({ id: "run-1" }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await POST(request({ ...exact, expectedIntegrationHeadSha: null }), {
          params: Promise.resolve({ id: "run-1" }),
        })
      ).status
    ).toBe(400);
    expect(state.authorize).not.toHaveBeenCalled();
  });

  it("passes the exact second-action contract and only then reconciles landing", async () => {
    const response = await POST(request(exact), {
      params: Promise.resolve({ id: "run-1" }),
    });

    expect(response.status).toBe(202);
    expect(state.authorize).toHaveBeenCalledWith(
      "run-1",
      "github_pr",
      "fleet-api-admin",
      {
        planHash: exact.expectedPlanHash,
        executionHash: exact.expectedExecutionHash,
        baseSha: exact.expectedBaseSha,
        integrationHeadSha: exact.expectedIntegrationHeadSha,
      }
    );
    expect(state.reconcile).toHaveBeenCalledWith({}, "run-1");
  });
});
