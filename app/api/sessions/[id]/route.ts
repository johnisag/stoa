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
import { deleteChannelMessagesForSession } from "@/lib/channels";
import { deleteCommentsForSession } from "@/lib/session-comments";
import { deleteSchedulesForSession } from "@/lib/scheduler";
import { expandHome } from "@/lib/platform";
import {
  parseJsonBody,
  resolveRealSandboxedPath,
  sanitizeSessionName,
  sanitizeGroupPath,
  SYSTEM_PROMPT_MAX_LENGTH,
} from "@/lib/api-security";
import {
  assertGenericSessionRouteAccess,
  backendKeyOwners,
  genericSessionRouteFailure,
} from "@/lib/session-route-access";
import {
  claimConductorSessionDeletion,
  commitConductorSessionDeletion,
  ConductorSessionDeletionRejectedError,
  isSessionDeletionBoundaryFenced,
} from "@/lib/session-deletion";

class SessionDeletionBackendStopError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionDeletionBackendStopError";
  }
}

class SessionRenameDeletionRaceError extends Error {
  constructor() {
    super("Session deletion is in progress");
    this.name = "SessionRenameDeletionRaceError";
  }
}

async function killRenameCandidates(
  backend: ReturnType<typeof getSessionBackend>,
  oldKey: string,
  newKey: string
): Promise<void> {
  await Promise.allSettled([backend.kill(newKey), backend.kill(oldKey)]);
}

