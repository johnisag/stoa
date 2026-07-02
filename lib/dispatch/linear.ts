/**
 * Dispatch — Linear issue intake (#34).
 *
 * A second `IssueSource` (alongside GitHub). Linear has no `gh`-style CLI in
 * this stack, so we talk to its GraphQL API over HTTPS with the global `fetch`
 * (NO shell, NO pipes — AGENTS.md). The network boundary is a single injectable
 * `LinearTransport` seam so tests feed a canned response WITHOUT real network.
 *
 * Auth: the API key comes from `LINEAR_API_KEY` (documented). Linear expects it
 * verbatim in the `Authorization` header (personal API keys are NOT `Bearer`-
 * prefixed). Missing key ⇒ [] (logged), like an unauthenticated `gh`.
 *
 * A repo targets Linear by giving its slug a `linear:` prefix, where the
 * remainder is the TEAM KEY (e.g. `linear:ENG`). issueSourceKind() routes on
 * that prefix; stripSourcePrefix() recovers the team key here.
 *
 * `parseLinearIssues` is a pure function (canned GraphQL JSON → EligibleIssue[])
 * so the response-shape mapping is unit-locked without a transport.
 */

import type { DispatchRepo, EligibleIssue } from "./types";
import type { IssueBrowseQuery, IssueSource } from "./issue-source";
import { stripSourcePrefix } from "./issue-source";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const MAX_ISSUES = 50;
const REQUEST_TIMEOUT_MS = 15000;

/**
 * The HTTP seam. A transport takes a fully-formed GraphQL request body and
 * returns the raw JSON text of the response (or throws). The real transport
 * POSTs to Linear; tests inject a fake that returns canned JSON. Keeping it at
 * "string in, string out" means `parseLinearIssues` stays a pure text mapper.
 */
export interface LinearTransport {
  post(body: {
    query: string;
    variables: Record<string, unknown>;
  }): Promise<string>;
}

/** Options for building the real fetch transport. */
export interface LinearTransportOptions {
  /** API key; defaults to LINEAR_API_KEY. */
  apiKey?: string;
  /** Override the endpoint (tests / self-hosted); defaults to Linear cloud. */
  url?: string;
  /** Per-request timeout; defaults to 15s. */
  timeoutMs?: number;
}

/**
 * The production transport: POST JSON to Linear's GraphQL endpoint via the
 * global `fetch` with an AbortController deadline. No shell, no pipes. Throws on
 * a missing key, a non-2xx, or a timeout — the IssueSource wrapper catches and
 * degrades to [].
 */
