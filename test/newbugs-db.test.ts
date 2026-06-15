import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";

describe("countDispatchesToday", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    // Parent row — issue_dispatches.repo_id has a FK to dispatch_repos(id).
    db.prepare(
      `INSERT INTO dispatch_repos (id, repo_path, repo_slug) VALUES ('r1', '/repo', 'owner/repo')`
    ).run();
  });

  const insert = (id: string, status: string, when: string, issue = 1) =>
    db
      .prepare(
        `INSERT INTO issue_dispatches (id, repo_id, issue_number, status, dispatched_at)
         VALUES (?, 'r1', ?, ?, ${when})`
      )
      .run(id, issue, status);

  it("counts today's non-failed dispatches, excluding failed rows and other days", () => {
    insert("today-ok", "pr_open", "datetime('now')", 1);
    insert("today-ok-2", "dispatched", "datetime('now')", 2);
    insert("today-failed", "failed", "datetime('now')", 3); // excluded: failed
    insert("yesterday", "pr_open", "datetime('now','-2 days')", 4); // excluded: old
    insert("never", "pending", "NULL", 5); // excluded: never dispatched

    const { n } = queries.countDispatchesToday(db).get("r1") as { n: number };
    expect(n).toBe(2);
  });

  it("a failed dispatch does not burn the day's quota", () => {
    insert("f1", "failed", "datetime('now')", 1);
    insert("f2", "failed", "datetime('now')", 2);
    const { n } = queries.countDispatchesToday(db).get("r1") as { n: number };
    expect(n).toBe(0);
  });
});

describe("repo_lessons dedupe + UNIQUE (migration 37)", () => {
  const count = (db: Database.Database) =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM repo_lessons").get() as {
        n: number;
      }
    ).n;

  it("dedups existing duplicate lessons and blocks new ones", () => {
    const db = new Database(":memory:");
    createSchema(db); // base schema — no UNIQUE index yet
    db.prepare(
      `INSERT INTO dispatch_repos (id, repo_path, repo_slug) VALUES ('r1','/r','o/r')`
    ).run();
    // Two identical (repo_id, text) lessons land before the index exists.
    const raw = db.prepare(
      `INSERT INTO repo_lessons (id, repo_id, lens, text) VALUES (?, 'r1', 'lens', 'dup')`
    );
    raw.run("a");
    raw.run("b");
    expect(count(db)).toBe(2);

    runMigrations(db); // migration 37 dedups + adds UNIQUE(repo_id, text)
    expect(count(db)).toBe(1);

    // A further duplicate is now a silent no-op (OR IGNORE + the unique index).
    db.prepare(
      `INSERT OR IGNORE INTO repo_lessons (id, repo_id, lens, text) VALUES (?, 'r1', 'lens', 'dup')`
    ).run("c");
    expect(count(db)).toBe(1);
  });
});
