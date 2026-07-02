/**
 * Dispatch — the GitHub `IssueSource` (#34).
 *
 * A thin adapter that presents the existing gh-CLI intake (lib/dispatch/issues.ts)
 * through the `IssueSource` interface. It adds NO behavior: `listEligible` and
 * `listOpen` delegate straight to `listEligibleIssues` / `listOpenIssues`, so the
 * GitHub path stays byte-identical to pre-#34 (same argv, same degrade-to-[]).
 * The generalization is purely a seam — GitHub remains the default backend.
 */

import type { DispatchRepo, EligibleIssue } from "./types";
import type { IssueBrowseQuery, IssueSource } from "./issue-source";
import { listEligibleIssues, listOpenIssues } from "./issues";

export class GitHubIssueSource implements IssueSource {
  listEligible(repo: DispatchRepo): Promise<EligibleIssue[]> {
    return listEligibleIssues(repo);
  }

  listOpen(
    repo: DispatchRepo,
    query: IssueBrowseQuery = {}
  ): Promise<EligibleIssue[]> {
    // gh's browse takes {label, search, limit}; forward the same shape.
    return listOpenIssues(repo, {
      label: query.label,
      search: query.search,
      limit: query.limit,
    });
  }
}
