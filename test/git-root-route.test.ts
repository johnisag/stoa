import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isWindows, tmpDir } from "@/lib/platform";

const state = vi.hoisted(() => ({ roots: [] as string[] }));

// Real sandbox checks (lexical + realpath); only the DB-backed roots are faked.
vi.mock("@/lib/api-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-security")>();
  return { ...actual, getAllowedPathRoots: () => state.roots };
});

import { GET } from "@/app/api/git/root/route";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpDir(), "stoa-git-root-route-"));
  temporaryDirectories.push(repo);
  execFileSync("git", ["init", "-b", "main"], {
    cwd: repo,
    windowsHide: isWindows,
    stdio: "ignore",
  });
  mkdirSync(join(repo, "pkg"));
});

async function repoRootFor(p: string) {
  const res = await GET(
    new NextRequest(
      `http://localhost/api/git/root?path=${encodeURIComponent(p)}`,
      { headers: { "x-stoa-scope": "admin" } }
    )
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { repoRoot: string | null }).repoRoot;
}

describe("/api/git/root", () => {
  it("resolves the repo root when it is inside the workspace", async () => {
    state.roots = [repo];
    expect(await repoRootFor(join(repo, "pkg"))).toBe(repo);
  });

  it("reports null when the repo root is OUTSIDE the workspace (monorepo subfolder registered)", async () => {
    // Every git route would 403 the parent root; null keeps the git surfaces
    // on the stored working directory instead.
    state.roots = [join(repo, "pkg")];
    expect(await repoRootFor(join(repo, "pkg"))).toBeNull();
  });

  it("returns the alias root for a project registered through a symlink/junction", async () => {
    const alias = join(
      mkdtempSync(join(tmpDir(), "stoa-git-root-alias-")),
      "alias"
    );
    temporaryDirectories.push(join(alias, ".."));
    symlinkSync(repo, alias, isWindows ? "junction" : "dir");
    state.roots = [alias];
    expect(await repoRootFor(join(alias, "pkg"))).toBe(alias);
  });
});
