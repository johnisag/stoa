/**
 * /api/files GET — the folder picker's `browse=1` listing mode. It LISTS
 * directories outside the registered workspace roots (so a user can navigate the
 * filesystem to pick a new project dir) while every other caller stays sandboxed,
 * and it is forced shallow (a crafted browse+recursive call must not deep-walk the
 * host). Reading file CONTENTS stays strict (a different route).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const listDirectory = vi.hoisted(() =>
  vi.fn(() => [{ name: "proj", path: "/x/proj", type: "directory" }])
);
vi.mock("@/lib/files", () => ({ listDirectory }));

const resolveSandboxedPath = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-security", () => ({
  getAllowedPathRoots: () => ["/allowed"],
  resolveSandboxedPath,
}));

import { GET } from "@/app/api/files/route";

function req(params: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/api/files");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // The handler only touches request.nextUrl.searchParams.
  return { nextUrl: url } as unknown as NextRequest;
}

beforeEach(() => {
  listDirectory.mockClear();
  resolveSandboxedPath.mockReset();
});

describe("/api/files GET — browse mode (folder picker)", () => {
  it("403s a path outside the workspace by default (sandboxed)", async () => {
    resolveSandboxedPath.mockReturnValue({
      allowed: false,
      resolved: "C:/outside",
    });
    const res = await GET(req({ path: "C:/outside" }));
    expect(res.status).toBe(403);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("LISTS an out-of-workspace path when browse=1 (name-only picker mode)", async () => {
    resolveSandboxedPath.mockReturnValue({
      allowed: false,
      resolved: "C:/outside",
    });
    const res = await GET(req({ path: "C:/outside", browse: "1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toEqual([
      { name: "proj", path: "/x/proj", type: "directory" },
    ]);
    expect(listDirectory).toHaveBeenCalledWith("C:/outside", {
      recursive: false,
      maxDepth: 1,
    });
  });

  it("forces browse listings shallow even when recursive+depth are requested", async () => {
    resolveSandboxedPath.mockReturnValue({
      allowed: false,
      resolved: "C:/outside",
    });
    await GET(
      req({ path: "C:/outside", browse: "1", recursive: "true", depth: "8" })
    );
    expect(listDirectory).toHaveBeenCalledWith("C:/outside", {
      recursive: false,
      maxDepth: 1,
    });
  });

  it("still serves an in-workspace path without browse", async () => {
    resolveSandboxedPath.mockReturnValue({
      allowed: true,
      resolved: "/allowed/x",
    });
    const res = await GET(req({ path: "/allowed/x" }));
    expect(res.status).toBe(200);
    expect(listDirectory).toHaveBeenCalledWith("/allowed/x", {
      recursive: false,
      maxDepth: 1,
    });
  });

  it("400s when no path is given", async () => {
    const res = await GET(req({ browse: "1" }));
    expect(res.status).toBe(400);
  });
});
