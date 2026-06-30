import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import { getSessionBackend } from "@/lib/session-backend";
import {
  isRespondAction,
  applyResponse,
  canApproveFromPrompt,
} from "@/lib/notification-actions";
import { detectPrompt, pushApproveEnabled } from "@/lib/auto-steer";

// Sessions with an Approve currently being processed — serializes concurrent approves so a
// lock-screen double-tap can't fire two Enters (the second landing on whatever's then
// highlighted). Keyed by backend name; cleared in a finally. In-process is enough: the pty/
// tmux backend lives in this same process, so there is no second writer to coordinate with.
const inFlightApprove = new Set<string>();

// POST /api/sessions/[id]/respond — act on a session straight from a push notification's
// action button: stop → kill, or approve → Enter (#9, only offered for a safe press-Enter-
// to-continue prompt). Same auth gate as every route (server.ts); the SW's fetch carries the
// cookie.
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

    // "approve" presses Enter. The push was sent earlier, so RE-VERIFY the LIVE prompt is
    // still a safe press-Enter-to-continue before pressing Enter — between push and tap the
    // prompt may have cleared or changed to a non-approvable one (a permission menu, a
    // destructive confirm). If it's no longer approvable, 409 so the SW falls back to opening
    // the app rather than firing a blind Enter (closes the push→tap TOCTOU). The in-flight
    // guard makes a concurrent double-tap 409 instead of racing a second Enter.
    if (action === "approve") {
      // Opt-in gate (STOA_PUSH_APPROVE=1) — enforced here too, not just at the push-build, so a
      // stale notification button from before the flag was disabled can never fire a blind Enter.
      if (!pushApproveEnabled()) {
        return NextResponse.json(
          { error: "Push approve disabled" },
          { status: 409 }
        );
      }
      if (inFlightApprove.has(name)) {
        return NextResponse.json(
          { error: "Approve already in progress" },
          { status: 409 }
        );
      }
      inFlightApprove.add(name);
      try {
        const prompt = detectPrompt(await backend.capture(name));
        if (!canApproveFromPrompt(prompt?.kind)) {
          return NextResponse.json(
            { error: "Prompt is no longer approvable" },
            { status: 409 }
          );
        }
        await applyResponse(backend, name, action);
      } finally {
        inFlightApprove.delete(name);
      }
      return NextResponse.json({ ok: true, action });
    }

    await applyResponse(backend, name, action);

    return NextResponse.json({ ok: true, action });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("respond route failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
