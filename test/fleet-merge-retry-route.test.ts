import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  retry: vi.fn(async () => ({ reopened: true, observedTargetSha: "a" })),
  abandon: vi.fn(async () => ({
    abandoned: true,
    observedTargetSha: "c",
  })),
  reconcile: vi.fn(async () => 0),
}));

vi.mock("@/lib/fleet/merge-runtime", () => ({
  abandonDivergedFleetLanding: state.abandon,
  retryFailedFleetLanding: state.retry,
  reconcileFleetMerges: state.reconcile,
  getFleetMergeStatus: () => ({ retry: { action: null } }),
}));

import { POST } from "@/app/api/fleet/runs/[id]/merge/retry/route";

const exact = {
  target: "local",
  expectedOperationId: "landing-operation-1",
  expectedPlanHash: "1".repeat(64),
  expectedExecutionHash: "2".repeat(64),
  expectedBaseSha: "a".repeat(40),
  expectedIntegrationHeadSha: "b".repeat(40),
};

function request(body: unknown, scope = "admin") {
  return new NextRequest("http://local/api/fleet/runs/run-1/merge/retry", {
    method: "POST",
    headers: { "content-type": "application/json", "x-stoa-scope": scope },
    body: JSON.stringify(body),
  });
}

describe("Fleet failed landing recovery route", () => {
  beforeEach(() => {
    state.retry.mockClear();
    state.abandon.mockClear();
    state.reconcile.mockClear();
  });

  it("requires admin authority and exact operation/head bindings", async () => {
    expect(
      (
        await POST(request(exact, "observer"), {
          params: Promise.resolve({ id: "run-1" }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await POST(request({ ...exact, expectedOperationId: "" }), {
          params: Promise.resolve({ id: "run-1" }),
        })
      ).status
    ).toBe(400);
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("reopens only the exact failed operation before reconciliation", async () => {
    const response = await POST(request(exact), {
      params: Promise.resolve({ id: "run-1" }),
    });

    expect(response.status).toBe(202);
    expect(state.retry).toHaveBeenCalledWith(
      "run-1",
      "local",
      "fleet-api-admin",
      {
        operationId: exact.expectedOperationId,
        planHash: exact.expectedPlanHash,
        executionHash: exact.expectedExecutionHash,
        baseSha: exact.expectedBaseSha,
        integrationHeadSha: exact.expectedIntegrationHeadSha,
      }
    );
    expect(state.reconcile).toHaveBeenCalledWith({}, "run-1");
  });

  it("requires exact confirmation and terminally abandons without reconciliation", async () => {
    const unconfirmed = await POST(
      request({ ...exact, action: "abandon", confirm: true }),
      { params: Promise.resolve({ id: "run-1" }) }
    );
    expect(unconfirmed.status).toBe(400);
    expect(state.abandon).not.toHaveBeenCalled();

    const response = await POST(
      request({
        ...exact,
        action: "abandon",
        confirm: true,
        confirmation: "run-1",
      }),
      { params: Promise.resolve({ id: "run-1" }) }
    );

    expect(response.status).toBe(200);
    expect(state.abandon).toHaveBeenCalledWith(
      "run-1",
      "local",
      "fleet-api-admin",
      {
        operationId: exact.expectedOperationId,
        planHash: exact.expectedPlanHash,
        executionHash: exact.expectedExecutionHash,
        baseSha: exact.expectedBaseSha,
        integrationHeadSha: exact.expectedIntegrationHeadSha,
      }
    );
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.reconcile).not.toHaveBeenCalled();
  });
});
