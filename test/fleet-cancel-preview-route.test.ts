import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { previewFleetDestructiveAction, cancelFleetRun, cancelFleetPlanner } =
  vi.hoisted(() => ({
    previewFleetDestructiveAction: vi.fn(),
    cancelFleetRun: vi.fn(),
    cancelFleetPlanner: vi.fn(),
  }));

vi.mock("@/lib/fleet/lifecycle", () => ({
  previewFleetDestructiveAction,
}));
vi.mock("@/lib/fleet/service", () => ({
  cancelFleetRun,
}));
vi.mock("@/lib/fleet/planner", () => ({
  cancelFleetPlanner,
}));

import { GET, POST } from "@/app/api/fleet/runs/[id]/cancel/route";

const params = Promise.resolve({ id: "run-1" });

describe("GET Fleet destructive cancellation preview", () => {
  beforeEach(() => {
    previewFleetDestructiveAction.mockReset();
    cancelFleetRun.mockReset();
    cancelFleetPlanner.mockReset();
    previewFleetDestructiveAction.mockResolvedValue({
      runId: "run-1",
      action: "cancel",
      revision: "b".repeat(64),
      targetDigest: "a".repeat(64),
      complete: true,
      objectLimit: 128,
      truncatedKinds: [],
      excludedWorktreeCount: 0,
      owners: [],
      sessions: [],
      worktrees: [],
      branches: [],
      artifacts: [],
      effects: {
        stopActiveSessions: true,
        deleteVerifiedWorktrees: true,
        preserveBranches: true,
        preserveArtifactMetadata: true,
        artifactBodyRetentionDays: 30,
      },
    });
  });

  it("requires admin scope before reading affected objects", async () => {
    const response = await GET(
      new NextRequest("http://x/api/fleet/runs/run-1/cancel"),
      { params }
    );

    expect(response.status).toBe(403);
    expect(previewFleetDestructiveAction).not.toHaveBeenCalled();
  });

  it("returns the exact bounded preview without caching", async () => {
    const response = await GET(
      new NextRequest("http://x/api/fleet/runs/run-1/cancel", {
        headers: { "x-stoa-scope": "admin" },
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(previewFleetDestructiveAction).toHaveBeenCalledWith("run-1");
    expect(await response.json()).toMatchObject({
      runId: "run-1",
      complete: true,
      objectLimit: 128,
    });
  });

  it("does not expose unexpected backend failures", async () => {
    previewFleetDestructiveAction.mockRejectedValueOnce(
      new Error("TOP_SECRET_PREVIEW_FAILURE")
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await GET(
      new NextRequest("http://x/api/fleet/runs/run-1/cancel", {
        headers: { "x-stoa-scope": "admin" },
      }),
      { params }
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("TOP_SECRET_PREVIEW_FAILURE");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("rejects an API bypass without a bound preview before any mutation", async () => {
    const response = await POST(
      new NextRequest("http://x/api/fleet/runs/run-1/cancel", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stoa-scope": "admin",
        },
        body: JSON.stringify({
          mode: "cancel-and-clean-owned-worktrees",
          confirm: true,
          confirmation: "run-1",
        }),
      }),
      { params }
    );

    expect(response.status).toBe(400);
    expect(cancelFleetRun).not.toHaveBeenCalled();
    expect(cancelFleetPlanner).not.toHaveBeenCalled();
  });
});