async function rollbackRenameOrStop(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  backend: ReturnType<typeof getSessionBackend>,
  oldKey: string,
  newKey: string
): Promise<boolean> {
  const fenced = () =>
    isSessionDeletionBoundaryFenced(db, sessionId, [oldKey, newKey]);
  if (fenced()) {
    await killRenameCandidates(backend, oldKey, newKey);
    return true;
  }

  let rolledBack = false;
  try {
    await backend.rename(newKey, oldKey);
    rolledBack = true;
  } catch {
    // Check the durable fence again before deciding whether only the orphaned
    // target is safe to stop.
  }

  if (fenced()) {
    await killRenameCandidates(backend, oldKey, newKey);
    return true;
  }
  if (!rolledBack) await backend.kill(newKey).catch(() => undefined);
  return false;
}

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
  "dead",
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

    const denied = genericSessionRouteFailure(session);
    if (denied) {
      return NextResponse.json(
        { error: denied.error },
        { status: denied.status }
      );
    }
    assertGenericSessionRouteAccess(session);

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
    const denied = genericSessionRouteFailure(existing);
    if (denied) {
      return NextResponse.json(
        { error: denied.error },
        { status: denied.status }
      );
    }
    assertGenericSessionRouteAccess(existing);
    if (
      isSessionDeletionBoundaryFenced(db, id, [backendKeyForSession(existing)])
    ) {
      return NextResponse.json(
        { error: "Session deletion is in progress" },
        { status: 409 }
      );
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
    let completedBackendRename: {
      oldKey: string;
      newKey: string;
      backend: ReturnType<typeof getSessionBackend>;
    } | null = null;

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
      const oldTmuxName = backendKeyForSession(existing);
      const renameDeletionFenced = () =>
        isSessionDeletionBoundaryFenced(db, id, [oldTmuxName, newTmuxName]);

      // Rename only a live backend and persist the new key only after that
      // rename succeeds. A requested key owned by any other row (especially an
      // internal session) or orphan live process is globally reserved.
      if (newTmuxName && newTmuxName !== oldTmuxName) {
        if (renameDeletionFenced()) {
          return NextResponse.json(
            { error: "Session deletion is in progress" },
            { status: 409 }
          );
        }
        const allSessions = queries.getAllSessions(db).all() as Session[];
        if (
          backendKeyOwners(allSessions, newTmuxName, existing.id).length > 0
        ) {
          return NextResponse.json(
            { error: "The requested session name is already reserved" },
            { status: 409 }
          );
        }
        try {
          const backend = getSessionBackend();
          if (await backend.exists(oldTmuxName)) {
            if (await backend.exists(newTmuxName)) {
              return NextResponse.json(
                { error: "The requested session name is already reserved" },
                { status: 409 }
              );
            }
            if (renameDeletionFenced()) {
              return NextResponse.json(
                { error: "Session deletion is in progress" },
                { status: 409 }
              );
            }
            await backend.rename(oldTmuxName, newTmuxName);
            updates.push("tmux_name = ?");
            values.push(newTmuxName);
            completedBackendRename = {
              oldKey: oldTmuxName,
              newKey: newTmuxName,
              backend,
            };
            if (renameDeletionFenced()) {
              await killRenameCandidates(backend, oldTmuxName, newTmuxName);
              return NextResponse.json(
                { error: "Session deletion is in progress" },
                { status: 409 }
              );
            }
          }
        } catch (error) {
          console.error("Failed to rename session backend:", error);
          // The display name may still change, but the durable backend key must
          // remain untouched after a failed or unverifiable process rename.
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
      const { allowed, resolved } = await resolveRealSandboxedPath(
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
        ? await resolveRealSandboxedPath(existing.working_directory, roots)
        : { allowed: true };
      const wtCheck = existing.worktree_path
        ? await resolveRealSandboxedPath(existing.worktree_path, roots)
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

      try {
        const persistUpdates = () => {
          if (completedBackendRename) {
            if (
              isSessionDeletionBoundaryFenced(db, id, [
                completedBackendRename.oldKey,
                completedBackendRename.newKey,
              ])
            ) {
              throw new SessionRenameDeletionRaceError();
            }
            const current = queries.getAllSessions(db).all() as Session[];
            if (
              backendKeyOwners(
                current,
                completedBackendRename.newKey,
                existing.id
              ).length > 0
            ) {
              throw new Error("Session key was reserved during rename");
            }
          }
          db.prepare(
            `UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`
          ).run(...values);
          if (
            completedBackendRename &&
            isSessionDeletionBoundaryFenced(db, id, [
              completedBackendRename.oldKey,
              completedBackendRename.newKey,
            ])
          ) {
            throw new SessionRenameDeletionRaceError();
          }
        };
        if (completedBackendRename) db.transaction(persistUpdates)();
        else persistUpdates();
      } catch (error) {
        if (completedBackendRename) {
          const { backend, oldKey, newKey } = completedBackendRename;
          const fenced = await rollbackRenameOrStop(
            db,
            id,
            backend,
            oldKey,
            newKey
          );
          if (fenced) throw new SessionRenameDeletionRaceError();
        }
        throw error;
      }
    }

    const session = queries.getSession(db).get(id) as Session;
    return NextResponse.json({ session });
  } catch (error) {
    console.error("Error updating session:", error);
    if (error instanceof SessionRenameDeletionRaceError) {
      return NextResponse.json(
        { error: "Session deletion is in progress" },
        { status: 409 }
      );
    }
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
    const denied = genericSessionRouteFailure(existing);
    if (denied) {
      return NextResponse.json(
        { error: denied.error },
        { status: denied.status }
      );
    }
    assertGenericSessionRouteAccess(existing);

    // Claim the complete relationship boundary before killing any process.
    // Unknown internal roles fail closed; only ordinary orchestration workers
    // may be deleted and the five known Fleet roles may be detached.
    const deletionPlan = claimConductorSessionDeletion(db, id);
    // Re-read after the claim: another Stoa process may have changed a mutable
    // interactive session between the access check and our IMMEDIATE claim.
    // The claim trigger freezes every backend/cleanup identity from here on.
    const claimedSession = queries.getSession(db).get(id) as
      Session | undefined;
    if (!claimedSession) {
      throw new ConductorSessionDeletionRejectedError(
        "Session disappeared while deletion was being claimed."
      );
    }
    for (const worker of deletionPlan.interactiveWorkers) {
      try {
        await killWorker(worker.id, false, "failed", {
          failOnBackendError: true,
        }); // false = don't cleanup worktree yet
      } catch (error) {
        throw new SessionDeletionBackendStopError(
          `Failed to stop worker ${worker.id}`,
          { cause: error }
        );
      }
    }

    // Kill this session's OWN agent process — not just its workers. Without it a
    // "deleted" agent lingers in the pty-host daemon (Tier-2/Windows default):
    // holding a CLI/auth seat, blocking idle-shutdown, resurrectable by key, and
    // leaving the client on a live ghost pane. SessionBackend.kill is idempotent
    // for a missing process; a rejection keeps the durable claim for a retry.
    const backendKey = backendKeyForSession(claimedSession);
    try {
      await getSessionBackend().kill(backendKey);
    } catch (error) {
      throw new SessionDeletionBackendStopError(
        `Failed to stop session backend ${backendKey}`,
        { cause: error }
      );
    }

    // Preserve Fleet evidence and delete the ordinary session graph as one DB
    // commit. A trigger/FK failure rolls the detachment and every row deletion
    // back together. The helper also revalidates the pre-kill snapshot.
    commitConductorSessionDeletion(db, deletionPlan);

    for (const worker of deletionPlan.interactiveWorkers) {
      clearQueue(worker.id);
      // channel_messages + schedules + session_comments have no session FK cascade.
      deleteChannelMessagesForSession(worker.id);
      deleteSchedulesForSession(worker.id);
      deleteCommentsForSession(worker.id);
    }
    clearQueue(id);
    deleteChannelMessagesForSession(id);
    deleteSchedulesForSession(id);
    deleteCommentsForSession(id);

    // Drop the conductor marker so a future session in this same dir can't
    // inherit this (now-dead) conductor's id from a stale .stoa-conductor file.
    if (claimedSession.working_directory) {
      removeConductorMarker(
        claimedSession.working_directory,
        claimedSession.id
      );
    }

    // Release port if this session had one assigned
    if (claimedSession.dev_server_port) {
      releasePort(id);
    }

    // Multi-repo workspace session: tear down EVERY worktree this session created
    // (one per picked sub-repo), unregistering each from its parent repo, then
    // remove the workspace dir. Background + best-effort, like the single case.
    if (claimedSession.worktree_paths) {
      let childPaths: string[] = [];
      try {
        const parsed = JSON.parse(claimedSession.worktree_paths);
        if (Array.isArray(parsed))
          childPaths = parsed.filter((p): p is string => typeof p === "string");
      } catch {
        /* malformed — nothing to tear down */
      }
      // Only reclaim worktrees Stoa created (under ~/.stoa/worktrees).
      const stoaChildren = childPaths.filter((p) => isStoaWorktree(p));
      const workspaceDir = claimedSession.working_directory;
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
    if (
      claimedSession.worktree_path &&
      isStoaWorktree(claimedSession.worktree_path)
    ) {
      const worktreePath = claimedSession.worktree_path; // Capture for closure
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
    if (deletionPlan.interactiveWorkers.length > 0) {
      for (const worker of deletionPlan.interactiveWorkers) {
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
    if (error instanceof ConductorSessionDeletionRejectedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof SessionDeletionBackendStopError) {
      console.error(error.message, error.cause);
      return NextResponse.json(
        {
          error:
            "Failed to stop the session backend. The deletion is safely claimed; retry to continue.",
        },
        { status: 503 }
      );
    }
    console.error("Error deleting session:", error);
    return NextResponse.json(
      { error: "Failed to delete session" },
      { status: 500 }
    );
  }
}
