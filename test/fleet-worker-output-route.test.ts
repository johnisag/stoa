import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureFleetWorkerOutput } = vi.hoisted(() => ({
  captureFleetWorkerOutput: vi.fn(),
}));
vi.mock("@/lib/fleet/worker-output", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/fleet/worker-output")>();
  return { ...actual, captureFleetWorkerOutput };
});

import { GET } from "@/app/api/fleet/runs/[id]/workers/[workerId]/output/route";

const params = Promise.resolve({ id: "run-1", workerId: "worker-1" });

describe("GET Fleet worker output", () => {
  beforeEach(() => {
    captureFleetWorkerOutput.mockReset();
    captureFleetWorkerOutput.mockResolvedValue({
      ok: true,
      output: {
        runId: "run-1",
        workerId: "worker-1",
        attempt: 3,
        sessionId: "session-1",
        lines: 1,
        output: "rendered",
        truncated: false,
        capturedAt: "2026-08-01T00:00:00.000Z",
      },
    });
  });

  it("requires admin scope for the otherwise read-only route", async () => {
    const response = await GET(
      new NextRequest(
        "http://x/api/fleet/runs/run-1/workers/worker-1/output?expectedAttempt=3&expectedSessionId=session-1"
      ),
      { params }
    );
    expect(response.status).toBe(403);
    expect(captureFleetWorkerOutput).not.toHaveBeenCalled();
  });

  it("passes an exact bounded binding and disables caching", async () => {
    const response = await GET(
      new NextRequest(
        "http://x/api/fleet/runs/run-1/workers/worker-1/output?expectedAttempt=3&expectedSessionId=session-1&lines=40",
        { headers: { "x-stoa-scope": "admin" } }
      ),
      { params }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(captureFleetWorkerOutput).toHaveBeenCalledWith({
      runId: "run-1",
      workerId: "worker-1",
      expectedAttempt: 3,
      expectedSessionId: "session-1",
      lines: 40,
    });
  });

  it("rejects duplicate, unknown, malformed, and oversized query input", async () => {
    for (const query of [
      "expectedAttempt=3&expectedAttempt=4&expectedSessionId=session-1",
      "expectedAttempt=3&expectedSessionId=session-1&raw=true",
      "expectedAttempt=3.5&expectedSessionId=session-1",
      `expectedAttempt=3&expectedSessionId=${"x".repeat(600)}`,
    ]) {
      const response = await GET(
        new NextRequest(
          `http://x/api/fleet/runs/run-1/workers/worker-1/output?${query}`,
          { headers: { "x-stoa-scope": "admin" } }
        ),
        { params }
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(captureFleetWorkerOutput).not.toHaveBeenCalled();
  });

  it("does not expose backend failures", async () => {
    captureFleetWorkerOutput.mockRejectedValueOnce(
      new Error("TOP_SECRET_BACKEND_DETAIL")
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await GET(
      new NextRequest(
        "http://x/api/fleet/runs/run-1/workers/worker-1/output?expectedAttempt=3&expectedSessionId=session-1",
        { headers: { "x-stoa-scope": "admin" } }
      ),
      { params }
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("TOP_SECRET_BACKEND_DETAIL");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("returns a retry boundary without returning quota-blocked output", async () => {
    captureFleetWorkerOutput.mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: "Fleet rendered output quota exceeded",
      retryAt: null,
    });
    const response = await GET(
      new NextRequest(
        "http://x/api/fleet/runs/run-1/workers/worker-1/output?expectedAttempt=3&expectedSessionId=session-1",
        { headers: { "x-stoa-scope": "admin" } }
      ),
      { params }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({
      error: "Fleet rendered output quota exceeded",
    });
  });
});
