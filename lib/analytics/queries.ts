/**
 * Analytics DB layer — gathers the normalized snapshot the pure engine consumes.
 *
 * This is the ONLY part of the Insight layer that touches better-sqlite3 + the
 * filesystem (cost transcripts). It reads the audit ledger (session_events), the
 * sessions table, and the dispatch outcome columns, joins them on the backend
 * key (session_events.session_key == sessions.tmux_name), folds in the existing
 * cost estimator, and hands a plain AnalyticsSnapshot to engine.buildReport().
 *
 * Runs in the web-server process (where the DB lives). Best-effort on the
 * per-session cost read (a missing transcript contributes 0, never throws).
 */

import { getDb, queries, type Session } from "../db";
import type { SessionEvent } from "../db";
import type { IssueDispatch } from "../dispatch/types";
import type { AgentType } from "../providers";
import { computeSessionCosts } from "../session-cost";
import { buildReport, utcDay } from "./engine";
import type {
  AnalyticsSnapshot,
  AnalyticsSession,
  AnalyticsEvent,
  AnalyticsReport,
} from "./types";

const MS_PER_DAY = 86_400_000;
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 90;

/** Parse a TEXT datetime('now') value (UTC, no zone) to epoch ms; now() on fail. */
function parseSqlTime(s: string | null | undefined, fallback: number): number {
  if (!s) return fallback;
  // SQLite datetime('now') yields "YYYY-MM-DD HH:MM:SS" in UTC — append Z so
  // Date parses it as UTC rather than local (which would skew every duration).
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? fallback : ms;
}

/** Clamp the window-days query param into a sane range. */
export function normalizeWindowDays(raw: unknown): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WINDOW_DAYS;
  return Math.min(Math.floor(n), MAX_WINDOW_DAYS);
}

/**
 * Start of the analytics window as epoch ms — midnight UTC of the FIRST day the
 * trends axis shows (now − (windowDays−1) days). Aligning the data filter to the
 * day-axis boundary (rather than a rolling N×24h cutoff) keeps every lens
 * consistent: a session that passes the filter always maps onto a chart day.
 */
export function windowStartMs(now: number, windowDays: number): number {
  const firstDay = utcDay(now - (windowDays - 1) * MS_PER_DAY);
  return Date.parse(`${firstDay}T00:00:00.000Z`);
}

/**
 * Gather the snapshot + build the report for the last `windowDays` days.
 * `now` is injectable so the API (and tests) stay deterministic.
 */
export async function getAnalyticsReport(
  windowDays = DEFAULT_WINDOW_DAYS,
  now: number = Date.now()
): Promise<AnalyticsReport> {
  const db = getDb();
  const since = windowStartMs(now, windowDays);

  const allSessions = queries.getAllSessions(db).all() as Session[];

  // Outcome signals: index dispatch rows by their session_id so we can attach a
  // worker's terminal state + review verdict to the matching session.
  const dispatches = queries
    .listDispatchesForBoard(db)
    .all() as IssueDispatch[];
  const dispatchBySession = new Map<string, IssueDispatch>();
  for (const d of dispatches) {
    if (d.session_id) dispatchBySession.set(d.session_id, d);
  }

  // All ledger events in the window in ONE indexed query (idx_session_events_
  // created), grouped by key — far cheaper than a per-key full-history scan.
  const windowEvents = queries
    .getSessionEventsSince(db)
    .all(since) as SessionEvent[];
  const eventsByKey = new Map<string, AnalyticsEvent[]>();
  for (const r of windowEvents) {
    const e: AnalyticsEvent = {
      session_key: r.session_key,
      event_type: r.event_type,
      // The engine reads only event_type + created_at; payload metadata is kept
      // null here to avoid parsing (and never surfacing) per-event input detail.
      payload: null,
      created_at: r.created_at,
    };
    const list = eventsByKey.get(r.session_key);
    if (list) list.push(e);
    else eventsByKey.set(r.session_key, [e]);
  }

  // A session belongs to the window if it was CREATED in it OR has any event in
  // it (so a long-lived session active this week isn't dropped for being old).
  const sessionKey = (s: Session) => s.tmux_name || s.name;
  const windowSessions = allSessions.filter(
    (s) =>
      parseSqlTime(s.created_at, now) >= since || eventsByKey.has(sessionKey(s))
  );

  // Cost (Claude-only; others null) for the WINDOW sessions only — scoping it
  // here avoids reading every historical transcript on each request.
  const costs = await computeSessionCosts(windowSessions);

  const sessions: AnalyticsSession[] = windowSessions.map((s) => {
    const key = sessionKey(s);
    const d = dispatchBySession.get(s.id) ?? null;
    const cost = costs[s.id];
    const prMerged = s.pr_status === "merged" || d?.status === "merged";
    return {
      id: s.id,
      key,
      agent_type: s.agent_type as AgentType,
      model: s.model,
      created_at: parseSqlTime(s.created_at, now),
      updated_at: parseSqlTime(s.updated_at, now),
      status: s.status,
      dispatchStatus: d?.status ?? null,
      reviewDecision: d?.review_decision ?? null,
      prMerged: !!prMerged,
      costUsd: cost?.costUsd ?? null,
      totalTokens: cost
        ? cost.tokens.input +
          cost.tokens.output +
          cost.tokens.cacheRead +
          cost.tokens.cacheWrite
        : 0,
    };
  });

  // Only carry events whose key maps to a windowed session (drop orphans, e.g.
  // events from a session deleted out of the window).
  const keep = new Set(sessions.map((s) => s.key));
  const events: AnalyticsEvent[] = [];
  for (const [key, list] of eventsByKey) {
    if (keep.has(key)) events.push(...list);
  }

  const snapshot: AnalyticsSnapshot = { sessions, events, now, windowDays };
  return buildReport(snapshot);
}
