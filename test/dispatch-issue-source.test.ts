import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * #34 — the IssueSource seam. Locks:
 *  - the SOURCE PICKER (`issueSourceKind` / `stripSourcePrefix` /
 *    `resolveIssueSource`): GitHub is the default, `linear:` picks Linear.
 *  - INTERFACE CONFORMANCE: the GitHub source (over mocked gh) and the Linear
 *    source (over a fake transport) map an equivalent issue to the SAME internal
 *    `EligibleIssue` shape — the whole point of the interface.
 *
 * gh is mocked at child_process so no real binary runs (CI on all three OSes).
 */
const { state } = vi.hoisted(() => ({
  state: {
    listStdout: "[]",
    calls: [] as string[][],
  },
}));

vi.mock("child_process", () => ({
  // resolveBinary("gh") → no match → gh falls back to the bare "gh".
  execFileSync: () => "",
  execFile: (
    _file: string,
    args: string[],
    optsOrCb: unknown,
    cb?: unknown
  ) => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void;
    state.calls.push(args);
    return callback(null, { stdout: state.listStdout, stderr: "" });
  },
}));

import {
  issueSourceKind,
  stripSourcePrefix,
  dispatchSupported,
} from "@/lib/dispatch/issue-source";
import { resolveIssueSource } from "@/lib/dispatch/sources";
import { GitHubIssueSource } from "@/lib/dispatch/github-source";
import { LinearIssueSource } from "@/lib/dispatch/linear";
import type { DispatchRepo, EligibleIssue } from "@/lib/dispatch/types";

function repo(overrides: Partial<DispatchRepo> = {}): DispatchRepo {
  return {
    id: "r1",
    repo_path: "/tmp/x",
    repo_slug: "octo/app",
    agent_type: "claude" as DispatchRepo["agent_type"],
    daily_quota: 5,
    max_concurrency: 2,
    label_filter: null,
    base_branch: "main",
    mode: "auto",
    enabled: 1,
    review_gate: 0,
    ci_autofix: 0,
    merge_train: 0,
    verify_gate: 0,
    verify_command: null,
    judge_gate: 0,
    maintainer_survey_enabled: 0,
    maintainer_survey_goal: null,
    maintainer_survey_cadence: null,
    maintainer_survey_last_at: null,
    project_id: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

beforeEach(() => {
  state.listStdout = "[]";
  state.calls.length = 0;
});

describe("issueSourceKind — the source picker predicate", () => {
  it("defaults an ordinary owner/name slug to github", () => {
    expect(issueSourceKind(repo({ repo_slug: "octo/app" }))).toBe("github");
  });

  it("routes a linear: prefix to linear (case-insensitive prefix)", () => {
    expect(issueSourceKind(repo({ repo_slug: "linear:ENG" }))).toBe("linear");
    expect(issueSourceKind(repo({ repo_slug: "LINEAR:ENG" }))).toBe("linear");
  });

  it("routes a jira: prefix to jira", () => {
    expect(issueSourceKind(repo({ repo_slug: "jira:PROJ" }))).toBe("jira");
  });

  it("treats an empty slug as github (no crash)", () => {
    expect(issueSourceKind(repo({ repo_slug: "" }))).toBe("github");
  });
});

describe("stripSourcePrefix", () => {
  it("recovers the backend-native key from a prefixed slug", () => {
    expect(stripSourcePrefix("linear:ENG")).toBe("ENG");
    expect(stripSourcePrefix("jira:PROJ")).toBe("PROJ");
  });

  it("leaves a GitHub slug unchanged", () => {
    expect(stripSourcePrefix("octo/app")).toBe("octo/app");
  });

  it("preserves the remainder verbatim (only the prefix is case-insensitive)", () => {
    expect(stripSourcePrefix("LINEAR:Eng-Team")).toBe("Eng-Team");
  });
});

describe("dispatchSupported — dispatch is GitHub-only until the PR loop is source-aware", () => {
  it("is true only for a github (unprefixed) repo", () => {
    expect(dispatchSupported(repo())).toBe(true);
    expect(dispatchSupported(repo({ repo_slug: "linear:ENG" }))).toBe(false);
    expect(dispatchSupported(repo({ repo_slug: "jira:PROJ" }))).toBe(false);
  });
});

describe("resolveIssueSource — the factory", () => {
  it("returns a GitHub source for an unprefixed slug (default, byte-identical path)", () => {
    expect(resolveIssueSource(repo())).toBeInstanceOf(GitHubIssueSource);
  });

  it("returns a Linear source for a linear: slug", () => {
    expect(
      resolveIssueSource(repo({ repo_slug: "linear:ENG" }))
    ).toBeInstanceOf(LinearIssueSource);
  });

  it("a (deferred) jira: slug ingests NOTHING — never falls back to gh", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = resolveIssueSource(repo({ repo_slug: "jira:PROJ" }));
    // Not the GitHub source (which would run `gh issue list --repo jira:PROJ`).
    expect(src).not.toBeInstanceOf(GitHubIssueSource);
    await expect(
      src.listEligible(repo({ repo_slug: "jira:PROJ" }))
    ).resolves.toEqual([]);
    warn.mockRestore();
  });

  it("uses an injected Linear override for tests", () => {
    const fake = new LinearIssueSource({
      async post() {
        return JSON.stringify({ data: { issues: { nodes: [] } } });
      },
    });
    expect(
      resolveIssueSource(repo({ repo_slug: "linear:ENG" }), { linear: fake })
    ).toBe(fake);
  });
});

describe("interface conformance — github and linear map to the SAME shape", () => {
  it("both sources produce an identical EligibleIssue for an equivalent issue", async () => {
    // GitHub: gh issue list JSON (labels are [{name}]).
    state.listStdout = JSON.stringify([
      {
        number: 42,
        title: "Fix login",
        url: "https://example/issue/42",
        createdAt: "2026-06-01T10:00:00.000Z",
        labels: [{ name: "bug" }, { name: "ready" }],
      },
    ]);
    const gh = await new GitHubIssueSource().listEligible(repo());

    // Linear: GraphQL JSON (labels are {nodes:[{name}]}) for the SAME issue.
    const linearResponse = JSON.stringify({
      data: {
        issues: {
          nodes: [
            {
              number: 42,
              title: "Fix login",
              url: "https://example/issue/42",
              createdAt: "2026-06-01T10:00:00.000Z",
              labels: { nodes: [{ name: "bug" }, { name: "ready" }] },
            },
          ],
        },
      },
    });
    const linear = await new LinearIssueSource({
      async post() {
        return linearResponse;
      },
    }).listEligible(repo({ repo_slug: "linear:ENG" }));

    const expected: EligibleIssue[] = [
      {
        number: 42,
        title: "Fix login",
        url: "https://example/issue/42",
        createdAt: "2026-06-01T10:00:00.000Z",
        labels: ["bug", "ready"],
      },
    ];
    expect(gh).toEqual(expected);
    expect(linear).toEqual(expected);
    expect(gh).toEqual(linear);
  });

  it("GitHub source still drives the real gh argv (byte-identical path)", async () => {
    await new GitHubIssueSource().listEligible(repo({ label_filter: "ready" }));
    // The gh path resolved through issues.ts buildOpenIssueArgs unchanged.
    const call = state.calls.at(-1)!;
    expect(call.slice(0, 6)).toEqual([
      "issue",
      "list",
      "--repo",
      "octo/app",
      "--state",
      "open",
    ]);
    expect(call).toContain("--label");
    expect(call).toContain("ready");
  });
});
