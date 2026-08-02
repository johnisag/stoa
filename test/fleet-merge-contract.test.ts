import { afterEach, describe, expect, it } from "vitest";
import { dirname, resolve } from "path";
import {
  buildFleetPrViewArgs,
  fleetIntegrationIdentity,
  parseFleetPrStatus,
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
});
