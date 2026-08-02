import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import { getManagedSessionPattern } from "@/lib/providers/registry";
import { parseJsonBody, requireLocalhost } from "@/lib/api-security";
import { backendKeyOwners } from "@/lib/session-route-access";
import { isInteractiveSessionRole } from "@/lib/session-role";

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
    await backend.rename(oldName, newName);

    try {
      db.transaction(() => {
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
      })();
    } catch (error) {
      // Keep the durable key and live process aligned. If rollback itself fails,
      // the request still fails and recovery can see the unchanged DB owner.
      await backend.rename(newName, oldName).catch(() => undefined);
      throw error;
    }

    return NextResponse.json({ success: true, newName });
  } catch (error) {
    console.error("Error renaming tmux session:", error);
    return NextResponse.json(
      { error: "Failed to rename tmux session" },
      { status: 500 }
    );
  }
}
