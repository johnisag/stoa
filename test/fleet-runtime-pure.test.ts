import { describe, expect, it } from "vitest";
import {
  availableFleetSlots,
  canReserveFleetBudget,
  providerConcurrencyCap,
} from "@/lib/fleet/admission";
import {
  fleetClaimsConflict,
  normalizeFleetClaims,
  UNKNOWN_FLEET_CLAIM,
} from "@/lib/fleet/conflicts";
import { buildFleetWorkerPrompt } from "@/lib/fleet/prompt";
import type { FleetRunRow, FleetTaskRow } from "@/lib/fleet/types";

describe("fleet runtime pure contracts", () => {
  it("normalizes cross-platform claims and fails closed for unknown writes", () => {
    expect(
      normalizeFleetClaims([String.raw`lib\fleet\service.ts`, "../escape"])
    ).toEqual(["lib/fleet/service.ts"]);
    expect(fleetClaimsConflict(["lib/fleet"], ["lib/fleet/service.ts"])).toBe(
      true
    );
    expect(fleetClaimsConflict([UNKNOWN_FLEET_CLAIM], ["docs/readme.md"])).toBe(
      true
    );
  });

  it("uses repository-aware case semantics with a case-sensitive default", () => {
    expect(fleetClaimsConflict(["Src/Foo.ts"], ["src/foo.ts"])).toBe(false);
    expect(
      fleetClaimsConflict(["Src/Foo.ts"], ["src/foo.ts"], {
        caseInsensitive: true,
      })
    ).toBe(true);
    expect(
      fleetClaimsConflict(["Src"], ["src/foo.ts"], {
        caseInsensitive: true,
      })
    ).toBe(true);
  });

  it("enforces provider, local, total, and budget caps", () => {
    expect(providerConcurrencyCap("claude")).toBe(4);
    expect(providerConcurrencyCap("codex")).toBe(6);
    expect(providerConcurrencyCap("hermes")).toBe(2);
    expect(
      availableFleetSlots({
        requestedConcurrency: 40,
        runActiveWorkers: 0,
        localActiveWorkers: 0,
        providerActiveWorkers: 0,
        totalWorkers: 0,
        provider: "codex",
      })
    ).toBe(6);
    expect(
      availableFleetSlots({
        requestedConcurrency: 6,
        runActiveWorkers: 5,
        localActiveWorkers: 5,
        providerActiveWorkers: 5,
        totalWorkers: 39,
        provider: "codex",
      })
    ).toBe(1);
    expect(
      canReserveFleetBudget({ budgetUsd: 0.2, reservedBudgetUsd: 0 })
    ).toBe(false);
  });

  it("builds a bounded worker contract with identity, claims, and report shape", () => {
    const run = {
      id: "run-1",
      name: "Fleet",
      goal: "Ship",
      provider: "codex",
      model: null,
    } as FleetRunRow;
    const task = {
      id: "task-1",
      title: "Implement",
      description: "Change it",
      acceptance_criteria: "Tests pass",
      verify_command: "npm test",
    } as FleetTaskRow;
    const prompt = buildFleetWorkerPrompt({
      run,
      task,
      claims: ["lib/fleet"],
      dependencies: ["task-0"],
      attempt: 2,
      spawnRequestId: "run-1:task-1:2",
    });
    expect(prompt).toContain("Task: task-1");
    expect(prompt).toContain("Allowed file claims: lib/fleet");
    expect(prompt).toContain("Do not modify paths outside your claims");
    expect(prompt).toContain("# Fleet Task Completion Report");
    expect(prompt).toContain("Spawn request: run-1:task-1:2");
  });
});
