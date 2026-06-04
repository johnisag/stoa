import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import { getSessionBackend } from "@/lib/session-backend";
import { isRespondAction, applyResponse } from "@/lib/notification-actions";

// POST /api/sessions/[id]/respond — act on a session straight from a push
// notification's action button (approve → Enter, reject → Escape, stop → kill).
// Same auth gate as every route (server.ts); the SW's fetch carries the cookie.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { action } = await request.json().catch(() => ({}));

    if (!isRespondAction(action)) {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    const session = queries.getSession(getDb()).get(id) as Session | undefined;
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Authoritative backend key (honors a renamed session's tmux_name), same as
    // the DELETE/summarize routes — sessionKey() alone would 409 after a rename.
    const name = backendKeyForSession(session);
    const backend = getSessionBackend();

    if (!(await backend.exists(name))) {
      return NextResponse.json(
        { error: "Session not running" },
        { status: 409 }
      );
    }

    await applyResponse(backend, name, action);

    return NextResponse.json({ ok: true, action });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("respond route failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
