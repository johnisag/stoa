import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(() => "head content"),
  getGitStatus: vi.fn(() => ({ files: [] })),
  getFileDiff: vi.fn(() => "working diff"),
  getUntrackedFileDiff: vi.fn(() => "untracked diff"),
  getWorktreeBaseChanges: vi.fn(() => []),
  getCommitFileDiff: vi.fn(() => "commit diff"),
  getCommitDetail: vi.fn(() => ({ hash: "abc", files: [] })),
  getSessionDiff: vi.fn(async () => ({
    supported: true,
    baseRef: "main",
    diff: "session diff",
  })),
  getSnapshotDiff: vi.fn(async () => "snapshot diff"),
  getBonRunStatus: vi.fn(() => ({ run: { id: "run-1" }, candidates: [] })),
  getServerLogs: vi.fn(async () => ["server output"]),
  listDirectory: vi.fn(() => []),
  discoverGitRepos: vi.fn(async () => []),
  isGitRepo: vi.fn(async () => true),
  getRepoSlug: vi.fn(async () => "owner/repo"),
  getDefaultBranch: vi.fn(async () => "main"),
  getMultiRepoGitStatus: vi.fn(() => ({ repositories: [] })),
}));

vi.mock("child_process", () => ({ execFileSync: mocks.execFileSync }));

vi.mock("@/lib/api-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-security")>();
  return {
    ...actual,
    getAllowedPathRoots: () => ["/workspace"],
    resolveSandboxedPath: (input: string) => ({
      allowed: input.startsWith("/workspace"),
      resolved: input,
    }),
    resolveRealSandboxedPath: async (input: string) => ({
      allowed: input.startsWith("/workspace"),
      resolved: input,
    }),
    resolveRealSandboxedPathOrHome: async (input: string) => ({
      allowed: input.startsWith("/workspace"),
      resolved: input,
    }),
  };
});

vi.mock("@/lib/git-status", () => ({
  expandPath: (value: string) => value,
  getGitStatus: mocks.getGitStatus,
  isGitRepo: () => true,
  getFileDiff: mocks.getFileDiff,
  getUntrackedFileDiff: mocks.getUntrackedFileDiff,
  getWorktreeBaseChanges: mocks.getWorktreeBaseChanges,
}));

vi.mock("@/lib/git-history", () => ({
  getCommitFileDiff: mocks.getCommitFileDiff,
  getCommitDetail: mocks.getCommitDetail,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    getSession: () => ({
      get: () => ({
        id: "session-1",
        working_directory: "/workspace/repo",
        base_branch: "main",
        session_role: "interactive",
      }),
    }),
    getAllProjects: () => ({
      all: () => [{ working_directory: "/workspace/repo" }],
    }),
  },
}));

vi.mock("@/lib/session-route-access", () => ({
  genericSessionRouteFailure: () => null,
  assertGenericSessionRouteAccess: () => undefined,
}));
vi.mock("@/lib/session-diff", () => ({
  getSessionDiff: mocks.getSessionDiff,
}));
vi.mock("@/lib/snapshots", () => ({
  getSnapshotDiff: mocks.getSnapshotDiff,
}));
vi.mock("@/lib/best-of-n", () => ({
  getBonRunStatus: mocks.getBonRunStatus,
}));
vi.mock("@/lib/dev-servers", () => ({
  getServerLogs: mocks.getServerLogs,
}));
vi.mock("@/lib/skills", () => {
  class SkillValidationError extends Error {}
  return {
    supportedSkillProviders: () => ["claude"],
    listSkills: () => [{ name: "review", description: "Review code" }],
    getSkill: () => ({ name: "review", body: "Inspect the diff" }),
    writeSkill: vi.fn(),
    deleteSkill: vi.fn(),
    SkillValidationError,
  };
});
vi.mock("@/lib/files", () => ({ listDirectory: mocks.listDirectory }));
vi.mock("@/lib/dispatch/discover", () => ({
  defaultScanRoots: () => ["/workspace"],
  discoverGitRepos: mocks.discoverGitRepos,
}));
vi.mock("@/lib/git", () => ({
  isGitRepo: mocks.isGitRepo,
  getRepoSlug: mocks.getRepoSlug,
  getDefaultBranch: mocks.getDefaultBranch,
}));
vi.mock("@/lib/projects", () => ({
  getProject: () => ({ id: "project-1" }),
  getProjectRepositories: () => [
    { id: "repo-1", name: "repo", path: "/workspace/repo" },
  ],
}));
vi.mock("@/lib/multi-repo-git", () => ({
  getMultiRepoGitStatus: mocks.getMultiRepoGitStatus,
}));
vi.mock("@/lib/workspace-session", () => ({
  parseWorktreePaths: () => ["/workspace/repo"],
  worktreePathsToRepositories: () => [
    { id: "repo-1", name: "repo", path: "/workspace/repo" },
  ],
}));

