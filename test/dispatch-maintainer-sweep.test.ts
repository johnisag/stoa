/**
 * sweepOrphanedSurveys (v1.1) — the startup reclaim for surveys orphaned by a
 * restart. Real in-memory SQLite; the backend kill + worktree helpers are mocked.
 * Locks the behavior AND the two structural fail-closed guards: it acts only on
 * sessions named in the EXACT machine shape Stoa emits (never a user rename), only
 * removes worktrees inside Stoa's worktrees dir, and never reaps a still-tracked
 * (live) survey — while staying best-effort across rows.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));
const kill = vi.hoisted(() =>
  vi.fn(async (_name: string): Promise<void> => {})
);

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ kill }),
}));
vi.mock("@/lib/worktrees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktrees")>();
  return {
    ...actual,
    createWorktree: vi.fn(),
    getMainRepoPath: vi.fn(),
    deleteWorktree: vi.fn(),
    isStoaWorktree: vi.fn(),
  };
});
vi.mock("@/lib/dispatch/reviewer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/dispatch/reviewer")>();
  return { ...actual, spawnWorktreeWorker: vi.fn() };
});

import {
  sweepOrphanedSurveys,
  spawnSurvey,
  cleanupSurveyRun,
} from "@/lib/dispatch/maintainer";
import { queries } from "@/lib/db";
import * as worktrees from "@/lib/worktrees";
import * as reviewer from "@/lib/dispatch/reviewer";
import type { DispatchRepo } from "@/lib/dispatch/types";

function db() {
  return state.db as InstanceType<typeof Database>;
}

function addSessionWithId(
  id: string,
  name: string,
  tmux: string,
  worktree: string | null
): string {
  queries
    .createSession(db())
    .run(
      id,
      name,
      tmux,
      "/cwd",
      null,
      "sonnet",
      null,
      "sessions",
      "claude",
      1,
      "uncategorized"
    );
  if (worktree) {
    queries
      .updateSessionWorktree(db())
      .run(worktree, "feature/survey-x", "main", null, id);
  }
  return id;
}

function addSession(
  name: string,
  tmux: string,
  worktree: string | null
): string {
  return addSessionWithId(`sess-${tmux}`, name, tmux, worktree);
}

const ids = () =>
  (queries.getAllSessions(db()).all() as { id: string }[]).map((r) => r.id);

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().exec("DELETE FROM sessions;");
  vi.clearAllMocks();
  kill.mockResolvedValue(undefined);
  vi.mocked(worktrees.getMainRepoPath).mockResolvedValue("/main/repo");
  vi.mocked(worktrees.deleteWorktree).mockResolvedValue(undefined);
  vi.mocked(worktrees.isStoaWorktree).mockReturnValue(true);
  vi.mocked(worktrees.createWorktree).mockResolvedValue({
    worktreePath: "/wt/tracked",
    branchName: "feature/survey-x",
    baseBranch: "main",
    projectPath: "/main/repo",
    projectName: "repo",
  });
  vi.mocked(reviewer.spawnWorktreeWorker).mockImplementation(
    async (_t, _n, _p, onSpawn) => {
      onSpawn("tracked-session-id");
      return "tracked-session-id";
    }
  );
});

describe("sweepOrphanedSurveys", () => {
  it("kills, reclaims the worktree, and drops every survey session — leaving others", async () => {
    addSession("stoa-survey-aaaa1111", "claude-uuid-1", "/wt/survey-a");
    addSession("stoa-survey-bbbb2222", "claude-uuid-2", "/wt/survey-b");
    const keep = addSession("my work session", "claude-uuid-3", "/wt/keep");

    await sweepOrphanedSurveys();

    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill.mock.calls.map((c) => c[0]).sort()).toEqual([
      "claude-uuid-1",
      "claude-uuid-2",
    ]);
    expect(vi.mocked(worktrees.deleteWorktree)).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual([keep]); // survey rows gone, normal one survives
  });

  it("passes the recovered main repo + deleteBranch=true to deleteWorktree", async () => {
    addSession("stoa-survey-aaaa1111", "claude-uuid-1", "/wt/survey-a");
    await sweepOrphanedSurveys();
    expect(vi.mocked(worktrees.deleteWorktree)).toHaveBeenCalledWith(
      "/wt/survey-a",
      "/main/repo",
      true
    );
  });

  it("falls back to the worktree path as projectPath when the main repo can't be resolved", async () => {
    addSession("stoa-survey-aaaa1111", "claude-uuid-1", "/wt/survey-a");
    vi.mocked(worktrees.getMainRepoPath).mockResolvedValueOnce(null);
    await sweepOrphanedSurveys();
    expect(vi.mocked(worktrees.deleteWorktree)).toHaveBeenCalledWith(
      "/wt/survey-a",
      "/wt/survey-a",
      true
    );
  });

  it("FAIL-CLOSED: leaves a user-renamed session that merely starts with the prefix", async () => {
    addSession("stoa-survey-notes", "claude-user", "/wt/user"); // not 8 hex
    addSession("Stoa-Survey-aaaa1111", "claude-case", "/wt/case"); // wrong case

    await sweepOrphanedSurveys();

    expect(kill).not.toHaveBeenCalled();
    expect(vi.mocked(worktrees.deleteWorktree)).not.toHaveBeenCalled();
    expect(ids()).toHaveLength(2); // both untouched
  });

  it("FAIL-CLOSED: never removes a worktree outside Stoa's worktrees dir (still drops the row)", async () => {
    addSession("stoa-survey-aaaa1111", "claude-uuid-1", "/external/repo/wt");
    vi.mocked(worktrees.isStoaWorktree).mockReturnValue(false);

    await sweepOrphanedSurveys();

    expect(kill).toHaveBeenCalledWith("claude-uuid-1"); // session killed
    expect(vi.mocked(worktrees.deleteWorktree)).not.toHaveBeenCalled(); // worktree untouched
    expect(ids()).toHaveLength(0); // row dropped
  });

  it("never reaps a survey the in-memory map still tracks (a live, non-orphan run)", async () => {
    const repo = {
      id: "r1",
      repo_path: "/main/repo",
      repo_slug: "o/r",
      agent_type: "claude",
      base_branch: "main",
      project_id: null,
    } as unknown as DispatchRepo;
    const surveyId = await spawnSurvey(repo, "keep CI green", []);
    // spawnWorktreeWorker recorded sessionId "tracked-session-id"; give it a DB row.
    addSessionWithId(
      "tracked-session-id",
      "stoa-survey-12345678",
      "claude-tracked",
      "/wt/tracked"
    );

    await sweepOrphanedSurveys();

    expect(kill).not.toHaveBeenCalledWith("claude-tracked");
    expect(ids()).toContain("tracked-session-id"); // left alone
    await cleanupSurveyRun(surveyId); // clear the in-memory map for other tests
  });

  it("no-ops when there are no survey sessions", async () => {
    addSession("normal work", "tmux-n", "/wt/n");
    await sweepOrphanedSurveys();
    expect(kill).not.toHaveBeenCalled();
    expect(vi.mocked(worktrees.deleteWorktree)).not.toHaveBeenCalled();
    expect(ids()).toHaveLength(1);
  });

  it("continues past a kill failure (best-effort) and still reclaims + drops the row", async () => {
    addSession("stoa-survey-cccc3333", "claude-uuid-4", "/wt/survey-c");
    kill.mockRejectedValueOnce(new Error("backend down"));

    await sweepOrphanedSurveys();

    expect(vi.mocked(worktrees.deleteWorktree)).toHaveBeenCalledTimes(1);
    expect(ids()).toHaveLength(0);
  });

  it("isolates failures across rows — one worktree rejection doesn't block the next", async () => {
    addSession("stoa-survey-aaaa1111", "claude-uuid-1", "/wt/survey-a");
    addSession("stoa-survey-bbbb2222", "claude-uuid-2", "/wt/survey-b");
    vi.mocked(worktrees.deleteWorktree).mockRejectedValueOnce(
      new Error("locked")
    );

    await sweepOrphanedSurveys();

    expect(vi.mocked(worktrees.deleteWorktree)).toHaveBeenCalledTimes(2);
    expect(ids()).toHaveLength(0); // both rows dropped despite the first's failure
  });

  it("reclaims a survey row even when its worktree path is null (no deleteWorktree call)", async () => {
    addSession("stoa-survey-dddd4444", "claude-uuid-5", null);

    await sweepOrphanedSurveys();

    expect(kill).toHaveBeenCalledWith("claude-uuid-5");
    expect(vi.mocked(worktrees.deleteWorktree)).not.toHaveBeenCalled();
    expect(ids()).toHaveLength(0);
  });
});
