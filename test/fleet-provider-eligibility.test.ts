import { describe, expect, it } from "vitest";
import {
  filterFleetUnattendedProviders,
  isFleetUnattendedProvider,
} from "@/lib/fleet/provider-eligibility";

describe("Fleet unattended provider eligibility", () => {
  it("derives eligibility from the provider's verified auto-approve capability", () => {
    expect(isFleetUnattendedProvider("claude")).toBe(true);
    expect(isFleetUnattendedProvider("codex")).toBe(true);
    expect(isFleetUnattendedProvider("hermes")).toBe(true);
    expect(isFleetUnattendedProvider("kimi")).toBe(true);
    expect(isFleetUnattendedProvider("kilo")).toBe(false);
    expect(isFleetUnattendedProvider("shell")).toBe(false);
    expect(isFleetUnattendedProvider("unknown")).toBe(false);
  });

  it("filters unsupported providers and duplicates without reordering", () => {
    expect(
      filterFleetUnattendedProviders([
        "kilo",
        "codex",
        "codex",
        "shell",
        "claude",
      ])
    ).toEqual(["codex", "claude"]);
  });
});
