/**
 * DB-level tests for Best-of-N tables and prepared-statement helpers.
 *
 * Uses a real in-memory SQLite with the full schema + migrations. No real
 * sessions are spawned; candidate session_id is NULL (allowed by the FK schema).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { randomUUID } from "crypto";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => state.db,
    get db() {
      return state.db;
    },
  };
});

import { queries } from "@/lib/db";
import type { BestOfNRun, BestOfNCandidate } from "@/lib/db";

function db() {
  return state.db as InstanceType<typeof Database>;
}

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().exec("DELETE FROM best_of_n_candidates;");
  db().exec("DELETE FROM best_of_n_runs;");
});

describe("best_of_n_runs — createBonRun / getBonRun", () => {
  it("inserts a run row and reads it back", () => {
    const id = randomUUID();
    queries.createBonRun(db()).run(id, "Fix the bug", "main", 2, null);
    const row = queries.getBonRun(db()).get(id) as BestOfNRun;

    expect(row.id).toBe(id);
    expect(row.task).toBe("Fix the bug");
    expect(row.base_branch).toBe("main");
    expect(row.n).toBe(2);
    expect(row.status).toBe("running");
    expect(row.winner_session_id).toBeNull();
    expect(row.project_id).toBeNull();
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  it("returns undefined for an unknown run id", () => {
    const row = queries.getBonRun(db()).get(randomUUID());
    expect(row).toBeUndefined();
  });
});

describe("best_of_n_candidates — createBonCandidate / getBonCandidatesByRun", () => {
  it("inserts N candidates and queries them by run_id", () => {
    const runId = randomUUID();
    queries.createBonRun(db()).run(runId, "Refactor auth", "main", 3, null);

    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < 3; i++) {
      queries.createBonCandidate(db()).run(
        ids[i],
        runId,
        null, // session_id (no real sessions in unit tests)
        `/worktrees/bon-${i}`,
        `feature/bon-${i}`,
        i
      );
    }

    const candidates = queries
      .getBonCandidatesByRun(db())
      .all(runId) as BestOfNCandidate[];

    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.candidate_index)).toEqual([0, 1, 2]);
    expect(candidates[0].worktree_path).toBe("/worktrees/bon-0");
    expect(candidates[0].branch_name).toBe("feature/bon-0");
    expect(candidates[0].is_winner).toBe(0);
    expect(candidates[0].diff).toBeNull();
  });

  it("returns an empty array for an unknown run_id", () => {
    const rows = queries.getBonCandidatesByRun(db()).all(randomUUID());
    expect(rows).toHaveLength(0);
  });
});

describe("updateBonCandidateDiff", () => {
  it("stores the diff text on the candidate row", () => {
    const runId = randomUUID();
    queries.createBonRun(db()).run(runId, "task", "main", 2, null);

    const cId = randomUUID();
    queries.createBonCandidate(db()).run(
      cId,
      runId,
      null,
      "/wt/bon-0",
      "feature/bon-0",
      0
    );

    queries.updateBonCandidateDiff(db()).run("diff --git a/foo...", cId);

    const candidates = queries
      .getBonCandidatesByRun(db())
      .all(runId) as BestOfNCandidate[];
    expect(candidates[0].diff).toBe("diff --git a/foo...");
  });
});

describe("markBonWinner", () => {
  it("sets is_winner=1 on exactly the chosen candidate and 0 on the rest", () => {
    const runId = randomUUID();
    queries.createBonRun(db()).run(runId, "task", "main", 2, null);

    const [id0, id1] = [randomUUID(), randomUUID()];
    queries.createBonCandidate(db()).run(id0, runId, null, null, null, 0);
    queries.createBonCandidate(db()).run(id1, runId, null, null, null, 1);

    // Pick id1 as the winner.
    queries.markBonWinner(db()).run(id1, runId);

    const candidates = queries
      .getBonCandidatesByRun(db())
      .all(runId) as BestOfNCandidate[];

    const winner = candidates.find((c) => c.id === id1);
    const loser = candidates.find((c) => c.id === id0);

    expect(winner?.is_winner).toBe(1);
    expect(loser?.is_winner).toBe(0);
  });
});

describe("updateBonRunStatus", () => {
  it("updates status to done with null winner_session_id", () => {
    const runId = randomUUID();
    queries.createBonRun(db()).run(runId, "task", "main", 2, null);

    // In unit tests we have no real sessions, so winner_session_id stays null.
    queries.updateBonRunStatus(db()).run("done", null, runId);

    const row = queries.getBonRun(db()).get(runId) as BestOfNRun;
    expect(row.status).toBe("done");
    expect(row.winner_session_id).toBeNull();
  });

  it("updates status to failed", () => {
    const runId = randomUUID();
    queries.createBonRun(db()).run(runId, "task", "main", 2, null);

    queries.updateBonRunStatus(db()).run("failed", null, runId);

    const row = queries.getBonRun(db()).get(runId) as BestOfNRun;
    expect(row.status).toBe("failed");
  });
});

describe("cascade delete", () => {
  it("deleting the run row removes all candidate rows", () => {
    const runId = randomUUID();
    queries.createBonRun(db()).run(runId, "task", "main", 2, null);
    queries.createBonCandidate(db()).run(randomUUID(), runId, null, null, null, 0);
    queries.createBonCandidate(db()).run(randomUUID(), runId, null, null, null, 1);

    // Verify they exist.
    expect(
      queries.getBonCandidatesByRun(db()).all(runId)
    ).toHaveLength(2);

    // Delete the run.
    db().prepare("DELETE FROM best_of_n_runs WHERE id = ?").run(runId);

    // Candidates should be gone (ON DELETE CASCADE).
    expect(
      queries.getBonCandidatesByRun(db()).all(runId)
    ).toHaveLength(0);
  });
});
