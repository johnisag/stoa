import { afterEach, describe, expect, it } from "vitest";
import { dirname, resolve } from "path";
import {
  buildFleetRequiredCheckRulesArgs,
  buildFleetPrViewArgs,
  FLEET_REQUIRED_RULES_MAX_PAGE_BYTES,
  FLEET_REQUIRED_RULES_MAX_PAGES,
  FLEET_REQUIRED_RULES_PAGE_SIZE,
  fleetIntegrationIdentity,
  parseFleetPrStatus,
  parseFleetRequiredCheckRulePages,
} from "@/lib/fleet/merge-contract";

const originalStoaHome = process.env.STOA_HOME;

afterEach(() => {
  if (originalStoaHome === undefined) delete process.env.STOA_HOME;
  else process.env.STOA_HOME = originalStoaHome;
});

describe("fleet integration identity", () => {
  it("places integration worktrees below an explicit STOA_HOME", () => {
    process.env.STOA_HOME = resolve("custom-stoa-state");

    const identity = fleetIntegrationIdentity("run-custom-home");

    expect(dirname(identity.worktree)).toBe(
      resolve(process.env.STOA_HOME, "fleet", "integrations")
    );
    expect(identity.branch).toMatch(/^stoa\/fleet\/integration-[a-f0-9]{20}$/);
  });
});

describe("fleet GitHub PR target identity", () => {
  it("requests and retains the exact GitHub base branch name", () => {
    expect(buildFleetPrViewArgs(17, "owner/repo").at(-1)).toContain(
      "baseRefName"
    );
    expect(
      parseFleetPrStatus(
        JSON.stringify({
          number: 17,
          url: "https://github.com/owner/repo/pull/17",
          state: "OPEN",
          baseRefName: "main",
          baseRefOid: "a".repeat(40),
          headRefOid: "b".repeat(40),
          mergeCommit: null,
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
        })
      )
    ).toMatchObject({ baseRefName: "main" });
  });

  it("retrieves branch rules through explicit direct-argv pagination", () => {
    expect(
      buildFleetRequiredCheckRulesArgs("owner/repo", "release/v2", 2)
    ).toEqual([
      "api",
      "--method",
      "GET",
      "repos/owner/repo/rules/branches/release%2Fv2",
      "-f",
      `per_page=${FLEET_REQUIRED_RULES_PAGE_SIZE}`,
      "-f",
      "page=2",
    ]);
  });

  it("flattens all bounded rule pages and preserves app identity", () => {
    const filler = Array.from(
      { length: FLEET_REQUIRED_RULES_PAGE_SIZE },
      () => ({
        type: "required_status_checks",
        parameters: { required_status_checks: [] },
      })
    );
    expect(
      parseFleetRequiredCheckRulePages([
        JSON.stringify(filler),
        JSON.stringify([
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "page-two-ci", integration_id: 4242 },
              ],
            },
          },
        ]),
      ])
    ).toEqual({
      checks: [{ context: "page-two-ci", integrationId: 4242 }],
    });
  });

  it("fails closed when supported checks are mixed with an unsupported active rule", () => {
    expect(
      parseFleetRequiredCheckRulePages([
        JSON.stringify([
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "ci" }],
            },
          },
          {
            type: "required_workflows",
            parameters: {
              workflows: [{ path: ".github/workflows/release.yml" }],
            },
          },
        ]),
      ])
    ).toBeNull();
  });

  it("fails closed on truncated, over-page, and oversized rule responses", () => {
    const fullPage = JSON.stringify(
      Array.from({ length: FLEET_REQUIRED_RULES_PAGE_SIZE }, (_, index) => ({
        type: `rule_${index}`,
      }))
    );
    expect(parseFleetRequiredCheckRulePages([fullPage])).toBeNull();
    expect(
      parseFleetRequiredCheckRulePages(
        Array.from({ length: FLEET_REQUIRED_RULES_MAX_PAGES + 1 }, () => "[]")
      )
    ).toBeNull();
    expect(
      parseFleetRequiredCheckRulePages([
        JSON.stringify([
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                {
                  context: "x".repeat(FLEET_REQUIRED_RULES_MAX_PAGE_BYTES + 1),
                },
              ],
            },
          },
        ]),
      ])
    ).toBeNull();
    expect(parseFleetRequiredCheckRulePages(["[truncated"])).toBeNull();
  });
});
