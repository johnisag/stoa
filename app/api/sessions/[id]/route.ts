import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getProject } from "@/lib/projects";
import {
  deleteWorktree,
  isStoaWorktree,
  getMainRepoPath,
} from "@/lib/worktrees";
import { releasePort } from "@/lib/ports";
import { killWorker } from "@/lib/orchestration";
import { generateBranchName, getCurrentBranch, renameBranch } from "@/lib/git";
import { runInBackground } from "@/lib/async-operations";
import { getSessionBackend } from "@/lib/session-backend";

// Sanitize a name for use as tmux session name
function sanitizeTmuxName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-") // Replace non-alphanumeric with dashes
    .replace(/-+/g, "-") // Collapse multiple dashes
    .replace(/^-|-$/g, "") // Remove leading/trailing dashes
    .slice(0, 50); // Limit length
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/sessions/[id] - Get single session
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json({ session });
  } catch (error) {
    console.error("Error fetching session:", error);
    return NextResponse.json(
      { error: "Failed to fetch session" },
      { status: 500 }
    );
  }
}

// PATCH /api/sessions/[id] - Update session
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const db = getDb();

    const existing = queries.getSession(db).get(id) as Session | undefined;
    if (!existing) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Build update query dynamically based on provided fields
    const updates: string[] = [];
    const values: unknown[] = [];

    // Handle name change - also rename tmux session and git branch (for worktrees)
    if (body.name !== undefined && body.name !== existing.name) {
      const newTmuxName = sanitizeTmuxName(body.name);
      const oldTmuxName = existing.tmux_name;

      // Try to rename the tmux session
      if (oldTmuxName && newTmuxName) {
        try {
          const backend = getSessionBackend();
          await backend.rename(oldTmuxName, newTmuxName);
          updates.push("tmux_name = ?");
          values.push(newTmuxName);
        } catch {
          // tmux session might not exist or rename failed - that's ok, just update the name
          // Still update tmux_name in DB so future attachments use the new name
          updates.push("tmux_name = ?");
          values.push(newTmuxName);
        }
      }

      // If this is a worktree session, also rename the git branch
      if (existing.worktree_path && isStoaWorktree(existing.worktree_path)) {
        try {
          const currentBranch = await getCurrentBranch(existing.worktree_path);
          const newBranchName = generateBranchName(body.name);

          if (currentBranch !== newBranchName) {
            const result = await renameBranch(
              existing.worktree_path,
              currentBranch,
              newBranchName
            );
            console.log(
              `Renamed branch ${currentBranch} → ${newBranchName}`,
              result.remoteRenamed ? "(also on remote)" : "(local only)"
            );
          }
        } catch (error) {
          console.error("Failed to rename git branch:", error);
          // Continue with session rename even if branch rename fails
        }
      }

      updates.push("name = ?");
      values.push(body.name);
    }
    if (body.status !== undefined) {
      updates.push("status = ?");
      values.push(body.status);
    }
    if (body.workingDirectory !== undefined) {
      updates.push("working_directory = ?");
      values.push(body.workingDirectory);
    }
    if (body.systemPrompt !== undefined) {
      updates.push("system_prompt = ?");
      values.push(body.systemPrompt);
    }
    if (body.groupPath !== undefined) {
      updates.push("group_path = ?");
      values.push(body.groupPath);
    }
    if (body.projectId !== undefined) {
      // Move the session to another project (the sidebar groups flat by
      // project_id, so this alone relocates it). Validate the target exists —
      // the FK isn't enforced (foreign_keys pragma is off), and a non-existent
      // id (e.g. a stale client moving to a since-deleted project) would orphan
      // the session into an un-rendered bucket. "uncategorized" is a real row.
      if (!body.projectId || !getProject(body.projectId)) {
        return NextResponse.json(
          { error: "Project not found" },
          { status: 400 }
        );
      }
      updates.push("project_id = ?");
      values.push(body.projectId);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(id);

      db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(
        ...values
      );
    }

    const session = queries.getSession(db).get(id) as Session;
    return NextResponse.json({ session });
  } catch (error) {
    console.error("Error updating session:", error);
    return NextResponse.json(
      { error: "Failed to update session" },
      { status: 500 }
    );
  }
}

// DELETE /api/sessions/[id] - Delete session
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();

    const existing = queries.getSession(db).get(id) as Session | undefined;
    if (!existing) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // If this is a conductor, delete all its workers first
    const workers = queries.getWorkersByConductor(db).all(id) as Session[];
    for (const worker of workers) {
      try {
        await killWorker(worker.id, false); // false = don't cleanup worktree yet
      } catch (error) {
        console.error(`Failed to kill worker ${worker.id}:`, error);
      }
      queries.deleteSession(db).run(worker.id);
    }

    // Release port if this session had one assigned
    if (existing.dev_server_port) {
      releasePort(id);
    }

    // Delete from database immediately for instant UI feedback
    queries.deleteSession(db).run(id);

    // Clean up worktree in background (non-blocking)
    if (existing.worktree_path && isStoaWorktree(existing.worktree_path)) {
      const worktreePath = existing.worktree_path; // Capture for closure
      runInBackground(async () => {
        const mainRepoPath = await getMainRepoPath(worktreePath);
        if (mainRepoPath) {
          await deleteWorktree(worktreePath, mainRepoPath, false);
        }
      }, `cleanup-worktree-${id}`);
    }

    // Also cleanup worker worktrees in background
    if (workers.length > 0) {
      for (const worker of workers) {
        if (worker.worktree_path && isStoaWorktree(worker.worktree_path)) {
          const worktreePath = worker.worktree_path; // Capture for closure
          const workerId = worker.id; // Capture ID for task name
          runInBackground(async () => {
            const mainRepoPath = await getMainRepoPath(worktreePath);
            if (mainRepoPath) {
              await deleteWorktree(worktreePath, mainRepoPath, false);
            }
          }, `cleanup-worker-worktree-${workerId}`);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting session:", error);
    return NextResponse.json(
      { error: "Failed to delete session" },
      { status: 500 }
    );
  }
}
