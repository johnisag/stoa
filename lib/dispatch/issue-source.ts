/**
 * Dispatch — issue-tracker intake behind ONE interface (#34).
 *
 * The reconciler and the on-demand triage browse used to call `gh` directly
 * (lib/dispatch/issues.ts). To let Dispatch ingest issues from Linear/Jira as
 * well as GitHub, the shape GitHub exposes — "list the eligible open issues",
 * "browse the open backlog" — is extracted into `IssueSource`. Every backend
 * maps its native issue into the SAME internal shape (`EligibleIssue`), so the
 * whole downstream pipeline (parse → annotate → dispatch) is source-agnostic.
 *
 * `resolveIssueSource(repo)` is the SOURCE PICKER: it inspects the repo's slug
 * for a `linear:` / `jira:` prefix (else GitHub) and returns the matching
 * implementation. GitHub stays the default so every existing Dispatch flow is
 * byte-identical — an unprefixed "owner/name" slug resolves to the GitHub
 * source, which delegates straight to the untouched `issues.ts` functions.
 */

import type { DispatchRepo, EligibleIssue } from "./types";

/** The intake backends Dispatch can pull issues from. */
export type IssueSourceKind = "github" | "linear" | "jira";

/**
 * Options for an on-demand backlog browse (mirrors issues.ts OpenIssueQuery).
 * Each source maps these onto its own query language defensively — an unknown
 * option is ignored, never forwarded raw.
 */
export interface IssueBrowseQuery {
  /** Narrow to a single label; omit/empty = all open issues. */
  label?: string | null;
  /** Free-text search — gh `--search` only. The Linear source IGNORES this for
   *  now (no free-text mapping shipped); the browse UI disables the box for a
   *  non-github source so it's not a silent no-op. */
  search?: string | null;
  /** Page size; each source clamps to its own max. */
  limit?: number;
}

/**
 * A pluggable issue backend. Both methods normalize to `EligibleIssue[]` and
 * DEGRADE TO `[]` on failure (missing CLI, unauthenticated, unreachable) —
 * logged, never thrown — because the reconciler runs on the main event loop and
 * a hung/failed intake must be "nothing to dispatch this tick", not a crash.
 */
export interface IssueSource {
  /**
   * Reconciler ingest: the repo's eligible open issues, bound to its standing
   * `label_filter`. Returns [] on any failure.
   */
  listEligible(repo: DispatchRepo): Promise<EligibleIssue[]>;
  /**
   * On-demand triage browse: the whole open backlog (NOT bound to the standing
   * filter — the caller narrows via `query`). Returns [] on any failure.
   */
  listOpen(
    repo: DispatchRepo,
    query?: IssueBrowseQuery
  ): Promise<EligibleIssue[]>;
}

/** Prefix a repo slug carries to pick a non-GitHub backend, e.g. `linear:ENG`. */
const KIND_PREFIXES: ReadonlyArray<[string, IssueSourceKind]> = [
  ["linear:", "linear"],
  ["jira:", "jira"],
];

/**
 * Determine which intake backend a repo uses from its slug. GitHub is the
 * default (an ordinary "owner/name" has no recognized prefix), so pre-#34 rows
 * resolve exactly as before. The check is case-insensitive on the prefix only;
 * the remainder (team key / project key) is preserved verbatim.
 *
 * Pure + exported so the source selection is unit-locked without spawning.
 */
export function issueSourceKind(
  repo: Pick<DispatchRepo, "repo_slug">
): IssueSourceKind {
  const slug = repo.repo_slug ?? "";
  const lower = slug.toLowerCase();
  for (const [prefix, kind] of KIND_PREFIXES) {
    if (lower.startsWith(prefix)) return kind;
  }
  return "github";
}

/**
 * Strip a recognized `<kind>:` prefix off a slug, yielding the backend-native
 * key (Linear team key, Jira project key). A GitHub slug is returned unchanged.
 * Pure; exported for the Linear/Jira sources and their tests.
 */
export function stripSourcePrefix(slug: string): string {
  const lower = (slug ?? "").toLowerCase();
  for (const [prefix] of KIND_PREFIXES) {
    if (lower.startsWith(prefix)) return slug.slice(prefix.length);
  }
  return slug;
}

/**
 * Whether Dispatch's DISPATCH→PR loop supports a repo's source. #34 shipped
 * issue INTAKE (list/browse) for Linear, but the dispatch path downstream
 * (`buildIssuePrompt` runs `gh issue view`, PR-linking assumes GitHub) is
 * GitHub-hardcoded — so a non-github repo is intake/browse-ONLY until that path
 * is made source-aware. Enforced in the reconciler's auto loop AND the manual
 * dispatch routes so a Linear issue can never be handed to the gh-only worker.
 */
export function dispatchSupported(
  repo: Pick<DispatchRepo, "repo_slug">
): boolean {
  return issueSourceKind(repo) === "github";
}
