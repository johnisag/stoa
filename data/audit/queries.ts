import { useQuery } from "@tanstack/react-query";
// Type-only imports — erased at build, so the client bundle never pulls the
// server-touching db/audit modules (same trick data/analytics uses).
import type { AuditCsvRow } from "@/lib/audit/csv";
import type { SessionEventType } from "@/lib/db/types";
import { auditKeys } from "./keys";

export interface AuditFilters {
  /** Scope to one session (its id) — omit for a fleet-wide read. */
  session?: string;
  types?: SessionEventType[];
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export interface AuditEnvelope {
  events: AuditCsvRow[];
  total: number;
  limit: number;
  offset: number;
}

/** Serialize filters to a query string — shared by the fetch hook and the export
 *  download links, so the on-screen view and the exported file always match. */
export function auditQueryString(filters: AuditFilters): string {
  const p = new URLSearchParams();
  if (filters.session) p.set("session", filters.session);
  if (filters.types && filters.types.length)
    p.set("types", filters.types.join(","));
  if (filters.since != null) p.set("since", String(filters.since));
  if (filters.until != null) p.set("until", String(filters.until));
  if (filters.limit != null) p.set("limit", String(filters.limit));
  if (filters.offset != null) p.set("offset", String(filters.offset));
  return p.toString();
}

async function fetchFleetAudit(filters: AuditFilters): Promise<AuditEnvelope> {
  const qs = auditQueryString(filters);
  const res = await fetch(`/api/audit${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to load activity");
  return (await res.json()) as AuditEnvelope;
}

/**
 * The fleet-wide (optionally session-scoped) audit timeline. Enabled only while the
 * Activity view is open; a modest refetch keeps it live-ish without hammering.
 */
export function useFleetAuditQuery(filters: AuditFilters, enabled = true) {
  return useQuery({
    queryKey: auditKeys.fleet(filters),
    queryFn: () => fetchFleetAudit(filters),
    enabled,
    staleTime: 5000,
    refetchInterval: enabled ? 15000 : false,
  });
}

/** A download URL (CSV or JSON attachment) for the current filters. Limit/offset are
 *  dropped — a download streams the newest AUDIT_EXPORT_MAX of the filtered set. */
export function auditExportUrl(
  filters: AuditFilters,
  format: "csv" | "json"
): string {
  const qs = auditQueryString({
    ...filters,
    limit: undefined,
    offset: undefined,
  });
  return `/api/audit?${qs ? `${qs}&` : ""}format=${format}`;
}
