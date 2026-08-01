import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFleetArtifactBody } = vi.hoisted(() => ({
  readFleetArtifactBody: vi.fn(),
}));
vi.mock("@/lib/fleet/artifact-read", () => ({ readFleetArtifactBody }));

import { GET } from "@/app/api/fleet/runs/[id]/artifacts/[artifactId]/route";

const params = Promise.resolve({ id: "run-1", artifactId: "artifact-1" });

describe("GET Fleet artifact body", () => {
  beforeEach(() => {
    readFleetArtifactBody.mockReset();
    readFleetArtifactBody.mockReturnValue({
      ok: true,
      artifact: {
        id: "artifact-1",
        contentHash: "a".repeat(64),
        byteCount: 4,
        body: "body",
        bodyPrunedAt: null,
      },
    });
  });

  it("requires admin scope", async () => {
    const response = await GET(
      new NextRequest("http://x/api/fleet/runs/run-1/artifacts/artifact-1"),
      { params }
    );
    expect(response.status).toBe(403);
    expect(readFleetArtifactBody).not.toHaveBeenCalled();
  });

  it("reads one exact binding without caching", async () => {
    const response = await GET(
      new NextRequest("http://x/api/fleet/runs/run-1/artifacts/artifact-1", {
        headers: { "x-stoa-scope": "admin" },
      }),
      { params }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readFleetArtifactBody).toHaveBeenCalledWith({
      runId: "run-1",
      artifactId: "artifact-1",
    });
  });

  it("rejects request bodies and query parameters before reading", async () => {
    const withBody = await GET(
      new NextRequest("http://x/api/fleet/runs/run-1/artifacts/artifact-1", {
        method: "GET",
        headers: {
          "x-stoa-scope": "admin",
          "content-length": "1",
        },
      }),
      { params }
    );
    const withQuery = await GET(
      new NextRequest(
        "http://x/api/fleet/runs/run-1/artifacts/artifact-1?raw=true",
        { headers: { "x-stoa-scope": "admin" } }
      ),
      { params }
    );
    expect(withBody.status).toBe(413);
    expect(withQuery.status).toBe(400);
    expect(readFleetArtifactBody).not.toHaveBeenCalled();
  });

  it("does not expose unexpected backend failures", async () => {
    readFleetArtifactBody.mockImplementationOnce(() => {
      throw new Error("TOP_SECRET_ARTIFACT_FAILURE");
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await GET(
      new NextRequest("http://x/api/fleet/runs/run-1/artifacts/artifact-1", {
        headers: { "x-stoa-scope": "admin" },
      }),
      { params }
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("TOP_SECRET_ARTIFACT_FAILURE");
    consoleError.mockRestore();
  });
});
