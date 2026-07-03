import type Database from "better-sqlite3";
import type { SessionEvent } from "../types";
import { buildAuditSql, type AuditQuery } from "../../audit/query";
import { getStmt } from "./_shared";
import { sessionsQueries } from "./sessions";
import { messagingQueries } from "./messaging";
import { projectsQueries } from "./projects";
import { workflowsKbQueries } from "./workflows-kb";
import { channelsQueries } from "./channels";
import { infraQueries } from "./infra";
import { dispatchQueries } from "./dispatch";
import { analyticsQueries } from "./analytics";
import { tokensQueries } from "./tokens";

/**
 * The prepared-statement builders, composed from per-domain modules (#54). Each
 * `queries.<name>(db)` returns a cached `Database.Statement`; call `.get()/.all()/
 * .run()` on it. This was one 1500-line god-object (a constant merge-conflict
 * magnet) — it is now a thin re-composition of `lib/db/queries/*.ts`, split by
 * domain, with ZERO call-site churn (the `queries` shape is unchanged). Keys are
 * unique across the domains (they came from one object), so the spread reproduces
 * the original object exactly.
 */
export const queries = {
  ...sessionsQueries,
  ...messagingQueries,
  ...projectsQueries,
  ...workflowsKbQueries,
  ...channelsQueries,
  ...infraQueries,
  ...dispatchQueries,
  ...analyticsQueries,
  ...tokensQueries,
};

// Audit read surface (#10). Dynamic filters (types/time/pagination) mean the SQL
// shape varies, so these build it via the pure builder and prepare through the same
// per-db statement cache (one prepared statement per distinct filter shape).
export function readAuditEvents(
  db: Database.Database,
  q: AuditQuery
): SessionEvent[] {
  const { sql, params } = buildAuditSql(q);
  return getStmt(db, sql).all(...params) as SessionEvent[];
}

export function countAuditEvents(db: Database.Database, q: AuditQuery): number {
  const { countSql, countParams } = buildAuditSql(q);
  const row = getStmt(db, countSql).get(...countParams) as { n: number };
  return row.n;
}
