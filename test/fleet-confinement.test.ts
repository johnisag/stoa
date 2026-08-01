import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FLEET_AUTOMATION_POLICY } from "@/lib/fleet/automation-policy";
import {
  evaluateFleetConfinementEvidence,
  fleetAgentApprovalMode,
  fleetConfinementEvidence,
} from "@/lib/fleet/confinement";

const saved = {
  STOA_AUTH: process.env.STOA_AUTH,
  STOA_REQUIRE_AUTH: process.env.STOA_REQUIRE_AUTH,
  STOA_SANDBOX: process.env.STOA_SANDBOX,
};

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Fleet strong-confinement evidence", () => {
  it("requires OS, network-authority, Git, and provider-state isolation", () => {
    const complete = {
      osSandbox: true,
      networkAuthorityProtected: true,
      isolatedGitMetadata: true,
      isolatedProviderState: true,
    };
    expect(evaluateFleetConfinementEvidence(complete)).toBe(true);
    for (const key of Object.keys(complete) as Array<keyof typeof complete>) {
      expect(
        evaluateFleetConfinementEvidence({ ...complete, [key]: false })
      ).toBe(false);
    }
  });

  it("does not classify the current shared Git/provider layout as confined", () => {
    process.env.STOA_SANDBOX = "1";
    process.env.STOA_REQUIRE_AUTH = "1";
    delete process.env.STOA_AUTH;
    const evidence = fleetConfinementEvidence();
    expect(evidence.networkAuthorityProtected).toBe(true);
    expect(evidence.isolatedGitMetadata).toBe(false);
    expect(evidence.isolatedProviderState).toBe(false);
    expect(fleetAgentApprovalMode(DEFAULT_FLEET_AUTOMATION_POLICY)).toBe(
      "prompt"
    );
  });

  it("requires explicit unconfined consent and never mistakes auth-off for protection", () => {
    process.env.STOA_REQUIRE_AUTH = "1";
    process.env.STOA_AUTH = "off";
    expect(fleetConfinementEvidence().networkAuthorityProtected).toBe(false);
    expect(
      fleetAgentApprovalMode({
        ...DEFAULT_FLEET_AUTOMATION_POLICY,
        allowUnconfinedAgents: true,
      })
    ).toBe("full-bypass");
  });
});
