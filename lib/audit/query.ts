/**
 * Audit read — PURE query core for the activity/timeline read surface (#10).
 *
 * Parses the read filters (event types, time window, pagination) off a URL's
 * search params and builds PARAMETERIZED SQL over `session_events`. No DB, no I/O
 * → unit-tested. The route layer runs the built SQL (lib/db/queries.ts
 * readAuditEvents/countAuditEvents); the client filter UI reuses AUDIT_EVENT_TYPES.
 *
 * SAFETY: every user value rides as a bound `?` placeholder (never string-
 * concatenated), and `types` is validated against the known SessionEventType set,
 * so a caller can neither inject SQL nor probe with arbitrary column values. Limit
 * and offset are clamped fail-safe (NaN/negative/over-max → sane bounds).
 */
import type { SessionEventType } from "@/lib/db/types";

/** Every recorded event kind, as a runtime array (the union has no runtime form).
 * `satisfies` checks each entry is a real type; the exhaustiveness guard below
 * fails the build if a new SessionEventType is added but not listed here. */
export const AUDIT_EVENT_TYPES = [
  "session_create",
  "session_kill",
  "session_rename",
  "input_text",
  "input_paste",
  "input_enter",
  "input_escape",
  "command_proposed",
  "command_executed",
  "command_rejected",
  "command_failed",
  "workflow_proposed",
  "workflow_rejected",
  "workflow_failed",
] as const satisfies readonly SessionEventType[];

// Compile-time exhaustiveness: errors if a SessionEventType is missing above.
type _MissingType = Exclude<
  SessionEventType,
  (typeof AUDIT_EVENT_TYPES)[number]
>;
const _exhaustive: _MissingType extends never ? true : never = true;
void _exhaustive;

/** Default page size for the timeline, and the hard ceiling a caller can request. */
export const AUDIT_LIMIT_DEFAULT = 100;
export const AUDIT_LIMIT_MAX = 500;
/** Row cap for a CSV/JSON download — the newest N filtered events (offset ignored). */
export const AUDIT_EXPORT_MAX = 10_000;
/** Max chars of each event's payload a read returns (a bounded SQL substr). Keeps a
 *  bulk export of verbatim-captured input (STOA_AUDIT_INPUT_TEXT=1, up to 64KB/event)
 *  from materializing huge strings in memory — an audit index, not the full store. */
export const AUDIT_PAYLOAD_CAP = 8192;

export interface AuditQuery {
  /** Constrain to one backend session key. Omit for a fleet-wide read. */
  sessionKey?: string;
  /** Filter to these event kinds (already validated). Omit/empty → all kinds. */
  types?: SessionEventType[];
  /** Inclusive epoch-millis lower / upper bound on created_at. */
  since?: number;
  until?: number;
  limit: number;
  offset: number;
  /** Cap each returned payload to this many chars (SQL substr). Omit → full payload. */
  payloadCap?: number;
}

export interface AuditSql {
  sql: string;
  params: (string | number)[];
  countSql: string;
  countParams: (string | number)[];
}

/**
 * Build the SELECT (a page, newest-first) and the matching COUNT (the filtered
 * total, no limit) for an AuditQuery. All values are bound placeholders.
 */
export function buildAuditSql(q: AuditQuery): AuditSql {
  const where: string[] = [];
  const whereParams: (string | number)[] = [];
  if (q.sessionKey !== undefined) {
    where.push("session_key = ?");
    whereParams.push(q.sessionKey);
  }
  if (q.types && q.types.length > 0) {
    where.push(`event_type IN (${q.types.map(() => "?").join(", ")})`);
    whereParams.push(...q.types);
  }
  if (q.since !== undefined) {
    where.push("created_at >= ?");
    whereParams.push(q.since);
  }
  if (q.until !== undefined) {
    where.push("created_at <= ?");
    whereParams.push(q.until);
  }
  const whereClause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const countSql = `SELECT COUNT(*) AS n FROM session_events${whereClause}`;
  const countParams = [...whereParams];
  // An optional payload cap rides as a substr in the SELECT, so its `?` is the FIRST
  // bound param. Newest first for a timeline; the id tiebreak keeps a stable order
  // within one ms.
  const payloadCol =
    q.payloadCap != null ? "substr(payload, 1, ?) AS payload" : "payload";
  const selectParams: number[] = q.payloadCap != null ? [q.payloadCap] : [];
  const sql =
    `SELECT id, session_key, event_type, ${payloadCol}, created_at FROM session_events${whereClause}` +
    ` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  const params = [...selectParams, ...whereParams, q.limit, q.offset];
  return { sql, params, countSql, countParams };
}

function clampLimit(raw: string | null): number {
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return AUDIT_LIMIT_DEFAULT;
  if (n < 1) return 1;
  if (n > AUDIT_LIMIT_MAX) return AUDIT_LIMIT_MAX;
  return n;
}

function clampOffset(raw: string | null): number {
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseTimestamp(raw: string | null): number | undefined {
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export interface ParsedAuditParams {
  query: AuditQuery;
  /** True when a `types` filter was given but NONE were valid → the caller asked
   *  for kinds that don't exist, so the route returns an empty set (not "all"). */
  emptyByFilter: boolean;
}

/**
 * Parse + validate the read filters off URL search params. `sessionKey`, when
 * provided by the route (per-session endpoint), is forced onto the query.
 */
export function parseAuditParams(
  searchParams: URLSearchParams,
  sessionKey?: string
): ParsedAuditParams {
  let types: SessionEventType[] | undefined;
  let emptyByFilter = false;
  const rawTypes = searchParams.get("types");
  if (rawTypes != null && rawTypes.length > 0) {
    const valid = new Set<string>(AUDIT_EVENT_TYPES);
    // Dedupe: a repeated valid token (?types=input_text,input_text,…) would otherwise
    // grow the IN-arity — and thus the distinct prepared-SQL shapes cached per db —
    // without bound. A Set caps the arity at the number of known kinds (≤14).
    const parsed = [
      ...new Set(
        rawTypes
          .split(",")
          .map((t) => t.trim())
          .filter((t) => valid.has(t))
      ),
    ] as SessionEventType[];
    if (parsed.length === 0) emptyByFilter = true;
    else types = parsed;
  }
  return {
    query: {
      sessionKey,
      types,
      since: parseTimestamp(searchParams.get("since")),
      until: parseTimestamp(searchParams.get("until")),
      limit: clampLimit(searchParams.get("limit")),
      offset: clampOffset(searchParams.get("offset")),
    },
    emptyByFilter,
  };
}

export type AuditFormat = "json" | "csv" | "download-json";

/** Map the `format` param to a response mode: absent → in-app JSON envelope;
 *  `csv` → CSV download; `json` → downloadable .json of the raw rows. */
export function parseAuditFormat(raw: string | null): AuditFormat {
  if (raw === "csv") return "csv";
  if (raw === "json") return "download-json";
  return "json";
}
