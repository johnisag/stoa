import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getProject } from "@/lib/projects";
import {
  deleteWorktree,
  isStoaWorktree,
  getMainRepoPath,
} from "@/lib/worktrees";
import { removeWorkspace } from "@/lib/multi-repo-worktree";
import { releasePort } from "@/lib/ports";
import { killWorker } from "@/lib/orchestration";
import { generateBranchName, getCurrentBranch, renameBranch } from "@/lib/git";
import { runInBackground } from "@/lib/async-operations";
import { getSessionBackend } from "@/lib/session-backend";
import { backendKeyForSession } from "@/lib/providers/registry";
import { removeConductorMarker } from "@/lib/mcp-config";
import { clearQueue } from "@/lib/prompt-queue";
import { expandHome } from "@/lib/platform";
import {
  parseJsonBody,
  resolveSandboxedPath,
  sanitizeSessionName,
  sanitizeGroupPath,
  SYSTEM_PROMPT_MAX_LENGTH,
} from "@/lib/api-security";

// Sanitize a name for use as tmux session name
function sanitizeTmuxName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-") // Replace non-alphanumeric with dashes
    .replace(/-+/g, "-") // Collapse multiple dashes
    .replace(/^-|-$/g, "") // Remove leading/trailing dashes
    .slice(0, 50); // Limit length
}

const ALLOWED_SESSION_STATUS: Set<string> = new Set([
  "idle",
  "running",
  "waiting",
  "error",
]);

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
  const parsed = await parseJsonBody<{
    name?: string;
    status?: string;
    workingDirectory?: string;
    systemPrompt?: string;
    groupPath?: string;
    projectId?: string;
  }>(request);
  if (!parsed.ok) return parsed.response;

  try {
    const { id } = await params;
    const body = parsed.data;
    const db = getDb();

    const existing = queries.getSession(db).get(id) as Session | undefined;
    if (!existing) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Resolve the session's project root for path validation.
    const project = existing.project_id
      ? getProject(existing.project_id)
      : null;
    const projectRoot = project
      ? expandHome(project.working_directory)
      : expandHome("~");

    // Build update query dynamically based on provided fields
    const updates: string[] = [];
    const values: unknown[] = [];

    // Handle name change - also rename tmux session and git branch (for worktrees)
    if (body.name !== undefined && body.name !== existing.name) {
      const sanitized = sanitizeSessionName(body.name);
      if (!sanitized) {
        return NextResponse.json(
          { error: "Invalid session name" },
          { status: 400 }
        );
      }
      const newTmuxName = sanitizeTmuxName(sanitized);
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
      values.push(sanitized);
    }
    if (body.status !== undefined) {
      if (!ALLOWED_SESSION_STATUS.has(body.status)) {
        return NextResponse.json(
          { error: `Invalid status: ${body.status}` },
          { status: 400 }
        );
      }
      updates.push("status = ?");
      values.push(body.status);
    }
    if (body.workingDirectory !== undefined) {
      const { allowed, resolved } = resolveSandboxedPath(
        body.workingDirectory,
        [projectRoot]
      );
      if (!allowed) {
        return NextResponse.json(
          { error: "workingDirectory is outside the project workspace" },
          { status: 403 }
        );
      }
      updates.push("working_directory = ?");
      values.push(resolved);
    }
    if (body.systemPrompt !== undefined) {
      if (
        typeof body.systemPrompt === "string" &&
        body.systemPrompt.length > SYSTEM_PROMPT_MAX_LENGTH
      ) {
        return NextResponse.json(
          { error: "systemPrompt exceeds maximum length" },
          { status: 400 }
        );
      }
      updates.push("system_prompt = ?");
      values.push(body.systemPrompt);
    }
    if (body.groupPath !== undefined) {
      const sanitized = sanitizeGroupPath(body.groupPath);
      if (!sanitized) {
        return NextResponse.json(
          { error: "Invalid groupPath" },
          { status: 400 }
        );
      }
      updates.push("group_path = ?");
      values.push(sanitized);
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
      // Re-validate the session's existing paths against the target project's
      // root so a caller can't satisfy the guard for project A and then relocate
      // the session to project B, breaking the project-to-path invariant.
      const targetProject = getProject(body.projectId)!;
      const targetRoot = expandHome(targetProject.working_directory);
      const roots = [targetRoot];
      const wdCheck = existing.working_directory
        ? resolveSandboxedPath(existing.working_directory, roots)
        : { allowed: true };
      const wtCheck = existing.worktree_path
        ? resolveSandboxedPath(existing.worktree_path, roots)
        : { allowed: true };
      if (!wdCheck.allowed || !wtCheck.allowed) {
        return NextResponse.json(
          { error: "Session paths are outside the target project workspace" },
          { status: 403 }
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
      clearQueue(worker.id);
    }

    // Kill this session's OWN agent process — not just its workers. Without it a
    // "deleted" agent lingers in the pty-host daemon (Tier-2/Windows default):
    // holding a CLI/auth seat, blocking idle-shutdown, resurrectable by key, and
    // leaving the client on a live ghost pane. Best-effort + backend-agnostic; a
    // missing/already-dead session must not fail the delete.
    const backendKey = backendKeyForSession(existing);
    try {
      await getSessionBackend().kill(backendKey);
    } catch (error) {
      console.error(`Failed to kill session pty ${backendKey}:`, error);
    }

    // Drop the conductor marker so a future session in this same dir can't
    // inherit this (now-dead) conductor's id from a stale .stoa-conductor file.
    if (existing.working_directory) {
      removeConductorMarker(existing.working_directory, existing.id);
    }

    // Release port if this session had one assigned
    if (existing.dev_server_port) {
      releasePort(id);
    }

    // Delete from database immediately for instant UI feedback
    queries.deleteSession(db).run(id);
    clearQueue(id);

    // Multi-repo workspace session: tear down EVERY worktree this session created
    // (one per picked sub-repo), unregistering each from its parent repo, then
    // remove the workspace dir. Background + best-effort, like the single case.
    if (existing.worktree_paths) {
      let childPaths: string[] = [];
      try {
        const parsed = JSON.parse(existing.worktree_paths);
        if (Array.isArray(parsed))
          childPaths = parsed.filter((p): p is string => typeof p === "string");
      } catch {
        /* malformed — nothing to tear down */
      }
      // Only reclaim worktrees Stoa created (under ~/.stoa/worktrees).
      const stoaChildren = childPaths.filter((p) => isStoaWorktree(p));
      const workspaceDir = existing.working_directory;
      if (stoaChildren.length > 0) {
        runInBackground(
          () => removeWorkspace(workspaceDir, stoaChildren),
          `cleanup-workspace-${id}`
        );
      }
    }

    // Clean up worktree in background (non-blocking). Fall back to the worktree's
    // parent dir when the owning repo can't be resolved (a broken worktree) so a
    // dead worktree is still removed rather than silently skipped.
    if (existing.worktree_path && isStoaWorktree(existing.worktree_path)) {
      const worktreePath = existing.worktree_path; // Capture for closure
      runInBackground(async () => {
        const mainRepoPath = await getMainRepoPath(worktreePath);
        await deleteWorktree(
          worktreePath,
          mainRepoPath ?? path.dirname(worktreePath),
          false
        );
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
            await deleteWorktree(
              worktreePath,
              mainRepoPath ?? path.dirname(worktreePath),
              false
            );
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
