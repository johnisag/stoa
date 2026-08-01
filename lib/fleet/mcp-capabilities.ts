/**
 * Public, side-effect-free description of Stoa's Fleet MCP boundary.
 *
 * MCP is date-versioned; "v2" below refers only to the TypeScript SDK major.
 * Durable Fleet state remains SQLite-backed and is never inferred from a
 * transport subscription or an experimental protocol extension.
 */
export const FLEET_MCP_CAPABILITIES = Object.freeze({
  schemaVersion: 2,
  sdk: {
    package: "@modelcontextprotocol/server",
    major: 2,
  },
  protocol: {
    preferred: "2026-07-28",
    legacyFallback: true,
  },
  fleetState: {
    authority: "stoa-sqlite",
    snapshotRefetchAfterReconnect: true,
  },
  extensions: {
    tasks: {
      advertised: false,
      reason: "TypeScript SDK support is not available for the draft extension",
      fallback: "Fleet run/task IDs and HTTP snapshots",
    },
    subscriptions: {
      advertised: false,
      fallback: "bounded polling with full snapshot refetch",
    },
    sampling: {
      advertised: false,
      reason: "deprecated by MCP 2026-07-28",
    },
  },
  authorization: {
    directFleetTools: "scoped-server-capability",
    issuance: "admin-http-only",
    tokenStorage: "sha256-only",
    exactScope: ["action", "run", "task", "worker", "attempt", "hash"],
    approvalAndMerge: "separate-human-issued-capability-required",
    operatorRequests: "informational-only",
  },
  tools: {
    capabilityReads: [
      "fleet_list_runs",
      "fleet_get_run",
      "fleet_list_tasks",
      "fleet_supervisor_snapshot",
    ],
    capabilityMutations: [
      "fleet_create_run",
      "fleet_plan_run",
      "fleet_approve_run",
      "fleet_start_run",
      "fleet_pause_run",
      "fleet_resume_run",
      "fleet_cancel_run",
      "fleet_submit_artifact",
      "fleet_merge_run",
    ],
    intentionallyUnadvertised: [
      "scheduler_tick",
      "worker_kill",
      "destructive_cleanup",
    ],
  },
} as const);