import { GET as getGitFileContent } from "@/app/api/git/file-content/route";
import { GET as getGitStatusRoute } from "@/app/api/git/status/route";
import { GET as getCommitDiff } from "@/app/api/git/history/[hash]/diff/route";
import { GET as getCommitDetail } from "@/app/api/git/history/[hash]/route";
import { GET as getSessionDiffRoute } from "@/app/api/sessions/[id]/diff/route";
import { GET as getSnapshotDiffRoute } from "@/app/api/sessions/[id]/snapshots/[seq]/diff/route";
import { GET as getBestOfNRun } from "@/app/api/best-of-n/[runId]/route";
import { GET as getDevServerLogs } from "@/app/api/dev-servers/[id]/logs/route";
import { GET as getSkills } from "@/app/api/skills/route";
import { GET as getFiles } from "@/app/api/files/route";
import { GET as getFileRoots } from "@/app/api/files/roots/route";
import { GET as discoverDispatchRepos } from "@/app/api/dispatch/discover/route";
import { GET as resolveDispatchRepo } from "@/app/api/dispatch/resolve/route";
import { GET as getMultiStatus } from "@/app/api/git/multi-status/route";

type Scope = "admin" | "observer";

function request(path: string, scope: Scope): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { "x-stoa-scope": scope },
  });
}

