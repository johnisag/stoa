import { NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { readClaudeSessionUsage } from "@/lib/session-cost";
import { computeCostUsd, ZERO_USAGE, type TokenUsage } from "@/lib/pricing";

export interface SessionCost {
  name: string;
  model: string | null;
  tokens: TokenUsage;
  costUsd: number | null;
  /** false for non-Claude agents (no comparable transcript) — shown as "—". */
  supported: boolean;
}

// GET /api/sessions/cost — estimated token cost per session + a fleet total.
// Claude-only today (reads each Claude session's transcript JSONL); other agents
// report supported:false. Best-effort: a session with no readable transcript
// contributes zero. Not on the hot poll path — the client refetches slowly.
export async function GET() {
  try {
    const db = getDb();
    const sessions = queries.getAllSessions(db).all() as Session[];

    // Read all transcripts concurrently (off the hot path; refetched slowly).
    const entries = await Promise.all(
      sessions.map(async (s): Promise<[string, SessionCost]> => {
        const base = { name: s.name, model: s.model };
        if (
          s.agent_type !== "claude" ||
          !s.claude_session_id ||
          !s.working_directory
        ) {
          return [
            s.id,
            { ...base, tokens: ZERO_USAGE, costUsd: null, supported: false },
          ];
        }
        const tokens =
          (await readClaudeSessionUsage(
            s.working_directory,
            s.claude_session_id
          )) ?? ZERO_USAGE;
        return [
          s.id,
          {
            ...base,
            tokens,
            costUsd: computeCostUsd(tokens, s.model),
            supported: true,
          },
        ];
      })
    );

    const out: Record<string, SessionCost> = Object.fromEntries(entries);
    const totalUsd = entries.reduce((sum, [, c]) => sum + (c.costUsd ?? 0), 0);

    return NextResponse.json({ sessions: out, totalUsd });
  } catch (error) {
    console.error("cost route failed:", error);
    return NextResponse.json(
      { error: "Failed to compute cost" },
      { status: 500 }
    );
  }
}
