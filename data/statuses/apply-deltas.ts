import type { SessionStatus } from "@/components/views/types";

export interface StatusDelta {
  id: string;
  name: string;
  status: SessionStatus["status"];
  lastLine: string;
  rateLimit?: SessionStatus["rateLimit"];
  hasPrompt?: boolean;
}

/**
 * Merge pushed status deltas into a statuses map. Pure so the field-preservation
 * contract is unit-testable: a delta carries only the fields the server pushes
 * — every OTHER field of the cached entry (claudeSessionId, cwd) must survive,
 * or consumers of the shared cache (e.g. the Files view's live-cwd root) flap
 * back to their fallback on every push until the next poll.
 *
 * Directive-free on purpose (the reconnect-delay.ts / focus-guard.ts pattern):
 * a node-env test imports this without dragging the "use client" hook module.
 */
export function applyStatusDeltas(
  previous: Record<string, SessionStatus>,
  deltas: StatusDelta[]
): Record<string, SessionStatus> {
  const statuses = { ...previous };
  for (const d of deltas) {
    statuses[d.id] = {
      ...statuses[d.id],
      sessionName: d.name,
      status: d.status,
      lastLine: d.lastLine,
      claudeSessionId: statuses[d.id]?.claudeSessionId ?? null,
      cwd: statuses[d.id]?.cwd ?? null,
      rateLimit: d.rateLimit ?? null,
      hasPrompt: d.hasPrompt ?? false,
    };
  }
  return statuses;
}
