/**
 * maintainerPass orchestration (reconciler half-b + half-a), against a real
 * in-memory SQLite with the survey I/O mocked (spawn/read/cleanup) — the way the
 * reconciler test mocks the dispatcher. Locks the load-bearing behavior the pure
 * tests can't: the cadence-due spawn + anchor stamp, rollback on a failed spawn,
 * the spawn-once guard, the structural task cap, and the maintainer_proposed filing.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ list: vi.fn(async (): Promise<string[]> => []) }),
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});
// Mock only the survey I/O; keep buildMaintainerTaskBody + the caps real.
vi.mock("@/lib/dispatch/maintainer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/dispatch/maintainer")>();
  return {
    ...actual,
    spawnSurvey: vi.fn(async () => "survey-1"),
    readSurveyRun: vi.fn(async () => ({ status: "running" })),
    cleanupSurveyRun: vi.fn(async () => {}),
    hasSurveyRun: vi.fn(() => false),
    trackedSurveyIds: vi.fn((): string[] => []),
  };
});

import { maintainerPass } from "@/lib/dispatch/reconciler";
import { queries } from "@/lib/db";
import * as maint from "@/lib/dispatch/maintainer";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";

function db() {
  return state.db as InstanceType<typeof Database>;
}

let seq = 0;
function addRepo(
  opts: {
    maintainerEnabled?: number;
    goal?: string | null;
    cadence?: string | null;
    lastAt?: string | null;
  } = {}
): string {
  const id = `repo-${seq++}`;
  queries
    .createDispatchRepo(db())
    .run(
      id,
      "/tmp/repo",
      "o/r",
      "claude",
      5,
      5,
      null,
      "main",
      "auto",
      1,
      0,
      0,
      0,
      0,
      null,
      null
    );
  const goal = opts.goal === undefined ? "keep CI green" : opts.goal;
  queries
    .updateMaintainerSurvey(db())
    .run(opts.maintainerEnabled ?? 1, goal, opts.cadence ?? "daily", id);
  queries.setMaintainerSurveyRanAt(db()).run(opts.lastAt ?? null, id);
  return id;
}

const getRepo = (id: string) =>
  queries.getDispatchRepo(db()).get(id) as DispatchRepo;

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().exec("DELETE FROM issue_dispatches; DELETE FROM dispatch_repos;");
  vi.clearAllMocks();
  vi.mocked(maint.spawnSurvey).mockResolvedValue("survey-1");
  vi.mocked(maint.readSurveyRun).mockResolvedValue({ status: "running" });
  vi.mocked(maint.cleanupSurveyRun).mockResolvedValue(undefined);
  vi.mocked(maint.hasSurveyRun).mockReturnValue(false);
  vi.mocked(maint.trackedSurveyIds).mockReturnValue([]);
});

describe("maintainerPass — spawn half", () => {
  it("spawns a survey for a due, enabled, goal-set repo and stamps the anchor", async () => {
    const id = addRepo({ lastAt: null }); // never run → due
    await maintainerPass();
    expect(vi.mocked(maint.spawnSurvey)).toHaveBeenCalledTimes(1);
    expect(getRepo(id).maintainer_survey_last_at).not.toBeNull();
  });

  it("skips a repo whose cadence is not yet due", async () => {
    addRepo({ cadence: "daily", lastAt: new Date().toISOString() });
    await maintainerPass();
    expect(vi.mocked(maint.spawnSurvey)).not.toHaveBeenCalled();
  });

  it("skips an enabled repo with no goal (fail-closed)", async () => {
    addRepo({ goal: null, lastAt: null });
    await maintainerPass();
    expect(vi.mocked(maint.spawnSurvey)).not.toHaveBeenCalled();
  });

  it("does not spawn while a survey is already in flight (spawn-once)", async () => {
    addRepo({ lastAt: null });
    vi.mocked(maint.hasSurveyRun).mockReturnValue(true);
    await maintainerPass();
    expect(vi.mocked(maint.spawnSurvey)).not.toHaveBeenCalled();
  });

  it("rolls the anchor back when the spawn throws (retries next tick, not next interval)", async () => {
    const id = addRepo({ lastAt: null });
    vi.mocked(maint.spawnSurvey).mockRejectedValueOnce(new Error("boom"));
    await maintainerPass();
    // Restored to the previous anchor (null) so isRecurrenceDue stays true.
    expect(getRepo(id).maintainer_survey_last_at).toBeNull();
  });

  it("RESTORES the exact prior anchor on a failed spawn (not just resets to null)", async () => {
    // A long-past anchor → always due regardless of the run date, so the spawn is
    // attempted and the rollback path runs.
    const stale = "2020-01-01T00:00:00.000Z";
    const id = addRepo({ cadence: "weekly", lastAt: stale });
    vi.mocked(maint.spawnSurvey).mockRejectedValueOnce(new Error("boom"));
    await maintainerPass();
    // The previous anchor is put back verbatim — a regression that reset to null
    // (or left `now` stamped) would fail this.
    expect(getRepo(id).maintainer_survey_last_at).toBe(stale);
  });

  it("does not spawn for a disabled-maintainer repo", async () => {
    addRepo({ maintainerEnabled: 0, lastAt: null });
    await maintainerPass();
    expect(vi.mocked(maint.spawnSurvey)).not.toHaveBeenCalled();
  });
});

describe("maintainerPass — file half", () => {
  it("files a ready survey's tasks (capped at 5) as fenced maintainer rows, then reclaims the run", async () => {
    const id = addRepo({ maintainerEnabled: 0 }); // spawn half skips; isolate filing
    vi.mocked(maint.trackedSurveyIds).mockReturnValue(["s1"]);
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      title: `Task ${i}`,
      body: "do it",
      rationale: "signal",
      rank: i,
    }));
    vi.mocked(maint.readSurveyRun).mockResolvedValue({
      status: "ready",
      repoId: id,
      tasks,
    });

    await maintainerPass();

    const pending = queries.listPendingForRepo(db()).all(id) as IssueDispatch[];
    expect(pending).toHaveLength(5); // DEFAULT_SURVEY_CAP
    expect(pending.every((r) => r.maintainer_proposed === 1)).toBe(true);
    expect(pending.every((r) => r.source === "local")).toBe(true);
    // None are auto-dispatchable (fenced).
    expect(queries.listPendingDispatchableForRepo(db()).all(id)).toHaveLength(
      0
    );
    expect(vi.mocked(maint.cleanupSurveyRun)).toHaveBeenCalledWith("s1");
  });

  it("dedupes by exact title against an already-open task", async () => {
    const id = addRepo({ maintainerEnabled: 0 });
    // An open local task already named "Bump eslint".
    queries
      .insertMaintainerTask(db())
      .run(
        "existing",
        id,
        "Bump eslint",
        "[maintainer] x",
        "2026-06-01T00:00:00Z"
      );
    vi.mocked(maint.trackedSurveyIds).mockReturnValue(["s1"]);
    vi.mocked(maint.readSurveyRun).mockResolvedValue({
      status: "ready",
      repoId: id,
      tasks: [
        { title: "Bump eslint", body: "b", rationale: "r", rank: 1 }, // dup
        { title: "Fix flaky test", body: "b", rationale: "r", rank: 2 },
      ],
    });

    await maintainerPass();

    const titles = (queries.listPendingForRepo(db()).all(id) as IssueDispatch[])
      .map((r) => r.issue_title)
      .sort();
    expect(titles).toEqual(["Bump eslint", "Fix flaky test"]); // dup not re-filed
  });

  it("files nothing for a failed survey but still reclaims the run", async () => {
    const id = addRepo({ maintainerEnabled: 0 });
    vi.mocked(maint.trackedSurveyIds).mockReturnValue(["s1"]);
    vi.mocked(maint.readSurveyRun).mockResolvedValue({
      status: "failed",
      repoId: id,
    });

    await maintainerPass();

    expect(queries.listPendingForRepo(db()).all(id)).toHaveLength(0);
    expect(vi.mocked(maint.cleanupSurveyRun)).toHaveBeenCalledWith("s1");
  });

  it("leaves a still-running survey alone (no file, no cleanup)", async () => {
    const id = addRepo({ maintainerEnabled: 0 });
    vi.mocked(maint.trackedSurveyIds).mockReturnValue(["s1"]);
    vi.mocked(maint.readSurveyRun).mockResolvedValue({ status: "running" });

    await maintainerPass();

    expect(queries.listPendingForRepo(db()).all(id)).toHaveLength(0);
    expect(vi.mocked(maint.cleanupSurveyRun)).not.toHaveBeenCalled();
  });
});
