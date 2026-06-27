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

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/sessions/[id]/fork - Fork a session
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: parentId } = await params;

    // Parse body if present, otherwise use empty object
    let body: { name?: string } = {};
    try {
      const parsed = await parseJsonBody<{ name?: string }>(request);
      if (parsed.ok) body = parsed.data;
    } catch {
      // No body provided, use defaults
    }
    const { name } = body;

    const sanitizedName = sanitizeSessionName(name);

    const db = getDb();

    // Get parent session
    const parent = queries.getSession(db).get(parentId) as Session | undefined;
    if (!parent) {
      return NextResponse.json(
        { error: "Parent session not found" },
        { status: 404 }
      );
    }

    // Create new session
    const newId = randomUUID();
    const newName = sanitizedName || `${parent.name} (fork)`;
    const agentType = parent.agent_type || "claude";
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
        parent.working_directory,
        parentId,
        parent.model,
        parent.system_prompt,
        parent.group_path || "sessions",
        agentType,
        parent.auto_approve ? 1 : 0,
        parent.project_id || "uncategorized"
      );

    // NOTE: We do NOT copy claude_session_id here.
    // NATIVE fork (Claude): when the forked session is first attached, buildAgentArgs
    // uses --resume <parent claude_session_id> --fork-session to branch the
    // conversation; the new id is captured automatically.
    // SCROLLBACK fork (Codex/Hermes/Kilo/Kimi — no fork primitive): the new session
    // launches FRESH, so seed it with the parent's recent rendered scrollback as a
    // "continue from here" prompt. Capture it NOW while the parent is live, then
    // enqueue the seed; the existing status ticker delivers it at the fork's first
    // idle turn (the same safe path the scheduler/queue use). A dead/empty parent
    // (capture fails or returns nothing) degrades to a plain fresh session.
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
        // Parent not live / capture unsupported — fork without a seed.
        console.warn("fork: scrollback capture failed, no seed:", err);
      }
    }

    // Copy any local messages from parent (for logging purposes)
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
        messagesCopied: parentMessages.length,
        forkMode,
        seeded,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error forking session:", error);
    return NextResponse.json(
      { error: "Failed to fork session" },
      { status: 500 }
    );
  }
}
