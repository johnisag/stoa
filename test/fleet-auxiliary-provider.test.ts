import { describe, expect, it } from "vitest";
import { allocateFleetAuxiliaryProvider } from "@/lib/fleet/auxiliary-provider";

describe("Fleet auxiliary provider allocation", () => {
  it("keeps the preferred installed provider and its model", () => {
    expect(
      allocateFleetAuxiliaryProvider({
        availableProviders: ["claude", "hermes"],
        preferredProvider: "hermes",
        preferredModel: "kimi-k3",
      })
    ).toEqual({ provider: "hermes", model: "kimi-k3" });
  });

  it("uses registry-stable installed fallback order and drops foreign models", () => {
    expect(
      allocateFleetAuxiliaryProvider({
        availableProviders: ["codex", "claude", "codex", "shell"],
        preferredProvider: "hermes",
        preferredModel: "kimi-k3",
      })
    ).toEqual({ provider: "claude", model: null });
  });

  it("rejects an empty or shell-only installed set", () => {
    expect(() =>
      allocateFleetAuxiliaryProvider({
        availableProviders: ["shell"],
        preferredProvider: "hermes",
        preferredModel: "kimi-k3",
      })
    ).toThrow("no installed agent provider is available");
  });

  it("does not allocate Kilo to an unattended auxiliary session", () => {
    expect(
      allocateFleetAuxiliaryProvider({
        availableProviders: ["kilo", "codex"],
        preferredProvider: "kilo",
        preferredModel: "kilo/model",
      })
    ).toEqual({ provider: "codex", model: null });

    expect(() =>
      allocateFleetAuxiliaryProvider({
        availableProviders: ["kilo"],
        preferredProvider: "kilo",
        preferredModel: null,
      })
    ).toThrow("no installed agent provider is available");
  });
});
