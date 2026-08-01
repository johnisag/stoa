import { describe, expect, it } from "vitest";
import { allocateFleetAgents } from "@/lib/fleet/allocation";

describe("allocateFleetAgents", () => {
  it("balances unspecified tasks and honors installed provider suggestions", () => {
    expect(
      allocateFleetAgents({
        tasks: [
          {},
          {},
          { suggestedProvider: "kimi" },
          { suggestedProvider: "not-installed" },
        ],
        availableProviders: ["claude", "codex", "kimi"],
        defaultProvider: "claude",
        defaultModel: "sonnet",
      })
    ).toEqual([
      { provider: "claude", model: "sonnet" },
      { provider: "codex", model: null },
      { provider: "kimi", model: null },
      { provider: "claude", model: "sonnet" },
    ]);
  });

  it("falls back to the first installed provider and fails when none exist", () => {
    expect(
      allocateFleetAgents({
        tasks: [{}],
        availableProviders: ["hermes"],
        defaultProvider: "claude",
        defaultModel: "sonnet",
      })
    ).toEqual([{ provider: "hermes", model: null }]);
    expect(() =>
      allocateFleetAgents({
        tasks: [{}],
        availableProviders: [],
        defaultProvider: "claude",
        defaultModel: null,
      })
    ).toThrow("no installed agent provider");
  });
});
