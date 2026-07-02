/**
 * #34 — Linear issue intake. Locks the GraphQL response mapping
 * (`parseLinearIssues`), the request-shape builder (`buildIssuesVariables`), and
 * the full `LinearIssueSource` driven by a FAKE transport (NO real network).
 */
import { describe, it, expect } from "vitest";
import {
  parseLinearIssues,
  buildIssuesVariables,
  fetchLinearIssues,
  LinearIssueSource,
  type LinearTransport,
} from "@/lib/dispatch/linear";
import type { DispatchRepo } from "@/lib/dispatch/types";

/** A minimal DispatchRepo for source tests (only slug/label are read). */
function repo(overrides: Partial<DispatchRepo> = {}): DispatchRepo {
  return {
    id: "r1",
    repo_path: "/tmp/x",
    repo_slug: "linear:ENG",
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

/** A transport that records the last request and returns a canned response. */
function fakeTransport(response: string): {
  transport: LinearTransport;
  lastBody: () => { query: string; variables: Record<string, unknown> } | null;
} {
  let seen: { query: string; variables: Record<string, unknown> } | null = null;
  return {
    transport: {
      async post(body) {
        seen = body;
        return response;
      },
    },
    lastBody: () => seen,
  };
}

const WELL_FORMED = JSON.stringify({
  data: {
    issues: {
      nodes: [
        {
          identifier: "ENG-42",
          number: 42,
          title: "Fix login",
          url: "https://linear.app/acme/issue/ENG-42",
          createdAt: "2026-06-01T10:00:00.000Z",
          labels: { nodes: [{ name: "bug" }, { name: "ready" }] },
        },
      ],
    },
  },
});

describe("parseLinearIssues", () => {
  it("maps a Linear issue node into the EligibleIssue shape", () => {
    expect(parseLinearIssues(WELL_FORMED)).toEqual([
      {
        number: 42,
        title: "Fix login",
        url: "https://linear.app/acme/issue/ENG-42",
        createdAt: "2026-06-01T10:00:00.000Z",
        labels: ["bug", "ready"],
      },
    ]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseLinearIssues("{not json")).toEqual([]);
  });

  it("returns [] on a GraphQL errors payload", () => {
    const errored = JSON.stringify({
      errors: [{ message: "Authentication required" }],
    });
    expect(parseLinearIssues(errored)).toEqual([]);
  });

  it("returns [] when data.issues.nodes is missing or not an array", () => {
    expect(parseLinearIssues(JSON.stringify({ data: {} }))).toEqual([]);
    expect(
      parseLinearIssues(JSON.stringify({ data: { issues: { nodes: 5 } } }))
    ).toEqual([]);
  });

  it("drops nodes with no numeric number", () => {
    const json = JSON.stringify({
      data: {
        issues: {
          nodes: [
            { title: "no number" },
            { number: "7", title: "string number" },
            { number: 9, title: "ok" },
          ],
        },
      },
    });
    expect(parseLinearIssues(json).map((i) => i.number)).toEqual([9]);
  });

  it("defaults missing string fields and absent labels", () => {
    const json = JSON.stringify({
      data: { issues: { nodes: [{ number: 5 }] } },
    });
    expect(parseLinearIssues(json)).toEqual([
      { number: 5, title: "", url: "", createdAt: "", labels: [] },
    ]);
  });

  it("skips malformed label nodes", () => {
    const json = JSON.stringify({
      data: {
        issues: {
          nodes: [
            {
              number: 1,
              labels: { nodes: [{ name: "keep" }, {}, { name: 123 }, "nope"] },
            },
          ],
        },
      },
    });
    expect(parseLinearIssues(json)[0].labels).toEqual(["keep"]);
  });
});

describe("buildIssuesVariables — Linear request shape (no injection surface)", () => {
  it("clamps limit to [1,50] and defaults to 50", () => {
    expect(buildIssuesVariables("ENG").variables.first).toBe(50);
    expect(buildIssuesVariables("ENG", { limit: 3 }).variables.first).toBe(3);
    expect(buildIssuesVariables("ENG", { limit: 999 }).variables.first).toBe(
      50
    );
    expect(buildIssuesVariables("ENG", { limit: 0 }).variables.first).toBe(50);
  });

  it("scopes to the team key and excludes done/canceled states", () => {
    const { variables } = buildIssuesVariables("ENG");
    const filter = variables.filter as Record<string, unknown>;
    expect(filter.team).toEqual({ key: { eq: "ENG" } });
    expect(filter.state).toEqual({ type: { nin: ["completed", "canceled"] } });
  });

  it("carries a hostile label as a structured filter VALUE, never as query text", () => {
    const nasty = '") { evil }';
    const { query, variables } = buildIssuesVariables("ENG", { label: nasty });
    // The label lands as data inside the filter object...
    expect((variables.filter as Record<string, unknown>).labels).toEqual({
      some: { name: { eq: nasty } },
    });
    // ...and never gets concatenated into the GraphQL document.
    expect(query).not.toContain(nasty);
  });

  it("omits the team filter for an empty key", () => {
    const filter = buildIssuesVariables("").variables.filter as Record<
      string,
      unknown
    >;
    expect(filter.team).toBeUndefined();
  });
});

describe("fetchLinearIssues — transport is mockable, degrades to []", () => {
  it("parses a canned transport response", async () => {
    const { transport } = fakeTransport(WELL_FORMED);
    const issues = await fetchLinearIssues(transport, "ENG");
    expect(issues.map((i) => i.number)).toEqual([42]);
  });

  it("returns [] (never throws) when the transport rejects", async () => {
    const throwing: LinearTransport = {
      async post() {
        throw new Error("network down");
      },
    };
    await expect(fetchLinearIssues(throwing, "ENG")).resolves.toEqual([]);
  });
});

describe("LinearIssueSource — full source over a fake transport", () => {
  it("derives the team key from a linear: slug and applies the label filter", async () => {
    const { transport, lastBody } = fakeTransport(WELL_FORMED);
    const src = new LinearIssueSource(transport);
    const out = await src.listEligible(repo({ label_filter: "ready" }));
    expect(out.map((i) => i.number)).toEqual([42]);
    const body = lastBody();
    // team key = the slug minus the linear: prefix.
    expect((body?.variables.filter as Record<string, unknown>).team).toEqual({
      key: { eq: "ENG" },
    });
    // the repo's standing label_filter rode through.
    expect((body?.variables.filter as Record<string, unknown>).labels).toEqual({
      some: { name: { eq: "ready" } },
    });
  });

  it("listOpen ignores the standing filter and uses the browse query label", async () => {
    const { transport, lastBody } = fakeTransport(WELL_FORMED);
    const src = new LinearIssueSource(transport);
    await src.listOpen(repo({ label_filter: "ready" }), { label: "bug" });
    const filter = lastBody()?.variables.filter as Record<string, unknown>;
    expect(filter.labels).toEqual({ some: { name: { eq: "bug" } } });
  });
});
