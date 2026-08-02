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
      { provider: "codex", model: "gpt-5.5" },
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
    ).toEqual([{ provider: "hermes", model: "kimi-k3" }]);
    expect(() =>
      allocateFleetAgents({
        tasks: [{}],
        availableProviders: [],
        defaultProvider: "claude",
        defaultModel: null,
      })
    ).toThrow("no installed agent provider");
  });

  it("excludes providers without a verified unattended mode", () => {
    expect(
      allocateFleetAgents({
        tasks: [{ suggestedProvider: "kilo" }, {}],
        availableProviders: ["kilo", "codex"],
        defaultProvider: "kilo",
        defaultModel: "kilo/model",
      })
    ).toEqual([
      { provider: "codex", model: "gpt-5.5" },
      { provider: "codex", model: "gpt-5.5" },
    ]);

    expect(() =>
      allocateFleetAgents({
        tasks: [{}],
        availableProviders: ["kilo", "shell"],
        defaultProvider: "kilo",
        defaultModel: null,
      })
    ).toThrow("no installed agent provider");
  });
});
