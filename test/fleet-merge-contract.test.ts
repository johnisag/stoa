import { afterEach, describe, expect, it } from "vitest";
import { dirname, resolve } from "path";
import { fleetIntegrationIdentity } from "@/lib/fleet/merge-contract";

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
