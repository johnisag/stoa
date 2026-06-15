import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
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
