import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import { getPRForBranchAnyState } from "@/lib/dispatch/issues";
import { mergePR } from "@/lib/dispatch/merge";
import { expandHome } from "@/lib/platform";
import type { SessionCeremony } from "@/lib/dispatch/types";

function requireSession(id: string): Session | null {
  return (queries.getSession(getDb()).get(id) as Session | undefined) ?? null;
}

/**
 * Session "go to auto" — enrol a session in the dispatch ceremony (critic panel →
 * fix loop → CI auto-fix → auto-merge). The session must be on its own worktree +
 * branch with an OPEN PR; we resolve the PR LIVE from the branch (`gh pr list`),
 * since Stoa's PR flows don't all write the session row. An optional seed prompt
 * is sent to the session as a final instruction; the reconciler's ceremony pass
 * waits for the session to settle before it starts reviewing.
 *
 *   POST   { seedPrompt?: string }  → enrol (idempotent) → { ceremony }
 *   GET                             → { ceremony | null }
 *   DELETE                          → cancel (remove the row) → { success }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let seedPrompt: string | undefined;
    let autoMerge = 0;
    try {
      const body = await request.json();
      seedPrompt =
        typeof body?.seedPrompt === "string"
          ? body.seedPrompt.trim()
          : undefined;
      // Opt-in unattended merge; default off (the human does the final merge).
      autoMerge = body?.autoMerge === true ? 1 : 0;
    } catch {
      // No body / invalid JSON is fine — auto mode with no seed prompt, no merge.
    }

    const db = getDb();
    const session = requireSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (!session.worktree_path || !session.branch_name) {
      return NextResponse.json(
        { error: "Auto mode needs the session on its own worktree + branch." },
        { status: 400 }
      );
    }

    // Resolve the PR live from the branch (the session row's pr_* fields aren't
    // written by every PR flow). An open PR is required — auto mode reviews + merges it.
    const pr = await getPRForBranchAnyState(
      expandHome(session.worktree_path),
      session.branch_name
    );
    if (!pr || pr.state !== "OPEN") {
      return NextResponse.json(
        {
          error: `No open PR found for branch "${session.branch_name}" — open one first; auto mode reviews and merges its PR.`,
        },
        { status: 400 }
      );
    }
    // Cache the PR on the session (lights the card's PR badge + feeds the pass).
    queries.updateSessionPR(db).run(pr.url, pr.number, "open", session.id);

    // Idempotent: re-tapping "go to auto" on an enrolled session refreshes the PR
    // but doesn't re-insert or re-poke. The seed prompt is sent only on the FIRST
    // enrol (changes===1 also guards against a racing double-POST).
    const existing = queries.getSessionCeremony(db).get(id) as
      | SessionCeremony
      | undefined;
    const ceremonyId = existing?.id ?? randomUUID();
    let firstEnrol = false;
    if (!existing) {
      const r = queries
        .createSessionCeremony(db)
        .run(ceremonyId, id, seedPrompt || null, autoMerge);
      firstEnrol = r.changes === 1;
    }
    queries.updateCeremonyPR(db).run(pr.url, pr.number, ceremonyId);

    if (firstEnrol && seedPrompt) {
      // Send the seed prompt as a final instruction. The session goes 'running';
      // the ceremony pass holds off until it idles again.
      try {
        const backend = getSessionBackend();
        if (await backend.exists(session.tmux_name)) {
          await backend.pasteText(session.tmux_name, seedPrompt, {
            enter: true,
          });
        }
      } catch (err) {
        console.error("ceremony: failed to send seed prompt:", err);
        // Non-fatal — the ceremony still proceeds once the session is idle.
      }
    }

    const ceremony = queries.getSessionCeremony(db).get(id) as SessionCeremony;
    return NextResponse.json({ ceremony });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** PUT — the human's one-tap "Merge now" for a ceremony at 'awaiting_merge'
 * (auto_merge off). Pinned to the reviewed SHA: gh refuses if the head moved off
 * what the panel approved, so even the human merge never lands unreviewed pushes. */
export async function PUT(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const session = requireSession(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const ceremony = queries.getSessionCeremony(db).get(id) as
    | SessionCeremony
    | undefined;
  if (!ceremony || ceremony.pr_number == null || !session.worktree_path) {
    return NextResponse.json(
      { error: "No auto-mode PR to merge." },
      { status: 400 }
    );
  }
  try {
    await mergePR({
      cwd: expandHome(session.worktree_path),
      prNumber: ceremony.pr_number,
      matchHeadCommit: ceremony.review_sha,
    });
    queries.setCeremonyStep(db).run("merged", ceremony.id);
    queries
      .updateSessionPR(db)
      .run(
        session.pr_url ?? ceremony.pr_url,
        ceremony.pr_number,
        "merged",
        session.id
      );
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!requireSession(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const ceremony =
    (queries.getSessionCeremony(getDb()).get(id) as
      | SessionCeremony
      | undefined) ?? null;
  return NextResponse.json({ ceremony });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!requireSession(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  queries.deleteSessionCeremony(getDb()).run(id);
  return NextResponse.json({ success: true });
}
