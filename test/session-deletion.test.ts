import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import {
  commitConductorSessionDeletion,
  ConductorSessionDeletionRejectedError,
  DETACHABLE_FLEET_SESSION_ROLES,
  planConductorSessionDeletion,
} from "@/lib/session-deletion";
import { internalSessionProfile } from "./internal-session-fixture";

let database: InstanceType<typeof Database>;

function addSession(input: {
  id: string;
  role?: string;
  conductorId?: string | null;
  parentId?: string | null;
}): void {
  const role = input.role ?? "interactive";
  const profile = role === "interactive" ? null : internalSessionProfile(role);
  database
    .prepare(
      `INSERT INTO sessions
       (id, name, session_role, launch_profile_json, launch_profile_hash,
        conductor_session_id, parent_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.id,
      role,
      profile?.profileJson ?? null,
      profile?.profileHash ?? null,
      input.conductorId ?? null,
      input.parentId ?? null
    );
}

function sessionRelationships(): Array<{
  id: string;
  conductor_session_id: string | null;
}> {
  return database
    .prepare(`SELECT id, conductor_session_id FROM sessions ORDER BY id`)
    .all() as Array<{ id: string; conductor_session_id: string | null }>;
}

beforeEach(() => {
  database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  createSchema(database);
  runMigrations(database);
});

afterEach(() => database.close());

describe("atomic conductor session deletion", () => {
  it("deletes ordinary workers while preserving and detaching all five Fleet roles", () => {
    addSession({ id: "conductor" });
    addSession({ id: "ordinary-worker", conductorId: "conductor" });
    for (const role of DETACHABLE_FLEET_SESSION_ROLES) {
      addSession({ id: role, role, conductorId: "conductor" });
    }

    const plan = planConductorSessionDeletion(database, "conductor");
    expect(plan.interactiveWorkers.map((row) => row.id)).toEqual([
      "ordinary-worker",
    ]);
    expect(plan.detachableFleetChildren.map((row) => row.session_role)).toEqual(
      [...DETACHABLE_FLEET_SESSION_ROLES].sort()
    );

    commitConductorSessionDeletion(database, plan);

    expect(sessionRelationships()).toEqual(
      [...DETACHABLE_FLEET_SESSION_ROLES]
        .sort()
        .map((id) => ({ id, conductor_session_id: null }))
    );
  });

  it("rolls back Fleet detachment and ordinary deletion when a foreign key rejects the commit", () => {
    addSession({ id: "conductor" });
    addSession({ id: "ordinary-worker", conductorId: "conductor" });
    addSession({
      id: "fleet-reviewer",
      role: "fleet_task_reviewer",
      conductorId: "conductor",
    });
    database.exec(`
      CREATE TABLE test_session_delete_blocker (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id)
      );
      INSERT INTO test_session_delete_blocker (id, session_id)
      VALUES ('blocker', 'conductor');
    `);
    const before = sessionRelationships();
    const plan = planConductorSessionDeletion(database, "conductor");

    database.transaction(() => {
      expect(() => commitConductorSessionDeletion(database, plan)).toThrow(
        /foreign key constraint/i
      );
      // Catch the nested failure and keep the outer transaction alive: the
      // helper's own savepoint must already have restored every relationship.
      expect(sessionRelationships()).toEqual(before);
    })();
    expect(sessionRelationships()).toEqual(before);
  });

  it("rejects unknown internal children and leaves their immutable relationship intact", () => {
    addSession({ id: "conductor" });
    addSession({
      id: "future-child",
      role: "future_internal_role",
      conductorId: "conductor",
    });

    expect(() => planConductorSessionDeletion(database, "conductor")).toThrow(
      ConductorSessionDeletionRejectedError
    );
    expect(() =>
      database
        .prepare(`UPDATE sessions SET conductor_session_id = NULL WHERE id = ?`)
        .run("future-child")
    ).toThrow(/immutable/i);
    expect(sessionRelationships()).toEqual([
      { id: "conductor", conductor_session_id: null },
      { id: "future-child", conductor_session_id: "conductor" },
    ]);
  });

  it("preflights parent-session blockers before changing any relationship", () => {
    addSession({ id: "conductor" });
    addSession({ id: "parent-linked-child", parentId: "conductor" });
    const before = sessionRelationships();

    expect(() => planConductorSessionDeletion(database, "conductor")).toThrow(
      /references it as a parent/i
    );
    expect(sessionRelationships()).toEqual(before);
  });

  it("fails closed on a self-referential conductor row", () => {
    addSession({ id: "conductor" });
    database
      .prepare(`UPDATE sessions SET conductor_session_id = id WHERE id = ?`)
      .run("conductor");

    expect(() => planConductorSessionDeletion(database, "conductor")).toThrow(
      /self-referential/i
    );
    expect(sessionRelationships()).toEqual([
      { id: "conductor", conductor_session_id: "conductor" },
    ]);
  });
});
