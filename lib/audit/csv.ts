/**
 * Audit export — PURE CSV serializer for the activity read surface (#10). No I/O
 * → unit-tested. Turns audit rows into RFC-4180 CSV (CRLF line endings, quote-
 * escaped fields) for a spreadsheet download.
 *
 * SECURITY: guards against CSV FORMULA INJECTION. An audit payload is attacker-
 * influenced (it can hold text an agent typed / a command it ran); a field that
 * begins with `= + - @` (or a leading tab/CR some spreadsheets treat as a formula
 * lead) is prefixed with a `'` so Excel/Sheets render it as literal text instead
 * of evaluating it. See OWASP "CSV Injection".
 */
import type { SessionEvent } from "@/lib/db/types";

/** An audit row, optionally enriched with the human session name (fleet view). */
export interface AuditCsvRow extends SessionEvent {
  session_name?: string | null;
}

const COLUMNS = [
  "id",
  "created_at",
  "created_at_iso",
  "session_key",
  "session_name",
  "event_type",
  "payload",
] as const;

function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** RFC-4180 field: formula-guarded, then quote-wrapped iff it contains a comma,
 *  double-quote, or newline (internal quotes doubled). */
export function csvField(value: string | number | null | undefined): string {
  const guarded = neutralizeFormula(value == null ? "" : String(value));
  return /[",\r\n]/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

function isoOf(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

/** Serialize audit rows to CSV (header + one line per row, CRLF-joined). */
export function eventsToCsv(rows: AuditCsvRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.id),
        csvField(r.created_at),
        csvField(isoOf(r.created_at)),
        csvField(r.session_key),
        csvField(r.session_name ?? ""),
        csvField(r.event_type),
        csvField(r.payload ?? ""),
      ].join(",")
    );
  }
  return lines.join("\r\n");
}
