import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { readClaudeTranscriptRaw } from "@/lib/claude-transcript";
import { searchTranscript, type OutputHit } from "@/lib/output-search";

// Search agent OUTPUT across every session — "which of my agents mentioned X?".
// The corpus is each Claude session's on-disk JSONL transcript (the same file
// cost/summary already read); non-Claude agents have no comparable transcript
// Stoa reads, so they're skipped (mirrors the Claude-only cost surface). Pure-JS
// substring scan — no `grep` shell-out, cross-platform by construction.

const MIN_QUERY = 2; // 1-char queries match everything → noise
const MAX_QUERY = 200;
const MAX_HITS_PER_SESSION = 5;
const MAX_SESSIONS = 50; // cap the response; ranked by match count so the top wins
// Bound concurrent transcript reads so a large fleet can't fan out into hundreds
// of open fds + a memory spike (same posture as computeSessionCosts).
const READ_CONCURRENCY = 12;

interface SessionOutputResult {
  id: string;
  name: string;
  agentType: string;
  total: number;
  hits: OutputHit[];
}

export async function GET(request: NextRequest) {
  const query = (request.nextUrl.searchParams.get("q") || "")
    .trim()
    .slice(0, MAX_QUERY);
  if (query.length < MIN_QUERY) {
    return NextResponse.json({ results: [], query, count: 0 });
  }

  try {
    const db = getDb();
    // Only Claude sessions with a captured transcript id are searchable.
    const sessions = (queries.getAllSessions(db).all() as Session[]).filter(
      (s) =>
        s.agent_type === "claude" &&
        !!s.claude_session_id &&
        !!s.working_directory
    );

    const results: SessionOutputResult[] = [];
    // Read in fixed-size batches so at most READ_CONCURRENCY transcripts are open
    // at once, and bail early if the client navigated away / typed a new query.
    for (let i = 0; i < sessions.length; i += READ_CONCURRENCY) {
      if (request.signal.aborted) break;
      const batch = sessions.slice(i, i + READ_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (s): Promise<SessionOutputResult | null> => {
          const raw = await readClaudeTranscriptRaw(
            s.working_directory,
            s.claude_session_id as string
          );
          if (!raw) return null;
          const { hits, total } = searchTranscript(raw, query, {
            maxHits: MAX_HITS_PER_SESSION,
          });
          if (total === 0) return null;
          return {
            id: s.id,
            name: s.name,
            agentType: s.agent_type,
            total,
            hits,
          };
        })
      );
      for (const r of batchResults) if (r) results.push(r);
    }

    // Rank by match count (most relevant first), then cap the response size.
    results.sort((a, b) => b.total - a.total);
    return NextResponse.json({
      results: results.slice(0, MAX_SESSIONS),
      query,
      count: results.length,
    });
  } catch (error) {
    console.error("output search error:", error);
    return NextResponse.json(
      { error: "Failed to search output" },
      { status: 500 }
    );
  }
}
