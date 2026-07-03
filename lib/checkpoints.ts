/**
 * Checkpoints (#44) — a DURABLE, labeled layer over the git shadow-commit
 * snapshots (lib/snapshots.ts). A snapshot is the store of worktree BYTES,
 * pruned FIFO to the last 20; a checkpoint is a row that PINS one snapshot
 * (by seq + sha) and adds what a git ref can't hold: a human label, a kind
 * (manual / auto / safety / fork-origin), the transcript anchor at capture,
 * and fork lineage (parent_checkpoint_id).
 *
 * The row OUTLIVES the ref: once a snapshot is FIFO-pruned its checkpoint is
 * shown `expired` (a historical record, no longer a rewind/fork target) rather
 * than vanishing. Time-travel (rewind) itself reuses the existing snapshot
 * restore path keyed by `seq`; this module owns create / list / fork-from.
 *
 * Orchestration only — all git I/O goes through lib/snapshots + lib/worktrees
 * (the execFile seam), all DB through the prepared-statement cache.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries } from "./db";
import type { Session } from "./db";
import { captureSnapshot, listSnapshots } from "./snapshots";
import { createWorktree, getMainRepoPath } from "./worktrees";

/** A checkpoint's origin — drives the timeline badge. */
export type CheckpointKind = "manual" | "auto" | "safety" | "fork-origin";

/** A stored checkpoint row (mirrors the `checkpoints` table). */
export interface CheckpointRow {
  id: string;
  session_id: string;
  seq: number;
  snapshot_sha: string;
  summary: string | null;
  transcript_session_id: string | null;
  kind: string;
  created_by: string;
  parent_checkpoint_id: string | null;
  created_at: string;
}

/** A checkpoint enriched with whether its snapshot is still live (not pruned). */
export interface CheckpointView extends CheckpointRow {
  /** The pinned snapshot ref is gone (FIFO-pruned) — a record, not a target. */
  expired: boolean;
}

/** The minimal session shape create/list need — narrow so callers can pass a
 *  partial in tests without constructing a whole Session. */
type CheckpointSession = Pick<Session, "id" | "working_directory"> & {
  claude_session_id?: string | null;
};

export interface CreateCheckpointOptions {
  label?: string;
  kind?: CheckpointKind;
  createdBy?: string;
  parentCheckpointId?: string | null;
}

/**
 * Pin the current working tree as a durable checkpoint. Captures a snapshot
 * first; if nothing changed since the last snapshot (capture is a no-op) the
 * checkpoint pins that EXISTING latest snapshot instead — so "checkpoint here"
 * always succeeds when there's a tree to pin. Returns null only when there is
 * no snapshot to pin at all (the cwd isn't a git repo / has no snapshots).
 */
export async function createCheckpoint(
  session: CheckpointSession,
  opts: CreateCheckpointOptions = {},
  db: Database.Database = getDb()
): Promise<CheckpointRow | null> {
  const label = (opts.label || "").trim();
  const summary = label || "checkpoint";

  const snap = await captureSnapshot(
    session.working_directory,
    session.id,
    summary
  );
  let seq: number;
  let sha: string;
  if (snap) {
    seq = snap.seq;
    sha = snap.sha;
  } else {
    // Capture was a no-op (unchanged tree) OR not a repo. Disambiguate: if a
    // snapshot already exists, pin the latest; otherwise there's nothing to pin.
    const existing = await listSnapshots(session.working_directory, session.id);
    const last = existing[existing.length - 1];
    if (!last) return null;
    seq = last.seq;
    sha = last.sha;
  }

  const id = randomUUID();
  queries
    .createCheckpoint(db)
    .run(
      id,
      session.id,
      seq,
      sha,
      label || null,
      session.claude_session_id ?? null,
      opts.kind ?? "manual",
      opts.createdBy ?? "manual",
      opts.parentCheckpointId ?? null
    );
  return queries.getCheckpoint(db).get(id) as CheckpointRow;
}

/**
 * A session's checkpoints, newest-first, each flagged `expired` when its pinned
 * snapshot ref has been FIFO-pruned (so it's a record, not a live target). One
 * git call (listSnapshots) reconciles the whole set.
 */
export async function listCheckpoints(
  session: CheckpointSession,
  db: Database.Database = getDb()
): Promise<CheckpointView[]> {
  const rows = queries.listCheckpoints(db).all(session.id) as CheckpointRow[];
  if (rows.length === 0) return [];
  const live = await listSnapshots(session.working_directory, session.id);
  const liveShas = new Set(live.map((s) => s.sha));
  return rows.map((r) => ({ ...r, expired: !liveShas.has(r.snapshot_sha) }));
}

export interface SnapshotForkPrep {
  worktreePath: string;
  branchName: string;
  /** The repo that owns the worktree — needed to clean it up on a later failure. */
  projectPath: string;
  snapshotSeq: number;
  snapshotSha: string;
  /** The checkpoint pinning this seq, if any — threaded as the child's lineage. */
  sourceCheckpointId: string | null;
}

/**
 * Compose the worktree feature name for a fork so the UNIQUE id always survives
 * `slugify`'s 50-char cap (lib/git.ts) — the id is what keeps two forks of the
 * same (possibly long-named) session from colliding on branch/path, and a
 * name-only slug would truncate an appended id away. We bound the human-readable
 * name so there is always ample room for the id token before the slug is capped.
 * Pure → unit-tested against the real slugify.
 */
export function buildForkFeatureName(name: string, uniqueId: string): string {
  return `${name.slice(0, 32)} ${uniqueId.slice(0, 8)}`;
}

/**
 * Materialize a past working-tree state as a fresh, isolated git worktree
 * branched at the snapshot commit for turn `seq` — the code half of "fork from
 * any point". Keyed on the snapshot seq (any turn is forkable, whether or not
 * it's a labeled checkpoint); a checkpoint pinning that seq is linked as the
 * fork's lineage. Returns null if the seq is unknown or its snapshot has been
 * pruned (no live commit to branch from). Throws if the worktree can't be
 * created (branch/path collision, not a repo) — the caller surfaces it. The
 * CONVERSATION fork (transcript seam) and the new session row are the route's
 * job; this owns only the git worktree.
 */
export async function prepareForkFromSnapshot(
  session: CheckpointSession,
  seq: number,
  opts: { featureName: string },
  db: Database.Database = getDb()
): Promise<SnapshotForkPrep | null> {
  const live = await listSnapshots(session.working_directory, session.id);
  const target = live.find((s) => s.seq === seq);
  if (!target) return null; // unknown seq or pruned snapshot

  // The snapshot commit + object live in the repo that OWNS the (possibly linked)
  // worktree — branch the new worktree there so the sha resolves.
  const projectPath =
    (await getMainRepoPath(session.working_directory)) ??
    session.working_directory;

  const info = await createWorktree({
    projectPath,
    featureName: opts.featureName,
    baseRef: target.sha,
  });

  const source = queries.getCheckpointBySeq(db).get(session.id, seq) as
    CheckpointRow | undefined;

  return {
    worktreePath: info.worktreePath,
    branchName: info.branchName,
    projectPath,
    snapshotSeq: seq,
    snapshotSha: target.sha,
    sourceCheckpointId: source?.id ?? null,
  };
}
