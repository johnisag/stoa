import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries, type Session, type Message } from "@/lib/db";
import { sessionKey, backendKeyForSession } from "@/lib/providers/registry";
import { parseJsonBody, sanitizeSessionName } from "@/lib/api-security";
import {
  forkModeForProvider,
  buildForkSeed,
  FORK_SCROLLBACK_LINES,
} from "@/lib/fork";
import { getSessionBackend } from "@/lib/session-backend";
import { enqueuePrompt } from "@/lib/prompt-queue";
import { readClaudeSessionUsage } from "@/lib/session-cost";
import {
  prepareForkFromSnapshot,
  createCheckpoint,
  buildForkFeatureName,
} from "@/lib/checkpoints";
import { deleteWorktree } from "@/lib/worktrees";

interface RouteParams {
  params: Promise<{ id: string; seq: string }>;
}

// POST /api/sessions/[id]/snapshots/[seq]/fork — fork a new, isolated session
// from any point in history: a fresh git worktree branched at that turn's
// snapshot commit (the CODE state then) + the provider's conversation fork. The
// transcript branches at its TIP (native --fork-session); mid-transcript
// fidelity is a v2 follow-up.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: parentId, seq } = await params;
    const seqNum = parseInt(seq, 10);
    if (Number.isNaN(seqNum)) {
      return NextResponse.json({ error: "Bad snapshot id" }, { status: 400 });
    }

    let body: { name?: string } = {};
    const parsed = await parseJsonBody<{ name?: string }>(request);
    if (parsed.ok) body = parsed.data;
    const sanitizedName = sanitizeSessionName(body.name);

    const db = getDb();
    const parent = queries.getSession(db).get(parentId) as Session | undefined;
    if (!parent) {
      return NextResponse.json(
        { error: "Parent session not found" },
        { status: 404 }
      );
    }

    const newId = randomUUID();
    const newName = sanitizedName || `${parent.name} (fork @${seqNum})`;
    const agentType = parent.agent_type || "claude";

    // Materialize the turn's tree as an isolated worktree. The feature name
    // carries the new id so repeat forks never collide on branch/path — via a
    // helper that keeps the id from being truncated by slugify's 50-char cap.
    let prep;
    try {
      prep = await prepareForkFromSnapshot(
        parent,
        seqNum,
        { featureName: buildForkFeatureName(newName, newId) },
        db
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("snapshot fork: worktree creation failed:", msg);
      return NextResponse.json(
        { error: `Couldn't create fork worktree: ${msg}` },
        { status: 500 }
      );
    }
    if (!prep) {
      return NextResponse.json(
        { error: "Snapshot not found or has expired" },
        { status: 404 }
      );
    }

    // The worktree + branch now exist on disk. If anything below throws before
    // we return, they'd be orphaned — so clean them up best-effort on failure
    // (mirrors the create-worktree-then-session convention in lib/dispatch).
    try {
      const tmuxName = sessionKey({
        kind: "agent",
        provider: agentType,
        id: newId,
      });
      queries
        .createSession(db)
        .run(
          newId,
          newName,
          tmuxName,
          prep.worktreePath,
          parentId,
          parent.model,
          parent.system_prompt,
          parent.group_path || "sessions",
          agentType,
          parent.auto_approve ? 1 : 0,
          parent.project_id || "uncategorized"
        );

      // Conversation fork seam — identical to the plain fork route (native
      // branches the transcript at tip on first attach; scrollback seeds a fresh
      // session).
      const forkMode = forkModeForProvider(agentType);
      let seeded = false;
      if (forkMode === "scrollback") {
        try {
          const scrollback = await getSessionBackend().capture(
            backendKeyForSession(parent),
            { lines: FORK_SCROLLBACK_LINES }
          );
          const seed = buildForkSeed(scrollback, parent.name);
          if (seed) {
            enqueuePrompt(newId, seed);
            seeded = true;
          }
        } catch (err) {
          console.warn(
            "snapshot fork: scrollback capture failed, no seed:",
            err
          );
        }
      } else if (forkMode === "native") {
        if (parent.claude_session_id && parent.working_directory) {
          try {
            const parentUsage = await readClaudeSessionUsage(
              parent.working_directory,
              parent.claude_session_id
            );
            if (parentUsage) {
              queries
                .updateSessionForkBaseline(db)
                .run(JSON.stringify(parentUsage.tokens), newId);
            }
          } catch (err) {
            console.warn("snapshot fork: parent usage read failed:", err);
          }
        }
      }

      // Record a fork-origin checkpoint in the NEW session pinning its starting
      // tree, with lineage back to the source checkpoint (if that turn was one).
      // Best-effort: a failure here doesn't undo the (already valid) fork.
      let originCheckpointId: string | null = null;
      try {
        const origin = await createCheckpoint(
          {
            id: newId,
            working_directory: prep.worktreePath,
            claude_session_id: null,
          },
          {
            label: `Forked from ${parent.name} @${seqNum}`,
            kind: "fork-origin",
            createdBy: "system",
            parentCheckpointId: prep.sourceCheckpointId,
          },
          db
        );
        originCheckpointId = origin?.id ?? null;
      } catch (err) {
        console.warn("snapshot fork: fork-origin checkpoint failed:", err);
      }

      // Copy local messages for logging continuity (mirrors the plain fork route).
      const parentMessages = queries
        .getSessionMessages(db)
        .all(parentId) as Message[];
      for (const msg of parentMessages) {
        queries
          .createMessage(db)
          .run(newId, msg.role, msg.content, msg.duration_ms);
      }

      const session = queries.getSession(db).get(newId) as Session;
      return NextResponse.json(
        {
          session,
          forkMode,
          seeded,
          worktreePath: prep.worktreePath,
          branchName: prep.branchName,
          originCheckpointId,
          messagesCopied: parentMessages.length,
        },
        { status: 201 }
      );
    } catch (err) {
      // Roll back BOTH sides of the half-built fork, then rethrow to the outer
      // handler (which returns 500) — never let cleanup mask the cause. The
      // session row may already be committed (better-sqlite3 autocommits), so
      // reclaim it first (FK CASCADE drops the fork-origin checkpoint + copied
      // messages), then remove the orphaned worktree + its feature branch. This
      // fully mirrors the create-worktree-then-session cleanup in lib/dispatch.
      try {
        if (queries.getSession(db).get(newId)) {
          queries.deleteSession(db).run(newId);
        }
      } catch {
        // Best-effort — a failed reclaim must not mask the original error.
      }
      await deleteWorktree(prep.worktreePath, prep.projectPath, true).catch(
        () => {}
      );
      throw err;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Error forking from snapshot:", msg);
    return NextResponse.json(
      { error: "Failed to fork from snapshot" },
      { status: 500 }
    );
  }
}
