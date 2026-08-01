import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import path from "path";
import type { NextRequest } from "next/server";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { tmpDir } from "@/lib/platform";

const holder = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

const mocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  getMainRepoPath: vi.fn(),
  isStoaWorktree: vi.fn(),
  listWorktrees: vi.fn(),
  findAvailablePort: vi.fn(),
  runInBackground: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    get db() {
      return holder.db;
    },
    getDb: () => holder.db,
  };
});

vi.mock("@/lib/worktrees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktrees")>();
  return {
    ...actual,
    createWorktree: mocks.createWorktree,
    getMainRepoPath: mocks.getMainRepoPath,
    isStoaWorktree: mocks.isStoaWorktree,
    listWorktrees: mocks.listWorktrees,
  };
});

vi.mock("@/lib/ports", () => ({
  findAvailablePort: mocks.findAvailablePort,
}));

vi.mock("@/lib/async-operations", () => ({
  runInBackground: mocks.runInBackground,
}));

import { queries, type Session } from "@/lib/db";
import { POST } from "@/app/api/sessions/route";

function request(body: unknown): NextRequest {
  return new Request("http://stoa.local/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function createDirectory(parent: string, name: string): string {
  const directory = path.join(parent, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

let fixtureRoot = "";
let projectRoot = "";
let ownedWorktree = "";
let configuredLinkedWorktree = "";
let foreignProjectRoot = "";
let foreignWorktree = "";
let unregisteredWorktree = "";

beforeAll(() => {
  const memory = new Database(":memory:");
  createSchema(memory);
  runMigrations(memory);
  holder.db = memory;
});

beforeEach(() => {
  holder.db.exec("DELETE FROM sessions; DELETE FROM projects;");

  fixtureRoot = mkdtempSync(path.join(tmpDir(), "stoa-session-route-"));
  projectRoot = createDirectory(fixtureRoot, "project");
  ownedWorktree = createDirectory(fixtureRoot, "owned-worktree");
  configuredLinkedWorktree = createDirectory(
    fixtureRoot,
    "configured-linked-worktree"
  );
  foreignProjectRoot = createDirectory(fixtureRoot, "foreign-project");
  foreignWorktree = createDirectory(fixtureRoot, "foreign-worktree");
  unregisteredWorktree = createDirectory(fixtureRoot, "unregistered-worktree");

  queries
    .createProject(holder.db)
    .run("proj1", "Project", projectRoot, "claude", "sonnet", null, 1);
  holder.db
    .prepare(
      `INSERT INTO projects
       (id, name, working_directory, is_uncategorized, sort_order)
       VALUES ('uncategorized', 'Uncategorized', '~', 1, 999999)`
    )
    .run();

  vi.clearAllMocks();
  mocks.isStoaWorktree.mockReturnValue(true);
  mocks.findAvailablePort.mockResolvedValue(43111);
  mocks.runInBackground.mockImplementation(() => undefined);
});

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe("POST /api/sessions existing-worktree ownership", () => {
  it("attaches a registered Stoa worktree owned by the selected project", async () => {
    mocks.getMainRepoPath.mockResolvedValue(projectRoot);
    mocks.listWorktrees.mockResolvedValue([
      {
        path: ownedWorktree,
        branch: "feature/owned-work",
        head: "a".repeat(40),
      },
    ]);

    const response = await POST(
      request({
        name: "Recovered",
        projectId: "proj1",
        // A recovered session's cwd is the worktree, which deliberately lives
        // outside the project root; ownership comes from Git registration.
        workingDirectory: ownedWorktree,
        useWorktree: true,
        existingWorktreePath: ownedWorktree,
        existingWorktreeBranch: "feature/client-spoof",
        useTmux: false,
      })
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { session: Session };
    expect(body.session).toMatchObject({
      working_directory: ownedWorktree,
      worktree_path: ownedWorktree,
      branch_name: "feature/owned-work",
      dev_server_port: 43111,
    });
    expect(mocks.getMainRepoPath).toHaveBeenCalledWith(ownedWorktree);
    expect(mocks.getMainRepoPath).toHaveBeenCalledWith(projectRoot);
    expect(mocks.listWorktrees).toHaveBeenCalledWith(projectRoot);
    expect(mocks.createWorktree).not.toHaveBeenCalled();
  });

  it("verifies a projectless attach against the selected repository and trusts Git's branch", async () => {
    mocks.getMainRepoPath.mockResolvedValue(projectRoot);
    mocks.listWorktrees.mockResolvedValue([
      {
        path: ownedWorktree,
        branch: "feature/projectless-owned",
        head: "f".repeat(40),
      },
    ]);

    const response = await POST(
      request({
        name: "Projectless recovery",
        projectId: "uncategorized",
        workingDirectory: projectRoot,
        useWorktree: true,
        existingWorktreePath: ownedWorktree,
        existingWorktreeBranch: "feature/client-spoof",
        useTmux: false,
      })
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { session: Session };
    expect(body.session).toMatchObject({
      project_id: "uncategorized",
      working_directory: ownedWorktree,
      worktree_path: ownedWorktree,
      branch_name: "feature/projectless-owned",
    });
    expect(mocks.getMainRepoPath).toHaveBeenNthCalledWith(1, ownedWorktree);
    expect(mocks.getMainRepoPath).toHaveBeenNthCalledWith(2, projectRoot);
    expect(mocks.listWorktrees).toHaveBeenCalledWith(projectRoot);
  });

  it("rejects an arbitrary directory under the Stoa worktree root for a projectless attach", async () => {
    mocks.getMainRepoPath.mockResolvedValue(projectRoot);
    mocks.listWorktrees.mockResolvedValue([
      {
        path: ownedWorktree,
        branch: "feature/registered",
        head: "a".repeat(40),
      },
    ]);

    const response = await POST(
      request({
        projectId: "uncategorized",
        workingDirectory: projectRoot,
        useWorktree: true,
        existingWorktreePath: unregisteredWorktree,
        existingWorktreeBranch: "feature/client-spoof",
        useTmux: false,
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.listWorktrees).toHaveBeenCalledWith(projectRoot);
    expect(queries.getAllSessions(holder.db).all()).toHaveLength(0);
  });

  it("rejects a worktree already attached to another session", async () => {
    mocks.getMainRepoPath.mockResolvedValue(projectRoot);
    mocks.listWorktrees.mockResolvedValue([
      {
        path: ownedWorktree,
        branch: "feature/owned-work",
        head: "a".repeat(40),
      },
    ]);
    const body = {
      projectId: "proj1",
      workingDirectory: ownedWorktree,
      useWorktree: true,
      existingWorktreePath: ownedWorktree,
      useTmux: false,
    };

    const first = await POST(request(body));
    const duplicate = await POST(request(body));

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: "Worktree is already attached to another session",
    });
    expect(queries.getAllSessions(holder.db).all()).toHaveLength(1);
  });

  it("atomically allows only one of two concurrent attaches", async () => {
    mocks.getMainRepoPath.mockResolvedValue(projectRoot);
    mocks.listWorktrees.mockResolvedValue([
      {
        path: ownedWorktree,
        branch: "feature/owned-work",
        head: "a".repeat(40),
      },
    ]);
    const body = {
      projectId: "proj1",
      workingDirectory: ownedWorktree,
      useWorktree: true,
      existingWorktreePath: ownedWorktree,
      useTmux: false,
    };

    const responses = await Promise.all([
      POST(request({ ...body, name: "Concurrent A" })),
      POST(request({ ...body, name: "Concurrent B" })),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(queries.getAllSessions(holder.db).all()).toHaveLength(1);
  });

  it("rejects a Stoa worktree whose Git main repository is another project", async () => {
    mocks.getMainRepoPath.mockImplementation(async (directory: string) =>
      directory === foreignWorktree ? foreignProjectRoot : projectRoot
    );

    const response = await POST(
      request({
        projectId: "proj1",
        workingDirectory: foreignWorktree,
        useWorktree: true,
        existingWorktreePath: foreignWorktree,
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.listWorktrees).not.toHaveBeenCalled();
    expect(queries.getAllSessions(holder.db).all()).toHaveLength(0);
  });

  it("fails closed when the selected project has no resolvable Git identity", async () => {
    mocks.getMainRepoPath.mockImplementation(async (directory: string) =>
      directory === ownedWorktree ? projectRoot : null
    );

    const response = await POST(
      request({
        projectId: "proj1",
        workingDirectory: ownedWorktree,
        useWorktree: true,
        existingWorktreePath: ownedWorktree,
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.listWorktrees).not.toHaveBeenCalled();
    expect(queries.getAllSessions(holder.db).all()).toHaveLength(0);
  });

  it("accepts an owned worktree when the project is configured to a repo subdirectory", async () => {
    const projectSubdirectory = createDirectory(projectRoot, "packages/app");
    holder.db
      .prepare("UPDATE projects SET working_directory = ? WHERE id = ?")
      .run(projectSubdirectory, "proj1");
    mocks.getMainRepoPath.mockResolvedValue(projectRoot);
    mocks.listWorktrees.mockResolvedValue([
      {
        path: ownedWorktree,
        branch: "feature/subdirectory-project",
        head: "c".repeat(40),
      },
    ]);

    const response = await POST(
      request({
        projectId: "proj1",
        workingDirectory: ownedWorktree,
        useWorktree: true,
        existingWorktreePath: ownedWorktree,
        useTmux: false,
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.getMainRepoPath).toHaveBeenNthCalledWith(1, ownedWorktree);
    expect(mocks.getMainRepoPath).toHaveBeenNthCalledWith(
      2,
      projectSubdirectory
    );
    expect(mocks.listWorktrees).toHaveBeenCalledWith(projectSubdirectory);
  });

  it("accepts an owned worktree when the project directory is another linked worktree", async () => {
    holder.db
      .prepare("UPDATE projects SET working_directory = ? WHERE id = ?")
      .run(configuredLinkedWorktree, "proj1");
    mocks.getMainRepoPath.mockResolvedValue(projectRoot);
    mocks.listWorktrees.mockResolvedValue([
      {
        path: ownedWorktree,
        branch: "feature/linked-project",
        head: "d".repeat(40),
      },
    ]);

    const response = await POST(
      request({
        projectId: "proj1",
        workingDirectory: ownedWorktree,
        useWorktree: true,
        existingWorktreePath: ownedWorktree,
        useTmux: false,
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.getMainRepoPath).toHaveBeenNthCalledWith(1, ownedWorktree);
    expect(mocks.getMainRepoPath).toHaveBeenNthCalledWith(
      2,
      configuredLinkedWorktree
    );
  });

  it("canonicalizes symlinked repository identities before comparing them", async () => {
    const projectAlias = path.join(fixtureRoot, "project-alias");
    symlinkSync(
      projectRoot,
      projectAlias,
      process.platform === "win32" ? "junction" : "dir"
    );
    holder.db
      .prepare("UPDATE projects SET working_directory = ? WHERE id = ?")
      .run(projectAlias, "proj1");
    mocks.getMainRepoPath.mockImplementation(async (directory: string) =>
      directory === ownedWorktree ? projectRoot : projectAlias
    );
    mocks.listWorktrees.mockResolvedValue([
      {
        path: ownedWorktree,
        branch: "feature/symlink-project",
        head: "e".repeat(40),
      },
    ]);

    const response = await POST(
      request({
        projectId: "proj1",
        workingDirectory: ownedWorktree,
        useWorktree: true,
        existingWorktreePath: ownedWorktree,
        useTmux: false,
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.getMainRepoPath).toHaveBeenNthCalledWith(1, ownedWorktree);
    expect(mocks.getMainRepoPath).toHaveBeenNthCalledWith(2, projectAlias);
  });

  it("rejects an on-disk path that Git does not register for the project", async () => {
    mocks.getMainRepoPath.mockResolvedValue(projectRoot);
    mocks.listWorktrees.mockResolvedValue([
      {
        path: ownedWorktree,
        branch: "feature/other",
        head: "b".repeat(40),
      },
    ]);

    const response = await POST(
      request({
        projectId: "proj1",
        workingDirectory: unregisteredWorktree,
        useWorktree: true,
        existingWorktreePath: unregisteredWorktree,
      })
    );

    expect(response.status).toBe(403);
    expect(queries.getAllSessions(holder.db).all()).toHaveLength(0);
  });

  it("returns 400 for a malformed existingWorktreePath without invoking Git", async () => {
    const response = await POST(
      request({
        projectId: "proj1",
        workingDirectory: projectRoot,
        useWorktree: true,
        existingWorktreePath: { path: ownedWorktree },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "existingWorktreePath must be a valid path",
    });
    expect(mocks.getMainRepoPath).not.toHaveBeenCalled();
    expect(mocks.listWorktrees).not.toHaveBeenCalled();
    expect(queries.getAllSessions(holder.db).all()).toHaveLength(0);
  });

  it("keeps normal project-descendant validation for non-attach sessions", async () => {
    const response = await POST(
      request({
        projectId: "proj1",
        workingDirectory: foreignProjectRoot,
        useWorktree: false,
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.getMainRepoPath).not.toHaveBeenCalled();
    expect(mocks.createWorktree).not.toHaveBeenCalled();
    expect(queries.getAllSessions(holder.db).all()).toHaveLength(0);
  });

  it("still creates a new feature worktree through the existing flow", async () => {
    const createdWorktree = createDirectory(fixtureRoot, "created-worktree");
    mocks.createWorktree.mockResolvedValue({
      worktreePath: createdWorktree,
      branchName: "feature/new-work",
      baseBranch: "develop",
      projectPath: projectRoot,
      projectName: "project",
    });

    const response = await POST(
      request({
        name: "New work",
        projectId: "proj1",
        workingDirectory: projectRoot,
        useWorktree: true,
        featureName: "new work",
        baseBranch: "develop",
        useTmux: false,
      })
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { session: Session };
    expect(body.session).toMatchObject({
      working_directory: createdWorktree,
      worktree_path: createdWorktree,
      branch_name: "feature/new-work",
      base_branch: "develop",
      dev_server_port: 43111,
    });
    expect(mocks.createWorktree).toHaveBeenCalledWith({
      projectPath: projectRoot,
      featureName: "new work",
      baseBranch: "develop",
    });
    expect(mocks.getMainRepoPath).not.toHaveBeenCalled();
    expect(mocks.runInBackground).toHaveBeenCalledOnce();
  });
});
