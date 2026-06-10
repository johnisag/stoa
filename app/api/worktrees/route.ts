import { NextRequest, NextResponse } from "next/server";
import { readdirSync, existsSync } from "fs";
import path from "path";
import { getDb, queries, type Session } from "@/lib/db";
import { getCurrentBranch, getGitStatus } from "@/lib/git";
import {
  isStoaWorktree,
  getMainRepoPath,
  deleteWorktree,
  getWorktreesDir,
  normalizeWorktreePath,
} from "@/lib/worktrees";

/** A Stoa-managed worktree, enriched for the reclaim panel. */
interface WorktreeRow {
  path: string;
  branch: string;
  projectId: string;
  projectName: string;
  attached: boolean;
  sessionId: string | null;
  sessionName: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

const baseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p;

/**
 * GET /api/worktrees — every Stoa-managed worktree (scanned straight from the
 * worktrees dir, so it finds them even when the owning repo isn't a registered
 * project), flagged with whether a live session owns it (else it's an orphan),
 * plus dirty / ahead-behind so reclaim is an informed decision.
 */
export async function GET() {
  try {
    const dir = getWorktreesDir();
    if (!existsSync(dir)) return NextResponse.json({ worktrees: [] });

    const db = getDb();
    const sessions = queries.getAllSessions(db).all() as Session[];
    const sessionByDir = new Map<string, Session>();
    for (const s of sessions) {
      sessionByDir.set(normalizeWorktreePath(s.working_directory), s);
    }

    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) =>
      e.isDirectory()
    );

    const rows: WorktreeRow[] = [];
    for (const entry of entries) {
      const wtPath = path.join(dir, entry.name);

      // Branch (falls back to the dir name for a broken/detached worktree so it
      // still shows up as reclaimable junk).
      let branch = "";
      try {
        branch = await getCurrentBranch(wtPath);
      } catch {
        branch = entry.name;
      }

      let dirty = false;
      let ahead = 0;
      let behind = 0;
      try {
        const st = await getGitStatus(wtPath);
        dirty = st.staged + st.unstaged + st.untracked > 0;
        ahead = st.ahead;
        behind = st.behind;
      } catch {
        // broken worktree — leave as clean/zero
      }

      const mainRepo = await getMainRepoPath(wtPath);
      const sess = sessionByDir.get(normalizeWorktreePath(wtPath)) ?? null;
      rows.push({
        path: wtPath,
        branch,
        projectId: mainRepo ?? "",
        projectName: mainRepo ? baseName(mainRepo) : entry.name,
        attached: !!sess,
        sessionId: sess?.id ?? null,
        sessionName: sess?.name ?? null,
        dirty,
        ahead,
        behind,
      });
    }

    // Orphans first, then by project, then branch.
    rows.sort(
      (a, b) =>
        Number(a.attached) - Number(b.attached) ||
        a.projectName.localeCompare(b.projectName) ||
        a.branch.localeCompare(b.branch)
    );

    return NextResponse.json({ worktrees: rows });
  } catch (error) {
    console.error("Error listing worktrees:", error);
    return NextResponse.json(
      { error: "Failed to list worktrees" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/worktrees — reclaim an ORPHANED Stoa worktree: remove it and
 * delete its branch. Refuses unless it's a Stoa worktree with no live session
 * (a guard mirroring the UI, so a stray API call can't nuke an active one).
 */
export async function DELETE(request: NextRequest) {
  try {
    const { path: worktreePath } = await request.json();
    if (!worktreePath || typeof worktreePath !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    if (!isStoaWorktree(worktreePath)) {
      return NextResponse.json(
        { error: "Refusing to remove a non-Stoa worktree" },
        { status: 400 }
      );
    }

    // Refuse if a live session still owns it.
    const db = getDb();
    const sessions = queries.getAllSessions(db).all() as Session[];
    const target = normalizeWorktreePath(worktreePath);
    if (
      sessions.some(
        (s) => normalizeWorktreePath(s.working_directory) === target
      )
    ) {
      return NextResponse.json(
        { error: "Worktree is in use by a session — delete the session first" },
        { status: 409 }
      );
    }

    const mainRepoPath = await getMainRepoPath(worktreePath);
    // No main repo (broken worktree) → deleteWorktree's manual-rm fallback still
    // cleans the directory. Only delete the branch when we actually resolved the
    // owning repo: otherwise git would run with cwd = the worktrees dir, and if
    // ~/.stoa happens to sit inside a git repo, `branch -D` would hit the WRONG
    // repo. Without a repo we can't identify the branch's owner, so skip it.
    await deleteWorktree(
      worktreePath,
      mainRepoPath ?? path.dirname(worktreePath),
      mainRepoPath !== null
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error reclaiming worktree:", error);
    // Surface the specific reason (e.g. "still locked after N attempts: …") so
    // the user knows a locked worktree may clear if they retry in a moment.
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to reclaim worktree",
      },
      { status: 500 }
    );
  }
}
