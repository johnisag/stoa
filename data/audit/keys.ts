import type { AuditFilters } from "./queries";

/** React-query keys for the audit/activity read surface (#10). */
export const auditKeys = {
  all: ["audit"] as const,
  fleet: (filters: AuditFilters) => ["audit", "fleet", filters] as const,
};
