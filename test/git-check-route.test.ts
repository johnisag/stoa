import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { homeDir } from "@/lib/platform";

const security = vi.hoisted(() => ({
  local: vi.fn(),
  realResolve: vi.fn(),
}));

vi.mock("@/lib/api-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-security")>();
  return {
    ...actual,
    getAllowedPathRoots: () => ["/registered"],
    resolveRealSandboxedPath: security.realResolve,
    requireLocalhost: security.local,
  };
});

vi.mock("@/lib/git", () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getBranches: vi.fn().mockResolvedValue(["main", "develop"]),
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
  getCurrentBranch: vi.fn().mockResolvedValue("main"),
}));

vi.mock("@/lib/worktrees", () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  annotateWorktrees: vi.fn().mockReturnValue([
    {
      path: "/registered/worktree",
      branch: "feature/mobile-fix",
      head: "abc123",
      isStoa: true,
      attached: false,
    },
  ]),
}));

vi.mock("@/lib/repo-scan", () => ({
  findGitReposUnder: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: { getAllSessions: () => ({ all: () => [] }) },
}));

import { POST } from "@/app/api/git/check/route";

function request(body: unknown, scope?: "admin" | "observer"): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (scope) headers["x-stoa-scope"] = scope;
  return new Request("http://stoa.local/api/git/check", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  security.local.mockReset();
  security.realResolve.mockReset();
});

describe("POST /api/git/check path policy", () => {
  it("allows a remote new-session request for a registered repository", async () => {
    security.local.mockReturnValue({ ok: false, response: new Response() });
    security.realResolve.mockResolvedValue({
      allowed: true,
      resolved: "/registered/repo",
    });

    const response = await POST(request({ path: "/registered/repo" }, "admin"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isGitRepo: true,
      branches: ["main", "develop"],
      defaultBranch: "main",
      worktrees: [
        expect.objectContaining({
          path: "/registered/worktree",
          branch: "feature/mobile-fix",
          attached: false,
        }),
      ],
    });
    expect(security.realResolve).toHaveBeenCalledWith("/registered/repo", [
      "/registered",
    ]);
  });

  it("denies a remote request outside registered roots", async () => {
    security.local.mockReturnValue({ ok: false, response: new Response() });
    security.realResolve.mockResolvedValue({
      allowed: false,
      resolved: "/home/user/private",
    });

    const response = await POST(
      request({ path: "/home/user/private" }, "admin")
    );

    expect(response.status).toBe(403);
  });

  it("requires admin scope for a remote request", async () => {
    security.local.mockReturnValue({ ok: false, response: new Response() });

    for (const scope of [undefined, "observer"] as const) {
      const response = await POST(request({ path: "/registered/repo" }, scope));
      expect(response.status).toBe(403);
    }
    expect(security.realResolve).not.toHaveBeenCalled();
  });

  it("keeps home-tree project discovery available on localhost", async () => {
    security.local.mockReturnValue({ ok: true });
    security.realResolve.mockResolvedValue({
      allowed: true,
      resolved: "/home/user/new-project",
    });

    const response = await POST(request({ path: "/home/user/new-project" }));

    expect(response.status).toBe(200);
    expect(security.realResolve).toHaveBeenCalledWith(
      "/home/user/new-project",
      expect.arrayContaining(["/registered", homeDir()])
    );
  });

  it("returns 400 for valid JSON with a missing or non-string path", async () => {
    security.local.mockReturnValue({ ok: true });

    for (const body of [null, [], {}, { path: 123 }, { path: "  " }]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
    }
    expect(security.realResolve).not.toHaveBeenCalled();
  });
});
