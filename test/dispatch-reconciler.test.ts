/**
 * Reconciler behavior against a real in-memory SQLite (real schema + queries),
 * with the side-effecting collaborators mocked: gh ingestion, the spawning
 * dispatcher, gh PR lookup, and the session backend. Asserts the core policy:
 * auto dispatches up to the slot count, review leaves candidates pending,
 * disabled repos are skipped, and ingestion is idempotent.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import type { EligibleIssue } from "@/lib/dispatch/types";

// Mutable holder so the db mock can return the in-memory db created in beforeAll.
const state = vi.hoisted(() => ({ db: null as unknown }));
// Reconfigurable backend.list() — drives the dead-worker sweep.
const backendList = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));

vi.mock("@/lib/dispatch/dispatcher", () => ({ dispatchOne: vi.fn() }));
vi.mock("@/lib/dispatch/issues", () => ({
  listEligibleIssues: vi.fn(async () => []),
  getPRForBranchAnyState: vi.fn(async () => null),
}));
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ list: backendList }),
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});

import { randomUUID } from "crypto";
import { reconcileTick, sweepActiveWorkers } from "@/lib/dispatch/reconciler";
import { queries } from "@/lib/db";
import { dispatchOne } from "@/lib/dispatch/dispatcher";
import {
  listEligibleIssues,
  getPRForBranchAnyState,
} from "@/lib/dispatch/issues";
import type { IssueDispatch } from "@/lib/dispatch/types";

function db() {
  return state.db as InstanceType<typeof Database>;
}

let repoSeq = 0;
function addRepo(over: Partial<Record<string, unknown>> = {}): string {
  const id = `repo-${repoSeq++}`;
  queries
    .createDispatchRepo(db())
    .run(
      id,
      (over.repo_path as string) ?? "/tmp/repo",
      (over.repo_slug as string) ?? "o/r",
      (over.agent_type as string) ?? "claude",
      (over.daily_quota as number) ?? 5,
      (over.max_concurrency as number) ?? 5,
      (over.label_filter as string | null) ?? null,
      (over.base_branch as string) ?? "main",
      (over.mode as string) ?? "auto",
      (over.enabled as number) ?? 1,
      (over.review_gate as number) ?? 0,
      (over.ci_autofix as number) ?? 0,
      null
    );
  return id;
}

let candSeq = 0;
function addPending(repoId: string, issueNumber: number) {
  queries
    .upsertDispatchCandidate(db())
    .run(
      `cand-${candSeq++}`,
      repoId,
      issueNumber,
      `Issue ${issueNumber}`,
      `https://x/${issueNumber}`,
      "2026-06-01T00:00:00Z"
    );
}

const issue = (n: number): EligibleIssue => ({
  number: n,
  title: `Issue ${n}`,
  url: `https://x/${n}`,
  createdAt: "2026-06-01T00:00:00Z",
  labels: [],
});

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().exec(
    "DELETE FROM issue_dispatches; DELETE FROM dispatch_repos; DELETE FROM sessions;"
  );
  vi.clearAllMocks();
  vi.mocked(listEligibleIssues).mockResolvedValue([]);
  vi.mocked(getPRForBranchAnyState).mockResolvedValue(null);
  backendList.mockResolvedValue([]);
});

// Insert a live-worker dispatch: a session row (so getSession resolves) + a
// 'dispatched' issue row pointing at it, dispatched_at=now (counts toward today).
function addDispatchedWithSession(
  repoId: string,
  issueNumber: number,
  opts: { tmuxName: string; worktree?: string; branch?: string }
): string {
  const sessionId = randomUUID();
  queries
    .createSession(db())
    .run(
      sessionId,
      `#${issueNumber}`,
      opts.tmuxName,
      opts.worktree ?? "/tmp/wt",
      null,
      "sonnet",
      null,
      "sessions",
      "claude",
      1,
      "uncategorized"
    );
  const dispatchId = `disp-${candSeq++}`;
  db()
    .prepare(
      `INSERT INTO issue_dispatches (id, repo_id, issue_number, status, session_id, worktree_path, branch_name, dispatched_at)
       VALUES (?, ?, ?, 'dispatched', ?, ?, ?, datetime('now'))`
    )
    .run(
      dispatchId,
      repoId,
      issueNumber,
      sessionId,
      opts.worktree ?? "/tmp/wt",
      opts.branch ?? "feature/x"
    );
  return dispatchId;
}

const getStatus = (id: string) =>
  (queries.getDispatch(db()).get(id) as IssueDispatch).status;

describe("reconcileTick", () => {
  it("auto mode dispatches up to the slot count (concurrency-bound)", async () => {
    const repo = addRepo({ mode: "auto", daily_quota: 5, max_concurrency: 2 });
    addPending(repo, 1);
    addPending(repo, 2);
    addPending(repo, 3);

    await reconcileTick();

    expect(vi.mocked(dispatchOne)).toHaveBeenCalledTimes(2); // capped at 2
  });

  it("review mode never dispatches — candidates stay pending", async () => {
    const repo = addRepo({
      mode: "review",
      daily_quota: 5,
      max_concurrency: 5,
    });
    addPending(repo, 1);
    addPending(repo, 2);

    await reconcileTick();

    expect(vi.mocked(dispatchOne)).not.toHaveBeenCalled();
    const n = (queries.countLiveInFlight(db()).get(repo) as { n: number }).n;
    expect(n).toBe(0);
    const pending = queries.listPendingForRepo(db()).all(repo);
    expect(pending).toHaveLength(2);
  });

  it("ingests eligible issues as pending candidates, idempotently", async () => {
    const repo = addRepo({ mode: "review" });
    vi.mocked(listEligibleIssues).mockResolvedValue([issue(1), issue(2)]);

    await reconcileTick();
    expect(queries.listPendingForRepo(db()).all(repo)).toHaveLength(2);

    await reconcileTick(); // same issues again
    expect(queries.listPendingForRepo(db()).all(repo)).toHaveLength(2); // not 4
  });

  it("skips disabled repos entirely (no ingest, no dispatch)", async () => {
    const repo = addRepo({ enabled: 0, mode: "auto" });
    vi.mocked(listEligibleIssues).mockResolvedValue([issue(1)]);

    await reconcileTick();

    expect(vi.mocked(listEligibleIssues)).not.toHaveBeenCalled();
    expect(vi.mocked(dispatchOne)).not.toHaveBeenCalled();
    expect(queries.listPendingForRepo(db()).all(repo)).toHaveLength(0);
  });

  it("honors the daily cap read from the DB (already-dispatched today)", async () => {
    const repo = addRepo({ mode: "auto", daily_quota: 2, max_concurrency: 5 });
    // Two workers already dispatched today → quota exhausted.
    addDispatchedWithSession(repo, 1, { tmuxName: "claude-a" });
    addDispatchedWithSession(repo, 2, { tmuxName: "claude-b" });
    addPending(repo, 3);
    backendList.mockResolvedValue(["claude-a", "claude-b"]); // both still live

    await reconcileTick();

    expect(vi.mocked(dispatchOne)).not.toHaveBeenCalled(); // 2/2 used today
  });
});

describe("sweepActiveWorkers", () => {
  it("links a PR and frees the slot (dispatched → pr_open)", async () => {
    const repo = addRepo();
    const d = addDispatchedWithSession(repo, 1, {
      tmuxName: "claude-x",
      branch: "feature/x",
      worktree: "/tmp/wt",
    });
    backendList.mockResolvedValue(["claude-x"]);
    vi.mocked(getPRForBranchAnyState).mockResolvedValue({
      number: 7,
      url: "https://pr/7",
      state: "OPEN",
    });

    await sweepActiveWorkers({ guardEmptyList: false });

    const row = queries.getDispatch(db()).get(d) as IssueDispatch;
    expect(row.status).toBe("pr_open");
    expect(row.pr_number).toBe(7);
    expect(row.pr_url).toBe("https://pr/7");
    // pr_open no longer counts against the concurrency cap.
    expect((queries.countLiveInFlight(db()).get(repo) as { n: number }).n).toBe(
      0
    );
  });

  it("records a merged PR as 'merged' (not mislabeled failed)", async () => {
    const repo = addRepo();
    const d = addDispatchedWithSession(repo, 1, {
      tmuxName: "claude-gone",
      branch: "feature/x",
    });
    backendList.mockResolvedValue([]); // agent exited after the merge
    vi.mocked(getPRForBranchAnyState).mockResolvedValue({
      number: 9,
      url: "https://pr/9",
      state: "MERGED",
    });

    await sweepActiveWorkers({ guardEmptyList: false });

    expect(getStatus(d)).toBe("merged");
  });

  it("marks a dead worker (no PR, session gone) failed", async () => {
    const repo = addRepo();
    const d = addDispatchedWithSession(repo, 1, { tmuxName: "claude-gone" });
    backendList.mockResolvedValue(["claude-other"]); // session not live

    await sweepActiveWorkers({ guardEmptyList: false });

    expect(getStatus(d)).toBe("failed");
  });

  it("leaves a live worker dispatched", async () => {
    const repo = addRepo();
    const d = addDispatchedWithSession(repo, 1, { tmuxName: "claude-live" });
    backendList.mockResolvedValue(["claude-live"]);

    await sweepActiveWorkers({ guardEmptyList: false });

    expect(getStatus(d)).toBe("dispatched");
  });

  it("startup guard does NOT mass-fail on an empty list (Tier-2 rehydration race)", async () => {
    const repo = addRepo();
    const d = addDispatchedWithSession(repo, 1, { tmuxName: "claude-x" });
    backendList.mockResolvedValue([]); // ambiguous: daemon may be mid-hydration

    await sweepActiveWorkers({ guardEmptyList: true });

    expect(getStatus(d)).toBe("dispatched"); // not failed at startup
  });

  it("steady-state sweep DOES fail a dead worker on an empty list (no deadlock)", async () => {
    const repo = addRepo();
    const d = addDispatchedWithSession(repo, 1, { tmuxName: "claude-x" });
    backendList.mockResolvedValue([]); // genuinely no live sessions, 60s in

    await sweepActiveWorkers({ guardEmptyList: false });

    expect(getStatus(d)).toBe("failed"); // slot freed — won't pin forever
  });
});
