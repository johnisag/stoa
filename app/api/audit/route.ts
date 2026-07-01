import { NextRequest, NextResponse } from "next/server";
import {
  getDb,
  queries,
  readAuditEvents,
  countAuditEvents,
  type Session,
} from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import { COMMAND_AUDIT_KEY } from "@/lib/command/audit";
import {
  parseAuditParams,
  parseAuditFormat,
  AUDIT_EXPORT_MAX,
  AUDIT_PAYLOAD_CAP,
} from "@/lib/audit/query";
import {
  auditJson,
  auditDownload,
  type AuditEnvelope,
} from "@/lib/audit/response";
import type { AuditCsvRow } from "@/lib/audit/csv";

// GET /api/audit — the fleet-wide audit/activity timeline (#10). Same filters as the
// per-session route (?types&since&until&limit&offset&format), plus an optional
// ?session=<id> to scope to one session. Rows are enriched with the human session
// name so the UI/CSV isn't just opaque backend keys.
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const sp = new URL(request.url).searchParams;

    // Optional session scope: resolve the id to its backend key (what the ledger keys on).
    let sessionKey: string | undefined;
    const sessionId = sp.get("session");
    if (sessionId) {
      const session = queries.getSession(db).get(sessionId) as
        Session | undefined;
      if (!session) {
        return NextResponse.json(
          { error: "Session not found" },
          { status: 404 }
        );
      }
      sessionKey = backendKeyForSession(session);
    }

    const { query, emptyByFilter } = parseAuditParams(sp, sessionKey);
    query.payloadCap = AUDIT_PAYLOAD_CAP; // bound payload size on both read + export
    const format = parseAuditFormat(sp.get("format"));
    const nameByKey = emptyByFilter
      ? new Map<string, string>()
      : buildNameMap(db);

    if (format !== "json") {
      const rows = emptyByFilter
        ? []
        : enrich(
            readAuditEvents(db, {
              ...query,
              limit: AUDIT_EXPORT_MAX,
              offset: 0,
            }),
            nameByKey
          );
      return auditDownload(rows, format, "stoa-audit");
    }

    const envelope: AuditEnvelope = {
      events: emptyByFilter
        ? []
        : enrich(readAuditEvents(db, query), nameByKey),
      total: emptyByFilter ? 0 : countAuditEvents(db, query),
      limit: query.limit,
      offset: query.offset,
    };
    return auditJson(envelope);
  } catch (error) {
    console.error("fleet audit read failed:", error);
    return NextResponse.json(
      { error: "Failed to read audit events" },
      { status: 500 }
    );
  }
}

/** Map each session's BACKEND key → its display name, for enriching event rows. */
function buildNameMap(db: ReturnType<typeof getDb>): Map<string, string> {
  const sessions = queries.getAllSessions(db).all() as Session[];
  const map = new Map<string, string>();
  for (const s of sessions) map.set(backendKeyForSession(s), s.name);
  return map;
}

function enrich(
  rows: AuditCsvRow[],
  nameByKey: Map<string, string>
): AuditCsvRow[] {
  return rows.map((e) => ({
    ...e,
    // Command Stoa events use a synthetic key with no session row — label them so
    // they read clearly; a deleted session's events fall back to their raw key.
    session_name:
      e.session_key === COMMAND_AUDIT_KEY
        ? "Command Stoa"
        : (nameByKey.get(e.session_key) ?? null),
  }));
}
