import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const securityState = vi.hoisted(() => ({ roots: [] as string[] }));

vi.mock("@/lib/api-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-security")>();
  return {
    ...actual,
    getAllowedPathRoots: () => securityState.roots,
  };
});

import { GET, POST } from "@/app/api/files/content/route";

function adminGet(url: string): NextRequest {
  return new NextRequest(url, {
    headers: { "x-stoa-scope": "admin" },
  });
}

describe("/api/files/content filesystem boundary", () => {
  let root: string;
  let outside: string;
  let link: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stoa-content-root-"));
    outside = mkdtempSync(join(tmpdir(), "stoa-content-outside-"));
    link = join(root, "escape");
    symlinkSync(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir"
    );
    securityState.roots = [root];
  });

  afterEach(() => {
    securityState.roots = [];
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("continues to read and write ordinary workspace files", async () => {
    const existing = join(root, "existing.txt");
    const created = join(root, "created.txt");
    writeFileSync(existing, "hello");

    const read = await GET(
      adminGet(
        `http://localhost/api/files/content?path=${encodeURIComponent(existing)}`
      )
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ content: "hello" });

    const write = await POST(
      new NextRequest("http://localhost/api/files/content", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: created, content: "safe" }),
      })
    );
    expect(write.status).toBe(200);
    expect(readFileSync(created, "utf8")).toBe("safe");
  });

  it("rejects escaping reads even when browse=true is supplied", async () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "authority");

    for (const browse of [false, true]) {
      const response = await GET(
        adminGet(
          `http://localhost/api/files/content?path=${encodeURIComponent(
            join(link, "secret.txt")
          )}&browse=${browse}`
        )
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Path is outside the allowed workspace",
      });
    }
  });

  it("rejects existing and new write targets through an escaping link", async () => {
    const existing = join(outside, "existing.txt");
    const created = join(outside, "created.txt");
    writeFileSync(existing, "unchanged");

    for (const path of [
      join(link, "existing.txt"),
      join(link, "created.txt"),
    ]) {
      const response = await POST(
        new NextRequest("http://localhost/api/files/content", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, content: "attacker" }),
        })
      );
      expect(response.status).toBe(403);
    }

    expect(readFileSync(existing, "utf8")).toBe("unchanged");
    expect(existsSync(created)).toBe(false);
  });

  it("does not expose workspace file content to an observer", async () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "private");

    const response = await GET(
      new NextRequest(
        `http://localhost/api/files/content?path=${encodeURIComponent(secret)}`,
        { headers: { "x-stoa-scope": "observer" } }
      )
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "admin token required",
    });
  });
});
