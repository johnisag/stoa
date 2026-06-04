import { join } from "path";
import { promises as fs } from "fs";
import { runGit, isGitRepo } from "./git";
import { expandHome, tmpDir } from "./platform";

/**
 * Per-turn working-tree snapshots, stored as git "shadow commits" under
 * refs/stoa/snap/<sessionId>/<seq> — invisible to normal git (not under
 * refs/heads), object-deduped, and pruned to the last MAX_SNAPSHOTS. Each
 * snapshot's tree is the FULL working tree at that moment (tracked + untracked,
 * via a throwaway index so the user's real index is never touched). Read-only
 * here — restore/rewind lands in a later stage. All git over the execFile seam.
 */

const REF_PREFIX = "refs/stoa/snap";
const MAX_SNAPSHOTS = 20;
const SEQ_PAD = 6;
const T = 15000;
const BIG = 32 * 1024 * 1024;

// Identity for commit-tree — a repo may have no user.name/email configured, and
// commit-tree fails without one. These never reach a real branch.
const IDENTITY = {
  GIT_AUTHOR_NAME: "Stoa",
  GIT_AUTHOR_EMAIL: "stoa@localhost",
  GIT_COMMITTER_NAME: "Stoa",
  GIT_COMMITTER_EMAIL: "stoa@localhost",
};

let indexCounter = 0;
// One capture per session at a time — two concurrent captures would compute the
// same seq and silently overwrite each other's ref.
const inFlight = new Set<string>();

export interface Snapshot {
  seq: number;
  sha: string;
  /** ISO-8601 commit date. */
  date: string;
  /** One-line label (the rendered last line at capture, or "checkpoint"). */
  summary: string;
}

function refFor(sessionId: string, seq: number): string {
  return `${REF_PREFIX}/${sessionId}/${String(seq).padStart(SEQ_PAD, "0")}`;
}

function refGlob(sessionId: string): string {
  return `${REF_PREFIX}/${sessionId}`;
}

/**
 * List a session's snapshots, oldest → newest. Empty if none / not a repo.
 */
export async function listSnapshots(
  cwd: string,
  sessionId: string
): Promise<Snapshot[]> {
  const dir = expandHome(cwd);
  try {
    const { stdout } = await runGit(
      dir,
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:lstrip=4)\t%(objectname)\t%(committerdate:iso-strict)\t%(contents:subject)",
        refGlob(sessionId),
      ],
      T,
      BIG
    );
    const out: Snapshot[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [seqStr, sha, date, ...rest] = line.split("\t");
      const seq = parseInt(seqStr, 10);
      if (Number.isNaN(seq) || !sha) continue;
      out.push({ seq, sha, date: date ?? "", summary: rest.join("\t") });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Capture the current working tree as a snapshot commit. Returns the new
 * Snapshot, or null if the cwd isn't a repo or nothing changed since the last
 * snapshot (so identical back-to-back turns don't pile up).
 */
export async function captureSnapshot(
  cwd: string,
  sessionId: string,
  summary: string
): Promise<Snapshot | null> {
  const dir = expandHome(cwd);
  if (inFlight.has(sessionId)) return null;
  inFlight.add(sessionId);
  try {
    if (!(await isGitRepo(dir))) return null;

    const indexFile = join(
      tmpDir(),
      `stoa-snap-${process.pid}-${++indexCounter}.idx`
    );
    const indexEnv = { GIT_INDEX_FILE: indexFile };
    try {
      // Initialize the throwaway index first — `git add -A` against a
      // non-existent GIT_INDEX_FILE can no-op on some git builds (Windows),
      // silently snapshotting nothing. read-tree --empty guarantees it exists.
      await runGit(dir, ["read-tree", "--empty"], T, BIG, indexEnv);
      // Stage the whole worktree into the throwaway index, then snapshot its tree.
      await runGit(dir, ["add", "-A"], T, BIG, indexEnv);
      const tree = (
        await runGit(dir, ["write-tree"], T, BIG, indexEnv)
      ).stdout.trim();
      if (!tree) return null;

      const existing = await listSnapshots(dir, sessionId);
      // Skip a no-op turn: identical tree to the most recent snapshot.
      const last = existing[existing.length - 1];
      if (last) {
        try {
          const lastTree = (
            await runGit(dir, ["rev-parse", `${last.sha}^{tree}`], T)
          ).stdout.trim();
          if (lastTree === tree) return null;
        } catch {
          // Can't resolve the last tree — fall through and snapshot anyway.
        }
      }

      // Parent on HEAD when it exists (unborn repos have none).
      let parentArgs: string[] = [];
      try {
        const head = (
          await runGit(dir, ["rev-parse", "HEAD"], T)
        ).stdout.trim();
        if (head) parentArgs = ["-p", head];
      } catch {
        // Unborn HEAD — no parent.
      }

      const subject = (summary || "checkpoint")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      const sha = (
        await runGit(
          dir,
          ["commit-tree", tree, ...parentArgs, "-m", subject || "checkpoint"],
          T,
          BIG,
          IDENTITY
        )
      ).stdout.trim();
      if (!sha) return null;

      const seq = (last?.seq ?? 0) + 1;
      await runGit(dir, ["update-ref", refFor(sessionId, seq), sha], T);

      // Prune oldest beyond the cap.
      const all = [...existing, { seq, sha, date: "", summary: subject }];
      const overflow = all.length - MAX_SNAPSHOTS;
      for (let i = 0; i < overflow; i++) {
        await runGit(
          dir,
          ["update-ref", "-d", refFor(sessionId, all[i].seq)],
          T
        ).catch(() => {});
      }

      return { seq, sha, date: new Date().toISOString(), summary: subject };
    } finally {
      await fs.unlink(indexFile).catch(() => {});
    }
  } finally {
    inFlight.delete(sessionId);
  }
}

/**
 * The diff a snapshot introduced — its delta vs the previous snapshot (or vs its
 * own parent / the empty tree for the first one). Empty string if not found.
 */
export async function getSnapshotDiff(
  cwd: string,
  sessionId: string,
  seq: number
): Promise<string> {
  const dir = expandHome(cwd);
  const snaps = await listSnapshots(dir, sessionId);
  const idx = snaps.findIndex((s) => s.seq === seq);
  if (idx === -1) return "";
  const sha = snaps[idx].sha;

  try {
    // Prefer the previous snapshot as the "from", else this commit's parent.
    const prev = snaps[idx - 1]?.sha;
    if (prev) {
      return (await runGit(dir, ["diff", prev, sha], T, BIG)).stdout;
    }
    let parent: string | null = null;
    try {
      parent = (await runGit(dir, ["rev-parse", `${sha}^`], T)).stdout.trim();
    } catch {
      // Root commit (unborn HEAD at capture) — no parent.
    }
    if (parent) {
      return (await runGit(dir, ["diff", parent, sha], T, BIG)).stdout;
    }
    // First snapshot of a parentless commit: show its whole tree as additions.
    // diff-tree --root is object-format-agnostic (no hardcoded empty-tree hash).
    return (await runGit(dir, ["diff-tree", "-p", "--root", sha], T, BIG))
      .stdout;
  } catch {
    return "";
  }
}
