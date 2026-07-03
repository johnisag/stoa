/**
 * Checkpoints (#44) — the durable, labeled layer over snapshots. Contract:
 * a checkpoint PINS a snapshot (seq + sha); it OUTLIVES the ref (shown expired
 * once the snapshot is pruned, never a broken rewind/fork target); fork-from
 * materializes the pinned tree as an isolated worktree branched at the sha and
 * records lineage. Git I/O is mocked; the DB is real (in-memory) so FK cascade
 * and the prepared statements are exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

// Mock the git seams — snapshot capture/list and worktree creation.
const captureSnapshot = vi.fn();
const listSnapshots = vi.fn();
vi.mock("../lib/snapshots", () => ({
  captureSnapshot: (...a: unknown[]) => captureSnapshot(...a),
  listSnapshots: (...a: unknown[]) => listSnapshots(...a),
}));

const createWorktree = vi.fn();
const getMainRepoPath = vi.fn();
vi.mock("../lib/worktrees", () => ({
  createWorktree: (...a: unknown[]) => createWorktree(...a),
  getMainRepoPath: (...a: unknown[]) => getMainRepoPath(...a),
}));

import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";
import {
  createCheckpoint,
  listCheckpoints,
  prepareForkFromSnapshot,
  type CheckpointRow,
} from "@/lib/checkpoints";

function db() {
  const d = new Database(":memory:");
  createSchema(d); // base tables + checkpoints + the seeded "uncategorized" project
  runMigrations(d); // idempotent — mirrors real init
  return d;
}

// Insert a minimal session row so checkpoint FKs (session_id → sessions) resolve.
function seedSession(d: Database.Database, id: string, cwd = "/repo") {
  queries
    .createSession(d)
    .run(
      id,
      id,
      `tmux-${id}`,
      cwd,
      null,
      null,
      null,
      "sessions",
      "claude",
      0,
      "uncategorized"
    );
}

const S = (seq: number, sha: string) => ({
  seq,
  sha,
  date: "2026-01-01T00:00:00Z",
  summary: `snap ${seq}`,
});

beforeEach(() => {
  captureSnapshot.mockReset();
  listSnapshots.mockReset();
  createWorktree.mockReset();
  getMainRepoPath.mockReset();
});

describe("createCheckpoint", () => {
  it("pins a freshly captured snapshot with label + kind + transcript anchor", async () => {
    const d = db();
    seedSession(d, "sess");
    captureSnapshot.mockResolvedValue(S(4, "shaFRESH"));

    const row = await createCheckpoint(
      {
        id: "sess",
        working_directory: "/repo",
        claude_session_id: "claude-123",
      },
      { label: "before refactor" },
      d
    );

    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      session_id: "sess",
      seq: 4,
      snapshot_sha: "shaFRESH",
      summary: "before refactor",
      transcript_session_id: "claude-123",
      kind: "manual",
      created_by: "manual",
      parent_checkpoint_id: null,
    });
    // captured with the label as the snapshot subject
    expect(captureSnapshot).toHaveBeenCalledWith(
      "/repo",
      "sess",
      "before refactor"
    );
  });

  it("pins the LATEST existing snapshot when capture is a no-op (unchanged tree)", async () => {
    const d = db();
    seedSession(d, "sess");
    captureSnapshot.mockResolvedValue(null); // nothing changed
    listSnapshots.mockResolvedValue([S(1, "a"), S(2, "b"), S(3, "cLAST")]);

    const row = await createCheckpoint(
      { id: "sess", working_directory: "/repo" },
      { label: "pin here" },
      d
    );
    expect(row).toMatchObject({
      seq: 3,
      snapshot_sha: "cLAST",
      summary: "pin here",
    });
  });

  it("returns null when there is no snapshot to pin (not a repo / empty)", async () => {
    const d = db();
    seedSession(d, "sess");
    captureSnapshot.mockResolvedValue(null);
    listSnapshots.mockResolvedValue([]);

    expect(
      await createCheckpoint({ id: "sess", working_directory: "/x" }, {}, d)
    ).toBeNull();
  });

  it("records fork-origin lineage via parentCheckpointId", async () => {
    const d = db();
    seedSession(d, "sess");
    captureSnapshot.mockResolvedValue(S(1, "s1"));
    const parent = await createCheckpoint(
      { id: "sess", working_directory: "/repo" },
      { label: "root" },
      d
    );
    captureSnapshot.mockResolvedValue(S(2, "s2"));
    const child = await createCheckpoint(
      { id: "sess", working_directory: "/repo" },
      {
        kind: "fork-origin",
        createdBy: "system",
        parentCheckpointId: parent!.id,
      },
      d
    );
    expect(child).toMatchObject({
      kind: "fork-origin",
      created_by: "system",
      parent_checkpoint_id: parent!.id,
    });
  });
});

describe("listCheckpoints", () => {
  it("flags expired when the pinned snapshot is gone, live otherwise; newest-first", async () => {
    const d = db();
    seedSession(d, "sess");
    // Two checkpoints: one pinning a still-live snapshot, one pinning a pruned one.
    captureSnapshot.mockResolvedValueOnce(S(2, "live"));
    await createCheckpoint(
      { id: "sess", working_directory: "/repo" },
      { label: "keep" },
      d
    );
    captureSnapshot.mockResolvedValueOnce(S(5, "pruned"));
    await createCheckpoint(
      { id: "sess", working_directory: "/repo" },
      { label: "gone" },
      d
    );

    // Only "live" remains among the snapshot refs.
    listSnapshots.mockResolvedValue([S(2, "live")]);

    const list = await listCheckpoints(
      { id: "sess", working_directory: "/repo" },
      d
    );
    expect(list.map((c) => [c.seq, c.expired])).toEqual([
      [5, true], // newest-first, pruned → expired
      [2, false],
    ]);
  });

  it("returns [] and makes no git call when the session has no checkpoints", async () => {
    const d = db();
    seedSession(d, "sess");
    const list = await listCheckpoints(
      { id: "sess", working_directory: "/repo" },
      d
    );
    expect(list).toEqual([]);
    expect(listSnapshots).not.toHaveBeenCalled();
  });
});

describe("prepareForkFromSnapshot", () => {
  it("branches an isolated worktree at the turn's snapshot commit", async () => {
    const d = db();
    seedSession(d, "sess");
    listSnapshots.mockResolvedValue([S(2, "shaA"), S(3, "shaTARGET")]);
    getMainRepoPath.mockResolvedValue("/main-repo");
    createWorktree.mockResolvedValue({
      worktreePath: "/wt/fork",
      branchName: "feature/fork-me",
      baseBranch: "main",
      projectPath: "/main-repo",
      projectName: "repo",
    });

    const prep = await prepareForkFromSnapshot(
      { id: "sess", working_directory: "/repo" },
      3,
      { featureName: "fork me abcd1234" },
      d
    );

    expect(prep).toMatchObject({
      worktreePath: "/wt/fork",
      branchName: "feature/fork-me",
      snapshotSeq: 3,
      snapshotSha: "shaTARGET",
      sourceCheckpointId: null, // that turn was never labeled a checkpoint
    });
    // Worktree branched from the turn's SNAPSHOT SHA (baseRef), in the owning repo.
    expect(createWorktree).toHaveBeenCalledWith({
      projectPath: "/main-repo",
      featureName: "fork me abcd1234",
      baseRef: "shaTARGET",
    });
  });

  it("links a checkpoint at that seq as the fork's lineage", async () => {
    const d = db();
    seedSession(d, "sess");
    captureSnapshot.mockResolvedValue(S(3, "shaTARGET"));
    const cp = (await createCheckpoint(
      { id: "sess", working_directory: "/repo" },
      { label: "labeled turn" },
      d
    )) as CheckpointRow;

    listSnapshots.mockResolvedValue([S(3, "shaTARGET")]);
    getMainRepoPath.mockResolvedValue(null);
    createWorktree.mockResolvedValue({
      worktreePath: "/wt/fork",
      branchName: "feature/x",
      baseBranch: "main",
      projectPath: "/repo",
      projectName: "repo",
    });

    const prep = await prepareForkFromSnapshot(
      { id: "sess", working_directory: "/repo" },
      3,
      { featureName: "x" },
      d
    );
    expect(prep?.sourceCheckpointId).toBe(cp.id);
  });

  it("returns null for an unknown/pruned seq and never creates a worktree", async () => {
    const d = db();
    seedSession(d, "sess");
    listSnapshots.mockResolvedValue([S(3, "shaTARGET")]);
    const prep = await prepareForkFromSnapshot(
      { id: "sess", working_directory: "/repo" },
      99, // no such live snapshot
      { featureName: "x" },
      d
    );
    expect(prep).toBeNull();
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("falls back to the session cwd when the main repo path can't be resolved", async () => {
    const d = db();
    seedSession(d, "sess");
    listSnapshots.mockResolvedValue([S(3, "shaTARGET")]);
    getMainRepoPath.mockResolvedValue(null);
    createWorktree.mockResolvedValue({
      worktreePath: "/wt/fork",
      branchName: "feature/x",
      baseBranch: "main",
      projectPath: "/repo",
      projectName: "repo",
    });
    await prepareForkFromSnapshot(
      { id: "sess", working_directory: "/repo" },
      3,
      { featureName: "x" },
      d
    );
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/repo", baseRef: "shaTARGET" })
    );
  });
});

describe("checkpoints cascade with the session", () => {
  it("deletes a session's checkpoints when the session is deleted (FK CASCADE)", async () => {
    const d = db();
    seedSession(d, "sess");
    captureSnapshot.mockResolvedValue(S(1, "s1"));
    await createCheckpoint(
      { id: "sess", working_directory: "/repo" },
      { label: "x" },
      d
    );
    expect(
      (d.prepare("SELECT COUNT(*) n FROM checkpoints").get() as { n: number }).n
    ).toBe(1);
    d.prepare("DELETE FROM sessions WHERE id = ?").run("sess");
    expect(
      (d.prepare("SELECT COUNT(*) n FROM checkpoints").get() as { n: number }).n
    ).toBe(0);
  });
});
