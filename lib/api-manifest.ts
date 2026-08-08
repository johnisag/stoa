/**
 * Public REST API discovery — a minimal OpenAPI-like manifest listing the
 * read-only public endpoints. This is not a full OpenAPI 3 spec; it's a
 * lightweight directory that external tools can consume to discover Stoa's
 * query capabilities.
 */

export interface ApiEndpointDoc {
  path: string;
  method: "GET";
  description: string;
  authRequired: boolean;
  /** Query parameters the endpoint accepts. */
  params?: Array<{ name: string; type: string; description: string }>;
}

export const PUBLIC_API_ENDPOINTS: ApiEndpointDoc[] = [
  {
    path: "/api/sessions",
    method: "GET",
    description:
      "List all sessions with their status, agent type, and project.",
    authRequired: true,
  },
  {
    path: "/api/sessions/status",
    method: "GET",
    description:
      "Live status snapshot for all sessions (idle/running/waiting/error).",
    authRequired: true,
  },
  {
    path: "/api/sessions/cost",
    method: "GET",
    description:
      "Estimated token cost per session + fleet total + budget levels.",
    authRequired: true,
  },
  {
    path: "/api/sessions/cost/history",
    method: "GET",
    description: "Durable fleet spend history (one point per UTC day).",
    authRequired: true,
    params: [
      {
        name: "days",
        type: "integer",
        description: "Window in days (default 14, max 90).",
      },
    ],
  },
  {
    path: "/api/monitor",
    method: "GET",
    description:
      "Agent Monitor snapshot: per-session status, model, context %, tokens.",
    authRequired: true,
  },
  {
    path: "/api/projects",
    method: "GET",
    description: "List all projects.",
    authRequired: true,
  },
  {
    path: "/api/fleet/runs",
    method: "GET",
    description: "List Fleet orchestration runs.",
    authRequired: true,
  },
  {
    path: "/api/audit",
    method: "GET",
    description:
      "Audit event ledger (filterable by session, type, time window). Supports CSV/JSON download via ?format=.",
    authRequired: true,
    params: [
      { name: "session", type: "string", description: "Filter by session id." },
      {
        name: "types",
        type: "string",
        description: "Comma-separated event types.",
      },
      { name: "since", type: "integer", description: "Epoch ms lower bound." },
      {
        name: "format",
        type: "string",
        description: "csv or json (download).",
      },
    ],
  },
  {
    path: "/api/readiness",
    method: "GET",
    description: "Server readiness probe (no auth required).",
    authRequired: false,
  },
];
