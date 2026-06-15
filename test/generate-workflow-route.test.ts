/**
 * POST /api/command/generate-workflow — the generator route. Mocks the live seams
 * (runAsk spawn + gatherStoaContext + getAllProjects) so the test is pure and
 * cross-platform: a valid design returns a laid-out workflow doc; prose, an
 * invalid design, a spawn failure, a bad provider, and an unknown project all
 * degrade safely. Audit is disabled (STOA_AUDIT=0) so no DB is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRunAsk = vi.hoisted(() => vi.fn());
const mockGetAllProjects = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ask", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ask")>();
  return { ...actual, runAsk: mockRunAsk };
});
vi.mock("@/lib/projects", () => ({ getAllProjects: mockGetAllProjects }));

import { POST } from "@/app/api/command/generate-workflow/route";
import type { NextRequest } from "next/server";

function req(body: unknown): NextRequest {
  return new Request("http://localhost/api/command/generate-workflow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const PROJECT = {
  id: "proj_1",
  name: "the-grid",
  working_directory: "/home/u/grid",
  agent_type: "claude",
};

const validDesign = JSON.stringify({
  kind: "workflow",
  spec: {
    name: "Build the thing",
    steps: [
      {
        id: "r1",
        role: "researcher",
        task: "Research the space. Write findings to STOA_OUTPUT.md",
        outputFile: "STOA_OUTPUT.md",
      },
      {
        id: "review",
        role: "review-gate",
        task: "Review {{steps.r1.output}} on all 3 dimensions and sign off.",
        dependsOn: ["r1"],
      },
    ],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STOA_AUDIT = "0"; // audit no-op → no DB
  mockGetAllProjects.mockReturnValue([PROJECT]);
});

afterEach(() => {
  delete process.env.STOA_AUDIT;
});

describe("POST /api/command/generate-workflow", () => {
  it("returns 400 for a missing summary", async () => {
    const res = await POST(req({ projectId: "proj_1" }));
    expect(res.status).toBe(400);
    expect(mockRunAsk).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown provider", async () => {
    const res = await POST(
      req({ summary: "build x", projectId: "proj_1", provider: "evil" })
    );
    expect(res.status).toBe(400);
    expect(mockRunAsk).not.toHaveBeenCalled();
  });

  it("degrades to an answer (no spawn) when the project is unknown", async () => {
    mockGetAllProjects.mockReturnValue([]);
    const res = await POST(req({ summary: "build x", projectId: "nope" }));
    const j = await res.json();
    expect(j.kind).toBe("answer");
    expect(mockRunAsk).not.toHaveBeenCalled();
  });

  it("returns a validated, project-stamped workflow doc on a good design", async () => {
    mockRunAsk.mockResolvedValue(validDesign);
    const res = await POST(req({ summary: "build x", projectId: "proj_1" }));
    const j = await res.json();
    expect(j.kind).toBe("workflow");
    expect(j.doc.nodes).toHaveLength(2);
    expect(j.doc.workingDirectory).toBe(PROJECT.working_directory);
    expect(j.doc.projectId).toBe("proj_1");
    expect(j.project).toEqual({ id: "proj_1", name: "the-grid" });
    // The generator runs the agent in one-shot mode with a generous timeout
    // (a fleet design is bigger than a one-line answer).
    expect(mockRunAsk).toHaveBeenCalledTimes(1);
    expect(mockRunAsk.mock.calls[0][2]).toMatchObject({ timeoutMs: 120_000 });
  });

  it("degrades to an answer when the agent replies in prose", async () => {
    mockRunAsk.mockResolvedValue(
      "I'd suggest a SIMPLER_APPROACH_MARKER first."
    );
    const res = await POST(req({ summary: "build x", projectId: "proj_1" }));
    const j = await res.json();
    expect(j.kind).toBe("answer");
    expect(j.text).toContain("SIMPLER_APPROACH_MARKER");
  });

  it("degrades to an answer when the design fails validation (e.g. a cycle)", async () => {
    mockRunAsk.mockResolvedValue(
      JSON.stringify({
        kind: "workflow",
        spec: {
          name: "X",
          steps: [
            { id: "a", role: "researcher", task: "t", dependsOn: ["b"] },
            { id: "b", role: "architect", task: "t", dependsOn: ["a"] },
          ],
        },
      })
    );
    const res = await POST(req({ summary: "build x", projectId: "proj_1" }));
    const j = await res.json();
    expect(j.kind).toBe("answer");
    expect(j.text).toMatch(/validation/i);
  });

  it("returns 502 when the agent spawn fails", async () => {
    mockRunAsk.mockRejectedValue(new Error("ENOENT"));
    const res = await POST(req({ summary: "build x", projectId: "proj_1" }));
    expect(res.status).toBe(502);
  });
});