export function createLinearTransport(
  opts: LinearTransportOptions = {}
): LinearTransport {
  const apiKey = (opts.apiKey ?? process.env.LINEAR_API_KEY ?? "").trim();
  const url = opts.url ?? LINEAR_API_URL;
  const timeoutMs =
    typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
      ? opts.timeoutMs
      : REQUEST_TIMEOUT_MS;

  return {
    async post(body) {
      if (!apiKey) {
        throw new Error("LINEAR_API_KEY is not set");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Linear personal API keys go in Authorization verbatim (no Bearer).
            Authorization: apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Linear API HTTP ${res.status}`);
        }
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

interface RawLinearIssue {
  identifier?: unknown;
  number?: unknown;
  title?: unknown;
  url?: unknown;
  createdAt?: unknown;
  labels?: unknown;
}

/**
 * Normalize a Linear `issues` GraphQL response into EligibleIssue[] — the SAME
 * internal shape a GitHub issue maps to. Pure + defensive: bad JSON, a GraphQL
 * `errors` payload, or a malformed node is dropped rather than thrown.
 *
 * Field mapping (Linear → EligibleIssue):
 *   number    ← issue.number (Linear's per-team incrementing int)
 *   title     ← issue.title
 *   url       ← issue.url
 *   createdAt ← issue.createdAt (ISO)
 *   labels    ← issue.labels.nodes[].name  (flattened, like gh's [{name}])
 *
 * A node needs a numeric `number` to survive (matches parseIssues' invariant so
 * the downstream (repo, issue_number) uniqueness holds identically).
 */
export function parseLinearIssues(rawJson: string): EligibleIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  // A GraphQL error response has top-level `errors` and no usable data.
  const root = parsed as {
    data?: { issues?: { nodes?: unknown } };
    errors?: unknown;
  } | null;
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root.errors) && root.errors.length > 0) return [];
  const nodes = root.data?.issues?.nodes;
  if (!Array.isArray(nodes)) return [];

  const out: EligibleIssue[] = [];
  for (const item of nodes as RawLinearIssue[]) {
    if (typeof item?.number !== "number") continue;
    const labelNodes = (item.labels as { nodes?: unknown } | null | undefined)
      ?.nodes;
    const labels = Array.isArray(labelNodes)
      ? (labelNodes as Array<{ name?: unknown }>)
          .map((l) => (typeof l?.name === "string" ? l.name : ""))
          .filter(Boolean)
      : [];
    out.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      url: typeof item.url === "string" ? item.url : "",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
      labels,
    });
  }
  return out;
}

/** The GraphQL document: open issues for a team, newest first, with labels. */
const ISSUES_QUERY = `
query DispatchIssues($filter: IssueFilter, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: createdAt) {
    nodes {
      identifier
      number
      title
      url
      createdAt
      labels { nodes { name } }
    }
  }
}`.trim();

/**
 * Build the GraphQL `variables` for a query. Pure (no network) so the request
 * shape — the team-key gate, the open-state filter, the optional label, the
 * clamped page size — is unit-locked. `teamKey` narrows to one Linear team;
 * `label` and `limit` come from the browse query.
 *
 * Linear's IssueFilter is a structured object (NOT a raw string), so there is no
 * injection surface: a hostile label lands as a `{ eq: "…" }` value the API
 * treats as data, never as query text.
 */
export function buildIssuesVariables(
  teamKey: string,
  opts: { label?: string | null; limit?: number } = {}
): { query: string; variables: Record<string, unknown> } {
  const first =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_ISSUES)
      : MAX_ISSUES;

  // Only issues in a state whose TYPE is not done/canceled count as "open".
  const filter: Record<string, unknown> = {
    state: { type: { nin: ["completed", "canceled"] } },
  };
  const key = teamKey.trim();
  if (key) filter.team = { key: { eq: key } };
  const label = opts.label?.trim();
  if (label) filter.labels = { some: { name: { eq: label } } };

  return { query: ISSUES_QUERY, variables: { filter, first } };
}

/**
 * Query Linear via the transport and normalize. Returns [] on ANY failure
 * (missing key, HTTP error, timeout, malformed body) — logged — mirroring
 * listEligibleIssues' degrade-to-empty contract so a Linear outage is "nothing
 * to dispatch this tick", never a thrown reconciler tick.
 */
export async function fetchLinearIssues(
  transport: LinearTransport,
  teamKey: string,
  opts: { label?: string | null; limit?: number } = {}
): Promise<EligibleIssue[]> {
  try {
    const raw = await transport.post(buildIssuesVariables(teamKey, opts));
    return parseLinearIssues(raw);
  } catch (err) {
    console.warn(
      `dispatch: Linear issue fetch failed for team ${teamKey || "(none)"}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * The Linear `IssueSource`. Both methods derive the team key from the repo slug
 * (`linear:ENG` → `ENG`). `listEligible` applies the repo's standing
 * `label_filter` (like the reconciler's gh path); `listOpen` uses the caller's
 * explicit browse query instead so the whole backlog is triageable.
 *
 * The transport is injected (defaulting to the real fetch transport) so a test
 * can drive the full source with a fake — no network, no env.
 */
export class LinearIssueSource implements IssueSource {
  readonly kind = "linear" as const;
  private readonly transport: LinearTransport;

  constructor(transport?: LinearTransport) {
    this.transport = transport ?? createLinearTransport();
  }

  listEligible(repo: DispatchRepo): Promise<EligibleIssue[]> {
    const teamKey = stripSourcePrefix(repo.repo_slug);
    return fetchLinearIssues(this.transport, teamKey, {
      label: repo.label_filter,
    });
  }

  listOpen(
    repo: DispatchRepo,
    query: IssueBrowseQuery = {}
  ): Promise<EligibleIssue[]> {
    const teamKey = stripSourcePrefix(repo.repo_slug);
    return fetchLinearIssues(this.transport, teamKey, {
      label: query.label,
      limit: query.limit,
    });
  }
}
