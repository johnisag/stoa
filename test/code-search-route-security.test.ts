import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/code-search/route";

describe("/api/code-search observer boundary", () => {
  it("does not expose workspace contents to an observer", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/code-search?path=/&q=secret", {
        headers: { "x-stoa-scope": "observer" },
      })
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "admin token required",
    });
  });

  it("still reaches normal request validation for an admin", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/code-search", {
        headers: { "x-stoa-scope": "admin" },
      })
    );
    expect(response.status).toBe(400);
  });
});
