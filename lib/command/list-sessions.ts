/**
 * Command Stoa — the in-process list_sessions executor.
 *
 * Read-only: queries getAllSessions, optionally filters by status, and returns a
 * compact summary array. No session is created or modified.
 */

import { getDb, queries } from "@/lib/db";
import type { Session } from "@/lib/db";
import type { ListSessionsParams, SessionSummary } from "./actions";

export type { SessionSummary };

export interface ListSessionsResult {
  sessions: SessionSummary[];
  total: number;
}

/**
 * Return a compact summary of sessions, optionally filtered by status.
 * Pure read — no writes, no spawns.
 */
export function executeListSessions(
  params: ListSessionsParams
): ListSessionsResult {
  const db = getDb();
  const all = queries.getAllSessions(db).all() as Session[];
  const filtered = params.status
    ? all.filter((s) => s.status === params.status)
    : all;
  const sessions: SessionSummary[] = filtered.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    agentType: s.agent_type,
    updatedAt: s.updated_at,
  }));
  return { sessions, total: sessions.length };
}
