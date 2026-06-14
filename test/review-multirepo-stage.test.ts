/**
 * Regression lock for the shared multi-repo stage/unstage fan-out.
 *
 * R10 — In a multi-repo workspace the root isn't a single git repo, so a single
 * stage mutation bound to the primary repo silently ignores the others. The
 * shared `stageAllAcrossRepos` helper must group files by `repoPath` and POST
 * one explicit per-repo file list to /api/git/<endpoint>. Both GitPanel and
 * GitDrawer call this helper, so the bug can't reappear in just one component.
 *
 * Pure grouping + a mocked-fetch fan-out → runs on the full ubuntu/macos/windows
 * matrix with no real git.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  groupFilePathsByRepoPath,
  stageAllAcrossRepos,
} from "@/lib/multi-repo-stage";
import type { MultiRepoGitFile } from "@/lib/multi-repo-git";

function file(repoPath: string, path: string): MultiRepoGitFile {
  return {
    path,
    status: "modified",
    staged: false,
    repoId: repoPath,
    repoName: repoPath,
    repoPath,
  };
}

describe("groupFilePathsByRepoPath (pure)", () => {
  it("groups each file's path under its repoPath", () => {
    const grouped = groupFilePathsByRepoPath([
      file("/ws/a", "src/x.ts"),
      file("/ws/b", "src/y.ts"),
      file("/ws/a", "src/z.ts"),
    ]);
    expect(grouped.get("/ws/a")).toEqual(["src/x.ts", "src/z.ts"]);
    expect(grouped.get("/ws/b")).toEqual(["src/y.ts"]);
    expect(grouped.size).toBe(2);
  });

  it("returns an empty map for no files", () => {
    expect(groupFilePathsByRepoPath([]).size).toBe(0);
  });
});

describe("stageAllAcrossRepos (fan-out)", () => {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({ ok: true } as unknown as Response)
  );

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs once per repo with that repo's explicit file list", async () => {
    await stageAllAcrossRepos(
      [
        file("/ws/a", "src/x.ts"),
        file("/ws/b", "src/y.ts"),
        file("/ws/a", "src/z.ts"),
      ],
      "stage"
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const bodies = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse((init as RequestInit).body as string),
    }));
    // Every call hits the stage endpoint (not the primary repo's mutation).
    for (const b of bodies) {
      expect(b.url).toBe("/api/git/stage");
    }
    const a = bodies.find((b) => b.body.path === "/ws/a")!;
    const repoB = bodies.find((b) => b.body.path === "/ws/b")!;
    expect(a.body.files).toEqual(["src/x.ts", "src/z.ts"]);
    expect(repoB.body.files).toEqual(["src/y.ts"]);
  });

  it("targets the unstage endpoint when asked", async () => {
    await stageAllAcrossRepos([file("/ws/a", "src/x.ts")], "unstage");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/git/unstage");
  });

  it("makes no request when there are no files", async () => {
    await stageAllAcrossRepos([], "stage");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when any per-repo POST is not ok, after issuing all POSTs", async () => {
    // /ws/b's POST fails (e.g. a git index.lock → 500); a fulfilled Response
    // with ok:false must surface as a rejection, not be silently swallowed.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return Promise.resolve(
        (body.path === "/ws/b"
          ? { ok: false, status: 500 }
          : { ok: true }) as unknown as Response
      );
    });

    await expect(
      stageAllAcrossRepos(
        [
          file("/ws/a", "src/x.ts"),
          file("/ws/b", "src/y.ts"),
          file("/ws/c", "src/z.ts"),
        ],
        "stage"
      )
    ).rejects.toThrow("/ws/b");

    // All repos were still POSTed — failures are aggregated after every settle,
    // not short-circuited on the first bad response.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