async function expectAdminRequired(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: "admin token required",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("content-bearing GET observer boundaries", () => {
  it("protects Git file and diff contents while retaining status metadata", async () => {
    await expectAdminRequired(
      await getGitFileContent(
        request(
          "/api/git/file-content?path=/workspace/repo&file=a.ts",
          "observer"
        )
      )
    );
    await expectAdminRequired(
      await getGitStatusRoute(
        request("/api/git/status?path=/workspace/repo&file=a.ts", "observer")
      )
    );
    await expectAdminRequired(
      await getGitStatusRoute(
        request("/api/git/status?path=/workspace/repo&file=", "observer")
      )
    );
    await expectAdminRequired(
      await getCommitDiff(
        request(
          "/api/git/history/abc/diff?path=/workspace/repo&file=a.ts",
          "observer"
        ),
        { params: Promise.resolve({ hash: "abc" }) }
      )
    );
    await expectAdminRequired(
      await getCommitDetail(
        request("/api/git/history/abc?path=/workspace/repo", "observer"),
        { params: Promise.resolve({ hash: "abc" }) }
      )
    );
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.getFileDiff).not.toHaveBeenCalled();
    expect(mocks.getCommitFileDiff).not.toHaveBeenCalled();
    expect(mocks.getCommitDetail).not.toHaveBeenCalled();

    expect(
      (
        await getGitStatusRoute(
          request("/api/git/status?path=/workspace/repo", "observer")
        )
      ).status
    ).toBe(200);
    expect(
      (
        await getGitFileContent(
          request(
            "/api/git/file-content?path=/workspace/repo&file=a.ts",
            "admin"
          )
        )
      ).status
    ).toBe(200);
    expect(
      (
        await getGitStatusRoute(
          request("/api/git/status?path=/workspace/repo&file=a.ts", "admin")
        )
      ).status
    ).toBe(200);
    expect(
      (
        await getCommitDiff(
          request(
            "/api/git/history/abc/diff?path=/workspace/repo&file=a.ts",
            "admin"
          ),
          { params: Promise.resolve({ hash: "abc" }) }
        )
      ).status
    ).toBe(200);
    expect(
      (
        await getCommitDetail(
          request("/api/git/history/abc?path=/workspace/repo", "admin"),
          { params: Promise.resolve({ hash: "abc" }) }
        )
      ).status
    ).toBe(200);
  });

  it("protects session and snapshot diffs", async () => {
    await expectAdminRequired(
      await getSessionDiffRoute(
        request("/api/sessions/session-1/diff", "observer"),
        {
          params: Promise.resolve({ id: "session-1" }),
        }
      )
    );
    await expectAdminRequired(
      await getSnapshotDiffRoute(
        request("/api/sessions/session-1/snapshots/1/diff", "observer"),
        { params: Promise.resolve({ id: "session-1", seq: "1" }) }
      )
    );
    expect(mocks.getSessionDiff).not.toHaveBeenCalled();
    expect(mocks.getSnapshotDiff).not.toHaveBeenCalled();

    expect(
      (
        await getSessionDiffRoute(
          request("/api/sessions/session-1/diff", "admin"),
          {
            params: Promise.resolve({ id: "session-1" }),
          }
        )
      ).status
    ).toBe(200);
    expect(
      (
        await getSnapshotDiffRoute(
          request("/api/sessions/session-1/snapshots/1/diff", "admin"),
          { params: Promise.resolve({ id: "session-1", seq: "1" }) }
        )
      ).status
    ).toBe(200);
  });

  it("protects Best-of-N content and dev-server logs", async () => {
    await expectAdminRequired(
      await getBestOfNRun(request("/api/best-of-n/run-1", "observer"), {
        params: Promise.resolve({ runId: "run-1" }),
      })
    );
    await expectAdminRequired(
      await getDevServerLogs(
        request("/api/dev-servers/server-1/logs", "observer"),
        {
          params: Promise.resolve({ id: "server-1" }),
        }
      )
    );
    expect(mocks.getBonRunStatus).not.toHaveBeenCalled();
    expect(mocks.getServerLogs).not.toHaveBeenCalled();

    expect(
      (
        await getBestOfNRun(request("/api/best-of-n/run-1", "admin"), {
          params: Promise.resolve({ runId: "run-1" }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await getDevServerLogs(
          request("/api/dev-servers/server-1/logs", "admin"),
          {
            params: Promise.resolve({ id: "server-1" }),
          }
        )
      ).status
    ).toBe(200);
  });

  it("keeps the skill-provider catalog visible but protects provider files", async () => {
    expect((await getSkills(request("/api/skills", "observer"))).status).toBe(
      200
    );
    await expectAdminRequired(
      await getSkills(request("/api/skills?provider=claude", "observer"))
    );
    await expectAdminRequired(
      await getSkills(request("/api/skills?provider=", "observer"))
    );
    expect(
      (await getSkills(request("/api/skills?provider=claude", "admin"))).status
    ).toBe(200);
  });

  it("protects host browsing and filesystem roots but not sandboxed listings", async () => {
    expect(
      (await getFiles(request("/api/files?path=/workspace/repo", "observer")))
        .status
    ).toBe(200);
    await expectAdminRequired(
      await getFiles(
        request("/api/files?path=/outside&browse=true", "observer")
      )
    );
    await expectAdminRequired(
      await getFileRoots(request("/api/files/roots", "observer"))
    );

    expect(
      (await getFiles(request("/api/files?path=/outside&browse=true", "admin")))
        .status
    ).toBe(200);
    expect(
      (await getFileRoots(request("/api/files/roots", "admin"))).status
    ).toBe(200);
  });

  it("protects dispatch discovery and path resolution", async () => {
    await expectAdminRequired(
      await discoverDispatchRepos(request("/api/dispatch/discover", "observer"))
    );
    await expectAdminRequired(
      await resolveDispatchRepo(
        request("/api/dispatch/resolve?path=/workspace/repo", "observer")
      )
    );
    expect(mocks.discoverGitRepos).not.toHaveBeenCalled();
    expect(mocks.isGitRepo).not.toHaveBeenCalled();

    expect(
      (await discoverDispatchRepos(request("/api/dispatch/discover", "admin")))
        .status
    ).toBe(200);
    expect(
      (
        await resolveDispatchRepo(
          request("/api/dispatch/resolve?path=/workspace/repo", "admin")
        )
      ).status
    ).toBe(200);
  });

  it("allows project metadata status but protects caller-supplied paths", async () => {
    expect(
      (
        await getMultiStatus(
          request("/api/git/multi-status?projectId=project-1", "observer")
        )
      ).status
    ).toBe(200);

    for (const query of [
      "paths=%5B%22%2Fworkspace%2Frepo%22%5D",
      "fallbackPath=/workspace/repo",
    ]) {
      await expectAdminRequired(
        await getMultiStatus(
          request(`/api/git/multi-status?${query}`, "observer")
        )
      );
      expect(
        (
          await getMultiStatus(
            request(`/api/git/multi-status?${query}`, "admin")
          )
        ).status
      ).toBe(200);
    }

    for (const query of ["paths=", "fallbackPath="]) {
      await expectAdminRequired(
        await getMultiStatus(
          request(`/api/git/multi-status?${query}`, "observer")
        )
      );
    }
  });
});
