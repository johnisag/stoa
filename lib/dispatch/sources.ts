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

// A deferred/unimplemented backend (Jira): ingests NOTHING rather than falling
// back to gh (which would run `gh issue list --repo jira:PROJ` and error every
// tick). Repo creation already rejects a `jira:` slug, so this is only a
// belt-and-suspenders for a hand-inserted row.
let warnedJira = false;
const emptyIssueSource: IssueSource = {
  async listEligible() {
    if (!warnedJira) {
      warnedJira = true;
      console.warn(
        "dispatch: Jira intake is not implemented — ingesting nothing"
      );
    }
    return [];
  },
  async listOpen() {
    return [];
  },
};

/**
 * Pick the IssueSource for a repo. GitHub is the default (unprefixed slug), so
 * every pre-#34 repo resolves to the untouched gh path. A `linear:`-prefixed
 * slug gets a Linear source; a `jira:` prefix (deferred) resolves to an EMPTY
 * source that ingests nothing — NOT a gh fallback (which would error every tick
 * against a `jira:` slug). Add-repo already rejects a `jira:` slug up front, so
 * this only guards a hand-inserted row.
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
      // Deferred: ingest nothing (NOT a gh fallback — that would run gh against
      // a `jira:` slug and error every tick). Add-repo rejects `jira:` up front.
      return emptyIssueSource;
    case "github":
    default:
      return githubSource;
  }
}
