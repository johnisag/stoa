import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import {
  claimConductorSessionDeletion,
  commitConductorSessionDeletion,
  ConductorSessionDeletionRejectedError,
  DETACHABLE_FLEET_SESSION_ROLES,
  isSessionDeletionBackendKeyFenced,
  isSessionDeletionFenced,
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

    const plan = claimConductorSessionDeletion(database, "conductor");
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
    `);
    const before = sessionRelationships();
    const plan = claimConductorSessionDeletion(database, "conductor");
    // Simulate an out-of-schema writer creating a new restrictive reference
    // after the durable claim. The commit must restore the claimed state.
    database
      .prepare(
        `INSERT INTO test_session_delete_blocker (id, session_id)
         VALUES ('blocker', 'conductor')`
      )
      .run();

    database.transaction(() => {
      expect(() => commitConductorSessionDeletion(database, plan)).toThrow(
        /foreign key constraint/i
      );
      // Catch the nested failure and keep the outer transaction alive: the
      // helper's own savepoint must already have restored every relationship.
      expect(sessionRelationships()).toEqual(before);
    })();
    expect(sessionRelationships()).toEqual(before);
    expect(
      database.prepare(`SELECT state FROM session_deletion_claims`).get()
    ).toEqual({ state: "claimed" });
    expect(() =>
      addSession({ id: "late-worker", conductorId: "conductor" })
    ).toThrow(/session deletion is in progress/i);

    database
      .prepare(`DELETE FROM test_session_delete_blocker WHERE id = 'blocker'`)
      .run();
    const recovered = claimConductorSessionDeletion(database, "conductor");
    expect(recovered).toEqual(plan);
    commitConductorSessionDeletion(database, recovered);
    expect(sessionRelationships()).toEqual([
      { id: "fleet-reviewer", conductor_session_id: null },
    ]);
  });

  it("preflights restrictive foreign-key blockers before publishing a claim", () => {
    addSession({ id: "conductor" });
    database.exec(`
      CREATE TABLE test_session_delete_blocker (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id)
      );
      INSERT INTO test_session_delete_blocker (id, session_id)
      VALUES ('blocker', 'conductor');
    `);

    expect(() => claimConductorSessionDeletion(database, "conductor")).toThrow(
      /database record still references it/i
    );
    expect(
      database.prepare(`SELECT 1 FROM session_deletion_claims`).get()
    ).toBeUndefined();
  });

  it("rejects unknown internal children and leaves their immutable relationship intact", () => {
    addSession({ id: "conductor" });
    addSession({
      id: "future-child",
      role: "future_internal_role",
      conductorId: "conductor",
    });

    expect(() => claimConductorSessionDeletion(database, "conductor")).toThrow(
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

    expect(() => claimConductorSessionDeletion(database, "conductor")).toThrow(
      /references it as a parent/i
    );
    expect(sessionRelationships()).toEqual(before);
  });

  it("fails closed on a self-referential conductor row", () => {
    addSession({ id: "conductor" });
    database
      .prepare(`UPDATE sessions SET conductor_session_id = id WHERE id = ?`)
      .run("conductor");

    expect(() => claimConductorSessionDeletion(database, "conductor")).toThrow(
      /self-referential/i
    );
    expect(sessionRelationships()).toEqual([
      { id: "conductor", conductor_session_id: "conductor" },
    ]);
  });

  it("freezes claimed identities but permits status-only progress writes", () => {
    addSession({ id: "conductor" });
    addSession({ id: "ordinary-worker", conductorId: "conductor" });
    claimConductorSessionDeletion(database, "conductor");

    expect(() =>
      database
        .prepare(`UPDATE sessions SET tmux_name = 'renamed' WHERE id = ?`)
        .run("conductor")
    ).toThrow(/session deletion is in progress/i);
    expect(() =>
      database
        .prepare(
          `INSERT INTO sessions (id, name, parent_session_id)
           VALUES ('late-child', 'Late child', 'ordinary-worker')`
        )
        .run()
    ).toThrow(/session deletion is in progress/i);
    expect(() =>
      database
        .prepare(`UPDATE sessions SET status = 'dead' WHERE id = ?`)
        .run("ordinary-worker")
    ).not.toThrow();
  });

  it("retains compact deleted-id tombstones after the commit", () => {
    addSession({ id: "conductor" });
    addSession({ id: "ordinary-worker", conductorId: "conductor" });
    const plan = claimConductorSessionDeletion(database, "conductor");
    commitConductorSessionDeletion(database, plan);

    // Production historically opened some SQLite connections without enabling
    // FK enforcement. The tombstone itself must still reject a stale writer.
    database.pragma("foreign_keys = OFF");
    expect(() =>
      addSession({ id: "late-worker", conductorId: "conductor" })
    ).toThrow(/session deletion is in progress/i);
    expect(() => addSession({ id: "conductor" })).toThrow(
      /session deletion is in progress/i
    );
    expect(
      database
        .prepare(
          `SELECT session_id, disposition
           FROM session_deletion_claim_members ORDER BY session_id`
        )
        .all()
    ).toEqual([
      { session_id: "conductor", disposition: "delete" },
      { session_id: "ordinary-worker", disposition: "delete" },
    ]);
  });

  it("fences claimed and deleted identities by session id and exact backend key", () => {
    addSession({ id: "conductor" });
    addSession({ id: "ordinary-worker", conductorId: "conductor" });
    database
      .prepare(`UPDATE sessions SET tmux_name = ? WHERE id = ?`)
      .run("custom-conductor-key", "conductor");
    database
      .prepare(`UPDATE sessions SET agent_type = ? WHERE id = ?`)
      .run("codex", "ordinary-worker");

    const plan = claimConductorSessionDeletion(database, "conductor");
    expect(isSessionDeletionFenced(database, "conductor")).toBe(true);
    expect(isSessionDeletionFenced(database, "ordinary-worker")).toBe(true);
    expect(
      isSessionDeletionBackendKeyFenced(database, "custom-conductor-key")
    ).toBe(true);
    expect(
      isSessionDeletionBackendKeyFenced(database, "codex-ordinary-worker")
    ).toBe(true);
    expect(isSessionDeletionBackendKeyFenced(database, "unrelated")).toBe(
      false
    );

    commitConductorSessionDeletion(database, plan);

    expect(isSessionDeletionFenced(database, "conductor")).toBe(true);
    expect(
      isSessionDeletionBackendKeyFenced(database, "custom-conductor-key")
    ).toBe(true);
  });

  it("migration 82 repairs a missing deletion-claim trigger", () => {
    database.exec(`
      DROP TRIGGER trg_sessions_deletion_claim_attach_guard;
      DELETE FROM _migrations WHERE id = 82;
    `);

    runMigrations(database);

    expect(
      database
        .prepare(
          `SELECT 1 FROM sqlite_master
           WHERE type = 'trigger'
             AND name = 'trg_sessions_deletion_claim_attach_guard'`
        )
        .get()
    ).toBeTruthy();
    expect(
      database.prepare(`SELECT name FROM _migrations WHERE id = 82`).get()
    ).toEqual({ name: "add_session_deletion_claims" });
  });
});
