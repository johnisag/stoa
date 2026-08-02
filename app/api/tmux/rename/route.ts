import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import { getManagedSessionPattern } from "@/lib/providers/registry";
import { parseJsonBody, requireLocalhost } from "@/lib/api-security";
import { backendKeyOwners } from "@/lib/session-route-access";
import { isInteractiveSessionRole } from "@/lib/session-role";
import { isSessionDeletionBoundaryFenced } from "@/lib/session-deletion";

class SessionRenameDeletionRaceError extends Error {
  constructor() {
    super("Session deletion is in progress");
    this.name = "SessionRenameDeletionRaceError";
  }
}

async function killRenameCandidates(
  backend: ReturnType<typeof getSessionBackend>,
  oldName: string,
  newName: string
): Promise<void> {
  await Promise.allSettled([backend.kill(newName), backend.kill(oldName)]);
}

/** Restore a failed rename only while both process identities remain unfenced.
 * A deletion claim can publish during the rollback await, so check once before
 * and once after it; either fence turns rollback into two-key cleanup. */
async function rollbackRenameOrStop(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  backend: ReturnType<typeof getSessionBackend>,
  oldName: string,
  newName: string
): Promise<boolean> {
  const fenced = () =>
    isSessionDeletionBoundaryFenced(db, sessionId, [oldName, newName]);
  if (fenced()) {
    await killRenameCandidates(backend, oldName, newName);
    return true;
  }

  let rolledBack = false;
  try {
    await backend.rename(newName, oldName);
    rolledBack = true;
  } catch {
    // A failed rollback can leave the target as an unowned live key. Defer its
    // cleanup until after the mandatory post-rollback fence check below.
  }

  if (fenced()) {
    await killRenameCandidates(backend, oldName, newName);
    return true;
  }
  if (!rolledBack) await backend.kill(newName).catch(() => undefined);
  return false;
}

// POST /api/tmux/rename - Rename a tmux session
export async function POST(request: NextRequest) {
  const auth = requireLocalhost(request);
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody<{ oldName?: string; newName?: string }>(
    request
  );
  if (!parsed.ok) return parsed.response;

  const { oldName, newName } = parsed.data;

  if (!oldName || !newName) {
    return NextResponse.json(
      { error: "oldName and newName are required" },
      { status: 400 }
    );
  }

  const managedPattern = getManagedSessionPattern();
  if (!managedPattern.test(oldName) || !managedPattern.test(newName)) {
    return NextResponse.json(
      { error: "Only Stoa-managed session names can be renamed" },
      { status: 400 }
    );
  }

  const db = getDb();
  const sessions = queries.getAllSessions(db).all() as Session[];
  const owners = backendKeyOwners(sessions, oldName);
  if (owners.length !== 1) {
    return NextResponse.json(
      { error: "The source session name is not uniquely owned" },
      { status: owners.length === 0 ? 404 : 409 }
    );
  }
  const owner = owners[0];
  if (!isInteractiveSessionRole(owner)) {
    return NextResponse.json(
      { error: "Internal sessions are managed only by their owning subsystem" },
      { status: 409 }
    );
  }
  const deletionFenced = () =>
    isSessionDeletionBoundaryFenced(db, owner.id, [oldName, newName]);
  if (deletionFenced()) {
    return NextResponse.json(
      { error: "Session deletion is in progress" },
      { status: 409 }
    );
  }
  if (oldName === newName) {
    return NextResponse.json({ success: true, newName });
  }
  if (backendKeyOwners(sessions, newName, owner.id).length > 0) {
    return NextResponse.json(
      { error: "The requested session name is already reserved" },
      { status: 409 }
    );
  }

  try {
    const backend = getSessionBackend();
    if (await backend.exists(newName)) {
      return NextResponse.json(
        { error: "The requested session name is already reserved" },
        { status: 409 }
      );
    }
    if (deletionFenced()) {
      return NextResponse.json(
        { error: "Session deletion is in progress" },
        { status: 409 }
      );
    }
    await backend.rename(oldName, newName);

    try {
      db.transaction(() => {
        if (deletionFenced()) throw new SessionRenameDeletionRaceError();
        const current = queries.getAllSessions(db).all() as Session[];
        const currentOwners = backendKeyOwners(current, oldName);
        if (
          currentOwners.length !== 1 ||
          currentOwners[0].id !== owner.id ||
          !isInteractiveSessionRole(currentOwners[0]) ||
          backendKeyOwners(current, newName, owner.id).length > 0
        ) {
          throw new Error("Session ownership changed during rename");
        }
        const updated = db
          .prepare(
            `UPDATE sessions
             SET tmux_name = ?, updated_at = datetime('now')
             WHERE id = ? AND COALESCE(session_role, 'interactive') = 'interactive'`
          )
          .run(newName, owner.id);
        if (updated.changes !== 1) {
          throw new Error("Session rename was not persisted");
        }
        if (deletionFenced()) throw new SessionRenameDeletionRaceError();
      })();
    } catch (error) {
      const fenced = await rollbackRenameOrStop(
        db,
        owner.id,
        backend,
        oldName,
        newName
      );
      if (fenced) throw new SessionRenameDeletionRaceError();
      throw error;
    }

    return NextResponse.json({ success: true, newName });
  } catch (error) {
    console.error("Error renaming tmux session:", error);
    if (error instanceof SessionRenameDeletionRaceError) {
      return NextResponse.json(
        { error: "Session deletion is in progress" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to rename tmux session" },
      { status: 500 }
    );
  }
}
