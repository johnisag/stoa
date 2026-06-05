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

vi.mock("@/lib/dispatch/dispatcher", () => ({ dispatchOne: vi.fn() }));
vi.mock("@/lib/dispatch/issues", () => ({
  listEligibleIssues: vi.fn(() => []),
}));
vi.mock("@/lib/pr", () => ({ getPRForBranch: vi.fn(() => null) }));
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ list: async () => [] }),
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});

import { reconcileTick } from "@/lib/dispatch/reconciler";
import { queries } from "@/lib/db";
import { dispatchOne } from "@/lib/dispatch/dispatcher";
import { listEligibleIssues } from "@/lib/dispatch/issues";

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
  vi.mocked(listEligibleIssues).mockReturnValue([]);
});

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
    vi.mocked(listEligibleIssues).mockReturnValue([issue(1), issue(2)]);

    await reconcileTick();
    expect(queries.listPendingForRepo(db()).all(repo)).toHaveLength(2);

    await reconcileTick(); // same issues again
    expect(queries.listPendingForRepo(db()).all(repo)).toHaveLength(2); // not 4
  });

  it("skips disabled repos entirely (no ingest, no dispatch)", async () => {
    const repo = addRepo({ enabled: 0, mode: "auto" });
    vi.mocked(listEligibleIssues).mockReturnValue([issue(1)]);

    await reconcileTick();

    expect(vi.mocked(listEligibleIssues)).not.toHaveBeenCalled();
    expect(vi.mocked(dispatchOne)).not.toHaveBeenCalled();
    expect(queries.listPendingForRepo(db()).all(repo)).toHaveLength(0);
  });
});
