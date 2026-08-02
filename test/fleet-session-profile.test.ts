import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "@/lib/db";
import { createSchema } from "@/lib/db/schema";
import {
  findFleetSessionByOwner,
  fleetSessionProfileError,
} from "@/lib/fleet/session-profile";
import {
  commitConductorSessionDeletion,
  planConductorSessionDeletion,
} from "@/lib/session-deletion";
import { insertFleetOwnedSession } from "./fleet-session-fixture";

describe("Fleet owner-bound session profiles", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createSchema(db);
  });

  afterEach(() => db.close());

  function worker(sessionId = "worker-session", ownerId = "worker-1") {
    return insertFleetOwnedSession(db, {
      runId: "run-1",
      ownerType: "worker",
      ownerId,
      sessionId,
      provider: "codex",
      model: "gpt-5.5",
      approvalMode: "full-bypass",
      workingDirectory: "C:\\repo\\.stoa-worktrees\\task-1",
      workerTask: "Implement the exact approved task",
      worktreePath: "C:\\repo\\.stoa-worktrees\\task-1",
      branchName: "feature/fleet-task-1",
      baseBranch: "a".repeat(40),
      fleetOwnershipKey: null,
    });
  }

  it("requires the exact run, owner, session, role, hash, and launch fields", () => {
    const session = worker();
    const expected = {
      runId: "run-1",
      ownerType: "worker" as const,
      ownerId: "worker-1",
      sessionId: session.id,
    };
    expect(fleetSessionProfileError(session, expected)).toBeNull();
    expect(
      fleetSessionProfileError(
        { ...session, session_role: "interactive" },
        expected
      )
    ).toMatch(/profile/i);
    expect(
      fleetSessionProfileError(
        { ...session, launch_profile_hash: "0".repeat(64) },
        expected
      )
    ).toMatch(/profile/i);
    expect(
      fleetSessionProfileError(
        { ...session, working_directory: "C:\\foreign" },
        expected
      )
    ).toMatch(/profile/i);
    expect(
      fleetSessionProfileError(session, { ...expected, runId: "run-2" })
    ).toMatch(/profile/i);
    expect(
      fleetSessionProfileError(session, {
        ...expected,
        sessionId: "different-session",
      })
    ).toMatch(/missing/i);
  });

  it("never adopts an interactive branch-and-prompt decoy", () => {
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, working_directory, group_path, agent_type,
        worker_task, worktree_path, branch_name, base_branch)
       VALUES ('decoy', 'Decoy', 'codex-decoy', ?, 'sessions', 'codex', ?, ?, ?, ?)`
    ).run(
      "C:\\repo\\.stoa-worktrees\\task-1",
      "Implement the exact approved task",
      "C:\\repo\\.stoa-worktrees\\task-1",
      "feature/fleet-task-1",
      "a".repeat(40)
    );

    expect(
      findFleetSessionByOwner(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-1",
      })
    ).toMatchObject({ kind: "missing" });
  });

  it("rejects a corrupted matching profile instead of treating it as absent", () => {
    const session = worker();
    db.exec(`DROP TRIGGER trg_sessions_launch_profile_immutable`);
    db.prepare(`UPDATE sessions SET launch_profile_hash = ? WHERE id = ?`).run(
      "0".repeat(64),
      session.id
    );

    expect(
      findFleetSessionByOwner(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-1",
      })
    ).toMatchObject({
      kind: "invalid",
      error: expect.stringMatching(/profile/i),
    });
  });

  it("rejects duplicate exact-owner candidates as ambiguous", () => {
    worker("worker-session-a");
    worker("worker-session-b");

    expect(
      findFleetSessionByOwner(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-1",
      })
    ).toMatchObject({ kind: "ambiguous" });
  });

  it("preserves an exact profile after its interactive conductor is deleted", () => {
    db.prepare(
      `INSERT INTO sessions (id, name, tmux_name, agent_type)
       VALUES ('conductor', 'Conductor', 'codex-conductor', 'codex')`
    ).run();
    const original = insertFleetOwnedSession(db, {
      runId: "run-1",
      ownerType: "worker",
      ownerId: "worker-1",
      sessionId: "worker-session",
      provider: "codex",
      model: "gpt-5.5",
      approvalMode: "full-bypass",
      workingDirectory: "C:\\repo\\.stoa-worktrees\\task-1",
      workerTask: "Implement the exact approved task",
      worktreePath: "C:\\repo\\.stoa-worktrees\\task-1",
      branchName: "feature/fleet-task-1",
      baseBranch: "a".repeat(40),
      conductorSessionId: "conductor",
      fleetOwnershipKey: null,
    });

    commitConductorSessionDeletion(
      db,
      planConductorSessionDeletion(db, "conductor")
    );

    const detached = db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(original.id) as Session;
    expect(detached.conductor_session_id).toBeNull();
    expect(detached.launch_profile_json).toBe(original.launch_profile_json);
    expect(detached.launch_profile_hash).toBe(original.launch_profile_hash);
    const expected = {
      runId: "run-1",
      ownerType: "worker" as const,
      ownerId: "worker-1",
      sessionId: detached.id,
    };
    expect(fleetSessionProfileError(detached, expected)).toBeNull();
    expect(
      fleetSessionProfileError(
        { ...detached, model: "foreign-model" },
        expected
      )
    ).toMatch(/profile/i);
    expect(
      fleetSessionProfileError(
        { ...detached, conductor_session_id: "different-conductor" },
        expected
      )
    ).toMatch(/profile/i);
  });
});
