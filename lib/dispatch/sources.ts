/**
 * Dispatch — the SOURCE PICKER: repo → concrete IssueSource (#34).
 *
 * `resolveIssueSource` maps a repo's `issueSourceKind` (derived from its slug
 * prefix, GitHub by default) to the backend that pulls its issues. This is the
 * single wiring point — the reconciler and the triage route ask for a source
 * and call `listEligible` / `listOpen`, never caring which tracker answers.
 *
 * Kept separate from `issue-source.ts` (pure interface + selection predicate) so
 * that module has no runtime deps; the concrete backends are imported only here.
 */

import type { DispatchRepo } from "./types";
import { issueSourceKind, type IssueSource } from "./issue-source";
import { GitHubIssueSource } from "./github-source";
import { LinearIssueSource } from "./linear";

// The GitHub source is stateless (delegates to module-level functions), so one
// shared instance is fine and keeps the default path allocation-free.
const githubSource = new GitHubIssueSource();

/**
 * Pick the IssueSource for a repo. GitHub is the default (unprefixed slug), so
 * every pre-#34 repo resolves to the untouched gh path. A `linear:`-prefixed
 * slug gets a Linear source; a `jira:` prefix is NOT wired yet (deferred) and
 * falls back to GitHub with a warning rather than silently doing nothing.
 *
 * `transport` is an escape hatch for tests / a pre-built Linear transport; in
 * production it is omitted and the Linear source builds its own fetch transport.
 */
export function resolveIssueSource(
  repo: Pick<DispatchRepo, "repo_slug">,
  overrides?: { linear?: IssueSource }
): IssueSource {
  const kind = issueSourceKind(repo);
  switch (kind) {
    case "linear":
      return overrides?.linear ?? new LinearIssueSource();
    case "jira":
      // Jira intake is deferred (see caveats). Fall back to GitHub so a mis-
      // prefixed slug degrades to the default rather than a silent no-op.
      console.warn(
        `dispatch: Jira intake is not implemented; repo "${repo.repo_slug}" falls back to GitHub`
      );
      return githubSource;
    case "github":
    default:
      return githubSource;
  }
}
