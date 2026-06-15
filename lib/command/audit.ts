/**
 * Command Stoa — the audit trail.
 *
 * Every command lifecycle event (proposed, executed, rejected, failed) is appended
 * to the existing append-only `session_events` ledger via the shared writer in
 * lib/audit/ledger.ts — so command events get the SAME best-effort, throttled,
 * STOA_AUDIT-respecting behavior as the rest of the ledger (one writer, not a
 * parallel one). A synthetic session_key keeps these app-level events in the trail
 * WITHOUT masquerading as a real session: the analytics engine only joins events
 * to actual session rows, so a synthetic key is invisible to the dashboards but
 * permanent in the trail (it outlives any session it spawns).
 */

import { recordEvent, auditEnabled } from "@/lib/audit/ledger";

/** Synthetic session_key for app-level command events (not a real backend key, so
 * analytics — which joins on real sessions — never counts it). */
export const COMMAND_AUDIT_KEY = "stoa:command";

export type CommandAuditType =
  | "command_proposed"
  | "command_executed"
  | "command_rejected"
  | "command_failed"
  // Assisted workflow generator (generation-only — these never imply execution):
  // a design was produced, rejected by the validator, or the spawn/run failed.
  | "workflow_proposed"
  | "workflow_rejected"
  | "workflow_failed";

// Cap the stored payload: a rejected event records (bounded) client/agent input,
// and an unbounded `name` etc. would otherwise write an arbitrarily large row per
// request. Over the cap, store a truncated head instead of the full blob.
const MAX_AUDIT_PAYLOAD_BYTES = 8 * 1024;

function bound(payload: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(payload);
  if (json.length <= MAX_AUDIT_PAYLOAD_BYTES) return payload;
  return { truncated: true, bytes: json.length, head: json.slice(0, 1024) };
}

/**
 * Append one command event to the ledger (best-effort, never throws — recordEvent
 * swallows DB errors). The payload is size-bounded so a crafted/large body can't
 * bloat the ledger. No-op when the ledger is disabled (STOA_AUDIT=0).
 */
export function auditCommand(
  type: CommandAuditType,
  payload: Record<string, unknown>
): void {
  if (!auditEnabled()) return;
  recordEvent(COMMAND_AUDIT_KEY, type, bound(payload));
}
