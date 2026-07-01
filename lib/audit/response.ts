/**
 * Audit read surface (#10) — shared HTTP response shaping for the per-session
 * (`/api/sessions/[id]/events`) and fleet (`/api/audit`) routes, so both agree on
 * the display envelope and the download headers.
 */
import { NextResponse } from "next/server";
import { eventsToCsv, type AuditCsvRow } from "./csv";

/** The in-app JSON envelope: one page of events plus the filtered total for paging. */
export interface AuditEnvelope {
  events: AuditCsvRow[];
  total: number;
  limit: number;
  offset: number;
}

export function auditJson(envelope: AuditEnvelope): NextResponse {
  return NextResponse.json(envelope);
}

// A download filename is interpolated into the Content-Disposition header, so keep
// it to a safe slug — a stray quote/newline would let a caller break the header.
function safeStem(stem: string): string {
  const slug = stem.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  return slug || "stoa-audit";
}

function downloadHeaders(contentType: string, filename: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
  };
}

/** Stream the filtered rows as a downloadable CSV or JSON file. */
export function auditDownload(
  rows: AuditCsvRow[],
  format: "csv" | "download-json",
  stem: string
): NextResponse {
  const slug = safeStem(stem);
  if (format === "csv") {
    return new NextResponse(eventsToCsv(rows), {
      headers: downloadHeaders("text/csv; charset=utf-8", `${slug}.csv`),
    });
  }
  return new NextResponse(JSON.stringify(rows, null, 2), {
    headers: downloadHeaders("application/json; charset=utf-8", `${slug}.json`),
  });
}
