/**
 * Locks the `resolveStaleDispatch` query's race guard against a REAL in-memory
 * sqlite (the guard lives purely in SQL text — `WHERE id = ? AND status =
 * 'pr_open'` — so a unit mock can't catch it being dropped). The guard is the whole
 * reason a manual Re-check tap can't clobber a status a concurrent reconcile tick /
 * auto-merge already wrote: the write must be a no-op (changes === 0) on any row
 * that has already left 'pr_open'.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db";

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
  // A real parent repo row so the issue_dispatches FK (repo_id) is satisfied.
  queries
    .createDispatchRepo(db)
    .run(
      "r1",
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
});

beforeEach(() => {
  db.exec("DELETE FROM issue_dispatches;");
});

let issueSeq = 1;
function insertRow(id: string, status: string): void {
  db.prepare(
    `INSERT INTO issue_dispatches (id, repo_id, issue_number, status) VALUES (?, 'r1', ?, ?)`
  ).run(id, issueSeq++, status);
}
const statusOf = (id: string): string =>
  (
    db.prepare(`SELECT status FROM issue_dispatches WHERE id = ?`).get(id) as {
      status: string;
    }
  ).status;

describe("resolveStaleDispatch — guarded WHERE status='pr_open'", () => {
  it("resolves a still-open row to the given terminal status", () => {
    insertRow("a", "pr_open");
    const info = queries.resolveStaleDispatch(db).run("merged", "a");
    expect(info.changes).toBe(1);
    expect(statusOf("a")).toBe("merged");
  });

  it("is a NO-OP on a row already moved off pr_open (a tick/auto-merge won the race)", () => {
    insertRow("b", "merged");
    const info = queries.resolveStaleDispatch(db).run("cancelled", "b");
    expect(info.changes).toBe(0); // guard refused to clobber
    expect(statusOf("b")).toBe("merged"); // the newer status is preserved
  });

  it("is a NO-OP on a dispatched row (only an open PR is reconcilable)", () => {
    insertRow("c", "dispatched");
    const info = queries.resolveStaleDispatch(db).run("merged", "c");
    expect(info.changes).toBe(0);
    expect(statusOf("c")).toBe("dispatched");
  });
});
