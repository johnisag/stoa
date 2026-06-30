/**
 * Fresh DB schema integrity — locks the indexes/columns that the rest of the
 * app assumes exist when createSchema runs on a brand-new database.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(":memory:");
  createSchema(db);
});

function hasIndex(name: string): boolean {
  return (
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .all(name) as { name: string }[]
    ).length > 0
  );
}

function hasColumn(table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => (c as { name: string }).name === column);
}

describe("fresh schema indexes", () => {
  it("has the dev_servers project_id index", () => {
    expect(hasIndex("idx_dev_servers_project")).toBe(true);
  });

  it("has the sessions group/conductor/project indexes", () => {
    expect(hasIndex("idx_sessions_group")).toBe(true);
    expect(hasIndex("idx_sessions_conductor")).toBe(true);
    expect(hasIndex("idx_sessions_project")).toBe(true);
  });
});

describe("fresh schema sessions columns", () => {
  it("has the orchestration columns referenced by indexes", () => {
    expect(hasColumn("sessions", "conductor_session_id")).toBe(true);
    expect(hasColumn("sessions", "project_id")).toBe(true);
  });

  it("has the fork_cost_baseline column (#1 — schema/migration parity)", () => {
    // schema.ts must carry it too, so migration 44's guarded ALTER is a no-op on a
    // fresh DB (and the cost path can read s.fork_cost_baseline).
    expect(hasColumn("sessions", "fork_cost_baseline")).toBe(true);
  });
});
