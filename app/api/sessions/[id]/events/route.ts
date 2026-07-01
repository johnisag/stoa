import { NextRequest, NextResponse } from "next/server";
import {
  getDb,
  queries,
  readAuditEvents,
  countAuditEvents,
  type Session,
} from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import {
  parseAuditParams,
  parseAuditFormat,
  AUDIT_EXPORT_MAX,
  AUDIT_PAYLOAD_CAP,
} from "@/lib/audit/query";
import { auditJson, auditDownload } from "@/lib/audit/response";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/sessions/[id]/events — the audit/activity timeline for ONE session (#10).
// Filters: ?types=a,b&since=<ms>&until=<ms>&limit=&offset=. ?format=csv|json streams a
// download (the newest AUDIT_EXPORT_MAX of the filtered set); no format → a JSON page.
// Reads by the session's BACKEND key (what the ledger records), resolved from its id.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const key = backendKeyForSession(session);
    const sp = new URL(request.url).searchParams;
    const { query, emptyByFilter } = parseAuditParams(sp, key);
    query.payloadCap = AUDIT_PAYLOAD_CAP; // bound payload size on both read + export
    const format = parseAuditFormat(sp.get("format"));

    if (format !== "json") {
      const rows = emptyByFilter
        ? []
        : readAuditEvents(db, { ...query, limit: AUDIT_EXPORT_MAX, offset: 0 });
      return auditDownload(rows, format, `session-${id}-events`);
    }

    const events = emptyByFilter ? [] : readAuditEvents(db, query);
    const total = emptyByFilter ? 0 : countAuditEvents(db, query);
    return auditJson({
      events,
      total,
      limit: query.limit,
      offset: query.offset,
    });
  } catch (error) {
    console.error("session events read failed:", error);
    return NextResponse.json(
      { error: "Failed to read session events" },
      { status: 500 }
    );
  }
}
