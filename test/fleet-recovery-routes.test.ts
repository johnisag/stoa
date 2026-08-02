import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startFleetPlanner: vi.fn(),
  cancelFleetPlanner: vi.fn(),
  requestFleetMerge: vi.fn(),
  reconcileFleetMerges: vi.fn(),
  getFleetMergeStatus: vi.fn(),
  getFleetRunDetail: vi.fn(),
}));

vi.mock("@/lib/fleet/planner", () => ({
  startFleetPlanner: mocks.startFleetPlanner,
  cancelFleetPlanner: mocks.cancelFleetPlanner,
}));
vi.mock("@/lib/fleet/merge-runtime", () => ({
  requestFleetMerge: mocks.requestFleetMerge,
  reconcileFleetMerges: mocks.reconcileFleetMerges,
  getFleetMergeStatus: mocks.getFleetMergeStatus,
}));
vi.mock("@/lib/fleet/service", () => ({
  getFleetRunDetail: mocks.getFleetRunDetail,
}));

import { POST as generate } from "@/app/api/fleet/runs/[id]/generate/route";
import { POST as merge } from "@/app/api/fleet/runs/[id]/merge/route";

const params = Promise.resolve({ id: "run-1" });

describe("Fleet recovery route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startFleetPlanner.mockResolvedValue({
      error: "fleet scheduler recovery is not ready",
      status: 503,
    });
    mocks.requestFleetMerge.mockResolvedValue({
      error: "fleet scheduler recovery is not ready",
      status: 503,
    });
  });

  it("maps planner recovery refusal to 503", async () => {
    const response = await generate(
      new NextRequest("http://local/api/fleet/runs/run-1/generate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stoa-scope": "admin",
        },
        body: "{}",
      }),
      { params }
    );
    expect(response.status).toBe(503);
  });

  it("does not dispatch merge reconciliation after recovery refusal", async () => {
    const response = await merge(
      new NextRequest("http://local/api/fleet/runs/run-1/merge", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stoa-scope": "admin",
        },
        body: JSON.stringify({
          target: "local",
          expectedPlanHash: "a".repeat(64),
          expectedBaseSha: "b".repeat(40),
          expectedIntegrationHeadSha: null,
        }),
      }),
      { params }
    );
    expect(response.status).toBe(503);
    expect(mocks.reconcileFleetMerges).not.toHaveBeenCalled();
  });
});
